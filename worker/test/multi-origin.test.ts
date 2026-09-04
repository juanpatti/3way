import { describe, it, expect } from 'vitest';
import worker from '../src/index';

/**
 * EXPECTED_ORIGIN accepts a comma-separated list so a deployment can answer on two origins
 * at once. That exists for one reason: moving to a new domain otherwise leaves a window
 * where the old origin is already refused and the new one does not resolve yet, which
 * takes the demo down mid-cutover for everybody.
 *
 * Still an exact-match allowlist. A list of two exact origins is a cutover; a pattern is
 * an accident waiting to be found by whoever registers 3way.dev.evil.com.
 */
const NOW = 1_700_000_000_000;
const env = (origins: string) => ({
  OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
  RP_ID: '3way.dev', RP_NAME: '3way', EXPECTED_ORIGIN: origins,
  KV: { get: async () => null, put: async () => {}, delete: async () => {} },
  NOW,
});

const post = async (origins: string, origin: string | null) => {
  const res = await worker.fetch(new Request('http://localhost/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify({ deviceId: 'dev-1' }),
  }), env(origins) as any);
  return { status: res.status, cors: res.headers.get('access-control-allow-origin') };
};

const BOTH = 'https://3way.dev, https://halden-3way.pages.dev';

describe('a two-origin cutover', () => {
  it('accepts the new domain', async () => {
    expect((await post(BOTH, 'https://3way.dev')).status).toBe(200);
  });

  it('still accepts the old one, so nothing breaks while DNS propagates', async () => {
    expect((await post(BOTH, 'https://halden-3way.pages.dev')).status).toBe(200);
  });

  it('echoes the CALLER’s origin back, never the list', async () => {
    // A comma-joined Access-Control-Allow-Origin is not a valid header value; a browser
    // would reject every response.
    const r = await post(BOTH, 'https://3way.dev');
    expect(r.cors).toBe('https://3way.dev');
    expect(r.cors).not.toContain(',');
  });

  it('tolerates whitespace around the separator', async () => {
    expect((await post('https://a.example ,  https://b.example', 'https://b.example')).status).toBe(200);
  });
});

describe('a list is still an allowlist', () => {
  it.each([
    ['an origin on neither entry', 'https://evil.example'],
    ['a lookalike suffix', 'https://3way.dev.evil.example'],
    ['a prefix of a listed origin', 'https://3way.de'],
    ['http where https is listed', 'http://3way.dev'],
  ])('refuses %s', async (_label, origin) => {
    expect((await post(BOTH, origin)).status).toBe(403);
  });

  it('refuses a request with no Origin header at all', async () => {
    expect((await post(BOTH, null)).status).toBe(403);
  });

  it('a single origin behaves exactly as it did before the list existed', async () => {
    expect((await post('https://3way.dev', 'https://3way.dev')).status).toBe(200);
    expect((await post('https://3way.dev', 'https://halden-3way.pages.dev')).status).toBe(403);
  });
});
