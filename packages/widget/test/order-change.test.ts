import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, type DataSource } from '../src/tools';
import { evaluateOrderChange } from '../src/eligibility';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Product } from '../src/types';

/**
 * Observed live on the deployed demo: `cancel_order` and `change_address` were registered,
 * listed in POLICY_RULES.requiresHumanDirect, and completely unreachable.
 *
 *   - Both took only `{ requestId }`, documented as "the id returned by request_return",
 *     and nothing in the registry could create any other kind of pending request.
 *   - So their gate evaluated RETURN eligibility. Cancelling an in-transit order was
 *     refused with "has not been delivered yet, so no return applies" — the wrong concept
 *     applied to the wrong action, and exactly backwards: not-yet-delivered is precisely
 *     when a cancellation SHOULD be allowed.
 *   - change_address had no field for the new address at all, so even a successful call
 *     could not say what to change it to.
 *
 * These tests pin the shape that makes them real: their own request-creating tools, their
 * own eligibility rule, and a request kind the gate binds to so one kind of confirmation
 * cannot spend another's.
 */

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const DELIVERED: Order = {
  orderId: 'ORD-1043',
  placedAt: NOW - 40 * DAY,
  deliveredAt: NOW - 35 * DAY,
  status: 'delivered',
  items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900 }],
};

const IN_TRANSIT: Order = {
  orderId: 'ORD-1118',
  placedAt: NOW - 2 * DAY,
  deliveredAt: null,
  status: 'in_transit',
  items: [{ itemId: 'IT-3', sku: 'SKU-STD-002', title: 'Sand Lamp', price: 9900 }],
};

const PRODUCT: Product = {
  sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900, description: 'A lamp.', finalSale: false,
};

const ORDERS = [DELIVERED, IN_TRANSIT];
const data: DataSource = {
  listOrders: async () => ORDERS,
  getOrder: async id => ORDERS.find(o => o.orderId === id) ?? null,
  searchProducts: async () => [PRODUCT],
  getProduct: async () => PRODUCT,
};

function fixture() {
  let n = 0, r = 0;
  const bus = createBus({ now: () => NOW, id: () => `e${++n}` });
  const act = vi.fn(async () => ({ ok: true }));
  const raised: Array<{ requestId: string; tool: string }> = [];
  const tools = createTools({
    bus, data, act, now: () => NOW, newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
    onConfirmationNeeded: (req, tool) => { raised.push({ requestId: req.requestId, tool }); },
  });
  const byName = (name: string) => {
    const t = tools.find(x => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { bus, byName, act, raised, tools };
}

const CTX = { origin: 'agent-autonomous' as const, cursor: null };
const HUMAN_CTX = { origin: 'human-direct' as const, cursor: null };

describe('evaluateOrderChange', () => {
  it('allows cancelling an order that has not been delivered', () => {
    const r = evaluateOrderChange(IN_TRANSIT, 'cancel');
    expect(r).toMatchObject({ eligible: true, path: 'order-change' });
  });

  it('refuses to cancel a delivered order, and says so in cancellation terms', () => {
    const r = evaluateOrderChange(DELIVERED, 'cancel');
    expect(r).toMatchObject({ eligible: false, path: 'denied' });
    expect(r.because.join(' ')).toMatch(/delivered/i);
    // The bug this replaces: a return-shaped explanation for a cancellation.
    expect(r.because.join(' ')).not.toMatch(/no return applies/i);
  });

  it('applies the same delivered/not-delivered rule to a redirect', () => {
    expect(evaluateOrderChange(IN_TRANSIT, 'address-change').eligible).toBe(true);
    expect(evaluateOrderChange(DELIVERED, 'address-change').eligible).toBe(false);
  });
});

describe('request_cancel', () => {
  it('files a cancellable request for an in-transit order and raises the confirm affordance', async () => {
    const { byName, raised } = fixture();
    const r = await byName('request_cancel').execute({ orderId: 'ORD-1118' }, CTX) as any;
    expect(r).toMatchObject({ ok: true, requestId: 'req-1' });
    expect(r.eligibility).toMatchObject({ eligible: true, path: 'order-change' });
    expect(raised).toEqual([{ requestId: 'req-1', tool: 'cancel_order' }]);
  });

  it('files a denied request for a delivered order and raises nothing', async () => {
    const { byName, raised } = fixture();
    const r = await byName('request_cancel').execute({ orderId: 'ORD-1043' }, CTX) as any;
    expect(r.eligibility.eligible).toBe(false);
    expect(raised).toEqual([]);
  });

  it('refuses an unknown order', async () => {
    const r = await fixture().byName('request_cancel').execute({ orderId: 'NOPE' }, CTX) as any;
    expect(r).toMatchObject({ ok: false });
  });
});

describe('request_address_change', () => {
  it('requires a non-empty address — the field that did not exist before', async () => {
    const { byName } = fixture();
    expect(byName('request_address_change').inputSchema)
      .toMatchObject({ required: ['orderId', 'address'] });
    const r = await byName('request_address_change').execute({ orderId: 'ORD-1118' }, CTX) as any;
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/address/i);
  });

  it.each([
    ['over 300 characters', 'A'.repeat(301), /300 characters/i],
    ['contains a control character', '12 Newgate St\nLondon', /control character/i],
  ])('refuses an address that is %s with a relay-safe reason and files no request',
    async (_label, address, expectedReason) => {
      const { byName, raised } = fixture();
      const r = await byName('request_address_change').execute(
        { orderId: 'ORD-1118', address }, CTX) as any;
      expect(r).toMatchObject({ ok: false });
      expect(r.message).toMatch(expectedReason);
      expect(raised).toEqual([]);
    });

  it('returns the new address locally without placing personal data in the transcript', async () => {
    const { byName, bus, act } = fixture();
    act.mockResolvedValueOnce({
      ok: true, data: { address: '12 Newgate St, London' },
    } as any);
    const made = await byName('request_address_change')
      .execute({ orderId: 'ORD-1118', address: '12 Newgate St, London' }, CTX) as any;
    expect(made.ok).toBe(true);

    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.',
      confirms: made.requestId, confirmsTool: 'change_address',
      verification: { method: 'webauthn', token: 't', at: NOW },
    });
    const done = await byName('change_address').execute(
      { requestId: made.requestId }, HUMAN_CTX) as any;
    expect(done).toMatchObject({ ok: true, address: '12 Newgate St, London' });
    expect(bus.all().at(-1)!.text).toBe('Delivery address updated. Completed for ORD-1118.');
    expect(bus.all().map(entry => entry.text).join(' ')).not.toContain('12 Newgate St, London');
  });
});

describe('a confirmation is bound to the KIND of request it was filed for', () => {
  it('cancel_order refuses a return request id', async () => {
    const { byName } = fixture();
    const ret = await byName('request_return')
      .execute({ orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX) as any;
    const r = await byName('cancel_order').execute({ requestId: ret.requestId }, CTX) as any;
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/not a cancellation request/i);
  });

  it('confirm_return refuses a cancellation request id', async () => {
    const { byName } = fixture();
    const cancel = await byName('request_cancel').execute({ orderId: 'ORD-1118' }, CTX) as any;
    const r = await byName('confirm_return').execute({ requestId: cancel.requestId }, CTX) as any;
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/not a return request/i);
  });

  it('the kind check runs before the gate, so a wrong-kind call never raises a confirm box', async () => {
    const { byName, raised } = fixture();
    const cancel = await byName('request_cancel').execute({ orderId: 'ORD-1118' }, CTX) as any;
    raised.length = 0;
    await byName('confirm_return').execute({ requestId: cancel.requestId }, CTX);
    expect(raised).toEqual([]);
  });
});

describe('cancel_order end to end', () => {
  it('is refused without a confirmation, then completes with one', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_cancel').execute({ orderId: 'ORD-1118' }, CTX) as any;

    const blocked = await byName('cancel_order').execute({ requestId: made.requestId }, CTX) as any;
    expect(blocked).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(act).not.toHaveBeenCalled();

    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.',
      confirms: made.requestId, confirmsTool: 'cancel_order',
      verification: { method: 'webauthn', token: 't', at: NOW },
    });
    const done = await byName('cancel_order').execute(
      { requestId: made.requestId }, HUMAN_CTX) as any;
    expect(done).toMatchObject({ ok: true, orderId: 'ORD-1118' });
    expect(act).toHaveBeenCalledWith('cancel_order', made.requestId, 't');
    expect(bus.all().at(-1)!.text).toBe('Order cancelled. Completed for ORD-1118.');
  });

  it('never completes a request the policy denied, even after a real ceremony', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_cancel').execute({ orderId: 'ORD-1043' }, CTX) as any;
    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.',
      confirms: made.requestId, confirmsTool: 'cancel_order',
      verification: { method: 'webauthn', token: 't', at: NOW },
    });
    const r = await byName('cancel_order').execute({ requestId: made.requestId }, CTX) as any;
    expect(r).toMatchObject({ ok: false });
    expect(act).not.toHaveBeenCalled();
  });
});
