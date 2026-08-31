import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  guestSession,
  issueSessionFor,
  sessionEpochValid,
} from "../src/server/guest-session.ts";
import { base64Url } from "../src/server/signing-keys.ts";

// --- PAINTING_KEYS (the current, Phase 0.75 keyset) -----------------------
//
// Two kids so the rotation path (a token signed under a non-primary kid
// still verifies and gets re-issued under the primary) is testable without
// needing to swap env vars mid-process — signing-keys.ts memoizes its
// parsed keyset for the life of the process, same as real deployments only
// pick up a new PAINTING_KEYS on restart.
const PRIMARY_KID = "kprim";
const OLD_KID = "kold";
const primaryKeyBytes = crypto.getRandomValues(new Uint8Array(32));
const oldKeyBytes = crypto.getRandomValues(new Uint8Array(32));
Deno.env.set(
  "PAINTING_KEYS",
  `${PRIMARY_KID}:${base64Url(primaryKeyBytes)},${OLD_KID}:${
    base64Url(oldKeyBytes)
  }`,
);

// --- Legacy (pre-keyset) secrets, verification-only ------------------------
const LEGACY_PRIMARY_SECRET = "test-guest-session-secret-primary-32-bytes";
const LEGACY_PREVIOUS_SECRET = "test-guest-session-secret-previous-32-bytes";
Deno.env.set("GUEST_SESSION_SECRET", LEGACY_PRIMARY_SECRET);
Deno.env.set("GUEST_SESSION_SECRET_PREVIOUS", LEGACY_PREVIOUS_SECRET);

async function legacyHmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** Hand-signs a `<prefix>.<sig>` legacy (v1/v2) token, same as guest-session.ts once did. */
async function legacySign(secret: string, prefix: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await legacyHmacKey(secret),
    new TextEncoder().encode(prefix),
  );
  return `${prefix}.${base64Url(new Uint8Array(signature))}`;
}

async function v1Token(
  guestId: string,
  secret = LEGACY_PRIMARY_SECRET,
): Promise<string> {
  return await legacySign(secret, `v1.${guestId}`);
}

async function v2Token(
  guestId: string,
  issuedAt: number,
  secret = LEGACY_PRIMARY_SECRET,
): Promise<string> {
  return await legacySign(secret, `v2.${issuedAt}.${guestId}`);
}

/** Hand-signs a v3 token under an arbitrary (not necessarily primary) kid, replicating signing-keys.ts's HKDF derivation from raw key bytes this test controls. */
async function v3Token(
  guestId: string,
  issuedAt: number,
  kid: string,
  rootBytes: Uint8Array,
): Promise<string> {
  const root = await crypto.subtle.importKey(
    "raw",
    rootBytes.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("painting/v1/guest-session"),
    },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const prefix = `v3.${kid}.${issuedAt}.${guestId}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(prefix),
  );
  return `${prefix}.${base64Url(new Uint8Array(signature))}`;
}

/** Hand-signs a v4 token (the current format, carrying session_epoch) under an arbitrary kid. */
async function v4Token(
  guestId: string,
  issuedAt: number,
  epoch: number,
  kid: string,
  rootBytes: Uint8Array,
): Promise<string> {
  const root = await crypto.subtle.importKey(
    "raw",
    rootBytes.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("painting/v1/guest-session"),
    },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const prefix = `v4.${kid}.${issuedAt}.${guestId}.${epoch}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(prefix),
  );
  return `${prefix}.${base64Url(new Uint8Array(signature))}`;
}

function requestWithCookie(token: string): Request {
  return new Request("http://localhost/", {
    headers: { cookie: `painting_guest=${token}` },
  });
}

function cookieToken(response: string): string {
  return response.split(";", 1)[0].split("=").slice(1).join("=");
}

const SOME_GUEST_ID = "01234567-89ab-4cde-89ab-0123456789ab";

Deno.test("a v1 token still verifies and is re-issued as v4 with epoch 0", async () => {
  const token = await v1Token(SOME_GUEST_ID);
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.guestId, SOME_GUEST_ID);
  assertMatch(
    session?.setCookie ?? "",
    new RegExp(`^painting_guest=v4\\.${PRIMARY_KID}\\.`),
  );
});

Deno.test("a v2 token still verifies and is re-issued as v4 with epoch 0", async () => {
  const token = await v2Token(SOME_GUEST_ID, Date.now());
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.guestId, SOME_GUEST_ID);
  assertMatch(
    session?.setCookie ?? "",
    new RegExp(`^painting_guest=v4\\.${PRIMARY_KID}\\.`),
  );
});

Deno.test("a v4 token round-trips: sign then verify yields the same uuid, kid, epoch, no reissue", async () => {
  const created = await guestSession(new Request("http://localhost/"), true);
  const token = cookieToken(created?.setCookie ?? "");
  assertMatch(token, new RegExp(`^v4\\.${PRIMARY_KID}\\.`));

  const verified = await guestSession(requestWithCookie(token), false);
  assertEquals(verified?.guestId, created?.guestId);
  assertEquals(verified?.setCookie, null);
});

Deno.test("a v4 token older than 30 days is re-issued; a fresh one is not", async () => {
  const now = Date.now();
  const oldToken = await v4Token(
    SOME_GUEST_ID,
    now - (1000 * 60 * 60 * 24 * 31),
    0,
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const oldSession = await guestSession(requestWithCookie(oldToken), false);
  assertEquals(oldSession?.guestId, SOME_GUEST_ID);
  assertMatch(
    oldSession?.setCookie ?? "",
    new RegExp(`^painting_guest=v4\\.${PRIMARY_KID}\\.`),
  );

  const freshToken = await v4Token(
    SOME_GUEST_ID,
    now,
    0,
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const freshSession = await guestSession(
    requestWithCookie(freshToken),
    false,
  );
  assertEquals(freshSession?.guestId, SOME_GUEST_ID);
  assertEquals(freshSession?.setCookie, null);
});

Deno.test("a future-dated but validly signed v4 token is accepted and reissued, not rejected", async () => {
  // A signature-valid future issuedAt can only have come from our own
  // signer (e.g. clock skew between server instances) — it must never be
  // treated as a forgery and destroy the guest's identity. It should be
  // accepted and reissued with a corrected issued-at, same as a stale token.
  // Carries forward the Phase 0 correction (see guest-session.ts's isStale).
  const farFuture = Date.now() + (1000 * 60 * 60 * 24 * 5);
  const token = await v4Token(
    SOME_GUEST_ID,
    farFuture,
    0,
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.guestId, SOME_GUEST_ID);
  assertMatch(
    session?.setCookie ?? "",
    new RegExp(`^painting_guest=v4\\.${PRIMARY_KID}\\.`),
  );
  assertNotEquals(cookieToken(session?.setCookie ?? ""), token);
});

Deno.test("a token signed under a non-primary kid verifies and is re-issued under the primary kid", async () => {
  const token = await v3Token(SOME_GUEST_ID, Date.now(), OLD_KID, oldKeyBytes);
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.guestId, SOME_GUEST_ID);
  assertMatch(
    session?.setCookie ?? "",
    new RegExp(`^painting_guest=v4\\.${PRIMARY_KID}\\.`),
  );
  assertNotEquals(cookieToken(session?.setCookie ?? ""), token);
});

Deno.test("a token signed under an unknown kid is rejected", async () => {
  const unknownKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = await v3Token(
    SOME_GUEST_ID,
    Date.now(),
    "kunknown",
    unknownKeyBytes,
  );
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session, null);
});

Deno.test("a tampered signature is rejected", async () => {
  const token = await v3Token(
    SOME_GUEST_ID,
    Date.now(),
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const tampered = `${token.slice(0, -2)}aa`;
  const session = await guestSession(requestWithCookie(tampered), false);
  assertEquals(session, null);
});

Deno.test("a token with a valid signature but malformed uuid is rejected", async () => {
  const token = await v3Token(
    "not-a-real-uuid",
    Date.now(),
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session, null);
});

Deno.test("a v1 token signed with the legacy previous secret verifies and is re-issued as v4 with epoch 0", async () => {
  const token = await v1Token(SOME_GUEST_ID, LEGACY_PREVIOUS_SECRET);
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.guestId, SOME_GUEST_ID);
  assertMatch(
    session?.setCookie ?? "",
    new RegExp(`^painting_guest=v4\\.${PRIMARY_KID}\\.`),
  );
  assertNotEquals(cookieToken(session?.setCookie ?? ""), token);
});

Deno.test("Lax cookie attribute replaces the old Strict setting", async () => {
  const session = await guestSession(new Request("http://localhost/"), true);
  assertMatch(session?.setCookie ?? "", /SameSite=Lax/);
});

// --- Phase 4: session_epoch ------------------------------------------------

Deno.test("a v3 (pre-epoch) token migrates to v4 carrying epoch 0", async () => {
  const token = await v3Token(SOME_GUEST_ID, Date.now(), PRIMARY_KID, primaryKeyBytes);
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.epoch, 0);
});

Deno.test("a v4 token round-trips a nonzero epoch", async () => {
  const token = await v4Token(
    SOME_GUEST_ID,
    Date.now(),
    5,
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session?.guestId, SOME_GUEST_ID);
  assertEquals(session?.epoch, 5);
  assertEquals(session?.setCookie, null);
});

Deno.test("reissuing a stale v4 token carries its embedded epoch forward unchanged, no database lookup possible here", async () => {
  const now = Date.now();
  const staleToken = await v4Token(
    SOME_GUEST_ID,
    now - (1000 * 60 * 60 * 24 * 31),
    7,
    PRIMARY_KID,
    primaryKeyBytes,
  );
  const session = await guestSession(requestWithCookie(staleToken), false);
  assertEquals(session?.epoch, 7);
  // The reissued cookie itself must also carry epoch 7 forward, not reset
  // to 0 or anything else — this function has no database access to look
  // up a "real" current epoch, by design (see signGuestId()'s doc comment
  // in guest-session.ts).
  const reissuedToken = cookieToken(session?.setCookie ?? "");
  const reVerified = await guestSession(requestWithCookie(reissuedToken), false);
  assertEquals(reVerified?.epoch, 7);
});

Deno.test("a v4 token with a malformed (non-numeric) epoch is rejected", async () => {
  const kid = PRIMARY_KID;
  const issuedAt = Date.now();
  const root = await crypto.subtle.importKey(
    "raw",
    primaryKeyBytes.buffer as ArrayBuffer,
    "HKDF",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: new TextEncoder().encode("painting/v1/guest-session"),
    },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const prefix = `v4.${kid}.${issuedAt}.${SOME_GUEST_ID}.not-a-number`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(prefix),
  );
  const token = `${prefix}.${base64Url(new Uint8Array(signature))}`;
  const session = await guestSession(requestWithCookie(token), false);
  assertEquals(session, null);
});

Deno.test("issueSessionFor mints a session for a SPECIFIC profile id and epoch, ignoring the request's existing cookie", async () => {
  const req = requestWithCookie(
    await v4Token(SOME_GUEST_ID, Date.now(), 0, PRIMARY_KID, primaryKeyBytes),
  );
  const otherProfileId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const session = await issueSessionFor(req, otherProfileId, 3);
  assertEquals(session.guestId, otherProfileId);
  assertEquals(session.epoch, 3);
  const reVerified = await guestSession(
    requestWithCookie(cookieToken(session.setCookie ?? "")),
    false,
  );
  assertEquals(reVerified?.guestId, otherProfileId);
  assertEquals(reVerified?.epoch, 3);
});

Deno.test("sessionEpochValid compares a session's embedded epoch against a given current value", () => {
  assertEquals(sessionEpochValid({ guestId: "x", epoch: 4, setCookie: null }, 4), true);
  assertEquals(sessionEpochValid({ guestId: "x", epoch: 4, setCookie: null }, 5), false);
});
