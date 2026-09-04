import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  toRealtimeTools, logToItems, initialResponseGuardState, createSession,
  guardRequestResponse, guardSendFailed, guardResponseCreated, guardFunctionOutputSent, guardResponseSettled,
} from '../src/session';
import { createBus } from '../src/bus';
import { POLICY_RULES } from '../../../config/policy';
import type { LogEntry, PolicyRules, Tool } from '../src/types';

const tool: Tool = {
  name: 'get_policy', description: 'The policy.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true },
  execute: async () => ({}),
};

const e = (origin: LogEntry['origin'], text: string, i = 1): LogEntry =>
  ({ id: `e${i}`, at: i, origin, text });

describe('toRealtimeTools', () => {
  it('maps to the Realtime function shape', () => {
    expect(toRealtimeTools([tool])).toEqual([{
      type: 'function', name: 'get_policy', description: 'The policy.',
      parameters: { type: 'object', properties: {}, required: [] },
    }]);
  });

  it('drops WebMCP-only fields the Realtime API does not accept', () => {
    const out = toRealtimeTools([tool])[0]! as Record<string, unknown>;
    expect(out.annotations).toBeUndefined();
    expect(out.execute).toBeUndefined();
  });
});

describe('response guard', () => {
  it('a request while active is queued, and only the active response\'s own settle drains it', () => {
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    expect(guardRequestResponse(s)).toBe(false);   // A is active — queued instead of firing
    expect(s.responseQueued).toBe(true);
    // A settle for some OTHER id must not drain the queue — an id-blind guard would.
    expect(guardResponseSettled(s, 'not-A')).toBe(false);
    expect(s.responseQueued).toBe(true);
    expect(s.responseActive).toBe(true);
    // Only A's own settle drains it.
    expect(guardResponseSettled(s, 'A')).toBe(true);
    expect(s.responseQueued).toBe(false);
    expect(s.responseActive).toBe(true);
  });

  it('a tool call whose turn settles before its output is sent fires exactly one continuation', () => {
    // The bug: response.function_call_arguments.done and response.done both belong to
    // turn A. The broken version cleared responseActive on the function-call event and
    // re-requested immediately, so A's own response.done — arriving right after — cleared
    // state out from under the response that request had just started (B).
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    expect(s.responseActive).toBe(true);

    // Tool executes and its output is sent while A is still generating.
    expect(guardFunctionOutputSent(s)).toBe(false);   // not sent yet — A hasn't settled
    expect(s.needsContinuation).toBe(true);

    // A's own response.done arrives. Exactly one continuation fires here, and it leaves
    // the guard in the "a response is active" state on B's behalf, before B's
    // response.created has even arrived.
    expect(guardResponseSettled(s, 'A')).toBe(true);
    expect(s.responseActive).toBe(true);
    expect(s.activeResponseId).toBe(null);
    expect(s.needsContinuation).toBe(false);

    // A stale or duplicate settle for A must not touch B's state.
    expect(guardResponseSettled(s, 'A')).toBe(false);
    expect(s.responseActive).toBe(true);

    // B's turn proceeds normally and clears on its own settle.
    guardResponseCreated(s, 'B');
    expect(guardResponseSettled(s, 'B')).toBe(false);
    expect(s.responseActive).toBe(false);
    expect(s.activeResponseId).toBe(null);
  });

  it('fires the continuation immediately when the output is sent after the turn already settled, without being confused by a different response now active', () => {
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    // A settles before the tool call that triggered it resolves.
    expect(guardResponseSettled(s, 'A')).toBe(false);
    expect(s.responseActive).toBe(false);

    // An unrelated response B starts before A's late tool output lands. An id-blind guard
    // (or one that only checked responseActive without ever having tracked A's real id)
    // could mistake "something is active" for "A already settled" either way here — the
    // correct read is that B, not A, is what's active, so the output must queue behind it
    // rather than firing a same-turn response.create into B.
    guardResponseCreated(s, 'B');
    expect(guardFunctionOutputSent(s)).toBe(false);
    expect(s.needsContinuation).toBe(true);
    // B's own settle — not any stray event — is what releases A's queued continuation.
    expect(guardResponseSettled(s, 'B')).toBe(true);
  });

  it('settling drains a pending continuation ahead of a merely queued response, and leaves the queue for the continuation to clear', () => {
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    expect(guardFunctionOutputSent(s)).toBe(false);   // needsContinuation set
    expect(guardRequestResponse(s)).toBe(false);      // also queued, e.g. a user message arrived too
    expect(s.needsContinuation).toBe(true);
    expect(s.responseQueued).toBe(true);

    // A settles: the continuation fires (not the queued request) and the guard is left
    // active on the continuation's behalf, with the queue still pending behind it.
    expect(guardResponseSettled(s, 'A')).toBe(true);
    expect(s.responseActive).toBe(true);
    expect(s.needsContinuation).toBe(false);
    expect(s.responseQueued).toBe(true);
  });

  it('several function calls in one turn still fire only one continuation', () => {
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    expect(guardFunctionOutputSent(s)).toBe(false);
    expect(guardFunctionOutputSent(s)).toBe(false);   // second call, same turn — no double state
    expect(guardResponseSettled(s, 'A')).toBe(true);  // exactly one continuation fires
    expect(s.responseActive).toBe(true);
  });

  it('a settle for an id that never matches the active response is ignored, not a hang risk', () => {
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    expect(guardResponseSettled(s, 'stale')).toBe(false);
    expect(s.responseActive).toBe(true);
    expect(s.activeResponseId).toBe('A');
  });

  it('error clears unconditionally regardless of which response was active', () => {
    const s = initialResponseGuardState();
    guardResponseCreated(s, 'A');
    expect(guardResponseSettled(s, null)).toBe(false);   // null = error, no id to check
    expect(s.responseActive).toBe(false);
    expect(s.activeResponseId).toBe(null);
  });

  it('a response.created with no id is still matched by the very next settle, not treated as stale', () => {
    // The regression: created(no id) stored activeResponseId: null while responseActive
    // stayed true, so every later done carrying a real id was rejected as a mismatch —
    // the guard never cleared again short of an error or a reconnect.
    const s = initialResponseGuardState();
    guardResponseCreated(s, null);
    expect(s.responseActive).toBe(true);
    expect(s.activeResponseId).not.toBe(null);   // the unknown-sentinel, not "nothing active"
    expect(guardResponseSettled(s, 'A')).toBe(false);   // A is trusted to be this response
    expect(s.responseActive).toBe(false);
    expect(s.activeResponseId).toBe(null);
  });

  it('a settle while nothing is tracked is rejected, proving null is not read as a wildcard match', () => {
    const s = initialResponseGuardState();
    // Simulates a settle arriving for a response this guard never created — a real risk
    // only if an implementation treated "activeResponseId === null" as "match anything".
    // Force a queued flag into this otherwise-idle state so a wrongly-permissive settle
    // would be observable: it would drain the queue and report a fire.
    s.responseQueued = true;
    expect(guardResponseSettled(s, 'A')).toBe(false);
    expect(s.responseQueued).toBe(true);
    expect(s.responseActive).toBe(false);
  });
});

describe('guardSendFailed', () => {
  it('reverts an assumed-active guard to queued instead of stranding it with nothing sent', () => {
    const s = initialResponseGuardState();
    expect(guardRequestResponse(s)).toBe(true);   // caller is told to send now
    // ...the actual write failed, e.g. the data channel was not open yet mid-handshake.
    guardSendFailed(s);
    expect(s.responseActive).toBe(false);
    expect(s.responseQueued).toBe(true);
    // A later, successful request now goes through instead of queuing behind a response
    // that was never really active.
    expect(guardRequestResponse(s)).toBe(true);
  });
});

describe('logToItems', () => {
  it('replays the log in order with roles and prefixes intact', () => {
    const items = logToItems([
      e('human-direct', 'hi', 1),
      e('site-agent', 'hello', 2),
      e('agent-relay', 'she wants a refund', 3),
    ]);
    expect(items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[customer] hi' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: "[customer's agent, relaying] she wants a refund" }] },
    ]);
  });

  it('produces an empty list for an empty log', () => {
    expect(logToItems([])).toEqual([]);
  });
});

describe('a connect() abandoned mid-flight by close()', () => {
  /** Resolves on demand instead of immediately, so a test can park an await exactly
   *  where it wants and control when it resumes. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
  }

  class FakeDataChannel {
    readyState = 'connecting';
    send = vi.fn();
    close = vi.fn(() => { this.readyState = 'closed'; });
    addEventListener() {}
  }

  class FakePeerConnection {
    static instances: FakePeerConnection[] = [];
    connectionState = 'new';
    ontrack: unknown;
    onconnectionstatechange: (() => void) | null = null;
    close = vi.fn(() => { this.connectionState = 'closed'; });
    constructor() { FakePeerConnection.instances.push(this); }
    addTransceiver() { return { sender: { replaceTrack: async () => {} } } as unknown; }
    createDataChannel() { return new FakeDataChannel() as unknown as RTCDataChannel; }
    createOffer() { return Promise.resolve({ sdp: 'offer', type: 'offer' } as unknown); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
  }

  it('parked mid-token-fetch when close() runs: no connection is left open, and start() ' +
    'never registers a bus subscriber', async () => {
    FakePeerConnection.instances.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection as unknown as typeof RTCPeerConnection);
    vi.stubGlobal('Audio', class { autoplay = false; srcObject: unknown; } as unknown as typeof Audio);

    // close() runs while connect() is still parked here — the exact reproduction of the
    // bug: close() finds no pc/dc yet (nothing built), then the fetch resolves and, without
    // the closed-check this test protects, connect() would carry on and build a live one.
    const tokenGate = deferred<Response>();
    const fetchMock = vi.fn((url: string) =>
      String(url) === 'https://api.test/token' ? tokenGate.promise : Promise.resolve(new Response('{}')));
    vi.stubGlobal('fetch', fetchMock);

    const bus = createBus({ now: () => Date.now(), id: () => 'e1' });
    const subscribeSpy = vi.spyOn(bus, 'subscribe');
    const session = createSession({
      apiBase: 'https://api.test', now: () => Date.now(), tokenUrl: 'https://api.test/token',
      tools: [], systemPrompt: '', bus, policyRules: POLICY_RULES,
    });

    const startPromise = session.start();
    await Promise.resolve();   // let connect() reach the parked fetch
    session.close();           // nothing to close yet — proven by instances staying empty below
    tokenGate.resolve(new Response(JSON.stringify({ client_secret: { value: 'x' }, model: 'gpt-x' })));
    await startPromise;

    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(subscribeSpy).not.toHaveBeenCalled();
  });
});

describe('confirmRequest and the requireHardwareConfirmation demo toggle', () => {
  const details = { orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' as const };

  function session(bus: ReturnType<typeof createBus>, rules: PolicyRules) {
    return createSession({
      apiBase: 'https://api.test', now: () => 1000, tokenUrl: 'https://api.test/token',
      tools: [], systemPrompt: '', bus, policyRules: rules,
    });
  }

  it('flag OFF: skips the ceremony entirely — a bare click authorises, with no ' +
    'verification on the entry', async () => {
    const bus = createBus({ now: () => 1000, id: () => 'e1' });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // jsdom exposes no PublicKeyCredential either, so if the ceremony ran at all it
    // would fail closed with 'unsupported' — this test needs it to never run in the
    // first place, not merely to fail gracefully.
    const s = session(bus, { ...POLICY_RULES, requireHardwareConfirmation: false });

    const result = await s.confirmRequest('req-1', 'confirm_return', details);

    expect(fetchSpy).not.toHaveBeenCalled();
    // An explicit, distinct result — never undefined, which would make "no value
    // returned" mean "the human confirmed" and let a future accidental early return
    // silently grant authorization.
    expect(result).toEqual({ method: 'none', at: 1000 });
    const entry = bus.all().at(-1)!;
    expect(entry).toMatchObject({ origin: 'human-direct', confirms: 'req-1', confirmsTool: 'confirm_return' });
    expect(entry.verification).toBeUndefined();
    // Exactly what checkGate's weak branch accepts, and exactly what it must NOT satisfy.
    expect(bus.hasHumanConfirmation('req-1')).toBe(true);
    expect(bus.hasVerifiedConfirmation('req-1', 'confirm_return')).toBe(false);
  });

  it('flag ON: runs the real ceremony, and a failure appends nothing to the bus', async () => {
    const bus = createBus({ now: () => 1000, id: () => 'e1' });
    const s = session(bus, { ...POLICY_RULES, requireHardwareConfirmation: true });

    // No PublicKeyCredential in jsdom by default — the ceremony fails closed with
    // 'unsupported' before ever reaching fetch.
    const result = await s.confirmRequest('req-1', 'confirm_return', details);

    expect(result).toEqual({ error: 'unsupported' });
    expect(bus.all()).toHaveLength(0);
  });

  it('flag ABSENT from rules: still fails closed and runs the real ceremony — the same ' +
    'rule checkGate already applies to this flag, never "missing means weak"', async () => {
    const bus = createBus({ now: () => 1000, id: () => 'e1' });
    const { requireHardwareConfirmation, ...withoutFlag } = POLICY_RULES;
    void requireHardwareConfirmation;
    const s = session(bus, withoutFlag as unknown as PolicyRules);

    const result = await s.confirmRequest('req-1', 'confirm_return', details);

    expect(result).toEqual({ error: 'unsupported' });
    expect(bus.all()).toHaveLength(0);
  });
});

describe('confirmRequest and PolicyRules.onMissingAuthenticator (layered assurance)', () => {
  const details = { orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' as const };

  function session(bus: ReturnType<typeof createBus>, rules: PolicyRules) {
    return createSession({
      apiBase: 'https://api.test', now: () => 1000, tokenUrl: 'https://api.test/token',
      tools: [], systemPrompt: '', bus, policyRules: rules,
    });
  }

  // Scoped to this describe block only — nothing else in this file stubs
  // PublicKeyCredential, and other tests here rely on it staying genuinely undefined
  // (see the "flag ON" test above), so a leaked stub here must never survive past a test.
  afterEach(() => vi.unstubAllGlobals());

  it("threads onMissingAuthenticator: 'trusted-click' through to a real /api/trusted-click round trip, and stamps the bus entry with a trusted-click proof", async () => {
    const bus = createBus({ now: () => 1000, id: () => 'e1' });
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    });
    const fetchSpy = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/session')) return new Response(JSON.stringify({ ticket: 'tc-ticket' }));
      if (String(url).endsWith('/api/trusted-click')) return new Response(JSON.stringify({ token: 'tc-tok' }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const s = session(bus, { ...POLICY_RULES, onMissingAuthenticator: 'trusted-click' });

    const result = await s.confirmRequest('req-1', 'confirm_return', details);

    expect(result).toEqual({ method: 'trusted-click', token: 'tc-tok', at: 1000 });
    const entry = bus.all().at(-1)!;
    expect(entry).toMatchObject({ origin: 'human-direct', confirms: 'req-1', confirmsTool: 'confirm_return' });
    expect(entry.verification).toEqual({ method: 'trusted-click', token: 'tc-tok', at: 1000 });
    // The layered gate: recognized (hasAssuredConfirmation), but never mistaken for the
    // cryptographic level (hasVerifiedConfirmation stays strict).
    expect(bus.hasAssuredConfirmation('req-1', 'confirm_return')).toBe(true);
    expect(bus.hasVerifiedConfirmation('req-1', 'confirm_return')).toBe(false);
  });

  it("does NOT fall back to trusted-click when the flag is 'refuse' (the default) — fails closed with no-authenticator, no network call", async () => {
    const bus = createBus({ now: () => 1000, id: () => 'e1' });
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const s = session(bus, { ...POLICY_RULES, onMissingAuthenticator: 'refuse' });

    const result = await s.confirmRequest('req-1', 'confirm_return', details);

    expect(result).toEqual({ error: 'no-authenticator' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bus.all()).toHaveLength(0);
  });

  // MUTATION GUARD, exercised again at this layer (verify.test.ts pins the same property
  // directly on verifyHumanPresence): a device the browser reports HAS an authenticator
  // must run the real WebAuthn ceremony even when policy permits the weaker path —
  // trusted-click must be unreachable there, not merely "usually not reached."
  it('MUTATION GUARD: a genuinely present authenticator still runs the real ceremony, never trusted-click, no matter the policy', async () => {
    const bus = createBus({ now: () => 1000, id: () => 'e1' });
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    });
    vi.stubGlobal('navigator', {
      credentials: { get: async () => { throw new DOMException('no', 'NotAllowedError'); } },
    });
    const fetchSpy = vi.fn(async (url: string) =>
      String(url).endsWith('/options')
        ? new Response(JSON.stringify({ mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }))
        : new Response('{"token":"should-not-be-reached"}'));
    vi.stubGlobal('fetch', fetchSpy);
    const s = session(bus, { ...POLICY_RULES, onMissingAuthenticator: 'trusted-click' });

    const result = await s.confirmRequest('req-1', 'confirm_return', details);

    // The person declined the (real) OS prompt — 'cancelled', not a trusted-click grant.
    expect(result).toEqual({ error: 'cancelled' });
    expect(bus.all()).toHaveLength(0);
    expect(fetchSpy.mock.calls.map(c => String(c[0]))).toEqual(['https://api.test/api/webauthn/options']);
  });
});
