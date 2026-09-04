import { describe, it, expect, vi } from 'vitest';
import { getModelContext, registerWebMCP } from '../src/webmcp';
import type { Tool } from '../src/types';

// The real WebMCP API's registerTool is ASYNC (returns a Promise, rejects on a duplicate
// name) and unregisters via `options.signal`, never a returned handle — see
// packages/widget/vendor/webmcp-polyfill.js's ModelContext#registerTool, vendored
// unmodified, which is the ground truth this fixture is built against.
const fakeMC = () => ({
  registerTool: vi.fn(async (_descriptor: Record<string, unknown>, _options?: { signal?: AbortSignal }) => undefined),
});

const tool: Tool = {
  name: 't', description: 'd', inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ ok: true }),
};

describe('getModelContext', () => {
  it('prefers document.modelContext', () => {
    const mc = fakeMC();
    expect(getModelContext({ modelContext: mc } as any, { modelContext: fakeMC() } as any)).toBe(mc);
  });

  it('falls back to navigator.modelContext for the Chrome 149 origin trial', () => {
    const mc = fakeMC();
    expect(getModelContext({} as any, { modelContext: mc } as any)).toBe(mc);
  });

  it('returns null when neither exists, and does not throw', () => {
    expect(getModelContext({} as any, {} as any)).toBeNull();
  });

  it('ignores a modelContext without registerTool', () => {
    expect(getModelContext({ modelContext: {} } as any, {} as any)).toBeNull();
  });
});

describe('registerWebMCP', () => {
  it('registers every tool', () => {
    const mc = fakeMC();
    registerWebMCP([tool, { ...tool, name: 'u' }], mc as any);
    expect(mc.registerTool).toHaveBeenCalledTimes(2);
  });

  it('passes name, description, schema and execute through', () => {
    const mc = fakeMC();
    registerWebMCP([tool], mc as any);
    const arg = mc.registerTool.mock.calls[0]![0] as any;
    expect(arg).toMatchObject({ name: 't', description: 'd' });
    expect(typeof arg.execute).toBe('function');
  });

  it('supplies a CallContext the tool can rely on', async () => {
    const mc = fakeMC();
    const spy = vi.fn(async () => ({ ok: true }));
    registerWebMCP([{ ...tool, execute: spy }], mc as any);
    await (mc.registerTool.mock.calls[0]![0] as any).execute({ a: 1 });
    expect(spy).toHaveBeenCalledWith({ a: 1 }, expect.objectContaining({ origin: 'agent-autonomous' }));
  });

  it('is a silent no-op when there is no model context (Tier 1)', () => {
    expect(() => registerWebMCP([tool], null)).not.toThrow();
  });

  it('returns an unregister function that is safe to call twice', () => {
    const mc = fakeMC();
    const off = registerWebMCP([tool], mc as any);
    expect(() => { off(); off(); }).not.toThrow();
  });

  it('unregisters via an AbortSignal passed to registerTool, not a returned handle', () => {
    // The earlier version of this file expected registerTool to RETURN { abort }, which
    // matches nothing real. The real contract is the other way around: the CALLER hands
    // registerTool a signal, and aborting it is what unregisters.
    const mc = fakeMC();
    const off = registerWebMCP([tool], mc as any);
    const options = mc.registerTool.mock.calls[0]![1];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options!.signal!.aborted).toBe(false);
    off();
    expect(options!.signal!.aborted).toBe(true);
  });

  it('shares one AbortSignal across every tool registered in the same call', () => {
    const mc = fakeMC();
    registerWebMCP([tool, { ...tool, name: 'u' }], mc as any);
    const [sigA, sigB] = mc.registerTool.mock.calls.map(c => c[1]?.signal);
    expect(sigA).toBe(sigB);
  });

  it('registerTool is called async (fire-and-forget) — its result is never awaited before returning', () => {
    const mc = fakeMC();
    // If registerWebMCP awaited each registration before moving on, this call would need
    // to be async itself; it isn't (see its signature), so a synchronous mock invocation
    // count right after calling it is the observable proof.
    registerWebMCP([tool, { ...tool, name: 'u' }], mc as any);
    expect(mc.registerTool).toHaveBeenCalledTimes(2);
  });

  it('does not throw, and never reaches an unhandled rejection, when registerTool rejects (e.g. a duplicate name)', async () => {
    const mc = { registerTool: vi.fn(async () => {
      throw new DOMException('Tool "t" is already registered', 'InvalidStateError');
    }) };
    expect(() => registerWebMCP([tool], mc as any)).not.toThrow();
    // Flush the microtask queue so the rejected promise settles inside this test's own
    // try — if registerWebMCP left it uncaught, vitest surfaces it as a failure here
    // rather than as a stray unhandledRejection blamed on an unrelated test.
    await new Promise(resolve => setTimeout(resolve, 0));
  });
});
