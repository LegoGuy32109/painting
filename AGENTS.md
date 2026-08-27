# AGENTS.md

Read this before doing anything else in this repo.

## What this is

Joy of Painting — a browser-based pixel painting app. See `README.md` for
project layout, dev commands, and the browser-code conventions (no-build,
vanilla ES modules, no client framework/bundler).

## The one convention that matters most

**Client stays vanilla JavaScript.** `src/client/` is plain ES modules with
`// @ts-check` and JSDoc typed against `src/shared/paint-types.d.ts` — no
libraries beyond what's already there, no framework, no bundler. **Real
TypeScript, and real dependencies, belong on the server** (`src/server/`) and in
`scripts/`. When in doubt about whether something is "client" or "server," ask
before adding a dependency to `src/client/`.

## docs/

- `docs/joy-of-painting-interface-spec.md` — the product/interface spec this app
  implements.
- `docs/NEXT-PHASE.md` — what to build next, and what's explicitly out of scope
  for the current phase.
- `docs/turso-databases.md` — the Turso databases this project uses
  (`painting-prod`/`-dev`/`-local`/`-test-*`), how to create, migrate, and
  delete them. Read it before changing a schema: dev is resettable, while
  production uses the immutable `migrations/` history and `migrate:prod`.
- `docs/deno-deploy-env-vars.md` — how this app's environment variables are
  scoped per Deno Deploy context (Production/Preview/Build/Local), and the
  tooling (`scripts/set-deploy-env.ts`) needed to set a different value per
  context under one key, which the `deno deploy` CLI can't do on its own.
- `docs/signing-key-rotation.md` — how to rotate `PAINTING_KEYS`, the HMAC
  keyset behind guest session cookies (and, from Phase 3 on, WebAuthn
  challenges/merge tokens/transfer codes): generating a key, the waiting
  period before dropping an old one, and the deliberate tradeoff of dropping
  one early.

Read the relevant doc before touching databases or deploy configuration — both
have sharp edges that already bit us once each (a classic-engine database that
silently couldn't do concurrent writes; a CLI command that silently clobbers the
wrong context if you don't check its result before chaining the next command).

## Database and deploy tooling lives in `scripts/`

- `scripts/ephemeral-test-db.ts` (`deno task test:e2e`) — creates a throwaway
  `painting-test-<slug>` database, runs the db test suite against it, deletes it
  in a `finally` regardless of pass/fail.
- `scripts/migrate-prod.ts` (`deno task migrate:prod`) — applies the immutable
  production migration history. It refuses any database other than
  `painting-prod`.
- `scripts/bootstrap-dev-db.ts` (`deno task bootstrap:dev`) — initializes a
  newly recreated empty `painting-dev` database. It is not a migration tool.
- `scripts/backup-environment-db.ts` and `clear-environment-db.ts` — backup or
  clear a named deployment database. Read `docs/turso-databases.md` before using
  either; clearing requires explicit confirmation.
- `scripts/save.ts` (`deno task save "message"`) — formats, type-checks,
  commits, and pushes the current branch. It warns when the branch is master.
- `scripts/set-deploy-env.ts` — sets one Deno Deploy env var scoped to one
  context. Use this, not `deno deploy env add`, for anything that needs a
  different value per context (see `docs/deno-deploy-env-vars.md` for why).

## Secrets

`.env` is gitignored and must stay that way — it holds real Turso database
tokens, the Turso org management key, and a Deno Deploy personal access token.
`.env.example` documents every variable's shape without real values; keep it in
sync when adding a new one.
