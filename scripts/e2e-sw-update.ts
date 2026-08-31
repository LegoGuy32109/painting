// End-to-end coverage for the service worker's "new version ready" update
// flow (src/client/pwa.js's watchForUpdate()/showUpdateBanner(), and
// src/client/sw.js's deliberate lack of skipWaiting() on install).
// Previously never executed.
//
// /sw.js is served unhashed with Cache-Control: no-cache and read from
// disk PER REQUEST (see src/server/main.ts) — so this script actually
// modifies src/client/sw.js's bytes mid-run to make a genuinely different
// worker available, exactly as a real deploy would. The file is restored
// in a `finally` no matter how the run ends, and this script verifies the
// restore by shelling out to `git status --porcelain` on that one file
// afterward — a failed run must never leave the repo modified.
//
// Modeled on scripts/e2e-passkey.ts's server-spawning / ephemeral-Turso
// shape.

import { chromium } from "playwright-core";
import { createDb } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_354;
const baseUrl = `http://localhost:${port}`;
const swPath = new URL("../src/client/sw.js", import.meta.url);

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

console.log("Creating ephemeral Turso database for the sw-update e2e run...");
const ephemeral = await createEphemeralDatabase("sw-update");
let server: Deno.ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
const originalSwSource = await Deno.readTextFile(swPath);
let swModified = false;

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
      GUEST_SESSION_SECRET: "sw-update-e2e-guest-session-secret-32-bytes",
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

  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });

  // pwa.js registers the service worker itself on module load; wait for
  // it to reach "active" and take control of THIS page (its activate
  // handler calls clients.claim()).
  await page.waitForFunction(
    () => navigator.serviceWorker.controller !== null,
    { timeout: 15_000 },
  );
  console.log("PASS: first install activated and took control of the page");

  // No update banner should exist yet — nothing has changed.
  const bannerBeforeUpdate = await page.locator("text=A new version is ready.").count();
  if (bannerBeforeUpdate !== 0) {
    throw new Error("update banner appeared before any update was available");
  }

  // --- Make the worker file genuinely different -----------------------
  await Deno.writeTextFile(
    swPath,
    `${originalSwSource}\n// e2e-sw-update.ts test marker: ${crypto.randomUUID()}\n`,
  );
  swModified = true;

  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
  });

  // The new worker should become "installed" (waiting), triggering the
  // banner via pwa.js's watchForUpdate() — but must NOT self-activate.
  const banner = page.locator("text=A new version is ready.");
  await banner.waitFor({ state: "visible", timeout: 15_000 });
  console.log("PASS: update banner appeared for the modified worker");

  const waitingScriptState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      hasWaiting: registration.waiting !== null,
      controllerScriptURL: navigator.serviceWorker.controller?.scriptURL ?? null,
    };
  });
  if (!waitingScriptState.hasWaiting) {
    throw new Error("expected a waiting worker after registration.update(), found none");
  }
  console.log("PASS: new worker is WAITING, not yet controlling the page");

  // Confirm it truly has not activated on its own: give it a beat, then
  // check the controller (the pre-existing worker) is unchanged and no
  // controllerchange has fired yet.
  let controllerChanged = false;
  await page.exposeFunction("__e2eControllerChanged", () => {
    controllerChanged = true;
  });
  await page.evaluate(() => {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // @ts-expect-error injected by exposeFunction above
      window.__e2eControllerChanged();
    });
  });
  await page.waitForTimeout(500);
  if (controllerChanged) {
    throw new Error("controllerchange fired before the user clicked Reload");
  }
  console.log("PASS: waiting worker did not self-activate");

  // --- Click the banner's Reload action ---------------------------------
  const reloadButton = page.locator("button:has-text('Reload')");
  await reloadButton.waitFor({ state: "visible", timeout: 5_000 });
  await Promise.all([
    page.waitForEvent("load", { timeout: 15_000 }),
    reloadButton.click(),
  ]);

  if (!controllerChanged) {
    throw new Error("controllerchange never fired after clicking Reload");
  }
  console.log("PASS: controllerchange fired and the page reloaded");

  const finalControllerState = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return { hasWaiting: registration.waiting !== null };
  });
  if (finalControllerState.hasWaiting) {
    throw new Error("a worker is still waiting after the update flow completed");
  }
  console.log("PASS: the new worker is now active, none waiting");

  await context.close();
  console.log("ALL PASS: service worker update flow exercised end-to-end.");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();

  if (swModified) {
    await Deno.writeTextFile(swPath, originalSwSource);
    console.log("Restored src/client/sw.js to its original contents.");
  }
  const statusCheck = new Deno.Command("git", {
    args: ["status", "--porcelain", "--", "src/client/sw.js"],
    cwd: new URL("..", import.meta.url),
    stdout: "piped",
    stderr: "inherit",
  });
  const { stdout } = await statusCheck.output();
  const statusOutput = new TextDecoder().decode(stdout).trim();
  if (statusOutput.length > 0) {
    throw new Error(
      `src/client/sw.js was NOT cleanly restored — git status shows:\n${statusOutput}`,
    );
  }
  console.log("Verified: git status shows src/client/sw.js unmodified.");
}
