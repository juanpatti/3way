import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createTools, type DataSource } from '../src/tools';
import { evaluateRecordsRelease } from '../src/eligibility';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import type { Order, Product } from '../src/types';

/**
 * The gated action that moves no money.
 *
 * Every other consequential path in this demo ends in a refund, which invites a viewer to
 * file the whole thing under "shopping." Releasing the customer's own records — card type
 * and last four, billing postcode, delivery address — is the same gate applied to
 * disclosure, and it is the one that generalises: healthcare records, benefits, anything
 * where the only real question is whether a person was present and agreed.
 *
 * The browser half is here. The half that matters most is in
 * worker/test/disclose-records.test.ts: the values live server-side and are returned only
 * against a spent token bound to this order, so there is nothing in this page to read
 * without the customer present.
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

const RECORDS = {
  paymentBrand: 'Visa', paymentLast4: '6411', billingPostcode: 'N1 7QT',
  deliveredTo: '14 Ashfield Road, London',
};
const SENSITIVE_RECORD_PATTERN = /6411|N1 7QT|14 Ashfield Road/;

function fixture(now: () => number = () => NOW) {
  let n = 0, r = 0;
  const bus = createBus({ now, id: () => `e${++n}` });
  const act = vi.fn(async () => ({ ok: true, data: { records: RECORDS } }));
  const raised: Array<{ requestId: string; tool: string }> = [];
  const tools = createTools({
    bus, data, act, now, newRequestId: () => `req-${++r}`,
    policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
    onConfirmationNeeded: (req, tool) => { raised.push({ requestId: req.requestId, tool }); },
    siteOrigin: 'https://shop.test',
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
const confirm = (bus: ReturnType<typeof createBus>, requestId: string) =>
  bus.append({
    origin: 'human-direct', text: 'Yes, I confirm.', confirms: requestId,
    confirmsTool: 'disclose_order_records',
    verification: { method: 'webauthn', token: 'tok-1', at: NOW },
  });

describe('evaluateRecordsRelease', () => {
  it('names what is about to be disclosed, because that clause IS the consent prompt', () => {
    const r = evaluateRecordsRelease(ORDER);
    expect(r).toMatchObject({ eligible: true, path: 'disclosure' });
    // modal.ts renders because.at(-1) — so the last clause is the sentence the person
    // reads before touching the sensor. It has to say what they are agreeing to.
    const shown = r.because.at(-1)!;
    expect(shown).toMatch(/last four digits/i);
    expect(shown).toMatch(/billing postcode/i);
    expect(shown).toMatch(/delivery address/i);
    expect(shown).toMatch(/no full card number/i);
  });
});

describe('request_records_release', () => {
  it('discloses nothing by itself, and raises the confirm affordance', async () => {
    const { byName, raised } = fixture();
    const r = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    expect(r).toMatchObject({ ok: true, requestId: 'req-1' });
    expect(JSON.stringify(r)).not.toMatch(/6411|paymentLast4/);
    expect(raised).toEqual([{ requestId: 'req-1', tool: 'disclose_order_records' }]);
  });

  it('refuses an unknown order', async () => {
    const r = await fixture().byName('request_records_release')
      .execute({ orderId: 'NOPE' }, CTX) as any;
    expect(r).toMatchObject({ ok: false });
  });
});

describe('disclose_order_records', () => {
  it('is refused before a confirmation, and never reaches the server', async () => {
    const { byName, act } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    const r = await byName('disclose_order_records').execute({ requestId: made.requestId }, CTX) as any;
    expect(r).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(act).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toMatch(/6411/);
    expect(r.agentHint).toMatch(/disclose_order_records/);
    expect(r.agentHint).toMatch(/same requestId/i);
  });

  it('surfaces the records the server returned, once confirmed', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    const r = await byName('disclose_order_records').execute(
      { requestId: made.requestId }, HUMAN_CTX) as any;
    expect(r).toMatchObject({ ok: true, orderId: 'ORD-1043', records: RECORDS });
    expect(act).toHaveBeenCalledWith('disclose_order_records', made.requestId, 'tok-1');
  });

  it('retains a filing agent receipt for one lost delivery, then leaves a payload-free consumed tombstone', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);

    const shownToPerson = await byName('disclose_order_records').execute(
      { requestId: made.requestId }, { origin: 'human-direct', cursor: null }) as any;
    expect(shownToPerson.records).toEqual(RECORDS);

    // A different consumer cannot drain or observe the receipt. It is keyed to the
    // consumer that filed the request, not merely to the guessable request id.
    const wrongConsumer = await byName('disclose_order_records').execute(
      { requestId: made.requestId }, { origin: 'site-agent', cursor: null }) as any;
    expect(wrongConsumer.records).toBeUndefined();

    const firstDelivery = await byName('disclose_order_records').execute(
      { requestId: made.requestId }, CTX) as any;
    expect(firstDelivery.records).toEqual(RECORDS);
    const retryAfterLostDelivery = await byName('disclose_order_records').execute(
      { requestId: made.requestId }, CTX) as any;
    expect(retryAfterLostDelivery.records).toEqual(RECORDS);
    const consumed = await byName('disclose_order_records').execute(
      { requestId: made.requestId }, CTX) as any;
    expect(consumed).toMatchObject({
      ok: true, terminal: true, outcome: 'completed', receiptStatus: 'consumed',
      origin: 'https://shop.test', requestId: made.requestId,
    });
    expect(consumed.records).toBeUndefined();
    expect(JSON.stringify(consumed)).not.toMatch(SENSITIVE_RECORD_PATTERN);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('keeps a site-agent receipt out of the visiting consumer in the opposite direction too', async () => {
    const { byName, bus, act } = fixture();
    const siteContext = { origin: 'site-agent' as const, cursor: null };
    const made = await byName('request_records_release')
      .execute({ orderId: 'ORD-1043' }, siteContext) as any;
    confirm(bus, made.requestId);
    await byName('disclose_order_records').execute({ requestId: made.requestId }, HUMAN_CTX);

    const visiting = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(visiting.records).toBeUndefined();
    const siteReceipt = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, siteContext) as any;
    expect(siteReceipt.records).toEqual(RECORDS);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('keeps agents out of execution and gives the filing agent the completed terminal result', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    const premature = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(premature).toMatchObject({
      ok: false, awaitingHumanExecution: true, terminal: false,
      origin: 'https://shop.test', requestId: made.requestId,
    });
    expect(premature.agentHint).toMatch(/poll|terminal/i);
    expect(premature.records).toBeUndefined();
    expect(act).not.toHaveBeenCalled();

    const cursor = bus.all().at(-1)!.id;
    const waiting = byName('await_reply').execute(
      { timeout_ms: 1000 }, { origin: 'agent-autonomous', cursor }) as Promise<any>;
    let finish!: (value: { ok: true; data: { records: typeof RECORDS } }) => void;
    act.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));

    const humanCompletion = byName('disclose_order_records')
      .execute({ requestId: made.requestId }, HUMAN_CTX) as Promise<any>;
    await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));

    const raced = await byName('disclose_order_records').execute({ requestId: made.requestId }, CTX) as any;
    expect(raced).toMatchObject({
      ok: false, awaitingHumanExecution: true, terminal: false,
      origin: 'https://shop.test', requestId: made.requestId,
    });
    expect(raced.agentHint).toMatch(/poll|terminal/i);
    expect(raced.records).toBeUndefined();
    expect(act).toHaveBeenCalledTimes(1);

    finish({ ok: true, data: { records: RECORDS } });
    await expect(humanCompletion).resolves.toMatchObject({ ok: true, records: RECORDS });
    await expect(waiting).resolves.toMatchObject({ nothing_new: false });
    const filingView = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(filingView).toMatchObject({
      ok: true, terminal: true, outcome: 'completed', origin: 'https://shop.test',
      requestId: made.requestId, records: RECORDS,
    });
    expect(bus.all().at(-1)!.text).not.toMatch(SENSITIVE_RECORD_PATTERN);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('wakes await_reply and gives the filing agent a definitive refusal terminal result', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    const cursor = bus.all().at(-1)!.id;
    const waiting = byName('await_reply').execute(
      { timeout_ms: 1000 }, { origin: 'agent-autonomous', cursor }) as Promise<any>;
    (act as any).mockResolvedValueOnce({ ok: false, error: 'invalid_token' });

    await expect(byName('disclose_order_records').execute(
      { requestId: made.requestId }, HUMAN_CTX)).resolves.toMatchObject({
        ok: false, terminal: true, outcome: 'refused',
      });
    await expect(waiting).resolves.toMatchObject({ nothing_new: false });
    const filingView = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(filingView).toMatchObject({
      ok: false, terminal: true, outcome: 'refused', origin: 'https://shop.test',
      requestId: made.requestId,
    });
    expect(filingView.message).toMatch(/refused by the server/i);
    expect(JSON.stringify(bus.all().at(-1))).not.toMatch(/6411|invalid_token/);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('wakes await_reply and gives the filing agent an indeterminate terminal result after a lost response', async () => {
    const { byName, bus, act } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    const cursor = bus.all().at(-1)!.id;
    const waiting = byName('await_reply').execute(
      { timeout_ms: 1000 }, { origin: 'agent-autonomous', cursor }) as Promise<any>;
    act.mockRejectedValueOnce(new Error('response lost'));

    await expect(byName('disclose_order_records').execute(
      { requestId: made.requestId }, HUMAN_CTX)).resolves.toMatchObject({
        ok: false, terminal: true, outcome: 'indeterminate',
      });
    await expect(waiting).resolves.toMatchObject({ nothing_new: false });
    const filingView = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(filingView).toMatchObject({
      ok: false, terminal: true, outcome: 'indeterminate', origin: 'https://shop.test',
      requestId: made.requestId,
    });
    expect(filingView.message).toMatch(/may or may not have gone through/i);
    expect(filingView.agentHint).toMatch(/do not retry/i);
    expect(JSON.stringify(bus.all().at(-1))).not.toMatch(/6411|response lost/);
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('expires an unread payload but retains a non-sensitive terminal tombstone', async () => {
    let clock = NOW;
    const { byName, bus } = fixture(() => clock);
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    await byName('disclose_order_records').execute({ requestId: made.requestId }, HUMAN_CTX);

    clock += 5 * 60_000 + 1;
    const expired = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(expired).toMatchObject({
      ok: true, terminal: true, outcome: 'completed', receiptStatus: 'expired',
      origin: 'https://shop.test', requestId: made.requestId,
    });
    expect(expired.records).toBeUndefined();
    expect(JSON.stringify(expired)).not.toMatch(SENSITIVE_RECORD_PATTERN);
  });

  it('caps sensitive receipts and leaves an evicted terminal tombstone for the oldest request', async () => {
    const { byName, bus, act } = fixture();
    const requestIds: string[] = [];
    for (let i = 0; i < 65; i++) {
      const made = await byName('request_records_release')
        .execute({ orderId: 'ORD-1043' }, CTX) as any;
      requestIds.push(made.requestId);
      confirm(bus, made.requestId);
      await byName('disclose_order_records').execute({ requestId: made.requestId }, HUMAN_CTX);
    }

    const oldest = await byName('disclose_order_records')
      .execute({ requestId: requestIds[0] }, CTX) as any;
    expect(oldest).toMatchObject({
      ok: true, terminal: true, outcome: 'completed', receiptStatus: 'evicted',
      origin: 'https://shop.test', requestId: requestIds[0],
    });
    expect(oldest.records).toBeUndefined();
    expect(JSON.stringify(oldest)).not.toMatch(SENSITIVE_RECORD_PATTERN);
    await expect(byName('disclose_order_records').execute(
      { requestId: requestIds.at(-1)! }, CTX)).resolves.toMatchObject({ records: RECORDS });
    expect(act).toHaveBeenCalledTimes(65);
  });

  it('clears retained payloads and terminal tombstones when the gateway is destroyed', async () => {
    const { byName, bus, tools } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    await byName('disclose_order_records').execute({ requestId: made.requestId }, HUMAN_CTX);

    tools.destroy();
    const afterDestroy = await byName('disclose_order_records')
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(afterDestroy.ok).toBe(false);
    expect(afterDestroy.records).toBeUndefined();
    expect(JSON.stringify(afterDestroy)).not.toMatch(SENSITIVE_RECORD_PATTERN);
    expect(afterDestroy.message).toMatch(/no pending request or retained result/i);
  });

  it('logs that records were released without reprinting them into the transcript', async () => {
    const { byName, bus } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    await byName('disclose_order_records').execute({ requestId: made.requestId }, HUMAN_CTX);
    const line = bus.all().at(-1)!;
    expect(line.text).toBe('Account records released. Completed for ORD-1043.');
    expect(line.text).not.toContain('6411');
  });

  it('cannot be spent on a return request, nor a return confirmed on a disclosure', async () => {
    const { byName } = fixture();
    const ret = await byName('request_return')
      .execute({ orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }, CTX) as any;
    const rec = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;

    const a = await byName('disclose_order_records').execute({ requestId: ret.requestId }, CTX) as any;
    expect(a.message).toMatch(/not a records release request/i);
    const b = await byName('confirm_return').execute({ requestId: rec.requestId }, CTX) as any;
    expect(b.message).toMatch(/not a return request/i);
  });

  it('a server refusal discloses nothing', async () => {
    const { byName, bus } = fixture();
    const made = await byName('request_records_release').execute({ orderId: 'ORD-1043' }, CTX) as any;
    confirm(bus, made.requestId);
    const tools = createTools({
      bus, data, now: () => NOW, newRequestId: () => 'req-x',
      policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
      act: async () => ({ ok: false, error: 'invalid_token' }),
    });
    const refused = await tools.find(t => t.name === 'disclose_order_records')!
      .execute({ requestId: made.requestId }, CTX) as any;
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toMatch(/6411/);
  });
});
