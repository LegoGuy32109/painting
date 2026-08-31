import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  buildImportMap,
  computeAssetManifest,
  contentHash,
  digestManifest,
  hashedPathFor,
} from "../src/server/asset-manifest.ts";

// Independent (not asset-manifest.ts's own) directory scans, used below to
// assert the manifest derives from the filesystem rather than from some
// hand-maintained list. Deliberately excludes the same files
// asset-manifest.ts excludes, for the same reasons — see its
// EXCLUDED_CLIENT_FILES comment. src/shared/ has no exclusion set (see
// asset-manifest.ts's header comment), so the shared scan below passes no
// excluded set.
async function jsFileNames(
  directory: URL,
  excluded: Set<string>,
): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (
      entry.isFile && entry.name.endsWith(".js") && !excluded.has(entry.name)
    ) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

const clientDirectory = new URL("../src/client/", import.meta.url);
const sharedDirectory = new URL("../src/shared/", import.meta.url);

Deno.test("contentHash is stable for identical bytes and changes when bytes change", async () => {
  const a = await contentHash(new TextEncoder().encode("hello"));
  const b = await contentHash(new TextEncoder().encode("hello"));
  const c = await contentHash(new TextEncoder().encode("hello!"));
  assertEquals(a, b);
  assertEquals(a.length, 8);
  assertMatch(a, /^[0-9a-f]{8}$/);
  assertNotEquals(a, c);
});

Deno.test("hashedPathFor inserts the hash immediately before the extension", () => {
  assertEquals(hashedPathFor("/app.js", "a1b2c3d4"), "/app.a1b2c3d4.js");
  assertEquals(
    hashedPathFor("/shared/compose.js", "deadbeef"),
    "/shared/compose.deadbeef.js",
  );
  assertEquals(hashedPathFor("/base.css", "00000000"), "/base.00000000.css");
});

Deno.test("digestManifest is order-independent and changes when any entry's hashed path changes", async () => {
  const base = [
    { logicalPath: "/a.js", hashedPath: "/a.111.js" },
    { logicalPath: "/b.js", hashedPath: "/b.222.js" },
  ];
  const reordered = [base[1], base[0]];
  const changed = [
    { logicalPath: "/a.js", hashedPath: "/a.111.js" },
    { logicalPath: "/b.js", hashedPath: "/b.999.js" },
  ];

  const baseDigest = await digestManifest(base);
  assertEquals(baseDigest, await digestManifest(reordered));
  assertNotEquals(baseDigest, await digestManifest(changed));
});

Deno.test("digestManifest depends only on content, not on the order entries were enumerated in", async () => {
  // Directory enumeration order is unspecified, so if computeAssetManifest
  // fed digestManifest un-sorted entries, the digest would thrash between
  // otherwise-identical runs/processes. Simulate several arbitrary
  // enumeration orders of the same file set and confirm they all agree.
  const entries = [
    { logicalPath: "/z.js", hashedPath: "/z.aaaaaaaa.js" },
    { logicalPath: "/m.js", hashedPath: "/m.bbbbbbbb.js" },
    { logicalPath: "/a.js", hashedPath: "/a.cccccccc.js" },
    { logicalPath: "/shared/q.js", hashedPath: "/shared/q.dddddddd.js" },
  ];
  const shuffled = [entries[2], entries[0], entries[3], entries[1]];
  const reversed = [...entries].reverse();

  const digest = await digestManifest(entries);
  assertEquals(digest, await digestManifest(shuffled));
  assertEquals(digest, await digestManifest(reversed));
});

Deno.test("computeAssetManifest(prod) hashes every served file distinctly and deterministically", async () => {
  const first = await computeAssetManifest(false);
  const second = await computeAssetManifest(false);

  assertEquals(first.manifestDigest, second.manifestDigest);
  assertEquals(first.devMode, false);
  assertEquals(first.entries.length > 0, true);

  const hashedPaths = new Set<string>();
  for (const entry of first.entries) {
    assertMatch(entry.hashedPath, /\.[0-9a-f]{8}\.(js|css)$/);
    assertNotEquals(entry.hashedPath, entry.logicalPath);
    assertEquals(
      first.byLogicalPath.get(entry.logicalPath)?.hashedPath,
      entry.hashedPath,
    );
    assertEquals(first.byHashedPath.get(entry.hashedPath), entry);
    hashedPaths.add(entry.hashedPath);
  }
  // Every entry got its own distinct hashed URL.
  assertEquals(hashedPaths.size, first.entries.length);

  // computeAssetManifest is a pure read of the current files, so hashing the
  // same content twice is stable.
  assertEquals(
    first.byLogicalPath.get("/base.css")?.hashedPath,
    second.byLogicalPath.get("/base.css")?.hashedPath,
  );
});

Deno.test("computeAssetManifest's client/shared entries are exactly the live directory contents, not a hand-maintained list", async () => {
  // This is the regression test for the bug this module used to have: a
  // newly added src/client/*.js or src/shared/*.js file must appear in the
  // manifest with no code change required. Asserting the manifest's set is
  // *equal to* (not just a subset/superset of) an independent directory
  // scan catches both directions of drift: a file present on disk but
  // missing from the manifest (the original bug — e.g. a hardcoded list
  // that forgot to mention it), and a file in the manifest that no longer
  // exists.
  const manifest = await computeAssetManifest(false);

  const expectedClient = await jsFileNames(
    clientDirectory,
    new Set(["sw.js", "sw-routing.js"]),
  );
  const actualClient = manifest.entries
    .filter((e) => e.kind === "client")
    .map((e) => e.logicalPath.slice(1))
    .sort();
  assertEquals(actualClient, expectedClient);
  // Sanity: this isn't a vacuous comparison of two empty lists.
  assertEquals(expectedClient.length > 0, true);

  const expectedShared = await jsFileNames(sharedDirectory, new Set());
  const actualShared = manifest.entries
    .filter((e) => e.kind === "shared")
    .map((e) => e.logicalPath.slice("/shared/".length))
    .sort();
  assertEquals(actualShared, expectedShared);
  assertEquals(expectedShared.length > 0, true);

  // transfer-code.js in particular is only ever reached via a relative
  // import, never a <script src> entry point — confirm it's still swept up
  // by the directory scan rather than needing its own special case.
  assertEquals(expectedShared.includes("transfer-code.js"), true);
});

Deno.test("computeAssetManifest excludes the service worker and its routing helper", async () => {
  const manifest = await computeAssetManifest(false);
  // Both are served unhashed at fixed URLs by their own routes in main.ts.
  // A hashed, immutably-cached service worker could never update itself,
  // so neither may be content-hashed or appear in the manifest/import map.
  for (const logicalPath of ["/sw.js", "/sw-routing.js"]) {
    assertEquals(manifest.byLogicalPath.has(logicalPath), false);
  }
  for (const entry of manifest.entries) {
    assertNotEquals(entry.sourceUrl.pathname.split("/").pop(), "sw.js");
    assertNotEquals(entry.sourceUrl.pathname.split("/").pop(), "sw-routing.js");
  }
});

Deno.test("computeAssetManifest excludes declaration files but includes jpaint.js", async () => {
  const manifest = await computeAssetManifest(false);
  for (const entry of manifest.entries) {
    assertEquals(entry.logicalPath.endsWith(".d.ts"), false);
  }
  // jpaint.js is DOM-free domain logic that belongs in src/shared/
  // precisely so a browser-side .jpaint decoder is possible (see its own
  // header comment and docs/jpaint-format.md) — nothing importing it
  // client-side TODAY is not a reason to exclude it from the manifest, or
  // the first client-side use of it would hit a 404.
  assertMatch(
    manifest.byLogicalPath.get("/shared/jpaint.js")?.hashedPath ?? "",
    /\.[0-9a-f]{8}\.js$/,
  );
});

Deno.test("computeAssetManifest includes shared modules never referenced by a <script src>", async () => {
  const manifest = await computeAssetManifest(false);
  // local-db.js and the shared/*.js modules are only ever reached through a
  // relative import inside another module, never a direct entry point — the
  // manifest (and later the import map built from it) must still know about
  // them, or a hashed importer's relative import has nowhere to resolve.
  for (
    const logicalPath of [
      "/local-db.js",
      "/live-replay.js",
      "/shared/compose.js",
      "/shared/pixel-render.js",
      "/shared/transfer-code.js",
    ]
  ) {
    assertMatch(
      manifest.byLogicalPath.get(logicalPath)?.hashedPath ?? "",
      /\.[0-9a-f]{8}\.js$/,
    );
  }
});

Deno.test("computeAssetManifest(dev) is an identity map with a fixed digest", async () => {
  const manifest = await computeAssetManifest(true);
  assertEquals(manifest.devMode, true);
  assertEquals(manifest.manifestDigest, "dev");
  for (const entry of manifest.entries) {
    assertEquals(entry.hashedPath, entry.logicalPath);
  }
});

Deno.test("buildImportMap covers the full client+shared module graph, not just entry points", async () => {
  const manifest = await computeAssetManifest(false);
  const importMap = buildImportMap(manifest);

  // Entry points named directly in a <script src>...
  assertMatch(importMap.imports["/app.js"], /^\/app\.[0-9a-f]{8}\.js$/);
  // ...and modules only ever reached via a relative import from another
  // module, which is the whole point of shipping a graph-wide map.
  assertMatch(
    importMap.imports["/local-db.js"],
    /^\/local-db\.[0-9a-f]{8}\.js$/,
  );
  assertMatch(
    importMap.imports["/shared/compose.js"],
    /^\/shared\/compose\.[0-9a-f]{8}\.js$/,
  );

  // CSS isn't part of the JS module graph and must not appear in the import map.
  assertEquals("/base.css" in importMap.imports, false);
});
