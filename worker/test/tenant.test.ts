import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { USER, PRODUCTS, seedOrders } from '../../config/seed';

/**
 * Regression coverage for the `tenant` query parameter on /api/orders and /api/products.
 * No KV involvement in these two routes at all,
 * so a bare stub is enough — this file is about which catalogue/user gets served, not the
 * authoritative gate (that's worker/test/act.test.ts).
 *
 * The orders payload embeds dates derived from "now" (seedOrders(now) computes
 * placedAt/deliveredAt relative to it). `env.NOW` is a test-only override the Worker reads
 * in place of `Date.now()` — every call in this file is frozen to the same fixed instant,
 * so the "no tenant vs. unrecognised tenant" comparison below is a genuine byte-for-byte
 * equality check, not two snapshots taken a clock tick apart. Without this, that
 * comparison was flaky: it passed standalone and failed intermittently in the full suite
 * whenever a millisecond separated the two calls.
 */
const NOW = 1_700_000_000_000;

function env() {
  return {
    OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
    RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN: 'http://localhost:3000',
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    NOW,
  };
}

async function get(path: string) {
  const res = await worker.fetch(new Request(`http://localhost${path}`), env() as any);
  return { status: res.status, body: await res.json() as any };
}

describe('an unrecognised tenant value falls back to the flagship defaults, not an error and not nothing', () => {
  it('/api/orders with an unrecognised tenant serves the flagship user and orders', async () => {
    const { status, body } = await get('/api/orders?tenant=nonexistent');
    expect(status).toBe(200);
    expect(body.user).toEqual(USER);
    expect(body.orders.length).toBeGreaterThan(0);
  });

  it('/api/products with an unrecognised tenant serves the flagship catalogue', async () => {
    const { status, body } = await get('/api/products?tenant=nonexistent');
    expect(status).toBe(200);
    expect(body.products).toEqual(PRODUCTS);
  });

  it('an empty tenant value falls back the same way, not an error', async () => {
    const { status, body } = await get('/api/orders?tenant=');
    expect(status).toBe(200);
    expect(body.user).toEqual(USER);
  });

  it('no tenant at all is identical to an unrecognised one — the exact behaviour from before this parameter existed', async () => {
    const withNone = await get('/api/orders');
    const withUnknown = await get('/api/orders?tenant=nonexistent');
    expect(withNone.body).toEqual(withUnknown.body);
  });
});

describe('legacy storefront tenant values no longer select a hidden public demo', () => {
  it('an unknown storefront falls back to the flagship user, orders, and catalogue', async () => {
    const orders = await get('/api/orders?tenant=legacy-store');
    expect(orders.status).toBe(200);
    expect(orders.body.user).toEqual(USER);
    expect(orders.body.orders).toEqual(seedOrders(NOW));

    const products = await get('/api/products?tenant=legacy-store');
    expect(products.status).toBe(200);
    expect(products.body.products).toEqual(PRODUCTS);
  });
});
