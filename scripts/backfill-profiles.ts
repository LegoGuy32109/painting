// Backfills a `profiles` row (with a minted handle) for every distinct
// `canvases.owner_id` that predates Phase 2's identity model — see
// migrations/001_initial.sql.
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
// ensureProfile() in db.ts), so an operator who skips this script just gets
// each returning guest's profile created the moment they next paint or
// sign — never an error. A canvas's author is derived at read time by
// joining profiles.handle off owner_id (see db.ts), so an owner_id with no
// profile row simply reads as a null author in the meantime, rather than
// anything permanently missing.
//
// Usage: deno run --allow-net --allow-env scripts/backfill-profiles.ts
// against whatever TURSO_DB_URL/TURSO_DB_TOKEN currently point at
// (painting-local by default, matching every other script here).

import { type Client, createDb, isHandleTaken } from "../src/server/db.ts";
import { mintUniqueHandle } from "../src/server/handles.ts";

export interface BackfillResult {
  inserted: number;
  alreadyPresent: number;
  distinctOwners: number;
}

/**
 * The actual profile-backfill logic, factored out of the CLI entrypoint
 * below so it's directly testable against a real (test) database — see
 * tests/db_test.ts — without shelling out to this file as a subprocess.
 */
export async function backfillProfiles(db: Client): Promise<BackfillResult> {
  const distinctOwners = await db.execute(
    "SELECT owner_id, MIN(created_at) AS created_at, " +
      "MAX(COALESCE(last_stroke_at, created_at)) AS last_seen_at " +
      "FROM canvases GROUP BY owner_id",
  );

  let inserted = 0;
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
    } else {
      alreadyPresent++;
    }
  }

  return {
    inserted,
    alreadyPresent,
    distinctOwners: distinctOwners.rows.length,
  };
}

if (import.meta.main) {
  const db = createDb();
  const profileResult = await backfillProfiles(db);
  console.log(
    `Backfilled ${profileResult.inserted} profile(s); ${profileResult.alreadyPresent} ` +
      `already had one (${profileResult.distinctOwners} distinct owner_id total).`,
  );
}
