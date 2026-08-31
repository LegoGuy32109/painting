import {
  assertEquals,
  assertMatch,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import {
  base64Url,
  derivedKey,
  parsePaintingKeysEnv,
  primaryKid,
  signPayload,
  verifyPayload,
} from "../src/server/signing-keys.ts";

// PAINTING_KEYS is process-wide cached (see rawKeyset() in signing-keys.ts),
// so only the FIRST test file (across the whole `deno test` run) to actually
// touch that cache determines its value — guest-session_test.ts sets it
// unconditionally for its own rotation tests, which always wins when the
// full suite runs together. This guarded set only matters when this file
// runs on its own.
if (!Deno.env.get("PAINTING_KEYS")) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  Deno.env.set("PAINTING_KEYS", `solo:${base64Url(bytes)}`);
}

function key(bytes: number[]): string {
  return base64Url(new Uint8Array(bytes));
}

const VALID_KEY_A = key(Array.from({ length: 32 }, (_, i) => i));
const VALID_KEY_B = key(Array.from({ length: 32 }, (_, i) => 31 - i));

Deno.test("parsePaintingKeysEnv accepts a valid multi-entry keyset, primary is the first entry", () => {
  const parsed = parsePaintingKeysEnv(`k1:${VALID_KEY_A},k2:${VALID_KEY_B}`);
  assertEquals(parsed.primaryKid, "k1");
  assertEquals(parsed.keys.size, 2);
  assertEquals(parsed.keys.get("k1")?.byteLength, 32);
  assertEquals(parsed.keys.get("k2")?.byteLength, 32);
});

Deno.test("parsePaintingKeysEnv rejects an empty or missing keyset", () => {
  assertThrows(() => parsePaintingKeysEnv(undefined));
  assertThrows(() => parsePaintingKeysEnv(""));
  assertThrows(() => parsePaintingKeysEnv("   ,  ,  "));
});

Deno.test("parsePaintingKeysEnv rejects a malformed entry (missing colon)", () => {
  assertThrows(() => parsePaintingKeysEnv(`k1${VALID_KEY_A}`));
});

Deno.test("parsePaintingKeysEnv rejects an invalid kid", () => {
  assertThrows(() => parsePaintingKeysEnv(`Not_Valid:${VALID_KEY_A}`));
  assertThrows(() =>
    parsePaintingKeysEnv(`this-kid-is-too-long-for-the-pattern:${VALID_KEY_A}`)
  );
});

Deno.test("parsePaintingKeysEnv rejects bad base64url", () => {
  assertThrows(() => parsePaintingKeysEnv("k1:not base64url!!"));
});

Deno.test("parsePaintingKeysEnv rejects a key that doesn't decode to exactly 32 bytes", () => {
  assertThrows(() =>
    parsePaintingKeysEnv(`k1:${base64Url(new Uint8Array(16))}`)
  );
  assertThrows(() =>
    parsePaintingKeysEnv(`k1:${base64Url(new Uint8Array(64))}`)
  );
});

Deno.test("parsePaintingKeysEnv rejects a duplicate kid", () => {
  assertThrows(() =>
    parsePaintingKeysEnv(`k1:${VALID_KEY_A},k1:${VALID_KEY_B}`)
  );
});

Deno.test("HKDF domain separation: a payload signed under guest-session does not verify under merge-token", async () => {
  const kid = primaryKid();
  const payload = "some-token-payload";
  const signature = await signPayload("guest-session", payload);

  assertEquals(
    await verifyPayload("guest-session", payload, kid, signature),
    true,
  );
  assertEquals(
    await verifyPayload("merge-token", payload, kid, signature),
    false,
  );
  assertEquals(
    await verifyPayload("webauthn-challenge", payload, kid, signature),
    false,
  );
  assertEquals(
    await verifyPayload("transfer-code", payload, kid, signature),
    false,
  );
});

Deno.test("signPayload/verifyPayload round-trip under the primary kid", async () => {
  const kid = primaryKid();
  const payload = "round-trip-payload";
  const signature = await signPayload("guest-session", payload);
  assertMatch(signature, /^[A-Za-z0-9_-]+$/);
  assertEquals(
    await verifyPayload("guest-session", payload, kid, signature),
    true,
  );
});

Deno.test("verifyPayload rejects a tampered signature", async () => {
  const kid = primaryKid();
  const payload = "tamper-me";
  const signature = await signPayload("guest-session", payload);
  const tampered = `${signature.slice(0, -2)}${
    signature.slice(-2) === "aa" ? "bb" : "aa"
  }`;
  assertEquals(
    await verifyPayload("guest-session", payload, kid, tampered),
    false,
  );
});

Deno.test("verifyPayload rejects an unknown kid without throwing", async () => {
  const payload = "unknown-kid-payload";
  const signature = await signPayload("guest-session", payload);
  assertEquals(
    await verifyPayload("guest-session", payload, "nonexistent", signature),
    false,
  );
});

Deno.test("derived keys are memoized: repeated kid/purpose returns the same CryptoKey instance", async () => {
  const kid = primaryKid();
  const first = await derivedKey(kid, "guest-session");
  const second = await derivedKey(kid, "guest-session");
  assertStrictEquals(first, second);

  const otherPurpose = await derivedKey(kid, "merge-token");
  assertEquals(first === otherPurpose, false);
});
