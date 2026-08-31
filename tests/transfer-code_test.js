import { assertEquals, assertMatch } from "@std/assert";
import {
  formatTransferCodeForDisplay,
  generateTransferCode,
  normalizeTransferCode,
  TRANSFER_CODE_ALPHABET,
  TRANSFER_CODE_LENGTH,
} from "../src/shared/transfer-code.js";

Deno.test("TRANSFER_CODE_ALPHABET is exactly Crockford base32: 32 symbols, no I/L/O/U", () => {
  assertEquals(TRANSFER_CODE_ALPHABET.length, 32);
  assertEquals(new Set(TRANSFER_CODE_ALPHABET).size, 32); // no duplicates
  for (const excluded of ["I", "L", "O", "U"]) {
    assertEquals(TRANSFER_CODE_ALPHABET.includes(excluded), false);
  }
});

Deno.test("generateTransferCode produces an 8-character code drawn only from the alphabet", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateTransferCode();
    assertEquals(code.length, TRANSFER_CODE_LENGTH);
    assertMatch(code, new RegExp(`^[${TRANSFER_CODE_ALPHABET}]{8}$`));
  }
});

Deno.test("generateTransferCode does not repeat in a reasonably large sample", () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(generateTransferCode());
  // With ~2^40 possible codes, 1000 draws colliding would be a sign
  // something is badly wrong (not a real probabilistic flake risk).
  assertEquals(seen.size, 1000);
});

Deno.test("normalizeTransferCode accepts lowercase input", () => {
  assertEquals(normalizeTransferCode("ab12cd34"), "AB12CD34");
});

Deno.test("normalizeTransferCode accepts a hyphen-separated form", () => {
  assertEquals(normalizeTransferCode("AB12-CD34"), "AB12CD34");
  assertEquals(normalizeTransferCode("ab12-cd34"), "AB12CD34");
});

Deno.test("normalizeTransferCode strips surrounding/internal whitespace", () => {
  assertEquals(normalizeTransferCode(" AB12 CD34 "), "AB12CD34");
});

Deno.test("normalizeTransferCode rejects the wrong length", () => {
  assertEquals(normalizeTransferCode("AB12CD3"), null);
  assertEquals(normalizeTransferCode("AB12CD345"), null);
});

Deno.test("normalizeTransferCode rejects characters outside the Crockford alphabet, including I/L/O/U", () => {
  assertEquals(normalizeTransferCode("AB12CD3I"), null);
  assertEquals(normalizeTransferCode("AB12CD3L"), null);
  assertEquals(normalizeTransferCode("AB12CD3O"), null);
  assertEquals(normalizeTransferCode("AB12CD3U"), null);
  assertEquals(normalizeTransferCode("AB12CD3!"), null);
});

Deno.test("formatTransferCodeForDisplay groups into two halves, and normalizing the result round-trips", () => {
  const code = generateTransferCode();
  const displayed = formatTransferCodeForDisplay(code);
  assertMatch(displayed, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assertEquals(normalizeTransferCode(displayed), code);
});
