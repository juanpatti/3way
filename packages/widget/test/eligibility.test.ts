import { describe, it, expect } from 'vitest';
import { evaluateReturnEligibility } from '../src/eligibility';
import { POLICY_RULES } from '../../../config/policy';
import type { Order } from '../src/types';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function order(overrides: Partial<Order> = {}, sku = 'SKU-STD-001'): Order {
  return {
    orderId: 'ORD-1',
    placedAt: NOW - 40 * DAY,
    deliveredAt: NOW - 35 * DAY,
    status: 'delivered',
    items: [{ itemId: 'IT-1', sku, title: 'Thing', price: 9900 }],
    ...overrides,
  };
}

const evalIt = (o: Order, reason: Parameters<typeof evaluateReturnEligibility>[2]) =>
  evaluateReturnEligibility(o, 'IT-1', reason, POLICY_RULES, NOW);

describe('evaluateReturnEligibility', () => {
  it('THE SHOWCASE: a defect past the window is a warranty claim, not a denial', () => {
    const r = evalIt(order(), 'defect');
    expect(r).toMatchObject({ eligible: true, path: 'warranty' });
    expect(r.because.join(' ')).toMatch(/warranty/i);
  });

  it('denies change of mind past the window', () => {
    expect(evalIt(order(), 'changed-mind')).toMatchObject({ eligible: false, path: 'denied' });
  });

  it('allows change of mind inside the window', () => {
    const r = evalIt(order({ deliveredAt: NOW - 5 * DAY }), 'changed-mind');
    expect(r).toMatchObject({ eligible: true, path: 'return' });
  });

  it('denies change of mind on a final-sale item even inside the window', () => {
    const o = order({ deliveredAt: NOW - 5 * DAY }, 'SKU-CLR-114');
    expect(evalIt(o, 'changed-mind')).toMatchObject({ eligible: false, path: 'denied' });
  });

  it('CLAUSE INTERACTION: final sale does not block a defect', () => {
    const o = order({ deliveredAt: NOW - 5 * DAY }, 'SKU-CLR-114');
    expect(evalIt(o, 'defect')).toMatchObject({ eligible: true, path: 'warranty' });
  });

  it('CLAUSE INTERACTION: final sale plus past window still yields warranty for a defect', () => {
    expect(evalIt(order({}, 'SKU-CLR-114'), 'defect')).toMatchObject({ eligible: true, path: 'warranty' });
  });

  it('covers our own error regardless of window or final sale', () => {
    expect(evalIt(order({}, 'SKU-CLR-114'), 'wrong-item')).toMatchObject({ eligible: true, path: 'return' });
  });

  it('covers transit damage on final sale, but only inside the window', () => {
    const inside = order({ deliveredAt: NOW - 5 * DAY }, 'SKU-CLR-114');
    expect(evalIt(inside, 'damaged-in-transit')).toMatchObject({ eligible: true, path: 'return' });
    expect(evalIt(order({}, 'SKU-CLR-114'), 'damaged-in-transit')).toMatchObject({ eligible: false });
  });

  it('denies an undelivered order', () => {
    const o = order({ deliveredAt: null, status: 'in_transit' });
    expect(evalIt(o, 'changed-mind')).toMatchObject({ eligible: false, path: 'denied' });
  });

  it('denies an item that is not in the order', () => {
    const r = evaluateReturnEligibility(order(), 'IT-NOPE', 'defect', POLICY_RULES, NOW);
    expect(r).toMatchObject({ eligible: false, path: 'denied' });
  });

  it('treats the boundary day as inside the window', () => {
    const o = order({ deliveredAt: NOW - 30 * DAY });
    expect(evalIt(o, 'changed-mind')).toMatchObject({ eligible: true });
  });

  it('always explains itself', () => {
    for (const reason of ['defect', 'changed-mind', 'wrong-item', 'damaged-in-transit'] as const) {
      expect(evalIt(order(), reason).because.length).toBeGreaterThan(0);
    }
  });
});
