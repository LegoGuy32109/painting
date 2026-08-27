import { assertEquals, assertNotEquals } from "@std/assert";
import { signMergeToken, verifyMergeToken } from "../src/server/merge-token.ts";
import { base64Url, signPayload } from "../src/server/signing-keys.ts";

Deno.env.set(
  "PAINTING_KEYS",
  `kprim:${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
);

const GUEST_ID = "01234567-89ab-4cde-89ab-0123456789ab";
const ACCOUNT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

Deno.test("signMergeToken/verifyMergeToken round-trip the bound profile ids", async () => {
  const now = Date.now();
  const token = await signMergeToken({
    guestProfileId: GUEST_ID,
    accountProfileId: ACCOUNT_ID,
    now,
  });
  const payload = await verifyMergeToken(token, now);
  assertEquals(payload?.guestProfileId, GUEST_ID);
  assertEquals(payload?.accountProfileId, ACCOUNT_ID);
});

Deno.test("verifyMergeToken rejects a token past its expiry", async () => {
  const now = Date.now();
  const token = await signMergeToken({
    guestProfileId: GUEST_ID,
    accountProfileId: ACCOUNT_ID,
    now,
  });
  // ~10 minute TTL — 11 minutes later it must be expired.
  const later = now + 11 * 60 * 1000;
  const payload = await verifyMergeToken(token, later);
  assertEquals(payload, null);
});

Deno.test("verifyMergeToken accepts a token right up to (not past) its expiry", async () => {
  const now = Date.now();
  const token = await signMergeToken({
    guestProfileId: GUEST_ID,
    accountProfileId: ACCOUNT_ID,
    now,
  });
  const justBefore = now + 10 * 60 * 1000 - 1;
  const payload = await verifyMergeToken(token, justBefore);
  assertEquals(payload?.guestProfileId, GUEST_ID);
});

Deno.test("a merge token cannot be verified under any other signing purpose (HKDF domain separation)", async () => {
  const now = Date.now();
  const token = await signMergeToken({
    guestProfileId: GUEST_ID,
    accountProfileId: ACCOUNT_ID,
    now,
  });
  // Re-sign the exact same payload under "guest-session" instead, and
  // confirm THAT signature does not verify as a merge token, and vice
  // versa — the two purposes must never be interchangeable.
  const parts = token.split(".");
  const payloadPrefix = parts.slice(0, 5).join(".");
  const wrongPurposeSignature = await signPayload("guest-session", payloadPrefix);
  const forged = `${payloadPrefix}.${wrongPurposeSignature}`;
  assertNotEquals(forged, token);
  const payload = await verifyMergeToken(forged, now);
  assertEquals(payload, null);
});

Deno.test("verifyMergeToken rejects a tampered signature", async () => {
  const now = Date.now();
  const token = await signMergeToken({
    guestProfileId: GUEST_ID,
    accountProfileId: ACCOUNT_ID,
    now,
  });
  const tampered = `${token.slice(0, -2)}aa`;
  const payload = await verifyMergeToken(tampered, now);
  assertEquals(payload, null);
});

Deno.test("verifyMergeToken rejects malformed tokens (wrong shape, unknown version, unknown kid)", async () => {
  const now = Date.now();
  assertEquals(await verifyMergeToken("not.enough.parts", now), null);
  assertEquals(
    await verifyMergeToken(
      `v2.kprim.${GUEST_ID}.${ACCOUNT_ID}.${now + 1000}.sig`,
      now,
    ),
    null,
  );
  assertEquals(
    await verifyMergeToken(
      `v1.kunknown.${GUEST_ID}.${ACCOUNT_ID}.${now + 1000}.sig`,
      now,
    ),
    null,
  );
});

Deno.test("verifyMergeToken rejects tampering with the bound profile ids (swapped guest/account)", async () => {
  const now = Date.now();
  const token = await signMergeToken({
    guestProfileId: GUEST_ID,
    accountProfileId: ACCOUNT_ID,
    now,
  });
  const parts = token.split(".");
  // Swap the two ids but keep the original signature — must not verify.
  const tampered = [parts[0], parts[1], parts[3], parts[2], parts[4], parts[5]]
    .join(".");
  const payload = await verifyMergeToken(tampered, now);
  assertEquals(payload, null);
});
