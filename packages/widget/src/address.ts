export const MAX_ADDRESS_LENGTH = 300;

export type AddressValidation =
  | { ok: true; address: string }
  | { ok: false; code: 'required' | 'too-long' | 'control-character'; message: string };

/**
 * Canonicalizes the one string the person reads and the Worker later binds. This lives in
 * the shared package because two copies once disagreed by silently slicing the Worker's
 * value to 300 characters while the widget displayed the full destination — the person
 * authorized one address and /api/act executed another. Callers may reject at different
 * boundaries, but they must never decide validity or normalization independently.
 */
export function validateAddress(value: unknown): AddressValidation {
  if (typeof value !== 'string') {
    return { ok: false, code: 'required',
      message: 'A new delivery address is required to file an address change.' };
  }
  // NFC is performed once, here, before either display or length validation. Without one
  // canonical value the modal can show a decomposed spelling while the Worker binds a
  // canonically equivalent but byte-different destination — the same consent mismatch
  // this shared validator exists to prevent.
  const normalized = value.normalize('NFC');
  if (!normalized.trim()) {
    return { ok: false, code: 'required',
      message: 'A new delivery address is required to file an address change.' };
  }
  // Checked before trimming: controls, bidi instructions, invisible format characters,
  // and Unicode line separators must not disappear or reorder glyphs between the modal's
  // textContent rendering and the Worker's logical code-point binding. U+202E, U+200B,
  // and U+2028 were the concrete display-one-destination/bind-another failures.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(normalized)) {
    return { ok: false, code: 'control-character',
      message: 'The new delivery address contains a control character or invisible Unicode formatting. Remove line breaks, bidi controls, or zero-width characters.' };
  }
  const address = normalized.trim();
  // JavaScript's string.length counts an astral code point twice. Applying the advertised
  // 300-character boundary that way rejected a 300-character Unicode address even though
  // the person and Worker both saw 300 characters.
  if ([...address].length > MAX_ADDRESS_LENGTH) {
    return { ok: false, code: 'too-long',
      message: `The new delivery address is too long. Use ${MAX_ADDRESS_LENGTH} characters or fewer.` };
  }
  return { ok: true, address };
}
