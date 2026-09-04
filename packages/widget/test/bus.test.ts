import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';

function fixture() {
  let t = 1_000;
  let n = 0;
  return createBus({ now: () => (t += 1_000), id: () => `e${++n}` });
}

describe('createBus', () => {
  it('stamps id and time on append', () => {
    const bus = fixture();
    const e = bus.append({ origin: 'human-direct', text: 'hi' });
    expect(e).toMatchObject({ id: 'e1', origin: 'human-direct', text: 'hi', at: 2_000 });
  });

  it('returns entries in append order', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'a' });
    bus.append({ origin: 'site-agent', text: 'b' });
    expect(bus.all().map(e => e.text)).toEqual(['a', 'b']);
  });

  it('since(null) returns everything with a cursor at the end', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'a' });
    bus.append({ origin: 'site-agent', text: 'b' });
    const { entries, cursor } = bus.since(null);
    expect(entries.map(e => e.text)).toEqual(['a', 'b']);
    expect(cursor).toBe('e2');
  });

  it('since(cursor) returns only entries after it', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'a' });
    const first = bus.since(null);
    bus.append({ origin: 'site-agent', text: 'b' });
    expect(bus.since(first.cursor).entries.map(e => e.text)).toEqual(['b']);
  });

  it('since with an unknown cursor returns everything rather than throwing', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'a' });
    expect(bus.since('nope').entries).toHaveLength(1);
  });

  it('notifies subscribers and can unsubscribe', () => {
    const bus = fixture();
    const seen = vi.fn();
    const off = bus.subscribe(seen);
    bus.append({ origin: 'human-direct', text: 'a' });
    off();
    bus.append({ origin: 'human-direct', text: 'b' });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a verified confirmation from a bare one', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1' });
    expect(bus.hasHumanConfirmation('req-1')).toBe(true);
    expect(bus.hasVerifiedConfirmation('req-1')).toBe(false);
  });

  it('accepts a confirmation carrying authenticator proof', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.hasVerifiedConfirmation('req-1')).toBe(true);
  });

  it('will not accept authenticator proof attached to a non-human origin', () => {
    const bus = fixture();
    bus.append({ origin: 'agent-relay', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.hasVerifiedConfirmation('req-1')).toBe(false);
  });

  it('recognises a human confirmation', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1' });
    expect(bus.hasHumanConfirmation('req-1')).toBe(true);
  });

  it('REFUSES a confirmation that did not come from the human', () => {
    const bus = fixture();
    bus.append({ origin: 'agent-relay', text: 'yes', confirms: 'req-1' });
    bus.append({ origin: 'agent-autonomous', text: 'yes', confirms: 'req-1' });
    bus.append({ origin: 'site-agent', text: 'yes', confirms: 'req-1' });
    expect(bus.hasHumanConfirmation('req-1')).toBe(false);
  });

  it('does not let a confirmation for one request satisfy another', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1' });
    expect(bus.hasHumanConfirmation('req-2')).toBe(false);
  });

  it('confirmationToken returns the token for a verified human-direct confirmation', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.confirmationToken('req-1')).toBe('tok-1');
  });

  it('confirmationToken returns null when the verification is on a non-human origin', () => {
    const bus = fixture();
    bus.append({ origin: 'agent-relay', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.confirmationToken('req-1')).toBeNull();
  });

  it('confirmationToken returns null for a human-direct entry with no verification', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1' });
    expect(bus.confirmationToken('req-1')).toBeNull();
  });

  it('confirmationToken does not let one request satisfy another', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.confirmationToken('req-2')).toBeNull();
  });

  it('hasVerifiedConfirmation refuses authenticator proof from every non-human origin', () => {
    const bus = fixture();
    bus.append({ origin: 'agent-relay', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    bus.append({ origin: 'agent-autonomous', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-2', at: 5 } });
    bus.append({ origin: 'site-agent', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-3', at: 5 } });
    expect(bus.hasVerifiedConfirmation('req-1')).toBe(false);
  });

  it('does not let a verified confirmation for one request satisfy another', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.hasVerifiedConfirmation('req-2')).toBe(false);
  });

  it('hasVerifiedConfirmation, given a tool, requires the confirmation to be stamped for it', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1', confirmsTool: 'confirm_return',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.hasVerifiedConfirmation('req-1', 'confirm_return')).toBe(true);
    expect(bus.hasVerifiedConfirmation('req-1', 'change_address')).toBe(false);
  });

  it('hasVerifiedConfirmation with no tool argument ignores confirmsTool, unchanged from before', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1', confirmsTool: 'confirm_return',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.hasVerifiedConfirmation('req-1')).toBe(true);
  });

  it('confirmationToken, given a tool, withholds the token from a mismatched action', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1', confirmsTool: 'confirm_return',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.confirmationToken('req-1', 'confirm_return')).toBe('tok-1');
    expect(bus.confirmationToken('req-1', 'change_address')).toBeNull();
  });

  it('hasAssuredConfirmation accepts webauthn proof, same as hasVerifiedConfirmation', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 5 } });
    expect(bus.hasAssuredConfirmation('req-1')).toBe(true);
  });

  it('hasAssuredConfirmation accepts trusted-click proof too, unlike hasVerifiedConfirmation', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'trusted-click', token: 'tc-1', at: 5 } });
    expect(bus.hasAssuredConfirmation('req-1')).toBe(true);
    // The stricter, cryptographic-only check must still refuse it.
    expect(bus.hasVerifiedConfirmation('req-1')).toBe(false);
  });

  it('hasAssuredConfirmation refuses a bare click with no proof of any kind', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1' });
    expect(bus.hasAssuredConfirmation('req-1')).toBe(false);
  });

  it('hasAssuredConfirmation refuses proof attached to a non-human origin', () => {
    const bus = fixture();
    bus.append({ origin: 'agent-relay', text: 'yes', confirms: 'req-1',
      verification: { method: 'trusted-click', token: 'tc-1', at: 5 } });
    expect(bus.hasAssuredConfirmation('req-1')).toBe(false);
  });

  it('hasAssuredConfirmation honours the tool binding, same as hasVerifiedConfirmation', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1', confirmsTool: 'confirm_return',
      verification: { method: 'trusted-click', token: 'tc-1', at: 5 } });
    expect(bus.hasAssuredConfirmation('req-1', 'confirm_return')).toBe(true);
    expect(bus.hasAssuredConfirmation('req-1', 'change_address')).toBe(false);
  });

  it('confirmationToken also returns the token for a trusted-click confirmation', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'yes', confirms: 'req-1',
      verification: { method: 'trusted-click', token: 'tc-1', at: 5 } });
    expect(bus.confirmationToken('req-1')).toBe('tc-1');
  });

  it('all() returns a copy — mutating it does not affect the bus', () => {
    const bus = fixture();
    bus.append({ origin: 'human-direct', text: 'a' });
    const snapshot = bus.all() as unknown as { text: string }[];
    snapshot.push({ text: 'injected' } as never);
    expect(bus.all().map(e => e.text)).toEqual(['a']);
  });

  it('one throwing subscriber does not stop delivery to the others or break append', () => {
    const bus = fixture();
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    bus.subscribe(bad);
    bus.subscribe(good);
    expect(() => bus.append({ origin: 'human-direct', text: 'a' })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
