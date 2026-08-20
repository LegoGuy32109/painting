# Joy of Painting

A browser-based pixel painting app inspired by xerca's
[Joy of Painting](https://modrinth.com/mod/joy-of-painting) Minecraft mod. It
recreates the painting experience without Minecraft dependencies.

The paint rules and interface reference live in
[the interface specification](docs/joy-of-painting-interface-spec.md).

## Project layout

```text
src/
  client/  Browser modules and declaration-only shared types
  server/  Deno HTTP server
tests/     Automated tests
public/    HTML, CSS, fonts, and vendored browser assets
docs/      Product specifications and project notes
```

Keep authored runtime code in `src/`, tests in `tests/`, static assets in
`public/`, and documentation in `docs/`.

## Development

```bash
deno task dev
deno task check
deno task test
deno task save "feat: describe the change"
```

`deno task check` recursively type-checks every authored JavaScript, TypeScript,
and declaration file in `src/` and `tests/`.

`deno task test` runs the test suite with only the read permissions it needs.
`deno task save` formats, type-checks, commits, and pushes; it requires a commit
message and warns when run on `master`.

## Database lifecycle

`painting-local` is for one developer's durable local work. `painting-dev` is an
intentionally disposable shared preview database: when its schema changes,
recreate it and run `deno task bootstrap:dev` with `TURSO_DB_URL` and
`TURSO_DB_TOKEN` set to the new `painting-dev` credentials. Do not add or run
incremental migrations for dev work.

`painting-prod` is durable. Its schema is defined by `migrations/`. Until the
first production release, `001_initial.sql` is the editable current bootstrap
schema; once production applies it, every applied migration is immutable. After
production approval and before deploying code that needs a new schema, run
`deno task migrate:prod --dry-run`, then `deno task migrate:prod`, with
production Turso credentials set in the shell. The runner records applied
versions and refuses a changed migration file.

See [the database guide](docs/turso-databases.md) before creating, resetting, or
migrating a database.

`deno task backup:db Development` writes a local JSON backup of `painting-dev`;
`Prod` and `Preview` are also accepted. It needs credentials for the selected
database: the scripts use `TURSO_API_KEY` and `TURSO_ORG_SLUG` to resolve it and
mint a connection token used only by the current process, or accept matching
`TURSO_DB_URL`/`TURSO_DB_TOKEN` explicitly.
`deno task clear:db Development
--confirm Development` removes all paintings
from that database but preserves its schema. The clear command also requires
`--allow-production` for `Prod`.

## Browser code conventions

- Browser code remains standard ES modules served directly by the Deno server.
- Keep the no-build workflow: do not add a client framework, bundler, or new
  dependency without an explicit project decision.
- Use `// @ts-check` in browser JavaScript.
- Put shared, non-runtime type shapes in `.d.ts` files. Deno and editor tooling
  use them only. Browsers neither fetch nor execute them.
- Keep vendored third-party browser files in `public/` so they stay outside the
  authored-code type-check boundary.
