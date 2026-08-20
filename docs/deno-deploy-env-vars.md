# Deno Deploy environment variables

This app deploys to Deno Deploy (org `legoguy32109`, app `painting`), on the
current (post-Classic) platform. Environment variables are scoped to
**contexts**, and each context maps to a different Turso database — see
`docs/turso-databases.md` for the databases themselves.

## The four contexts

| Context      | When it applies                                                                                                    | Database it points at |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `Production` | The production deployment (`paint.joshhale.me`)                                                                    | `painting-prod`       |
| `Preview`    | Any git-branch deploy (including `dev` → `painting--dev.legoguy32109.deno.net`) _and_ any ad-hoc PR/preview deploy | `painting-dev`        |
| `Local`      | Running the app locally (`deno task dev`)                                                                          | `painting-local`      |
| `Build`      | Only available during the build step, not at runtime                                                               | unused today          |

Two things worth knowing that aren't obvious from the platform's own docs:

- The docs describe a three-way split (Production / Development / Build) and
  call the branch-and-preview bucket "Development." That name doesn't actually
  exist as a context — the real, API-level name is **`Preview`**. `Development`
  fails outright if you try to use it (`Context "Development"
  not found`).
- There's a fourth context, **`Local`**, not mentioned in the docs at all,
  specifically for env vars that apply when you're running the app on your own
  machine.

So: `dev` branch pushes and one-off PR previews share the _same_ context
(`Preview`) — there's no way to separate "the named `dev` branch" from "an
arbitrary preview deploy" at the env-var level. If that distinction ever
matters, it'd need a different mechanism (e.g. reading `DENO_DEPLOY_BRANCH` or
similar at runtime), not a different context.

## Viewing current variables

```bash
deno deploy env list --json --non-interactive --org legoguy32109 --app painting
```

Secret-flagged values always come back as `null` — that's the platform refusing
to ever re-display a secret once set, not a bug.

## Setting a variable — and the CLI limitation you need to know about

`deno deploy env add <KEY> <value>` works fine for a variable that only ever
needs **one** value across every context. It does **not** work for setting a
different value per context under the same key — every `add` call hardcodes the
variable to "all contexts," and the platform then refuses to add a second "all
contexts" entry once any context-scoped entry exists for that key. This isn't a
permissions issue or a sequencing mistake — it's true no matter what order you
add/narrow things in (confirmed directly, more than once).

This matters here because `TURSO_DB_URL`/`TURSO_DB_TOKEN` need a **different
value in every context** — that's the entire point of separating prod/dev/local
databases.

**Use `scripts/set-deploy-env.ts` instead**, for any variable that needs a
per-context value:

```bash
deno run -A scripts/set-deploy-env.ts <Context> <KEY> <value> [secret]

# examples
deno run -A scripts/set-deploy-env.ts Production TURSO_DB_URL "libsql://painting-prod-legoguy.aws-us-east-2.turso.io"
deno run -A scripts/set-deploy-env.ts Production TURSO_DB_TOKEN "eyJ..." secret
deno run -A scripts/set-deploy-env.ts Preview    TURSO_DB_URL "libsql://painting-dev-legoguy.aws-us-east-2.turso.io"
deno run -A scripts/set-deploy-env.ts Preview    TURSO_DB_TOKEN "eyJ..." secret
deno run -A scripts/set-deploy-env.ts Local      TURSO_DB_URL "libsql://painting-local-legoguy.aws-us-east-2.turso.io"
deno run -A scripts/set-deploy-env.ts Local      TURSO_DB_TOKEN "eyJ..." secret
```

### Why this works when the CLI doesn't

`deno deploy` is itself an open-source JSR package (`jsr:@deno/deploy`) — when
its own subcommands don't cover something, read its source rather than guess.
`deploy/env.ts`'s `add` command calls a tRPC mutation,
`envVarsContexts.updateEnvVars`, passing `context_ids: null` unconditionally.
That field is `string[] | null` in the mutation's own type — the _backend_ fully
supports setting specific context IDs right at creation time, the CLI subcommand
just never exposed a flag for it. `scripts/set-deploy-env.ts` imports the CLI's
own `createTrpcClient` and `tokenStorage` helpers directly and calls that same
mutation with a real `context_ids` array, sidestepping the missing flag
entirely. Requires `DENO_DEPLOY_TOKEN` (a `ddp_...` personal access token) in
the environment.

## Setting a variable that's the _same_ everywhere

For anything that genuinely doesn't vary by context, plain `deno deploy env add`
is fine and simpler than the script above:

```bash
deno deploy env add SOME_KEY "value" --org legoguy32109 --app painting
# --secret to mark it secret
```

## Deleting a variable

```bash
deno deploy env delete SOME_KEY --org legoguy32109 --app painting
```

This deletes every context-scoped entry under that key at once — there's no way
to delete just one context's entry while leaving others, short of deleting all
of them and re-adding the ones you want to keep.
