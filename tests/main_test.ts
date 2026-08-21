import { assertEquals, assertMatch } from "@std/assert";
import { handler } from "../src/server/main.ts";

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

Deno.test("returns the stylesheet", async () => {
  const res = await handler(new Request("http://localhost/style.css"));
  assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
  assertEquals(
    res.headers.get("cache-control"),
    "public, max-age=0, must-revalidate",
  );
});

Deno.test("revalidates mutable browser modules", async () => {
  const res = await handler(
    new Request("http://localhost/local-db.js?v=3"),
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("cache-control"),
    "public, max-age=0, must-revalidate",
  );
  assertMatch(await res.text(), /export function deleteCanvasLocal/);
});

Deno.test("unknown paths return 404 instead of the application shell", async () => {
  const res = await handler(new Request("http://localhost/missing.js"));
  assertEquals(res.status, 404);
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

Deno.test("guest profiles are issued once in a protected cookie", async () => {
  const first = await handler(new Request("https://paint.example/"));
  const setCookie = first.headers.get("set-cookie") ?? "";
  assertMatch(setCookie, /HttpOnly/);
  assertMatch(setCookie, /SameSite=Strict/);
  assertMatch(setCookie, /Secure/);

  const second = await handler(
    new Request("https://paint.example/", {
      headers: { cookie: cookieFrom(first) },
    }),
  );
  assertEquals(second.status, 200);
  assertEquals(second.headers.has("set-cookie"), false);
});

Deno.test("returns the browser modules", async () => {
  for (
    const path of [
      "/app.js",
      "/shared/paint-engine.js",
      "/shared/palette-engine.js",
      "/shared/pixel-render.js",
      "/live-replay.js",
      "/site-nav.js",
      "/painting-parade.js",
      "/collection-page.js",
      "/editor-page.js",
    ]
  ) {
    const res = await handler(new Request(`http://localhost${path}`));
    assertEquals(
      res.headers.get("content-type"),
      "application/javascript; charset=utf-8",
    );
    assertEquals((await res.text()).length > 0, true);
  }
});
