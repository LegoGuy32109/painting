# Managing Turso databases

This project uses [Turso](https://turso.tech) (the `tursodb` engine
specifically, not classic `libsql`) for durable storage. `tursodb` matters
because it's the only engine that supports `BEGIN CONCURRENT` — see
`src/server/db.ts` for why the app needs that.

## Current databases

| Name | Purpose | Lifecycle |
|---|---|---|
| `painting-prod` | Real production data, served at `paint.joshhale.me` | Persistent |
| `painting-dev` | The `dev` branch / any preview deploy | Disposable; recreate for schema changes |
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

For a newly created dev database, initialize it from the current initial
schema. This is only for an empty `painting-dev`; it refuses an existing
database so it cannot accidentally paper over a missing schema change:

```bash
TURSO_DB_URL="libsql://painting-dev-legoguy.aws-us-east-2.turso.io" \
TURSO_DB_TOKEN="<jwt from above>" \
deno task bootstrap:dev
```

## Schema changes

Development and production deliberately use different workflows.

### Dev is reset, not migrated

`painting-dev` is a shared preview environment between local work and
production. It contains no durable production data. While the app is still
pre-production, do not add a migration merely to evolve dev: delete and
recreate `painting-dev`, mint its new token, update the Preview deployment
variables, then run `bootstrap:dev` with the new credentials. This starts dev
from the current initial schema.

`painting-local` is separate and may be kept for personal work. It is not a
deployment target and is never changed by either database script.

### Backup and clearing

The environment tools accept `Prod`, `Preview`, or `Development`. Preview and
Development currently both target `painting-dev`; the latter identifies the
dev-branch workflow even though the Deno Deploy API currently presents that
branch timeline as Preview. The scripts use `TURSO_API_KEY` and
`TURSO_ORG_SLUG` to resolve the database and mint a connection token whose
value exists only in the current process. Turso records issued tokens, but the
scripts neither log nor write their values; `.env` does not need one URL/token
pair per environment. Alternatively, matching `TURSO_DB_URL` and
`TURSO_DB_TOKEN` values override that path. Deno Deploy lists secret variables
as `null`, so it cannot supply the token to these local commands.

```bash
deno task backup:db Development
```

The command writes a JSON snapshot under ignored `backups/`. To erase painting
data while retaining the database schema and its migration ledger, use:

```bash
deno task clear:db Development --confirm Development
```

Clearing is irreversible. Production clearing requires the additional
`--allow-production` flag as well as `--confirm Production`.

### Production uses immutable migrations

`migrations/001_initial.sql` is the current initial schema. Before the first
production migration, it is also what `bootstrap:dev` uses for a newly
recreated dev database, so update it as the pre-production schema evolves.
Once production applies `001_initial.sql`, it becomes immutable. When
production exists and a schema must evolve, add a new sequential migration
file such as `002_add_thing.sql`; never edit a migration that could already
have run.

After the production release is approved, use the Turso organization
credentials already in `.env` (or explicit production database credentials):

```bash
deno task migrate:prod --dry-run

deno task migrate:prod
```

Run the migration before deploying code that requires it. The runner maintains
`schema_migrations`, applies each pending file atomically with its ledger row,
and rejects a migration whose contents changed after application. The serving
app never runs migrations on startup or while handling traffic.

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
whole create → apply the production migration history → test → delete cycle for a throwaway
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
