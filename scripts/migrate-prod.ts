/**
 * Applies the repository's immutable migrations to painting-prod only.
 * It is a release gate, not a development or application-startup command.
 */
import {
  migrateDatabase,
  pendingMigrations,
} from "../src/server/migrations.ts";
import {
  openEnvironmentDatabase,
  parseDatabaseEnvironment,
} from "./database-environment.ts";

const db = await openEnvironmentDatabase(
  parseDatabaseEnvironment("Production"),
);
if (Deno.args.includes("--dry-run")) {
  const pending = await pendingMigrations(db);
  console.log(
    pending.length ? pending.join("\n") : "No pending production migrations.",
  );
} else {
  const applied = await migrateDatabase(db);
  console.log(
    applied.length
      ? `Applied: ${applied.join(", ")}`
      : "No pending production migrations.",
  );
}
