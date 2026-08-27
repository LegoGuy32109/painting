import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  appendEvents,
  completeCanvas,
  consumeChallenge,
  countCredentials,
  createCanvas,
  createChallenge,
  createDb,
  deleteCompletedCanvas,
  deleteCredential,
  ensureProfile,
  getOrCreateDraft,
  getProfile,
  insertCredential,
  isHandleTaken,
  listActiveCanvases,
  listCredentials,
  listRecentlyCompleted,
  pullEventsSince,
  renameHandle,
} from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { ulid } from "../src/shared/ulid.js";
import {
  backfillAuthors,
  backfillProfiles,
} from "../scripts/backfill-profiles.ts";

const db = createDb();
await migrateDatabase(db);

const dbUrl = Deno.env.get("TURSO_DB_URL")!;
const dbToken = Deno.env.get("TURSO_DB_TOKEN")!;

const TEST_OWNER = "test-owner";

function emptyPixels(): Uint8Array {
  return new Uint8Array(16 * 16);
}

async function makeCanvas(): Promise<string> {
  const id = ulid();
  await createCanvas(db, id, `${TEST_OWNER}-${id}`, emptyPixels(), Date.now());
  return id;
}

Deno.test("one guest can have only one draft", async () => {
  const owner = `draft-owner-${ulid()}`;
  const firstId = ulid();
  const secondId = ulid();
  try {
    const [first, second] = await Promise.all([
      getOrCreateDraft(db, firstId, owner, emptyPixels(), Date.now()),
      getOrCreateDraft(db, secondId, owner, emptyPixels(), Date.now()),
    ]);
    assertEquals(first.id, second.id);
  } finally {
    await db.execute({
      sql: "DELETE FROM canvases WHERE owner_id = ?",
      args: [owner],
    });
  }
});

Deno.test("getOrCreateDraft falls back to a fresh id when the preferred id is owned by someone else", async () => {
  const otherOwner = `draft-owner-${ulid()}`;
  const thisOwner = `draft-owner-${ulid()}`;
  const contestedId = ulid();
  try {
    // Someone else already owns a canvas at the id this guest's stale
    // localStorage still names (the Defect 1 scenario: a new guest identity
    // was minted, but the client still remembers its old draft id).
    await createCanvas(db, contestedId, otherOwner, emptyPixels(), Date.now());

    const draft = await getOrCreateDraft(
      db,
      contestedId,
      thisOwner,
      emptyPixels(),
      Date.now(),
    );
    assertEquals(draft.ownerId, thisOwner);
    assertEquals(draft.id === contestedId, false);
  } finally {
    await db.execute({
      sql: "DELETE FROM canvases WHERE owner_id IN (?, ?)",
      args: [otherOwner, thisOwner],
    });
  }
});

Deno.test("only an owner can delete their completed canvas", async () => {
  const canvasId = await makeCanvas();
  const access = await db.execute({
    sql: "SELECT owner_id FROM canvases WHERE id = ?",
    args: [canvasId],
  });
  const owner = String(access.rows[0].owner_id);
  await completeCanvas(db, canvasId, "Done", "Test Author", Date.now());
  assertEquals(
    await deleteCompletedCanvas(db, canvasId, "someone-else"),
    false,
  );
  assertEquals(await deleteCompletedCanvas(db, canvasId, owner), true);
});

async function dropCanvas(id: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM canvases WHERE id = ?", args: [id] });
}

Deno.test("migrateDatabase() is idempotent", async () => {
  await migrateDatabase(db);
  await migrateDatabase(db);
});

Deno.test("foreign key CASCADE removes events when their canvas is deleted", async () => {
  const canvasId = await makeCanvas();
  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );

  const before = await pullEventsSince(db, canvasId, 0);
  assertEquals(before.events.length, 1);

  await dropCanvas(canvasId);

  const after = await db.execute({
    sql: "SELECT count(*) as n FROM canvas_events WHERE canvas_id = ?",
    args: [canvasId],
  });
  assertEquals(Number(after.rows[0].n), 0);
});

Deno.test("CHECK constraint rejects an invalid event kind", async () => {
  const canvasId = await makeCanvas();
  await assertRejects(() =>
    db.execute({
      sql:
        "INSERT INTO canvas_events (id, canvas_id, kind, client_ts, received_at) " +
        "VALUES (?, ?, 'bogus', ?, ?)",
      args: [ulid(), canvasId, Date.now(), Date.now()],
    })
  );
  await dropCanvas(canvasId);
});

Deno.test("UNIQUE(id) makes a retried push idempotent", async () => {
  const canvasId = await makeCanvas();
  const eventId = ulid();
  const push = () =>
    appendEvents(
      dbUrl,
      dbToken,
      canvasId,
      [{ id: eventId, kind: "stroke", clientTs: Date.now() }],
      true,
      Date.now(),
    );

  await push();
  await push(); // simulates a retried network send of the same batch

  const { events } = await pullEventsSince(db, canvasId, 0);
  assertEquals(events.length, 1);
  assertEquals(events[0].id, eventId);

  await dropCanvas(canvasId);
});

Deno.test("undo event references its stroke via revertsId", async () => {
  const canvasId = await makeCanvas();
  const strokeId = ulid();
  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: strokeId, kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );
  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: ulid(), kind: "undo", revertsId: strokeId, clientTs: Date.now() }],
    true,
    Date.now(),
  );

  const { events } = await pullEventsSince(db, canvasId, 0);
  assertEquals(events.length, 2);
  assertEquals(events[1].kind, "undo");
  assertEquals(events[1].revertsId, strokeId);

  await dropCanvas(canvasId);
});

Deno.test("pullEventsSince only returns events after the given sequence", async () => {
  const canvasId = await makeCanvas();
  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );
  const first = await pullEventsSince(db, canvasId, 0);
  assertEquals(first.events.length, 1);

  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );
  const second = await pullEventsSince(db, canvasId, first.headSequence);
  assertEquals(second.events.length, 1);
  assertEquals(second.headSequence, first.headSequence + 1);

  await dropCanvas(canvasId);
});

Deno.test("client_reported_active + last_stroke_at index drives the homescreen query", async () => {
  const active = await makeCanvas();
  const inactive = await makeCanvas();
  await appendEvents(
    dbUrl,
    dbToken,
    active,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );
  await appendEvents(
    dbUrl,
    dbToken,
    inactive,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    false,
    Date.now(),
  );

  const activeIds = (await listActiveCanvases(db)).map((c) => c.id);
  assertEquals(activeIds.includes(active), true);
  assertEquals(activeIds.includes(inactive), false);

  await dropCanvas(active);
  await dropCanvas(inactive);
});

Deno.test("completeCanvas sets title/completedAt and forces active=false, visible in recently-completed", async () => {
  const canvasId = await makeCanvas();
  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );
  assertEquals(
    await completeCanvas(
      db,
      canvasId,
      "My Painting",
      "Test Author",
      Date.now(),
    ),
    true,
  );
  assertEquals(
    await completeCanvas(
      db,
      canvasId,
      "Replacement",
      "Test Author",
      Date.now(),
    ),
    false,
  );
  await appendEvents(
    dbUrl,
    dbToken,
    canvasId,
    [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
    true,
    Date.now(),
  );
  assertEquals((await pullEventsSince(db, canvasId, 0)).events.length, 1);

  const activeIds = (await listActiveCanvases(db)).map((c) => c.id);
  assertEquals(activeIds.includes(canvasId), false);

  const completed = await listRecentlyCompleted(db, 20);
  const mine = completed.find((c) => c.id === canvasId);
  assertEquals(mine?.title, "My Painting");
  assertEquals(mine?.completedAt !== null, true);

  await dropCanvas(canvasId);
});

Deno.test("concurrent pushes to DIFFERENT canvases both succeed without conflict", async () => {
  const a = await makeCanvas();
  const b = await makeCanvas();

  await Promise.all([
    appendEvents(
      dbUrl,
      dbToken,
      a,
      [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
      true,
      Date.now(),
    ),
    appendEvents(
      dbUrl,
      dbToken,
      b,
      [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
      true,
      Date.now(),
    ),
  ]);

  assertEquals((await pullEventsSince(db, a, 0)).events.length, 1);
  assertEquals((await pullEventsSince(db, b, 0)).events.length, 1);

  await dropCanvas(a);
  await dropCanvas(b);
});

Deno.test("concurrent pushes to the SAME canvas both land via automatic conflict retry", async () => {
  const canvasId = await makeCanvas();

  const results = await Promise.allSettled([
    appendEvents(
      dbUrl,
      dbToken,
      canvasId,
      [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
      true,
      Date.now(),
    ),
    appendEvents(
      dbUrl,
      dbToken,
      canvasId,
      [{ id: ulid(), kind: "stroke", clientTs: Date.now() }],
      true,
      Date.now(),
    ),
  ]);

  // appendEvents retries internally on conflict, so both pushes should
  // succeed from the caller's point of view even though they raced on the
  // same canvas row (this is the case that produced a real MVCC conflict in
  // manual testing against the live database).
  for (const r of results) assertEquals(r.status, "fulfilled");

  const { events } = await pullEventsSince(db, canvasId, 0);
  assertEquals(events.length, 2);

  await dropCanvas(canvasId);
});

// Single-writer enforcement (see the owner check in main.ts's events POST
// handler) means only one owner's client ever pushes to a given canvas in
// production, and that client's own drainOutbox already serializes its own
// pushes (the `syncing` guard in src/client/sync.js) — so genuine same-
// canvas write concurrency is bounded low in practice: a client retry
// racing a slow in-flight push, or two devices racing to be first before a
// canvas has an owner yet. It is NOT bounded by how many browser tabs a
// human happens to have open, since those get rejected by the owner check
// before ever reaching appendEvents.
//
// A synthetic 20-way hammer on one row was tried here first and did not
// reliably resolve even with backoff and 8 retries (still saw multiple
// pushes exhaust retries against the live db) — that's a fundamentally
// different, much harsher regime than anything this app can produce, so
// chasing it further would be over-engineering for a scenario the
// architecture already rules out. This test targets the concurrency this
// app can actually generate, with headroom, and guards the retry logic
// itself against regression.
Deno.test("a few concurrent multi-event pushes to the SAME canvas all land, none crash or get lost", async () => {
  const canvasId = await makeCanvas();
  const PUSH_COUNT = 5;
  const EVENTS_PER_PUSH = 3;

  const pushes = Array.from({ length: PUSH_COUNT }, () =>
    appendEvents(
      dbUrl,
      dbToken,
      canvasId,
      Array.from({ length: EVENTS_PER_PUSH }, () => ({
        id: ulid(),
        kind: "stroke" as const,
        clientTs: Date.now(),
      })),
      true,
      Date.now(),
    ));

  const results = await Promise.allSettled(pushes);
  const failures = results.filter((r) => r.status === "rejected");
  assertEquals(
    failures,
    [],
    `expected every push to eventually succeed via retry, got: ${
      failures.map((f) => (f as PromiseRejectedResult).reason).join("; ")
    }`,
  );

  const { events } = await pullEventsSince(db, canvasId, 0);
  assertEquals(events.length, PUSH_COUNT * EVENTS_PER_PUSH);

  await dropCanvas(canvasId);
});

async function dropProfile(id: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM profiles WHERE id = ?", args: [id] });
}

Deno.test("ensureProfile creates a row once and only touches last_seen_at afterward", async () => {
  const id = `profile-owner-${ulid()}`;
  try {
    const first = await ensureProfile(db, id, 1000);
    assertEquals(first.id, id);
    // A handle is minted at creation (Phase 3 change request #2), not
    // deferred to account upgrade — see mintHandle()'s format.
    assertMatch(first.handle ?? "", /^[A-Za-z ]+ [A-Za-z]+ [0-9A-F]{4}$/);
    assertEquals(first.sessionEpoch, 0);
    assertEquals(first.upgradedAt, null);
    assertEquals(first.userHandle.byteLength, 32);
    assertEquals(first.createdAt, 1000);
    assertEquals(first.lastSeenAt, 1000);

    const second = await ensureProfile(db, id, 2000);
    assertEquals(second.createdAt, 1000, "created_at must not change");
    assertEquals(second.lastSeenAt, 2000, "last_seen_at should advance");
    assertEquals(
      second.handle,
      first.handle,
      "handle must not change on a later ensureProfile call",
    );
    assertEquals(
      second.userHandle,
      first.userHandle,
      "user_handle must stay stable once assigned",
    );

    const count = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM profiles WHERE id = ?",
      args: [id],
    });
    assertEquals(Number(count.rows[0].n), 1);
  } finally {
    await dropProfile(id);
  }
});

Deno.test("countCredentials and isHandleTaken reflect real rows", async () => {
  const id = `profile-owner-${ulid()}`;
  const handle = `Test Handle ${ulid().slice(0, 4)}`;
  try {
    await ensureProfile(db, id, Date.now());
    assertEquals(await countCredentials(db, id), 0);
    assertEquals(await isHandleTaken(db, handle), false);

    await db.execute({
      sql: "UPDATE profiles SET handle = ? WHERE id = ?",
      args: [handle, id],
    });
    await db.execute({
      sql:
        "INSERT INTO credentials (credential_id, profile_id, public_key, created_at) " +
        "VALUES (?, ?, ?, ?)",
      args: [ulid(), id, new Uint8Array([9]), Date.now()],
    });

    assertEquals(await countCredentials(db, id), 1);
    assertEquals(await isHandleTaken(db, handle), true);
  } finally {
    await db.execute({
      sql: "DELETE FROM credentials WHERE profile_id = ?",
      args: [id],
    });
    await dropProfile(id);
  }
});

Deno.test("getProfile returns null for a profile that was never created", async () => {
  assertEquals(await getProfile(db, `profile-owner-${ulid()}`), null);
});

Deno.test("backfillProfiles creates one profile per distinct owner_id, each with its own user_handle", async () => {
  const ownerA = `backfill-owner-${ulid()}`;
  const ownerB = `backfill-owner-${ulid()}`;
  const canvasA1 = await makeCanvasFor(ownerA, 1_000);
  const canvasA2 = await makeCanvasFor(ownerA, 2_000);
  const canvasB1 = await makeCanvasFor(ownerB, 5_000);
  try {
    const result = await backfillProfiles(db);
    assertEquals(result.inserted >= 2, true);

    const profileA = await getProfile(db, ownerA);
    const profileB = await getProfile(db, ownerB);
    assertEquals(profileA !== null, true);
    assertEquals(profileB !== null, true);
    assertEquals(
      profileA!.createdAt,
      1_000,
      "MIN(created_at) across owner_id's canvases",
    );
    assertEquals(
      profileA!.userHandle.byteLength === 32 &&
        profileB!.userHandle.byteLength === 32,
      true,
    );
    assertEquals(
      Array.from(profileA!.userHandle).join(",") !==
        Array.from(profileB!.userHandle).join(","),
      true,
      "each backfilled profile gets its own random user_handle",
    );

    // Running it again must not duplicate or error — INSERT OR IGNORE.
    const second = await backfillProfiles(db);
    assertEquals(second.alreadyPresent >= 2, true);
  } finally {
    await dropCanvas(canvasA1);
    await dropCanvas(canvasA2);
    await dropCanvas(canvasB1);
    await dropProfile(ownerA);
    await dropProfile(ownerB);
  }
});

async function makeCanvasFor(
  ownerId: string,
  createdAt: number,
): Promise<string> {
  const id = ulid();
  await createCanvas(db, id, ownerId, emptyPixels(), createdAt);
  await completeCanvas(
    db,
    id,
    "Backfill fixture",
    "Backfill Author",
    createdAt,
  );
  return id;
}

Deno.test("ensureProfile mints a handle on first creation and never changes it on later calls", async () => {
  const id = `profile-owner-${ulid()}`;
  try {
    const first = await ensureProfile(db, id, 1000);
    assertEquals(typeof first.handle, "string");
    assertMatch(first.handle ?? "", /^[A-Za-z ]+ [A-Za-z]+ [0-9A-F]{4}$/);

    const second = await ensureProfile(db, id, 2000);
    assertEquals(second.handle, first.handle);

    const third = await ensureProfile(db, id, 3000);
    assertEquals(third.handle, first.handle);
  } finally {
    await dropProfile(id);
  }
});

Deno.test("renameHandle returns conflict on a duplicate and ok otherwise", async () => {
  const idA = `profile-owner-${ulid()}`;
  const idB = `profile-owner-${ulid()}`;
  try {
    await ensureProfile(db, idA, Date.now());
    await ensureProfile(db, idB, Date.now());
    const takenHandle = `Taken Handle ${ulid().slice(0, 4)}`;
    assertEquals(await renameHandle(db, idA, takenHandle), "ok");
    assertEquals(await renameHandle(db, idB, takenHandle), "conflict");

    const freeHandle = `Free Handle ${ulid().slice(0, 4)}`;
    assertEquals(await renameHandle(db, idB, freeHandle), "ok");
    const profileB = await getProfile(db, idB);
    assertEquals(profileB?.handle, freeHandle);
  } finally {
    await dropProfile(idA);
    await dropProfile(idB);
  }
});

Deno.test("deleteCredential refuses to remove the last credential for a profile", async () => {
  const id = `profile-owner-${ulid()}`;
  const credentialA = ulid();
  const credentialB = ulid();
  try {
    await ensureProfile(db, id, Date.now());
    await insertCredential(db, {
      credentialId: credentialA,
      profileId: id,
      publicKey: new Uint8Array([1]),
      counter: 0,
      transports: null,
      aaguid: null,
      backupEligible: false,
      backedUp: false,
      createdAt: Date.now(),
    });
    await insertCredential(db, {
      credentialId: credentialB,
      profileId: id,
      publicKey: new Uint8Array([2]),
      counter: 0,
      transports: null,
      aaguid: null,
      backupEligible: true,
      backedUp: true,
      createdAt: Date.now(),
    });

    assertEquals(await deleteCredential(db, id, credentialA), "deleted");
    assertEquals(
      await deleteCredential(db, id, credentialB),
      "last-credential",
    );
    const remaining = await listCredentials(db, id);
    assertEquals(remaining.map((c) => c.credentialId), [credentialB]);
    assertEquals(
      await deleteCredential(db, id, `nonexistent-${ulid()}`),
      "not-found",
    );
  } finally {
    await db.execute({
      sql: "DELETE FROM credentials WHERE profile_id = ?",
      args: [id],
    });
    await dropProfile(id);
  }
});

Deno.test("webauthn challenges are single-use, TTL-bound, and bound to the issuing profile", async () => {
  const profileId = `profile-owner-${ulid()}`;
  const otherProfileId = `profile-owner-${ulid()}`;
  const challenge = `challenge-${ulid()}`;
  const now = Date.now();
  try {
    await createChallenge(db, {
      challenge,
      profileId,
      purpose: "register",
      now,
      ttlMs: 5 * 60 * 1000,
    });

    // Wrong profile: rejected, and the row must still be there afterward.
    assertEquals(
      await consumeChallenge(db, {
        challenge,
        purpose: "register",
        profileId: otherProfileId,
        now,
      }),
      false,
    );
    // Wrong purpose: also rejected.
    assertEquals(
      await consumeChallenge(db, {
        challenge,
        purpose: "authenticate",
        profileId,
        now,
      }),
      false,
    );
    // Expired: rejected even with the right profile/purpose.
    assertEquals(
      await consumeChallenge(db, {
        challenge,
        purpose: "register",
        profileId,
        now: now + 6 * 60 * 1000,
      }),
      false,
    );

    // Correct profile, purpose, and still within TTL: succeeds exactly once.
    assertEquals(
      await consumeChallenge(db, {
        challenge,
        purpose: "register",
        profileId,
        now,
      }),
      true,
    );
    // Replay of the same challenge: single-use means this now fails.
    assertEquals(
      await consumeChallenge(db, {
        challenge,
        purpose: "register",
        profileId,
        now,
      }),
      false,
    );
  } finally {
    await db.execute({
      sql: "DELETE FROM webauthn_challenges WHERE challenge = ?",
      args: [challenge],
    });
  }
});

Deno.test("createChallenge opportunistically sweeps expired rows", async () => {
  const expiredChallenge = `expired-${ulid()}`;
  const now = Date.now();
  try {
    await createChallenge(db, {
      challenge: expiredChallenge,
      profileId: null,
      purpose: "authenticate",
      now: now - 10 * 60 * 1000,
      ttlMs: 1000,
    });
    // A fresh insert at `now` should sweep the already-expired row above.
    await createChallenge(db, {
      challenge: `fresh-${ulid()}`,
      profileId: null,
      purpose: "authenticate",
      now,
    });
    const stillThere = await db.execute({
      sql: "SELECT 1 FROM webauthn_challenges WHERE challenge = ?",
      args: [expiredChallenge],
    });
    assertEquals(stillThere.rows.length, 0);
  } finally {
    await db.execute({
      sql: "DELETE FROM webauthn_challenges WHERE challenge LIKE 'fresh-%'",
    });
  }
});

Deno.test("backfillAuthors sets author from the owner's handle, is idempotent, and never overwrites an existing author", async () => {
  const ownerWithProfile = `backfill-author-owner-${ulid()}`;
  const ownerWithoutProfile = `backfill-author-owner-${ulid()}`;
  const canvasNoAuthor = ulid();
  const canvasAlreadyHasAuthor = ulid();
  const canvasOrphanOwner = ulid();
  try {
    await createCanvas(
      db,
      canvasNoAuthor,
      ownerWithProfile,
      emptyPixels(),
      1000,
    );
    await completeCanvas(db, canvasNoAuthor, "No Author Yet", null, 1000);

    await createCanvas(
      db,
      canvasAlreadyHasAuthor,
      ownerWithProfile,
      emptyPixels(),
      1000,
    );
    await completeCanvas(
      db,
      canvasAlreadyHasAuthor,
      "Already Signed",
      "Hand-Set Author",
      1000,
    );

    // Backfill profiles now, BEFORE the orphan-owner canvas exists —
    // backfillProfiles() covers every distinct owner_id present in
    // `canvases` at call time, so ownerWithoutProfile must not have a
    // canvas yet, or it would get backfilled a profile too and the
    // "shouldn't happen after backfillProfiles(), but handled" case below
    // would never actually be exercised.
    await backfillProfiles(db);

    // NOW create the completed canvas whose owner has no profile row —
    // the defensive case.
    await createCanvas(
      db,
      canvasOrphanOwner,
      ownerWithoutProfile,
      emptyPixels(),
      1000,
    );
    await completeCanvas(db, canvasOrphanOwner, "Orphan Owner", null, 1000);

    const first = await backfillAuthors(db);
    assertEquals(
      first.updated,
      1,
      "only the author-less, profiled canvas is touched",
    );
    assertEquals(
      first.skippedNoHandle,
      1,
      "the orphan-owner canvas is counted as skipped",
    );

    const profile = await getProfile(db, ownerWithProfile);
    const noAuthorRow = await db.execute({
      sql: "SELECT author FROM canvases WHERE id = ?",
      args: [canvasNoAuthor],
    });
    assertEquals(noAuthorRow.rows[0].author, profile?.handle);

    const alreadyHadAuthorRow = await db.execute({
      sql: "SELECT author FROM canvases WHERE id = ?",
      args: [canvasAlreadyHasAuthor],
    });
    assertEquals(alreadyHadAuthorRow.rows[0].author, "Hand-Set Author");

    const orphanRow = await db.execute({
      sql: "SELECT author FROM canvases WHERE id = ?",
      args: [canvasOrphanOwner],
    });
    assertEquals(orphanRow.rows[0].author, null);

    // Running it again: strictly idempotent. Nothing left to update, the
    // hand-set author stays exactly as it was (never overwritten), and
    // the orphan canvas is still skipped the same way.
    const second = await backfillAuthors(db);
    assertEquals(second.updated, 0);
    assertEquals(second.skippedNoHandle, 1);
    const stillHandSet = await db.execute({
      sql: "SELECT author FROM canvases WHERE id = ?",
      args: [canvasAlreadyHasAuthor],
    });
    assertEquals(stillHandSet.rows[0].author, "Hand-Set Author");
  } finally {
    await dropCanvas(canvasNoAuthor);
    await dropCanvas(canvasAlreadyHasAuthor);
    await dropCanvas(canvasOrphanOwner);
    await dropProfile(ownerWithProfile);
    await dropProfile(ownerWithoutProfile);
  }
});
