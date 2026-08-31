import { assertEquals, assertMatch } from "@std/assert";
import { handler } from "../src/server/main.ts";
import { getAssetManifest } from "../src/server/asset-manifest.ts";
import { base64Url } from "../src/server/signing-keys.ts";

// guest-session.ts has no fallback secret (a server that can't sign guest
// sessions must refuse to start, not issue tokens silently) so tests that
// exercise routes calling guestSession() need one explicitly. PAINTING_KEYS
// is process-wide cached (see signing-keys.ts), so if guest-session_test.ts
// already set it during this run, that value wins and this guard is a
// no-op — this file's own tests never depend on a specific kid.
if (!Deno.env.get("GUEST_SESSION_SECRET")) {
  Deno.env.set(
    "GUEST_SESSION_SECRET",
    "test-only-guest-session-secret-32-bytes",
  );
}
if (!Deno.env.get("PAINTING_KEYS")) {
  Deno.env.set(
    "PAINTING_KEYS",
    `main:${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
  );
}

function cookieFrom(response: Response): string {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

Deno.test("returns html on /", async () => {
  const res = await handler(new Request("http://localhost/"));
  assertEquals(res.headers.get("content-type"), "text/html");
  assertMatch(res.headers.get("set-cookie") ?? "", /^painting_guest=/);
  assertEquals(res.headers.get("cache-control"), "no-cache");
  assertEquals(res.headers.get("x-frame-options"), "DENY");
  const body = await res.text();
  assertEquals(body.includes("Joy of Painting"), true);
});

Deno.test("serves each public page and establishes a guest profile", async () => {
  for (const path of ["/editor", "/display", "/collection"]) {
    const response = await handler(new Request(`http://localhost${path}`));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/html");
    assertMatch(response.headers.get("set-cookie") ?? "", /^painting_guest=/);
  }
});

Deno.test("returns the Minecraft font", async () => {
  const res = await handler(
    new Request("http://localhost/Minecraftia-Regular.ttf"),
  );
  assertEquals(res.headers.get("content-type"), "font/ttf");
  assertMatch(res.headers.get("cache-control") ?? "", /immutable/);
});

Deno.test("returns the stylesheet at its content-hashed, immutable URL", async () => {
  const manifest = await getAssetManifest(false);
  const hashedPath = manifest.byLogicalPath.get("/style.css")?.hashedPath;
  assertMatch(hashedPath ?? "", /^\/style\.[0-9a-f]{8}\.css$/);

  const res = await handler(new Request(`http://localhost${hashedPath}`));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
  assertEquals(
    res.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});

Deno.test("serves browser modules at their content-hashed, immutable URLs", async () => {
  const manifest = await getAssetManifest(false);
  const hashedPath = manifest.byLogicalPath.get("/local-db.js")?.hashedPath;
  assertMatch(hashedPath ?? "", /^\/local-db\.[0-9a-f]{8}\.js$/);

  const res = await handler(new Request(`http://localhost${hashedPath}`));
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
  assertMatch(await res.text(), /export function deleteCanvasLocal/);
});

Deno.test("unknown paths return 404 instead of the application shell", async () => {
  const res = await handler(new Request("http://localhost/missing.js"));
  assertEquals(res.status, 404);
});

Deno.test("unhashed logical asset paths are no longer served directly", async () => {
  // The old hand-bumped ?v=N scheme is gone: an asset is only reachable at
  // its content-hashed URL now (see asset-manifest.ts). Serving the bare
  // logical path would be a stale-serving trap, so it 404s instead.
  for (const path of ["/style.css", "/local-db.js", "/shared/compose.js"]) {
    const res = await handler(new Request(`http://localhost${path}`));
    assertEquals(res.status, 404);
  }
});

Deno.test("write routes require the signed guest cookie", async () => {
  const canvasId = "01K00000000000000000000000";
  const body = JSON.stringify({ events: [], heartbeatActive: false });
  const missing = await handler(
    new Request(`http://localhost/canvases/${canvasId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  assertEquals(missing.status, 401);

  const root = await handler(new Request("http://localhost/"));
  const tampered = await handler(
    new Request(`http://localhost/canvases/${canvasId}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${cookieFrom(root)}x`,
      },
      body,
    }),
  );
  assertEquals(tampered.status, 401);
});

Deno.test("GET /api/me requires a signed guest cookie, same as its /api/me/* siblings", async () => {
  const res = await handler(new Request("http://localhost/api/me"));
  assertEquals(res.status, 401);
});

Deno.test("guest profiles are issued once in a protected cookie", async () => {
  const first = await handler(new Request("https://paint.example/"));
  const setCookie = first.headers.get("set-cookie") ?? "";
  assertMatch(setCookie, /HttpOnly/);
  assertMatch(setCookie, /SameSite=Lax/);
  assertMatch(setCookie, /Secure/);

  const second = await handler(
    new Request("https://paint.example/", {
      headers: { cookie: cookieFrom(first) },
    }),
  );
  assertEquals(second.status, 200);
  assertEquals(second.headers.has("set-cookie"), false);
});

Deno.test("returns the browser modules at their content-hashed URLs", async () => {
  const manifest = await getAssetManifest(false);
  for (
    const path of [
      "/app.js",
      "/shared/paint-engine.js",
      "/shared/palette-engine.js",
      "/shared/pixel-render.js",
      "/live-replay.js",
      "/live-stream-message.js",
      "/site-nav.js",
      "/painting-parade.js",
      "/collection-page.js",
      "/editor-page.js",
    ]
  ) {
    const hashedPath = manifest.byLogicalPath.get(path)?.hashedPath;
    assertMatch(hashedPath ?? "", /\.[0-9a-f]{8}\.js$/);
    const res = await handler(new Request(`http://localhost${hashedPath}`));
    assertEquals(
      res.headers.get("content-type"),
      "application/javascript; charset=utf-8",
    );
    assertEquals((await res.text()).length > 0, true);
  }
});

Deno.test("rewritten pages have no cache-busting query strings and no unhashed asset references", async () => {
  for (const path of ["/", "/editor", "/display", "/collection"]) {
    const res = await handler(new Request(`http://localhost${path}`));
    const body = await res.text();
    assertEquals(body.includes("?v="), false);
    for (
      const match of body.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)
    ) {
      const ref = match[1];
      // datastar.js is a vendored third-party file, outside this manifest's
      // scope (see AGENTS.md on vendored public/ assets) and stays unhashed.
      if (ref === "/datastar.js") continue;
      assertMatch(
        ref,
        /\.[0-9a-f]{8}\.(js|css)$/,
        `expected a content-hashed reference, got ${ref}`,
      );
    }
  }
});

Deno.test("the served import map covers the full module graph, not just entry points", async () => {
  const res = await handler(new Request("http://localhost/editor"));
  const body = await res.text();
  const match = body.match(/<script type="importmap">([^<]+)<\/script>/);
  assertEquals(match !== null, true);
  const importMap = JSON.parse(match![1]);
  // local-db.js and shared/compose.js are never named in a <script src> —
  // only reached through a relative import from sync.js/collection-page.js
  // — so their presence here proves the map covers the whole graph.
  assertMatch(
    importMap.imports["/local-db.js"],
    /^\/local-db\.[0-9a-f]{8}\.js$/,
  );
  assertMatch(
    importMap.imports["/shared/compose.js"],
    /^\/shared\/compose\.[0-9a-f]{8}\.js$/,
  );
  assertEquals("/base.css" in importMap.imports, false);
});

Deno.test("GET /asset-manifest.json exposes the manifest for the service worker to consume", async () => {
  const manifest = await getAssetManifest(false);
  const res = await handler(
    new Request("http://localhost/asset-manifest.json"),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-cache");
  const payload = await res.json();
  assertEquals(payload.manifestDigest, manifest.manifestDigest);
  assertEquals(
    payload.assets["/style.css"],
    manifest.byLogicalPath.get("/style.css")?.hashedPath,
  );
});

Deno.test("serves the web app manifest with the required PWA fields", async () => {
  const res = await handler(
    new Request("http://localhost/manifest.webmanifest"),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/manifest+json");
  const manifest = await res.json();
  assertEquals(manifest.id, "/");
  assertEquals(manifest.start_url, "/editor");
  assertEquals(manifest.scope, "/");
  assertEquals(manifest.display, "standalone");
  assertEquals(manifest.launch_handler?.client_mode, "navigate-existing");
  assertEquals("orientation" in manifest, false);
  assertEquals(
    Array.isArray(manifest.icons) && manifest.icons.length >= 3,
    true,
  );
  assertEquals(
    manifest.icons.some((icon: { purpose?: string }) =>
      icon.purpose === "maskable"
    ),
    true,
  );
});

Deno.test("serves /sw.js at root scope with no-cache and Service-Worker-Allowed", async () => {
  const res = await handler(new Request("http://localhost/sw.js"));
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "application/javascript; charset=utf-8",
  );
  assertEquals(res.headers.get("cache-control"), "no-cache");
  assertEquals(res.headers.get("service-worker-allowed"), "/");
  assertMatch(await res.text(), /classifyRequest/);
});

Deno.test("serves the service worker's imported routing module", async () => {
  const res = await handler(new Request("http://localhost/sw-routing.js"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("cache-control"), "no-cache");
  assertMatch(await res.text(), /export function classifyRequest/);
});

Deno.test("serves the offline fallback page through the same asset rewrite as real pages", async () => {
  const res = await handler(new Request("http://localhost/offline.html"));
  assertEquals(res.status, 200);
  const body = await res.text();
  assertEquals(body.includes("?v="), false);
  assertMatch(body, /href="\/base\.[0-9a-f]{8}\.css"/);
});

Deno.test("serves every icon referenced from the manifest as a real PNG", async () => {
  for (
    const path of [
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/icon-512-maskable.png",
      "/icons/apple-touch-icon-180.png",
    ]
  ) {
    const res = await handler(new Request(`http://localhost${path}`));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // The PNG signature, then straight into IHDR to confirm real dimensions.
    assertEquals(
      [...bytes.slice(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assertEquals(new TextDecoder().decode(bytes.slice(12, 16)), "IHDR");
    const width = new DataView(bytes.buffer).getUint32(16);
    const height = new DataView(bytes.buffer).getUint32(20);
    assertEquals(width > 0 && width === height, true);
  }
});

Deno.test("the CSP on every real page allows the service worker and blob: images", async () => {
  const res = await handler(new Request("http://localhost/"));
  const csp = res.headers.get("content-security-policy") ?? "";
  assertMatch(csp, /worker-src 'self'/);
  assertMatch(csp, /manifest-src 'self'/);
  assertMatch(csp, /img-src[^;]*blob:/);
});

Deno.test("every real page carries viewport-fit=cover, the manifest link, and the apple touch icon", async () => {
  for (const path of ["/", "/editor", "/display", "/collection"]) {
    const res = await handler(new Request(`http://localhost${path}`));
    const body = await res.text();
    assertMatch(body, /viewport-fit=cover/);
    assertMatch(body, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assertMatch(
      body,
      /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon-180\.png">/,
    );
    assertMatch(
      body,
      /<meta name="apple-mobile-web-app-capable" content="yes">/,
    );
  }
});
