// @ts-check
import { assertEquals } from "@std/assert";
import { classifyRequest } from "../src/client/sw-routing.js";

/** @param {string} pathname @param {string} [method] @param {string} [mode] */
function classify(pathname, method = "GET", mode = "same-origin") {
  return classifyRequest({ pathname, method, mode });
}

Deno.test("classifies Server-Sent Events streams above everything else", () => {
  assertEquals(classify("/api/live-stream"), "sse");
  assertEquals(classify("/canvases/01ABC/stream"), "sse");
  // Even a navigation-flavored request to an SSE path stays "sse" — the
  // bare-return handling in sw.js must win regardless of request.mode.
  assertEquals(classify("/canvases/01ABC/stream", "GET", "navigate"), "sse");
});

Deno.test("classifies every /api/* GET and every mutating request as network-only", () => {
  assertEquals(classify("/api/me/canvases"), "network-only");
  assertEquals(classify("/api/completed-feed"), "network-only");
  assertEquals(classify("/canvases/01ABC/events", "POST"), "network-only");
  assertEquals(classify("/api/me/draft", "PUT"), "network-only");
  assertEquals(classify("/api/me/draft", "DELETE"), "network-only");
});

Deno.test("classifies page navigations distinctly from same asset paths", () => {
  assertEquals(classify("/editor", "GET", "navigate"), "navigate");
  assertEquals(classify("/", "GET", "navigate"), "navigate");
});

Deno.test("classifies completed-painting replays as stale-while-revalidate", () => {
  assertEquals(classify("/canvases/01ABC/replay"), "replay-swr");
});

Deno.test("classifies content-hashed asset URLs for cache-first, unhashed ones as pass-through", () => {
  assertEquals(classify("/app.4e085198.js"), "hashed-asset");
  assertEquals(classify("/shared/compose.2e336850.js"), "hashed-asset");
  assertEquals(classify("/base.bbab045b.css"), "hashed-asset");
  // No 8-hex-char hash segment: not part of the content-addressed set.
  assertEquals(classify("/manifest.webmanifest"), "pass-through");
  assertEquals(classify("/icons/icon-192.png"), "pass-through");
  assertEquals(classify("/favicon.ico"), "pass-through");
  assertEquals(classify("/Minecraftia-Regular.ttf"), "pass-through");
});
