// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readAttributes, fetchConfig, autoMount } from '../src/autoMount';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';

/**
 * The one-tag embed. Two script tags in a load-bearing order plus a hand-written mount()
 * call is a demo; one tag is a product someone else can install.
 *
 * The reason this needs a fetch rather than more attributes: mount() requires a policy —
 * prose plus rules — and those are objects, while an attribute is a string. Moving them
 * server-side is the only honest route to one tag, and it is where they belonged anyway:
 * the Worker is already the authoritative gate's source of truth for the same rules, so
 * one copy is what stops a page showing a person one policy while /api/act enforces
 * another.
 *
 * The load-bearing behaviour under test is the FAILURE path. A widget that cannot reach
 * its config must mount nothing and say so — rendering with a default policy would show a
 * person terms that are not the store's, beside a gate enforcing terms that are.
 */
const CONFIG = {
  policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
  stances: undefined,
  stance: 'policy-bound',
  storeAgentName: 'Halden Support',
};

const tag = (attrs: Record<string, string>) => {
  const el = document.createElement('script');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const ok = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

afterEach(() => { vi.restoreAllMocks(); });

describe('readAttributes', () => {
  it('returns null without data-3way-api, so a hand-mounted page is left alone', () => {
    expect(readAttributes(tag({ 'data-3way-store': 'Halden' }))).toBeNull();
    expect(readAttributes(null)).toBeNull();
  });

  it('reads every supported attribute', () => {
    expect(readAttributes(tag({
      'data-3way-api': 'https://api.example.com',
      'data-3way-store': 'Halden Support',
      'data-3way-user': 'Alex Rivera',
      'data-3way-stance': 'concierge',
      'data-3way-tenant': 'clinic-preview',
    }))).toEqual({
      apiBase: 'https://api.example.com',
      storeAgentName: 'Halden Support',
      userName: 'Alex Rivera',
      stance: 'concierge',
      tenant: 'clinic-preview',
      composer: false,
    });
  });

  it('strips a trailing slash, so an author cannot produce //api/config', () => {
    expect(readAttributes(tag({ 'data-3way-api': 'https://api.example.com//' }))!.apiBase)
      .toBe('https://api.example.com');
  });

  it('treats blank attributes as absent rather than as empty strings', () => {
    const got = readAttributes(tag({ 'data-3way-api': ' https://api.example.com ', 'data-3way-store': '   ' }));
    expect(got!.apiBase).toBe('https://api.example.com');
    expect(got!.storeAgentName).toBeUndefined();
  });

  it('selects Composer mode from data-3way-input="composer"', () => {
    expect(readAttributes(tag({ 'data-3way-api': 'https://api.x', 'data-3way-input': 'composer' })))
      .toMatchObject({ composer: true });
  });

  it('defaults to Keyholder mode (composer false) without the attribute or on any other value', () => {
    expect(readAttributes(tag({ 'data-3way-api': 'https://api.x' })))
      .toMatchObject({ composer: false });
    expect(readAttributes(tag({ 'data-3way-api': 'https://api.x', 'data-3way-input': 'keyholder' })))
      .toMatchObject({ composer: false });
  });
});

describe('fetchConfig', () => {
  it('requests /api/config, and adds the tenant only when there is one', async () => {
    const f = ok(CONFIG);
    await fetchConfig('https://api.example.com', undefined, f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('https://api.example.com/api/config');
    await fetchConfig('https://api.example.com', 'clinic-preview', f as unknown as typeof fetch);
    expect(f).toHaveBeenLastCalledWith('https://api.example.com/api/config?tenant=clinic-preview');
  });

  it('returns the config when it is usable', async () => {
    const got = await fetchConfig('https://x', undefined, ok(CONFIG) as unknown as typeof fetch);
    expect(got!.policy.rules.returnWindowDays).toBe(POLICY_RULES.returnWindowDays);
  });

  it.each([
    ['a non-2xx response', vi.fn(async () => new Response('nope', { status: 502 }))],
    ['a body with no policy', vi.fn(async () => new Response('{"stance":"policy-bound"}', { status: 200 }))],
    ['a policy with no rules', vi.fn(async () => new Response('{"policy":{"prose":"x"}}', { status: 200 }))],
    ['unreachable', vi.fn(async () => { throw new Error('offline'); })],
  ])('returns null and complains loudly on %s', async (_label, f) => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await fetchConfig('https://x', undefined, f as unknown as typeof fetch)).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe('autoMount', () => {
  it('mounts nothing when the config cannot be fetched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn(async () => new Response('', { status: 500 }));
    const el = tag({ 'data-3way-api': 'https://api.example.com' });
    expect(await autoMount(el, f as unknown as typeof fetch)).toBeNull();
    // Nothing rendered: a silent default-policy mount is the failure mode this prevents.
    expect(document.querySelector('div')).toBeNull();
  });

  it('does nothing at all on a page that mounts by hand', async () => {
    const f = vi.fn();
    expect(await autoMount(tag({}), f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});
