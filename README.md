# Joy of Painting

A browser-based pixel painting app inspired by xerca's
[Joy of Painting](https://modrinth.com/mod/joy-of-painting) Minecraft mod. It
recreates the painting experience without Minecraft dependencies.

The paint rules and interface reference live in [the interface
specification](docs/joy-of-painting-interface-spec.md).

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
```

`deno task check` recursively type-checks every authored JavaScript,
TypeScript, and declaration file in `src/` and `tests/`.

`deno task test` runs the test suite with only the read permissions it needs.

## Browser code conventions

- Browser code remains standard ES modules served directly by the Deno server.
- Keep the no-build workflow: do not add a client framework, bundler, or new
  dependency without an explicit project decision.
- Use `// @ts-check` in browser JavaScript.
- Put shared, non-runtime type shapes in `.d.ts` files. Deno and editor tooling
  use them only. Browsers neither fetch nor execute them.
- Keep vendored third-party browser files in `public/` so they stay outside the
  authored-code type-check boundary.
