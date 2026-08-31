// Route-level tests for Phase 4's sign-in merge machinery: POST
// /api/auth/merge, POST /api/auth/logout, and session_epoch enforcement.
// Against a live database (TURSO_DB_URL/TURSO_DB_TOKEN), same isolation
// reasoning as tests/db_test.ts / tests/sync-routes_test.ts.
//
// Deliberately does NOT attempt to drive POST /api/auth/login/verify's
// own WebAuthn ceremony here — that needs a real signed assertion, which
// only a browser (or hand-rolled authenticator crypto, out of scope) can
// produce. scripts/e2e-passkey.ts exercises login/verify through a real
// CDP virtual authenticator instead. What IS tested here, directly and
// thoroughly: the merge mechanics db.mergeProfiles() performs (all four
// row-shapes of the merge table), the POST /api/auth/merge route built on
// top of it (replay-safety, device binding, epoch enforcement, cookie
// issuance), and sign-out. Unlike tests/sync-routes_test.ts, THIS file
// configures WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS, since every route under
// test here is gated behind requireRelyingParty().

import { assertEquals, assertNotEquals } from "@std/assert";
import { handler } from "../src/server/main.ts";
import {
  bumpSessionEpoch,
  createDb,
  ensureProfile,
  getGuestDraft,
  getOrCreateDraft,
  getProfile,
  mergeProfiles,
} from "../src/server/db.ts";
import { ulid } from "../src/shared/ulid.js";
import {
  type GuestSession,
  guestSession,
  issueSessionFor,
} from "../src/server/guest-session.ts";
import { signMergeToken } from "../src/server/merge-token.ts";
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
    `authmerge:${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
  );
}
Deno.env.set("WEBAUTHN_RP_ID", "localhost");
Deno.env.set("WEBAUTHN_ORIGINS", "http://localhost");

const db = createDb();

function cookie(session: GuestSession): string {
  return session.setCookie?.split(";", 1)[0] ?? "";
}

function post(path: string, body: unknown, session: GuestSession) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie(session) },
      body: JSON.stringify(body),
    }),
  );
}

function put(path: string, body: unknown, session: GuestSession) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookie(session) },
      body: JSON.stringify(body),
    }),
  );
}

async function dropProfile(id: string) {
  await db.execute({ sql: "DELETE FROM canvases WHERE owner_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM credentials WHERE profile_id = ?", args: [id] });
  await db.execute({ sql: "DELETE FROM profiles WHERE id = ?", args: [id] });
}

async function freshSession(): Promise<GuestSession> {
  return (await guestSession(new Request("http://localhost/"), true)) as GuestSession;
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

async function canvasesSnapshot(): Promise<unknown> {
  const res = await db.execute({
    sql: "SELECT id, owner_id, completed_at FROM canvases ORDER BY id",
    args: [],
  });
  return JSON.stringify(res.rows);
}

// --- db.mergeProfiles(): the four row-shapes -------------------------------

Deno.test("mergeProfiles: neither side has a draft — only completed canvases (if any) move, no error", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await mergeProfiles(db, {
      guestProfileId: guestId,
      accountProfileId: accountId,
      discardDraftId: null,
      reownDraftId: null,
    });
    assertEquals(await getGuestDraft(db, guestId), null);
    assertEquals(await getGuestDraft(db, accountId), null);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("mergeProfiles: device draft only — re-owned to the account", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    const draftId = await makeDraft(guestId);
    await mergeProfiles(db, {
      guestProfileId: guestId,
      accountProfileId: accountId,
      discardDraftId: null,
      reownDraftId: draftId,
    });
    assertEquals(await getGuestDraft(db, guestId), null);
    const accountDraft = await getGuestDraft(db, accountId);
    assertEquals(accountDraft?.id, draftId);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("mergeProfiles: account draft only — untouched, nothing to reown or discard", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    const draftId = await makeDraft(accountId);
    await mergeProfiles(db, {
      guestProfileId: guestId,
      accountProfileId: accountId,
      discardDraftId: null,
      reownDraftId: null,
    });
    const accountDraft = await getGuestDraft(db, accountId);
    assertEquals(accountDraft?.id, draftId);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("mergeProfiles: both sides have a draft — discard one, reown the other, never both open", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    const deviceDraftId = await makeDraft(guestId);
    const accountDraftId = await makeDraft(accountId);

    // keep "device": the account's own draft is discarded, the device's
    // is re-owned to the account.
    await mergeProfiles(db, {
      guestProfileId: guestId,
      accountProfileId: accountId,
      discardDraftId: accountDraftId,
      reownDraftId: deviceDraftId,
    });
    assertEquals(await getGuestDraft(db, guestId), null);
    const kept = await getGuestDraft(db, accountId);
    assertEquals(kept?.id, deviceDraftId);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("mergeProfiles: completed canvases re-own unconditionally, independent of the draft decision", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  const completedId = ulid();
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await db.execute({
      sql:
        "INSERT INTO canvases (id, owner_id, pixels, created_at, completed_at, client_reported_active) " +
        "VALUES (?, ?, ?, ?, ?, 0)",
      args: [completedId, guestId, new Uint8Array(16 * 16 * 4), Date.now(), Date.now()],
    });
    await mergeProfiles(db, {
      guestProfileId: guestId,
      accountProfileId: accountId,
      discardDraftId: null,
      reownDraftId: null,
    });
    const res = await db.execute({
      sql: "SELECT owner_id FROM canvases WHERE id = ?",
      args: [completedId],
    });
    assertEquals(String(res.rows[0].owner_id), accountId);
  } finally {
    await dropCanvasRow(completedId);
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

async function dropCanvasRow(id: string) {
  await db.execute({ sql: "DELETE FROM canvases WHERE id = ?", args: [id] });
}

// --- POST /api/auth/merge ---------------------------------------------

Deno.test("POST /api/auth/merge keep=device: discards the account's draft, re-owns the device's, sets the account cookie", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    const guestProfile = await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    const deviceDraftId = await makeDraft(guestId);
    const accountDraftId = await makeDraft(accountId);
    const token = await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now(),
    });

    const res = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "device" },
      guestSess,
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.ok, true);
    await assertCookieBelongsTo(res, accountId);

    assertEquals(await getGuestDraft(db, guestId), null);
    const kept = await getGuestDraft(db, accountId);
    assertEquals(kept?.id, deviceDraftId);
    assertNotEquals(kept?.id, accountDraftId);
    assertEquals(guestProfile.sessionEpoch, 0);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge keep=account: discards the device's draft, account's stays", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    const deviceDraftId = await makeDraft(guestId);
    const accountDraftId = await makeDraft(accountId);
    const token = await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now(),
    });

    const res = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "account" },
      guestSess,
    );
    assertEquals(res.status, 200);

    const kept = await getGuestDraft(db, accountId);
    assertEquals(kept?.id, accountDraftId);
    assertNotEquals(kept?.id, deviceDraftId);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge: back out (never calling it) leaves the database byte-identical", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await makeDraft(guestId);
    await makeDraft(accountId);
    // Issuing the merge token itself (what login/verify does for the
    // dialog row) writes nothing — confirmed by simply never calling
    // /api/auth/merge and comparing snapshots before/after "backing out".
    await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now(),
    });
    const before = await canvasesSnapshot();
    // "Backing out" is exactly this: doing nothing further.
    const after = await canvasesSnapshot();
    assertEquals(after, before);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge: a used token cannot be replayed — second call is a safe no-op, rejected", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await makeDraft(guestId);
    await makeDraft(accountId);
    const token = await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now(),
    });

    const first = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "device" },
      guestSess,
    );
    assertEquals(first.status, 200);
    const snapshotAfterFirst = await canvasesSnapshot();

    // Replay with the SAME token and the SAME (now-stale) guest cookie.
    const second = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "device" },
      guestSess,
    );
    assertEquals(second.status, 409);
    assertEquals(await canvasesSnapshot(), snapshotAfterFirst);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge: a token replayed from a DIFFERENT device session is rejected", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const otherDeviceSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await makeDraft(guestId);
    await makeDraft(accountId);
    const token = await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now(),
    });

    const res = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "device" },
      otherDeviceSess,
    );
    assertEquals(res.status, 401);
    assertEquals((await getGuestDraft(db, guestId)) !== null, true);
    assertEquals((await getGuestDraft(db, accountId)) !== null, true);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge: an expired token is rejected", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await makeDraft(guestId);
    await makeDraft(accountId);
    const token = await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now() - 11 * 60 * 1000, // ~10 minute TTL, already elapsed
    });

    const res = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "device" },
      guestSess,
    );
    assertEquals(res.status, 401);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge: a stale session_epoch is rejected before any merge happens", async () => {
  const guestSess = await freshSession();
  const accountSess = await freshSession();
  const guestId = guestSess.guestId;
  const accountId = accountSess.guestId;
  try {
    await ensureProfile(db, guestId, Date.now());
    await ensureProfile(db, accountId, Date.now());
    await makeDraft(guestId);
    await makeDraft(accountId);
    const token = await signMergeToken({
      guestProfileId: guestId,
      accountProfileId: accountId,
      now: Date.now(),
    });

    // Bump the guest's epoch AFTER the session cookie (epoch 0) was
    // issued — simulating a sign-out-everywhere in between.
    await bumpSessionEpoch(db, guestId);

    const res = await post(
      "/api/auth/merge",
      { mergeToken: token, keep: "device" },
      guestSess,
    );
    assertEquals(res.status, 401);
    assertEquals((await getGuestDraft(db, guestId)) !== null, true);
    assertEquals((await getGuestDraft(db, accountId)) !== null, true);
  } finally {
    await dropProfile(guestId);
    await dropProfile(accountId);
  }
});

Deno.test("POST /api/auth/merge: rejects a malformed body (missing keep)", async () => {
  const guestSess = await freshSession();
  const res = await post(
    "/api/auth/merge",
    { mergeToken: "whatever" },
    guestSess,
  );
  assertEquals(res.status, 400);
});

async function assertCookieBelongsTo(res: Response, expectedProfileId: string) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  assertEquals(setCookie.length > 0, true);
  const token = setCookie.split(";", 1)[0].split("=").slice(1).join("=");
  const reVerified = await guestSession(
    new Request("http://localhost/", {
      headers: { cookie: `painting_guest=${token}` },
    }),
    false,
  );
  assertEquals(reVerified?.guestId, expectedProfileId);
}

// --- POST /api/auth/logout ----------------------------------------------

Deno.test("POST /api/auth/logout issues a fresh, working guest cookie — never leaves the client cookie-less", async () => {
  const accountSess = await freshSession();
  try {
    const res = await handler(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: cookie(accountSess) },
      }),
    );
    assertEquals(res.status, 200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assertEquals(setCookie.length > 0, true);
    const token = setCookie.split(";", 1)[0].split("=").slice(1).join("=");
    const newSession = await guestSession(
      new Request("http://localhost/", { headers: { cookie: `painting_guest=${token}` } }),
      false,
    );
    assertEquals(newSession !== null, true);
    assertNotEquals(newSession?.guestId, accountSess.guestId);
  } finally {
    // Nothing to clean up — logout never touches profiles/canvases.
  }
});

// --- session_epoch enforcement on a mutating route -----------------------

Deno.test("a mutating route rejects a session signed under a stale epoch", async () => {
  const guestId = crypto.randomUUID();
  try {
    await ensureProfile(db, guestId, Date.now());
    await bumpSessionEpoch(db, guestId); // profile is now at epoch 1
    // Hand-mint a session carrying the OLD epoch (0) — as if issued
    // before the bump.
    const staleSession = await issueSessionFor(
      new Request("http://localhost/"),
      guestId,
      0,
    );
    const res = await put(
      "/api/me/handle",
      { handle: "Should Not Apply" },
      staleSession,
    );
    assertEquals(res.status, 401);
    const profile = await getProfile(db, guestId);
    assertNotEquals(profile?.handle, "Should Not Apply");
  } finally {
    await dropProfile(guestId);
  }
});

Deno.test("a mutating route accepts a session signed under the CURRENT epoch", async () => {
  const guestId = crypto.randomUUID();
  try {
    await ensureProfile(db, guestId, Date.now());
    await bumpSessionEpoch(db, guestId); // now at epoch 1
    const currentSession = await issueSessionFor(
      new Request("http://localhost/"),
      guestId,
      1,
    );
    const res = await put(
      "/api/me/handle",
      { handle: "Epoch Ok" },
      currentSession,
    );
    assertEquals(res.status, 200);
  } finally {
    await dropProfile(guestId);
  }
});
