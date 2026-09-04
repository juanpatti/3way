import type { ConfirmationProof, ReturnReason, TrustedClickRecord, Verification } from './types';

/**
 * The action-* members are the only ones that describe something after the ceremony
 * succeeded. `action-failed` is a definitive refusal; `action-indeterminate` means the
 * request was sent but its response was lost, so completion is unknown and retrying could
 * repeat the same action. They exist because the confirm
 * box used to be told `{ ok: true }` unconditionally once the signature checked out —
 * so a server refusal left the person believing they had authorized a refund that no
 * transcript line and no server record ever recorded. Consent that reaches the log and
 * then strands there is the worst resting state this UI can produce; this reason is how
 * the box says so instead.
 */
export type VerifyFailure =
  'no-authenticator' | 'unsupported' | 'cancelled' | 'rejected' |
  'action-failed' | 'action-indeterminate';
/**
 * Four named outcomes, not three named ones and a hole: a real Verification, a
 * TrustedClickRecord (the layered-assurance path, ConfirmationProof's other member), the
 * demo's deliberately weak `{ method: 'none' }` (confirmRequest's
 * requireHardwareConfirmation: false path — no ceremony ran, nothing to verify at any
 * level), or a failure. `{ method: 'none' }` is NOT a ConfirmationProof — it has no token
 * and satisfies none of the predicates that read one (hasVerifiedConfirmation,
 * hasAssuredConfirmation, confirmationToken, the Worker's own check) — so it is typed as
 * a distinct member of this union rather than folded into ConfirmationProof or
 * represented by `undefined`. `undefined` was tried and rejected: it would make "no
 * value returned" mean "the human confirmed," so a future early return with no value, or
 * a fall-through branch, would silently read as authorization instead of failing the
 * typecheck.
 */
export type VerifyResult = ConfirmationProof | { method: 'none'; at: number } | { error: VerifyFailure };

export function b64url(buf: ArrayBuffer): string {
  let bin = '';
  for (const byte of new Uint8Array(buf)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Total: never throws. Returns null for anything that is not a well-formed base64url
 * string — including a missing/undefined value — so a malformed or absent field (like a
 * challenge the Worker forgot to send) fails the ceremony instead of silently decoding to
 * a zero-length buffer. An empty string is still a legitimate zero-length buffer, distinct
 * from "the field wasn't there at all".
 */
export function fromB64url(str: unknown): Uint8Array | null {
  if (typeof str !== 'string') return null;
  if (str === '') return new Uint8Array(0);
  // Strip any pre-existing padding before recomputing it, so an already-padded input
  // (e.g. "AQID=") doesn't get re-padded into something atob rejects.
  const cleaned = str.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const b64 = cleaned.padEnd(cleaned.length + ((4 - (cleaned.length % 4)) % 4), '=');
  try {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function isAuthenticatorAvailable(): Promise<boolean> {
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/**
 * Runs the ceremony and returns the token THE SERVER ISSUED. The browser never mints a
 * Verification: every field here originates server-side, so patching this file gains an
 * attacker nothing it could not already do by patching everything else in the page.
 *
 * The Worker decides register-vs-authenticate, so there is no client-side registration
 * state to desynchronise across tenants.
 */
const DEVICE_KEY = '3way:device';

/**
 * A per-device anonymous id. Credentials are keyed on this, never on a client-supplied
 * user name — otherwise the first person ever to register owns the only credential and
 * every later visitor (a judge opening the live URL) is asked to satisfy an authenticator
 * enrolled on someone else's hardware.
 */
let memoryDeviceId: string | null = null;

/**
 * crypto.randomUUID is absent on Safari 15.0–15.3 and in any non-secure context — and
 * those Safari versions still expose PublicKeyCredential, so the earlier `typeof
 * PublicKeyCredential` guard does not catch them. This is a lookup key, not a secret, so
 * getRandomValues (or, failing that, Math.random) is an acceptable fallback — it must
 * never throw, unlike randomUUID's ReferenceError when the method doesn't exist.
 *
 * Exported: index.ts's mount() reuses this to suffix the requestIds it mints, so two
 * concurrent visitors on the same live URL — both starting a fresh per-mount counter at
 * 1 — cannot mint the SAME requestId and collide in the Worker's (global, not per-visitor)
 * challenge/token KV keyspace. See mount()'s newRequestId for the collision this closes.
 */
export function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function deviceId(): string {
  // localStorage throws outright in privacy-restricted, partitioned and kiosk contexts.
  // Judges open the live URL in browsers we do not control, so falling back to a
  // session-only id is required — an unhandled throw here leaves the confirm button
  // stuck on "Verifying…" forever with nothing downstream to catch it.
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = randomId(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch {
    return (memoryDeviceId ??= randomId());
  }
}

/** Total: a non-JSON body must not throw past this point either. */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/**
 * The weaker layer. Called ONLY from inside verifyHumanPresence's
 * `!isAuthenticatorAvailable()` branch — there is no other caller, and no path into this
 * function with a real authenticator present. No WebAuthn ceremony runs: there is
 * nothing to sign, so there is nothing for the Worker to cryptographically verify. The
 * Worker mints a token anyway, on the client's word that isAuthenticatorAvailable()
 * genuinely came back false — an AUDITABLE RECORD, not a VERIFIED FACT (worker/src/
 * index.ts's /api/trusted-click enforces the one independent check it actually can:
 * refusing this device if it has already registered a real credential here, which would
 * directly contradict the claim this call is making).
 *
 * Two POSTs, not one: first /api/session for a short-lived ticket (Origin-checked —
 * worker/src/index.ts's comment on that endpoint says exactly what it narrows and does
 * not close), then /api/trusted-click itself with that ticket attached. Neither call
 * authenticates this device; the ticket only proves whoever holds it recently reached
 * this same Worker over a real, Origin-checked fetch.
 */
async function recordTrustedClick(opts: {
  apiBase: string;
  requestId: string;
  tool: string;
  now: () => number;
  tenant?: string;
  orderId?: string;
  itemId?: string;
  reason?: ReturnReason;
  scope?: string;
  address?: string;
}): Promise<TrustedClickRecord | { error: VerifyFailure }> {
  // Hoisted so the ticket request and the mint request agree on one value — two calls to
  // deviceId() could in principle observe different ids (a concurrent write to the same
  // localStorage key from another tab), and a ticket minted for one device is refused by
  // /api/trusted-click when presented alongside a different one.
  const device = deviceId();

  let sessRes: Response | null;
  try {
    sessRes = await fetch(`${opts.apiBase}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // Tenant must be bound into the ticket: otherwise a ticket minted under the shop's
      // trusted-click policy can be presented for clinic records after the clinic has
      // failed closed to refuse that weaker assurance.
      body: JSON.stringify({ deviceId: device, tenant: opts.tenant }),
    });
  } catch {
    return { error: 'rejected' };
  }
  if (!sessRes.ok) return { error: 'rejected' };
  const sessBody = await safeJson(sessRes);
  const ticket = (sessBody as { ticket?: unknown } | null)?.ticket;
  // Same discipline as the token check below: a cast here would be a lie. Fail closed
  // rather than carry a non-string, empty, or missing ticket into the next call.
  if (typeof ticket !== 'string' || !ticket) return { error: 'rejected' };

  let res: Response | null;
  try {
    res = await fetch(`${opts.apiBase}/api/trusted-click`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: opts.requestId, tool: opts.tool, deviceId: device, sessionTicket: ticket,
        tenant: opts.tenant, orderId: opts.orderId, itemId: opts.itemId, reason: opts.reason,
        scope: opts.scope, address: opts.address,
      }),
    });
  } catch {
    return { error: 'rejected' };
  }
  if (!res.ok) return { error: 'rejected' };
  const body = await safeJson(res);
  const token = (body as { token?: unknown } | null)?.token;
  // Same discipline as the webauthn path below: a cast here would be a lie. Fail closed
  // rather than mint a record whose token came from nowhere.
  if (typeof token !== 'string' || !token) return { error: 'rejected' };
  return { method: 'trusted-click', token, at: opts.now() };
}

export async function verifyHumanPresence(opts: {
  apiBase: string;
  requestId: string;
  /** The gated action being confirmed. The token is bound to it. */
  tool: string;
  now: () => number;
  /**
   * Which domain this ceremony's action belongs to (WidgetConfig's `tenant`, threaded
   * through unchanged) — bound into the Worker's ChallengeRecord at /options time so
   * domain policy is re-checked when the token is spent. Omitted for the flagship.
   */
  tenant?: string;
  /**
   * The eligibility triple this ceremony is being asked to authorize. The Worker requires
   * these when tool === 'confirm_return' — omitted, it refuses the ceremony outright
   * (400 missing_eligibility_fields) rather than let a page bind the ceremony now and
   * substitute the claim later (worker/src/index.ts's /options handler). Ignored by the
   * Worker for every other gated tool.
   */
  orderId?: string;
  itemId?: string;
  reason?: ReturnReason;
  /** Bound into the ceremony alongside the subject — see PendingRequest.scope. */
  scope?: string;
  /**
   * The new delivery address, bound for change_address exactly as the eligibility triple
   * is bound for confirm_return. Without it the Worker completes an address change it
   * cannot name, and the receipt records a redirect to nowhere — the page could show one
   * address in the confirm box and spend the token on another.
   */
  address?: string;
  /**
   * PolicyRules.onMissingAuthenticator, threaded straight through — see its own doc
   * comment in types.ts. Consulted ONLY inside the branch below where
   * isAuthenticatorAvailable() has already returned false; whenever it returns true the
   * full WebAuthn ceremony runs unconditionally, never even reading this value. That
   * ordering — not a value check — is what makes the weaker path unreachable whenever
   * the browser REPORTS an authenticator available, regardless of what this is set to.
   * Precise on purpose: isAuthenticatorAvailable() swallows a thrown error and returns
   * false (below), so a device that genuinely has hardware but whose browser fails that
   * one call selects the weaker path the same as genuine absence would — "the browser
   * reports available," not "hardware physically exists," is the actual boundary.
   */
  onMissingAuthenticator?: 'refuse' | 'trusted-click';
}): Promise<ConfirmationProof | { error: VerifyFailure }> {
  // Narrower than the exported VerifyResult on purpose: this function runs the real
  // ceremony (or, on the layered path below, the real trusted-click record) and only
  // ever produces a genuine ConfirmationProof or a failure — never the `{ method: 'none'
  // }` shape confirmRequest returns for its separate, ceremony-free demo path. That's
  // the property that makes widening VerifyResult safe: the compiler still catches an
  // attempt to write this function's result straight into a bus entry's `verification`
  // field, exactly as it did when this file first widened the type (see session.ts's
  // confirmRequest).
  if (typeof PublicKeyCredential === 'undefined') return { error: 'unsupported' };
  if (!(await isAuthenticatorAvailable())) {
    // Only an explicit 'trusted-click' selects the weaker path — same fail-closed rule
    // every other flag in this codebase follows. This branch is reached ONLY because
    // the authenticator check above already came back false; there is no route into
    // recordTrustedClick with one present, no matter this value.
    if (opts.onMissingAuthenticator !== 'trusted-click') return { error: 'no-authenticator' };
    return recordTrustedClick(opts);
  }

  // A rejected fetch (offline, a missing CORS preflight, an ad blocker) must not
  // propagate: this is the button a judge is staring at, in a browser we do not control.
  const post = async (path: string, body: unknown): Promise<Response | null> => {
    try {
      return await fetch(`${opts.apiBase}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  };

  const device = deviceId();
  // The eligibility triple is bound to the ceremony HERE, before the person authenticates
  // — never re-supplied at /api/act, which no longer even accepts it. JSON.stringify drops
  // undefined-valued keys, so this is a no-op for
  // gated tools other than confirm_return.
  const optionsRes = await post('/api/webauthn/options', {
    requestId: opts.requestId, tool: opts.tool, deviceId: device, tenant: opts.tenant,
    orderId: opts.orderId, itemId: opts.itemId, reason: opts.reason, scope: opts.scope,
    address: opts.address,
  });
  if (!optionsRes || !optionsRes.ok) return { error: 'rejected' };

  const optionsBody = await safeJson(optionsRes);
  if (typeof optionsBody !== 'object' || optionsBody === null) return { error: 'rejected' };
  const { mode, publicKey } = optionsBody as { mode?: unknown; publicKey?: unknown };
  if (mode !== 'register' && mode !== 'authenticate') return { error: 'rejected' };
  if (typeof publicKey !== 'object' || publicKey === null) return { error: 'rejected' };
  const pk = publicKey as Record<string, any>;

  // The challenge is what makes the assertion unreplayable. Missing or malformed is a
  // hard failure, never a silent zero-length buffer.
  const challenge = fromB64url(pk.challenge);
  if (!challenge) return { error: 'rejected' };
  pk.challenge = challenge;

  if (pk.user?.id !== undefined) {
    const userId = fromB64url(pk.user.id);
    if (!userId) return { error: 'rejected' };
    pk.user.id = userId;
  }
  for (const list of [pk.allowCredentials, pk.excludeCredentials]) {
    // `?? []` only guards null/undefined. A non-nullish, non-array value ({}, a number, a
    // string) is still iterable-looking enough to reach for...of, which throws
    // synchronously outside every try/catch above — fail closed instead.
    if (list != null && !Array.isArray(list)) return { error: 'rejected' };
    for (const c of list ?? []) {
      const id = fromB64url(c?.id);
      if (!id) return { error: 'rejected' };
      c.id = id;
    }
  }

  let credential: PublicKeyCredential | null;
  try {
    // publicKey arrives as JSON and is patched in place above (challenge and any
    // credential ids decoded from base64url), so it cannot be statically typed as the
    // DOM option shape. Cast at the call site rather than lying about the wire format.
    credential = (mode === 'register'
      ? await navigator.credentials.create({
          publicKey: pk as unknown as PublicKeyCredentialCreationOptions })
      : await navigator.credentials.get({
          publicKey: pk as unknown as PublicKeyCredentialRequestOptions })
      ) as PublicKeyCredential | null;
  } catch (err) {
    // NotAllowedError is the person dismissing the prompt or timing out — invite a retry.
    // Anything else (SecurityError from an RP ID/origin mismatch, NotSupportedError,
    // InvalidStateError, ...) is a configuration problem, not a "no": don't tell someone
    // they cancelled when a misconfigured RP ID is what actually happened.
    return { error: err instanceof DOMException && err.name === 'NotAllowedError' ? 'cancelled' : 'unsupported' };
  }
  if (!credential) return { error: 'cancelled' };

  const r = credential.response as AuthenticatorAssertionResponse & AuthenticatorAttestationResponse;
  const verifyRes = await post('/api/webauthn/verify', {
    requestId: opts.requestId,
    deviceId: device,
    mode,
    credential: {
      id: credential.id,
      rawId: b64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: b64url(r.clientDataJSON),
        ...(r.attestationObject ? { attestationObject: b64url(r.attestationObject) } : {}),
        ...(r.authenticatorData ? { authenticatorData: b64url(r.authenticatorData) } : {}),
        ...(r.signature ? { signature: b64url(r.signature) } : {}),
        ...(r.userHandle ? { userHandle: b64url(r.userHandle) } : {}),
      },
    },
  });
  if (!verifyRes || !verifyRes.ok) return { error: 'rejected' };

  const verifyBody = await safeJson(verifyRes);
  const token = (verifyBody as { token?: unknown } | null)?.token;
  // A cast here would be a lie: strict mode does not protect against a 200 with no token.
  // Fail closed rather than mint a Verification whose token came from nowhere.
  if (typeof token !== 'string' || !token) return { error: 'rejected' };
  return { method: 'webauthn', token, at: opts.now() };
}
