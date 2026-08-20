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
const confirmation = confirmIndex === -1 ? undefined : Deno.args[confirmIndex + 1];
if (confirmation !== environment.label) {
  throw new Error(`refusing to clear ${environment.database}; pass --confirm ${environment.label}`);
}
if (environment.label === "Production" && !Deno.args.includes("--allow-production")) {
  throw new Error("refusing to clear production; pass --allow-production as well");
}

const db = await openEnvironmentDatabase(environment);
// canvas_events references canvases with ON DELETE CASCADE, so this removes
// every user-created painting/event while leaving the schema ready to use.
await db.execute("DELETE FROM canvases");
console.log(`Cleared all painting data from ${environment.database}`);
