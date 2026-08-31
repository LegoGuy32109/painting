/**
 * Deletes all painting data from the selected database while preserving its
 * schema and migration ledger. This is irreversible.
 *
 * TURSO_DB_URL=<matching url> TURSO_DB_TOKEN=<token> \
 *   deno task clear:db Development --confirm Development
 */
import {
  openEnvironmentDatabase,
  parseDatabaseEnvironment,
} from "./database-environment.ts";

const environment = parseDatabaseEnvironment(Deno.args[0]);
const confirmIndex = Deno.args.indexOf("--confirm");
const confirmation = confirmIndex === -1
  ? undefined
  : Deno.args[confirmIndex + 1];
if (confirmation !== environment.label) {
  throw new Error(
    `refusing to clear ${environment.database}; pass --confirm ${environment.label}`,
  );
}
if (
  environment.label === "Production" &&
  !Deno.args.includes("--allow-production")
) {
  throw new Error(
    "refusing to clear production; pass --allow-production as well",
  );
}

const db = await openEnvironmentDatabase(environment);
// canvas_events DOES declare ON DELETE CASCADE, but that cascade never fires
// here: SQLite's foreign_keys pragma is off by default and is per-connection,
// and nothing turns it on for the connection openEnvironmentDatabase() hands
// back. Deleting only `canvases` therefore left every event row behind,
// orphaned and unreachable — the opposite of "cleared". Same trap, and the
// same fix, as the app's own delete paths; see the "Deleting a canvas" note
// in src/server/db.ts.
//
// Events first, then their canvases: the reverse order would strand any row
// inserted between the two statements.
const events = await db.execute("DELETE FROM canvas_events");
const canvases = await db.execute("DELETE FROM canvases");
console.log(
  `Cleared all painting data from ${environment.database} ` +
    `(${canvases.rowsAffected} canvas(es), ${events.rowsAffected} event(s))`,
);

// Loud rather than silent: if this ever prints a non-zero count, the delete
// above missed something and the next person to look at this database will
// find rows that "clearing" was supposed to have removed.
const leftover = await db.execute(
  "SELECT COUNT(*) AS n FROM canvas_events e " +
    "LEFT JOIN canvases c ON c.id = e.canvas_id WHERE c.id IS NULL",
);
const orphans = Number(leftover.rows[0].n);
if (orphans > 0) {
  console.warn(`WARNING: ${orphans} orphaned canvas_events row(s) remain`);
}
