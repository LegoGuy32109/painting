// Route-level tests for Phase 5's transfer codes: generation, single-use
// consumption, expiry, per-code attempt exhaustion, IP-keyed rate
// limiting, and reuse of the Phase 4 four-case merge path. Against a live
// database, same isolation reasoning as tests/auth-merge_test.ts (which
// this file is modeled on).
//
// WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS ARE set here — not because any
// transfer-code route needs them (POST /api/auth/transfer and
// POST /api/auth/transfer/consume are deliberately NOT gated behind
// requireRelyingParty(): a transfer code performs no WebAuthn ceremony at
// all) — but because the fourth merge row's test below also calls
// POST /api/auth/merge, which IS gated (it's the same shared resolution
// route Phase 4 built for passkey sign-in).

import { assertEquals, assertNotEquals } from "@std/assert";
import { handler } from "../src/server/main.ts";
import {
  createDb,
  ensureProfile,
  getGuestDraft,
  getOrCreateDraft,
} from "../src/server/db.ts";
import { ulid } from "../src/shared/ulid.js";
import { normalizeTransferCode } from "../src/shared/transfer-code.js";
import { type GuestSession, guestSession } from "../src/server/guest-session.ts";
import { base64Url } from "../src/server/signing-keys.ts";

if (!Deno.env.get("GUEST_SESSION_SECRET")) {
  Deno.env.set(
    "GUEST_SESSION_SECRET",
    "test-only-guest-session-secret-32-bytes",
  );
}
if (!Deno.env.get("PAINTING_KEYS")) {
  Deno.env.set(
    "PAINTING_KEYS",
    `transfer:${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
  );
}
Deno.env.set("WEBAUTHN_RP_ID", "localhost");
Deno.env.set("WEBAUTHN_ORIGINS", "http://localhost");

const db = createDb();

function cookie(session: GuestSession): string {
  return session.setCookie?.split(";", 1)[0] ?? "";
}

let ipCounter = 0;
/** A fresh, never-reused IP per test so the shared rate-limit bucket in rate-limit.ts never bleeds between tests. */
function freshIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter % 254 + 1}.${ipCounter}`;
}

function post(
  path: string,
  body: unknown,
  session: GuestSession | null,
  ip: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip,
  };
  if (session) headers.cookie = cookie(session);
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function freshSession(): Promise<GuestSession> {
  return (await guestSession(new Request("http://localhost/"), true)) as GuestSession;
}

async function dropProfile(id: string) {
  await db.execute({ sql: "DELETE FROM canvases WHERE owner_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM credentials WHERE profile_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM transfer_codes WHERE profile_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM profiles WHERE id = ?", args: [id] });
}

async function makeDraft(ownerId: string): Promise<string> {
  const draft = await getOrCreateDraft(
    db,
    ulid(),
    ownerId,
    new Uint8Array(16 * 16 * 4),
    Date.now(),
  );
  return draft.id;
}

Deno.test("POST /api/auth/transfer generates an 8-char code with a ~10-minute expiry", async () => {
  const session = await freshSession();
  const ip = freshIp();
  try {
    await ensureProfile(db, session.guestId, Date.now());
    const before = Date.now();
    const res = await post("/api/auth/transfer", {}, session, ip);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(typeof body.code, "string");
    assertEquals(body.code.length, 8);
    assertEquals(normalizeTransferCode(body.code), body.code);
    const ttl = body.expiresAt - before;
    // ~10 minutes, generous slack for test execution time.
    assertEquals(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000 + 5000, true);
  } finally {
    await dropProfile(session.guestId);
  }
});

Deno.test("transfer code happy path: a fresh browsing context lands on the code's profile", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  const ip1 = freshIp();
  const ip2 = freshIp();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    const genRes = await post("/api/auth/transfer", {}, generatorSession, ip1);
    const { code } = await genRes.json();

    const consumeRes = await post(
      "/api/auth/transfer/consume",
      { code },
      consumerSession,
      ip2,
    );
    assertEquals(consumeRes.status, 200);
    const body = await consumeRes.json();
    assertEquals(body.ok, true);
    assertEquals(body.merge.pending, false);

    const setCookie = consumeRes.headers.get("set-cookie") ?? "";
    const token = setCookie.split(";", 1)[0].split("=").slice(1).join("=");
    const landed = await guestSession(
      new Request("http://localhost/", { headers: { cookie: `painting_guest=${token}` } }),
      false,
    );
    assertEquals(landed?.guestId, generatorSession.guestId);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("transfer code accepts lowercase and hyphenated input", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    const genRes = await post("/api/auth/transfer", {}, generatorSession, freshIp());
    const { code } = await genRes.json();
    const messy = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();

    const consumeRes = await post(
      "/api/auth/transfer/consume",
      { code: messy },
      consumerSession,
      freshIp(),
    );
    assertEquals(consumeRes.status, 200);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("a transfer code is single-use: a second consume attempt fails", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  const thirdSession = await freshSession();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    const genRes = await post("/api/auth/transfer", {}, generatorSession, freshIp());
    const { code } = await genRes.json();

    const first = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(first.status, 200);

    const second = await post("/api/auth/transfer/consume", { code }, thirdSession, freshIp());
    assertEquals(second.status, 401);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
    await dropProfile(thirdSession.guestId);
  }
});

Deno.test("an expired transfer code is rejected", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    const profile = await ensureProfile(db, generatorSession.guestId, Date.now());
    // Insert a code that's already expired, bypassing the route's own
    // 10-minute TTL so this test doesn't need to wait.
    const code = "AB12CD34".slice(0, 8);
    await db.execute({
      sql: "DELETE FROM transfer_codes WHERE code = ?",
      args: [code],
    });
    await db.execute({
      sql: "INSERT INTO transfer_codes (code, profile_id, expires_at) VALUES (?, ?, ?)",
      args: [code, profile.id, Date.now() - 1000],
    });

    const res = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(res.status, 401);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("a code is invalidated after 3 failed attempts, even if it would otherwise still be valid", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    const profile = await ensureProfile(db, generatorSession.guestId, Date.now());
    const code = "ZZ99YY88";
    await db.execute({ sql: "DELETE FROM transfer_codes WHERE code = ?", args: [code] });
    await db.execute({
      sql: "INSERT INTO transfer_codes (code, profile_id, expires_at, failed_attempts) VALUES (?, ?, ?, ?)",
      args: [code, profile.id, Date.now() + 10 * 60 * 1000, 3],
    });

    // The code is otherwise perfectly live (not expired, not consumed) —
    // only failed_attempts having reached 3 should block it.
    const res = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(res.status, 401);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("3 wrong/dead attempts against the SAME code exhaust it even from different IPs", async () => {
  const generatorSession = await freshSession();
  try {
    const profile = await ensureProfile(db, generatorSession.guestId, Date.now());
    const code = "QQ11WW22";
    await db.execute({ sql: "DELETE FROM transfer_codes WHERE code = ?", args: [code] });
    // Already consumed — every attempt against it is doomed, which is
    // exactly what should increment failed_attempts.
    await db.execute({
      sql:
        "INSERT INTO transfer_codes (code, profile_id, expires_at, consumed_at) VALUES (?, ?, ?, ?)",
      args: [code, profile.id, Date.now() + 10 * 60 * 1000, Date.now()],
    });

    for (let i = 0; i < 3; i++) {
      const attemptSession = await freshSession();
      const res = await post(
        "/api/auth/transfer/consume",
        { code },
        attemptSession,
        freshIp(),
      );
      assertEquals(res.status, 401);
      await dropProfile(attemptSession.guestId);
    }

    const row = await db.execute({
      sql: "SELECT failed_attempts FROM transfer_codes WHERE code = ?",
      args: [code],
    });
    assertEquals(Number(row.rows[0].failed_attempts) >= 3, true);
  } finally {
    await dropProfile(generatorSession.guestId);
  }
});

Deno.test("the consume error message does not distinguish nonexistent from wrong/expired/used", async () => {
  const consumerSession = await freshSession();
  try {
    const neverExisted = await post(
      "/api/auth/transfer/consume",
      { code: "ABSENT12" },
      consumerSession,
      freshIp(),
    );
    const neverExistedText = await neverExisted.text();

    const generatorSession = await freshSession();
    const profile = await ensureProfile(db, generatorSession.guestId, Date.now());
    const deadCode = "DEADDEAD".slice(0, 8);
    await db.execute({ sql: "DELETE FROM transfer_codes WHERE code = ?", args: [deadCode] });
    await db.execute({
      sql:
        "INSERT INTO transfer_codes (code, profile_id, expires_at, consumed_at) VALUES (?, ?, ?, ?)",
      args: [deadCode, profile.id, Date.now() + 10 * 60 * 1000, Date.now()],
    });
    const alreadyUsed = await post(
      "/api/auth/transfer/consume",
      { code: deadCode },
      consumerSession,
      freshIp(),
    );
    const alreadyUsedText = await alreadyUsed.text();

    assertEquals(neverExisted.status, alreadyUsed.status);
    assertEquals(neverExistedText, alreadyUsedText);
    await dropProfile(generatorSession.guestId);
  } finally {
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("IP-keyed rate limiting: consume returns 429 once the bucket is exhausted", async () => {
  const consumerSession = await freshSession();
  const ip = freshIp();
  try {
    let sawTooManyRequests = false;
    // Capacity is small enough that a tight burst of wrong guesses from
    // ONE IP exhausts it well before 40 attempts.
    for (let i = 0; i < 40; i++) {
      const res = await post(
        "/api/auth/transfer/consume",
        { code: "ABSENT12" },
        consumerSession,
        ip,
      );
      if (res.status === 429) {
        sawTooManyRequests = true;
        break;
      }
      assertEquals(res.status, 401);
    }
    assertEquals(sawTooManyRequests, true);
  } finally {
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("IP-keyed rate limiting: generation returns 429 once the bucket is exhausted", async () => {
  const session = await freshSession();
  const ip = freshIp();
  try {
    await ensureProfile(db, session.guestId, Date.now());
    let sawTooManyRequests = false;
    for (let i = 0; i < 10; i++) {
      const res = await post("/api/auth/transfer", {}, session, ip);
      if (res.status === 429) {
        sawTooManyRequests = true;
        break;
      }
      assertEquals(res.status, 200);
    }
    assertEquals(sawTooManyRequests, true);
  } finally {
    await dropProfile(session.guestId);
  }
});

// --- Reusing the Phase 4 four-case merge path -----------------------------

Deno.test("consume, row: neither side has a draft — silent, lands on the code's profile", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    const genRes = await post("/api/auth/transfer", {}, generatorSession, freshIp());
    const { code } = await genRes.json();

    const res = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.merge.pending, false);
    assertEquals((res.headers.get("set-cookie") ?? "").length > 0, true);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("consume, row: device draft only — re-owned to the code's profile, silent", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    await ensureProfile(db, consumerSession.guestId, Date.now());
    const deviceDraftId = await makeDraft(consumerSession.guestId);
    const genRes = await post("/api/auth/transfer", {}, generatorSession, freshIp());
    const { code } = await genRes.json();

    const res = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.merge.pending, false);
    assertEquals((await getGuestDraft(db, consumerSession.guestId)), null);
    const kept = await getGuestDraft(db, generatorSession.guestId);
    assertEquals(kept?.id, deviceDraftId);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("consume, row: account draft only — untouched, silent", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    await ensureProfile(db, consumerSession.guestId, Date.now());
    const accountDraftId = await makeDraft(generatorSession.guestId);
    const genRes = await post("/api/auth/transfer", {}, generatorSession, freshIp());
    const { code } = await genRes.json();

    const res = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.merge.pending, false);
    const kept = await getGuestDraft(db, generatorSession.guestId);
    assertEquals(kept?.id, accountDraftId);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});

Deno.test("consume, row: both sides have a draft — pending merge, no cookie set, nothing re-owned yet", async () => {
  const generatorSession = await freshSession();
  const consumerSession = await freshSession();
  try {
    await ensureProfile(db, generatorSession.guestId, Date.now());
    await ensureProfile(db, consumerSession.guestId, Date.now());
    const deviceDraftId = await makeDraft(consumerSession.guestId);
    const accountDraftId = await makeDraft(generatorSession.guestId);
    const genRes = await post("/api/auth/transfer", {}, generatorSession, freshIp());
    const { code } = await genRes.json();

    const res = await post("/api/auth/transfer/consume", { code }, consumerSession, freshIp());
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.merge.pending, true);
    assertEquals(typeof body.merge.mergeToken, "string");
    assertEquals(body.merge.deviceDraft.id, deviceDraftId);
    assertEquals(body.merge.accountDraft.id, accountDraftId);
    assertEquals(res.headers.get("set-cookie"), null);

    // Nothing touched: both drafts still exactly where they were.
    assertEquals((await getGuestDraft(db, consumerSession.guestId))?.id, deviceDraftId);
    assertEquals((await getGuestDraft(db, generatorSession.guestId))?.id, accountDraftId);

    // And POST /api/auth/merge (the same shared resolution route Phase 4
    // added) resolves it exactly as it would for a passkey sign-in.
    const mergeRes = await post(
      "/api/auth/merge",
      { mergeToken: body.merge.mergeToken, keep: "account" },
      consumerSession,
      freshIp(),
    );
    assertEquals(mergeRes.status, 200);
    assertEquals((await getGuestDraft(db, generatorSession.guestId))?.id, accountDraftId);
    assertNotEquals((await getGuestDraft(db, generatorSession.guestId))?.id, deviceDraftId);
  } finally {
    await dropProfile(generatorSession.guestId);
    await dropProfile(consumerSession.guestId);
  }
});
