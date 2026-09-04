import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { ORDER_RECORDS } from '../../config/seed';

/**
 * disclose_order_records is the gated action that moves no money. It exists to show the
 * confirmation gate is a CONSENT primitive rather than a payments one: releasing the card
 * type and its last four digits, the billing postcode and the delivery address needs the
 * person present exactly as a refund does.
 *
 * That claim only holds if the values are genuinely unreachable without a spent token,
 * which is why they live here and not in the Order type: /api/orders does not carry them,
 * the browser never holds them, and this endpoint is the only thing that returns them.
 * A gate in front of data the page already had would be theatre — these tests are what
 * stop it quietly becoming that.
 */
class MockKV {
  store = new Map<string, string>();
  puts: string[] = [];
  async get(key: string, type?: string): Promise<unknown> {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> { this.puts.push(key); this.store.set(key, value); }
  async delete(key: string): Promise<void> { this.store.delete(key); }
  seedToken(token: string, record: Record<string, unknown>): void {
    this.store.set(`3way:tok:${token}`, JSON.stringify(record));
  }
}

const NOW = 1_700_000_000_000;
const env = (kv: MockKV) => ({
  OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
  RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN: 'http://localhost:3000',
  KV: kv, NOW,
});

async function post(kv: MockKV, path: string, body: unknown, origin?: string) {
  const res = await worker.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  }), env(kv) as any);
  return { status: res.status, body: await res.json() as any };
}

async function get(kv: MockKV, path: string) {
  const res = await worker.fetch(new Request(`http://localhost${path}`), env(kv) as any);
  return await res.json() as any;
}

const TOKEN = 'tok-records-1';
const seedGoodToken = (kv: MockKV, over: Record<string, unknown> = {}) => {
  kv.seedToken(TOKEN, {
    requestId: 'req-1', tool: 'disclose_order_records', deviceId: 'dev-1',
    orderId: 'ORD-1043', used: false, assurance: 'webauthn', ...over,
  });
};

describe('the records are not readable without spending a confirmation', () => {
  it('/api/orders does not carry them — the browser never holds them at all', async () => {
    const kv = new MockKV();
    const body = await get(kv, '/api/orders');
    const serialized = JSON.stringify(body);
    for (const field of ['paymentLast4', 'paymentBrand', 'billingPostcode', 'deliveredTo']) {
      expect(serialized).not.toContain(field);
    }
    expect(serialized).not.toContain(ORDER_RECORDS['ORD-1043']!.paymentLast4);
    expect(serialized).not.toContain(ORDER_RECORDS['ORD-1043']!.deliveredTo);
  });

  it('/api/act refuses the disclosure with no token', async () => {
    const kv = new MockKV();
    const { status, body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1' });
    expect(status).toBe(403);
    expect(body).toEqual({ ok: false, error: 'confirmation_required' });
  });

  it('/api/act refuses a token that was never minted', async () => {
    const kv = new MockKV();
    const { status, body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: 'invented' });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
    expect(JSON.stringify(body)).not.toContain('6411');
  });

  it('refuses a token minted for a DIFFERENT action, so a refund cannot become a disclosure', async () => {
    const kv = new MockKV();
    seedGoodToken(kv, { tool: 'confirm_return', itemId: 'IT-1', reason: 'defect' });
    const { status, body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN });
    expect(status).toBe(403);
    expect(body.error).toBe('invalid_token');
  });
});

describe('a spent confirmation returns exactly the bound order’s records', () => {
  it('returns them, and marks the token used', async () => {
    const kv = new MockKV();
    seedGoodToken(kv);
    const { status, body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true, tool: 'disclose_order_records', requestId: 'req-1',
      refunded: false, assurance: 'webauthn',
      records: ORDER_RECORDS['ORD-1043'],
    });
    expect(kv.puts).toContain(`3way:tok:${TOKEN}`);
  });

  it('never reports a refund — this action moves no money', async () => {
    const kv = new MockKV();
    seedGoodToken(kv);
    const { body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN });
    expect(body.refunded).toBe(false);
  });

  it('reads the order from the TOKEN, not from the request body', async () => {
    // The page cannot redirect a disclosure the person authorised for ORD-1043 onto a
    // different order by asking for one here; nothing in this body is consulted.
    const kv = new MockKV();
    seedGoodToken(kv);
    const { body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN, orderId: 'ORD-1118' });
    expect(body.records).toEqual(ORDER_RECORDS['ORD-1043']);
  });

  it('refuses a token bound to an order that does not exist', async () => {
    const kv = new MockKV();
    seedGoodToken(kv, { orderId: 'ORD-NOPE' });
    const { status, body } = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN });
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_order');
  });

  it('refuses a replay by returning the stored result rather than re-running', async () => {
    const kv = new MockKV();
    seedGoodToken(kv);
    await post(kv, '/api/act', { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN });
    const again = await post(kv, '/api/act',
      { tool: 'disclose_order_records', requestId: 'req-1', token: TOKEN });
    expect(again.body).toMatchObject({ ok: true, records: ORDER_RECORDS['ORD-1043'] });
    // Same ceremony, same answer — never a second, independently computed disclosure.
    expect(kv.puts.filter(k => k === `3way:tok:${TOKEN}`)).toHaveLength(1);
  });
});

describe('the ceremony must commit to an order before the person authenticates', () => {
  it('/api/webauthn/options refuses a disclosure with no orderId', async () => {
    const kv = new MockKV();
    const { status, body } = await post(kv, '/api/webauthn/options',
      { requestId: 'req-1', tool: 'disclose_order_records', deviceId: 'dev-1' },
      'http://localhost:3000');
    expect(status).toBe(400);
    expect(body.error).toBe('missing_eligibility_fields');
  });
});
