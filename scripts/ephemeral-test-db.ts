// Creates a throwaway `painting-test-<slug>` Turso database (real tursodb
// engine, so BEGIN CONCURRENT works), migrates it, runs the db test suite
// against it, then deletes it — regardless of whether the tests pass. The
// time-slug means multiple runs (local + CI, or several CI jobs) can each
// have their own database on the account at once without colliding.
//
// Usage: deno run --allow-net --allow-env --allow-read --allow-run scripts/ephemeral-test-db.ts

const API_BASE = "https://api.turso.tech/v1";

const apiKey = requireEnv("TURSO_API_KEY");
const orgSlug = requireEnv("TURSO_ORG_SLUG");

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function slug(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} -> ${res.status}: ${await res
        .text()}`,
    );
  }
  return res.json();
}

async function createDatabase(name: string): Promise<{ hostname: string }> {
  const result = await api(`/organizations/${orgSlug}/databases`, {
    method: "POST",
    body: JSON.stringify({ name, group: "default", use_tursodb: true }),
  });
  return { hostname: result.database.Hostname };
}

async function createToken(name: string): Promise<string> {
  const result = await api(
    `/organizations/${orgSlug}/databases/${name}/auth/tokens?expiration=never&authorization=full-access`,
    { method: "POST" },
  );
  return result.jwt;
}

async function deleteDatabase(name: string): Promise<void> {
  await api(`/organizations/${orgSlug}/databases/${name}`, {
    method: "DELETE",
  });
}

const name = `painting-test-${slug()}`;
console.log(`Creating ephemeral database: ${name}`);
const { hostname } = await createDatabase(name);
const token = await createToken(name);
const dbUrl = `libsql://${hostname}`;

let exitCode = 1;
try {
  const { createDb } = await import("../src/server/db.ts");
  const { migrateDatabase } = await import("../src/server/migrations.ts");
  Deno.env.set("TURSO_DB_URL", dbUrl);
  Deno.env.set("TURSO_DB_TOKEN", token);

  const db = createDb();
  await migrateDatabase(db);
  console.log(`Migrated ${name}, running tests...`);

  const testProcess = new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "tests/db_test.ts",
    ],
    env: { ...Deno.env.toObject(), TURSO_DB_URL: dbUrl, TURSO_DB_TOKEN: token },
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await testProcess.output();
  exitCode = code;
} finally {
  console.log(`Deleting ephemeral database: ${name}`);
  await deleteDatabase(name);
}

Deno.exit(exitCode);
