import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, scopeFor, withPiggyback, type DataSource } from '../src/tools';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Product } from '../src/types';

/**
 * A return that has completed cannot be filed again in the same session. Found on camera:
 * after a refund completed, the visiting agent re-filed request_return for the SAME order,
 * a fresh confirm box appeared, and confirming it would have refunded ORD-1043 twice —
 * nothing recorded the first return, and the pure eligibility engine keeps saying a
 * warranty defect qualifies. The gateway now records completed returns per (orderId,
 * itemId) and refuses to file or raise a box for one already done.
 *
 * In memory and per gateway ON PURPOSE, so a reload re-runs the seeded demo. No server
 * marker backs it up: keyed on the stable seeded order it would refuse a filmed rerun
 * after the hardware gesture, and a genuine second refund would need a second full
 * ceremony (a fresh WebAuthn assertion and token) — the person's own choice, not a silent
 * double-spend this guard must close.
 */
const NOW = 1_700_000_000_000;
const ORDER: Order = {
  orderId: 'ORD-1043', placedAt: NOW - 40 * 86_400_000, deliveredAt: NOW - 35 * 86_400_000,
  status: 'delivered',
  items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900 }],
};
const ORDER_B: Order = {
  orderId: 'ORD-1102', placedAt: NOW - 6 * 86_400_000, deliveredAt: NOW - 4 * 86_400_000,
  status: 'delivered',
  items: [{ itemId: 'IT-2', sku: 'SKU-CLR-114', title: 'Sconce', price: 4500 }],
};
const PRODUCT: Product = { sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900, description: '.', finalSale: false };
const data: DataSource = {
  listOrders: async () => [ORDER, ORDER_B],
  getOrder: async (id) => [ORDER, ORDER_B].find(o => o.orderId === id) ?? null,
  searchProducts: async () => [PRODUCT],
  getProduct: async () => PRODUCT,
};

function fixture() {
  let n = 0, r = 0;
  const bus = createBus({ now: () => Date.now(), id: () => `e${++n}` });
  const act = vi.fn(async () => ({ ok: true, data: { refunded: true } }));
  const raised: Array<{ requestId: string; tool: string }> = [];
  const tools = createTools({
    bus, data, act, now: () => NOW, newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
    onConfirmationNeeded: (req, tool) => { raised.push({ requestId: req.requestId, tool }); },
  });
  const agentTools = withPiggyback(scopeFor(tools, 'visiting-agent'), bus);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    agentTools.find(x => x.name === name)!.execute(input, { origin: 'agent-autonomous', cursor: null }) as Promise<any>;
  const raw = (name: string, input: Record<string, unknown>) =>
    tools.find(x => x.name === name)!.execute(input, { origin: 'human-direct', cursor: null }) as Promise<any>;
  /** File, then complete a return the way index.ts's onConfirm does after a real ceremony. */
  const completeReturn = async (orderId: string, itemId: string) => {
    const { requestId } = await call('request_return', { orderId, itemId, reason: 'defect' });
    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: requestId,
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok', at: 1 },
    });
    const done = await raw('confirm_return', { requestId });
    expect(done).toMatchObject({ ok: true, outcome: 'completed' });
    return requestId;
  };
  return { bus, tools, call, raw, act, raised, completeReturn };
}

describe('a completed return cannot be filed or confirmed a second time', () => {
  it('refuses a re-filed request_return for the same item, and raises no second box', async () => {
    const { call, act, raised, completeReturn } = fixture();
    await completeReturn('ORD-1043', 'IT-1');
    expect(raised).toHaveLength(1);      // the first, legitimate box
    expect(act).toHaveBeenCalledTimes(1);

    const again = await call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already been returned/i);
    expect(again.requestId).toBeUndefined();   // nothing was filed
    expect(raised).toHaveLength(1);            // no new affordance offered
    expect(act).toHaveBeenCalledTimes(1);      // and certainly no second refund
  });

  it('reports the item as no longer eligible once returned', async () => {
    const { call, completeReturn } = fixture();
    const before = await call('evaluate_return_eligibility', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    expect(before.eligible).toBe(true);
    await completeReturn('ORD-1043', 'IT-1');
    const after = await call('evaluate_return_eligibility', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    expect(after.eligible).toBe(false);
    expect(after.because.join(' ')).toMatch(/already been returned/i);
  });

  it('does not block a different order after one is returned', async () => {
    const { call, raised, completeReturn } = fixture();
    await completeReturn('ORD-1043', 'IT-1');
    const other = await call('request_return', { orderId: 'ORD-1102', itemId: 'IT-2', reason: 'defect' });
    expect(other.ok).toBe(true);
    expect(other.eligibility.eligible).toBe(true);
    expect(raised.map(r => r.requestId)).toContain(other.requestId);   // its box is offered
  });

  it('resets per gateway, so a fresh mount re-runs the seeded demo', async () => {
    const first = fixture();
    await first.completeReturn('ORD-1043', 'IT-1');
    // A brand-new gateway is what a page reload builds: it carries no completed state.
    const fresh = fixture();
    const r = await fresh.call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    expect(r.ok).toBe(true);
    expect(r.eligibility.eligible).toBe(true);
  });
});
