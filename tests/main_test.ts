import { assertEquals } from "@std/assert";
import { handler } from "../src/server/main.ts";

Deno.test("returns html on /", async () => {
  const res = await handler(new Request("http://localhost/"));
  assertEquals(res.headers.get("content-type"), "text/html");
  const body = await res.text();
  assertEquals(body.includes("Joy of Painting"), true);
});

Deno.test("returns the Minecraft font", async () => {
  const res = await handler(
    new Request("http://localhost/Minecraftia-Regular.ttf"),
  );
  assertEquals(res.headers.get("content-type"), "font/ttf");
});

Deno.test("returns the stylesheet", async () => {
  const res = await handler(new Request("http://localhost/style.css"));
  assertEquals(res.headers.get("content-type"), "text/css; charset=utf-8");
});

Deno.test("returns the browser modules", async () => {
  for (const path of ["/app.js", "/paint-engine.js", "/palette-engine.js"]) {
    const res = await handler(new Request(`http://localhost${path}`));
    assertEquals(
      res.headers.get("content-type"),
      "application/javascript; charset=utf-8",
    );
    assertEquals((await res.text()).length > 0, true);
  }
});

Deno.test("returns json on /api", async () => {
  const res = await handler(new Request("http://localhost/api"));
  const data = await res.json();
  assertEquals(data.message, "Hello, world!");
  assertEquals(typeof data.time, "string");
});
