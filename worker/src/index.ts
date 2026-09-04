import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { ORDER_RECORDS, PRODUCTS, seedOrders, USER } from '../../config/seed';
import { POLICY_PROSE, POLICY_RULES } from '../../config/policy';
import { STANCES } from '../../config/stances';
import {
  CLINIC_DOCUMENTS, CLINIC_NAME, CLINIC_POLICY_PROSE, CLINIC_POLICY_RULES, CLINIC_STANCES,
  CLINIC_USER, RESTRICTED_CATEGORIES, seedVisits,
} from '../../config/clinic';
import { evaluateOrderChange, evaluateReturnEligibility } from '../../packages/widget/src/eligibility';
import { validateAddress } from '../../packages/widget/src/address';
import { RETURN_REASONS } from '../../packages/widget/src/types';
import type { Assurance, ReturnReason } from '../../packages/widget/src/types';

interface Env {
  OPENAI_API_KEY: string;
  REALTIME_MODEL: string;
  RP_ID: string;          // e.g. "halden.example" — must match the site's domain
  RP_NAME: string;
  EXPECTED_ORIGIN: string; // e.g. "https://halden.example"
  KV: KVNamespace;
  /**
   * Test-only clock override. Never set in `wrangler.jsonc`/production — `fetch`'s
   * signature is fixed by the Workers runtime, so this is the only seam available for a
   * test to freeze "now" without stubbing a global. Matches this codebase's injected-clock
   * convention (see e.g. bus.ts's `BusOpts.now`) rather than reaching for `Date.now()`
   * directly wherever a comparison needs two calls to see the same instant.
   */
  NOW?: number;
}

/** What /options bound the ceremony to. orderId/itemId/reason are present only for confirm_return. */
interface ChallengeRecord {
  challenge: string;
  tool: string;
  deviceId: string;
  mode: 'register' | 'authenticate';
  /**
   * Which domain this ceremony belongs to — bound here, at /options time, for the
   * assurance policy /api/act must re-check. `'C'` selects the clinic, and absence
   * selects the flagship.
   */
  tenant?: string;
  orderId?: string;
  itemId?: string;
  reason?: string;
  /** Free-form qualifier for domains whose consent is not one bit — see PendingRequest.scope. */
  scope?: string;
  /**
   * change_address only: the new delivery address, bound here for exactly the reason the
   * eligibility triple is. Without it this Worker completed an address change it could
   * not name — the page displayed one address in the confirm box and /api/act had no way
   * to know which one, so the receipt recorded a redirect to nowhere.
   */
  address?: string;
}

/**
 * The token IS the record, not a pointer to one keyed by anything client-supplied. Minted
 * once per completed ceremony, looked up only by the unguessable token string itself.
 * `used` plus `result`/`resultStatus` turn on the same key: unset means "spend me",
 * set means "here is what happened last time — do not run it again."
 */
interface TokenRecord {
  requestId: string;
  tool: string;
  deviceId: string;
  /** Carried through from the ChallengeRecord this token's ceremony was minted for. */
  tenant?: string;
  orderId?: string;
  itemId?: string;
  reason?: string;
  scope?: string;
  address?: string;
  used: boolean;
  result?: Record<string, unknown>;
  resultStatus?: number;
  /**
   * Which layer minted this token. 'webauthn' means /api/webauthn/verify actually
   * checked a signature. 'trusted-click' means /api/trusted-click took the client's word
   * that this device has no authenticator — an AUDITABLE RECORD, not a VERIFIED FACT
   * (see that handler and TrustedClickRecord's doc comment in packages/widget/src/
   * types.ts). /api/act re-derives eligibility itself either way; this field only
   * records HOW the person side of the ceremony was established, for whoever audits it
   * later. Optional only because it didn't exist before this field did — every token
   * minted from here on sets it explicitly.
   */
  assurance?: Assurance;
}

/** What a ceremony commits to before the person authenticates. */
interface BoundSubject {
  orderId?: string; itemId?: string; reason?: string; scope?: string; address?: string;
}

type TenantId = 'C' | undefined;

/**
 * Normalizes the clinic tenant once. Tenant C used to be discarded by every ceremony
 * endpoint, so the clinic silently inherited the shop's weaker policy. Unknown values
 * still fall back to the flagship instead of becoming key material.
 */
const tenantId = (value: unknown): TenantId => value === 'C' ? value : undefined;

const policyForTenant = (tenant: TenantId) =>
  tenant === 'C' ? CLINIC_POLICY_RULES : POLICY_RULES;

/**
 * A domain-unique gated tool selects its own policy even when an untrusted caller omits
 * or lies about tenant. The tenant breaks ties only if two domains deliberately share a
 * tool name. Without this, `release_records` could be evaluated against the shop's
 * trusted-click flag merely by dropping tenant C from an /api/act request.
 */
const policyForTool = (tool: string, tenant: TenantId) => {
  const inShop = POLICY_RULES.requiresHumanDirect.includes(tool);
  const inClinic = CLINIC_POLICY_RULES.requiresHumanDirect.includes(tool);
  if (inClinic && !inShop) return CLINIC_POLICY_RULES;
  if (inShop && !inClinic) return POLICY_RULES;
  return policyForTenant(tenant);
};

interface SubjectBindingFailure {
  error: 'invalid_address';
  message: string;
}

const isSubjectBindingFailure = (
  value: BoundSubject | SubjectBindingFailure,
): value is SubjectBindingFailure => 'error' in value;

/**
 * Decides, ONCE, what each gated tool must commit to at mint time. Both mint paths
 * (/api/webauthn/options and /api/trusted-click) called a byte-identical copy of this
 * logic, which is how two of the four gated actions came to bind nothing at all: adding
 * a tool meant remembering to add it twice, and cancel_order/change_address were added
 * to neither. One function, both callers — a tool that is missing here is missing from
 * both paths together, which is a visible bug rather than a silent asymmetry.
 *
 * Returns null when the caller failed to commit to the fields its tool requires OR the
 * tool is unknown; both mint paths refuse. Unknown tools used to return `{}`, which made
 * a future policy entry mint an unbound token and later fall through /api/act's generic
 * success branch — configuration drift became authorization. Address-format failures
 * retain their shared validator message so the refusal is legible rather than silent.
 */
function bindSubject(
  tool: string,
  body: { orderId?: unknown; itemId?: unknown; reason?: unknown; scope?: unknown; address?: unknown },
): BoundSubject | SubjectBindingFailure | null {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v : undefined;
  // Whitespace-only identifiers deliberately stay rejected: extraction tightened this
  // fail-closed instead of preserving garbage truthiness. For scope specifically, '' and
  // undefined are behaviorally identical because /api/act widens only on the exact stamped
  // value 'include-restricted'; both therefore remain routine without any normalization.

  if (tool === 'confirm_return') {
    const orderId = str(body.orderId), itemId = str(body.itemId);
    if (!orderId || !itemId || typeof body.reason !== 'string'
      || !RETURN_REASONS.includes(body.reason as ReturnReason)) return null;
    return { orderId, itemId, reason: body.reason };
  }
  // A disclosure must commit to WHICH order's records it is asking the person to
  // release. Without this the page could show one order in the confirm box and spend
  // the token on another.
  if (tool === 'disclose_order_records') {
    const orderId = str(body.orderId);
    return orderId ? { orderId } : null;
  }
  // A records release must commit to WHICH visits, to WHOM, and at what scope. Scope
  // especially: without it bound here a page could display a routine release and spend
  // a token that also carries restricted records.
  if (tool === 'release_records') {
    const orderId = str(body.orderId), itemId = str(body.itemId);
    if (!orderId || !itemId) return null;
    return { orderId, itemId, scope: str(body.scope) };
  }
  // The two that used to bind NOTHING. /api/act had no order for either, fell through to
  // a generic success branch that knew neither the order nor the address, and the browser
  // then wrote "Order cancelled" / "Delivery address updated" out of its own local
  // pending object. The ceremony was real; the effect was unbound.
  if (tool === 'cancel_order') {
    const orderId = str(body.orderId);
    return orderId ? { orderId } : null;
  }
  if (tool === 'change_address') {
    // The address is REQUIRED, not optional: an address change bound to an order but not
    // to a destination is a blank cheque the person cannot check. Capped so a page cannot
    // bind an unbounded string into a record this Worker stores and echoes back. The
    // shared validator is the same one used before PendingRequest creation, so the value
    // shown and the value bound are identical by construction rather than by convention.
    const orderId = str(body.orderId);
    if (!orderId) return null;
    const checkedAddress = validateAddress(body.address);
    if (!checkedAddress.ok) {
      return checkedAddress.code === 'required'
        ? null
        : { error: 'invalid_address', message: checkedAddress.message };
    }
    return { orderId, address: checkedAddress.address };
  }
  return null;
}

interface ActionSubject extends BoundSubject {
  tenant?: string;
  assurance?: Assurance;
}

/**
 * The one executor dispatch for every authorization level. The old demo-weak branch had
 * a second generic `ok:true` implementation, so disabling hardware also bypassed subject
 * binding and made any future policy-listed name succeed without an executor. Keeping
 * authorization outside this function means the demo can honestly weaken WHO authorizes
 * while the action still has exactly one implementation of WHAT executes.
 */
function executeBoundAction(
  tool: string, requestId: string, record: ActionSubject, now: number,
): { result: Record<string, unknown>; status: number } {
  let result: Record<string, unknown>;
  let status: number;
  if (tool === 'confirm_return') {
    if (typeof record.orderId !== 'string' || typeof record.itemId !== 'string'
      || typeof record.reason !== 'string' || !RETURN_REASONS.includes(record.reason as ReturnReason)) {
      result = { ok: false, error: 'missing_eligibility_fields' }; status = 400;
    } else {
      const order = seedOrders(now).find(o => o.orderId === record.orderId);
      if (!order) {
        result = { ok: false, error: 'unknown_order' }; status = 400;
      } else {
        const verdict = evaluateReturnEligibility(
          order, record.itemId, record.reason as ReturnReason, POLICY_RULES, now);
        result = verdict.eligible
          ? { ok: true, tool, requestId, refunded: true, assurance: record.assurance }
          : { ok: false, error: 'ineligible', eligibility: verdict };
        status = verdict.eligible ? 200 : 403;
      }
    }
  } else if (tool === 'release_records') {
    // The documents exist here and nowhere else. Both authorization paths reach this
    // exact branch, preventing the demo toggle from becoming a generic disclosure path.
    const visitIds = (record.orderId ?? '').split('+').filter(Boolean);
    // Restricted records (mental health, substance use, genetic) are NEVER released through
    // an agent-prepared disclosure — a hard limit enforced here, at the authoritative gate,
    // regardless of any scope the request tried to bind. The widget and the eligibility
    // engine refuse it too; this is the copy a patched page cannot get around.
    const documents = CLINIC_DOCUMENTS.filter(d =>
      visitIds.includes(d.visitId) && !RESTRICTED_CATEGORIES.includes(d.category));
    if (visitIds.length === 0 || documents.length === 0) {
      result = { ok: false, error: 'nothing_to_release' }; status = 400;
    } else {
      result = {
        ok: true, tool, requestId, refunded: false, assurance: record.assurance,
        released: { to: record.itemId || 'the named recipient', documents },
      };
      status = 200;
    }
  } else if (tool === 'disclose_order_records') {
    // Records stay server-side until this explicit executor runs; no generic policy
    // branch is allowed to manufacture a successful disclosure.
    const records = ORDER_RECORDS[record.orderId ?? ''];
    if (!record.orderId || !records) {
      result = { ok: false, error: 'unknown_order' }; status = 400;
    } else {
      result = { ok: true, tool, requestId, refunded: false, assurance: record.assurance, records };
      status = 200;
    }
  } else if (tool === 'cancel_order' || tool === 'change_address') {
    // Eligibility is re-derived at execution time in both assurance modes, so a stale
    // page verdict cannot turn a shipped order into an eligible redirect or cancellation.
    const order = seedOrders(now).find(o => o.orderId === record.orderId);
    if (!record.orderId || !order) {
      result = { ok: false, error: 'unknown_order' }; status = 400;
    } else {
      const action = tool === 'cancel_order' ? 'cancel' : 'address-change';
      const verdict = evaluateOrderChange(order, action);
      if (!verdict.eligible) {
        result = { ok: false, error: 'ineligible', eligibility: verdict }; status = 403;
      } else if (tool === 'change_address' && !record.address) {
        // bindSubject refuses this before either mint path. Retaining the check here keeps
        // a corrupt stored token from completing a redirect whose destination is absent.
        result = { ok: false, error: 'missing_eligibility_fields' }; status = 400;
      } else {
        result = {
          ok: true, tool, requestId, refunded: false, assurance: record.assurance,
          orderId: record.orderId,
          ...(tool === 'change_address' ? { address: record.address } : { cancelled: true }),
        };
        status = 200;
      }
    }
  } else {
    // Policy allowlisting is not an executor. Configuration drift must become a visible
    // refusal under every assurance mode, never an invented successful effect.
    result = { ok: false, error: 'unimplemented_tool' };
    status = 500;
  }
  return { result, status };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

/**
 * For endpoints that proxy a metered API key. Their CORS is narrowed to the site's own
 * origin (never `*`) so a foreign page cannot even read the response over a browser
 * fetch, on top of the Origin check that keeps the proxy from running for it at all.
 */
const jsonForOrigin = (body: unknown, status: number, origin: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST,OPTIONS',
    },
  });

/**
 * Origin-header allowlisting is not a cryptographic boundary — a non-browser caller can
 * set any Origin it likes. It stops a browser running a DIFFERENT site's page from
 * spending this key via a normal fetch/XHR, which is the actual shape of the risk for an
 * unauthenticated proxy whose URL becomes known (e.g. via the network tab). It does not
 * and cannot stand in for the WebAuthn-gated boundary at /api/act.
 */
/**
 * EXPECTED_ORIGIN accepts a comma-separated LIST, so a deployment can answer on two
 * origins at once. That exists for exactly one reason: moving to a new domain otherwise
 * means a window where the old origin is already refused and the new one does not resolve
 * yet, which takes the demo down mid-cutover for everybody.
 *
 * Still an exact-match allowlist — no wildcards, no suffix matching. A list of two exact
 * origins is a cutover; a pattern is an accident waiting to be discovered by somebody
 * registering `3way.dev.evil.com`.
 */
function expectedOrigins(env: Env): string[] {
  return env.EXPECTED_ORIGIN.split(',').map(o => o.trim()).filter(Boolean);
}

/** The caller's origin if it is allowed, else null. Also what CORS must echo back. */
function matchedOrigin(req: Request, env: Env): string | null {
  const origin = req.headers.get('origin');
  return origin && expectedOrigins(env).includes(origin) ? origin : null;
}

function forbiddenOrigin(req: Request, env: Env): Response | null {
  if (!matchedOrigin(req, env)) return json({ error: 'forbidden_origin' }, 403);
  return null;
}

// Imported rather than re-declared: this Worker and the browser's eligibility engine have
// to agree on the vocabulary exactly, or a code one accepts is one the other silently
// reinterprets. That divergence is what made `wrong_item` answerable at all.

// KV keys are limited to 512 bytes. requestId and deviceId are client-chosen, and token
// is a bearer value the client sends back on every /api/act call — all three are strings
// this Worker never controls the length or shape of once they're in a request, so all
// three get an explicit cap well under 512 bytes (checked here, before anything is
// attempted) plus `:` is rejected outright — not because a colon can desync a JSON-keyed
// lookup (it can't, not anymore), but because nothing about how these strings are chosen
// should ever depend on that being true.
const MAX_ID_LEN = 128;
function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LEN && !id.includes(':');
}

async function readJson<T>(req: Request): Promise<T | null> {
  try { return await req.json() as T; } catch { return null; }
}

/**
 * Wraps KV.put so an oversized key/value (or any other KV failure) is a 400, not a 500.
 * Omit `ttlSeconds` for records meant to persist indefinitely (registered credentials).
 */
async function safePut(env: Env, key: string, value: string, ttlSeconds?: number): Promise<boolean> {
  try { await env.KV.put(key, value, ttlSeconds === undefined ? undefined : { expirationTtl: ttlSeconds }); return true; }
  catch (err) { console.error('KV.put failed', key, err); return false; }
}

/**
 * Wraps KV.get so a transient read failure is a structured refusal, not an unhandled
 * rejection reaching the runtime's default handler. `KVNamespace.get` itself returns
 * `null` for BOTH "read succeeded, nothing there" and cannot represent "the read failed"
 * at all — collapsing those two into one `null` here would be exactly the bug this exists
 * to prevent (e.g. the already-registered check below: treating a failed read the same as
 * "no credential found" would let registration proceed and overwrite an existing
 * credential during a transient KV blip). `ok: false` and `ok: true, value: null` are kept
 * distinguishable so every call site fails closed on the former without misreading it as
 * the latter.
 */
type KVRead<T> = { ok: true; value: T | null } | { ok: false };
async function safeGet<T>(env: Env, key: string, type?: 'json'): Promise<KVRead<T>> {
  try {
    const value = (type === 'json' ? await env.KV.get(key, 'json') : await env.KV.get(key)) as T | null;
    return { ok: true, value };
  } catch (err) {
    console.error('KV.get failed', key, err);
    return { ok: false };
  }
}

/** Wraps KV.delete the same way — a failed delete must not be silently treated as done. */
async function safeDelete(env: Env, key: string): Promise<boolean> {
  try { await env.KV.delete(key); return true; }
  catch (err) { console.error('KV.delete failed', key, err); return false; }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const now = env.NOW ?? Date.now();

    // Ephemeral token: the browser connects to Realtime directly, the key stays here.
    // Unauthenticated + metered, so both the Origin check and the narrowed CORS above
    // matter here: anyone who learns this URL could otherwise burn the key owner's
    // credits directly, with no WebAuthn ceremony involved at all.
    if (url.pathname === '/api/realtime-token' && req.method === 'POST') {
      const denied = forbiddenOrigin(req, env);
      if (denied) return denied;
      let r: Response;
      try {
        // /v1/realtime/sessions was retired and now 404s ("Invalid URL") for every
        // caller — verified against the live API, not inferred. The replacement is
        // /v1/realtime/client_secrets, which takes the session nested under `session`
        // (with `type: 'realtime'`) and nests its output configuration under audio.output.
        // The SDP exchange the browser does afterwards is
        // unchanged: /v1/realtime?model= is still live, so session.ts needs no change.
        r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            session: {
              type: 'realtime',
              model: env.REALTIME_MODEL,
              audio: { output: { voice: 'alloy' } },
            },
          }),
        });
      } catch (err) {
        // A thrown fetch (network/DNS/TLS failure) is a runtime fault like any other —
        // same discipline as the KV wrappers above: structured refusal, never an
        // unhandled rejection reaching the platform's default error page.
        console.error('realtime token mint request threw', err);
        return jsonForOrigin({ error: 'token_mint_failed' }, 502, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      }
      if (!r.ok) {
        // The upstream error body can embed a partially-redacted API key plus org/project
        // ids. Never relay it to an unauthenticated caller — log it, return a bare code.
        console.error('realtime token mint failed', r.status, await r.text().catch(() => '<unreadable body>'));
        return jsonForOrigin({ error: 'token_mint_failed' }, 502, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      }
      let payload: unknown;
      try { payload = await r.json(); }
      catch (err) {
        console.error('realtime token response was not valid JSON', err);
        return jsonForOrigin({ error: 'token_mint_failed' }, 502, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      }
      // Normalize to the shape the widget has always consumed ({ client_secret: { value },
      // model }) rather than relaying this endpoint's own ({ value, expires_at, session }).
      // Keeping the contract here means session.ts's WebRTC handshake — and every test
      // around it — is untouched by an upstream rename, and `model` stays authoritative
      // from config instead of being read back out of a response we'd then have to trust.
      const value = (payload as { value?: unknown } | null)?.value;
      if (typeof value !== 'string' || !value) {
        console.error('realtime token response carried no usable client secret');
        return jsonForOrigin({ error: 'token_mint_failed' }, 502, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      }
      return jsonForOrigin({ client_secret: { value }, model: env.REALTIME_MODEL }, 200, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
    }

    // ---- WebAuthn: the authorization boundary lives here, not in the page ----
    //
    // Request shape for /api/webauthn/options, POST body:
    //   { requestId: string, tool: string, deviceId: string,
    //     orderId?: string, itemId?: string, reason?: ReturnReason }
    // requestId and deviceId: non-empty, <=128 chars, no ':'. tool: non-empty string
    // (validated against the real allowlist later, at /api/act — anything else here is
    // simply inert). orderId/itemId/reason are REQUIRED when tool === 'confirm_return'
    // (reason must be one of 'defect' | 'changed-mind' | 'wrong-item' |
    // 'damaged-in-transit') and are ignored/optional for every other tool. Whatever is
    // supplied here is what /api/act will act on later — there is no second chance to
    // supply or correct it at confirm time, by design (see /api/act below).
    // Response: unchanged — { mode: 'register' | 'authenticate', publicKey: <WebAuthn options> }.
    if (url.pathname === '/api/webauthn/options' && req.method === 'POST') {
      const body = await readJson<{
        requestId: string; tool: string; deviceId: string; tenant?: string;
        orderId?: string; itemId?: string; reason?: string; scope?: string; address?: string;
      }>(req);
      if (!body || !isSafeId(body.requestId) || !isSafeId(body.deviceId) || typeof body.tool !== 'string' || !body.tool) {
        return json({ error: 'bad_request' }, 400);
      }
      const { requestId, tool, deviceId } = body;
      // Bound into the record now so /api/act uses both the catalogue and assurance
      // policy the page actually showed. Tenant C was once discarded here, which made
      // clinic tokens inherit the shop's trusted-click setting at spend time.
      const tenant = tenantId(body.tenant);

      // confirm_return's eligibility is decided from whatever is bound to the ceremony
      // HERE, at options time — never read again from the /api/act request body. A page
      // must commit to the specific order/item/reason it is asking the person to confirm
      // before the person authenticates, not adjust it afterward.
      const bound = bindSubject(tool, body);
      if (!bound) return json({ error: 'missing_eligibility_fields' }, 400);
      if (isSubjectBindingFailure(bound)) {
        return json({ error: bound.error, message: bound.message }, 400);
      }
      const { orderId, itemId, reason, scope, address } = bound;

      const credRead = await safeGet<{ id: string; publicKey: string }>(env, `3way:cred:${deviceId}`, 'json');
      if (!credRead.ok) return json({ error: 'storage_error' }, 500);
      const stored = credRead.value;
      const mode: 'register' | 'authenticate' = stored ? 'authenticate' : 'register';
      let options;
      try {
        options = mode === 'authenticate'
          ? await generateAuthenticationOptions({ rpID: env.RP_ID, userVerification: 'required',
              allowCredentials: [{ id: stored!.id }] })
          : await generateRegistrationOptions({
              rpName: env.RP_NAME, rpID: env.RP_ID,
              // There is no real user identity here; the device id is the account key.
              userName: deviceId, userID: new TextEncoder().encode(deviceId),
              authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' } });
      } catch (err) {
        console.error('webauthn options generation failed', err);
        return json({ error: 'webauthn_options_failed' }, 400);
      }
      // Challenge is bound to the requestId and expires; a stale one cannot be reused.
      // It remembers everything /verify and /act will need to trust later — tool, mode,
      // deviceId, and (for confirm_return) the exact order/item/reason — so none of them
      // is ever re-read from a client-supplied body downstream of this point.
      const record: ChallengeRecord = { challenge: options.challenge, tool, deviceId, mode, tenant, orderId, itemId, reason, scope, address };
      if (!(await safePut(env, `3way:chal:${requestId}`, JSON.stringify(record), 300))) {
        return json({ error: 'storage_error' }, 400);
      }
      return json({ mode, publicKey: options });
    }

    if (url.pathname === '/api/webauthn/verify' && req.method === 'POST') {
      const body = await readJson<{ requestId: string; credential: unknown }>(req);
      if (!body || !isSafeId(body.requestId) || !body.credential) return json({ error: 'bad_request' }, 400);
      const { requestId, credential } = body;
      const chalRead = await safeGet<ChallengeRecord>(env, `3way:chal:${requestId}`, 'json');
      if (!chalRead.ok) return json({ error: 'storage_error' }, 500);
      const pendingChal = chalRead.value;
      if (!pendingChal) return json({ error: 'no_challenge' }, 400);
      // Failing to burn the challenge must refuse the ceremony rather than proceed as if
      // it had been consumed — same fail-closed direction as everything else here.
      if (!(await safeDelete(env, `3way:chal:${requestId}`))) return json({ error: 'storage_error' }, 500);
      // mode, tool, deviceId, and the eligibility triple all come from the challenge
      // record the Worker itself wrote at /options time — NEVER from this request body.
      // A client that supplied its own mode here could request `authenticate` options for
      // someone else's deviceId, then post mode:"register" and overwrite that device's
      // stored public key with one it controls, with no proof of possession of the
      // original private key. Same bug class as trusting a client-supplied `tool` (see
      // verify.ts) or a client-supplied eligibility triple (see /api/act below) — one
      // field over each time.
      const { challenge: expectedChallenge, tool, deviceId, mode, tenant, orderId, itemId, reason, scope, address } = pendingChal;

      const common = { expectedChallenge, expectedOrigin: expectedOrigins(env), expectedRPID: env.RP_ID };
      if (mode === 'register') {
        // A device that already has a stored credential cannot register a second one
        // through this path — that would be the same credential-overwrite hole above,
        // just reached by winning a race instead of lying about mode.
        const existingCred = await safeGet<unknown>(env, `3way:cred:${deviceId}`);
        if (!existingCred.ok) return json({ error: 'storage_error' }, 500);
        if (existingCred.value) return json({ error: 'already_registered' }, 400);
        let v;
        try { v = await verifyRegistrationResponse({ response: credential as any, ...common }); }
        catch (err) { console.error('webauthn registration verification threw', err); return json({ error: 'bad_registration' }, 400); }
        if (!v.verified || !v.registrationInfo) return json({ error: 'bad_registration' }, 400);
        const credRecord = {
          id: v.registrationInfo.credential.id,
          publicKey: btoa(String.fromCharCode(...v.registrationInfo.credential.publicKey)),
          counter: v.registrationInfo.credential.counter,
        };
        if (!(await safePut(env, `3way:cred:${deviceId}`, JSON.stringify(credRecord)))) {
          return json({ error: 'storage_error' }, 400);
        }
      } else {
        const storedRead = await safeGet<any>(env, `3way:cred:${deviceId}`, 'json');
        if (!storedRead.ok) return json({ error: 'storage_error' }, 500);
        const stored = storedRead.value;
        if (!stored) return json({ error: 'unknown_credential' }, 400);
        let v;
        try {
          v = await verifyAuthenticationResponse({
            response: credential as any, ...common, requireUserVerification: true,
            credential: {
              id: stored.id,
              publicKey: Uint8Array.from(atob(stored.publicKey), c => c.charCodeAt(0)),
              counter: stored.counter,
            },
          });
        } catch (err) { console.error('webauthn assertion verification threw', err); return json({ error: 'bad_assertion' }, 400); }
        if (!v.verified) return json({ error: 'bad_assertion' }, 400);
      }

      // Single-use, short-lived, and IS the record of what it authorizes — requestId,
      // tool, deviceId, and (for confirm_return) the exact order/item/reason bound at
      // /options time. /api/act looks this up only by the token itself, never by
      // anything the caller supplies, so there is no shared, guessable key (like the
      // requestId alone) for one caller's lookup to ever land on another caller's record.
      const token = crypto.randomUUID();
      const tokenRecord: TokenRecord = {
        requestId, tool, deviceId, tenant, orderId, itemId, reason, scope, address, used: false, assurance: 'webauthn',
      };
      if (!(await safePut(env, `3way:tok:${token}`, JSON.stringify(tokenRecord), 300))) {
        return json({ error: 'storage_error' }, 400);
      }
      return json({ token });
    }

    // ---- Session ticket for /api/trusted-click. This one IS Origin-checked (see
    // forbiddenOrigin above) — a browser running a DIFFERENT site's page cannot mint a
    // ticket via a normal fetch. That is the entire narrowing this endpoint buys: a
    // non-browser caller still sets any Origin header it likes, so this is a speed bump
    // against a page-script adversary reaching /api/trusted-click through someone else's
    // browser, not a boundary against anyone willing to forge one header. It does NOT
    // authenticate the caller, and it does not make /api/trusted-click itself safe to
    // reach unauthenticated — see that handler's comment, directly below, for the full
    // severity account of what this does and does not close.
    //
    // Ticket is short-lived (120s), single-use (checked and burned by /api/trusted-click
    // before it mints), and bound to the deviceId it was issued for — /api/trusted-click
    // refuses a ticket whose bound deviceId doesn't match the one presented alongside it.
    //
    // Request shape, POST body: { deviceId: string, tenant?: string }.
    // Response: { ticket: string }.
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const denied = forbiddenOrigin(req, env);
      if (denied) return denied;
      const body = await readJson<{ deviceId: string; tenant?: string }>(req);
      if (!body || !isSafeId(body.deviceId)) return jsonForOrigin({ error: 'bad_request' }, 400, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      const tenant = tenantId(body.tenant);
      // No reason to hand out a ticket for a path this tenant's policy closes. Reading
      // POLICY_RULES unconditionally let tenant C mint a weak ticket even after the
      // clinic policy was changed to refuse.
      if (policyForTenant(tenant).onMissingAuthenticator !== 'trusted-click') {
        return jsonForOrigin({ error: 'trusted_click_not_permitted' }, 403, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      }
      const ticket = crypto.randomUUID();
      if (!(await safePut(env, `3way:sess:${ticket}`, JSON.stringify({
        deviceId: body.deviceId, ...(tenant ? { tenant } : {}),
      }), 120))) {
        return jsonForOrigin({ error: 'storage_error' }, 400, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
      }
      return jsonForOrigin({ ticket }, 200, matchedOrigin(req, env) ?? expectedOrigins(env)[0]!);
    }

    // ---- The weaker layer. No signature to check, so nothing here is cryptographically
    // verified — the Worker is taking the browser's word that isUserVerifyingPlatform-
    // AuthenticatorAvailable() returned false. It cannot check that claim directly (that
    // API only exists client-side); it enforces the things it actually can: the bound
    // domain/tool policy must read 'trusted-click' (never reachable when that policy
    // reads 'refuse' — the setting to ship for anything real), the caller must present a
    // session ticket minted for this SAME deviceId by the Origin-checked /api/session
    // above, and this deviceId must never have registered a real credential HERE — a
    // device that has would be directly contradicting the claim this endpoint exists to
    // record. None of that proves the device truly lacks hardware, or that whoever is
    // calling right now is the one the browser made that claim on behalf of. That is why
    // the minted token is stamped 'trusted-click', not 'webauthn': an AUDITABLE RECORD,
    // not a VERIFIED FACT.
    //
    // SEVERITY, stated precisely rather than left to be discovered by reading further:
    // this endpoint itself (and /api/act, spending the token it mints) carries NO Origin
    // check — unlike /api/session immediately above and /api/realtime-token, which call
    // forbiddenOrigin for exactly this
    // reason. So the adversary here is still not limited to "a page-script or
    // CDP-driven agent with code execution inside a victim's browser" — it is any caller
    // who knows the Worker URL and can present one Origin
    // header matching EXPECTED_ORIGIN on the /api/session call, which any non-browser
    // caller does simply by setting it. The session ticket NARROWS the reproduction, it
    // does not CLOSE it — three POSTs and a forged Origin header, instead of two bare
    // ones:
    //   POST /api/session       {deviceId:<fresh>}  Origin: <EXPECTED_ORIGIN>          -> {ticket}
    //   POST /api/trusted-click {requestId, tool, deviceId:<same>, sessionTicket,
    //                            orderId, itemId, reason}                              -> {token}
    //   POST /api/act            {tool, requestId, token}                              -> {ok:true, ...}
    // That stops a caller who merely learned this URL with nothing else, and it stops a
    // DIFFERENT site's page from driving this flow from a real browser (the Origin check
    // on /api/session refuses it there). It does NOT stop anyone who opens the demo page
    // and reads the network tab — the header to forge is right there — and it does NOT
    // stop any non-browser caller willing to set one header. Say that plainly; do not let
    // this comment, or any other, imply a boundary that isn't one.
    // 'refuse' remains the only setting this project ships safe for anything real, for
    // exactly this reason — and this deployment does not use it: config/policy.ts opts
    // in to 'trusted-click' so the showcase completes in the one measured runtime with
    // no platform authenticator. There is no "default" to fall back on here either;
    // PolicyRules requires the field. What fails closed on absence is the WIDGET (see
    // gates.ts, verify.ts), not this Worker. See README.md's "Layered assurance"
    // section for the full account.
    //
    // Request shape, POST body: identical fields to /api/webauthn/options (requestId,
    // tool, deviceId, tenant?, orderId?, itemId?, reason?) plus `sessionTicket: string`
    // — minted by /api/session for this same deviceId, single-use, checked and burned
    // here before a token is minted. Same eligibility-triple validation as /options:
    // confirm_return's is REQUIRED here for exactly the same reason it is there: bound to
    // this token before /api/act ever runs, never re-suppliable then. Response: { token }
    // — spent at /api/act exactly like a webauthn-minted one.
    if (url.pathname === '/api/trusted-click' && req.method === 'POST') {
      const body = await readJson<{
        requestId: string; tool: string; deviceId: string; sessionTicket: string; tenant?: string;
        orderId?: string; itemId?: string; reason?: string; scope?: string; address?: string;
      }>(req);
      if (!body || typeof body.tool !== 'string' || !body.tool) {
        return json({ error: 'bad_request' }, 400);
      }
      const { tool } = body;
      const tenant = tenantId(body.tenant);
      if (policyForTool(tool, tenant).onMissingAuthenticator !== 'trusted-click') {
        return json({ error: 'trusted_click_not_permitted' }, 403);
      }
      // Policy is intentionally checked before ticket validation so a closed path does
      // not reveal whether any supplied ticket exists. Tenant/tool must be parsed first
      // solely to select the correct policy; every key-bearing field still fails closed.
      if (!isSafeId(body.requestId) || !isSafeId(body.deviceId) || !isSafeId(body.sessionTicket)) {
        return json({ error: 'bad_request' }, 400);
      }
      const { requestId, deviceId, sessionTicket } = body;

      const bound = bindSubject(tool, body);
      if (!bound) return json({ error: 'missing_eligibility_fields' }, 400);
      if (isSubjectBindingFailure(bound)) {
        return json({ error: bound.error, message: bound.message }, 400);
      }
      const { orderId, itemId, reason, scope, address } = bound;

      // The one piece of independent evidence the Worker actually has: a device that has
      // ALREADY registered a real credential here is contradicting its own "no
      // authenticator" claim right now. Refuse rather than let a stale or false claim
      // override evidence already on file — this is the check that keeps "genuinely
      // absent" from degrading into "whatever the client feels like asserting" for any
      // device this Worker has already seen prove otherwise.
      const credRead = await safeGet<unknown>(env, `3way:cred:${deviceId}`);
      if (!credRead.ok) return json({ error: 'storage_error' }, 500);
      if (credRead.value) return json({ error: 'device_has_authenticator' }, 403);

      // The ticket narrows who can reach this far — it proves whoever holds it recently
      // completed an Origin-checked /api/session call for this same deviceId, nothing
      // more. Checked and burned here, after the credential check above (so a caller who
      // fails either check gets a response that doesn't reveal which one) and before a
      // token is minted (so a caller who fails this check can never spend one).
      const sessRead = await safeGet<{ deviceId: string; tenant?: string }>(
        env, `3way:sess:${sessionTicket}`, 'json');
      if (!sessRead.ok) return json({ error: 'storage_error' }, 500);
      if (!sessRead.value || sessRead.value.deviceId !== deviceId
        || tenantId(sessRead.value.tenant) !== tenant) {
        // Tenant is part of the ticket binding so a ticket minted while the shop's weak
        // path is open cannot be carried into a clinic request whose policy refuses it.
        return json({ error: 'session_required' }, 403);
      }
      // Single-use: delete before minting, and refuse — rather than mint a token whose
      // ticket may still be spendable — if the delete itself fails. This codebase has
      // already been bitten once by making single-use enforcement contingent on a write
      // that is allowed to fail (see /api/act's own used-token handling below); refusing
      // here is the same discipline applied one layer earlier.
      if (!(await safeDelete(env, `3way:sess:${sessionTicket}`))) return json({ error: 'storage_error' }, 500);

      const token = crypto.randomUUID();
      const tokenRecord: TokenRecord = {
        requestId, tool, deviceId, tenant, orderId, itemId, reason, scope, address, used: false, assurance: 'trusted-click',
      };
      if (!(await safePut(env, `3way:tok:${token}`, JSON.stringify(tokenRecord), 300))) {
        return json({ error: 'storage_error' }, 400);
      }
      return json({ token });
    }

    // ---- The authoritative gate. The browser's check is advisory; this one is not. ----
    if (url.pathname === '/api/act' && req.method === 'POST') {
      const body = await readJson<{
        tool: string; requestId: string; token?: unknown; tenant?: string;
        orderId?: string; itemId?: string; reason?: string; scope?: string; address?: string;
      }>(req);
      if (!body) return json({ ok: false, error: 'bad_request' }, 400);
      const { tool, requestId, token } = body;
      const declaredTenant = tenantId(body.tenant);

      // Allowlist first, before anything else runs: an inexact match ("Confirm_Return",
      // a trailing space, an unrecognized tool entirely) must 404, not silently fall
      // through the gate below and return ok:true. requiresHumanDirect is also the
      // complete set of tools that ever reach this endpoint (see tools.ts's `gated`) —
      // one source of truth, no second list to drift out of sync with it.
      // The allowlist is the union of every tenant's gated tools. Keyed off the policies
      // themselves rather than a hand-written list, so a tenant that adds a gated action
      // cannot forget to add it here — and one that removes it closes this door too.
      const GATED = [...POLICY_RULES.requiresHumanDirect, ...CLINIC_POLICY_RULES.requiresHumanDirect];
      if (typeof tool !== 'string' || !GATED.includes(tool) || !isSafeId(requestId)) {
        return json({ error: 'not_found' }, 404);
      }

      // A supplied token always takes the stronger path, even while the demo toggle is
      // weak. With no token, only an explicit `false` in this tool's own domain policy
      // opens the deliberately weak branch below; missing or garbage remains closed.
      if (token !== undefined && token !== null && token !== '') {
        if (typeof token !== 'string') {
          return json({ ok: false, error: 'confirmation_required' }, 403);
        }
        // Validated the same way as requestId/deviceId, and for the same reason: an
        // oversized or ':'-containing token is client-supplied KV key material too, and
        // must not reach KV.get unvalidated (that throws → 500) — it is simply an invalid
        // token, not a missing one, so it gets invalid_token rather than confirmation_required.
        if (!isSafeId(token)) {
          return json({ ok: false, error: 'invalid_token' }, 403);
        }

        // The token IS the credential: minted for exactly one completed ceremony, and
        // looked up only by itself — never by requestId, which is client-chosen and NOT
        // unique across visitors (the widget mints them as req-1, req-2, … per mount).
        // An earlier version of this gate cached results under a requestId+tool key and
        // checked that cache before authenticating at all: an unauthenticated caller who
        // simply guessed another visitor's requestId got that visitor's cached result —
        // their eligibility reasons, their order detail — and a genuine visitor whose
        // requestId collided with a stranger's got the stranger's answer instead of their
        // own action ever running. Keying on the token instead of requestId closes that:
        // nothing here is reachable without the unguessable value that only the person
        // who completed the ceremony (and the browser that ran it) ever holds.
        // A failed read is folded into the same invalid_token refusal as a genuinely
        // unknown token, deliberately — both "the token doesn't exist" and "we couldn't
        // check" resolve to "the action does not proceed," and giving them the same
        // response tells an unauthenticated caller nothing about which one occurred.
        const tokenRead = await safeGet<TokenRecord>(env, `3way:tok:${token}`, 'json');
        if (!tokenRead.ok || !tokenRead.value) return json({ ok: false, error: 'invalid_token' }, 403);
        const record = tokenRead.value;
        // Belt-and-suspenders: the token was minted for exactly this (requestId, tool);
        // a token from one ceremony presented alongside a different declared action is
        // rejected even though nothing is parsed out of a combined string anymore.
        if (record.requestId !== requestId || record.tool !== tool) {
          return json({ ok: false, error: 'invalid_token' }, 403);
        }
        // Re-check the policy bound to this token's domain. Reading POLICY_RULES here
        // unconditionally let a clinic trusted-click token survive a clinic policy flip
        // whenever the shop remained open to the weaker assurance.
        if (record.assurance === 'trusted-click'
          && policyForTool(record.tool, tenantId(record.tenant)).onMissingAuthenticator !== 'trusted-click') {
          return json({ ok: false, error: 'invalid_token' }, 403);
        }

        if (record.used) {
          // Replay. Two ways to land here, and neither is fully closed by this record:
          // (a) two requests genuinely concurrent, both reading `used: false` before
          // either write below lands — KV has no compare-and-swap; or (b) a plain
          // SEQUENTIAL retry that reads a stale `used: false` because Workers KV is only
          // eventually consistent (writes can take up to ~60s to propagate to every
          // colo), so a second request routed to a different colo shortly after the first
          // can observe the pre-write value with no concurrency involved at all. Either
          // way, hand back the exact result already computed for this one ceremony — no
          // new work runs. What this DOES close: because the record is scoped to this one
          // token, that residual window can only ever re-run THIS ceremony's own action a
          // second time, never leak or act on a different visitor's data. A Durable Object
          // keyed on the token would eliminate the remaining consistency window by burning
          // it inside one invocation.
          return json(record.result ?? { ok: false, error: 'invalid_token' }, record.resultStatus ?? 403);
        }

        // Authorizing the PERSON is necessary but not sufficient, and binding this triple
        // does NOT make the page's declaration of it trustworthy — a patched page can
        // still bind reason:"defect" at /options while showing the human a change-of-mind
        // return, and that dishonesty is outside what this Worker can see: the person is
        // trusting the page's UI. This binding does prevent a stolen or replayed token
        // from being redirected at a different action, or
        // completed with an order/item/reason other than the one actually presented to
        // the person at confirm time. On this strong path orderId/itemId/reason come only
        // from THIS record — bound at /options time — and any copies in the request body
        // are ignored. The body fields exist solely for the explicitly tokenless demo.
        const { result, status } = executeBoundAction(tool, requestId, record, now);

        // Mark used and store the result under the SAME key, on a longer TTL, so a
        // legitimate retry (or a concurrent duplicate landing second) gets this exact
        // answer instead of invalid_token once the short minting TTL would otherwise have
        // expired it. This write is NOT allowed to fail silently: if it does not land,
        // the token is still `used: false` in KV and stays spendable for the rest of its
        // TTL — single-use would degrade to multi-use for whoever tries it again. Refuse
        // instead of returning the computed result; the token is untouched, so a retry
        // (by the same caller, once the transient KV failure clears) completes normally.
        if (!(await safePut(env, `3way:tok:${token}`, JSON.stringify({ ...record, used: true, result, resultStatus: status }), 3600))) {
          console.error('failed to persist token result; refusing rather than leaving it spendable', token);
          return json({ ok: false, error: 'storage_error' }, 500);
        }
        return json(result, status);
      }

      const weakPolicy = policyForTool(tool, declaredTenant);
      if (weakPolicy.requireHardwareConfirmation !== false) {
        return json({ ok: false, error: 'confirmation_required' }, 403);
      }

      // Deliberately weak demo authorization: no ceremony and no token, so the subject
      // below is only the caller's assertion and can be forged. That weakness is the
      // point of the toggle and is not softened into a promise. It still goes through the
      // same binder and executor as the strong path, so weakening WHO authorizes cannot
      // silently add a second generic implementation of WHAT the tool does.
      const weakBound = bindSubject(tool, body);
      if (weakBound && isSubjectBindingFailure(weakBound)) {
        return json({ error: weakBound.error, message: weakBound.message }, 400);
      }
      const { result, status } = executeBoundAction(tool, requestId, {
        ...(weakBound ?? {}), tenant: declaredTenant,
      }, now);
      return json(result, status);
    }

    // 'C' is the clinic — a different DOMAIN rather than a second storefront, which is the
    // whole reason it exists (see config/clinic.ts).
    const isClinic = url.searchParams.get('tenant') === 'C';

    if (url.pathname === '/api/orders' && req.method === 'GET') {
      return json({ user: USER, orders: seedOrders(now) });
    }

    // The config a one-tag embed needs before it can mount (packages/widget/src/autoMount.ts).
    //
    // The policy lives here rather than in the page on purpose, and not only for embed
    // ergonomics: this Worker is already the authoritative gate's source of truth for the
    // same rules, so serving them from one place is what stops a page showing a person one
    // policy while /api/act enforces another.
    //
    // Public by design — a returns policy is published anyway, and the prose is the same
    // text the store's own /returns page carries. No Origin check, matching /api/products:
    // gating it would break the one-tag embed on any page that legitimately wants it, and
    // there is nothing here that is not already public.
    if (url.pathname === '/api/config' && req.method === 'GET') {
      if (isClinic) {
        return json({
          policy: { prose: CLINIC_POLICY_PROSE, rules: CLINIC_POLICY_RULES },
          stances: CLINIC_STANCES,
          stance: 'policy-bound',
          storeAgentName: `${CLINIC_NAME} records desk`,
        });
      }
      return json({
        policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
        stances: STANCES,
        stance: 'policy-bound',
        storeAgentName: 'Halden Support',
      });
    }

    if (url.pathname === '/api/visits' && req.method === 'GET') {
      // Visits carry the CATEGORIES of record each produced, never the records. Those live
      // in CLINIC_DOCUMENTS and are returned by /api/act alone, against a spent token —
      // the same rule ORDER_RECORDS follows, and for the same reason: a gate in front of
      // data the page already holds is theatre.
      return json({ user: CLINIC_USER, visits: seedVisits(now), restricted: RESTRICTED_CATEGORIES });
    }

    if (url.pathname === '/api/products' && req.method === 'GET') {
      const catalogue = PRODUCTS;
      // Every term must appear somewhere in title+description+sku, in any order — NOT the
      // whole query as one substring, which is what this did before. "Halden lamp" then
      // returned nothing when an extra model word sat between the search terms. That is
      // one of the two phrasings
      // the product's return flow suggests, and the natural way an agent relays a
      // question about "the Halden lamp"; the store agent's only honest reply to an empty
      // catalogue is that it has nothing, which is false.
      //
      // AND across terms, deliberately, not OR: one common word ("lamp") should narrow the
      // answer as more words are added, never drag the whole catalogue into it. Hyphens are
      // kept inside terms so a SKU stays a single term and get_product's `?q=<sku>` lookup
      // still resolves to exactly one product.
      const terms = (url.searchParams.get('q') ?? '').toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
      const products = terms.length
        ? catalogue.filter(p => {
          const haystack = `${p.title} ${p.description} ${p.sku}`.toLowerCase();
          return terms.every(t => haystack.includes(t));
        })
        : catalogue;
      return json({ products });
    }

    return json({ error: 'not_found' }, 404);
  },
};
