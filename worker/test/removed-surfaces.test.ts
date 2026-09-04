import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';

const env = {
  OPENAI_API_KEY: 'sk-test', REALTIME_MODEL: 'gpt-realtime',
  RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN: 'http://localhost:3000',
  KV: { get: async () => null, put: async () => {}, delete: async () => {} },
};

afterEach(() => vi.unstubAllGlobals());

describe('removed HTTP surfaces', () => {
  it('does not expose the unused /api/reason proxy or spend an OpenAI request', async () => {
    const upstream = vi.fn(async () =>
      new Response(JSON.stringify({ output_text: 'unused' }), { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    const res = await worker.fetch(new Request('http://localhost/api/reason', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'test' }),
    }), env as any);

    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });
});
