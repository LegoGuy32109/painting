/**
 * `deno task env:check` — reports, grouped by tier, which of the variables
 * documented in `.env.example` (see scripts/env-manifest.ts) are present in
 * `.env`, missing, or present-but-malformed.
 *
 * Exits non-zero only when a `boot`-tier variable is missing or malformed —
 * that's the class of failure that makes `deno task dev` refuse to start at
 * all (see src/server/signing-keys.ts's assertSigningKeysConfigured()).
 * `feature`/`tooling`/`optional` gaps are reported but don't fail the task.
 *
 * HARD RULE: this script never prints, logs, or returns a variable's real
 * value — only its name and a presence/shape verdict. Reads `.env` directly
 * as text rather than trusting `Deno.env`, both so a shell-exported variable
 * can't paper over a genuinely missing `.env` entry, and so this script
 * needs no --allow-env grant at all.
 *
 * Usage: deno run --allow-read=.env,.env.example scripts/env-check.ts
 */
import {
  declaredNamesFrom,
  ENV_MANIFEST,
  excludedSpecs,
  specsForTier,
  type Tier,
  tiersInReportOrder,
} from "./env-manifest.ts";
import { parsePaintingKeysEnv } from "../src/server/signing-keys.ts";
import { meetsLegacySecretLength } from "../src/server/guest-session.ts";

type Verdict =
  | { kind: "present" }
  | { kind: "missing" }
  | { kind: "malformed"; reason: string };

async function readDotEnv(): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(".env");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values.set(name, value);
  }
  return values;
}

function validateShape(name: string, value: string): Verdict {
  try {
    if (name === "PAINTING_KEYS") {
      parsePaintingKeysEnv(value);
      return { kind: "present" };
    }
    if (name === "WEBAUTHN_ORIGINS") {
      const origins = value.split(",").map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
      if (origins.length === 0) {
        return { kind: "malformed", reason: "no origins listed" };
      }
      for (const origin of origins) {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          return {
            kind: "malformed",
            reason: `"${origin}" is not an absolute URL`,
          };
        }
        if (!/^https?:$/.test(parsed.protocol) || parsed.pathname !== "/" && parsed.pathname !== "") {
          return {
            kind: "malformed",
            reason: `"${origin}" must be a bare http(s) origin`,
          };
        }
      }
      return { kind: "present" };
    }
    if (
      name === "GUEST_SESSION_SECRET" || name === "GUEST_SESSION_SECRET_PREVIOUS"
    ) {
      if (!meetsLegacySecretLength(value)) {
        return {
          kind: "malformed",
          reason: "must contain at least 32 bytes",
        };
      }
      return { kind: "present" };
    }
    return { kind: "present" };
  } catch (error) {
    return {
      kind: "malformed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function verdictFor(name: string, values: Map<string, string>): Verdict {
  const value = values.get(name);
  if (value === undefined || value.length === 0) return { kind: "missing" };
  return validateShape(name, value);
}

const TIER_LABELS: Record<Tier, string> = {
  boot: "boot (server refuses to start without these)",
  feature: "feature (server boots, but something is disabled)",
  tooling: "tooling (only scripts/ reads these, never the app)",
  optional: "optional (legacy verification only; a fresh clone needs none)",
  excluded: "excluded",
};

async function main(): Promise<void> {
  // Defensive drift check: the manifest and .env.example should never
  // disagree (tests/env-manifest_test.ts is the authoritative guard for
  // this), but if something slipped through anyway, say so loudly rather
  // than silently under- or over-reporting.
  try {
    const exampleText = await Deno.readTextFile(".env.example");
    const declared = new Set(declaredNamesFrom(exampleText));
    const manifestNames = new Set(ENV_MANIFEST.map((spec) => spec.name));
    const missingFromManifest = [...declared].filter((n) => !manifestNames.has(n));
    const missingFromExample = [...manifestNames].filter((n) => !declared.has(n));
    if (missingFromManifest.length > 0 || missingFromExample.length > 0) {
      console.warn(
        "WARNING: scripts/env-manifest.ts and .env.example have drifted apart.",
      );
      if (missingFromManifest.length > 0) {
        console.warn(`  in .env.example but not the manifest: ${missingFromManifest.join(", ")}`);
      }
      if (missingFromExample.length > 0) {
        console.warn(`  in the manifest but not .env.example: ${missingFromExample.join(", ")}`);
      }
      console.warn("");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }

  const values = await readDotEnv();
  if (values === null) {
    console.log(
      "No .env file found.\n" +
        "Run `deno task env:fill` to create one with every variable this " +
        "project can generate or default for you.\n",
    );
    Deno.exit(1);
  }

  let bootFailure = false;

  for (const tier of tiersInReportOrder()) {
    const specs = specsForTier(tier);
    if (specs.length === 0) continue;
    console.log(`${TIER_LABELS[tier]}:`);
    for (const spec of specs) {
      const verdict = verdictFor(spec.name, values);
      if (verdict.kind === "present") {
        console.log(`  [ok]      ${spec.name}`);
      } else if (verdict.kind === "missing") {
        console.log(`  [missing] ${spec.name} — ${spec.description}`);
        if (tier === "boot") bootFailure = true;
      } else {
        console.log(`  [BAD]     ${spec.name} — ${verdict.reason}`);
        if (tier === "boot") bootFailure = true;
      }
    }
    console.log("");
  }

  for (const spec of excludedSpecs()) {
    if (values.has(spec.name)) {
      console.log(
        `WARNING: ${spec.name} is set in .env. ${spec.description}\n`,
      );
    }
  }

  if (bootFailure) {
    console.log(
      "A boot-tier variable is missing or malformed — `deno task dev` will " +
        "refuse to start. Run `deno task env:fill` to fill in what can be " +
        "generated, or see .env.example for the expected format.",
    );
    Deno.exit(1);
  }

  console.log("All boot-tier variables are present and well-formed.");
}

await main();
