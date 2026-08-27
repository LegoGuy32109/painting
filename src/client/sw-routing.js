// @ts-check
//
// Pure request-classification logic for src/client/sw.js, pulled out on its
// own so it can be unit-tested under the project's normal dom lib — sw.js
// itself needs the webworker lib (see deno.worker.json) to type-check its
// ServiceWorkerGlobalScope/FetchEvent usage, and mixing dom + webworker libs
// in one program doesn't work. This module touches neither: no `self`,
// `caches`, or `clients` — just pathname/method/mode in, a RouteKind out.

/**
 * @typedef {"sse" | "network-only" | "navigate" | "hashed-asset" | "replay-swr" | "pass-through"} RouteKind
 */

const SSE_STREAM_PATTERN = /^\/canvases\/[^/]+\/stream$/;
const REPLAY_PATTERN = /^\/canvases\/[^/]+\/replay$/;
// Phase 0.5's content-addressing scheme: an 8-hex-char hash immediately
// before the file extension. Matching on shape (not a hardcoded file list)
// means this file never needs updating when asset-manifest.ts's served-file
// allowlists change.
const HASHED_ASSET_PATTERN = /\.[0-9a-f]{8}\.(?:js|css)$/;

/**
 * Classifies one request so sw.js knows how to handle it. Order matters —
 * callers must check in this priority order (SSE first, above all else).
 * @param {{ pathname: string, method: string, mode: string }} request
 * @returns {RouteKind}
 */
export function classifyRequest({ pathname, method, mode }) {
  // (a) Server-Sent Events streams: the fetch handler must not touch these
  // at all — see sw.js's bare `return` (no respondWith) for why.
  if (pathname === "/api/live-stream" || SSE_STREAM_PATTERN.test(pathname)) {
    return "sse";
  }

  // (b) Every other API call, and every mutating request regardless of
  // path: network-only, never cached. /api/me/* is `private, no-store`
  // server-side specifically so one guest's collection can never leak into
  // another's cache.
  if (method !== "GET" || pathname.startsWith("/api/")) {
    return "network-only";
  }

  // (c) Page navigations: network-first, falling back to a cached copy of
  // that route and then to the offline fallback page.
  if (mode === "navigate") {
    return "navigate";
  }

  // (e) Completed-painting replays: already long-cacheable server-side
  // (max-age=3600, effectively immutable once signed) — stale-while-
  // revalidate makes /collection's replays work offline too.
  if (REPLAY_PATTERN.test(pathname)) {
    return "replay-swr";
  }

  // (d) Content-hashed client/shared/css assets: cache-first, no
  // revalidation, ever — safe only because the URL is content-derived
  // (Phase 0.5). This is that phase's payoff.
  if (HASHED_ASSET_PATTERN.test(pathname)) {
    return "hashed-asset";
  }

  // Everything else (manifest.webmanifest, icons, the font, favicon, ...)
  // isn't part of the content-addressed set and isn't safe to cache
  // indefinitely, so it just passes through to the network untouched.
  return "pass-through";
}
