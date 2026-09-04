import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { POLICY_RULES } from '../../config/policy';
import { CLINIC_POLICY_RULES } from '../../config/clinic';

/**
 * Regression coverage for /api/webauthn/options's relying-party name. The platform's
 * native registration prompt shows this to the person, and unknown storefront values
 * must not change the configured display name. No real WebAuthn assertion is needed to exercise
 * this: generateRegistrationOptions() is a pure options-generation call, not a signature
 * check, so this runs against the exported fetch handler directly like worker/test/
 * act.test.ts and tenant.test.ts, with a MockKV that always reports "no stored
 * credential" so every call here takes the register (not authenticate) branch.
 */
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

function env() {
  return {
    OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
    RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN: 'http://localhost:3000',
    KV: new MockKV(),
  };
}

async function options(body: unknown) {
  const req = new Request('http://localhost/api/webauthn/options', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env() as any);
  return { status: res.status, body: await res.json() as any };
}

describe('/api/webauthn/options — unknown tenant values retain the configured relying-party name', () => {
  it("an unknown storefront does not change the relying-party display name", async () => {
    const { status, body } = await options({
      requestId: 'req-1', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-1', tenant: 'legacy-store',
    });
    expect(status).toBe(200);
    expect(body.mode).toBe('register');
    expect(body.publicKey.rp.name).toBe('Halden');
  });

  it('no tenant (the flagship default) registers under env.RP_NAME, unchanged from before tenant existed', async () => {
    const { status, body } = await options({
      requestId: 'req-2', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-2',
    });
    expect(status).toBe(200);
    expect(body.publicKey.rp.name).toBe('Halden');
  });

  it('an unrecognized tenant value falls back to env.RP_NAME the same way the GET routes fall back', async () => {
    const { status, body } = await options({
      requestId: 'req-3', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-3', tenant: 'nonexistent',
    });
    expect(status).toBe(200);
    expect(body.publicKey.rp.name).toBe('Halden');
  });
});

/**
 * cancel_order and change_address were the last two gated actions binding NOTHING at mint
 * time: /api/act had no order for either, fell through to a generic success branch that
 * knew neither the order nor the address, and the browser then wrote "Order cancelled." /
 * "Delivery address updated." out of its own local pending object. The ceremony was real
 * and the effect was unbound — exactly what binding the eligibility triple exists to stop
 * for confirm_return.
 */
describe('/api/webauthn/options — every gated action commits to its subject before the person authenticates', () => {
  it('refuses a cancellation that names no order', async () => {
    const { status, body } = await options({ requestId: 'req-c1', tool: 'cancel_order', deviceId: 'dev-c1' });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });

  it('accepts a cancellation that names one', async () => {
    const { status } = await options({
      requestId: 'req-c2', tool: 'cancel_order', orderId: 'ORD-1118', deviceId: 'dev-c2' });
    expect(status).toBe(200);
  });

  it('refuses an address change with an order but no address — a redirect to nowhere', async () => {
    const { status, body } = await options({
      requestId: 'req-a1', tool: 'change_address', orderId: 'ORD-1118', deviceId: 'dev-a1' });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });

  it('refuses an address change whose address is only whitespace', async () => {
    const { status, body } = await options({
      requestId: 'req-a2', tool: 'change_address', orderId: 'ORD-1118', address: '   ', deviceId: 'dev-a2' });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });

  it('accepts an address change that commits to both', async () => {
    const { status } = await options({
      requestId: 'req-a3', tool: 'change_address', orderId: 'ORD-1118',
      address: '14 Bellweather Lane, Bristol BS1 4TR', deviceId: 'dev-a3' });
    expect(status).toBe(200);
  });

  it('accepts exactly 300 address characters without truncation or an off-by-one refusal', async () => {
    const { status } = await options({
      requestId: 'req-a300', tool: 'change_address', orderId: 'ORD-1118',
      address: 'A'.repeat(300), deviceId: 'dev-a300',
    });
    expect(status).toBe(200);
  });

  it.each([
    ['orderId', '   ', 'IT-1'],
    ['itemId', 'ORD-1043', '   '],
  ])('rejects a whitespace-only %s instead of restoring loose truthiness',
    async (_field, orderId, itemId) => {
      const { status, body } = await options({
        requestId: `req-whitespace-${_field}`, tool: 'confirm_return', deviceId: `dev-${_field}`,
        orderId, itemId, reason: 'defect',
      });
      expect(status).toBe(400);
      expect(body.error).toBe('missing_eligibility_fields');
    });

  it.each([
    ['over 300 characters', 'A'.repeat(301), /300 characters/i],
    ['contains a control character', '14 Bellweather Lane\nBristol', /control character/i],
    ['contains a bidi override', '14 Bellweather Lane\u202E123', /control character|formatting/i],
    ['contains a bidi isolate', '14 Bellweather Lane\u2066123\u2069', /control character|formatting/i],
    ['contains a zero-width character', '14 Bellweather\u200B Lane', /control character|formatting/i],
    ['contains a Unicode line separator', '14 Bellweather Lane\u2028Bristol', /control character|formatting/i],
    ['contains a Unicode paragraph separator', '14 Bellweather Lane\u2029Bristol', /control character|formatting/i],
  ])('rejects an address that is %s instead of silently changing what was displayed',
    async (_label, address, expectedMessage) => {
      const { status, body } = await options({
        requestId: 'req-invalid-address', tool: 'change_address', orderId: 'ORD-1118',
        address, deviceId: 'dev-invalid-address',
      });
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_address');
      expect(body.message).toMatch(expectedMessage);
    });
});

describe('/api/webauthn/options — policy/binder configuration fails closed', () => {
  const SUBJECTS: Record<string, Record<string, unknown>> = {
    confirm_return: { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' },
    cancel_order: { orderId: 'ORD-1118' },
    change_address: { orderId: 'ORD-1118', address: '14 Bellweather Lane, Bristol' },
    disclose_order_records: { orderId: 'ORD-1043' },
    release_records: { orderId: 'VIS-2291', itemId: 'Dr. Okafor', scope: 'routine' },
  };
  const GATED = [...new Set([
    ...POLICY_RULES.requiresHumanDirect,
    ...CLINIC_POLICY_RULES.requiresHumanDirect,
  ])];

  it.each(GATED)('%s has a binder that accepts its complete subject', async (tool) => {
    const subject = SUBJECTS[tool];
    if (!subject) throw new Error(`No binder fixture for policy-gated tool ${tool}`);
    const { status } = await options({
      requestId: `req-${tool}`, tool, deviceId: `dev-${tool}`, ...subject,
    });
    expect(status).toBe(200);
  });

  it('rejects an unrecognized binder instead of minting an unbound challenge', async () => {
    const { status, body } = await options({
      requestId: 'req-future', tool: 'future_gated_tool', deviceId: 'dev-future',
    });
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });
});
