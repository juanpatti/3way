import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { PRODUCTS } from '../../config/seed';

/**
 * Observed live on the deployed demo: /api/products matched the query as ONE substring of
 * `title + description + sku`, so `q=Halden lamp` returned zero products — the catalogue
 * places the finish and model wording between those terms. That exact
 * phrasing is one of the two queries the product's return flow suggests, and it is the
 * natural way an agent relays "does the Halden lamp come in a warmer white?".
 *
 * The fix is ordinary AND-over-terms matching: every term must appear somewhere in the
 * haystack, in any order. Deliberately NOT any-term matching, which would make one common
 * word ("lamp") drag the whole catalogue into an answer.
 */
const NOW = 1_700_000_000_000;

function env() {
  return {
    OPENAI_API_KEY: 'x', REALTIME_MODEL: 'x',
    RP_ID: 'localhost', RP_NAME: 'Halden', EXPECTED_ORIGIN: 'http://localhost:3000',
    KV: { get: async () => null, put: async () => {}, delete: async () => {} },
    NOW,
  };
}

async function search(q: string, tenant?: string) {
  const url = `http://localhost/api/products?q=${encodeURIComponent(q)}`
    + (tenant ? `&tenant=${tenant}` : '');
  const res = await worker.fetch(new Request(url), env() as any);
  const body = await res.json() as { products: Array<{ sku: string }> };
  return body.products.map(p => p.sku).sort();
}

describe('/api/products matches every term, not the whole phrase', () => {
  it('THE BUG: "Halden lamp" finds both Halden lamps', async () => {
    expect(await search('Halden lamp')).toEqual(['SKU-STD-001', 'SKU-STD-002']);
  });

  it('is order-independent', async () => {
    expect(await search('lamp Halden')).toEqual(['SKU-STD-001', 'SKU-STD-002']);
  });

  it('still supports the phrase queries that already worked', async () => {
    expect(await search('portable lamp')).toEqual(['SKU-STD-001', 'SKU-STD-002']);
    expect(await search('sconce')).toEqual(['SKU-CLR-114']);
  });

  it('narrows as terms are added rather than widening', async () => {
    expect(await search('lamp')).toHaveLength(3);
    expect(await search('blue lamp')).toEqual(['SKU-STD-001']);
    expect(await search('halden blue lamp')).toEqual(['SKU-STD-001']);
  });

  it('matches description text across the field boundary', async () => {
    // "dimmable" appears only in SKU-STD-001's description, "Halden" only in the title —
    // neither field alone contains both terms, so this passes only if the match spans them.
    expect(await search('halden dimmable')).toEqual(['SKU-STD-001']);
  });

  it('keeps exact-SKU lookup working — get_product depends on it', async () => {
    expect(await search('SKU-STD-001')).toEqual(['SKU-STD-001']);
    expect(await search('sku-clr-114')).toEqual(['SKU-CLR-114']);
  });

  it('ignores punctuation and extra whitespace instead of failing on it', async () => {
    expect(await search('  Halden,   lamp!  ')).toEqual(['SKU-STD-001', 'SKU-STD-002']);
  });

  it('returns the whole catalogue for an empty query, unchanged', async () => {
    expect(await search('')).toEqual(PRODUCTS.map(p => p.sku).sort());
  });

  it('returns nothing when one term matches and the other does not', async () => {
    expect(await search('halden duffel')).toEqual([]);
  });

});
