import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  buildImportMap,
  computeAssetManifest,
  contentHash,
  digestManifest,
  hashedPathFor,
} from "../src/server/asset-manifest.ts";

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
