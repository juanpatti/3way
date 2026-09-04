// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createBus } from '../src/bus';
import { createModal } from '../src/ui/modal';
import { CSS } from '../src/ui/styles';

function fixture(opts: {
  storeAgentLabel?: string;
  authenticatorAvailable?: () => boolean | undefined;
  onMissingAuthenticator?: 'refuse' | 'trusted-click';
  composer?: boolean;
} = {}) {
  let t = 0, n = 0;
  const bus = createBus({ now: () => ++t, id: () => `e${++n}` });
  const send = vi.fn();
  const confirm = vi.fn();
  const modal = createModal({
    bus, onSend: send, onConfirm: confirm,
    storeAgentLabel: opts.storeAgentLabel,
    authenticatorAvailable: opts.authenticatorAvailable,
    onMissingAuthenticator: opts.onMissingAuthenticator,
    composer: opts.composer,
  });
  document.body.append(modal.el);
  // The widget renders into a shadow root, so queries must go through it rather
  // than through `document` — an open shadow root is still not pierced by
  // document.querySelector.
  const root = modal.el.shadowRoot!;
  return { bus, modal, send, confirm, root };
}

const lines = (root: ShadowRoot) => [...root.querySelectorAll('[data-3way-origin]')];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

/**
 * A script-dispatched event is ALWAYS isTrusted: false — that's the platform's own
 * behaviour, in jsdom exactly as in a real browser, and it's what a computer-use agent's
 * synthetic click looks like on the wire. `isTrusted` is `[Unforgeable]` per the WebIDL
 * standard: jsdom defines it as a non-configurable OWN property on each event instance
 * specifically so it CANNOT be shadowed after construction (`Object.defineProperty`
 * throws "Cannot redefine property" — that's platform behavior, not a jsdom
 * limitation to work around at the Event level).
 *
 * So this simulates a trusted click one level down instead: capture the listener
 * modal.ts's `btn.addEventListener('click', ...)` registers, and invoke it directly with
 * a plain object carrying `isTrusted: true` — never asking jsdom to fake an unforgeable
 * platform property. The handler reads nothing else off the event, so this is a faithful
 * simulation of what a REAL trusted click would reach it with.
 */
const clickListeners = new WeakMap<EventTarget, (ev: unknown) => unknown>();
const realAddEventListener = HTMLElement.prototype.addEventListener;
HTMLElement.prototype.addEventListener = function (
  this: HTMLElement, type: string, listener: EventListenerOrEventListenerObject | null, ...rest: unknown[]
) {
  if (type === 'click' && typeof listener === 'function') clickListeners.set(this, listener as (ev: unknown) => unknown);
  return (realAddEventListener as (...a: unknown[]) => unknown).call(this, type, listener, ...rest);
};

function trustedClick(el: HTMLElement) {
  const listener = clickListeners.get(el);
  if (!listener) throw new Error('trustedClick: no click listener registered on this element');
  void listener({ isTrusted: true });
}

describe('createModal', () => {
  it('renders an entry with its origin as a data attribute', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'human-direct', text: 'hello' });
    expect(lines(root).map(el => el.getAttribute('data-3way-origin'))).toEqual(['human-direct']);
  });

  it('labels the visiting agent distinctly from the person', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'human-direct', text: 'a' });
    bus.append({ origin: 'agent-autonomous', text: 'b' });
    const labels = lines(root).map(el => el.querySelector('[data-3way-label]')!.textContent);
    expect(labels[0]).not.toBe(labels[1]);
  });

  it('marks a relayed message as asserted, not verified', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'agent-relay', text: 'she wants a refund' });
    expect(lines(root)[0]!.getAttribute('data-3way-direct')).toBe('false');
  });

  it('marks the human as verified', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'human-direct', text: 'hi' });
    expect(lines(root)[0]!.getAttribute('data-3way-direct')).toBe('true');
  });

  // The layered assurance model: the transcript itself must carry which level a
  // confirmation completed at, not just the confirm box (long gone by the time this
  // renders) — so a viewer can tell a webauthn confirmation from a trusted-click one.
  it('carries the assurance level on a confirming entry as a data attribute', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'human-direct', text: 'Yes, I confirm.', confirms: 'req-1',
      verification: { method: 'webauthn', token: 'tok-1', at: 1 } });
    expect(lines(root)[0]!.getAttribute('data-3way-assurance')).toBe('webauthn');
  });

  it('carries trusted-click as a distinct assurance level, not folded into webauthn', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'human-direct', text: 'Yes, I confirm.', confirms: 'req-1',
      verification: { method: 'trusted-click', token: 'tc-1', at: 1 } });
    expect(lines(root)[0]!.getAttribute('data-3way-assurance')).toBe('trusted-click');
  });

  it('carries no assurance attribute at all for the demo bypass (bare click, no proof)', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'human-direct', text: 'Yes, I confirm.', confirms: 'req-1' });
    expect(lines(root)[0]!.hasAttribute('data-3way-assurance')).toBe(false);
  });

  // The store's own agent (site-agent) is also NOT data-3way-direct="true" — it isn't the
  // human-direct ingress path — but it must not be badged "unverified" on screen: the
  // the attribution model treats it as verified, and the panel is the visible surface for "the site
  // knows who is speaking." Pinned by inspecting the CSS source directly, since jsdom
  // does not render generated ::after content for a computed-style assertion.
  it('does not mark the store agent as unverified, even though it fails the direct check', () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'site-agent', text: 'On its way.' });
    expect(lines(root)[0]!.getAttribute('data-3way-direct')).toBe('false');
  });

  // The store agent's on-screen name used to be hardcoded ("Halden Support") in this
  // shared bundle, so every OTHER adopter's transcript showed Halden's name too. It must
  // come from config, with a generic fallback for an adopter who doesn't set one.
  it("labels the store agent from config, defaulting to 'Store' when no name is configured", () => {
    const { bus, root } = fixture();
    bus.append({ origin: 'site-agent', text: 'On its way.' });
    const label = lines(root)[0]!.querySelector('[data-3way-label]')!.textContent;
    expect(label).toBe('Store');
  });

  it('labels the store agent with a tenant-supplied name instead of the library default', () => {
    const { bus, root } = fixture({ storeAgentLabel: 'Acme Support' });
    bus.append({ origin: 'site-agent', text: 'On its way.' });
    const label = lines(root)[0]!.querySelector('[data-3way-label]')!.textContent;
    expect(label).toBe('Acme Support');
    expect(label).not.toBe('Halden Support');
  });

  it("the CSS 'unverified' badge is scoped to the two visiting-agent origins, never site-agent", () => {
    expect(CSS).not.toMatch(/data-3way-direct="false"\]\s*\.label::after/);
    expect(CSS).toMatch(/\[data-3way-origin="agent-relay"\]\s*\.label::after/);
    expect(CSS).toMatch(/\[data-3way-origin="agent-autonomous"\]\s*\.label::after/);
    const badgeRule = CSS.slice(CSS.indexOf('· unverified') - 200, CSS.indexOf('· unverified'));
    expect(badgeRule).not.toContain('data-3way-origin="site-agent"');
  });

  it('renders no composer in keyholder mode (the default)', () => {
    const { root } = fixture();
    expect(root.querySelector('[data-3way-composer]')).toBeNull();
    expect(root.querySelector('form')).toBeNull();
    // The empty state stands on its own without a "type below" instruction.
    expect(root.querySelector('[data-3way-empty]')?.textContent).not.toMatch(/type below/i);
  });

  it('minimizes to the header bar and restores, defaulting to the full shape', () => {
    const { root } = fixture();
    const panel = root.querySelector('.panel') as HTMLElement;
    const min = root.querySelector('[data-3way-min]') as HTMLButtonElement;
    expect(min).not.toBeNull();
    expect(panel.getAttribute('data-min')).not.toBe('true');   // default load is the full shape
    min.click();
    expect(panel.getAttribute('data-min')).toBe('true');
    min.click();
    expect(panel.getAttribute('data-min')).toBe('false');
  });

  it('sends composer text and clears the field', () => {
    const { send, root } = fixture({ composer: true });
    const input = root.querySelector('[data-3way-composer]') as HTMLInputElement;
    input.value = 'I want a refund';
    input.form!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(send).toHaveBeenCalledWith('I want a refund');
    expect(input.value).toBe('');
  });

  it('ignores an empty composer submission', () => {
    const { send, root } = fixture({ composer: true });
    const input = root.querySelector('[data-3way-composer]') as HTMLInputElement;
    input.value = '   ';
    input.form!.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    expect(send).not.toHaveBeenCalled();
  });

  it('shows a confirm affordance only when one is requested', async () => {
    const { modal, confirm, root } = fixture();
    // The click handler awaits onConfirm regardless of what this test asserts on, so the
    // mock must resolve to a conforming value — otherwise the await settles to `undefined`
    // and the handler's `.ok` access throws asynchronously as an unhandled rejection.
    confirm.mockResolvedValue({ ok: true });
    expect(root.querySelector('[data-3way-confirm]')).toBeNull();
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'ORD-1043', itemId: 'IT-1',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: ['x'] } },
      'confirm_return');
    const btn = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    trustedClick(btn);
    expect(confirm).toHaveBeenCalledWith('req-1', 'confirm_return',
      { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' });
  });

  // Layered assurance rule #1: a synthetic click (isTrusted === false) — exactly what a
  // computer-use agent's DOM-driven click looks like on the wire — is refused BEFORE
  // onConfirm is ever called, regardless of which assurance level would otherwise apply.
  it('REFUSES an untrusted click and never calls onConfirm', () => {
    const { modal, confirm, root } = fixture();
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    const btn = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    // Plain .click() is a script-dispatched, therefore untrusted, event — the same shape
    // a computer-use agent's synthetic click has.
    btn.click();
    expect(confirm).not.toHaveBeenCalled();
    expect(root.querySelector('[data-3way-note]')!.textContent).not.toBe('');
    // The button stays live for the actual person to try — an untrusted attempt must
    // never lock out a genuine one that follows it.
    expect(root.querySelector('[data-3way-confirm]')).not.toBeNull();
  });

  it('a genuine (trusted) click after a refused untrusted one still succeeds', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue({ ok: true });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    const btn = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    btn.click();   // untrusted — refused
    expect(confirm).not.toHaveBeenCalled();
    trustedClick(btn);
    expect(confirm).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(root.querySelector('[data-3way-confirm]')).toBeNull());
  });

  // Proactive path (mount-time probe already resolved: known no-authenticator).
  // Layered assurance rule #2: 'refuse' (the only setting shipped safe for anything
  // real — not this deployment's, which opts in to 'trusted-click') keeps removing the
  // button entirely — unchanged from before this policy switch existed.
  it("proactively removes the button when the authenticator is known absent and the policy is 'refuse'", () => {
    const { modal, root } = fixture({ authenticatorAvailable: () => false, onMissingAuthenticator: 'refuse' });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    expect(root.querySelector('[data-3way-confirm]')).toBeNull();
    expect(root.querySelector('[data-3way-note]')!.textContent).toMatch(/fingerprint|face/i);
  });

  it('proactively removes the button when the authenticator is known absent and the policy is omitted (fail-closed default)', () => {
    const { modal, root } = fixture({ authenticatorAvailable: () => false });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    expect(root.querySelector('[data-3way-confirm]')).toBeNull();
  });

  // Layered assurance rule #2, the weaker branch: 'trusted-click' keeps the button LIVE
  // and states plainly, on screen, that this device has no hardware authenticator and
  // the confirmation will be recorded at a lower assurance.
  it("keeps the button live and states the weaker assurance plainly when the authenticator is known absent and the policy is 'trusted-click'", async () => {
    const { modal, confirm, root } = fixture({
      authenticatorAvailable: () => false, onMissingAuthenticator: 'trusted-click',
    });
    confirm.mockResolvedValue({ ok: true });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    const note = root.querySelector('[data-3way-note]')!.textContent ?? '';
    expect(note).toMatch(/fingerprint|face/i);
    expect(note.toLowerCase()).toMatch(/trusted click|weaker/);
    const btn = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    trustedClick(btn);
    expect(confirm).toHaveBeenCalledWith('req-1', 'confirm_return',
      { orderId: 'O', itemId: 'I', reason: 'defect' });
    await vi.waitFor(() => expect(root.querySelector('[data-3way-confirm]')).toBeNull());
  });

  // The confirm box used to show the order and the eligibility verdict but never which
  // action was being authorized — so a person had no way to tell, from the box alone,
  // whether they were about to confirm a return or something else entirely. All three
  // gated tools share one pending map keyed only by requestId (tools.ts), so this is the
  // one place a person can actually check the action matches what they expect.
  it('names the action being authorized in the confirm box, distinctly per tool', () => {
    const { modal, root } = fixture();
    const box = () => root.querySelector('.confirm')!.textContent ?? '';
    const eligibility = { eligible: true, path: 'warranty' as const, because: ['x'] };

    modal.requestConfirmation(
      { requestId: 'req-1', kind: 'return' as const, orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect', eligibility },
      'confirm_return');
    expect(box()).toMatch(/return/i);
    expect(box()).toMatch(/refund/i);

    modal.requestConfirmation(
      { requestId: 'req-2', kind: 'return' as const, orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect', eligibility },
      'cancel_order');
    expect(box()).toMatch(/cancel/i);
    expect(box()).not.toMatch(/refund/i);

    modal.requestConfirmation(
      { requestId: 'req-3', kind: 'return' as const, orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect', eligibility },
      'change_address');
    expect(box()).toMatch(/address/i);
  });

  it('removes the affordance only after verification succeeds', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue({ ok: true });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    await vi.waitFor(() => expect(root.querySelector('[data-3way-confirm]')).toBeNull());
  });

  it('shows a successful action payload to the person without adding its values to the transcript', async () => {
    const { modal, confirm, root, bus } = fixture();
    confirm.mockResolvedValue({
      ok: true,
      data: { records: { paymentBrand: 'Visa', paymentLast4: '6411' } },
    });
    modal.requestConfirmation({
      requestId: 'req-records', kind: 'records-release' as const, orderId: 'ORD-1043',
      itemId: '', reason: null,
      eligibility: { eligible: true, path: 'disclosure', because: ['Belongs to this customer.'] },
    }, 'disclose_order_records');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);

    await vi.waitFor(() => {
      const result = root.querySelector('[data-3way-action-result]');
      expect(result).not.toBeNull();
      expect(result!.textContent).toMatch(/Visa/);
      expect(result!.textContent).toMatch(/6411/);
    });
    expect(bus.all().map(e => e.text).join(' ')).not.toMatch(/Visa|6411/);
  });

  it('makes an indeterminate action terminal and warns not to retry', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue({ ok: false, reason: 'action-indeterminate' });
    modal.requestConfirmation({ requestId: 'req-unknown', kind: 'cancel' as const,
      orderId: 'ORD-1118', itemId: '', reason: null,
      eligibility: { eligible: true, path: 'order-change', because: ['Not shipped.'] } },
      'cancel_order');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);

    await vi.waitFor(() => {
      const note = root.querySelector('[data-3way-note]')!.textContent ?? '';
      expect(note).toMatch(/confirmation was recorded/i);
      expect(note).not.toMatch(/verified it was you/i);
      expect(note).toMatch(/could not confirm whether this completed/i);
      expect(note).toMatch(/do not retry/i);
      expect(note).toMatch(/check the order/i);
      expect(root.querySelector('[data-3way-confirm]')).toBeNull();
    });
  });

  it('makes a definitive action refusal terminal without claiming device verification', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue({ ok: false, reason: 'action-failed' });
    modal.requestConfirmation({ requestId: 'req-refused', kind: 'cancel' as const,
      orderId: 'ORD-1118', itemId: '', reason: null,
      eligibility: { eligible: true, path: 'order-change', because: ['Not shipped.'] } },
      'cancel_order');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);

    await vi.waitFor(() => {
      const note = root.querySelector('[data-3way-note]')!.textContent ?? '';
      expect(note).toMatch(/confirmation was recorded/i);
      expect(note).not.toMatch(/verified it was you/i);
      expect(note).toMatch(/server refused it/i);
      expect(note).toMatch(/nothing has changed/i);
      expect(root.querySelector('[data-3way-confirm]')).toBeNull();
    });
  });

  it('REMOVES the button and explains when the device has no authenticator', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue({ ok: false, reason: 'no-authenticator' });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    await vi.waitFor(() => {
      expect(root.querySelector('[data-3way-confirm]')).toBeNull();
      expect(root.querySelector('[data-3way-note]')!.textContent).toMatch(/fingerprint|face/i);
    });
  });

  it('KEEPS the affordance when verification is cancelled, and re-enables it', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue({ ok: false, reason: 'cancelled' });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    await vi.waitFor(() => {
      const b = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
      expect(b).not.toBeNull();
      expect(b.disabled).toBe(false);
    });
  });

  it('re-enables with a message instead of hanging when onConfirm rejects', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockRejectedValue(new Error('network down'));
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    await vi.waitFor(() => {
      const b = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
      expect(b).not.toBeNull();
      expect(b.disabled).toBe(false);
      expect(root.querySelector('[data-3way-note]')!.textContent).not.toBe('');
    });
  });

  it('re-enables with a message instead of hanging when onConfirm resolves to undefined', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValue(undefined);
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    await vi.waitFor(() => {
      const b = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
      expect(b).not.toBeNull();
      expect(b.disabled).toBe(false);
      expect(root.querySelector('[data-3way-note]')!.textContent).not.toBe('');
    });
  });

  it('falls back to a known message when onConfirm resolves with an unrecognized reason', async () => {
    const { modal, confirm, root } = fixture();
    // Deliberately malformed — the mock is untyped, so nothing stops onConfirm from
    // resolving a reason the interface never promised. Exercises the fallback.
    confirm.mockResolvedValue({ ok: false, reason: 'not-a-real-reason' });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    await vi.waitFor(() => {
      const b = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
      expect(b).not.toBeNull();
      expect(b.disabled).toBe(false);
      expect(root.querySelector('[data-3way-note]')!.textContent).not.toMatch(/undefined/);
      expect(root.querySelector('[data-3way-note]')!.textContent).not.toBe('');
    });
  });

  it('clears a previous failure note when the affordance is retried', async () => {
    const { modal, confirm, root } = fixture();
    confirm.mockResolvedValueOnce({ ok: false, reason: 'cancelled' });
    modal.requestConfirmation({ requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    const button = () => root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    trustedClick(button());
    await vi.waitFor(() => expect(root.querySelector('[data-3way-note]')!.textContent).not.toBe(''));
    confirm.mockResolvedValueOnce({ ok: true });
    trustedClick(button());
    // The click handler clears the note synchronously, before awaiting onConfirm.
    expect(root.querySelector('[data-3way-note]')!.textContent).toBe('');
    await vi.waitFor(() => expect(root.querySelector('[data-3way-confirm]')).toBeNull());
  });

  it('leaves the pending box in place when a second request arrives mid-ceremony', async () => {
    const { modal, confirm, root } = fixture();
    const a = deferred<{ ok: true }>();
    confirm.mockReturnValueOnce(a.promise);
    modal.requestConfirmation({ requestId: 'req-A', kind: 'return' as const, orderId: 'A', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    // A's ceremony is now in flight (the OS prompt is up). A second gated call for a
    // different order arrives before it resolves.
    modal.requestConfirmation({ requestId: 'req-B', kind: 'return' as const, orderId: 'B', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    const btn = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    expect(btn.getAttribute('data-3way-confirm')).toBe('req-A');
    a.resolve({ ok: true });
    await vi.waitFor(() => expect(root.querySelector('[data-3way-confirm]')).toBeNull());
  });

  it('does not let a superseded ceremony corrupt the box shown after it resolves', async () => {
    const { modal, confirm, root } = fixture();
    const a = deferred<{ ok: false; reason: 'no-authenticator' }>();
    confirm.mockReturnValueOnce(a.promise);
    modal.requestConfirmation({ requestId: 'req-A', kind: 'return' as const, orderId: 'A', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    trustedClick(root.querySelector('[data-3way-confirm]') as HTMLButtonElement);
    // Blocked while A's ceremony is in flight — this request never gets shown.
    modal.requestConfirmation({ requestId: 'req-B', kind: 'return' as const, orderId: 'B', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    a.resolve({ ok: false, reason: 'no-authenticator' });
    await vi.waitFor(() => {
      expect(root.querySelector('[data-3way-confirm]')).toBeNull();
      expect(root.querySelector('[data-3way-note]')!.textContent).toMatch(/fingerprint|face/i);
    });
    // The slot is free now — B can finally be shown, with no trace of A's leftover note.
    confirm.mockResolvedValueOnce({ ok: true });
    modal.requestConfirmation({ requestId: 'req-B', kind: 'return' as const, orderId: 'B', itemId: 'I',
      reason: 'defect', eligibility: { eligible: true, path: 'warranty', because: [] } },
      'confirm_return');
    const btn = root.querySelector('[data-3way-confirm]') as HTMLButtonElement;
    expect(btn.getAttribute('data-3way-confirm')).toBe('req-B');
    expect(root.querySelector('[data-3way-note]')!.textContent).toBe('');
  });
});

/**
 * The subject of a confirmation is the decision, not background for it. All of this used
 * to live inside the collapsed <details> while the confirm button sat outside it — so the
 * default state of the box named the ACTION ("Confirm this return") and hid WHICH return,
 * where it was going, and whether restricted records were included, behind a disclosure
 * the button did not wait for. Presence is not informed consent.
 */
describe('the confirm box never hides what is being confirmed', () => {
  // jsdom performs no layout, so this pins the CSS SOURCE against a bug measured in
  // headless Chrome: with a long transcript the confirm slot was squeezed to 27px around a
  // 213px box, and the "Yes, confirm this" button sat below the fold of a scrollbar inside
  // the chat. Two causes, both pinned here. The slot must not be shrinkable (flex-shrink 0:
  // with overflow-y auto its automatic minimum is zero, so the transcript's pressure wins),
  // and its cap must be a definite length, not a percentage — the panel has max-height
  // only, so its height is indefinite and a percentage max-height resolves to none.
  // The same goes for the transcript's floor, which is why .log carries no percentage.
  it('re-raising the request already on screen leaves the box untouched; a different one replaces it', () => {
    // A gated call that holds the line re-raises the box on every re-arm (tools.ts's
    // hold). Rebuilding it collapsed the "why" the person had opened, every window.
    const { modal, root } = fixture();
    const req = { requestId: 'req-1', kind: 'return' as const, orderId: 'O', itemId: 'I', reason: 'defect' as const,
      eligibility: { eligible: true, path: 'warranty' as const, because: ['x'] } };
    modal.requestConfirmation(req, 'confirm_return');
    const box = root.querySelector('.confirm')!;
    (root.querySelector('details') as HTMLDetailsElement).open = true;
    modal.requestConfirmation(req, 'confirm_return');
    expect(root.querySelector('.confirm')).toBe(box);
    expect((root.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    modal.requestConfirmation({ ...req, requestId: 'req-2' }, 'confirm_return');
    expect(root.querySelector('.confirm')).not.toBe(box);
    expect(root.querySelector('[data-3way-confirm]')!.getAttribute('data-3way-confirm')).toBe('req-2');
  });

  it('the confirm slot cannot be squeezed by the transcript, and is capped by a definite length', () => {
    const slotRule = CSS.match(/\[data-3way-confirm-slot\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(slotRule).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(slotRule).toMatch(/overflow-y:\s*auto/);
    expect(slotRule).toMatch(/max-height:\s*min\(\s*\d+vh,\s*\d+px\s*\)/);
    expect(slotRule).not.toMatch(/max-height:\s*\d+%/);
    const logRule = CSS.match(/\n\.log\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(logRule).toMatch(/min-height:\s*0\b/);
    expect(logRule).not.toMatch(/min-height:\s*\d+%/);
  });


  const subjectText = (root: ShadowRoot) =>
    root.querySelector('[data-3way-subject]')?.textContent ?? '';

  it('names the order without the details element being opened', () => {
    const { modal, root } = fixture();
    modal.requestConfirmation({
      requestId: 'req-1', kind: 'return' as const, orderId: 'ORD-1043', itemId: 'IT-1',
      reason: 'defect' as const,
      eligibility: { eligible: true, path: 'warranty', because: ['Within warranty.'] },
    }, 'confirm_return');

    const details = root.querySelector('details.confirm__detail') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(subjectText(root)).toContain('ORD-1043');
    // The verdict path changes what the person is agreeing to, not merely why it was
    // allowed — a warranty claim and a change-of-mind return are different decisions.
    expect(subjectText(root)).toContain('warranty');
  });

  it('distinguishes two returns for different items and reasons on the same order', () => {
    const { modal, root } = fixture();
    const eligibility = { eligible: true, path: 'warranty' as const, because: ['Covered.'] };
    modal.requestConfirmation({ requestId: 'req-line-1', kind: 'return' as const,
      orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect', eligibility }, 'confirm_return');
    const first = subjectText(root);
    modal.requestConfirmation({ requestId: 'req-line-2', kind: 'return' as const,
      orderId: 'ORD-1043', itemId: 'IT-2', reason: 'wrong-item', eligibility }, 'confirm_return');
    const second = subjectText(root);

    expect(first).toMatch(/IT-1/);
    expect(first).toMatch(/defect/);
    expect(second).toMatch(/IT-2/);
    expect(second).toMatch(/wrong-item/);
    expect(first).not.toBe(second);
  });

  it('names the new address on an address change — a redirect the person cannot read is a blank cheque', () => {
    const { modal, root } = fixture();
    modal.requestConfirmation({
      requestId: 'req-2', kind: 'address-change' as const, orderId: 'ORD-1118', itemId: '',
      reason: null, address: '14 Bellweather Lane, Bristol BS1 4TR',
      eligibility: { eligible: true, path: 'order-change', because: ['Not delivered yet.'] },
    }, 'change_address');

    expect(subjectText(root)).toContain('ORD-1118');
    expect(subjectText(root)).toContain('14 Bellweather Lane, Bristol BS1 4TR');
  });

  it('says out loud when a release covers restricted records, and who receives them', () => {
    const { modal, root } = fixture();
    modal.requestConfirmation({
      requestId: 'req-3', kind: 'disclosure' as const, orderId: 'VIS-2291',
      itemId: 'Dr. Amara Okafor, Meridian Family Practice', reason: null,
      scope: 'include-restricted',
      eligibility: { eligible: true, path: 'disclosure', because: ['Belongs to this patient.'] },
    }, 'release_records');

    expect(subjectText(root)).toContain('Dr. Amara Okafor');
    // Consenting to routine records must never be how somebody consents to restricted
    // ones, so the widening cannot be the thing behind the disclosure.
    expect(subjectText(root)).toContain('INCLUDES RESTRICTED RECORDS');
  });

  it('still shows the subject on the refuse path, where there is nothing to click', () => {
    const { modal, root } = fixture({ authenticatorAvailable: () => false });
    modal.requestConfirmation({
      requestId: 'req-4', kind: 'return' as const, orderId: 'ORD-1043', itemId: 'IT-1',
      reason: 'defect' as const,
      eligibility: { eligible: true, path: 'warranty', because: ['Within warranty.'] },
    }, 'confirm_return');
    // Being told this device cannot confirm is not a reason to stop saying what it was
    // that could not be confirmed.
    expect(subjectText(root)).toContain('ORD-1043');
  });
});
