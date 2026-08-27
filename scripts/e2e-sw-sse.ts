// End-to-end check that the service worker does not break Server-Sent
// Events. src/client/sw.js's fetch handler classifies `/api/live-stream`
// and `/canvases/*/stream` as "sse" and does a bare `return` — no
// event.respondWith() at all — specifically because piping a streaming
// response body through a service worker breaks it subtly (buffering,
// connection lifecycle). This is exactly the kind of bypass that can
// regress silently, so this drives a REAL EventSource against a REAL
// server WHILE a service worker is active and controlling the page, and
// asserts messages still arrive.
//
// Deliberately does not touch or depend on src/client/painting-parade.js
// (off limits — someone else is actively rewriting it): this opens its
// own plain EventSource from the page context instead of relying on the
// <painting-parade> custom element's internal wiring.
//
// Modeled on scripts/e2e-passkey.ts's server-spawning / ephemeral-Turso
// shape.

import { chromium } from "playwright-core";
import { createDb } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_355;
const baseUrl = `http://localhost:${port}`;

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not come up in time");
}

console.log("Creating ephemeral Turso database for the sw-sse e2e run...");
const ephemeral = await createEphemeralDatabase("sw-sse");
let server: Deno.ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  Deno.env.set("TURSO_DB_URL", ephemeral.url);
  Deno.env.set("TURSO_DB_TOKEN", ephemeral.token);
  const db = createDb();
  await migrateDatabase(db);

  server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/server/main.ts"],
    cwd: new URL("..", import.meta.url),
    env: {
      ...Deno.env.toObject(),
      PORT: String(port),
      TURSO_DB_URL: ephemeral.url,
      TURSO_DB_TOKEN: ephemeral.token,
      GUEST_SESSION_SECRET: "sw-sse-e2e-guest-session-secret-32-bytes",
      PAINTING_KEYS: `e2e:${randomKey()}`,
    },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  await waitForServer();

  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${baseUrl}/`, { waitUntil: "load" });

  // Confirm a service worker is genuinely active and controlling this
  // page before trusting the SSE result at all — otherwise a "yes it
  // works" result would be meaningless (no worker was ever in the path).
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    { timeout: 15_000 },
  );
  console.log("PASS: service worker is active and controlling the page");

  // Sanity check: fetch() through the SW for a plain page (network-only
  // classification territory doesn't apply to a GET navigation, but this
  // just confirms the worker is genuinely intercepting fetches at all —
  // not required by the brief, kept minimal.)

  const result = await page.evaluate(async () => {
    return await new Promise<{ ok: true; type: string } | { ok: false; reason: string }>(
      (resolve) => {
        const source = new EventSource("/api/live-stream");
        const timeout = setTimeout(() => {
          source.close();
          resolve({ ok: false, reason: "timed out waiting for any SSE message" });
        }, 10_000);
        for (const type of ["sync", "snapshot", "diff", "completed", "inactive"]) {
          source.addEventListener(type, () => {
            clearTimeout(timeout);
            source.close();
            resolve({ ok: true, type });
          });
        }
        source.onerror = () => {
          // EventSource retries automatically; only treat this as a hard
          // failure if we time out without ever having received anything
          // (handled by the timeout above). A transient onerror alone is
          // not itself a failure.
        };
      },
    );
  });

  if (!result.ok) {
    throw new Error(`SSE through an active service worker failed: ${result.reason}`);
  }
  console.log(`PASS: received a "${result.type}" SSE message through the active service worker`);

  await context.close();
  console.log("ALL PASS: service worker does not break SSE.");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
