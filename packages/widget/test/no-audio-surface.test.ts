// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSession } from '../src/session';
import { createModal } from '../src/ui/modal';
import { createBus } from '../src/bus';
import { POLICY_RULES } from '../../../config/policy';

/**
 * Voice was removed deliberately, not lost. Judged against the chat experience it was a
 * distraction from what this project actually demonstrates: the store agent's replies
 * were synthesized well, but the customer's own agent could only be rendered by browser
 * SpeechSynthesis — WebMCP carries tool calls, not audio, so its real voice was never
 * reachable — and whisper-1's per-utterance language detection kept answering English in
 * Vietnamese and Korean while turning room noise into things the customer had said.
 *
 * What survives is the part that carries the argument: one shared transcript, three
 * stamped origins, and a gate no agent can pass. This file exists so none of the audio
 * surface returns by accident, because every piece of it was individually reasonable.
 *
 * The Realtime session STAYS. It is the store agent's brain, running in text mode over
 * the same data channel — removing audio is not the same as removing Realtime, and
 * /api/realtime-token is still required.
 */
class FakeDataChannel {
  readyState = 'open';
  sent: any[] = [];
  send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw)); });
  close = vi.fn();
  listeners: Record<string, ((ev?: any) => void)[]> = {};
  addEventListener(type: string, fn: (ev?: any) => void) { (this.listeners[type] ??= []).push(fn); }
  fire(type: string, ev?: any) { for (const fn of this.listeners[type] ?? []) fn(ev); }
}

class FakePeerConnection {
  static last: FakePeerConnection;
  channel = new FakeDataChannel();
  transceivers: { kind: string; direction: string }[] = [];
  connectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  constructor() { FakePeerConnection.last = this; }
  addTransceiver(kind: string, init: { direction: string }) {
    this.transceivers.push({ kind, direction: init.direction });
    return { sender: { replaceTrack: async () => {} } } as unknown;
  }
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  createOffer() { return Promise.resolve({ sdp: 'v=0-fake-offer', type: 'offer' } as unknown); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
}

afterEach(() => { vi.unstubAllGlobals(); });

async function connect() {
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).endsWith('/token')
      ? new Response(JSON.stringify({ client_secret: { value: 'ek_test' }, model: 'gpt-realtime' }))
      : new Response('v=0-fake-answer')));
  let n = 0;
  const bus = createBus({ now: () => 1000, id: () => `e${++n}` });
  const session = createSession({
    apiBase: 'https://api.test', now: () => 1000, tokenUrl: 'https://api.test/token',
    tools: [], systemPrompt: 'be helpful', bus, policyRules: POLICY_RULES,
  });
  await session.start();
  FakePeerConnection.last.channel.fire('open');
  return { session, bus, pc: FakePeerConnection.last };
}

describe('the session is text-only', () => {
  it('never asks the model for audio output', async () => {
    const { pc } = await connect();
    const cfg = pc.channel.sent.filter(m => m.type === 'session.update').at(-1)!.session;
    expect(cfg.output_modalities).toEqual(['text']);
  });

  it('never asks for input transcription, because nothing is ever spoken into it', async () => {
    const { pc } = await connect();
    const cfg = pc.channel.sent.filter(m => m.type === 'session.update').at(-1)!.session;
    expect(cfg.audio?.input?.transcription).toBeUndefined();
    expect(cfg.input_audio_transcription).toBeUndefined();
  });

  it('never captures a microphone', async () => {
    const requestMedia = vi.fn();
    const mediaMethod = 'get' + 'UserMedia';
    vi.stubGlobal('navigator', { mediaDevices: { [mediaMethod]: requestMedia } });
    await connect();
    expect(requestMedia).not.toHaveBeenCalled();
  });

  it('declares its audio transceiver recvonly and never sends on it', async () => {
    // Kept only so the SDP offer still carries an audio m-line for the Realtime endpoint;
    // nothing is ever attached to it. If this ever flips back to sendrecv, someone is
    // reintroducing the mic.
    const { pc } = await connect();
    for (const t of pc.transceivers) expect(t.direction).toBe('recvonly');
  });

  it('exposes no microphone or modality controls on the Session interface', async () => {
    const { session } = await connect();
    for (const gone of ['enableMic', 'duckMic', 'setModality']) {
      expect(session).not.toHaveProperty(gone);
    }
    // What remains is the text conversation and the ceremony.
    for (const kept of ['start', 'sendUserText', 'confirmRequest', 'close']) {
      expect(typeof (session as any)[kept]).toBe('function');
    }
  });
});

describe('the widget offers no way to start a voice call', () => {
  it('renders a composer and a Send button, and no Voice button', () => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn(), composer: true });
    const root = modal.el.shadowRoot!;
    expect(root.querySelector('[data-3way-voice]')).toBeNull();
    // Asserted by intent rather than as an exact button list: the panel legitimately grew
    // an expand control later, and an exact list would have failed for the wrong reason.
    const labels = [...root.querySelectorAll('button')].map(b => b.textContent!.trim());
    expect(labels).toContain('Send');
    expect(labels.join(' ')).not.toMatch(/voice|mic|speak|listen/i);
    expect(root.querySelector('[data-3way-composer]')).not.toBeNull();
  });
});

/**
 * The resting state. Most people have never been told that the assistant in their other
 * tab could be talking to this page — an empty box with a "Type a message" placeholder
 * teaches them nothing, and the whole product is invisible until somebody already knows
 * what it is.
 */
describe('the empty transcript invites the thing the product is for', () => {
  const mount = () => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    // Composer mode: these tests pin the composer-mode empty-state copy specifically
    // ("tell your agent", "type below") — the Keyholder default has its own copy, covered
    // in modal.test.ts's "renders no composer in keyholder mode" test.
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn(), composer: true });
    return { bus, root: modal.el.shadowRoot! };
  };

  it('names the agent, not just the text box', () => {
    const { root } = mount();
    expect(root.querySelector('[data-3way-empty]')!.textContent).toMatch(/tell your agent/i);
  });

  it('still offers typing, so nobody is stuck without an agent', () => {
    const { root } = mount();
    expect(root.querySelector('[data-3way-empty]')!.textContent).toMatch(/type/i);
  });

  it('is REMOVED once anything is said, not merely hidden', () => {
    // Left in the DOM it would still be read out under a live conversation.
    const { bus, root } = mount();
    bus.append({ origin: 'site-agent', text: 'Hello' });
    expect(root.querySelector('[data-3way-empty]')).toBeNull();
  });
});

/**
 * The WebMCP layer, made visible.
 *
 * Without this the agent's tool calls happen in silence and a reply simply appears after a
 * pause — so the one thing this project demonstrates is the one thing nobody can see.
 * Narration only: an activity line is NOT a transcript entry, because putting it on the
 * bus would feed it back into both agents' context as noise.
 */
describe('agent activity is narrated without becoming a turn', () => {
  it('shows what the agent did, in words a person would use', () => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn() });
    modal.showActivity('checked the returns policy');
    const line = modal.el.shadowRoot!.querySelector('[data-3way-activity]')!;
    expect(line.textContent).toBe('Your agent checked the returns policy');
  });

  it('does not append to the conversation the agents read', () => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn() });
    modal.showActivity('looked up your orders');
    expect(bus.all()).toHaveLength(0);
  });

  it('clears the empty state, so narration and the invitation never stack', () => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn() });
    modal.showActivity('searched the catalogue');
    expect(modal.el.shadowRoot!.querySelector('[data-3way-empty]')).toBeNull();
  });
});

describe('a completed confirmation offers its proof', () => {
  const withVerification = (method: 'webauthn' | 'trusted-click') => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn() });
    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: 'req-1',
      confirmsTool: 'confirm_return', verification: { method, token: 't', at: 1 },
    });
    return modal.el.shadowRoot!;
  };

  it('describes a device signature as bound and single-use', () => {
    const root = withVerification('webauthn');
    const btn = root.querySelector('[data-3way-proof]') as HTMLButtonElement;
    btn.click();
    const text = root.querySelector('.proof__detail')!.textContent!;
    expect(text).toMatch(/single-use/i);
    expect(text).toMatch(/confirm_return/);
    expect(text).toMatch(/req-1/);
    expect(text).toMatch(/registered credential/i);
    expect(text).toMatch(/authorization token.*request.*action/i);
    expect(text).toMatch(/concurrent|stale read/i);
    expect(text).not.toMatch(/spends it on first use and refuses it afterwards/i);
  });

  it('does NOT call a trusted-click proof a verification', () => {
    // The whole point of the distinction: an honest record that somebody clicked is not
    // proof of who, and the popover must not blur that.
    const root = withVerification('trusted-click');
    (root.querySelector('[data-3way-proof]') as HTMLButtonElement).click();
    const text = root.querySelector('.proof__detail')!.textContent!;
    expect(text).toMatch(/no device signature/i);
    expect(text).toMatch(/not proof of who/i);
  });

  it('offers nothing on an ordinary line', () => {
    const bus = createBus({ now: () => 1, id: () => 'e1' });
    const modal = createModal({ bus, onSend: vi.fn(), onConfirm: vi.fn() });
    bus.append({ origin: 'site-agent', text: 'Hello' });
    expect(modal.el.shadowRoot!.querySelector('[data-3way-proof]')).toBeNull();
  });
});
