import { assertEquals } from "@std/assert";
import { ENV_MANIFEST } from "../scripts/env-manifest.ts";

// Regression test for the whole point of scripts/env-manifest.ts: a
// developer hit `PAINTING_KEYS must be set` from `deno task dev` because a
// variable was documented in .env.example but never wired into env:check /
// env:fill's manifest. This test makes that impossible to reintroduce —
// same technique as tests/asset-manifest_test.ts: an INDEPENDENT scan
// (its own regex here, not scripts/env-manifest.ts's declaredNamesFrom)
// compared against the manifest, so the test isn't tautological with the
// code it's guarding.
async function namesDeclaredInEnvExample(): Promise<string[]> {
  const text = await Deno.readTextFile(
    new URL("../.env.example", import.meta.url),
  );
  const names: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

Deno.test("ENV_MANIFEST covers exactly the variables documented in .env.example", async () => {
  const declared = await namesDeclaredInEnvExample();
  const manifestNames = ENV_MANIFEST.map((spec) => spec.name);

  // No duplicates on either side — a duplicate would silently hide a
  // missing/extra entry from the set-equality assertions below.
  assertEquals(
    new Set(declared).size,
    declared.length,
    ".env.example declares a variable more than once",
  );
  assertEquals(
    new Set(manifestNames).size,
    manifestNames.length,
    "ENV_MANIFEST lists a variable more than once",
  );

  assertEquals(
    [...manifestNames].sort(),
    [...declared].sort(),
    "ENV_MANIFEST and .env.example have drifted apart — every variable in " +
      "one must appear in the other, with no extras on either side",
  );

  // Sanity: this isn't a vacuous comparison of two empty lists.
  assertEquals(declared.length > 0, true);
});

Deno.test("every ENV_MANIFEST entry has the fields its fill strategy requires", () => {
  for (const spec of ENV_MANIFEST) {
    if (spec.fillStrategy === "generate") {
      assertEquals(
        typeof spec.generate,
        "function",
        `${spec.name}: fillStrategy "generate" needs a generate() function`,
      );
    }
    if (spec.fillStrategy === "default") {
      assertEquals(
        typeof spec.defaultValue,
        "string",
        `${spec.name}: fillStrategy "default" needs a defaultValue`,
      );
    }
    if (spec.fillStrategy === "manual") {
      assertEquals(
        typeof spec.doc,
        "string",
        `${spec.name}: fillStrategy "manual" needs a doc pointer`,
      );
    }
  }
});

Deno.test("PAINTING_DEV is tiered excluded and never fillable", () => {
  const spec = ENV_MANIFEST.find((entry) => entry.name === "PAINTING_DEV");
  assertEquals(spec?.tier, "excluded");
  assertEquals(spec?.fillStrategy, "none");
});

Deno.test("PAINTING_KEYS is the sole boot-tier variable", () => {
  const bootNames = ENV_MANIFEST.filter((spec) => spec.tier === "boot").map(
    (spec) => spec.name,
  );
  assertEquals(bootNames, ["PAINTING_KEYS"]);
});
