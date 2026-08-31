import type { Client } from "./db.ts";

const migrationsDirectory = new URL("../../migrations/", import.meta.url);

interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function checksum(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function readMigrations(): Promise<Migration[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(migrationsDirectory)) {
    if (entry.isFile && /^\d{3}_[a-z0-9_]+\.sql$/.test(entry.name)) {
      files.push(entry.name);
    }
  }
  return await Promise.all(
    files.sort().map(async (file) => {
      const sql = await Deno.readTextFile(new URL(file, migrationsDirectory));
      return { version: file, sql, checksum: await checksum(sql) };
    }),
  );
}

/**
 * Applies each immutable migration exactly once. This is intentionally a
 * deployment operation, never something a serving instance performs.
 */
export async function migrateDatabase(db: Client): Promise<string[]> {
  // Scoped to THIS migration connection only — SQLite's foreign_keys
  // pragma is per-connection, so this says nothing about what a serving
  // instance sees. The app deliberately does not depend on it; see the
  // "Deleting a canvas" note in db.ts for why every delete removes its own
  // dependent rows instead.
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const result = await db.execute(
    "SELECT version, checksum FROM schema_migrations",
  );
  const applied = new Map(
    result.rows.map((row) => [String(row.version), String(row.checksum)]),
  );
  const migrations = await readMigrations();
  const pending: Migration[] = [];

  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing && existing !== migration.checksum) {
      throw new Error(
        `migration ${migration.version} was changed after it was applied`,
      );
    }
    if (!existing) pending.push(migration);
  }

  for (const migration of pending) {
    await db.batch([
      ...statements(migration.sql),
      {
        sql:
          "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
        args: [migration.version, migration.checksum, Date.now()],
      },
    ], "immediate");
  }
  return pending.map((migration) => migration.version);
}

export async function pendingMigrations(db: Client): Promise<string[]> {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)",
  );
  const result = await db.execute(
    "SELECT version, checksum FROM schema_migrations",
  );
  const applied = new Map(
    result.rows.map((row) => [String(row.version), String(row.checksum)]),
  );
  const migrations = await readMigrations();
  // Apply the SAME checksum check migrateDatabase() does, so a dry run
  // predicts the real run instead of contradicting it. Without this, an
  // already-applied migration whose file has since been edited reports as
  // "nothing pending" — a false all-clear for a database whose real schema
  // no longer matches the repo, where the actual migrate would then throw.
  for (const migration of migrations) {
    const existing = applied.get(migration.version);
    if (existing && existing !== migration.checksum) {
      throw new Error(
        `migration ${migration.version} was changed after it was applied`,
      );
    }
  }
  return migrations.filter((migration) => !applied.has(migration.version)).map((
    migration,
  ) => migration.version);
}
