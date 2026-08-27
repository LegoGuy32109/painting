// Tier 2 — logic-only coverage for src/client/pwa.js's storage.persist()
// timing: it is deliberately requested right after the FIRST committed
// stroke, never on cold page load, because Chromium grants persistence
// based on engagement signals and a cold-load request is likelier to be
// denied. This drives a REAL stroke through the real editor (a mouse
// drag on <paint-canvas>, not a synthetic DOM event) and asserts
// navigator.storage.persist() is called exactly once that stroke commits
// — and NOT at load.
//
// Also tries context.grantPermissions(["persistent-storage"]) and reports
// whether Chromium then actually returns true from persist(), per the
// brief this script was written against; if it stays false, the
// assertion is on the CALL happening at the right time, not the outcome.
//
// Modeled on scripts/e2e-passkey.ts's server-spawning / ephemeral-Turso
// shape.

import { chromium } from "playwright-core";
import { createDb } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_357;
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

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("Creating ephemeral Turso database for the pwa-persist e2e run...");
const ephemeral = await createEphemeralDatabase("pwa-persist");
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
      GUEST_SESSION_SECRET: "pwa-persist-e2e-guest-session-secret-32-bytes",
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

  let grantedPersistentStorage = false;
  try {
    await context.grantPermissions(["persistent-storage"]);
    grantedPersistentStorage = true;
  } catch (error) {
    console.log(
      `context.grantPermissions(["persistent-storage"]) is not supported here: ${
        error instanceof Error ? error.message : error
      }`,
    );
  }

  const page = await context.newPage();

  // Instrument navigator.storage.persist() BEFORE any app code runs, via
  // addInitScript so it's in place for every navigation in this context.
  await context.addInitScript(() => {
    // @ts-expect-error test-only instrumentation global
    window.__persistCalls = [];
    if (navigator.storage && "persist" in navigator.storage) {
      const original = navigator.storage.persist.bind(navigator.storage);
      navigator.storage.persist = async () => {
        // @ts-expect-error test-only instrumentation global
        window.__persistCalls.push(Date.now());
        return await original();
      };
    }
  });

  await page.goto(`${baseUrl}/editor`, { waitUntil: "load" });

  // Give the page a moment to settle after load — this is exactly the
  // "cold load" window persist() must NOT be called during.
  await page.waitForTimeout(500);
  const callsAtLoad = await page.evaluate(() =>
    // @ts-expect-error test-only instrumentation global
    window.__persistCalls.length
  );
  assert(
    callsAtLoad === 0,
    `storage.persist() timing: called ${callsAtLoad} time(s) on cold load, expected 0`,
  );
  console.log("PASS (storage.persist() timing): not called on cold page load");

  // Drive a REAL stroke: a mouse drag across the paint-canvas element's
  // own <canvas>, not a synthetic stroke-committed DOM event.
  const canvasHandle = page.locator("paint-canvas canvas").first();
  await canvasHandle.waitFor({ state: "visible", timeout: 10_000 });
  const box = await canvasHandle.boundingBox();
  if (!box) throw new Error("paint-canvas's <canvas> has no bounding box");
  const startX = box.x + box.width * 0.3;
  const startY = box.y + box.height * 0.3;
  const endX = box.x + box.width * 0.6;
  const endY = box.y + box.height * 0.6;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 8 });
  await page.mouse.up();

  // stroke-committed fires on pointerup handling; give the listener a
  // moment to run and requestPersistedStorageOnce() to resolve.
  await page.waitForFunction(
    // @ts-expect-error test-only instrumentation global
    () => window.__persistCalls.length > 0,
    { timeout: 5_000 },
  ).catch(() => {
    throw new Error(
      "storage.persist() timing: was never called after a real committed stroke",
    );
  });
  const callsAfterStroke = await page.evaluate(() =>
    // @ts-expect-error test-only instrumentation global
    window.__persistCalls.length
  );
  assert(
    callsAfterStroke === 1,
    `storage.persist() timing: expected exactly 1 call after the first committed stroke, ` +
      `got ${callsAfterStroke}`,
  );
  console.log(
    "PASS (storage.persist() timing): called exactly once, right after the first committed stroke",
  );

  const persistedNow = await page.evaluate(async () => {
    if (!navigator.storage?.persisted) return null;
    return await navigator.storage.persisted();
  });
  console.log(
    `INFO: navigator.storage.persisted() after the request ${
      persistedNow === null ? "is unsupported here" : `returned ${persistedNow}`
    } ` +
      `(context.grantPermissions(["persistent-storage"]) ${
        grantedPersistentStorage ? "succeeded" : "was NOT supported"
      })`,
  );
  if (grantedPersistentStorage && persistedNow === true) {
    console.log(
      "INFO: Chromium DID return true for storage.persisted() after granting the permission",
    );
  } else {
    console.log(
      "INFO: persisted() did not report true even with the permission granted — asserting " +
        "only on the CALL happening at the right time, not the outcome, as the brief allows",
    );
  }

  // A second stroke must NOT call persist() again (requestPersistedStorageOnce
  // is one-shot per pwa.js flag, and this script's own listener also
  // guards with a local `persistRequested` boolean — see pwa.js).
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX + 10, endY + 10, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const callsAfterSecondStroke = await page.evaluate(() =>
    // @ts-expect-error test-only instrumentation global
    window.__persistCalls.length
  );
  assert(
    callsAfterSecondStroke === 1,
    `storage.persist() timing: expected persist() to stay one-shot, got ${callsAfterSecondStroke} calls`,
  );
  console.log("PASS (storage.persist() timing): stays one-shot across further strokes");

  await context.close();
  console.log("ALL PASS: storage.persist() timing exercised via a real committed stroke.");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
