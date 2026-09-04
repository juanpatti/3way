import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, scopeFor, withPiggyback, type DataSource } from '../src/tools';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Product } from '../src/types';

/**
 * WebMCP is pull-only. A page cannot tell a visiting agent that anything happened, so
 * after the agent says something, the reply lands in the conversation and the agent does
 * not see it until its next call — and if it ended its turn, there is no next call. The
 * dead moment this exists for is the confirmation: the agent hands off to the person,
 * they touch the sensor, the refund completes, and the agent never learns it worked.
 *
 * await_reply is the workaround the API permits rather than a fix. A tool call is a
 * question the page answers whenever it likes, so "answer when there is news" is legal —
 * it is long-polling, which is how push worked on the web before WebSockets. What it
 * CANNOT do is wake an agent that did not choose to wait, leaving a residual platform
 * limitation that requires a future notification mechanism.
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

function fixture() {
  let n = 0, r = 0;
  const bus = createBus({ now: () => Date.now(), id: () => `e${++n}` });
  const tools = createTools({
    bus, data, act: vi.fn(async () => ({ ok: true })),
    now: () => Date.now(), newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
  });
  // The agent's real view: scoped, and piggybacked so the cursor exists.
  const agentTools = withPiggyback(scopeFor(tools, 'visiting-agent'), bus);
  const call = (name: string, input: Record<string, unknown> = {}) => {
    const t = agentTools.find(x => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.execute(input, { origin: 'agent-autonomous', cursor: null }) as Promise<any>;
  };
  return { bus, tools, call };
}

describe('await_reply returns as soon as anything is said', () => {
  it('resolves when a reply lands, not when the timeout expires', async () => {
    const { bus, call } = fixture();
    const waiting = call('await_reply', { timeout_ms: 5000 });
    // Nothing has happened yet; the call is genuinely parked.
    let settled = false;
    void waiting.then(() => { settled = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(settled).toBe(false);

    bus.append({ origin: 'site-agent', text: 'Yes, that is a warranty claim.' });
    const r = await waiting;
    expect(r.nothing_new).toBe(false);
    expect(r.waited_ms).toBeLessThan(5000);
    // The content rides back the same way every other tool's does.
    expect(r.room_since_last_call.map((e: any) => e.text))
      .toContain('Yes, that is a warranty claim.');
  });

  it('delivers a confirmation the person made at the sensor — the dead moment it exists for', async () => {
    const { bus, call } = fixture();
    const waiting = call('await_reply', { timeout_ms: 5000 });
    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method: 'webauthn', token: 't', at: NOW },
    });
    const r = await waiting;
    expect(r.nothing_new).toBe(false);
    expect(r.room_since_last_call.some((e: any) => e.fromHuman)).toBe(true);
  });

  it('returns immediately when the caller is ALREADY behind', async () => {
    // Waiting for the NEXT entry while an unseen one sits there would stall for the whole
    // timeout and then deliver stale news — the bug this tool exists to prevent.
    const { bus, call } = fixture();
    bus.append({ origin: 'site-agent', text: 'said before you asked' });
    const r = await call('await_reply', { timeout_ms: 5000 });
    expect(r).toMatchObject({ waited_ms: 0, nothing_new: false });
    expect(r.room_since_last_call.map((e: any) => e.text)).toContain('said before you asked');
  });
});

describe('await_reply gives up on its own terms', () => {
  it('reports nothing_new rather than hanging forever', async () => {
    const { call } = fixture();
    const r = await call('await_reply', { timeout_ms: 1000 });
    expect(r).toMatchObject({ nothing_new: true });
    expect(r.waited_ms).toBeGreaterThanOrEqual(900);
    expect(r.room_since_last_call).toEqual([]);
  });

  it('clamps a caller-supplied timeout instead of trusting it', async () => {
    const { call } = fixture();
    // Below the floor: clamped up to 1s, so this resolves near 1000ms, not instantly.
    const started = Date.now();
    const r = await call('await_reply', { timeout_ms: 5 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(r.nothing_new).toBe(true);
  });

  it('survives a nonsense timeout by falling back to the default rather than throwing', async () => {
    // Garbage falls back to the 25s default, so this is resolved by an append rather than
    // by waiting it out — the point is that a bad argument does not throw or hang forever.
    const { bus, call } = fixture();
    const waiting = call('await_reply', { timeout_ms: 'soon' as unknown as number });
    bus.append({ origin: 'site-agent', text: 'anything' });
    const r = await waiting;
    expect(r.nothing_new).toBe(false);
  });
});

describe('await_reply cannot be used as a lever', () => {
  it('is read-only and is not a gated action', () => {
    const { tools } = fixture();
    const t = tools.find(x => x.name === 'await_reply')!;
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(POLICY_RULES.requiresHumanDirect).not.toContain('await_reply');
  });

  it('appends nothing to the conversation, whether it times out or not', async () => {
    const { bus, call } = fixture();
    const before = bus.all().length;
    await call('await_reply', { timeout_ms: 1000 });
    expect(bus.all().length).toBe(before);
  });

  it('does not delay or interfere with a gated call made while it is parked', async () => {
    const { bus, call } = fixture();
    const parked = call('await_reply', { timeout_ms: 5000 });
    const made = await call('request_return',
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    const blocked = await call('confirm_return', { requestId: made.requestId });
    expect(blocked).toMatchObject({ ok: false, needsHumanConfirmation: true });
    bus.append({ origin: 'site-agent', text: 'done' });
    await parked;
  });

  it('leaves no subscriber behind — a page that waits often must not accumulate them', async () => {
    const { bus, call } = fixture();
    for (let i = 0; i < 5; i++) {
      const w = call('await_reply', { timeout_ms: 5000 });
      bus.append({ origin: 'site-agent', text: `turn ${i}` });
      await w;
    }
    // If each wait leaked its subscriber, this append would reach five dead listeners.
    // The observable proxy: appending still works and nothing throws into the bus.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.append({ origin: 'site-agent', text: 'after' });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the store agent never gets it', () => {
  it('is scoped away, because it is already pushed to and would stall its own turn', () => {
    const { tools } = fixture();
    expect(scopeFor(tools, 'site-agent').map(t => t.name)).not.toContain('await_reply');
    expect(scopeFor(tools, 'visiting-agent').map(t => t.name)).toContain('await_reply');
  });
});

describe('the agent is told about it where the advice is actionable', () => {
  it('send_message hints at it, because a reply is obviously coming', async () => {
    const { call } = fixture();
    const r = await call('send_message', { text: 'is this covered?' });
    expect(r.hint).toMatch(/await_reply/);
  });

  it('a refused gated call hints at it — the moment the agent would otherwise go quiet', async () => {
    const { call } = fixture();
    const made = await call('request_return',
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    const blocked = await call('confirm_return', { requestId: made.requestId });
    // Two audiences stay separate: the human is told to confirm,
    // the agent is told how to find out when they have. Neither leaks into the other.
    expect(blocked.agentHint).toMatch(/await_reply/);
    expect(blocked.agentHint).toMatch(/nothing is pushed to you/i);
    expect(blocked.message).toMatch(/confirm it in person/i);
    expect(blocked.message).not.toMatch(/await_reply/);
  });
});

/**
 * requestId is opaque and site-local,
 * so an agent in two conversations at once sees two indistinguishable `req-...` strings.
 * Nothing was exploitable — the other site answers "no pending request" — but neither the
 * agent nor anyone reading a transcript could tell them apart. The pair (origin,
 * requestId) is the identifier; origin is a separate field rather than a prefix baked
 * into the id, because the id is echoed into human-facing text and run through
 * sanitizeRequestId, which would silently eat the dots in a hostname.
 */
describe('a refusal says which site it came from', () => {
  const build = (siteOrigin?: string) => {
    let n = 0, r = 0;
    const bus = createBus({ now: () => Date.now(), id: () => `e${++n}` });
    const tools = createTools({
      bus, data, act: vi.fn(async () => ({ ok: true })),
      now: () => Date.now(), newRequestId: () => `req-${++r}`,
      policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
      siteOrigin,
    });
    const call = (name: string, input: Record<string, unknown> = {}) =>
      tools.find(t => t.name === name)!.execute(input, { origin: 'agent-autonomous', cursor: null }) as Promise<any>;
    return { call };
  };

  it('stamps the origin on a gated refusal', async () => {
    const { call } = build('https://halden-3way.pages.dev');
    const made = await call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    const blocked = await call('confirm_return', { requestId: made.requestId });
    expect(blocked).toMatchObject({
      needsHumanConfirmation: true, origin: 'https://halden-3way.pages.dev',
    });
  });

  it('lets two sites be told apart on the same requestId', async () => {
    const a = build('https://halden-3way.pages.dev');
    const b = build('https://second.example');
    const mkBlocked = async (s: ReturnType<typeof build>) => {
      const made = await s.call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
      return s.call('confirm_return', { requestId: made.requestId });
    };
    const [ra, rb] = [await mkBlocked(a), await mkBlocked(b)];
    // Same opaque id from both — which is exactly the confusion this closes.
    expect(ra.requestId).toBe(rb.requestId);
    expect(ra.origin).not.toBe(rb.origin);
  });

  it('leaves the requestId itself untouched, so it survives sanitisation unchanged', async () => {
    const { call } = build('https://halden-3way.pages.dev');
    const made = await call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    const blocked = await call('confirm_return', { requestId: made.requestId });
    expect(blocked.requestId).toBe(made.requestId);
    expect(blocked.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(blocked.message).toContain(made.requestId);
  });

  it('omits the field entirely when no origin is configured, rather than emitting undefined', async () => {
    const { call } = build();
    const made = await call('request_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
    const blocked = await call('confirm_return', { requestId: made.requestId });
    expect('origin' in blocked).toBe(false);
  });
});
