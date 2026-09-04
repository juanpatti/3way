import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSession } from '../src/session';
import { createBus } from '../src/bus';
import { POLICY_RULES } from '../../../config/policy';

/**
 * Pins the two wire shapes this widget sends to OpenAI. Both were written from stale
 * knowledge of the beta API and shipped dead — the token mint 404'd, the SDP POST 400'd
 * with "The Realtime Beta API is no longer supported. Please use /v1/realtime/calls for
 * the GA API." — while every other test passed, because nothing asserted either one.
 *
 * These are deliberately literal. A future rename should fail here, loudly, instead of on
 * a live page where the only symptom is a chat box that never answers.
 */
class FakeDataChannel {
  readyState = 'open';
  sent: any[] = [];
  send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw)); });
  close = vi.fn();
  listeners: Record<string, (() => void)[]> = {};
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  fire(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

class FakePeerConnection {
  static last: FakePeerConnection;
  channel = new FakeDataChannel();
  connectionState = 'new';
  ontrack: unknown;
  onconnectionstatechange: (() => void) | null = null;
  close = vi.fn();
  constructor() { FakePeerConnection.last = this; }
  addTransceiver() { return { sender: { replaceTrack: async () => {} } } as unknown; }
  createDataChannel() { return this.channel as unknown as RTCDataChannel; }
  createOffer() { return Promise.resolve({ sdp: 'v=0-fake-offer', type: 'offer' } as unknown); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
}

afterEach(() => { vi.unstubAllGlobals(); });

async function connect() {
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection as unknown as typeof RTCPeerConnection);
  vi.stubGlobal('Audio', class { autoplay = false; srcObject: unknown; } as unknown as typeof Audio);

  const calls: { url: string; init: any }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/token')) {
      return new Response(JSON.stringify({ client_secret: { value: 'ek_test' }, model: 'gpt-realtime' }));
    }
    return new Response('v=0-fake-answer');
  }));

  const bus = createBus({ now: () => 1000, id: () => 'e1' });
  const session = createSession({
    apiBase: 'https://api.test', now: () => 1000, tokenUrl: 'https://api.test/token',
    tools: [], systemPrompt: 'be helpful', bus, policyRules: POLICY_RULES,
  });
  await session.start();
  FakePeerConnection.last.channel.fire('open');
  return { calls, channel: FakePeerConnection.last.channel, session, bus };
}

describe('Realtime GA wire shape', () => {
  it('POSTs the SDP offer to /v1/realtime/calls — the beta /v1/realtime endpoint is retired and 400s', async () => {
    const { calls } = await connect();
    const sdpCall = calls.find(c => c.url.includes('api.openai.com'));

    expect(sdpCall?.url).toBe('https://api.openai.com/v1/realtime/calls?model=gpt-realtime');
    expect(sdpCall?.init.headers['content-type']).toBe('application/sdp');
    expect(sdpCall?.init.headers.authorization).toBe('Bearer ek_test');
  });

  it("sends a GA session.update: session.type present, output_modalities (not beta's modalities) carrying exactly one value", async () => {
    const { channel } = await connect();
    const update = channel.sent.find(m => m.type === 'session.update');

    expect(update.session.type).toBe('realtime');
    expect(update.session.output_modalities).toEqual(['text']);
    // The beta field name. Sending it to GA is silently ignored, which is worse than an error.
    expect(update.session).not.toHaveProperty('modalities');
  });

  it("records the agent's turn from the GA transcript event name as well as the beta one", async () => {
    for (const type of ['response.output_audio_transcript.done', 'response.audio_transcript.done', 'response.output_text.done']) {
      const { channel, bus } = await connect();
      const onMessage = channel.listeners['message']?.[0] as unknown as (e: MessageEvent) => void;
      await onMessage({ data: JSON.stringify({ type, transcript: 'hello', text: 'hello' }) } as MessageEvent);

      expect(bus.all().filter(e => e.origin === 'site-agent').map(e => e.text)).toContain('hello');
    }
  });
});

describe('what reaches the model, and what does not', () => {
  // Observed live: the store agent asked for a confirmation directly underneath its own
  // "Return confirmed and refund issued" line. Two causes, both here.
  it('forwards a TOOL-authored site-agent line as context — the model never wrote it and otherwise contradicts it', async () => {
    const { channel, bus } = await connect();
    channel.sent.length = 0;

    bus.append({ origin: 'site-agent', text: 'Return confirmed and refund issued.', authoredByTool: true });

    const items = channel.sent.filter(m => m.type === 'conversation.item.create');
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items[0])).toContain('Return confirmed and refund issued.');
    // Context only. The tool's line IS the turn; asking for another produces the echo.
    expect(channel.sent.filter(m => m.type === 'response.create')).toHaveLength(0);
  });

  it('still skips a MODEL-authored site-agent line, which is already in its context', async () => {
    const { channel, bus } = await connect();
    channel.sent.length = 0;

    bus.append({ origin: 'site-agent', text: 'Anything else I can help with?' });

    expect(channel.sent).toHaveLength(0);
  });

  it('does not request a turn for a confirmation — the action it authorises is the answer, and asking races the tool', async () => {
    const { channel, bus } = await connect();
    channel.sent.length = 0;

    bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.',
      confirms: 'req-1', confirmsTool: 'confirm_return',
    });

    // The confirmation still reaches the model's context...
    expect(channel.sent.filter(m => m.type === 'conversation.item.create')).toHaveLength(1);
    // ...but does not prompt a reply asking for the confirmation that just happened.
    expect(channel.sent.filter(m => m.type === 'response.create')).toHaveLength(0);
  });

  it('an ordinary human turn still gets a response requested — the suppression is scoped to confirmations', async () => {
    const { channel, bus } = await connect();
    channel.sent.length = 0;

    bus.append({ origin: 'human-direct', text: 'Where is my order?' });

    expect(channel.sent.filter(m => m.type === 'response.create')).toHaveLength(1);
  });
});
