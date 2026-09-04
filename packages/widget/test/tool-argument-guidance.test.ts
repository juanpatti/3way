import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, type DataSource } from '../src/tools';
import { buildSystemPrompt } from '../src/prompt';
import { DEFAULT_STANCES } from '../src/stances';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Product } from '../src/types';

/**
 * Observed live on the deployed demo, failing differently in two runs. Both are the store
 * agent choosing bad ARGUMENTS for a
 * tool that itself behaved correctly:
 *
 *   1. "cracked base" → reason 'damaged-in-transit' rather than 'defect'. That verdict is
 *      denied (transit damage is bound by the window, a defect is exempt), so the agent
 *      told the customer their claim was refused while request_return was concurrently
 *      returning warranty/eligible. Two independent callers must reach the SAME verdict
 *      from the same deterministic function; opposite verdicts would be incorrect.
 *   2. itemId set to a SKU or a product title instead of 'IT-1', without calling
 *      get_order_status first — so the customer was told their lamp "isn't recognized as
 *      part of order ORD-1043".
 *
 * Neither is fixable in the eligibility engine: it was asked a different question and
 * answered it correctly both times. The fix is the two places that tell a model what to
 * pass — the tool schema descriptions (read by BOTH agents) and the store agent's system
 * prompt — so these assertions pin the guidance itself.
 */

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const ORDER: Order = {
  orderId: 'ORD-1043', placedAt: NOW - 40 * DAY, deliveredAt: NOW - 35 * DAY,
  status: 'delivered',
  items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900 }],
};
const PRODUCT: Product = {
  sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900, description: 'A lamp.', finalSale: false,
};
const data: DataSource = {
  listOrders: async () => [ORDER],
  getOrder: async id => (id === ORDER.orderId ? ORDER : null),
  searchProducts: async () => [PRODUCT],
  getProduct: async () => PRODUCT,
};

function byName(name: string) {
  let n = 0, r = 0;
  const tools = createTools({
    bus: createBus({ now: () => NOW, id: () => `e${++n}` }),
    data, act: vi.fn(async () => ({ ok: true })),
    now: () => NOW, newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
  });
  const t = tools.find(x => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

const props = (name: string) =>
  (byName(name).inputSchema as any).properties as Record<string, { description?: string }>;

describe('the itemId argument says where to get it, and what it is not', () => {
  it.each(['evaluate_return_eligibility', 'request_return'])(
    "%s's itemId names its source tool and rules out the SKU and the title", (tool) => {
      const d = props(tool).itemId?.description ?? '';
      expect(d).toMatch(/IT-1/);                    // shows the shape, not just describes it
      expect(d).toMatch(/get_order_status|list_my_orders/);
      expect(d).toMatch(/\bnot\b.*\bSKU\b/i);
      expect(d).toMatch(/title/i);
    });
});

describe('the reason argument distinguishes a defect from transit damage', () => {
  it.each(['evaluate_return_eligibility', 'request_return'])(
    "%s's reason enum explains when each code applies", (tool) => {
      const d = props(tool).reason?.description ?? '';
      // A fault in the item is a defect;
      // transit damage needs evidence the courier caused it.
      expect(d).toMatch(/defect/);
      expect(d).toMatch(/damaged-in-transit/);
      expect(d).toMatch(/packaging|parcel|courier|shipping/i);
      expect(d).toMatch(/wrong-item/);
      expect(d).toMatch(/changed-mind/);
    });

  it('still advertises exactly the four codes the engine accepts', () => {
    for (const tool of ['evaluate_return_eligibility', 'request_return']) {
      expect(props(tool).reason).toMatchObject({
        enum: ['defect', 'changed-mind', 'wrong-item', 'damaged-in-transit'],
      });
    }
  });
});

describe('the store agent is told how to pick arguments, not just which tool to call', () => {
  const prompt = () =>
    buildSystemPrompt('policy-bound', { prose: POLICY_PROSE, rules: POLICY_RULES },
      DEFAULT_STANCES, 'Alex Rivera');

  it('tells it to resolve the order and item before judging eligibility', () => {
    expect(prompt()).toMatch(/get_order_status|list_my_orders/);
    expect(prompt()).toMatch(/itemId/);
  });

  it('gives the defect-versus-transit-damage rule explicitly', () => {
    const p = prompt();
    expect(p).toMatch(/defect/i);
    expect(p).toMatch(/damaged-in-transit/);
    // The specific trap: absent evidence of a shipping incident, a broken item is a defect.
    expect(p).toMatch(/shipping incident|the parcel|packaging|courier/i);
  });

  it('tells it that a bad argument is its own mistake, not the customer\'s problem', () => {
    // Failure 2 was not just the wrong itemId — it was relaying the resulting
    // "not part of order" back to the customer as though their order were wrong.
    expect(prompt()).toMatch(/not part of order/i);
    expect(prompt()).toMatch(/never relay it to\s+them|mistake in your call/i);
  });
});


/**
 * Observed live on the deployed site. The customer said "the blue lamp from
 * last month arrived with a cracked base" and the store agent replied "Could you share the
 * order number or any other details you have on hand?" — while list_my_orders sat there
 * taking no arguments and already scoped to the signed-in session.
 *
 * If the store agent asks a clarifying question before calling list_my_orders, the
 * exchange needs a retry. Earlier text interactions masked it, because the visiting agent
 * always called provide_context first and handed the order over. A bare human turn exposed it.
 *
 * The prompt described who is speaking, how to judge eligibility and what the agent
 * cannot do, but never that it already knows who the customer is.
 */
describe('the store agent looks the customer up instead of interrogating them', () => {
  const prompt = () =>
    buildSystemPrompt('policy-bound', { prose: POLICY_PROSE, rules: POLICY_RULES },
      DEFAULT_STANCES, 'Alex Rivera');

  it('says the customer is signed in and their orders are already readable', () => {
    const p = prompt();
    expect(p).toMatch(/signed in/i);
    expect(p).toMatch(/list_my_orders takes no\s+arguments/i);
  });

  it('rules out the three questions the store agent must never ask', () => {
    const p = prompt();
    expect(p).toMatch(/do not ask for an order\s+number/i);
    expect(p).toMatch(/email/i);
    expect(p).toMatch(/confirm who they are/i);
  });

  it('tells it to resolve a vague reference rather than hand the work back', () => {
    const p = prompt();
    expect(p).toMatch(/blue lamp from last month/i);
    expect(p).toMatch(/say which order you\s+landed on/i);
  });

  it('still permits asking for something genuinely not in the data', () => {
    expect(prompt()).toMatch(/box itself was damaged|genuinely not in the data/i);
  });
});
