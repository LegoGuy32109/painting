# Managing Turso databases

This project uses [Turso](https://turso.tech) (the `tursodb` engine
specifically, not classic `libsql`) for durable storage. `tursodb` matters
because it's the only engine that supports `BEGIN CONCURRENT` — see
`src/server/db.ts` for why the app needs that.

## Current databases

| Name | Purpose | Lifecycle |
|---|---|---|
| `painting-prod` | Real production data, served at `paint.joshhale.me` | Persistent |
| `painting-dev` | The `dev` branch / any preview deploy | Persistent |
| `painting-local` | Your own machine running `deno task dev` or `test:db` | Persistent |
| `painting-test-<slug>` | One per `test:e2e` run | Created, migrated, tested, deleted every run — never persists |

Every database is provisioned with `use_tursodb: true`. Without that flag you
get the classic engine, which rejects `BEGIN CONCURRENT` with a hard SQL parse
error — confirmed the hard way once, when `painting` (the very first database
here) turned out to be classic-engine and had to be replaced.

The mapping from database to *where it's actually used* (which Deno Deploy
context reads which database) lives in
`docs/deno-deploy-env-vars.md` — this file is just about the databases
themselves.

## Creating a database

There's no `turso` CLI installed on this machine; everything goes through the
Platform API directly with `TURSO_API_KEY` (the org-wide management token,
different from a per-database `TURSO_DB_TOKEN`):

```bash
curl -s -X POST -H "Authorization: Bearer $TURSO_API_KEY" -H "Content-Type: application/json" \
  "https://api.turso.tech/v1/organizations/legoguy/databases" \
  -d '{"name":"painting-whatever","group":"default","use_tursodb":true}'
```

Then mint a token for it:

```bash
curl -s -X POST -H "Authorization: Bearer $TURSO_API_KEY" \
  "https://api.turso.tech/v1/organizations/legoguy/databases/painting-whatever/auth/tokens?expiration=never&authorization=full-access"
```

And apply the schema (this just runs `migrate()` against whatever
`TURSO_DB_URL`/`TURSO_DB_TOKEN` are in the environment — it's idempotent, safe
to re-run):

```bash
TURSO_DB_URL="libsql://painting-whatever-legoguy.aws-us-east-2.turso.io" \
TURSO_DB_TOKEN="<jwt from above>" \
deno eval --ext=ts '
import { createDb, migrate } from "./src/server/db.ts";
const schemaSql = await Deno.readTextFile("./src/server/schema.sql");
await migrate(createDb(), schemaSql);
console.log("migrated");
'
```

## Deleting a database

```bash
curl -s -X DELETE -H "Authorization: Bearer $TURSO_API_KEY" \
  "https://api.turso.tech/v1/organizations/legoguy/databases/painting-whatever"
```

Watch for `delete_protection` — the very first `painting` database had it set
and rejected the delete until it was turned off first:

```bash
curl -s -X PATCH -H "Authorization: Bearer $TURSO_API_KEY" -H "Content-Type: application/json" \
  "https://api.turso.tech/v1/organizations/legoguy/databases/painting-whatever/configuration" \
  -d '{"delete_protection": false}'
```

## Listing what currently exists

```bash
curl -s -H "Authorization: Bearer $TURSO_API_KEY" \
  "https://api.turso.tech/v1/organizations/legoguy/databases" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(db['Name'], '->', db['Hostname']) for db in d['databases']]"
```

## Ephemeral test databases

`scripts/ephemeral-test-db.ts` (run via `deno task test:e2e`) automates the
whole create → migrate → test → delete cycle above for a throwaway
`painting-test-<time-slug>` database. The slug means more than one can exist
at once — a local run and a CI run, or several CI runs, don't collide. It
deletes the database in a `finally`, so a failing test suite still cleans up.

Nothing about this needs a rename operation — **Turso databases can't be
renamed at all** (confirmed: no such endpoint exists in the Platform API, and
attempting to set `name` through the configuration PATCH is silently
ignored). If a database needs a different name, the only path is delete and
recreate, which is exactly how `painting` became `painting-prod`.

## What's *not* possible

- No rename (see above).
- No self-hosted Turso Cloud server — the open-source `tursodatabase/turso`
  engine is an embeddable in-process library (`@tursodatabase/database`), not
  a server binary you can run yourself. There's no `turso serve` equivalent
  in the open-source repo.
- Existing auth tokens can't be re-fetched once issued — only new ones minted
  (harmless to do; it doesn't invalidate the old one).
