// @ts-check

// Transfer codes: the one recovery/bootstrap primitive in a product with
// no email, no password, and no account-recovery flow (see
// docs/transfer-codes.md). This module is the DOM-free bit both the
// server (generating and validating them) and the browser (normalizing
// what a person typed, formatting one for display) need identically — see
// AGENTS.md's src/shared/ convention.

// Crockford base32: 32 symbols, deliberately excluding I, L, O, and U —
// no ambiguity against 1/I, l/1, 0/O, and no accidental profanity from a
// vowel-complete alphabet. Exactly 32 symbols (a power of two) matters for
// generateTransferCode() below: `byte % 32` is then uniform over a
// 0-255 byte with NO modulo bias, which would not hold for an alphabet of
// any other size.
export const TRANSFER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TRANSFER_CODE_LENGTH = 8;

/**
 * Generates a fresh code from crypto.getRandomValues() (never Math.random —
 * this is a bearer credential, not a UI detail). 8 Crockford base32
 * characters ~= 40 bits of entropy.
 * @returns {string}
 */
export function generateTransferCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(TRANSFER_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) {
    code += TRANSFER_CODE_ALPHABET[byte % TRANSFER_CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Normalizes user-typed input into the canonical stored form: uppercased,
 * with whitespace and hyphens stripped (so "ab12-cd34", "AB12 CD34", and
 * "ab12cd34" all normalize identically to what generateTransferCode()
 * produces). Returns null — never throws — for anything that can't be a
 * valid code after normalizing (wrong length, or a character outside the
 * Crockford alphabet, INCLUDING i/l/o/u, which are simply invalid rather
 * than silently mapped to a lookalike).
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeTransferCode(raw) {
  const stripped = raw.toUpperCase().replace(/[\s-]/g, "");
  if (stripped.length !== TRANSFER_CODE_LENGTH) return null;
  for (const character of stripped) {
    if (!TRANSFER_CODE_ALPHABET.includes(character)) return null;
  }
  return stripped;
}

/**
 * Groups a canonical code for display, e.g. "AB12CD34" -> "AB12-CD34" —
 * readability only; normalizeTransferCode() accepts the hyphen back out
 * again either way.
 * @param {string} code
 * @returns {string}
 */
export function formatTransferCodeForDisplay(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
