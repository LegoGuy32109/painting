// @ts-check
/// <reference lib="webworker" />
//
// The PWA shell's service worker. Registered at root scope ("/") by
// src/client/pwa.js. Type-checked separately from the rest of the codebase
// — see deno.worker.json and the "check:sw" step in deno.json's "check"
// task — because this file needs the webworker lib (self, caches, clients,
// FetchEvent, ...) and the project's default lib set is dom-based; the two
// libs declare incompatible globals (both define `self`) and can't be
// combined in one `deno check` run.
//
// Request classification is a pure function in ./sw-routing.js so it can
// be unit-tested under the normal dom lib without touching any of that.

import { classifyRequest } from "./sw-routing.js";

/** @type {ServiceWorkerGlobalScope} */
// @ts-expect-error — `self` is typed as Window under the project's default
// lib elsewhere, but this file's own webworker lib types it correctly; the
// cast is only needed so tooling that doesn't load deno.worker.json (an
// editor's default TS server, say) doesn't flag every `self.` access below.
const worker = self;

const OFFLINE_URL = "/offline.html";
const PRECACHE_PAGES = ["/", "/editor", "/display", "/collection", OFFLINE_URL];

// A fixed-name cache that survives every version — NOT swept on activate —
// used only to remember the active manifest digest across the browser
// terminating and respawning this worker between events. A plain
// module-level variable would not survive that respawn; Cache Storage does.
const META_CACHE_NAME = "painting-meta";
const META_KEY = new Request("/__sw_manifest_meta__");

/** @typedef {{ manifestDigest: string, assets: Record<string, string> }} AssetManifestPayload */

/** @returns {Promise<AssetManifestPayload>} */
async function fetchAndRememberManifest() {
  const response = await fetch("/asset-manifest.json");
  /** @type {AssetManifestPayload} */
  const manifest = await response.json();
  const metaCache = await worker.caches.open(META_CACHE_NAME);
  await metaCache.put(META_KEY, new Response(JSON.stringify(manifest)));
  return manifest;
}

/**
 * The manifest as last known to THIS worker instance. Populated during
 * install (a fresh network fetch — an update cannot happen without network
 * access anyway, since there is nothing new to install without it) and
 * durably remembered in META_CACHE_NAME so a later respawned instance can
 * recover it — via getCurrentManifest() below — without needing network.
 * @returns {Promise<AssetManifestPayload>}
 */
async function getCurrentManifest() {
  const metaCache = await worker.caches.open(META_CACHE_NAME);
  const cached = await metaCache.match(META_KEY);
  if (cached) return await cached.json();
  // No durable record yet (a fresh worker that has never installed, or the
  // meta cache was cleared out-of-band) — only reachable path is network.
  return await fetchAndRememberManifest();
}

/** @param {AssetManifestPayload} manifest */
function cacheNameFor(manifest) {
  return `painting-${manifest.manifestDigest}`;
}

worker.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const manifest = await fetchAndRememberManifest();
    const cache = await worker.caches.open(cacheNameFor(manifest));
    const hashedUrls = Object.values(manifest.assets);
    await cache.addAll([...hashedUrls, ...PRECACHE_PAGES]);
    // Deliberately no skipWaiting() here — see pwa.js for the "new version
    // ready" affordance. Force-activating mid-stroke could lose an
    // in-flight outbox flush in sync.js.
  })());
});

worker.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const manifest = await getCurrentManifest();
    const currentCacheName = cacheNameFor(manifest);
    const names = await worker.caches.keys();
    await Promise.all(
      names
        .filter((name) => name !== currentCacheName && name !== META_CACHE_NAME)
        .map((name) => worker.caches.delete(name)),
    );
    await worker.clients.claim();
  })());
});

worker.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    worker.skipWaiting();
  }
});

/** @param {Request} request @returns {Promise<Response>} */
async function cacheFirst(request) {
  const manifest = await getCurrentManifest();
  const cache = await worker.caches.open(cacheNameFor(manifest));
  const cached = await cache.match(request);
  if (cached) return cached;
  // Not precached for some reason (a partial install, a asset that shipped
  // after this worker's install ran) — fetch once and cache it; the URL is
  // content-addressed, so caching it now is exactly as safe as having
  // precached it originally.
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/** @param {Request} request @returns {Promise<Response>} */
async function staleWhileRevalidate(request) {
  const manifest = await getCurrentManifest();
  const cache = await worker.caches.open(cacheNameFor(manifest));
  const cached = await cache.match(request);
  const revalidate = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  if (cached) {
    // Update the cache in the background; the caller doesn't wait on it.
    revalidate.catch(() => {});
    return cached;
  }
  const fresh = await revalidate;
  if (fresh) return fresh;
  throw new Error("replay unavailable offline and not cached");
}

/** @param {Request} request @returns {Promise<Response>} */
async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    const manifest = await getCurrentManifest();
    const cache = await worker.caches.open(cacheNameFor(manifest));
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch {
    const manifest = await getCurrentManifest();
    const cache = await worker.caches.open(cacheNameFor(manifest));
    const cachedPage = await cache.match(request);
    if (cachedPage) return cachedPage;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    throw new Error("offline and no cached fallback available");
  }
}

worker.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const kind = classifyRequest({
    pathname: url.pathname,
    method: request.method,
    mode: request.mode,
  });

  switch (kind) {
    case "sse":
      // Server-Sent Events. Do NOT call event.respondWith at all — piping
      // a streaming response body through the service worker breaks it in
      // subtle ways (buffering, connection lifecycle). A bare return lets
      // the browser handle the request exactly as if there were no service
      // worker in scope, which is the only safe option for a stream.
      return;
    case "network-only":
      event.respondWith(fetch(request));
      return;
    case "navigate":
      event.respondWith(networkFirstNavigation(request));
      return;
    case "hashed-asset":
      event.respondWith(cacheFirst(request));
      return;
    case "replay-swr":
      event.respondWith(staleWhileRevalidate(request));
      return;
    case "pass-through":
      event.respondWith(fetch(request));
      return;
  }
});
