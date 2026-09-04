import { describe, expect, it } from 'vitest';
import { validateAddress } from '../src/address';

describe('validateAddress consent-integrity normalization', () => {
  it('normalizes the displayed and bound address to NFC exactly once', () => {
    expect(validateAddress('  Cafe\u0301 Road  ')).toEqual({ ok: true, address: 'Caf\u00e9 Road' });
  });

  it.each([
    ['a bidi override', '12 Main St\u202E123'],
    ['a bidi isolate', '12 Main St\u2066123\u2069'],
    ['a zero-width default-ignorable format character', '12 Main\u200B St'],
    ['a Unicode line separator', '12 Main St\u2028Suite 4'],
    ['a Unicode paragraph separator', '12 Main St\u2029Suite 4'],
  ])('rejects %s that can make the displayed destination differ from the bound value', (_label, address) => {
    const result = validateAddress(address);
    expect(result).toMatchObject({ ok: false, code: 'control-character' });
  });

  it('accepts exactly 300 Unicode code points after NFC normalization', () => {
    const result = validateAddress('e\u0301'.repeat(300));
    expect(result).toEqual({ ok: true, address: '\u00e9'.repeat(300) });
  });

  it('rejects 301 Unicode code points after NFC normalization', () => {
    const result = validateAddress('\ud83d\udce6'.repeat(301));
    expect(result).toMatchObject({ ok: false, code: 'too-long' });
  });
});
