import { createBus } from './bus';
import { createTools, scopeFor, withPiggyback, DEFAULT_HOLD_MS, type DataSource } from './tools';
import { createClinicTools, type ClinicDataSource, type ClinicVisit } from './clinic';
import { isAuthenticatorAvailable, randomId } from './verify';
import { getModelContext, registerWebMCP } from './webmcp';
import { autoMount as autoMountOnLoad } from './autoMount';
import { buildClinicSystemPrompt, buildSystemPrompt } from './prompt';
import { createSession, type Session } from './session';
import { createModal } from './ui/modal';
import type { Order, PendingRequest, Policy, Product, StanceKey } from './types';

export interface WidgetConfig {
  apiBase: string;
  policy: Policy;
  stance: StanceKey;
  /**
   * A tenant's own stance presets (e.g. this repo's flagship site, via config/stances.ts)
   * — passed straight through to buildSystemPrompt's own injectable parameter. Omit to
   * use the library's DEFAULT_STANCES, unchanged from before this field existed. This is
   * the seam that lets the published library ship with no tenant's presets hard-bundled.
   */
  stances?: Record<StanceKey, string>;
  mountTo?: HTMLElement;
  /**
   * Display name only — folded into the store agent's system prompt (buildSystemPrompt)
   * so it can address the customer by name; nothing security-relevant reads it. Credentials
   * are keyed on a per-device id generated in the browser, never on this — see verify.ts
   * deviceId().
   */
  userName?: string;
  /**
   * Display label for the store's own agent in the transcript (e.g. "Halden Support").
   * Defaults to "Store" when omitted. This is a shared bundle — a tenant's name must
   * never be hardcoded into it, or every OTHER adopter's transcript shows the first
   * tenant's name too (see ui/modal.ts's LABEL).
   */
  storeAgentName?: string;
  /** Set false in tests to skip opening a live session. */
  autoStart?: boolean;
  /**
   * How long a refused gated call from the visiting agent is held open for the person to
   * act before the refusal is returned (`GatewayDeps.holdMs`). Defaults to the same 25 s
   * await_reply uses. 0 restores the older shape — refused at once, agent hands off in
   * its own words, then must choose to wait. Not part of `/api/config`: it is timing,
   * not policy. See docs/WEBMCP.md, "Holding a refused call open".
   */
  holdMs?: number;
  /**
   * Selects which store's seed data a shared Worker serves. Omit for the default
   * (flagship) tenant — the request URLs are then unchanged from before this existed.
   */
  tenant?: string;
  /**
   * Which tool registry to expose. 'shop' is the default and is what every existing
   * embed gets. 'clinic' swaps the DOMAIN tools — visits and disclosures rather than
   * orders and refunds — over the identical gateway: same transcript, same stamped
   * origins, same refusal shape, same gate. That substitution demonstrates that the
   * coordination layer is domain-neutral.
   */
  domain?: 'shop' | 'clinic';
  /**
   * Keyholder mode (the default, false): the page shows the open ledger and the person's
   * only affordance is authorizing a consequential step — no text composer, so there is
   * no human-typing surface for an agent to impersonate. Composer mode (true) also gives
   * the person a text box in the thread; select it per page with data-3way-input="composer".
   * The clinic runs Composer mode because its flow needs information only the person can
   * supply. Not part of /api/config: it is presentation, not policy.
   */
  composer?: boolean;
}

export interface WidgetHandle {
  surface: 'document' | 'navigator' | 'none';
  /** Undefined until the mount-time probe resolves. */
  authenticator?: boolean;
  session: Session;
  destroy(): void;
}

export function createHttpDataSource(apiBase: string, tenant?: string): DataSource {
  // Omitted entirely (not sent as an empty string) when no tenant is configured, so the
  // flagship's request URLs are byte-for-byte unchanged from before this parameter
  // existed. The Worker reads it via url.searchParams.get('tenant') and falls back to
  // the default seed data for a missing or unrecognized value — same behavior either way.
  const ordersQuery = tenant === undefined ? '' : `?tenant=${encodeURIComponent(tenant)}`;
  const tenantParam = tenant === undefined ? '' : `&tenant=${encodeURIComponent(tenant)}`;
  const get = async <T>(path: string): Promise<T> =>
    (await (await fetch(`${apiBase}${path}`)).json()) as T;
  let cache: Order[] | null = null;
  const orders = async () => (cache ??= (await get<{ orders: Order[] }>(`/api/orders${ordersQuery}`)).orders);
  return {
    listOrders: orders,
    getOrder: async id => (await orders()).find(o => o.orderId === id) ?? null,
    searchProducts: async q =>
      (await get<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(q)}${tenantParam}`)).products,
    getProduct: async sku =>
      (await get<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(sku)}${tenantParam}`)).products[0] ?? null,
  };
}

/**
 * Categories a routine release never carries. Defaulted here rather than fetched, so the
 * widget fails SAFE if a config endpoint ever omits them: an unknown category is treated
 * as routine only when the deployment says so explicitly.
 */
const RESTRICTED_DEFAULT = ['mental-health', 'substance-use', 'genetic'] as const;

/** The clinic's read surface. Visits carry categories; the records themselves never travel here. */
export function createClinicHttpDataSource(apiBase: string): ClinicDataSource {
  const visits = async () =>
    (await fetch(`${apiBase}/api/visits?tenant=C`).then(r => r.json() as Promise<{ visits: ClinicVisit[] }>)).visits;
  return {
    listVisits: visits,
    getVisit: async id => (await visits()).find(v => v.visitId === id) ?? null,
  };
}

export function mount(config: WidgetConfig): WidgetHandle {
  let seq = 0;
  const bus = createBus({ now: () => Date.now(), id: () => `e${++seq}` });
  const data = createHttpDataSource(config.apiBase, config.tenant);
  const clinicData = createClinicHttpDataSource(config.apiBase);

  let onConfirmationNeeded: (req: PendingRequest, tool: string) => void = () => {};
  let onHold: (requestId: string, tool: string) => void = () => {};
  // One gateway, two domains. Everything below this line — the transcript, the stamped
  // origins, the refusal shape, the ceremony — is identical either way; only the domain
  // tools differ. That substitution IS the argument that this layer is not about shopping.
  const makeTools = config.domain === 'clinic'
    ? (d: Parameters<typeof createTools>[0]) =>
        createClinicTools({ ...d, data: clinicData, restrictedCategories: RESTRICTED_DEFAULT })
    : createTools;
  const tools = makeTools({
    bus, data, policy: config.policy,
    now: () => Date.now(),
    // A bare `req-${++seq}` collides across visitors: `seq` restarts at 1 on every
    // mount(), so two people on the same live URL both mint `req-2` at roughly the same
    // point in their conversation — no malice needed, especially during concurrent use.
    // The Worker keys challenges/tokens globally by requestId (see
    // worker/src/index.ts), so a collision lets one visitor's /options overwrite
    // another's mid-ceremony. The random suffix only needs to keep passing isSafeId
    // (<=128 chars, no ':') and sanitizeRequestId's [A-Za-z0-9_-] — randomId() (verify.ts)
    // already satisfies both, and is reused rather than re-implemented here.
    newRequestId: () => `req-${++seq}-${randomId()}`,
    // The Worker's authoritative gate reads the device and the eligibility triple from
    // the token record it wrote at /options time (see session.ts's confirmRequest /
    // verify.ts's verifyHumanPresence) — never from this call. Send exactly what the
    // Worker's /api/act now accepts; anything more invites a future reader to believe
    // those fields still matter here.
    act: async (tool, requestId, token, weakSubject) => {
      const r = await fetch(`${config.apiBase}/api/act`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tool, requestId, token,
          // A real token already binds these fields in the Worker's record, so resending
          // them would create an apparent second source of authority. The demo-weak path
          // has no token by design and is explicitly forgeable; it supplies the displayed
          // subject only so both assurance modes share one binder and executor.
          ...(token === null && weakSubject ? {
            tenant: config.tenant, orderId: weakSubject.orderId, itemId: weakSubject.itemId,
            reason: weakSubject.reason ?? undefined, scope: weakSubject.scope,
            address: weakSubject.address,
          } : {}),
        }),
      });
      const parsed = await r.json().catch(() => null) as unknown;
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
      // HTTP status is transport metadata, not the action stamp. A proxy can return a
      // 2xx body that is empty or unrelated, while a 502 can arrive after the upstream
      // action completed. Only the Worker's parsed `ok` field establishes an outcome;
      // anything ambiguous throws into gated()'s terminal indeterminate path.
      if (r.ok && body?.ok === true) {
        const { ok: _stamp, ...data } = body;
        return { ok: true, data };
      }
      // A structured 4xx is an application refusal the Worker deliberately stamped.
      // Server/gateway failures remain indeterminate even if an intermediary happens to
      // attach refusal-shaped JSON: they cannot establish whether upstream acted.
      if (r.status >= 400 && r.status < 500 && body?.ok === false) {
        return { ok: false,
          error: typeof body.error === 'string' ? body.error : 'refused' };
      }
      throw new Error(`Indeterminate /api/act response (${r.status})`);
    },
    onConfirmationNeeded: (req, tool) => onConfirmationNeeded(req, tool),
    // The deployed widget holds a refused gated call open for the visiting agent until
    // the person acts (see GatewayDeps.holdMs). Opted into HERE, not defaulted in the
    // gateway, so a hand-built registry — every test fixture — keeps answering at once.
    holdMs: config.holdMs ?? DEFAULT_HOLD_MS,
    onHold: (requestId, tool) => onHold(requestId, tool),
    // Read once, here, rather than inside tools.ts: keeps the registry free of DOM globals
    // and testable without one.
    siteOrigin: location.origin,
  });

  // Piggyback wraps the VISITING agent's view only — the site's own agent is already
  // in the session and sees the log directly. One cursor per consumer.
  const mc = getModelContext();
  // Narrated to the person as it happens. The modal does not exist yet at this point in
  // mount(), so this reads it through the same late-bound handle onConfirmationNeeded uses.
  let onActivity: (activity: string) => void = () => {};
  const unregister = registerWebMCP(
    withPiggyback(scopeFor(tools, 'visiting-agent'), bus, a => onActivity(a)), mc);

  const session = createSession({
    apiBase: config.apiBase,
    now: () => Date.now(),
    tokenUrl: `${config.apiBase}/api/realtime-token`,
    // The store's agent gets a narrower view: no send_message, no provide_context.
    tools: scopeFor(tools, 'site-agent'),
    // Selected by the SAME flag that selects the tool registry, forty lines above. The
    // domain substitution swapped the tools and left this on the shop's builder, so the
    // clinic's agent was briefed as a store and pointed at list_my_orders — a tool its
    // own registry does not contain.
    systemPrompt: (config.domain === 'clinic' ? buildClinicSystemPrompt : buildSystemPrompt)(
      config.stance, config.policy, config.stances, config.userName),
    bus,
    // So confirmRequest can honour requireHardwareConfirmation: false the same way
    // checkGate already does — see session.ts's confirmRequest.
    policyRules: config.policy.rules,
    // So confirmRequest can bind the ceremony to the right store — see verify.ts's
    // verifyHumanPresence and worker/src/index.ts's /options handler.
    tenant: config.tenant,
  });


  const modal = createModal({
    bus,
    onSend: text => session.sendUserText(text),
    // A click gets you here. Only a server-verified assertion gets you past.
    // The session owns the ceremony — nothing here can hand in a Verification.
    onConfirm: async (requestId, tool, details) => {
      const result = await session.confirmRequest(requestId, tool, details);
      // { method: 'none' } (the demo's ceremony-free path) is not an error either.
      if ('error' in result) return { ok: false as const, reason: result.error };

      // The ceremony RECORDS consent; it does not perform the action. Something still has
      // to call the gated tool to spend it. Observed live: the customer confirmed, the
      // verified entry landed in the transcript, and the store's agent responded by
      // explaining that a confirmation was needed — because "now re-attempt the tool" was
      // left to a model's judgment instead of being written down. Consent that reaches
      // the log and then strands there is the worst possible resting state: the person
      // believes they authorized a refund, and no refund exists.
      //
      // Invoked here, in code, on the one path that knows the ceremony just succeeded.
      // This grants nothing on its own — checkGate re-reads the bus, and the Worker
      // re-validates the single-use token against the tool and eligibility it was minted
      // for. A page patched to call this without a ceremony still gets refused there.
      const gatedTool = tools.find(t => t.name === tool);
      if (!gatedTool) {
        console.warn(`[3way] no gated executor exists for confirmed tool ${tool}`);
        return { ok: false as const, reason: 'action-failed' as const };
      }
      {
        // Never throw across this boundary: this runs from a click handler. But DO read
        // the result. This used to discard it and return { ok: true } unconditionally,
        // which is the same class of bug as the stranded-consent one described above,
        // one step later: gated() correctly returns { ok: false } when the Worker
        // refuses (ineligible claim, unknown order, spent token) and appends nothing to
        // the transcript — and the modal was still told the action succeeded, so the box
        // closed silently and the person was left believing a refund existed that no
        // server record and no transcript line ever recorded. A ceremony that verified
        // and an action that ran are two different facts; only the second one is what
        // the person is being shown here.
        let outcome: unknown;
        try { outcome = await gatedTool.execute({ requestId }, { origin: 'human-direct', cursor: null }); }
        catch (err) {
          console.warn(`[3way] ${tool} failed after a successful confirmation`, err);
          return { ok: false as const, reason: 'action-indeterminate' as const };
        }
        if (outcome && typeof outcome === 'object' && (outcome as { ok?: unknown }).ok === false) {
          console.warn(`[3way] ${tool} was refused after a successful confirmation`, outcome);
          if ((outcome as { outcome?: unknown }).outcome === 'indeterminate') {
            return { ok: false as const, reason: 'action-indeterminate' as const };
          }
          return { ok: false as const, reason: 'action-failed' as const };
        }
        if (!outcome || typeof outcome !== 'object' || (outcome as { ok?: unknown }).ok !== true) {
          console.warn(`[3way] ${tool} returned a malformed result after confirmation`, outcome);
          // Without an explicit outcome stamp we cannot honestly say nothing changed;
          // the action may have completed before the result was corrupted or lost.
          return { ok: false as const, reason: 'action-indeterminate' as const };
        }
        // Let the host page react to a completed consequential action — the shop marks the
        // order returned, the clinic marks the released visits. Fires only here, after the
        // Worker actually completed it; a page with no listener is unaffected.
        try {
          document.dispatchEvent(new CustomEvent('3way:action-completed', {
            detail: {
              tool,
              orderId: details.orderId,
              itemId: details.itemId,
              scope: details.scope ?? null,
              recipient: details.address ?? details.itemId,
            },
          }));
        } catch { /* no DOM, or a listener that threw: not this boundary's concern */ }
        return { ok: true as const, data: outcome as Record<string, unknown> };
      }
    },
    authenticatorAvailable: () => handle.authenticator,
    onMissingAuthenticator: config.policy.rules.onMissingAuthenticator,
    storeAgentLabel: config.storeAgentName,
    composer: config.composer ?? false,
  });
  onConfirmationNeeded = (req, tool) => modal.requestConfirmation(req, tool);
  onActivity = activity => modal.showActivity(activity);
  // Narrated once per request, not once per window: a box appears and the agent goes
  // quiet for up to 25 seconds, and the person should be told the silence is the agent
  // waiting for THEM. A line on every re-arm would be transcript noise, and the box is
  // still there to say what is being waited for.
  let narratedHold: string | null = null;
  onHold = (requestId, tool) => {
    const k = `${requestId}:${tool}`;
    if (narratedHold === k) return;
    narratedHold = k;
    modal.showActivity('is waiting for you to confirm');
  };


  // Learn about missing hardware at mount, not at the moment someone tries to confirm.
  void isAuthenticatorAvailable().then(ok => { handle.authenticator = ok; });

  (config.mountTo ?? document.body).append(modal.el);

  // The store agent's replies come over this session, so a failed token mint takes the
  // whole conversation down.
  // Retry quietly; never show an API error to someone shopping for a lamp.
  let destroyed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  if (config.autoStart !== false) {
    let delay = 1_000;
    const attempt = () => session.start().catch(() => {
      // destroy() may have run while this attempt was in flight — closed DOM, closed
      // session, nothing left to revive. Without this check the timer this schedules
      // outlives destroy() and fires anyway: a new token-mint POST, a fresh peer
      // connection, re-subscribed to a bus nobody reads,
      // with no close() left to run on it. One leaked connection per mount/destroy cycle.
      if (destroyed) return;
      retryTimer = setTimeout(attempt, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    void attempt();
  }

  const handle: WidgetHandle = {
    // Derived from what getModelContext() actually returned — not re-probed — so a shim
    // that exposes `modelContext` without a usable registerTool (and therefore registers
    // zero tools) can never report a surface the widget didn't actually use.
    surface: mc === null
      ? 'none'
      : mc === (document as unknown as { modelContext?: unknown }).modelContext ? 'document' : 'navigator',
    session,
    destroy() {
      destroyed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      unregister(); session.close(); modal.destroy(); tools.destroy();
    },
  };
  return handle;
}

export type { DataSource, Consumer } from './tools';
// An external adopter needs every type required to build a replacement config/ directory.
// Re-exporting the whole module is what makes the "swap config/ and nothing else" claim
// true outside this monorepo.
export * from './types';
export { verifyHumanPresence, isAuthenticatorAvailable } from './verify';

/**
 * One-tag embed. Exported so a page can call it explicitly, and fired here so it does not
 * have to: a script tag carrying data-3way-api mounts itself, and one carrying none is
 * inert, leaving mount() to whoever wants full control.
 *
 * Never throws into the host page. A widget that breaks somebody else's site is worse
 * than a widget that fails to appear.
 */
export { autoMount, readAttributes, fetchConfig } from './autoMount';
// Statically imported, not dynamic: a dynamic import would make the IIFE build emit a
// second chunk, and a drop-in that needs two files is not a drop-in.
// Inert unless the loading script tag carries data-3way-api, so importing this package
// from npm never mounts anything by surprise.
void autoMountOnLoad().catch((err: unknown) => console.error('[3way] auto-mount failed', err));
