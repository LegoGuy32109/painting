/**
 * `deno task env:fill` — appends every MISSING generate/default variable
 * (see scripts/env-manifest.ts) to `.env`, creating it if it doesn't exist.
 *
 * The primary safety property: it NEVER modifies or overwrites a line
 * already present — `.env` holds irreplaceable Turso and Deno Deploy
 * credentials, so an existing line (whatever its value) is left byte-
 * identical. Running this twice in a row must add nothing the second time.
 *
 * `manual`-tier variables (real external credentials — Turso, Deno Deploy)
 * are never fabricated; they're only listed at the end for a human to fill
 * in. `excluded`-tier variables (PAINTING_DEV) and `none`-fill-strategy
 * variables (the legacy GUEST_SESSION_SECRET* pair) are never written
 * either.
 *
 * `.env` is backed up first, timestamped as `.env.backup-<epoch>` — printed
 * so the human knows where it went.
 *
 * `--dry-run` prints exactly what would be added (names and comments; a
 * generated secret is reported as `<generated>`, never its real value) and
 * makes no changes.
 *
 * HARD RULE: this script never prints, logs, or writes a variable's real
 * value anywhere except into `.env`/its backup — never to stdout.
 *
 * Usage: deno run --allow-read=.env,.env.example,.gitignore --allow-write
 *   scripts/env-fill.ts [--dry-run]
 */
import { type EnvVarSpec, ENV_MANIFEST, wrapAsComment } from "./env-manifest.ts";

const dryRun = Deno.args.includes("--dry-run");

async function readExistingNames(path: string): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    names.add(trimmed.slice(0, separator).trim());
  }
  return names;
}

async function ensureGitignoreCoversBackups(): Promise<void> {
  const pattern = ".env.backup-*";
  let text: string;
  try {
    text = await Deno.readTextFile(".gitignore");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      text = "";
    } else {
      throw error;
    }
  }
  const alreadyCovered = text.split("\n").some((line) =>
    line.trim() === pattern
  );
  if (alreadyCovered) return;
  if (dryRun) {
    console.log(`(dry run) would add "${pattern}" to .gitignore`);
    return;
  }
  const separator = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
  await Deno.writeTextFile(
    ".gitignore",
    `${text}${separator}\n# A .env backup written by scripts/env-fill.ts — holds the same real\n# secrets .env does and must never be committable.\n${pattern}\n`,
  );
  console.log(`Added "${pattern}" to .gitignore (it did not cover backups).`);
}

async function backupExistingEnv(): Promise<void> {
  const epoch = Date.now();
  const backupPath = `.env.backup-${epoch}`;
  if (dryRun) {
    console.log(`(dry run) would back up .env to ${backupPath}`);
    return;
  }
  await Deno.copyFile(".env", backupPath);
  console.log(`Backed up existing .env to ${backupPath}`);
}

async function main(): Promise<void> {
  const existingNames = await readExistingNames(".env");
  const envExists = existingNames !== null;

  await ensureGitignoreCoversBackups();

  const known = existingNames ?? new Set<string>();
  const toAppend: string[] = [];
  const manualMissing: EnvVarSpec[] = [];

  for (const spec of ENV_MANIFEST) {
    if (spec.tier === "excluded" || spec.fillStrategy === "none") continue;
    if (known.has(spec.name)) continue;

    if (spec.fillStrategy === "manual") {
      manualMissing.push(spec);
      continue;
    }

    const value = spec.fillStrategy === "generate"
      ? spec.generate?.()
      : spec.defaultValue;
    if (value === undefined) {
      throw new Error(`${spec.name}: no value available for its fill strategy`);
    }

    const commentLines = wrapAsComment(spec.description);
    const displayValue = spec.fillStrategy === "generate"
      ? "<generated>"
      : value;
    console.log(
      `Adding ${spec.name} (${spec.fillStrategy}: ${displayValue})`,
    );
    toAppend.push(`${commentLines.join("\n")}\n${spec.name}=${value}\n`);
  }

  if (toAppend.length === 0) {
    console.log(
      "\nNothing to add — .env already has every fillable variable.",
    );
  } else if (dryRun) {
    if (envExists) {
      console.log(`(dry run) would back up .env to .env.backup-<epoch>`);
    } else {
      console.log("(dry run) .env does not exist; would create it");
    }
    console.log(
      `\n(dry run) would append ${toAppend.length} variable(s) to .env; no changes made.`,
    );
  } else {
    if (envExists) {
      await backupExistingEnv();
    } else {
      console.log(".env did not exist; creating it.");
    }
    const separator = envExists ? "\n" : "";
    const block = `${separator}${toAppend.join("\n")}`;
    await Deno.writeTextFile(".env", block, { append: true, create: true });
    console.log(`\nAppended ${toAppend.length} variable(s) to .env.`);
  }

  if (manualMissing.length > 0) {
    console.log(
      "\nYou must supply these yourself — env:fill never fabricates a " +
        "real external credential:",
    );
    for (const spec of manualMissing) {
      console.log(`  ${spec.name} — see ${spec.doc}`);
    }
  }
}

await main();
