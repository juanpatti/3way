import { describe, it, expect } from 'vitest';
import { PRODUCTS, seedOrders, USER } from '../../../config/seed';
import { POLICY_PROSE, POLICY_RULES } from '../../../config/policy';
import { STANCES } from '../../../config/stances';
import {
  PRODUCTS as PRODUCTS_MIRROR, seedOrders as seedOrdersMirror, USER as USER_MIRROR,
} from '../../../sites/flagship/config/seed.js';
import {
  POLICY_PROSE as POLICY_PROSE_MIRROR, POLICY_RULES as POLICY_RULES_MIRROR,
} from '../../../sites/flagship/config/policy.js';
import { STANCES as STANCES_MIRROR } from '../../../sites/flagship/config/stances.js';

const NOW = 1_700_000_000_000;

// sites/flagship/ is a static site with no bundler at deploy time — TS `import type`
// (used by config/seed.ts and config/policy.ts) isn't valid browser ESM, so the site
// imports plain-JS mirrors of that data instead (see the sync-comment at the top of
// sites/flagship/config/seed.js and policy.js). The whole reason the storefront renders
// from that data, rather than hand-written copy, is so the page can never disagree with
// what the Worker and the widget's tools return — a hand-mirror that silently drifts
// reintroduces exactly that failure. This test is what actually enforces the mirror.
const drift = (base: string) =>
  `sites/flagship/config/${base}.js has drifted from config/${base}.ts — ` +
  `update the mirror in sites/flagship/config/${base}.js to match.`;

describe('sites/flagship/config/*.js mirrors config/*.ts exactly', () => {
  it('PRODUCTS matches exactly, including SKUs, prices, and final-sale flags', () => {
    expect(PRODUCTS_MIRROR, drift('seed')).toEqual(PRODUCTS);
  });

  it('seedOrders(now) matches exactly for a fixed timestamp', () => {
    expect(seedOrdersMirror(NOW), drift('seed')).toEqual(seedOrders(NOW));
  });

  it('USER matches exactly', () => {
    expect(USER_MIRROR, drift('seed')).toEqual(USER);
  });

  it('POLICY_PROSE matches exactly, character for character', () => {
    expect(POLICY_PROSE_MIRROR, drift('policy')).toBe(POLICY_PROSE);
  });

  it('POLICY_RULES matches exactly, field for field', () => {
    expect(POLICY_RULES_MIRROR, drift('policy')).toEqual(POLICY_RULES);
  });

  it('STANCES matches exactly, preset for preset', () => {
    expect(STANCES_MIRROR, drift('stances')).toEqual(STANCES);
  });
});
