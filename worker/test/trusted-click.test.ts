import { describe, it, expect, afterEach } from 'vitest';
import worker from '../src/index';
import { POLICY_RULES } from '../../config/policy';
import { CLINIC_POLICY_RULES } from '../../config/clinic';

/**
 * Regression coverage for /api/session and /api/trusted-click — the layered assurance
 * model's weaker layer (see README.md's "Layered assurance" section and
 * packages/widget/src/types.ts's TrustedClickRecord). No miniflare, no wrangler: this
 * calls the exported `fetch` handler directly against a mock KVNamespace, same technique
 * as worker/test/act.test.ts.
 *
 * POLICY_RULES.onMissingAuthenticator has no test-time override seam in this Worker —
 * same pre-existing gap noted in act.test.ts for requireHardwareConfirmation — so this
 * file mutates the imported constant directly for the duration of each test that needs a
 * specific setting, and restores it in afterEach so no other test file (running in the
 * same worker process) ever observes the flag flipped. ORIGINAL_ON_MISSING captures
 * whatever config/policy.ts actually ships — as of this deployment's opt-in for
 * ChatGPT's in-app browser (see that file's comment), that's 'trusted-click', not
 * 'refuse'; see the first describe block below for the assertion that pins it.
 */
const ORIGINAL_ON_MISSING = POLICY_RULES.onMissingAuthenticator;
const ORIGINAL_CLINIC_ON_MISSING = CLINIC_POLICY_RULES.onMissingAuthenticator;
afterEach(() => {
  POLICY_RULES.onMissingAuthenticator = ORIGINAL_ON_MISSING;
  CLINIC_POLICY_RULES.onMissingAuthenticator = ORIGINAL_CLINIC_ON_MISSING;
});

class MockKV {
  store = new Map<string, string>();
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> { this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
}

const NOW = 1_700_000_000_000;
const EXPECTED_ORIGIN = 'http://localhost:3000';

function env(kv: MockKV) {
  return {
    OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
    RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN,
    KV: kv, NOW,
  };
}

// `origin: null` omits the header entirely, for the "no Origin at all" case — distinct
// from passing the wrong value, which the file's own test covers separately.
async function apiSession(kv: MockKV, body: unknown, origin: string | null = EXPECTED_ORIGIN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers.origin = origin;
  const req = new Request('http://localhost/api/session', { method: 'POST', headers, body: JSON.stringify(body) });
  const res = await worker.fetch(req, env(kv) as any);
  return { status: res.status, body: await res.json() as any };
}

/**
 * Mints a real ticket through /api/session — the same round trip the widget makes —
 * rather than writing the KV key directly, so tests that need a genuinely valid ticket
 * also exercise the endpoint that issues one. Throws on setup failure so a broken
 * /api/session doesn't silently turn into a confusing failure in whatever test called
 * this to set up its fixture.
 */
async function mintTicket(kv: MockKV, deviceId: string, tenant?: string): Promise<string> {
  const { status, body } = await apiSession(kv, { deviceId, ...(tenant ? { tenant } : {}) });
  if (status !== 200) throw new Error(`mintTicket setup failed: ${status} ${JSON.stringify(body)}`);
  return body.ticket;
}

async function trustedClick(kv: MockKV, body: unknown) {
  const req = new Request('http://localhost/api/trusted-click', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env(kv) as any);
  return { status: res.status, body: await res.json() as any };
}

async function act(kv: MockKV, body: unknown) {
  const req = new Request('http://localhost/api/act', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env(kv) as any);
  return { status: res.status, body: await res.json() as any };
}

describe('the value this file captured at import time', () => {
  it("is 'trusted-click' — this deployment opts in so the experience can complete in ChatGPT's " +
    "in-app browser (config/policy.ts's comment explains why); 'refuse' remains the only " +
    "setting this project ships safe for anything real, which is why every test below " +
    "sets the flag explicitly rather than relying on this captured value", () => {
    expect(ORIGINAL_ON_MISSING).toBe('trusted-click');
  });
});

describe('/api/session — refused unless policy explicitly permits it, and Origin-checked', () => {
  it("403s with trusted_click_not_permitted when onMissingAuthenticator is 'refuse' — no " +
    'reason to hand out a ticket for a path that is closed', async () => {
    POLICY_RULES.onMissingAuthenticator = 'refuse';
    const kv = new MockKV();
    const { status, body } = await apiSession(kv, { deviceId: 'dev-sess-1' });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'trusted_click_not_permitted' });
    expect(kv.store.size).toBe(0);
  });

  it('403s forbidden_origin with no Origin header at all', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await apiSession(kv, { deviceId: 'dev-sess-2' }, null);
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'forbidden_origin' });
    expect(kv.store.size).toBe(0);
  });

  it("403s forbidden_origin when the Origin header doesn't match EXPECTED_ORIGIN — the " +
    'one check in this whole flow a non-browser caller cannot pass without forging it', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await apiSession(kv, { deviceId: 'dev-sess-3' }, 'https://evil.example');
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'forbidden_origin' });
    expect(kv.store.size).toBe(0);
  });

  it('mints a short-lived ticket bound to the deviceId it was issued for', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await apiSession(kv, { deviceId: 'dev-sess-4' });
    expect(status).toBe(200);
    expect(typeof body.ticket).toBe('string');
    expect(JSON.parse(kv.store.get(`3way:sess:${body.ticket}`)!)).toEqual({ deviceId: 'dev-sess-4' });
  });

  it('uses the clinic policy for tenant C instead of the shop trusted-click setting', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    CLINIC_POLICY_RULES.onMissingAuthenticator = 'refuse';
    const kv = new MockKV();
    const { status, body } = await apiSession(kv, { deviceId: 'dev-clinic', tenant: 'C' });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'trusted_click_not_permitted' });
    expect(kv.store.size).toBe(0);
  });

  it('rejects a malformed deviceId the same way /api/trusted-click does', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await apiSession(kv, { deviceId: '' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request' });
  });
});

describe('/api/trusted-click — refused unless policy explicitly permits it', () => {
  it("403s with trusted_click_not_permitted when onMissingAuthenticator is 'refuse' — " +
    "still the only setting this project ships safe, just not this deployment's", async () => {
    POLICY_RULES.onMissingAuthenticator = 'refuse';
    const kv = new MockKV();
    const { status, body } = await trustedClick(kv, { requestId: 'req-1', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-1' });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'trusted_click_not_permitted' });
    // Refused before touching KV at all — same "allowlist/policy first" discipline as
    // /api/act's own tool allowlist check.
    expect(kv.store.size).toBe(0);
  });
});

describe('/api/trusted-click — session ticket gate', () => {
  it('400s bad_request when sessionTicket is missing entirely', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await trustedClick(kv, { requestId: 'req-tc-1', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-tc-1' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'bad_request' });
  });

  it('403s session_required for a ticket that was never issued', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await trustedClick(kv, {
      requestId: 'req-tc-2', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-tc-2', sessionTicket: 'never-issued',
    });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'session_required' });
  });

  it('403s session_required for a real ticket presented alongside a different deviceId ' +
    'than the one it was issued for', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-tc-3-original');
    const { status, body } = await trustedClick(kv, {
      requestId: 'req-tc-3', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-tc-3-impostor', sessionTicket: ticket,
    });
    expect(status).toBe(403);
    expect(body).toEqual({ error: 'session_required' });
  });

  it('burns the ticket on first use — a second attempt with the same ticket is refused ' +
    'exactly like one that was never issued', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-tc-4');
    const first = await trustedClick(kv, {
      requestId: 'req-tc-4a', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-tc-4', sessionTicket: ticket,
    });
    expect(first.status).toBe(200);
    expect(kv.store.has(`3way:sess:${ticket}`)).toBe(false);
    const second = await trustedClick(kv, {
      requestId: 'req-tc-4b', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-tc-4', sessionTicket: ticket,
    });
    expect(second.status).toBe(403);
    expect(second.body).toEqual({ error: 'session_required' });
  });
});

describe('/api/trusted-click — the permitted path', () => {
  it('mints a token recorded at trusted-click assurance when the device has never registered a credential', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-2');
    const { status, body } = await trustedClick(kv, {
      requestId: 'req-2', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-2', sessionTicket: ticket,
    });
    expect(status).toBe(200);
    expect(typeof body.token).toBe('string');
    const stored = JSON.parse(kv.store.get(`3way:tok:${body.token}`)!);
    expect(stored).toMatchObject({
      requestId: 'req-2', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-2', used: false, assurance: 'trusted-click',
    });
  });

  it('refuses when this device already has a registered credential on file — contradicts the "no authenticator" claim', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    kv.store.set('3way:cred:dev-3', JSON.stringify({ id: 'c', publicKey: 'x', counter: 0 }));
    // The credential check runs before the ticket is ever looked up, so a syntactically
    // valid but never-minted ticket is enough here — it's never actually checked.
    const { status, body } = await trustedClick(kv, {
      requestId: 'req-3', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-3', sessionTicket: 'unused-ticket',
    });
    expect(status).toBe(403);
    expect(body.error).toBe('device_has_authenticator');
    // No token minted for a claim the Worker has direct evidence against.
    expect([...kv.store.keys()]).toEqual(['3way:cred:dev-3']);
  });

  it('requires the eligibility triple for confirm_return, same as /api/webauthn/options', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    // The eligibility check runs before the ticket is ever looked up too.
    const { status, body } = await trustedClick(kv, {
      requestId: 'req-4', tool: 'confirm_return', deviceId: 'dev-4', sessionTicket: 'unused-ticket',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });

  it.each([
    ['over 300 characters', 'A'.repeat(301), /300 characters/i],
    ['contains a control character', '14 Bellweather Lane\tBristol', /control character/i],
    ['contains a bidi override', '14 Bellweather Lane\u202E123', /control character|formatting/i],
    ['contains a bidi isolate', '14 Bellweather Lane\u2066123\u2069', /control character|formatting/i],
    ['contains a zero-width character', '14 Bellweather\u200B Lane', /control character|formatting/i],
    ['contains a Unicode line separator', '14 Bellweather Lane\u2028Bristol', /control character|formatting/i],
    ['contains a Unicode paragraph separator', '14 Bellweather Lane\u2029Bristol', /control character|formatting/i],
  ])('rejects an address that is %s before consuming a session ticket',
    async (_label, address, expectedMessage) => {
      POLICY_RULES.onMissingAuthenticator = 'trusted-click';
      const kv = new MockKV();
      const ticket = await mintTicket(kv, 'dev-address');
      const { status, body } = await trustedClick(kv, {
        requestId: 'req-address', tool: 'change_address', orderId: 'ORD-1118', address,
        deviceId: 'dev-address', sessionTicket: ticket,
      });
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_address');
      expect(body.message).toMatch(expectedMessage);
      expect(kv.store.has(`3way:sess:${ticket}`)).toBe(true);
    });

  it('rejects malformed request bodies the same way /api/webauthn/options does', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const { status, body } = await trustedClick(kv, { requestId: '', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-5', sessionTicket: 'x' });
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
  });

  it('the minted token completes /api/act, and the act result records the weaker assurance', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-5');
    const mint = await trustedClick(kv, {
      requestId: 'req-5', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-5', sessionTicket: ticket,
    });
    const { status, body } = await act(kv, { tool: 'cancel_order', requestId: 'req-5', token: mint.body.token });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, tool: 'cancel_order', requestId: 'req-5', refunded: false, assurance: 'trusted-click', orderId: 'ORD-1118', cancelled: true });
  });

  it('a trusted-click token still cannot be redirected to a different tool — same binding as a webauthn token', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-6');
    const mint = await trustedClick(kv, {
      requestId: 'req-6', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-6', sessionTicket: ticket,
    });
    const { status, body } = await act(kv, { tool: 'change_address', requestId: 'req-6', token: mint.body.token });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });

  it('refuses at /api/act when the token was minted trusted-click but the policy has since reverted to refuse', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-7');
    const mint = await trustedClick(kv, {
      requestId: 'req-7', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-7', sessionTicket: ticket,
    });
    POLICY_RULES.onMissingAuthenticator = 'refuse';   // policy flipped between mint and spend
    const { status, body } = await act(kv, { tool: 'cancel_order', requestId: 'req-7', token: mint.body.token });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });

  it('binds tenant C through ticket, mint, and spend so clinic policy changes are authoritative', async () => {
    POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    CLINIC_POLICY_RULES.onMissingAuthenticator = 'trusted-click';
    const kv = new MockKV();
    const ticket = await mintTicket(kv, 'dev-clinic-release', 'C');
    const mint = await trustedClick(kv, {
      requestId: 'req-clinic-release', tool: 'release_records', deviceId: 'dev-clinic-release',
      sessionTicket: ticket, tenant: 'C', orderId: 'VIS-2291', itemId: 'Dr. Okafor', scope: 'routine',
    });
    expect(mint.status).toBe(200);
    const tokenRecord = JSON.parse(kv.store.get(`3way:tok:${mint.body.token}`)!);
    expect(tokenRecord.tenant).toBe('C');

    CLINIC_POLICY_RULES.onMissingAuthenticator = 'refuse';
    const { status, body } = await act(kv, {
      tool: 'release_records', requestId: 'req-clinic-release', token: mint.body.token,
    });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });

  it('a webauthn-minted token is unaffected by onMissingAuthenticator — the re-check is scoped to trusted-click tokens only', async () => {
    POLICY_RULES.onMissingAuthenticator = 'refuse';
    const kv = new MockKV();
    kv.store.set('3way:tok:tok-webauthn', JSON.stringify({
      requestId: 'req-8', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-8', used: false, assurance: 'webauthn',
    }));
    const { status, body } = await act(kv, { tool: 'cancel_order', requestId: 'req-8', token: 'tok-webauthn' });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, tool: 'cancel_order', requestId: 'req-8', refunded: false, assurance: 'webauthn', orderId: 'ORD-1118', cancelled: true });
  });
});
