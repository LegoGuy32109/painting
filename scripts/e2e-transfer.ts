// End-to-end test for Phase 5's transfer codes, driven through a REAL
// Chromium instance: generate a code in one browser context (device A),
// consume it in a completely separate, fresh browser context (device B —
// its own cookie jar, exactly like a second physical device or an iOS
// installed app's separate storage jar), and confirm device B lands on
// the SAME profile device A had.
//
// Modeled on scripts/e2e-passkey.ts's server-spawning / ephemeral-Turso
// shape, but needs no WebAuthn virtual authenticator at all — a transfer
// code performs no WebAuthn ceremony.

import { chromium } from "playwright-core";
import { createDb, getProfile } from "../src/server/db.ts";
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

console.log("Creating ephemeral Turso database for the transfer-code e2e run...");
const ephemeral = await createEphemeralDatabase("transfer");
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
      GUEST_SESSION_SECRET: "transfer-e2e-guest-session-secret-32-bytes",
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

  // Device A: generates the code.
  const deviceA = await browser.newContext();
  const pageA = await deviceA.newPage();
  await pageA.goto(`${baseUrl}/collection`, { waitUntil: "load" });

  const generateButton = pageA.locator(
    "#account-panel button:has-text('Generate a transfer code')",
  );
  await generateButton.waitFor({ state: "visible", timeout: 10_000 });
  await generateButton.click();

  const codeValue = pageA.locator(".transfer-code-value");
  await codeValue.waitFor({ state: "visible", timeout: 10_000 });
  const displayedCode = (await codeValue.textContent())?.trim() ?? "";
  if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(displayedCode)) {
    throw new Error(`unexpected code display format: "${displayedCode}"`);
  }
  const code = displayedCode.replace("-", "");

  const meAResponse = await pageA.request.get(`${baseUrl}/api/me`);
  const meA = await meAResponse.json();
  if (!meA.handle) throw new Error("device A has no handle after generating a code");

  // Device B: a totally separate browser context — its own cookie jar,
  // exactly like a second device or an iOS home-screen app's separate
  // storage.
  const deviceB = await browser.newContext();
  const pageB = await deviceB.newPage();
  await pageB.goto(`${baseUrl}/collection`, { waitUntil: "load" });

  const codeInput = pageB.locator(".transfer-consume-form input");
  await codeInput.waitFor({ state: "visible", timeout: 10_000 });
  await codeInput.fill(displayedCode);

  // A successful, non-pending consume reloads the page (see
  // collection-page.js) — wait for that navigation IN PARALLEL with the
  // click, not after it resolves: submitTransferCode() is async, so
  // location.reload() only happens once its fetch settles, well after
  // click() itself has resolved. Waiting for the load event afterward
  // would very likely observe the ORIGINAL page's already-settled "load"
  // state instead of the reload. Then confirm the landed profile via
  // /api/me rather than assuming DOM text, since the guest cookie itself
  // never exposes a profile id to JavaScript.
  await Promise.all([
    // waitForLoadState('load') can resolve IMMEDIATELY if the page is
    // already in the loaded state (it checks current state, not a NEW
    // event) — since this page loaded once already, that would race
    // ahead of the reload every time. waitForEvent('load') specifically
    // waits for the NEXT 'load' DOM event to fire.
    pageB.waitForEvent("load", { timeout: 15_000 }),
    pageB.locator(".transfer-consume-form button[type=submit]").click(),
  ]);
  const meBResponse = await pageB.request.get(`${baseUrl}/api/me`);
  const meB = await meBResponse.json();
  if (meB.handle !== meA.handle) {
    throw new Error(
      `device B landed on handle "${meB.handle}", expected device A's handle "${meA.handle}"`,
    );
  }

  // Confirm server-side too: exactly one profile should exist with that
  // handle (device B's original, pre-consume guest profile was empty and
  // should simply be abandoned, not merged into anything, since it never
  // owned any canvases).
  const profilesRes = await db.execute({
    sql: "SELECT id FROM profiles WHERE handle = ?",
    args: [meA.handle],
  });
  if (profilesRes.rows.length !== 1) {
    throw new Error(
      `expected exactly one profile with handle "${meA.handle}", found ${profilesRes.rows.length}`,
    );
  }
  const profile = await getProfile(db, String(profilesRes.rows[0].id));
  if (!profile) throw new Error("profile disappeared after transfer");

  console.log(
    `PASS: device B consumed device A's transfer code and landed on the ` +
      `same profile (handle "${profile.handle}")`,
  );

  await deviceA.close();
  await deviceB.close();
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
