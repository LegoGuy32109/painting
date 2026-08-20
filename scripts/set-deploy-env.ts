// Sets a Deno Deploy environment variable scoped to a specific context
// (Production, Preview, Build, or Local), with a distinct value per context
// under the same key.
//
// Why this exists instead of `deno deploy env add`: that command hardcodes
// `context_ids: null` (all contexts) on every add, and the backend refuses a
// second all-contexts entry once a context-scoped one exists for the same
// key — so it can never produce two different values for one key. The
// underlying API (envVarsContexts.updateEnvVars) fully supports setting
// context_ids at creation time; the CLI just never exposed it as a flag.
// This script calls that same API directly, reusing the CLI's own auth
// helpers, to set a context-scoped value atomically in one call.
//
// Usage:
//   deno run -A scripts/set-deploy-env.ts <Context> <KEY> <value> [secret]
//
// Example:
//   deno run -A scripts/set-deploy-env.ts Preview TURSO_DB_URL "libsql://painting-dev-..."
//   deno run -A scripts/set-deploy-env.ts Preview TURSO_DB_TOKEN "eyJ..." secret
//
// Requires DENO_DEPLOY_TOKEN in the environment (a `ddp_...` personal access
// token — see docs/deno-deploy-env-vars.md).

// Dynamic import (not static): `deno check` refuses to type-check an https
// import of a JSR package, so this is the documented workaround.
const authModuleUrl = "https://jsr.io/@deno/deploy/0.0.9904/auth.ts";
const { createTrpcClient, tokenStorage } = await import(authModuleUrl);

const ORG = "legoguy32109";
const APP = "painting";

const [contextName, key, value, secretFlag] = Deno.args;
if (!contextName || !key || value === undefined) {
  console.error(
    "Usage: deno run -A scripts/set-deploy-env.ts <Context> <KEY> <value> [secret]",
  );
  Deno.exit(1);
}
const isSecret = secretFlag === "secret";

const token = Deno.env.get("DENO_DEPLOY_TOKEN");
if (!token) throw new Error("DENO_DEPLOY_TOKEN must be set");
tokenStorage.set(token, true);

const trpcClient = createTrpcClient({
  debug: false,
  endpoint: "https://console.deno.com",
  json: true as const,
  nonInteractive: true as const,
});

const app = await trpcClient.query("apps.get", { org: ORG, app: APP }) as { id: string };
const contexts = await trpcClient.query("envVarsContexts.listContexts", { org: ORG }) as
  { id: string; name: string }[];

const target = contexts.find((c) => c.name === contextName);
if (!target) {
  throw new Error(
    `Context "${contextName}" not found. Known contexts: ${contexts.map((c) => c.name).join(", ")}`,
  );
}

const existing = await trpcClient.query("envVarsContexts.list", { org: ORG, app: APP }) as
  { id: string; key: string; context_ids: string[] | null }[];
const current = existing.find((variable) =>
  variable.key === key &&
  (variable.context_ids === null || variable.context_ids.includes(target.id))
);
const variable = {
  key,
  value,
  is_secret: isSecret,
  context_ids: current?.context_ids ?? [target.id],
};
const result = await trpcClient.mutation("envVarsContexts.updateEnvVars", {
  org: ORG,
  add: current ? [] : [{ app_id: app.id, ...variable }],
  update: current ? [{ id: current.id, ...variable }] : [],
  remove: [],
});

console.log(`${current ? "Updated" : "Set"} ${key} (${contextName}):`, JSON.stringify(result));
