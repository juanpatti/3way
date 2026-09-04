import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, scopeFor, withPiggyback, type DataSource } from '../src/tools';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Product, Tool } from '../src/types';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const ORDER: Order = {
  orderId: 'ORD-1043',
  placedAt: NOW - 40 * DAY,
  deliveredAt: NOW - 35 * DAY,
  status: 'delivered',
  items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900 }],
};

const PRODUCT: Product = {
  sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900, description: 'A lamp.', finalSale: false,
};

/** Undelivered, so it is the one an order change (cancel / redirect) can still apply to. */
const IN_TRANSIT: Order = {
  orderId: 'ORD-1118',
  placedAt: NOW - 2 * DAY,
  deliveredAt: null,
  status: 'in_transit',
  items: [{ itemId: 'IT-3', sku: 'SKU-STD-002', title: 'Sand Lamp', price: 9900 }],
};

const ORDERS = [ORDER, IN_TRANSIT];
const data: DataSource = {
  listOrders: async () => ORDERS,
  getOrder: async id => ORDERS.find(o => o.orderId === id) ?? null,
  searchProducts: async () => [PRODUCT],
  getProduct: async sku => (sku === PRODUCT.sku ? PRODUCT : null),
};

function fixture() {
  let t = NOW, n = 0;
  const bus = createBus({ now: () => t, id: () => `e${++n}` });
  let r = 0;
  const act = vi.fn(async () => ({ ok: true }));
  const tools = createTools({
    bus, data, act, now: () => NOW, newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
  });
  const byName = (name: string) => {
    const t = tools.find(x => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  };
  return { bus, tools, byName, act };
}

const CTX = { origin: 'agent-autonomous' as const, cursor: null };
const HUMAN_CTX = { origin: 'human-direct' as const, cursor: null };

describe('createTools', () => {
  it('registers every public tool in the registry', () => {
    const names = fixture().tools.map(t => t.name).sort();
    expect(names).toEqual([
      'await_reply', 'cancel_order', 'change_address', 'confirm_return', 'disclose_order_records',
      'evaluate_return_eligibility', 'get_conversation', 'get_order_status', 'get_policy',
      'get_product', 'list_my_orders', 'provide_context', 'request_address_change',
      'request_cancel', 'request_records_release', 'request_return', 'search_products',
      'send_message',
    ]);
  });

  it('marks read-only tools with readOnlyHint', () => {
    const { byName } = fixture();
    expect(byName('search_products').annotations?.readOnlyHint).toBe(true);
    expect(byName('confirm_return').annotations?.readOnlyHint).not.toBe(true);
  });

  it('send_message defaults to agent-autonomous', async () => {
    const { bus, byName } = fixture();
    await byName('send_message').execute({ text: 'hello' }, CTX);
    expect(bus.all().at(-1)).toMatchObject({ origin: 'agent-autonomous', text: 'hello' });
  });

  it('describes send_message as exchange participation without a removed voice feature', () => {
    const { byName } = fixture();
    expect(byName('send_message').description).toMatch(/shared exchange/i);
    expect(byName('send_message').description).not.toMatch(/voice|hear/i);
  });

  it('send_message stamps agent-relay when the agent declares it is relaying', async () => {
    const { bus, byName } = fixture();
    await byName('send_message').execute({ text: 'she wants a refund', intent: 'relay' }, CTX);
    expect(bus.all().at(-1)).toMatchObject({ origin: 'agent-relay' });
  });

  it('send_message CANNOT be used by the site agent to impersonate the visitor', async () => {
    const { bus, byName } = fixture();
    const before = bus.all().length;
    const r = await byName('send_message').execute(
      { text: 'hi' }, { origin: 'site-agent', cursor: null }) as any;
    expect(r.ok).toBe(false);
    expect(bus.all().length).toBe(before);
  });

  it('send_message CANNOT forge a human origin', async () => {
    const { bus, byName } = fixture();
    await byName('send_message').execute({ text: 'yes', intent: 'human-direct' }, CTX);
    expect(bus.all().at(-1)!.origin).not.toBe('human-direct');
  });

  it('provide_context lands on the log as structured context', async () => {
    const { bus, byName } = fixture();
    await byName('provide_context').execute(
      { summary: 'wants refund', data: { orderId: 'ORD-1043' } }, CTX);
    const last = bus.all().at(-1)!;
    expect(last.origin).toBe('agent-autonomous');
    expect(last.context).toMatchObject({ orderId: 'ORD-1043' });
  });

  it('provide_context CANNOT be used by the site agent to inject context as the visitor', async () => {
    const { bus, byName } = fixture();
    const before = bus.all().length;
    const r = await byName('provide_context').execute(
      { summary: 'hi' }, { origin: 'site-agent', cursor: null }) as any;
    expect(r.ok).toBe(false);
    expect(bus.all().length).toBe(before);
  });

  it('request_return returns a request id and the eligibility verdict', async () => {
    const { byName } = fixture();
    const r = await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX) as any;
    expect(r.requestId).toBe('req-1');
    expect(r.eligibility).toMatchObject({ eligible: true, path: 'warranty' });
  });

  it('confirm_return is REFUSED until the human confirms', async () => {
    const { byName } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    const r = await byName('confirm_return').execute({ requestId: 'req-1' }, CTX) as any;
    expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true });
  });

  it('confirm_return succeeds once a HARDWARE-VERIFIED confirmation is on the log', async () => {
    const { bus, byName } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes, refund it', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-1', at: 1 } });
    const r = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    expect(r).toMatchObject({ ok: true });
  });

  // The completion line is what actually plays back to a person; it must not be the
  // tool's own (long, agent-facing) description read aloud. `gated()` used to reuse the
  // description string for both purposes.
  it('the completion line logged to the transcript is a short status, not the tool description', async () => {
    const { bus, byName } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes, refund it', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-1', at: 1 } });
    await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX);
    const completionLine = bus.all().find(e => e.origin === 'site-agent')!;
    expect(completionLine.text).toBe('Return confirmed and refund issued. Completed for ORD-1043.');
    expect(completionLine.text).not.toContain('you cannot confirm on their behalf');
  });

  it('a confirmation minted for confirm_return cannot be redirected to authorize change_address', async () => {
    const { bus, byName } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);       // req-1, a return
    await byName('request_address_change').execute(
      { orderId: 'ORD-1118', address: '12 Newgate St' }, CTX);               // req-2, a redirect
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-1', at: 1 } });

    // Handing the return's id to change_address is now refused one step earlier than the
    // gate — on the KIND of request, before eligibility or confirmation is consulted at
    // all. Same conclusion, narrower door.
    const crossKind = await byName('change_address').execute({ requestId: 'req-1' }, CTX) as any;
    expect(crossKind).toMatchObject({ ok: false });
    expect(crossKind.needsHumanConfirmation).toBeUndefined();
    expect(crossKind.message).toMatch(/not an address change request/i);

    // And the original claim, tested where it actually bites: a real address-change
    // request exists, but the only confirmation on the log was minted for confirm_return,
    // so it authorizes nothing here.
    const redirected = await byName('change_address').execute({ requestId: 'req-2' }, CTX) as any;
    expect(redirected).toMatchObject({ ok: false, needsHumanConfirmation: true });

    const same = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    expect(same.ok).toBe(true);
  });

  it('confirm_return refuses to complete an ineligible request even once confirmed', async () => {
    const { bus, byName } = fixture();
    // Delivered 35 days ago; changed-mind is bound by the 30-day window, so this is denied.
    const request = await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'changed-mind' }, CTX) as any;
    expect(request.eligibility.eligible).toBe(false);
    bus.append({ origin: 'human-direct', text: 'yes, refund it', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-1', at: 1 } });
    const r = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    expect(r.ok).toBe(false);
    expect(bus.all().some(e => e.text.includes('Completed'))).toBe(false);
  });

  it('does not throw when the server resolves something other than a well-formed result', async () => {
    const { bus, byName, act } = fixture();
    act.mockResolvedValue(undefined as any);
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-1', at: 1 } });
    const r = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    expect(r.ok).toBe(false);
  });

  it('defers the real decision to the server and passes the token along', async () => {
    const { bus, byName, act } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-9', at: 1 } });
    await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX);
    // /api/act carries only tool/requestId/token now — the Worker re-derives eligibility
    // from the token record it wrote at /options time, not from anything sent here
    // (worker/src/index.ts's /api/act). The eligibility triple travels earlier, at the
    // ceremony's /options call (see session.ts's confirmRequest), never re-sent at act time.
    expect(act).toHaveBeenCalledWith('confirm_return', 'req-1', 'tok-9');
  });

  it('FAILS CLOSED when the server refuses, even though the local check passed', async () => {
    const { bus, byName, act } = fixture();
    act.mockResolvedValue({ ok: false, error: 'invalid_token' } as any);
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'stolen', at: 1 } });
    const r = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    expect(r.ok).toBe(false);
  });

  it('a completed request cannot execute twice; a second human call reads terminal status only', async () => {
    const { bus, byName, act } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 'tok-1', at: 1 } });
    const first = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    const second = await byName('confirm_return').execute({ requestId: 'req-1' }, HUMAN_CTX) as any;
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: true, terminal: true, outcome: 'completed', receiptStatus: 'unavailable',
    });
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('confirm_return REFUSES a bare human confirmation carrying no hardware proof', async () => {
    const { bus, byName } = fixture();
    await byName('request_return').execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX);
    bus.append({ origin: 'human-direct', text: 'yes, refund it', confirms: 'req-1' });
    const r = await byName('confirm_return').execute({ requestId: 'req-1' }, CTX) as any;
    expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true });
  });

  it('rejects confirming an unknown request without throwing', async () => {
    const { byName } = fixture();
    const r = await byName('confirm_return').execute({ requestId: 'nope' }, CTX) as any;
    expect(r.ok).toBe(false);
  });

  it('get_conversation reports origins so the agent can see who spoke', async () => {
    const { bus, byName } = fixture();
    bus.append({ origin: 'human-direct', text: 'hi' });
    const r = await byName('get_conversation').execute({}, CTX) as any;
    expect(r.entries).toEqual([{ origin: 'human-direct', text: 'hi', fromHuman: true }]);
  });
});

describe('scopeFor', () => {
  it('gives the visiting agent everything', () => {
    const { tools } = fixture();
    expect(scopeFor(tools, 'visiting-agent')).toHaveLength(tools.length);
  });

  it("withholds the visitor's conversation tools from the store's own agent", () => {
    const { tools } = fixture();
    const names = scopeFor(tools, 'site-agent').map(t => t.name);
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('provide_context');
    expect(names).toContain('evaluate_return_eligibility');
  });

  it('restricts an unrecognized consumer value instead of defaulting to full access', () => {
    const { tools } = fixture();
    const names = scopeFor(tools, 'bogus' as any).map(t => t.name);
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('provide_context');
    expect(names).toContain('evaluate_return_eligibility');
  });
});

describe('gate coverage', () => {
  it('every gated tool is listed in requiresHumanDirect, and vice versa', () => {
    const { tools } = fixture();
    const declared = [...POLICY_RULES.requiresHumanDirect].sort();
    const implemented = tools
      .filter(t => t.description.includes('consequential action'))
      .map(t => t.name).sort();
    expect(implemented).toEqual(declared);
  });

  /**
   * Each gated tool spends a request of its OWN kind — a return id can no longer stand in
   * for a cancellation, so the gate has to be reached through the matching filer. Keyed by
   * tool name so a new entry in requiresHumanDirect fails loudly here rather than being
   * silently skipped.
   */
  const FILE_REQUEST: Record<string, { tool: string; args: Record<string, unknown> }> = {
    confirm_return: { tool: 'request_return', args: { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' } },
    cancel_order: { tool: 'request_cancel', args: { orderId: 'ORD-1118' } },
    change_address: { tool: 'request_address_change', args: { orderId: 'ORD-1118', address: '12 Newgate St' } },
    disclose_order_records: { tool: 'request_records_release', args: { orderId: 'ORD-1043' } },
  };

  it.each(POLICY_RULES.requiresHumanDirect)(
    '%s is refused without a hardware-verified confirmation on the log',
    async (toolName) => {
      const { byName } = fixture();
      const filer = FILE_REQUEST[toolName];
      if (!filer) throw new Error(`no request filer known for gated tool ${toolName}`);
      const made = await byName(filer.tool).execute(filer.args, CTX) as any;
      expect(made).toMatchObject({ ok: true });
      const r = await byName(toolName).execute({ requestId: made.requestId }, CTX) as any;
      expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true });
    },
  );
});

describe('withPiggyback', () => {
  const run = (t: Tool) => t.execute({ query: 'lamp' }, CTX);

  it('appends unseen entries to every tool result', async () => {
    const { bus, tools } = fixture();
    const [search] = withPiggyback(tools.filter(t => t.name === 'search_products'), bus);
    bus.append({ origin: 'human-direct', text: 'anything blue?' });
    const r = await run(search!) as any;
    expect(r.room_since_last_call).toEqual([
      { origin: 'human-direct', text: 'anything blue?', fromHuman: true },
    ]);
  });

  it('does not repeat entries the caller has already been shown', async () => {
    const { bus, tools } = fixture();
    const [search] = withPiggyback(tools.filter(t => t.name === 'search_products'), bus);
    bus.append({ origin: 'human-direct', text: 'first' });
    await run(search!);
    const r = await run(search!) as any;
    expect(r.room_since_last_call).toEqual([]);
  });

  it('preserves the underlying tool result', async () => {
    const { bus, tools } = fixture();
    const [search] = withPiggyback(tools.filter(t => t.name === 'search_products'), bus);
    const r = await run(search!) as any;
    expect(r.products).toHaveLength(1);
  });
});

describe('request_return raises the confirm affordance', () => {
  function fixtureWithSpy() {
    let t = NOW, n = 0, r = 0;
    const bus = createBus({ now: () => t, id: () => `e${++n}` });
    const onConfirmationNeeded = vi.fn();
    const tools = createTools({
      bus, data, act: vi.fn(async () => ({ ok: true })), now: () => NOW,
      newRequestId: () => `req-${++r}`,
      policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
      onConfirmationNeeded,
    });
    const requestReturn = tools.find(x => x.name === 'request_return')!;
    return { requestReturn, onConfirmationNeeded };
  }

  // Observed live: an eligible warranty claim was filed by the visiting agent, the store
  // agent told the customer to confirm it themselves, and nothing on screen could be
  // confirmed — the modal had only ever been raised by a REFUSED gated call.
  it('raises it for an eligible request, bound to confirm_return, without waiting for a refused gated call', async () => {
    const { requestReturn, onConfirmationNeeded } = fixtureWithSpy();

    // 35 days after delivery: outside the standard window, but a defect is a warranty
    // claim and warranty is exempt from the window.
    const result = await requestReturn.execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX) as any;

    expect(result.eligibility.eligible).toBe(true);
    expect(onConfirmationNeeded).toHaveBeenCalledTimes(1);
    const [req, tool] = onConfirmationNeeded.mock.calls[0]!;
    expect(tool).toBe('confirm_return');
    expect(req).toMatchObject({ requestId: 'req-1', orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
  });

  it('stays silent for an ineligible request — a denied claim has nothing to confirm, and a confirmation over a refusal invites clicking past the policy', async () => {
    const { requestReturn, onConfirmationNeeded } = fixtureWithSpy();

    const result = await requestReturn.execute(
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'changed-mind' }, CTX) as any;

    expect(result.eligibility.eligible).toBe(false);
    expect(onConfirmationNeeded).not.toHaveBeenCalled();
  });
});
