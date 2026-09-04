// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { b64url, fromB64url, verifyHumanPresence, deviceId } from '../src/verify';

const OPTS = { apiBase: 'https://api.test', requestId: 'req-1', tool: 'confirm_return', now: () => 42 };

function stubAuthenticator(available: boolean) {
  vi.stubGlobal('PublicKeyCredential', {
    isUserVerifyingPlatformAuthenticatorAvailable: async () => available,
  });
}

function stubCredentials(result: unknown) {
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    credentials: { get: vi.fn(async () => result), create: vi.fn(async () => result) },
  });
}

const FAKE_CRED = {
  id: 'abc', rawId: new Uint8Array([1, 2, 3]).buffer, type: 'public-key',
  response: {
    clientDataJSON: new Uint8Array([4]).buffer,
    authenticatorData: new Uint8Array([5]).buffer,
    signature: new Uint8Array([6]).buffer,
    userHandle: null,
  },
};

beforeEach(() => vi.unstubAllGlobals());

describe('base64url', () => {
  it('round-trips', () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    expect([...(fromB64url(b64url(bytes.buffer)) ?? [])]).toEqual([...bytes]);
  });
  it('is url-safe and unpadded', () => {
    expect(b64url(new Uint8Array([251, 255, 190]).buffer)).toBe('-_--');
  });
  it('handles empty', () => {
    expect(b64url(new ArrayBuffer(0))).toBe('');
    expect([...(fromB64url('') ?? [])]).toEqual([]);
  });
  it('is total: returns null instead of throwing on malformed input', () => {
    expect(fromB64url('not valid base64!!')).toBeNull();
    expect(fromB64url(undefined)).toBeNull();
    expect(fromB64url(null)).toBeNull();
  });
  it('tolerates already-padded input instead of re-padding into garbage', () => {
    expect([...(fromB64url('AQID=') ?? [])]).toEqual([1, 2, 3]);
  });
});

describe('deviceId', () => {
  it('still returns a stable id when crypto.randomUUID is absent (Safari 15.0-15.3, non-secure contexts)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });
    // No randomUUID on this stub — only getRandomValues, the fallback path.
    vi.stubGlobal('crypto', {
      getRandomValues: (arr: Uint8Array) => { for (let i = 0; i < arr.length; i++) arr[i] = i; return arr; },
    });
    const first = deviceId();
    const second = deviceId();
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]+$/);
  });
});

describe('verifyHumanPresence', () => {
  it('reports missing hardware WITHOUT prompting', async () => {
    stubAuthenticator(false);
    const creds = { get: vi.fn(), create: vi.fn() };
    vi.stubGlobal('navigator', { ...globalThis.navigator, credentials: creds });
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'no-authenticator' });
    expect(creds.get).not.toHaveBeenCalled();
  });

  it('reports unsupported when the browser exposes no WebAuthn API at all', async () => {
    // jsdom leaves PublicKeyCredential undefined by default — no stubbing needed.
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'unsupported' });
  });

  it('returns the SERVER-ISSUED token on success — never one it made up', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(
        String(url).endsWith('/options')
          ? { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }
          : { token: 'server-token-xyz' }))));
    expect(await verifyHumanPresence(OPTS)).toEqual({
      method: 'webauthn', token: 'server-token-xyz', at: 42,
    });
  });

  it('fails closed when the SERVER rejects the assertion', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/options')
        ? new Response(JSON.stringify({ mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }))
        : new Response('{"error":"bad signature"}', { status: 400 })));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when a 200 /verify response has no token', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(
        String(url).endsWith('/options')
          ? { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }
          : {}))));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when fetch itself rejects on the options call (offline, CORS, ad blocker)', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when fetch itself rejects on the verify call', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/options')) {
        return new Response(JSON.stringify({ mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }));
      }
      throw new TypeError('Failed to fetch');
    }));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when the /options response is not valid JSON', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json')));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when the /options response parses to null', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null')));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when a 200 /options response is missing publicKey', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'authenticate' }))));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed rather than throwing when allowCredentials is present but not an array', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        mode: 'authenticate',
        publicKey: { challenge: 'AQID', allowCredentials: {} },
      }))));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when the challenge is missing from a 200 response, rather than running against an empty one', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'authenticate', publicKey: { allowCredentials: [] } }))));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('fails closed when the /verify response is not valid JSON', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/options')
        ? new Response(JSON.stringify({ mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }))
        : new Response('not json')));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'rejected' });
  });

  it('reports unsupported (not cancelled) when the ceremony fails for a reason other than the person declining', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      credentials: { get: async () => { throw new DOMException('rp id mismatch', 'SecurityError'); } },
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }))));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'unsupported' });
  });

  it('runs the register ceremony on a first-run device and posts an attestation, not an assertion', async () => {
    stubAuthenticator(true);
    const FAKE_ATTESTATION_CRED = {
      id: 'reg-abc', rawId: new Uint8Array([9, 9, 9]).buffer, type: 'public-key',
      response: {
        clientDataJSON: new Uint8Array([4]).buffer,
        attestationObject: new Uint8Array([7]).buffer,
      },
    };
    const getSpy = vi.fn();
    const createSpy = vi.fn(async (_options?: CredentialCreationOptions) => FAKE_ATTESTATION_CRED);
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      credentials: { get: getSpy, create: createSpy },
    });
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) =>
      new Response(JSON.stringify(
        String(url).endsWith('/options')
          ? {
              mode: 'register',
              publicKey: {
                challenge: 'AQID',
                user: { id: 'AQID', name: 'device', displayName: 'device' },
                excludeCredentials: [{ id: 'AQID', type: 'public-key' }],
              },
            }
          : { token: 'reg-token' })));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyHumanPresence(OPTS);

    expect(getSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
    const passedOptions = createSpy.mock.calls[0]![0] as unknown as { publicKey: Record<string, any> };
    expect(passedOptions.publicKey.challenge).toBeInstanceOf(Uint8Array);
    expect(passedOptions.publicKey.user.id).toBeInstanceOf(Uint8Array);
    expect(passedOptions.publicKey.excludeCredentials[0].id).toBeInstanceOf(Uint8Array);

    const verifyBody = JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body));
    expect(verifyBody.mode).toBe('register');
    expect(verifyBody.credential.response.attestationObject).toBeTypeOf('string');
    expect(verifyBody.credential.response.signature).toBeUndefined();
    expect(result).toEqual({ method: 'webauthn', token: 'reg-token', at: 42 });
  });

  it('reports a cancelled ceremony distinctly from a rejected one', async () => {
    stubAuthenticator(true);
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      credentials: { get: async () => { throw new DOMException('no', 'NotAllowedError'); } },
    });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }))));
    expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'cancelled' });
  });

  it('survives localStorage throwing, rather than stranding the confirm button', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    vi.stubGlobal('localStorage', {
      getItem() { throw new DOMException('denied', 'SecurityError'); },
      setItem() { throw new DOMException('denied', 'SecurityError'); },
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      new Response(JSON.stringify(
        String(url).endsWith('/options')
          ? { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }
          : { token: 't' }))));
    await expect(verifyHumanPresence(OPTS)).resolves.toMatchObject({ method: 'webauthn' });
  });

  it('keys the credential to a stable per-device id, not a caller-supplied name', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    // Two parameters, so the recorded call tuple actually contains the init object the
    // assertions below read. A one-parameter stub type-errors on calls[0][1].
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) =>
      new Response(JSON.stringify(
        String(url).endsWith('/options')
          ? { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }
          : { token: 't' })));
    vi.stubGlobal('fetch', fetchSpy);
    await verifyHumanPresence(OPTS);
    const first = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
    await verifyHumanPresence(OPTS);
    const second = JSON.parse(String(fetchSpy.mock.calls[2]![1]!.body));
    expect(first.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.deviceId).toBe(first.deviceId);   // stable across ceremonies
    expect(first.tool).toBe('confirm_return');      // token will be bound to the action
  });

  describe('layered assurance — onMissingAuthenticator', () => {
    it('refuses (no-authenticator) when the flag is absent — the same default as before this flag existed', async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      expect(await verifyHumanPresence(OPTS)).toEqual({ error: 'no-authenticator' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("refuses (no-authenticator) when the flag is explicitly 'refuse'", async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'refuse' }))
        .toEqual({ error: 'no-authenticator' });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("posts to /api/session then /api/trusted-click, and returns the SERVER-ISSUED token when the authenticator is genuinely absent and the flag permits it", async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) =>
        String(url).endsWith('/api/session')
          ? new Response(JSON.stringify({ ticket: 'tc-ticket-1' }))
          : new Response(JSON.stringify({ token: 'tc-token-1' })));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await verifyHumanPresence({
        ...OPTS, tenant: 'C', onMissingAuthenticator: 'trusted-click',
      });
      expect(result).toEqual({ method: 'trusted-click', token: 'tc-token-1', at: 42 });
      expect(fetchSpy.mock.calls.map(c => String(c[0]))).toEqual([
        'https://api.test/api/session',
        'https://api.test/api/trusted-click',
      ]);
      const sessBody = JSON.parse(String(fetchSpy.mock.calls[0]![1]!.body));
      expect(sessBody).toEqual({ deviceId: expect.any(String), tenant: 'C' });
      // The ticket /api/session issued has to actually reach /api/trusted-click — that's
      // the entire point of the round trip, not an incidental detail.
      const clickBody = JSON.parse(String(fetchSpy.mock.calls[1]![1]!.body));
      expect(clickBody).toMatchObject({
        requestId: 'req-1', tool: 'confirm_return', tenant: 'C', sessionTicket: 'tc-ticket-1',
      });
    });

    // MUTATION GUARD: the one property that must never
    // rot is that an authenticator the browser REPORTS available makes the trusted-click
    // path unreachable, no matter this flag's value. Sets BOTH "authenticator available"
    // and "policy permits the weaker path" and asserts the REAL ceremony ran — never
    // /api/trusted-click. A mutant that checked onMissingAuthenticator before (or
    // instead of) isAuthenticatorAvailable() would call the wrong endpoint here and fail
    // both assertions below.
    it('MUTATION GUARD: never reaches trusted-click when the authenticator is genuinely available, regardless of policy', async () => {
      stubAuthenticator(true);
      stubCredentials(FAKE_CRED);
      const fetchSpy = vi.fn(async (url: string) =>
        new Response(JSON.stringify(
          String(url).endsWith('/options')
            ? { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }
            : { token: 'server-token-xyz' })));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' });
      expect(result).toEqual({ method: 'webauthn', token: 'server-token-xyz', at: 42 });
      expect(fetchSpy.mock.calls.map(c => String(c[0]))).toEqual([
        'https://api.test/api/webauthn/options',
        'https://api.test/api/webauthn/verify',
      ]);
    });

    it('fails closed when fetch itself rejects on the /api/session call', async () => {
      stubAuthenticator(false);
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' }))
        .toEqual({ error: 'rejected' });
    });

    it('fails closed when the Worker refuses /api/session (non-2xx) — /api/trusted-click is never called', async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn(async (_url: string) => new Response('{"error":"forbidden_origin"}', { status: 403 }));
      vi.stubGlobal('fetch', fetchSpy);
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' }))
        .toEqual({ error: 'rejected' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0]![0]).toBe('https://api.test/api/session');
    });

    it('fails closed when a 200 /api/session response has no ticket', async () => {
      stubAuthenticator(false);
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' }))
        .toEqual({ error: 'rejected' });
    });

    it('fails closed when fetch itself rejects on the /api/trusted-click call, after a good /api/session response', async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn(async (url: string) => {
        if (String(url).endsWith('/api/session')) return new Response(JSON.stringify({ ticket: 'tc-ticket' }));
        throw new TypeError('Failed to fetch');
      });
      vi.stubGlobal('fetch', fetchSpy);
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' }))
        .toEqual({ error: 'rejected' });
    });

    it('fails closed when the Worker refuses /api/trusted-click (non-2xx), after a good /api/session response', async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn(async (url: string) =>
        String(url).endsWith('/api/session')
          ? new Response(JSON.stringify({ ticket: 'tc-ticket' }))
          : new Response('{"error":"session_required"}', { status: 403 }));
      vi.stubGlobal('fetch', fetchSpy);
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' }))
        .toEqual({ error: 'rejected' });
    });

    it('fails closed when a 200 /api/trusted-click response has no token, after a good /api/session response', async () => {
      stubAuthenticator(false);
      const fetchSpy = vi.fn(async (url: string) =>
        String(url).endsWith('/api/session') ? new Response(JSON.stringify({ ticket: 'tc-ticket' })) : new Response('{}'));
      vi.stubGlobal('fetch', fetchSpy);
      expect(await verifyHumanPresence({ ...OPTS, onMissingAuthenticator: 'trusted-click' }))
        .toEqual({ error: 'rejected' });
    });
  });

  it('never returns a Verification without a server round trip', async () => {
    stubAuthenticator(true);
    stubCredentials(FAKE_CRED);
    const fetchSpy = vi.fn(async (url: string) =>
      new Response(JSON.stringify(
        String(url).endsWith('/options')
          ? { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }
          : { token: 't' })));
    vi.stubGlobal('fetch', fetchSpy);
    await verifyHumanPresence(OPTS);
    expect(fetchSpy.mock.calls.map(c => String(c[0]))).toEqual([
      'https://api.test/api/webauthn/options',
      'https://api.test/api/webauthn/verify',
    ]);
  });
});
