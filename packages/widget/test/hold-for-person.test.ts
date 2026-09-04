import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, scopeFor, withPiggyback, DEFAULT_HOLD_MS, type DataSource } from '../src/tools';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Origin, Product } from '../src/types';

/**
 * The gate holds the line. Told in the agentHint to call await_reply after a refusal, a
 * real visiting agent ended its turn anyway: the person confirmed, the refund ran, and
 * nobody was listening. The instruction was a prompt. This is the mechanism it replaces
 * for the confirmation handoff: the gated call the agent already made does not return
 * its refusal until the person has acted or a bounded window has closed — so the agent
 * that asked "complete this return" is answered by that same call.
 *
 * Bounded by the same bet await_reply makes about runtime tool timeouts; see
 * DEFAULT_HOLD_MS. Off unless a caller opts in, which mount() does.
 */
const NOW = 1_700_000_000_000;
const ORDER: Order = {
  orderId: 'ORD-1043', placedAt: NOW, deliveredAt: NOW, status: 'delivered',
  items: [{ itemId: 'IT-1', sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900 }],
};
const PRODUCT: Product = {
  sku: 'SKU-STD-001', title: 'Blue Lamp', price: 9900, description: 'A lamp.', finalSale: false,
};
const data: DataSource = {
  listOrders: async () => [ORDER],
  getOrder: async () => ORDER,
  searchProducts: async () => [PRODUCT],
  getProduct: async () => PRODUCT,
};
const tick = (ms: number) => new Promise(r => setTimeout(r, ms));
const CONFIRM = (requestId: string) => ({
  origin: 'human-direct' as const, text: 'Yes, I confirm.', confirms: requestId,
  confirmsTool: 'confirm_return', verification: { method: 'webauthn' as const, token: 'tok', at: 1 },
});

function fixture(opts: { holdMs?: number } = {}) {
  let n = 0, r = 0;
  const bus = createBus({ now: () => Date.now(), id: () => `e${++n}` });
  const act = vi.fn(async () => ({ ok: true, data: { refunded: true } }));
  const onHold = vi.fn();
  const tools = createTools({
    bus, data, act, now: () => Date.now(), newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES }, holdMs: opts.holdMs, onHold,
  });
  const agentTools = withPiggyback(scopeFor(tools, 'visiting-agent'), bus);
  const call = (name: string, input: Record<string, unknown> = {}) =>
    agentTools.find(x => x.name === name)!.execute(input, { origin: 'agent-autonomous', cursor: null }) as Promise<any>;
  const raw = (name: string, origin: Origin, input: Record<string, unknown> = {}) =>
    tools.find(x => x.name === name)!.execute(input, { origin, cursor: null }) as Promise<any>;
  const file = async () => (await call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' })).requestId as string;
  /** The person's path, as index.ts runs it after a successful ceremony. */
  const personConfirms = async (requestId: string) => {
    bus.append(CONFIRM(requestId));
    return raw('confirm_return', 'human-direct', { requestId });
  };
  return { bus, tools, call, raw, file, personConfirms, act, onHold };
}

describe('a refused gated call holds the line for the visiting agent', () => {
  it('does not return until the person has confirmed, then returns the completed receipt', async () => {
    const { call, file, personConfirms, act, onHold, bus } = fixture({ holdMs: 3000 });
    const requestId = await file();
    const parked = call('confirm_return', { requestId });
    let settled = false;
    void parked.then(() => { settled = true; });
    await tick(30);
    expect(settled).toBe(false);
    expect(onHold).toHaveBeenCalledWith(requestId, 'confirm_return');
    // Consent alone is not the outcome. The ceremony records it; the action still has to
    // run, and the hold waits for THAT — a call resumed on the confirmation entry would
    // find no receipt yet and hand back "still completing".
    bus.append(CONFIRM(requestId));
    await tick(10);
    expect(settled).toBe(false);
    await personConfirms(requestId);
    const r = await parked;
    expect(r).toMatchObject({ ok: true, terminal: true, outcome: 'completed', requestId, refunded: true });
    // The held call never became a second executor.
    expect(act).toHaveBeenCalledTimes(1);
    // Everything said during the wait rides back with it, completion line included.
    const texts = r.room_since_last_call.map((e: any) => e.text);
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringMatching(/Yes, I confirm/), expect.stringMatching(/Completed for ORD-1043/),
    ]));
    // Receipt accounting is unchanged: the hold's return was delivery one of two.
    expect(await call('confirm_return', { requestId })).toMatchObject({ ok: true, outcome: 'completed', refunded: true });
    expect(await call('confirm_return', { requestId })).toMatchObject({ terminal: true, receiptStatus: 'consumed' });
  });

  it('returns at once when the person says something other than yes, and says so', async () => {
    const { call, file, bus, act } = fixture({ holdMs: 3000 });
    const requestId = await file();
    const parked = call('confirm_return', { requestId });
    await tick(20);
    bus.append({ origin: 'human-direct', text: 'Wait — which order is this?' });
    const r = await parked;
    expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true, requestId });
    expect(r.agentHint).toMatch(/said something instead of confirming/);
    expect(r.agentHint).toMatch(/room_since_last_call/);
    expect(r.room_since_last_call.map((e: any) => e.text)).toContain('Wait — which order is this?');
    expect(act).not.toHaveBeenCalled();
  });

  it('is not woken by the store agent or by a confirmation of another request; the window then closes', async () => {
    const { call, file, bus } = fixture({ holdMs: 1000 });
    const requestId = await file();
    const parked = call('confirm_return', { requestId });
    let settled = false;
    void parked.then(() => { settled = true; });
    await tick(20);
    bus.append({ origin: 'site-agent', text: 'I can see the return is filed.' });
    bus.append(CONFIRM('req-someone-else'));
    await tick(80);
    expect(settled).toBe(false);
    const r = await parked;
    expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true, requestId });
    expect(r.agentHint).toMatch(/Waited 1s/);
    expect(r.agentHint).toMatch(/Call confirm_return again with the same requestId/);
    expect(r.agentHint).toMatch(/Do not end your turn/);
    // The chatter it ignored still arrives, on the ordinary channel.
    expect(r.room_since_last_call.map((e: any) => e.text)).toContain('I can see the return is filed.');
  });

  it('holds a poll made after consent but before the action ran, until the receipt exists', async () => {
    const { call, file, raw, bus } = fixture({ holdMs: 3000 });
    const requestId = await file();
    bus.append(CONFIRM(requestId));
    // Gate satisfied, nothing spent yet: today's answer is "still completing". Held instead.
    const parked = call('confirm_return', { requestId });
    let settled = false;
    void parked.then(() => { settled = true; });
    await tick(30);
    expect(settled).toBe(false);
    await raw('confirm_return', 'human-direct', { requestId });
    expect(await parked).toMatchObject({ ok: true, terminal: true, outcome: 'completed' });
  });

  it('keeps one hold per request: a newer call takes over and the older one is told so', async () => {
    const { call, file, personConfirms } = fixture({ holdMs: 3000 });
    const requestId = await file();
    const first = call('confirm_return', { requestId });
    await tick(20);
    const second = call('confirm_return', { requestId });
    const r1 = await first;
    expect(r1).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(r1.agentHint).toMatch(/newer call for this request took over/);
    await personConfirms(requestId);
    // Only the surviving hold read the receipt, so the retry delivery is intact.
    expect(await second).toMatchObject({ ok: true, outcome: 'completed', refunded: true });
    expect(await call('confirm_return', { requestId })).toMatchObject({ ok: true, outcome: 'completed', refunded: true });
    expect(await call('confirm_return', { requestId })).toMatchObject({ receiptStatus: 'consumed' });
  });

  it('never holds the store agent, the human path, or a gateway that did not opt in', async () => {
    const withHold = fixture({ holdMs: 3000 });
    const requestId = await withHold.file();
    let t0 = Date.now();
    const site = await withHold.raw('confirm_return', 'site-agent', { requestId });
    expect(site).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(Date.now() - t0).toBeLessThan(500);
    t0 = Date.now();
    const human = await withHold.raw('confirm_return', 'human-direct', { requestId });
    expect(human).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(Date.now() - t0).toBeLessThan(500);

    // Off by default: a hand-built registry answers at once, as every other test expects.
    const plain = fixture();
    const id2 = await plain.file();
    t0 = Date.now();
    const r = await plain.call('confirm_return', { requestId: id2 });
    expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(r.agentHint).toMatch(/await_reply/);
    expect(Date.now() - t0).toBeLessThan(500);
    expect(plain.onHold).not.toHaveBeenCalled();
  });

  it('resolves a live hold when the gateway is destroyed, rather than leaving it parked', async () => {
    const { call, file, tools } = fixture({ holdMs: 3000 });
    const requestId = await file();
    const parked = call('confirm_return', { requestId });
    await tick(20);
    tools.destroy();
    const t0 = Date.now();
    const r = await parked;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.ok).toBe(false);
  });

  it('is the same bound await_reply uses', () => {
    expect(DEFAULT_HOLD_MS).toBe(25_000);
  });
});
