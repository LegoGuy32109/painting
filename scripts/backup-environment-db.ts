/**
 * Creates a portable JSON snapshot of every application table in the selected
 * Deno Deploy environment. It only reads the database.
 *
 * TURSO_DB_URL=<matching url> TURSO_DB_TOKEN=<token> \
 *   deno task backup:db Development
 */
import {
  backupFileName,
  openEnvironmentDatabase,
  parseDatabaseEnvironment,
} from "./database-environment.ts";

const environment = parseDatabaseEnvironment(Deno.args[0]);
const output = Deno.args[1] ?? backupFileName(environment);
const outputUrl = new URL(output, `file://${Deno.cwd()}/`);
const db = await openEnvironmentDatabase(environment);

/** @param {unknown} value */
function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return { encoding: "base64", data: btoa(binary) };
  }
  if (value instanceof ArrayBuffer) return jsonValue(new Uint8Array(value));
  if (typeof value === "bigint") {
    return { encoding: "bigint", data: value.toString() };
  }
  return value;
}

function identifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    throw new Error(`unsafe table name: ${name}`);
  }
  return `"${name}"`;
}

const tablesResult = await db.execute(
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__turso_internal_%' ORDER BY name",
);
const tables = await Promise.all(tablesResult.rows.map(async (row) => {
  const name = String(row.name);
  const result = await db.execute(`SELECT * FROM ${identifier(name)}`);
  return {
    name,
    schema: row.sql,
    rows: result.rows.map((record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [key, jsonValue(value)]),
      )
    ),
  };
}));

await Deno.mkdir(new URL(".", outputUrl), { recursive: true });
await Deno.writeTextFile(
  outputUrl,
  `${
    JSON.stringify(
      {
        format: "joy-of-painting-db-backup/v1",
        environment: environment.label,
        database: environment.database,
        capturedAt: new Date().toISOString(),
        tables,
      },
      null,
      2,
    )
  }\n`,
);
console.log(`Wrote ${output}`);
