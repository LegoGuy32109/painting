// The declarative source of truth for every variable `.env` can hold —
// shared by `deno task env:check` (scripts/env-check.ts) and
// `deno task env:fill` (scripts/env-fill.ts) so the two tasks can never
// describe a variable differently from one another. `.env.example` is the
// human-facing documentation of the same variables; tests/env-manifest_test.ts
// asserts this table and that file can never drift apart (same technique as
// tests/asset-manifest_test.ts: an independent scan compared against this
// module's own list).
//
// A developer hit `Error: PAINTING_KEYS must be set` from `deno task dev`
// after that variable was documented in `.env.example` but never added to
// their real `.env`. Every `scripts/e2e-*.ts` harness injects its own
// `PAINTING_KEYS` (and friends) into the server subprocess it spawns, so the
// automated test suites stayed green the whole time and never touched the
// real `.env` — `deno task dev` was the first thing to actually read it. Both
// tasks here exist to make that class of drift loud instead of silent.
//
// HARD RULE: nothing in this module, env-check.ts, or env-fill.ts may ever
// print, log, or return a variable's real *value* — only names, tiers, and
// presence/shape verdicts. `.env` holds real Turso database tokens, a Turso
// org management key, and a Deno Deploy personal access token.

/**
 * - `boot`: the server refuses to start without it (signing-keys.ts's
 *   `assertSigningKeysConfigured`).
 * - `feature`: the server boots, but something is disabled without it —
 *   passkey routes 501 (webauthn-config.ts), or any database-backed route
 *   fails (db.ts).
 * - `tooling`: only `scripts/` reads it; the running app never does.
 * - `optional`: legacy-verification-only. A fresh clone needs none of these.
 * - `excluded`: documented in `.env.example` for context, but must NEVER be
 *   written into `.env` itself. See PAINTING_DEV below for why.
 */
export type Tier = "boot" | "feature" | "tooling" | "optional" | "excluded";

/**
 * - `generate`: this module (or its caller) can mint a correct value with no
 *   external input — see `generate()` below.
 * - `default`: a fixed, sensible local-dev constant — see `defaultValue`.
 * - `manual`: a real external credential; `env:fill` must never fabricate
 *   one, only report that it's missing and where to get it (`doc`).
 * - `none`: `env:fill` never adds this variable under any circumstance.
 */
export type FillStrategy = "generate" | "default" | "manual" | "none";

export interface EnvVarSpec {
  name: string;
  tier: Tier;
  fillStrategy: FillStrategy;
  /** One-line explanation. Doubles as env:check's report line and, for
   * `generate`/`default`, the comment env:fill writes above the value. */
  description: string;
  /** `default` only: the literal value env:fill appends. */
  defaultValue?: string;
  /** `generate` only: mints a fresh, correctly-shaped value. Pure — takes no
   * arguments and reads nothing from the environment. */
  generate?: () => string;
  /** `manual` only: the doc a human should read to obtain a real value. */
  doc?: string;
}

function randomPaintingKeysValue(): string {
  // Mirrors the exact format src/server/signing-keys.ts's
  // parsePaintingKeysEnv accepts: <kid>:<base64url-32-random-bytes>, where
  // kid matches /^[a-z0-9]{1,16}$/. "k1" is an arbitrary, valid kid, matching
  // .env.example's own placeholder.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64Url = btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/, "");
  return `k1:${base64Url}`;
}

export const ENV_MANIFEST: EnvVarSpec[] = [
  {
    name: "PAINTING_KEYS",
    tier: "boot",
    fillStrategy: "generate",
    description:
      "The signing keyset for guest session cookies (and, from Phase 3 on, " +
      "WebAuthn challenges/merge tokens/transfer codes). The server refuses " +
      "to start without it. See docs/signing-key-rotation.md.",
    generate: randomPaintingKeysValue,
  },
  {
    name: "WEBAUTHN_RP_ID",
    tier: "feature",
    fillStrategy: "default",
    description:
      "WebAuthn relying-party id. Without this (and WEBAUTHN_ORIGINS), " +
      "every passkey/account route deliberately 501s; guest painting still " +
      "works. localhost is a WebAuthn secure context by spec, so this is " +
      "fine for local dev.",
    defaultValue: "localhost",
  },
  {
    name: "WEBAUTHN_ORIGINS",
    tier: "feature",
    fillStrategy: "default",
    description:
      "Comma-separated allowlist of origins passkey ceremonies are " +
      "permitted from. Must match the port deno task dev actually listens " +
      "on (PORT, default 8000 — see src/server/main.ts).",
    defaultValue: "http://localhost:8000",
  },
  {
    name: "TURSO_DB_URL",
    tier: "feature",
    fillStrategy: "manual",
    description:
      "The libsql connection URL for the Turso database this server reads " +
      "and writes. Every database-backed route fails without it.",
    doc: "docs/turso-databases.md",
  },
  {
    name: "TURSO_DB_TOKEN",
    tier: "feature",
    fillStrategy: "manual",
    description:
      "The auth token for TURSO_DB_URL. Every database-backed route fails " +
      "without it.",
    doc: "docs/turso-databases.md",
  },
  {
    name: "TURSO_API_KEY",
    tier: "tooling",
    fillStrategy: "manual",
    description:
      "Turso organization management token. Only scripts/ (ephemeral test " +
      "databases, backup/clear/migrate tooling) read it; the running app " +
      "never does.",
    doc: "docs/turso-databases.md",
  },
  {
    name: "TURSO_ORG_SLUG",
    tier: "tooling",
    fillStrategy: "manual",
    description:
      "The Turso organization slug those same scripts resolve databases " +
      "under. Only scripts/ read it.",
    doc: "docs/turso-databases.md",
  },
  {
    name: "DENO_DEPLOY_TOKEN",
    tier: "tooling",
    fillStrategy: "manual",
    description:
      "A Deno Deploy personal access token, needed only to run " +
      "scripts/set-deploy-env.ts. Only scripts/ read it.",
    doc: "docs/deno-deploy-env-vars.md",
  },
  {
    name: "GUEST_SESSION_SECRET",
    tier: "optional",
    fillStrategy: "none",
    description:
      "Legacy (pre-keyset) guest-cookie secret, kept ONLY to verify old " +
      "v1/v2 cookies (see src/server/guest-session.ts) — nothing signs " +
      "with it anymore. A fresh clone has no such cookies and does not " +
      "need it; env:fill never adds it.",
  },
  {
    name: "GUEST_SESSION_SECRET_PREVIOUS",
    tier: "optional",
    fillStrategy: "none",
    description:
      "The one-key rotation predecessor to GUEST_SESSION_SECRET, same " +
      "legacy-verification-only status. Not needed by a fresh clone.",
  },
  {
    name: "PAINTING_DEV",
    tier: "excluded",
    fillStrategy: "none",
    description:
      "NEVER put this in .env. deno.json's dev task sets it inline on " +
      "purpose: --env-file loads .env into every task that uses it, " +
      "including the e2e suites, so a PAINTING_DEV in .env would leak dev " +
      "mode's identity asset manifest into those runs and fail the " +
      "assertion that an unhashed asset path 404s in production mode. " +
      "env:check warns if it finds this key in .env; env:fill never writes " +
      "it.",
  },
];

const manifestByName = new Map(ENV_MANIFEST.map((spec) => [spec.name, spec]));

export function specFor(name: string): EnvVarSpec | undefined {
  return manifestByName.get(name);
}

const TIER_ORDER: Tier[] = ["boot", "feature", "tooling", "optional"];

/** Manifest entries in report order, grouped by tier. Excludes `excluded` —
 * those are handled as a special case by env-check.ts/env-fill.ts, not
 * reported alongside real candidates for `.env`. */
export function tiersInReportOrder(): Tier[] {
  return TIER_ORDER;
}

export function specsForTier(tier: Tier): EnvVarSpec[] {
  return ENV_MANIFEST.filter((spec) => spec.tier === tier);
}

/** The one variable(s) that must never appear in `.env` at all. */
export function excludedSpecs(): EnvVarSpec[] {
  return ENV_MANIFEST.filter((spec) => spec.tier === "excluded");
}

/**
 * Extracts declared variable NAMES (never values) from `.env.example`-shaped
 * text: any line matching `NAME=...` at the start of the line. Used by
 * env-check.ts's runtime drift sanity check; tests/env-manifest_test.ts
 * deliberately reimplements this scan independently rather than importing
 * it, so the test doesn't become tautological.
 */
export function declaredNamesFrom(exampleText: string): string[] {
  const names: string[] = [];
  for (const line of exampleText.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

/**
 * Wraps `text` into `#`-prefixed comment lines no wider than `width`
 * columns, matching .env.example's own comment style.
 */
export function wrapAsComment(text: string, width = 78): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "#";
  for (const word of words) {
    if (current.length + 1 + word.length > width) {
      lines.push(current);
      current = "#";
    }
    current += (current === "#" ? " " : " ") + word;
  }
  if (current !== "#") lines.push(current);
  return lines;
}
