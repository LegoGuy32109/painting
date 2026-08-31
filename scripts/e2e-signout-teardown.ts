// End-to-end proof that signing out actually leaves the device clean, and
// that "Sign out everywhere" revokes sessions the device can no longer
// reach. Both are client-state properties that no server test can observe:
// the bugs they cover lived entirely in what localStorage and IndexedDB
// still held after POST /api/auth/logout returned 200.
//
// Before the teardown existed, signing out replaced the cookie and nothing
// else, so the next profile on the device inherited the previous one's
// currentCanvasId and its whole local event history — which sync.js
// renders onto the canvas before it has asked the server anything. A brand
// new guest opened the editor looking at the signed-out account's
// painting, and the stale cached WebAuthn user.id meant that guest
// renaming its handle relabelled the SIGNED-OUT account's passkey in the
// platform password manager.
//
// Modeled on scripts/e2e-passkey.ts: same ephemeral database, same spawned
// server, same CDP virtual authenticator (an account is required — the
// sign-out controls only render for a profile with a credential).

import { chromium, type Page } from "playwright-core";
import { createDb } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_352;
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Everything this device is holding on to, from the browser's point of view. */
function deviceState(page: Page) {
  return page.evaluate(async () => {
    const db: IDBDatabase = await new Promise((resolve) => {
      const request = indexedDB.open("painting-local");
      request.onsuccess = () => resolve(request.result);
    });
    const stores: Record<string, number> = {};
    for (const name of [...db.objectStoreNames]) {
      stores[name] = await new Promise<number>((resolve) => {
        const request = db.transaction(name).objectStore(name).count();
        request.onsuccess = () => resolve(request.result);
      });
    }
    db.close();
    const canvas = document.querySelector("paint-canvas") as
      | (HTMLElement & { pixels?: Int32Array })
      | null;
    return {
      localStorageKeys: Object.keys(localStorage).sort(),
      currentCanvasId: localStorage.getItem("currentCanvasId"),
      webauthnUserId: localStorage.getItem("webauthnUserId"),
      stores,
      pixels: canvas?.pixels ? Array.from(canvas.pixels) : null,
    };
  });
}

/** Paints one real stroke: a pigment click, then a mouse drag across the canvas. */
async function paintAStroke(page: Page): Promise<void> {
  await page.locator("paint-palette").locator("css=[data-palette-index]")
    .first().click();
  await page.waitForFunction(
    () =>
      (document.querySelector("paint-canvas") as { canPaint?: boolean } | null)
        ?.canPaint === true,
    { timeout: 10_000 },
  );
  const box = await page.locator("paint-canvas canvas").first().boundingBox();
  assert(box, "paint-canvas has no bounding box");
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.75, {
    steps: 20,
  });
  await page.mouse.up();
  await page.waitForFunction(
    () => document.getElementById("sync-status")?.dataset.state === "synced",
    { timeout: 20_000 },
  );
}

console.log("Creating ephemeral Turso database for the sign-out e2e run...");
const ephemeral = await createEphemeralDatabase("signout");
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
      GUEST_SESSION_SECRET: "signout-e2e-guest-session-secret-32-bytes",
      PAINTING_KEYS: `e2e:${randomKey()}`,
      WEBAUTHN_RP_ID: "localhost",
      WEBAUTHN_ORIGINS: baseUrl,
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
  page.on("dialog", (dialog) => void dialog.accept());

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
      },
    },
  );

  // --- Become an account, then leave real local painting state behind ---
  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
  const upgradeButton = page.locator(
    "#account-panel button:has-text('Create an account')",
  );
  await upgradeButton.waitFor({ state: "visible", timeout: 10_000 });
  await upgradeButton.click();
  await page.locator("#account-panel h2:has-text('Your account')").waitFor({
    state: "visible",
    timeout: 15_000,
  });

  await page.goto(`${baseUrl}/editor`, { waitUntil: "load" });
  await paintAStroke(page);

  const before = await deviceState(page);
  assert(before.currentCanvasId, "expected a currentCanvasId after painting");
  assert(
    before.webauthnUserId,
    "expected registration to have cached webauthnUserId — the leak this test covers",
  );
  assert(
    before.stores.canvas_history > 0 || before.stores.local_events > 0,
    `expected local event state after painting, got ${
      JSON.stringify(before.stores)
    }`,
  );
  const accountCanvasId = before.currentCanvasId;
  const accountArtwork = JSON.stringify(before.pixels);
  assert(
    new Set(before.pixels ?? []).size > 1,
    "the stroke did not actually change any pixels",
  );
  console.log(`Account painted canvas ${accountCanvasId}.`);

  // --- Sign out ---
  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
  const signOut = page.locator("#account-panel button:has-text('Sign out')")
    .first();
  await signOut.waitFor({ state: "visible", timeout: 10_000 });
  // The handler drains the outbox and clears storage before reloading, so
  // wait for the reload itself rather than for any intermediate state.
  await Promise.all([
    page.waitForEvent("load", { timeout: 20_000 }),
    signOut.click(),
  ]);

  const after = await deviceState(page);
  assert(
    after.currentCanvasId === null,
    `sign-out left currentCanvasId behind: ${after.currentCanvasId}`,
  );
  assert(
    after.webauthnUserId === null,
    "sign-out left the account's cached WebAuthn user.id behind — a later " +
      "handle rename by the next profile would relabel the signed-out " +
      "account's passkey",
  );
  for (const [name, count] of Object.entries(after.stores)) {
    assert(count === 0, `sign-out left ${count} row(s) in ${name}`);
  }
  console.log(
    "PASS (teardown): local storage and IndexedDB are empty after sign-out.",
  );

  // --- The next profile on this device must not inherit any of it ---
  await page.goto(`${baseUrl}/editor`, { waitUntil: "load" });
  await page.waitForFunction(
    () =>
      (document.querySelector("paint-canvas") as { ready?: boolean } | null)
        ?.ready === true,
    { timeout: 15_000 },
  );
  const nextGuest = await deviceState(page);
  assert(
    nextGuest.currentCanvasId !== accountCanvasId,
    "the next guest is pointed at the signed-out account's canvas id",
  );
  assert(
    JSON.stringify(nextGuest.pixels) !== accountArtwork,
    "the next guest's editor is rendering the signed-out account's painting",
  );
  assert(
    new Set(nextGuest.pixels ?? []).size === 1,
    `the next guest's canvas is not blank: ${
      new Set(nextGuest.pixels ?? []).size
    } distinct colours`,
  );
  console.log(
    "PASS (isolation): the next guest gets a blank canvas of its own.",
  );

  // --- Sign out everywhere revokes a cookie the device no longer holds ---
  //
  // Drop the draft the isolation check above just caused this fresh guest
  // to create. Signing back in with drafts on BOTH sides is the merge-
  // dialog row of the sign-in table, which is a different flow with its own
  // e2e (scripts/e2e-merge-dialog.ts); this test wants the silent row.
  const dropped = await page.evaluate(async () =>
    (await fetch("/api/me/draft", { method: "DELETE" })).status
  );
  assert(dropped === 204, `could not clear the guest draft (got ${dropped})`);

  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
  const signIn = page.locator(
    "#account-panel button:has-text('Sign in with a passkey')",
  );
  await signIn.waitFor({ state: "visible", timeout: 10_000 });
  await signIn.click();
  await page.locator("#account-panel h2:has-text('Your account')").waitFor({
    state: "visible",
    timeout: 15_000,
  });

  // Snapshot the account's live cookie, standing in for a session on some
  // OTHER device that this browser cannot reach.
  const otherDeviceCookie = (await context.cookies())
    .find((cookie) => cookie.name === "painting_guest");
  assert(otherDeviceCookie, "no guest cookie after signing back in");

  const signOutAll = page.locator(
    "#account-panel button:has-text('Sign out everywhere')",
  );
  await signOutAll.waitFor({ state: "visible", timeout: 10_000 });
  // page.on("dialog") above accepts the confirm() this opens.
  await Promise.all([
    page.waitForEvent("load", { timeout: 20_000 }),
    signOutAll.click(),
  ]);

  // A plain logout would leave this cookie perfectly usable for 400 days.
  const replay = await fetch(`${baseUrl}/api/me/handle`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      cookie: `painting_guest=${otherDeviceCookie.value}`,
      origin: baseUrl,
    },
    body: JSON.stringify({ handle: "Revoked Session Rename" }),
  });
  assert(
    replay.status === 401,
    `the other device's session survived "sign out everywhere" (got ${replay.status}, expected 401)`,
  );
  console.log(
    'PASS (revocation): "sign out everywhere" invalidated an outstanding session ' +
      "cookie held elsewhere.",
  );

  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  await context.close();
  console.log("\nAll sign-out teardown checks passed.");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
