// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHttpDataSource, mount } from '../src/index';
import * as sessionModule from '../src/session';
import * as modalModule from '../src/ui/modal';
import * as toolsModule from '../src/tools';
import { DEFAULT_STANCES } from '../src/stances';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';

const CONFIG = {
  apiBase: 'https://api.test',
  policy: { prose: POLICY_PROSE, rules: POLICY_RULES },
  stance: 'policy-bound' as const,
  autoStart: false,
};

const DAY = 86_400_000;
const ORDER = {
  orderId: 'ORD-1', placedAt: Date.now() - 10 * DAY, deliveredAt: Date.now() - 5 * DAY,
  status: 'delivered', items: [{ itemId: 'IT-1', sku: 'SKU-1', title: 'Lamp', price: 1000 }],
};
const FAKE_CRED = {
  id: 'abc', rawId: new Uint8Array([1, 2, 3]).buffer, type: 'public-key',
  response: {
    clientDataJSON: new Uint8Array([4]).buffer,
    authenticatorData: new Uint8Array([5]).buffer,
    signature: new Uint8Array([6]).buffer,
    userHandle: null,
  },
};

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"orders":[],"products":[]}')));
});

describe('mount', () => {
  it('mounts without a model context and does not throw (Tier 1)', () => {
    expect(() => mount(CONFIG)).not.toThrow();
    expect(document.body.children.length).toBe(1);
  });

  it('never surfaces a capability error to the human when WebMCP is absent', () => {
    mount(CONFIG);
    expect(document.body.textContent ?? '').not.toMatch(/webmcp|not supported|unavailable/i);
  });

  it('registers every tool when a model context exists', () => {
    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    mount(CONFIG);
    expect(registerTool.mock.calls.length).toBe(18);
    delete (document as any).modelContext;
  });

  it('mints requestIds that do not collide across two independent mounts (two visitors on the same live URL)', async () => {
    // Both mounts start their own `seq` counter at 1, so a bare `req-${seq}` scheme would
    // mint the IDENTICAL id here — the exact collision that let one visitor's /options
    // overwrite another's mid-ceremony (the Worker keys challenges/tokens globally by
    // requestId, not per-visitor). newRequestId must suffix something that differs.
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).endsWith('/api/orders')
        ? new Response(JSON.stringify({ orders: [ORDER] }))
        : new Response('{"orders":[],"products":[]}')));
    const registerToolA = vi.fn();
    (document as any).modelContext = { registerTool: registerToolA };
    const handleA = mount(CONFIG);
    const requestReturnA = registerToolA.mock.calls.find((c: any) => c[0].name === 'request_return')![0];
    const resA = await requestReturnA.execute({ orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' }) as any;
    handleA.destroy();
    delete (document as any).modelContext;

    const registerToolB = vi.fn();
    (document as any).modelContext = { registerTool: registerToolB };
    const handleB = mount(CONFIG);
    const requestReturnB = registerToolB.mock.calls.find((c: any) => c[0].name === 'request_return')![0];
    const resB = await requestReturnB.execute({ orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' }) as any;
    handleB.destroy();
    delete (document as any).modelContext;

    expect(resA.requestId).not.toBe(resB.requestId);
  });

  it("gives the store's own agent a narrower tool list than the visiting agent — no " +
    'send_message, no provide_context', () => {
    // The other direction (visiting agent gets everything) is already covered by the
    // 18-tool registerTool assertion above. This is the direction that actually matters:
    // if the store's own agent ever got the unscoped list, it could hold send_message
    // and provide_context and talk to itself under the visitor's attribution.
    const spy = vi.spyOn(sessionModule, 'createSession');
    mount(CONFIG);
    const opts = spy.mock.calls.at(-1)![0];
    const names = opts.tools.map(t => t.name).sort();
    expect(names).toHaveLength(15);
    expect(names).not.toContain('send_message');
    expect(names).not.toContain('provide_context');
    spy.mockRestore();
  });

  it("threads a tenant's own stance presets into the assembled system prompt — the seam " +
    'config/stances.ts exists for', () => {
    const spy = vi.spyOn(sessionModule, 'createSession');
    const stances = {
      'policy-bound': 'CUSTOM STANCE TEXT', concierge: 'unused', 'advocate-adversarial': 'unused',
    } as const;
    mount({ ...CONFIG, stances });
    const opts = spy.mock.calls.at(-1)![0];
    expect(opts.systemPrompt).toContain('CUSTOM STANCE TEXT');
    spy.mockRestore();
  });

  it('threads userName into the assembled system prompt — it used to be declared and read nowhere', () => {
    const spy = vi.spyOn(sessionModule, 'createSession');
    mount({ ...CONFIG, userName: 'Alex Rivera' });
    const opts = spy.mock.calls.at(-1)![0];
    expect(opts.systemPrompt).toContain('Alex Rivera');
    spy.mockRestore();
  });

  it('threads storeAgentName into the modal instead of a bundle-wide hardcoded name', () => {
    const spy = vi.spyOn(modalModule, 'createModal');
    mount({ ...CONFIG, storeAgentName: 'Acme Support' });
    const opts = spy.mock.calls.at(-1)![0];
    expect(opts.storeAgentLabel).toBe('Acme Support');
    spy.mockRestore();
  });

  it('renders keyholder mode by default (no composer)', () => {
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    mount(CONFIG);
    expect(modalSpy).toHaveBeenCalledWith(expect.objectContaining({ composer: false }));
    modalSpy.mockRestore();
  });

  it('passes composer through to the modal when Composer mode is selected', () => {
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    mount({ ...CONFIG, composer: true });
    expect(modalSpy).toHaveBeenCalledWith(expect.objectContaining({ composer: true }));
    modalSpy.mockRestore();
  });

  it("falls back to the library's default stances when a tenant supplies none", () => {
    const spy = vi.spyOn(sessionModule, 'createSession');
    mount(CONFIG);
    const opts = spy.mock.calls.at(-1)![0];
    expect(opts.systemPrompt).toContain(DEFAULT_STANCES['policy-bound']);
    spy.mockRestore();
  });

  it('reports which surface it found, for the compatibility table', () => {
    (document as any).modelContext = { registerTool: vi.fn() };
    expect(mount(CONFIG).surface).toBe('document');
    delete (document as any).modelContext;
  });

  it('reports "none" in Tier 1', () => {
    expect(mount(CONFIG).surface).toBe('none');
  });

  it('exposes authenticator availability for the confirm affordance to read', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
    });
    const h = mount(CONFIG);
    await vi.waitFor(() => expect(h.authenticator).toBe(false));
  });

  it('retries a failed session start instead of dying silently', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    mount({ ...CONFIG, autoStart: true });
    const before = (globalThis.fetch as any).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_100);
    expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(before);
    vi.useRealTimers();
  });

  it('destroy removes the widget from the page', () => {
    const h = mount(CONFIG);
    h.destroy();
    expect(document.body.children.length).toBe(0);
  });

  it('destroy clears the pending retry timer so a later tick cannot revive a closed session', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const h = mount({ ...CONFIG, autoStart: true });
    // Let the first attempt fail and its retry get scheduled, then destroy before it fires.
    await vi.advanceTimersByTimeAsync(0);
    const callsAtDestroy = (globalThis.fetch as any).mock.calls.length;
    h.destroy();
    await vi.advanceTimersByTimeAsync(30_000);
    expect((globalThis.fetch as any).mock.calls.length).toBe(callsAtDestroy);
    vi.useRealTimers();
  });

  it('destroy clears a retained sensitive receipt from the mounted gateway', async () => {
    const records = {
      paymentBrand: 'Visa', paymentLast4: '6411', billingPostcode: 'N1 7QT',
      deliveredTo: '14 Ashfield Road, London',
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/orders')) return new Response(JSON.stringify({ orders: [ORDER] }));
      if (u.endsWith('/api/act')) return new Response(JSON.stringify({ ok: true, records }));
      return new Response('{"orders":[],"products":[]}');
    }));
    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    const handle = mount(CONFIG);
    const descriptor = (name: string) =>
      registerTool.mock.calls.find((c: any) => c[0].name === name)![0];
    const made = await descriptor('request_records_release').execute({ orderId: 'ORD-1' }) as any;
    const sessionInstance = sessionSpy.mock.results.at(-1)!.value as any;
    const sessionOpts = sessionSpy.mock.calls.at(-1)![0];
    sessionInstance.confirmRequest = vi.fn(async (requestId: string, tool: string) => {
      sessionOpts.bus.append({
        origin: 'human-direct', text: 'Yes, I confirm.', confirms: requestId, confirmsTool: tool,
        verification: { method: 'webauthn', token: 'tok', at: 1 },
      });
      return { method: 'webauthn' as const, token: 'tok', at: 1 };
    });
    await modalSpy.mock.calls.at(-1)![0].onConfirm(
      made.requestId, 'disclose_order_records', { orderId: 'ORD-1', itemId: '', reason: null });

    handle.destroy();
    const staleDescriptorResult = await descriptor('disclose_order_records')
      .execute({ requestId: made.requestId }) as any;
    expect(staleDescriptorResult.records).toBeUndefined();
    expect(JSON.stringify(staleDescriptorResult)).not.toMatch(/6411|N1 7QT|14 Ashfield Road/);
    expect(staleDescriptorResult.message).toMatch(/no pending request or retained result/i);

    delete (document as any).modelContext;
    modalSpy.mockRestore();
    sessionSpy.mockRestore();
  });

  it("binds the eligibility triple to the ceremony at /options time, and sends /api/act " +
    'exactly what the hardened Worker now accepts', async () => {
    vi.stubGlobal('PublicKeyCredential', {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
    });
    vi.stubGlobal('navigator', {
      ...globalThis.navigator,
      credentials: { get: vi.fn(async () => FAKE_CRED), create: vi.fn(async () => FAKE_CRED) },
    });
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/orders')) return new Response(JSON.stringify({ orders: [ORDER] }));
      if (u.endsWith('/api/webauthn/options')) {
        return new Response(JSON.stringify(
          { mode: 'authenticate', publicKey: { challenge: 'AQID', allowCredentials: [] } }));
      }
      if (u.endsWith('/api/webauthn/verify')) return new Response(JSON.stringify({ token: 'srv-tok' }));
      if (u.endsWith('/api/act')) {
        return new Response(JSON.stringify({ ok: true, tool: 'confirm_return', requestId: 'req-1', refunded: true }));
      }
      return new Response('{"orders":[],"products":[]}');
    });
    vi.stubGlobal('fetch', fetchMock);

    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const handle = mount(CONFIG);
    const descriptor = (name: string) =>
      registerTool.mock.calls.find((c: any) => c[0].name === name)![0];

    const req = await descriptor('request_return')
      .execute({ orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' }) as any;
    // Use the modal's human-direct path: registered WebMCP consumers may file and later
    // read their receipt, but must never become the executor merely because the shared
    // transcript now contains a confirmation.
    await modalSpy.mock.calls.at(-1)![0].onConfirm(
      req.requestId, 'confirm_return', { orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' });

    // The eligibility triple is bound to the ceremony HERE, at /options time — not later
    // at /api/act. A page must commit to the specific claim before the person
    // authenticates; there is no second chance to supply or correct it afterward
    // (worker/src/index.ts's /options handler). A regression that drops these fields at
    // the onConfirm boundary would 400 missing_eligibility_fields on the real Worker
    // without this test ever noticing, since the mock above answers unconditionally.
    const optionsCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/webauthn/options'));
    expect(optionsCall).toBeDefined();
    const optionsBody = JSON.parse(String((optionsCall as any)[1].body));
    expect(optionsBody).toMatchObject({
      requestId: req.requestId, tool: 'confirm_return',
      orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect',
    });
    expect(optionsBody.deviceId).toBeTypeOf('string');

    // /api/act no longer accepts or needs the triple — the Worker reads it from the token
    // record it wrote at /options time. Sending it here again would be dead weight.
    const actCall = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/act'));
    expect(actCall).toBeDefined();
    const actBody = JSON.parse(String((actCall as any)[1].body));
    expect(Object.keys(actBody).sort()).toEqual(['requestId', 'token', 'tool'].sort());
    expect(actBody).toMatchObject({ tool: 'confirm_return', requestId: req.requestId });
    expect(actBody.token).toBeTypeOf('string');

    handle.destroy();
    delete (document as any).modelContext;
    modalSpy.mockRestore();
  });
});

describe('createHttpDataSource tenant hook', () => {
  it('appends tenant to /api/orders and /api/products so one Worker can serve a second store', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('{"orders":[],"products":[]}'));
    vi.stubGlobal('fetch', fetchMock);
    const data = createHttpDataSource('https://api.test', 'north store');
    await data.listOrders();
    await data.searchProducts('lamp');
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls[0]).toBe('https://api.test/api/orders?tenant=north%20store');
    expect(urls[1]).toBe('https://api.test/api/products?q=lamp&tenant=north%20store');
  });

  it('omits tenant entirely when unconfigured, leaving the flagship URLs unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response('{"orders":[],"products":[]}'));
    vi.stubGlobal('fetch', fetchMock);
    const data = createHttpDataSource('https://api.test');
    await data.listOrders();
    await data.searchProducts('lamp');
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls[0]).toBe('https://api.test/api/orders');
    expect(urls[1]).toBe('https://api.test/api/products?q=lamp');
  });
});

describe('a successful confirmation completes the gated action', () => {
  // Observed live: the customer confirmed, the verified entry landed in the transcript,
  // and no refund happened — because re-attempting the tool was left to the store agent's
  // judgment and it chose to explain rather than act. Consent that reaches the log and
  // strands there is the worst resting state there is: the person believes they
  // authorised a refund and none exists.
  it('invokes the gated tool itself once the ceremony resolves ok, rather than waiting for an agent to try again', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/orders')) return new Response(JSON.stringify({ orders: [ORDER] }));
      if (u.endsWith('/api/act')) {
        return new Response(JSON.stringify({
          ok: true, tool: 'confirm_return', requestId: 'server-echo', refunded: true,
        }));
      }
      return new Response('{"orders":[],"products":[]}');
    });
    vi.stubGlobal('fetch', fetchMock);
    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    const handle = mount(CONFIG);

    const modalOpts = modalSpy.mock.calls.at(-1)![0];
    const sessionInstance = sessionSpy.mock.results.at(-1)!.value as any;
    const sessionOpts = sessionSpy.mock.calls.at(-1)![0];
    const requestReturn = registerTool.mock.calls
      .find((c: any) => c[0].name === 'request_return')![0];
    const filed = await requestReturn.execute(
      { orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' }) as any;
    // Preserve the real ceremony's state-changing side effect while replacing only the
    // external WebAuthn work. The old test invented req-1 without filing it, so execution
    // stopped at "No pending request" and the apiBase truthiness assertion proved nothing.
    sessionInstance.confirmRequest = vi.fn(async (requestId: string, tool: string) => {
      sessionOpts.bus.append({
        origin: 'human-direct', text: 'Yes, I confirm.', confirms: requestId, confirmsTool: tool,
        verification: { method: 'webauthn', token: 't', at: 1 },
      });
      return { method: 'webauthn' as const, token: 't', at: 1 };
    });

    const result = await modalOpts.onConfirm(
      filed.requestId, 'confirm_return', { orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' });

    expect(result).toMatchObject({
      ok: true,
      data: { ok: true, terminal: true, outcome: 'completed', requestId: filed.requestId, refunded: true },
    });
    const actCalls = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/api/act'));
    expect(actCalls).toHaveLength(1);
    expect(JSON.parse(String((actCalls[0] as any)[1].body))).toEqual({
      tool: 'confirm_return', requestId: filed.requestId, token: 't',
    });
    expect(sessionInstance.confirmRequest).toHaveBeenCalledWith(
      filed.requestId, 'confirm_return', { orderId: 'ORD-1', itemId: 'IT-1', reason: 'defect' });

    handle.destroy();
    delete (document as any).modelContext;
    modalSpy.mockRestore();
    sessionSpy.mockRestore();
  });

  it('does not invoke the tool when the ceremony fails — a refused confirmation must authorise nothing', async () => {
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    mount(CONFIG);

    const modalOpts = modalSpy.mock.calls.at(-1)![0];
    const sessionInstance = sessionSpy.mock.results.at(-1)!.value as any;
    sessionInstance.confirmRequest = vi.fn(async () => ({ error: 'rejected' }));

    expect(await modalOpts.onConfirm(
      'req-1', 'confirm_return', { orderId: 'ORD-1043', itemId: 'IT-1', reason: 'defect' }))
      .toEqual({ ok: false, reason: 'rejected' });

    modalSpy.mockRestore();
    sessionSpy.mockRestore();
  });

  it('returns the gated tool payload to the modal instead of discarding server-only records', async () => {
    const records = { paymentBrand: 'Visa', paymentLast4: '6411' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/orders')) return new Response(JSON.stringify({ orders: [ORDER] }));
      if (u.endsWith('/api/act')) return new Response(JSON.stringify({ ok: true, records }));
      return new Response('{"orders":[],"products":[]}');
    }));
    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    const handle = mount(CONFIG);
    const requestRecords = registerTool.mock.calls
      .find((c: any) => c[0].name === 'request_records_release')![0];
    const made = await requestRecords.execute({ orderId: 'ORD-1' }) as any;
    const sessionInstance = sessionSpy.mock.results.at(-1)!.value as any;
    sessionInstance.confirmRequest = vi.fn(async () => ({ method: 'webauthn', token: 'tok', at: 1 }));
    sessionSpy.mock.calls.at(-1)![0].bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: made.requestId,
      confirmsTool: 'disclose_order_records',
      verification: { method: 'webauthn', token: 'tok', at: 1 },
    });

    const result = await modalSpy.mock.calls.at(-1)![0].onConfirm(
      made.requestId, 'disclose_order_records',
      { orderId: 'ORD-1', itemId: '', reason: null });
    expect(result).toMatchObject({ ok: true, data: { records } });

    handle.destroy();
    delete (document as any).modelContext;
    modalSpy.mockRestore();
    sessionSpy.mockRestore();
  });

  it('maps a lost /api/act response to the stamped indeterminate outcome', async () => {
    const cancellable = { ...ORDER, deliveredAt: null, status: 'in_transit' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/orders')) return new Response(JSON.stringify({ orders: [cancellable] }));
      if (u.endsWith('/api/act')) throw new Error('response lost after send');
      return new Response('{"orders":[],"products":[]}');
    }));
    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    const handle = mount(CONFIG);
    const requestCancel = registerTool.mock.calls
      .find((c: any) => c[0].name === 'request_cancel')![0];
    const made = await requestCancel.execute({ orderId: 'ORD-1' }) as any;
    const sessionInstance = sessionSpy.mock.results.at(-1)!.value as any;
    sessionInstance.confirmRequest = vi.fn(async () => ({ method: 'webauthn', token: 'tok', at: 1 }));
    sessionSpy.mock.calls.at(-1)![0].bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: made.requestId,
      confirmsTool: 'cancel_order', verification: { method: 'webauthn', token: 'tok', at: 1 },
    });

    const result = await modalSpy.mock.calls.at(-1)![0].onConfirm(
      made.requestId, 'cancel_order', { orderId: 'ORD-1', itemId: '', reason: null });
    expect(result).toEqual({ ok: false, reason: 'action-indeterminate' });

    handle.destroy();
    delete (document as any).modelContext;
    modalSpy.mockRestore();
    sessionSpy.mockRestore();
  });

  it.each([
    ['a 2xx body without ok:true', 200, { cancelled: true }, 'action-indeterminate'],
    ['a 502 response even with refusal-shaped JSON', 502, { ok: false, error: 'upstream' }, 'action-indeterminate'],
    ['an explicit stamped 400 refusal', 400, { ok: false, error: 'invalid_token' }, 'action-failed'],
  ])('classifies %s honestly', async (_label, status, body, expectedReason) => {
    const cancellable = { ...ORDER, deliveredAt: null, status: 'in_transit' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/api/orders')) return new Response(JSON.stringify({ orders: [cancellable] }));
      if (u.endsWith('/api/act')) return new Response(JSON.stringify(body), { status });
      return new Response('{"orders":[],"products":[]}');
    }));
    const registerTool = vi.fn();
    (document as any).modelContext = { registerTool };
    const modalSpy = vi.spyOn(modalModule, 'createModal');
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    const handle = mount(CONFIG);
    const requestCancel = registerTool.mock.calls
      .find((c: any) => c[0].name === 'request_cancel')![0];
    const made = await requestCancel.execute({ orderId: 'ORD-1' }) as any;
    const sessionInstance = sessionSpy.mock.results.at(-1)!.value as any;
    sessionInstance.confirmRequest = vi.fn(async () => ({ method: 'webauthn', token: 'tok', at: 1 }));
    sessionSpy.mock.calls.at(-1)![0].bus.append({
      origin: 'human-direct', text: 'Yes, I confirm.', confirms: made.requestId,
      confirmsTool: 'cancel_order', verification: { method: 'webauthn', token: 'tok', at: 1 },
    });

    const result = await modalSpy.mock.calls.at(-1)![0].onConfirm(
      made.requestId, 'cancel_order', { orderId: 'ORD-1', itemId: '', reason: null });
    expect(result).toEqual({ ok: false, reason: expectedReason });

    handle.destroy();
    delete (document as any).modelContext;
    modalSpy.mockRestore();
    sessionSpy.mockRestore();
  });
});

describe('the domain flag selects the prompt, not only the tools', () => {
  it('gives the clinic its own system prompt instead of the shop\'s', () => {
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    mount({ ...CONFIG, domain: 'clinic' } as any);
    const prompt = sessionSpy.mock.calls.at(-1)![0].systemPrompt;

    // The substitution used to swap createTools for createClinicTools and leave this on
    // buildSystemPrompt, so the records desk was briefed as a store and pointed at
    // list_my_orders — a tool its registry does not contain.
    expect(prompt).toContain('You are the records desk for this clinic');
    expect(prompt).not.toContain('customer service agent for this store');
    expect(prompt).not.toContain('list_my_orders');
    sessionSpy.mockRestore();
  });

  it('leaves the shop on the shop prompt', () => {
    const sessionSpy = vi.spyOn(sessionModule, 'createSession');
    mount(CONFIG);
    const prompt = sessionSpy.mock.calls.at(-1)![0].systemPrompt;
    expect(prompt).toContain('You are the customer service agent for this store');
    expect(prompt).toContain('list_my_orders');
    sessionSpy.mockRestore();
  });
});

describe('the deployed widget holds the line for the visiting agent', () => {
  // The gateway defaults the hold to OFF so every hand-built fixture answers at once;
  // mount() is the one caller that opts in. Pinned here because a mount that forgot would
  // silently reproduce the live failure this exists for (see hold-for-person.test.ts).
  it('opts into the hold, at the same bound await_reply uses', () => {
    const spy = vi.spyOn(toolsModule, 'createTools');
    const h = mount(CONFIG);
    try {
      const deps = spy.mock.calls.at(-1)![0];
      expect(deps.holdMs).toBe(toolsModule.DEFAULT_HOLD_MS);
      expect(toolsModule.DEFAULT_HOLD_MS).toBeGreaterThan(0);
      expect(typeof deps.onHold).toBe('function');
    } finally {
      h.destroy();
      spy.mockRestore();
    }
  });
});
