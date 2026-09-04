import { describe, it, expect } from 'vitest';
import { seedOrders, PRODUCTS } from '../../../config/seed';
import { evaluateReturnEligibility } from '../src/eligibility';
import { POLICY_RULES } from '../../../config/policy';

const NOW = 1_700_000_000_000;

describe('seed data supports the demo', () => {
  const orders = seedOrders(NOW);
  const find = (id: string) => orders.find(o => o.orderId === id)!;

  it('ORD-1043 is past the window, so a defect must resolve as warranty', () => {
    const r = evaluateReturnEligibility(find('ORD-1043'), 'IT-1', 'defect', POLICY_RULES, NOW);
    expect(r).toMatchObject({ eligible: true, path: 'warranty' });
  });

  it('ORD-1043 change-of-mind must be denied, so the contrast is visible', () => {
    const r = evaluateReturnEligibility(find('ORD-1043'), 'IT-1', 'changed-mind', POLICY_RULES, NOW);
    expect(r.eligible).toBe(false);
  });

  it('ORD-1102 is final sale in-window: denied for change of mind, allowed for defect', () => {
    expect(evaluateReturnEligibility(find('ORD-1102'), 'IT-2', 'changed-mind', POLICY_RULES, NOW).eligible).toBe(false);
    expect(evaluateReturnEligibility(find('ORD-1102'), 'IT-2', 'defect', POLICY_RULES, NOW)).toMatchObject({ path: 'warranty' });
  });

  it('ORD-1118 is undelivered', () => {
    expect(find('ORD-1118').deliveredAt).toBeNull();
  });

  it('every final-sale product is listed in POLICY_RULES, and vice versa', () => {
    const fromProducts = PRODUCTS.filter(p => p.finalSale).map(p => p.sku).sort();
    expect(fromProducts).toEqual([...POLICY_RULES.finalSaleSkus].sort());
  });
});
