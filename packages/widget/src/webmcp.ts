import type { Tool } from './types';

/**
 * The real WebMCP API (see packages/widget/vendor/webmcp-polyfill.js's ModelContext —
 * vendored unmodified from GoogleChromeLabs/webmcp-tools, so it's the ground truth, not
 * an approximation): `registerTool` is ASYNC, returns a Promise that REJECTS on a
 * duplicate name or a malformed tool, and unregistering happens via `options.signal` (an
 * AbortSignal), never via a returned handle. An earlier version of this file was written
 * against a synchronous `registerTool` returning `{ abort }`, which matches nothing real
 * — not the polyfill, and (per the WebMCP explainer this polyfill implements) not the
 * native browser API either.
 */
export interface ModelContextLike {
  registerTool(descriptor: Record<string, unknown>, options?: { signal?: AbortSignal }): unknown;
}

type Host = { modelContext?: unknown };

const usable = (v: unknown): v is ModelContextLike =>
  !!v && typeof (v as ModelContextLike).registerTool === 'function';

/**
 * ChatGPT and Chrome 150+ expose document.modelContext; the Chrome 149 origin trial
 * exposes navigator.modelContext, deprecated in 150. Both are live during the contest,
 * so check both and never assume either.
 */
export function getModelContext(
  doc: Host = globalThis.document as unknown as Host,
  nav: Host = globalThis.navigator as unknown as Host,
): ModelContextLike | null {
  if (usable(doc?.modelContext)) return doc.modelContext;
  if (usable(nav?.modelContext)) return nav.modelContext;
  return null;
}

/**
 * Which surface we actually got, for the log line below. This distinction is the whole
 * diagnostic: registering into the vendored polyfill and registering into a real agent's
 * surface look IDENTICAL from the page — same call, same success — but only one of them
 * is visible to a visiting agent. The polyfill installs itself only when no native
 * surface exists (its own guard, first lines of webmcp-polyfill.js) and marks its
 * presence with __webmcp_registered_tools, so that marker distinguishes "an agent can see
 * these" from "these are registered into a shim nobody is reading."
 */
export function describeSurface(
  doc: Host = globalThis.document as unknown as Host,
  nav: Host = globalThis.navigator as unknown as Host,
  win: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): string {
  const polyfilled = '__webmcp_registered_tools' in win;
  if (usable(doc?.modelContext)) return polyfilled ? 'document.modelContext (POLYFILL)' : 'document.modelContext (native)';
  if (usable(nav?.modelContext)) return polyfilled ? 'navigator.modelContext (POLYFILL)' : 'navigator.modelContext (native)';
  return 'none';
}

/**
 * Registers the tool set. A null context is Tier 1 — the widget still works as a
 * chat assistant, and the human is never shown a capability error.
 *
 * One AbortController shared across every registration in this call: aborting it is how
 * the real API unregisters (see the ModelContextLike doc comment), and there is exactly
 * one lifetime here — everything this call registers goes away together, at destroy().
 * `registerTool` is fire-and-forget: it returns a Promise that can reject (a duplicate
 * name, a malformed tool), and that must never become an unhandled rejection reaching the
 * page — same discipline as the execute wrapper below, one boundary earlier.
 */
export function registerWebMCP(tools: Tool[], mc: ModelContextLike | null): () => void {
  if (!mc) {
    // Tier 1. Say so once: the difference between "this runtime has no WebMCP" and
    // "registration failed" is the first thing anyone debugging a silent agent needs,
    // and it is invisible from the page otherwise.
    console.info('[3way] no WebMCP surface on this runtime — chat still works, agent tools are not offered');
    return () => {};
  }
  const surface = describeSurface();
  console.info(`[3way] registering ${tools.length} WebMCP tools on ${surface}:`, tools.map(t => t.name).join(', '));
  if (surface.includes('POLYFILL')) {
    console.info('[3way] that is the vendored polyfill, not a browser-provided surface — ' +
      'no visiting agent can see these tools. In ChatGPT this usually means the tab is in ' +
      'read-only page mode rather than browser-control/agent mode.');
  }
  const controller = new AbortController();
  // Whichever name an agent probes, it must find the surface. Measured 2026-09-01: an
  // agent extension on Chrome 152 checked navigator.modelContext — the origin-trial name,
  // gone in 150+ — found nothing, concluded the tools were unreachable, and typed its
  // question into the person's own box, where it was attributed to the person. A plain
  // property, set only where the name is absent, removed again on unregister so a test's
  // fake surface never leaks into the next test through a global.
  const aliased = aliasMissingSurface();
  for (const tool of tools) {
    void Promise.resolve(mc.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      // The Realtime path wraps tool calls; this one must too, or a network failure
      // throws across the WebMCP boundary instead of returning a structured result.
      execute: async (input: Record<string, unknown> = {}) => {
        try {
          return await tool.execute(input, { origin: 'agent-autonomous', cursor: null });
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    }, { signal: controller.signal })).catch(err => {
      // Swallowing this silently is how a page ends up registered with nothing and no
      // way to tell. Never rethrow — an unhandled rejection here would surface to
      // someone shopping for a lamp — but never hide it from a console either.
      console.warn(`[3way] WebMCP registration failed for "${tool.name}"`, err);
    });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    controller.abort();
    aliased();
  };
}

/**
 * Makes the one surface reachable under both names, returning the undo. A live getter,
 * not a copy: the alias answers with whatever the real name holds RIGHT NOW, so it can
 * never outlive the surface it stands for — a copy did, and a fake surface one test
 * installed was still findable under the other name in the next test. Never overrides
 * anything usable, and never throws into registration: a host that refuses the property
 * simply keeps its single name.
 */
function aliasMissingSurface(): () => void {
  const nav = globalThis.navigator as unknown as Host | undefined;
  const doc = globalThis.document as unknown as Host | undefined;
  const undos: Array<() => void> = [];
  for (const [target, source] of [[nav, doc], [doc, nav]] as Array<[Host | undefined, Host | undefined]>) {
    if (!target || !source || usable(target.modelContext) || !usable(source.modelContext)) continue;
    try {
      Object.defineProperty(target, 'modelContext', {
        configurable: true, enumerable: false,
        get: () => (usable(source.modelContext) ? source.modelContext : undefined),
      });
      undos.push(() => { try { delete target.modelContext; } catch { /* refused: keep it */ } });
    } catch { /* refused: keep the single name */ }
  }
  return () => { for (const undo of undos) undo(); };
}
