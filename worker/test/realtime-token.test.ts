import { describe, it, expect, afterEach, vi } from 'vitest';
import worker from '../src/index';

/**
 * Regression coverage for /api/realtime-token. This exists because the endpoint shipped
 * calling https://api.openai.com/v1/realtime/sessions, which OpenAI retired — it now
 * 404s "Invalid URL" for every caller, so the text-mode Realtime session could not start
 * every other test stayed green. Nothing here mocked the upstream call, so nothing
 * caught it. These tests pin the two things that broke: WHICH url is called, and that
 * the response is normalized to the shape session.ts consumes rather than relayed
 * verbatim (the replacement endpoint returns `value` at the top level, not
 * `client_secret.value`).
 *
 * Same technique as the other files here: call the exported handler directly, no
 * miniflare. Only global fetch is stubbed, since that is the boundary under test.
 */
const EXPECTED_ORIGIN = 'http://localhost:3000';

function env() {
  return {
    OPENAI_API_KEY: 'sk-test', REALTIME_MODEL: 'gpt-realtime',
    RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN,
    KV: {} as any, NOW: 1_700_000_000_000,
  };
}

async function mint(origin: string | null = EXPECTED_ORIGIN) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (origin !== null) headers.origin = origin;
  const req = new Request('http://localhost/api/realtime-token', { method: 'POST', headers });
  const res = await worker.fetch(req, env() as any);
  return { status: res.status, body: await res.json() as any };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('/api/realtime-token', () => {
  it('mints a GA Realtime client secret with the media configuration required by the WebRTC handshake', async () => {
    const seen: { url: string; body: any } = { url: '', body: null };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      seen.url = url;
      seen.body = JSON.parse(init.body);
      return new Response(JSON.stringify({ value: 'ek_abc', expires_at: 1 }), { status: 200 });
    }));

    const { status, body } = await mint();

    expect(status).toBe(200);
    expect(seen.url).toBe('https://api.openai.com/v1/realtime/client_secrets');
    expect(seen.body).toEqual({
      session: { type: 'realtime', model: 'gpt-realtime', audio: { output: { voice: 'alloy' } } },
    });
    // The contract session.ts reads. Upstream returns `value` at the top level; if this
    // ever relays verbatim again, the WebRTC handshake reads undefined and cannot start.
    expect(body).toEqual({ client_secret: { value: 'ek_abc' }, model: 'gpt-realtime' });
  });

  it('502s without relaying the upstream body when the mint fails — that body can embed a partially-redacted key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'Incorrect API key provided: sk-abc****xyz' } }), { status: 401 })));

    const { status, body } = await mint();

    expect(status).toBe(502);
    expect(body).toEqual({ error: 'token_mint_failed' });
    expect(JSON.stringify(body)).not.toContain('sk-abc');
  });

  it('502s when the response carries no usable secret, rather than handing session.ts an undefined bearer token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ expires_at: 1 }), { status: 200 })));

    expect(await mint()).toEqual({ status: 502, body: { error: 'token_mint_failed' } });
  });

  it('refuses a foreign origin before spending the key at all', async () => {
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);

    expect((await mint('https://evil.example')).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});
