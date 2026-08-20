/**
 * Initializes a newly recreated, empty painting-dev database. Development is
 * disposable: reset it for schema changes instead of incrementally migrating
 * it. This command refuses a non-empty database.
 */
import { migrateDatabase } from "../src/server/migrations.ts";
import { openEnvironmentDatabase, parseDatabaseEnvironment } from "./database-environment.ts";

const db = await openEnvironmentDatabase(parseDatabaseEnvironment("Development"));
const existing = await db.execute(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
);
if (existing.rows.length > 0) {
  throw new Error("bootstrap-dev-db only initializes a newly recreated empty database");
}

const applied = await migrateDatabase(db);
console.log(`Initialized painting-dev with: ${applied.join(", ")}`);
