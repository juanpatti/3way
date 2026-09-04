import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, type DataSource } from '../src/tools';
import { evaluateReturnEligibility } from '../src/eligibility';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import { RETURN_REASONS, isReturnReason } from '../src/types';
import type { Order, Product, ReturnReason } from '../src/types';

/**
 * Observed live on the deployed demo: `reason: "wrong_item"` — snake_case, the same
 * convention every TOOL name in this registry uses, so a natural guess for an agent that
 * never read the enum — fell through every explicit branch of evaluateReturnEligibility
 * and landed in the change-of-mind tail. The caller got a confidently-worded denial
 * ("Final sale items are not returnable for change of mind") for a case policy clause 4
 * covers outright. Nothing rejected it, and nothing said the code was unrecognised.
 *
 * The Worker validates `reason` against its own RETURN_REASONS before minting a ceremony,
 * so this was never an authorization hole — it is a wrong ANSWER, delivered to the person
 * and to both agents, which for a policy engine is its own kind of failure.
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

const PRODUCT: Product = {
  sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900, description: 'A lamp.', finalSale: false,
};

const data: DataSource = {
  listOrders: async () => [DELIVERED],
  getOrder: async id => (id === DELIVERED.orderId ? DELIVERED : null),
  searchProducts: async () => [PRODUCT],
  getProduct: async () => PRODUCT,
};

function fixture() {
  let n = 0, r = 0;
  const bus = createBus({ now: () => NOW, id: () => `e${++n}` });
  const tools = createTools({
    bus, data, act: vi.fn(async () => ({ ok: true })),
    now: () => NOW, newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
  });
  const byName = (name: string) => {
    const t = tools.find(x => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { bus, byName };
}

const CTX = { origin: 'agent-autonomous' as const, cursor: null };
const evalIt = (reason: unknown) =>
  evaluateReturnEligibility(DELIVERED, 'IT-1', reason as ReturnReason, POLICY_RULES, NOW);

describe('isReturnReason', () => {
  it('accepts exactly the four codes the tool schema advertises', () => {
    for (const r of RETURN_REASONS) expect(isReturnReason(r)).toBe(true);
    expect(RETURN_REASONS).toEqual(['defect', 'changed-mind', 'wrong-item', 'damaged-in-transit']);
  });

  it('rejects near-misses, wrong casing, and non-strings', () => {
    for (const bad of ['wrong_item', 'damaged_in_transit', 'Defect', 'banana', '', null, 7, {}]) {
      expect(isReturnReason(bad)).toBe(false);
    }
  });
});

describe('evaluateReturnEligibility rejects an unrecognised reason instead of guessing', () => {
  it('does not silently treat a snake_case guess as change-of-mind', () => {
    const r = evalIt('wrong_item');
    expect(r.eligible).toBe(false);
    expect(r.path).toBe('denied');
    // The actual defect: this used to render the change-of-mind clause.
    expect(r.because.join(' ')).not.toMatch(/change of mind/i);
    expect(r.because.join(' ')).toMatch(/wrong_item/);
    expect(r.because.join(' ')).toMatch(/defect, changed-mind, wrong-item, damaged-in-transit/);
  });

  it('rejects arbitrary garbage the same way', () => {
    const r = evalIt('banana');
    expect(r).toMatchObject({ eligible: false, path: 'denied' });
    expect(r.because.join(' ')).not.toMatch(/change of mind/i);
  });

  it('still honours the four real codes (regression)', () => {
    expect(evalIt('defect')).toMatchObject({ eligible: true, path: 'warranty' });
    expect(evalIt('wrong-item')).toMatchObject({ eligible: true, path: 'return' });
    expect(evalIt('changed-mind')).toMatchObject({ eligible: false, path: 'denied' });
    expect(evalIt('changed-mind').because.join(' ')).toMatch(/change-of-mind/i);
  });
});

describe('the tools refuse an unrecognised reason at the boundary', () => {
  it('evaluate_return_eligibility returns the rejection as a verdict, not a fabricated denial', async () => {
    const r = await fixture().byName('evaluate_return_eligibility')
      .execute({ orderId: 'ORD-1043', itemId: 'IT-1', reason: 'wrong_item' }, CTX) as any;
    expect(r.eligible).toBe(false);
    expect(r.because.join(' ')).toMatch(/not a return reason/i);
  });

  it('request_return refuses and creates NO pending request an agent could then confirm', async () => {
    const { byName } = fixture();
    const made = await byName('request_return')
      .execute({ orderId: 'ORD-1043', itemId: 'IT-1', reason: 'wrong_item' }, CTX) as any;
    expect(made.ok).toBe(false);
    expect(made.requestId).toBeUndefined();
    expect(made.message).toMatch(/not a return reason/i);

    // Nothing was filed, so nothing is confirmable — the important half of the fix.
    const spend = await byName('confirm_return').execute({ requestId: 'req-1' }, CTX) as any;
    expect(spend).toMatchObject({ ok: false });
    expect(spend.message).toMatch(/no pending request/i);
  });
});
