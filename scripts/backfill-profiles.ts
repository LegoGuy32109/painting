// Backfills a `profiles` row (with a minted handle) for every distinct
// `canvases.owner_id` that predates Phase 2's identity model, and then
// backfills `canvases.author` for already-completed canvases from that
// same handle — both see migrations/001_initial.sql.
//
// This is NOT a migration and does NOT belong in scripts/bootstrap-dev-db.ts:
// that script explicitly refuses a non-empty database (it only initializes
// a freshly recreated, empty painting-dev), whereas this backfill is only
// ever needed against a database that already HAS canvases rows —
// painting-local, one developer's durable local work, being the actual
// case that matters pre-production. It's also not expressible as pure SQL
// in migrations/001_initial.sql: each backfilled profile needs its OWN 32
// random bytes for user_handle (the WebAuthn user handle must be unique
// and opaque per profile), and SQLite has no per-row random-bytes
// generator to lean on.
//
// Convenience, not a prerequisite: the app's own runtime already creates a
// profiles row lazily on a guest's first mutation after this ships (see
// ensureProfile() in db.ts), so an operator who skips this script just
// gets each returning guest's profile (and, on their next sign, their
// canvases.author) created the moment they next paint or sign — never an
// error. Without running it, though, every painting signed BEFORE this
// script runs stays permanently authorless in the public feed, since a
// guest who never returns never triggers that lazy path.
//
// Usage: deno run --allow-net --allow-env scripts/backfill-profiles.ts
// against whatever TURSO_DB_URL/TURSO_DB_TOKEN currently point at
// (painting-local by default, matching every other script here).

import { type Client, createDb, isHandleTaken } from "../src/server/db.ts";
import { mintUniqueHandle } from "../src/server/handles.ts";

export interface BackfillResult {
  inserted: number;
  /** owner_ids whose profile (and handle) THIS run created — their handle is
   * newly invented, not recalled, which backfillAuthors() relies on. */
  mintedOwnerIds: string[];
  alreadyPresent: number;
  distinctOwners: number;
}

/**
 * The actual profile-backfill logic, factored out of the CLI entrypoint
 * below so it's directly testable against a real (test) database — see
 * tests/db_test.ts — without shelling out to this file as a subprocess.
 * Must run BEFORE backfillAuthors() (see below), which depends on every
 * relevant owner_id already having a profile with a handle.
 */
export async function backfillProfiles(db: Client): Promise<BackfillResult> {
  const distinctOwners = await db.execute(
    "SELECT owner_id, MIN(created_at) AS created_at, " +
      "MAX(COALESCE(last_stroke_at, created_at)) AS last_seen_at " +
      "FROM canvases GROUP BY owner_id",
  );

  let inserted = 0;
  const mintedOwnerIds: string[] = [];
  let alreadyPresent = 0;

  for (const row of distinctOwners.rows) {
    const ownerId = String(row.owner_id);
    const createdAt = Number(row.created_at);
    const lastSeenAt = Number(row.last_seen_at);
    const userHandle = crypto.getRandomValues(new Uint8Array(32));
    // Minted even when the row turns out to already exist (INSERT OR
    // IGNORE below then no-ops and this handle is simply discarded) — the
    // uniqueness check has to happen before the insert either way, and
    // that race is rare and harmless, same tradeoff ensureProfile() makes.
    const handle = await mintUniqueHandle(
      ownerId,
      (candidate) => isHandleTaken(db, candidate),
    );

    const result = await db.execute({
      sql:
        "INSERT OR IGNORE INTO profiles (id, handle, user_handle, created_at, last_seen_at) " +
        "VALUES (?, ?, ?, ?, ?)",
      args: [ownerId, handle, userHandle, createdAt, lastSeenAt],
    });
    if (result.rowsAffected === 1) {
      inserted++;
      mintedOwnerIds.push(ownerId);
    } else {
      alreadyPresent++;
    }
  }

  return {
    inserted,
    mintedOwnerIds,
    alreadyPresent,
    distinctOwners: distinctOwners.rows.length,
  };
}

export interface AuthorBackfillResult {
  /** Rows given the owning profile's pre-existing handle. */
  updated: number;
  /** Rows given DEFAULT_AUTHOR, for either reason described below. */
  defaulted: number;
  /** Of those, rows whose owner had no profile row at all. */
  orphanedOwners: number;
}

/** Stand-in author for canvases whose real author cannot be known. */
export const DEFAULT_AUTHOR = "Josh";

/** SQLite caps bound parameters per statement; chunk well under it. */
const OWNER_CHUNK = 200;

/**
 * Sets `canvases.author` on already-completed canvases that lack one.
 *
 * Two distinct cases, and conflating them is what makes a backfill lie:
 *
 *  - The owner's profile ALREADY EXISTED, so its handle is a real identity
 *    that predates this run. Use it.
 *  - The owner's profile was minted by backfillProfiles() moments ago, so
 *    its handle is a random name this script just invented. Using it would
 *    put noise shaped like data on the public display wall — a painting
 *    attributed to "Lime Dolphin A938", a name that did not exist when the
 *    painting was made. Use DEFAULT_AUTHOR instead: not knowing who painted
 *    something is honest, inventing an author is not.
 *
 * Strictly idempotent and non-destructive: `author IS NULL` throughout means
 * a canvas that already has an author — captured server-side at signing (see
 * completeCanvas() in db.ts) or set by an earlier run — is never touched.
 * That matters beyond idempotency: overwriting it would destroy the snapshot
 * semantics that stop a later handle rename from retroactively relabelling
 * public work.
 *
 * Must run AFTER backfillProfiles(), and be passed its `mintedOwnerIds`.
 * It only ever reads profiles; it never creates one.
 */
export async function backfillAuthors(
  db: Client,
  mintedOwnerIds: string[] = [],
): Promise<AuthorBackfillResult> {
  let defaulted = 0;

  // Case 2 first, so these rows are settled before the handle-based pass
  // below could otherwise claim them.
  for (let i = 0; i < mintedOwnerIds.length; i += OWNER_CHUNK) {
    const chunk = mintedOwnerIds.slice(i, i + OWNER_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const result = await db.execute({
      sql: "UPDATE canvases SET author = ? " +
        "WHERE completed_at IS NOT NULL AND author IS NULL " +
        `AND owner_id IN (${placeholders})`,
      args: [DEFAULT_AUTHOR, ...chunk],
    });
    defaulted += result.rowsAffected;
  }

  // Case 1: a profile that genuinely predates this run.
  const updated = await db.execute(
    "UPDATE canvases SET author = (" +
      "SELECT handle FROM profiles WHERE profiles.id = canvases.owner_id" +
      ") " +
      "WHERE completed_at IS NOT NULL AND author IS NULL " +
      "AND EXISTS (" +
      "SELECT 1 FROM profiles WHERE profiles.id = canvases.owner_id AND profiles.handle IS NOT NULL" +
      ")",
  );

  // Whatever is left has no profile row at all, or one without a handle.
  // Should not happen after backfillProfiles(), but a permanently blank
  // author on a public painting is worse than a stand-in, so handle it
  // rather than assume it away.
  const remainder = await db.execute({
    sql: "UPDATE canvases SET author = ? " +
      "WHERE completed_at IS NOT NULL AND author IS NULL",
    args: [DEFAULT_AUTHOR],
  });
  defaulted += remainder.rowsAffected;

  return {
    updated: updated.rowsAffected,
    defaulted,
    orphanedOwners: remainder.rowsAffected,
  };
}

if (import.meta.main) {
  const db = createDb();
  const profileResult = await backfillProfiles(db);
  console.log(
    `Backfilled ${profileResult.inserted} profile(s); ${profileResult.alreadyPresent} ` +
      `already had one (${profileResult.distinctOwners} distinct owner_id total).`,
  );
  const authorResult = await backfillAuthors(
    db,
    profileResult.mintedOwnerIds,
  );
  console.log(
    `Backfilled author on ${authorResult.updated} completed canvas(es) from ` +
      `their owner's pre-existing handle; ${authorResult.defaulted} fell back ` +
      `to "${DEFAULT_AUTHOR}" (owner's identity was minted by this run, so a ` +
      `handle would be invented rather than recalled` +
      `${
        authorResult.orphanedOwners > 0
          ? `; ${authorResult.orphanedOwners} had no profile at all`
          : ""
      }). ` +
      `No completed canvas is left without an author.`,
  );
}
