import { mount, type WidgetConfig, type WidgetHandle } from './index';
import type { Policy, StanceKey } from './types';

/**
 * One script tag, no JavaScript to write.
 *
 *   <script src="3way.bundle.js"
 *           data-3way-api="https://api.example.com"
 *           data-3way-store="Halden Support"
 *           data-3way-user="Alex Rivera"></script>
 *
 * The reason this needs a fetch rather than more attributes: mount() requires a `policy`
 * — prose plus rules — and a stance set. Those are objects, and an attribute is a string,
 * so the only honest way to reach a one-tag embed is to move them where they belong
 * anyway. The returns policy is the STORE's, not the page's; it is already the Worker's
 * source of truth for the authoritative gate; and keeping one copy means a page can never
 * show a person one policy while the gate enforces another.
 *
 * So: the tag says where the API is, the API says what the policy is.
 */
export interface AutoMountConfig {
  policy: Policy;
  stances?: Record<StanceKey, string>;
  stance?: StanceKey;
  storeAgentName?: string;
}

const DATA = {
  api: 'data-3way-api',
  store: 'data-3way-store',
  user: 'data-3way-user',
  stance: 'data-3way-stance',
  tenant: 'data-3way-tenant',
  domain: 'data-3way-domain',
  input: 'data-3way-input',
} as const;

/**
 * Captured at module scope, not inside the async function below: document.currentScript
 * is only non-null while the script is executing synchronously, and it is null by the
 * time any await resolves.
 */
const SCRIPT: HTMLScriptElement | null =
  typeof document !== 'undefined' ? (document.currentScript as HTMLScriptElement | null) : null;

export function readAttributes(el: Element | null): Partial<WidgetConfig> | null {
  const apiBase = el?.getAttribute(DATA.api)?.trim();
  if (!apiBase) return null;   // no data-3way-api means this page is mounting by hand
  const attr = (name: string) => el!.getAttribute(name)?.trim() || undefined;
  return {
    apiBase: apiBase.replace(/\/+$/, ''),
    storeAgentName: attr(DATA.store),
    userName: attr(DATA.user),
    stance: attr(DATA.stance) as StanceKey | undefined,
    tenant: attr(DATA.tenant),
    // Which tool registry to expose. Omitted means the shop, so every existing embed is
    // unaffected by the clinic existing.
    domain: attr(DATA.domain) as 'shop' | 'clinic' | undefined,
    // Keyholder is the default; only the exact string "composer" opts into the text box.
    // Fail-closed toward the more locked-down surface, like every other flag here.
    composer: attr(DATA.input) === 'composer',
  };
}

/**
 * Fetches the store's own configuration. Fails LOUDLY in the console and mounts nothing:
 * a widget that silently renders with a default policy would be showing a person terms
 * that are not the store's, next to a gate enforcing terms that are.
 */
export async function fetchConfig(
  apiBase: string, tenant: string | undefined, fetchImpl: typeof fetch = fetch,
): Promise<AutoMountConfig | null> {
  const url = `${apiBase}/api/config${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) {
      console.error(`[3way] ${url} responded ${res.status}; not mounting`);
      return null;
    }
    const body = await res.json() as AutoMountConfig;
    if (!body?.policy?.rules || typeof body.policy.prose !== 'string') {
      console.error('[3way] /api/config returned no usable policy; not mounting', body);
      return null;
    }
    return body;
  } catch (err) {
    console.error(`[3way] could not reach ${url}; not mounting`, err);
    return null;
  }
}

export async function autoMount(
  el: Element | null = SCRIPT, fetchImpl: typeof fetch = fetch,
): Promise<WidgetHandle | null> {
  const attrs = readAttributes(el);
  if (!attrs) return null;
  const remote = await fetchConfig(attrs.apiBase!, attrs.tenant, fetchImpl);
  if (!remote) return null;
  return mount({
    ...attrs,
    apiBase: attrs.apiBase!,
    policy: remote.policy,
    // Page attribute wins over the store default, so one deployment can host several
    // pages with different stances against the same config endpoint.
    stance: attrs.stance ?? remote.stance ?? 'policy-bound',
    stances: remote.stances,
    storeAgentName: attrs.storeAgentName ?? remote.storeAgentName,
  });
}
