import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createClinicTools, type ClinicDataSource, type ClinicVisit } from '../src/clinic';
import { evaluateDisclosure } from '../src/eligibility';
import { CLINIC_POLICY, RESTRICTED_CATEGORIES } from '../../../config/clinic';

/**
 * The second domain, and the reason it exists.
 *
 * What generalises is the transcript, stamped origins, refusal shape, and a gate only a
 * person can pass, while the domain tools are swappable. A clinic built on the same
 * gateway makes that reuse concrete.
 *
 * The gated action here moves no money at all, and it is a strictly harder consent problem
 * than a refund: a refund can be reversed, a disclosure cannot be recalled.
 */
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const VISITS: ClinicVisit[] = [
  { visitId: 'VIS-2291', at: NOW - 14 * DAY, clinician: 'Dr. Amara Okafor',
    reason: 'Annual physical', categories: ['visit-summary', 'labs'] },
  { visitId: 'VIS-2180', at: NOW - 210 * DAY, clinician: 'Dr. Lena Marsh',
    reason: 'Counselling referral', categories: ['visit-summary', 'mental-health'] },
];

const data: ClinicDataSource = {
  listVisits: async () => VISITS,
  getVisit: async id => VISITS.find(v => v.visitId === id) ?? null,
};

function fixture() {
  let n = 0, r = 0;
  const bus = createBus({ now: () => NOW, id: () => `e${++n}` });
  const act = vi.fn(async () => ({ ok: true, data: { released: { to: 'Dr. Okafor', documents: [{ title: 'Lipid panel' }] } } }));
  const raised: Array<{ requestId: string; tool: string }> = [];
  const tools = createClinicTools({
    bus, data, act, policy: CLINIC_POLICY,
    now: () => NOW, newRequestId: () => `req-${++r}`,
    restrictedCategories: RESTRICTED_CATEGORIES,
    onConfirmationNeeded: (req, tool) => { raised.push({ requestId: req.requestId, tool }); },
  });
  const call = (name: string, input: Record<string, unknown> = {},
    origin: 'agent-autonomous' | 'human-direct' = 'agent-autonomous') => {
    const t = tools.find(x => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t.execute(input, { origin, cursor: null }) as Promise<any>;
  };
  return { bus, tools, call, act, raised };
}

describe('the clinic is a different domain over the same gateway', () => {
  it('exposes visits and disclosures, and nothing about orders or refunds', () => {
    const names = fixture().tools.map(t => t.name);
    expect(names).toContain('list_my_visits');
    expect(names).toContain('request_records_disclosure');
    expect(names).toContain('release_records');
    for (const shopOnly of ['list_my_orders', 'request_return', 'confirm_return', 'search_products']) {
      expect(names).not.toContain(shopOnly);
    }
  });

  it('keeps the conventions that are supposed to generalise', () => {
    const names = fixture().tools.map(t => t.name);
    for (const shared of ['get_conversation', 'send_message', 'provide_context', 'await_reply']) {
      expect(names).toContain(shared);
    }
  });

  it('never exposes the records themselves through a read tool', async () => {
    const { call } = fixture();
    const seen = JSON.stringify([await call('list_my_visits'), await call('get_visit', { visitId: 'VIS-2291' })]);
    // Categories, yes. Contents, no — those come from /api/act against a spent token.
    expect(seen).toContain('labs');
    expect(seen).not.toMatch(/cholesterol|Lipid panel|BP 118/i);
  });
});

describe('restricted records do not travel by accident', () => {
  it('holds them back on a routine release, and SAYS it is holding them back', () => {
    const r = evaluateDisclosure(VISITS, 'Dr. Okafor', false, RESTRICTED_CATEGORIES);
    expect(r.eligible).toBe(true);
    const shown = r.because.at(-1)!;
    expect(shown).toMatch(/holding back/i);
    expect(shown).toMatch(/mental-health/);
    // A person should never find out afterwards that a release was narrower than they
    // thought, any more than that it was wider.
  });

  it('names them explicitly when a request does ask for them', () => {
    const shown = evaluateDisclosure(VISITS, 'Dr. Okafor', true, RESTRICTED_CATEGORIES).because.at(-1)!;
    expect(shown).toMatch(/INCLUDES restricted/);
    expect(shown).toMatch(/mental-health/);
  });

  it('refuses a release with no named recipient', () => {
    const r = evaluateDisclosure(VISITS, '   ', false, RESTRICTED_CATEGORIES);
    expect(r.eligible).toBe(false);
    expect(r.because.join(' ')).toMatch(/named recipient/i);
  });

  it('refuses a release that matches no visits', () => {
    expect(evaluateDisclosure([], 'Dr. Okafor', false, RESTRICTED_CATEGORIES).eligible).toBe(false);
  });

  it('puts the recipient in the sentence the person reads before confirming', async () => {
    const r = await fixture().call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Amara Okafor' });
    // modal.ts renders because.at(-1): "release records" is not consent, naming what and
    // to whom is.
    expect(r.eligibility.because.at(-1)).toMatch(/Dr\. Amara Okafor/);
  });
});

describe('the gate holds here exactly as it does in the shop', () => {
  it('request_records_disclosure sends nothing and raises the confirm affordance', async () => {
    const { call, raised, act } = fixture();
    const made = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Okafor' });
    expect(made.ok).toBe(true);
    expect(act).not.toHaveBeenCalled();
    expect(raised).toEqual([{ requestId: 'req-1', tool: 'release_records' }]);
  });

  it('release_records is refused until a hardware-verified confirmation exists', async () => {
    const { call, act } = fixture();
    const made = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Okafor' });
    const blocked = await call('release_records', { requestId: made.requestId });
    expect(blocked).toMatchObject({ ok: false, needsHumanConfirmation: true });
    expect(act).not.toHaveBeenCalled();
  });

  it('completes once confirmed, and surfaces what the server actually released', async () => {
    const { call, bus, act } = fixture();
    const made = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Okafor' });
    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: made.requestId,
      confirmsTool: 'release_records', verification: { method: 'webauthn', token: 'tok', at: NOW },
    });
    const done = await call('release_records', { requestId: made.requestId }, 'human-direct');
    expect(done).toMatchObject({ ok: true });
    expect(done.released.documents[0].title).toBe('Lipid panel');
    expect(act).toHaveBeenCalledWith('release_records', made.requestId, 'tok');
    expect(bus.all().at(-1)!.text).toMatch(/^Records released\./);
    const receipt = await call('release_records', { requestId: made.requestId });
    expect(receipt.released.documents[0].title).toBe('Lipid panel');
    // A second delivery is the one retry allowed when the first tool response was lost.
    // The third read must be a metadata-only tombstone, never another copy of documents.
    const retryAfterLostDelivery = await call('release_records', { requestId: made.requestId });
    expect(retryAfterLostDelivery.released.documents[0].title).toBe('Lipid panel');
    const consumed = await call('release_records', { requestId: made.requestId });
    expect(consumed).toMatchObject({
      ok: true, terminal: true, outcome: 'completed', receiptStatus: 'consumed',
    });
    expect(consumed.released).toBeUndefined();
    expect(JSON.stringify(consumed)).not.toContain('Lipid panel');
    expect(act).toHaveBeenCalledTimes(1);
  });

  it('refuses a re-filed disclosure for an already-released set, but still allows a different one', async () => {
    const { call, bus, act, raised } = fixture();
    const made = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Okafor' });
    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: made.requestId,
      confirmsTool: 'release_records', verification: { method: 'webauthn', token: 'tok', at: NOW },
    });
    const done = await call('release_records', { requestId: made.requestId }, 'human-direct');
    expect(done.ok).toBe(true);
    expect(raised).toHaveLength(1);
    expect(act).toHaveBeenCalledTimes(1);

    // The agent re-files the identical release. No second box, no second delivery.
    const again = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Okafor' });
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already been released/i);
    expect(again.requestId).toBeUndefined();
    expect(raised).toHaveLength(1);
    expect(act).toHaveBeenCalledTimes(1);

    // A genuinely different release (different visit set) is still offered.
    const other = await call('request_records_disclosure',
      { visitIds: ['VIS-2180'], recipient: 'Dr. Okafor' });
    expect(other.ok).toBe(true);
    expect(raised.map(r => r.requestId)).toContain(other.requestId);
  });

  it('holds restricted records back on a routine release and refuses any attempt to include them', async () => {
    const { call } = fixture();
    const routine = await call('request_records_disclosure',
      { visitIds: ['VIS-2180'], recipient: 'Dr. Okafor' });
    // A routine release of a visit that also has restricted records releases the routine
    // part and says, out loud, what it is holding back.
    expect(routine.ok).toBe(true);
    expect(routine.eligibility.because.at(-1)).toMatch(/Holding back/i);
    // An agent cannot widen the release to restricted records: the request is refused
    // outright, nothing pending is created, and no ceremony is offered.
    const wide = await call('request_records_disclosure',
      { visitIds: ['VIS-2180'], recipient: 'Dr. Okafor', include_restricted: true });
    expect(wide.ok).toBe(false);
    expect(wide.requestId).toBeUndefined();
    expect(wide.message).toMatch(/cannot be released|restricted/i);
  });

  it('a clinic request cannot be spent by a shop action name', async () => {
    const { call } = fixture();
    const made = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Okafor' });
    // confirm_return does not exist in this registry at all — the strongest form of the
    // kind binding, since there is nothing here to point at the wrong action.
    expect(fixture().tools.find(t => t.name === 'confirm_return')).toBeUndefined();
    expect(made.requestId).toBe('req-1');
  });
});

/**
 * ACTION_LABEL is keyed by tool name and falls back to the bare tool name. That fallback
 * exists so a new gated tool renders SOMETHING rather than nothing, but it is not a
 * finished state: "Confirm this action (release_records)" is a developer's string shown to
 * a patient at the moment of consent. Every gated tool in POLICY_RULES needs a real one.
 */
describe('the clinic gate is labelled for a person, not for a developer', () => {
  it('names the action in words a patient would use', async () => {
    const { ACTION_LABEL } = await import('../src/ui/modal') as unknown as
      { ACTION_LABEL: Record<string, string> };
    expect(ACTION_LABEL.release_records).toBeDefined();
    expect(ACTION_LABEL.release_records).not.toMatch(/release_records/);
    expect(ACTION_LABEL.release_records).toMatch(/records/i);
  });
});

/**
 * The other kind of human-in-the-loop refusal, and the one the conventions were missing.
 *
 * "A human must AUTHORISE this" is the gate. "A human is the only one who KNOWS this" is
 * different, and it is what forces a genuine round trip between the two agents: the clinic
 * cannot infer a recipient, there is no correct guess, and guessing is the failure mode
 * worth designing out of a records system.
 *
 * It is also the scenario that exercises await_reply for real, which is why the demo bar
 * scripts it: the agent asks, and then has to still be listening when the answer arrives.
 */
describe('a release with missing information asks for it instead of guessing', () => {
  it('refuses a nameless recipient with a question, not just a complaint', async () => {
    const r = await fixture().call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: '' });
    expect(r).toMatchObject({ ok: false, needsInformation: true });
    expect(r.question).toMatch(/who should the records go to/i);
    expect(r.message).toMatch(/named recipient/i);
  });

  it('tells the agent to ask AND to wait, because ending the turn loses the answer', async () => {
    const r = await fixture().call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: '' });
    expect(r.agentHint).toMatch(/send_message/);
    expect(r.agentHint).toMatch(/await_reply/);
  });

  it('asks which visits when none matched', async () => {
    const r = await fixture().call('request_records_disclosure',
      { visitIds: [], recipient: 'Dr. Okafor' });
    expect(r).toMatchObject({ ok: false, needsInformation: true });
    expect(r.question).toMatch(/which visits/i);
  });

  it('is NOT the confirmation refusal — the two must not be confused', async () => {
    // needsHumanConfirmation means "authorise this". needsInformation means "tell me
    // something". An agent that conflates them would ask a person to confirm a release it
    // has not described yet.
    const r = await fixture().call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: '' });
    expect(r.needsHumanConfirmation).toBeUndefined();
    expect(r.requestId).toBeUndefined();
  });

  it('files nothing, so there is no half-made release to confirm later', async () => {
    const { call } = fixture();
    await call('request_records_disclosure', { visitIds: ['VIS-2291'], recipient: '' });
    const spend = await call('release_records', { requestId: 'req-1' });
    expect(spend.message).toMatch(/no pending|needs the requestId/i);
  });

  it('proceeds normally once the answer comes back', async () => {
    const { call } = fixture();
    const asked = await call('request_records_disclosure', { visitIds: ['VIS-2291'], recipient: '' });
    expect(asked.needsInformation).toBe(true);
    const answered = await call('request_records_disclosure',
      { visitIds: ['VIS-2291'], recipient: 'Dr. Amara Okafor' });
    expect(answered).toMatchObject({ ok: true });
    expect(answered.eligibility.because.at(-1)).toMatch(/Dr\. Amara Okafor/);
  });
});
