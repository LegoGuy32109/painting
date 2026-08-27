// Tier 2 — logic-only coverage for src/client/pwa.js's two "should we ask
// to install?" affordances. Chromium will not fire a real
// `beforeinstallprompt` on demand (it's gated behind installability plus
// engagement heuristics with no CDP override), and there is no WebKit
// here to exercise `navigator.standalone` for real — so BOTH sections
// below drive our OWN handling with a SYNTHETIC event / overridden
// globals. This tests our gating logic, not proof that either browser
// fires/reports the real thing. Test names say so explicitly.
//
// Modeled on scripts/e2e-passkey.ts's server-spawning / ephemeral-Turso
// shape.

import { chromium, type Page } from "playwright-core";
import { createDb } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_356;
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

/** A crude 26-char Crockford-base32-ish id, valid against the server's ULID regex. */
function fakeUlid(): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

async function bannerCount(page: Page, text: string): Promise<number> {
  return await page.locator(`div[role="status"]:has-text("${text}")`).count();
}

async function dispatchSyntheticBeforeInstallPrompt(page: Page): Promise<void> {
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    // @ts-expect-error synthetic BeforeInstallPromptEvent shape
    event.prompt = () => Promise.resolve();
    // @ts-expect-error synthetic BeforeInstallPromptEvent shape
    event.userChoice = Promise.resolve({ outcome: "accepted" });
    window.dispatchEvent(event);
  });
}

async function dispatchAppInstalled(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
}

async function markJustSigned(page: Page): Promise<void> {
  await page.evaluate(() => sessionStorage.setItem("paintingJustSigned", "1"));
}

async function clearAllStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}

console.log("Creating ephemeral Turso database for the pwa-install e2e run...");
const ephemeral = await createEphemeralDatabase("pwa-install");
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
      GUEST_SESSION_SECRET: "pwa-install-e2e-guest-session-secret-32-bytes",
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

  // === Section 1: install banner logic (synthetic event; Chromium will ===
  // === not fire the real beforeinstallprompt on demand) ===================
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });

    // Case A: nothing signed yet -> a synthetic beforeinstallprompt must
    // NOT produce a visible install banner.
    await dispatchSyntheticBeforeInstallPrompt(page);
    await page.waitForTimeout(200);
    assert(
      (await bannerCount(page, "Enjoying it?")) === 0,
      "install banner logic (synthetic event): banner appeared with no signed painting",
    );
    console.log(
      "PASS (install banner logic; synthetic event, Chromium will not fire the real one " +
        "on demand): no banner without a signed painting",
    );

    // Case B: mark "just signed", reload (so pwa.js re-evaluates the flag
    // at module load, per its own documented one-shot design), then fire
    // the synthetic event -> banner must appear.
    await markJustSigned(page);
    await page.reload({ waitUntil: "load" });
    await dispatchSyntheticBeforeInstallPrompt(page);
    const installBanner = page.locator('div[role="status"]:has-text("Enjoying it?")');
    await installBanner.waitFor({ state: "visible", timeout: 5_000 });
    console.log(
      "PASS (install banner logic; synthetic event): banner appears after a signed painting",
    );

    // Dismiss it -> settled flag should be remembered.
    await installBanner.locator("button:has-text('Dismiss')").click();
    await installBanner.waitFor({ state: "hidden", timeout: 5_000 });
    const settled = await page.evaluate(() => localStorage.getItem("installPromptSettled"));
    assert(settled === "1", "dismissing the install banner should set installPromptSettled");

    // Case C: sign again, reload, fire the event again -> banner must
    // stay suppressed (remembered dismissal).
    await markJustSigned(page);
    await page.reload({ waitUntil: "load" });
    await dispatchSyntheticBeforeInstallPrompt(page);
    await page.waitForTimeout(200);
    assert(
      (await bannerCount(page, "Enjoying it?")) === 0,
      "install banner logic (synthetic event): a dismissed banner reappeared",
    );
    console.log(
      "PASS (install banner logic; synthetic event): dismissal is remembered across reloads",
    );

    // Case D: appinstalled suppresses it too, even on a fresh (unsettled)
    // load that would otherwise show the banner.
    await clearAllStorage(page);
    await markJustSigned(page);
    await page.reload({ waitUntil: "load" });
    await dispatchAppInstalled(page);
    await dispatchSyntheticBeforeInstallPrompt(page);
    await page.waitForTimeout(200);
    assert(
      (await bannerCount(page, "Enjoying it?")) === 0,
      "install banner logic (synthetic event): appinstalled did not suppress the banner",
    );
    console.log(
      "PASS (install banner logic; synthetic event): appinstalled suppresses the banner",
    );

    await context.close();
  }

  // === Section 2: iOS install-jar hint logic (no WebKit available; ========
  // === navigator.standalone + an iOS UA are overridden/spoofed) ===========
  {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        value: true,
        configurable: true,
      });
    });
    const page = await context.newPage();

    // Fresh guest: no account, no draft, no completed paintings -> ALL
    // conditions met, hint should show.
    await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
    const hintBanner = page.locator('div[role="status"]:has-text("Painted in Safari")');
    await hintBanner.waitFor({ state: "visible", timeout: 5_000 });
    console.log(
      "PASS (iOS hint logic; navigator.standalone + UA overridden, not real iOS): " +
        "hint shows for a brand-new standalone guest",
    );

    // Dismiss -> remembered across reload.
    await hintBanner.locator("button:has-text('Dismiss')").click();
    await hintBanner.waitFor({ state: "hidden", timeout: 5_000 });
    const hintSettled = await page.evaluate(() =>
      localStorage.getItem("iosTransferHintSettled")
    );
    assert(hintSettled === "1", "dismissing the iOS hint should set iosTransferHintSettled");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(300);
    assert(
      (await bannerCount(page, "Painted in Safari")) === 0,
      "iOS hint logic: a dismissed hint reappeared after reload",
    );
    console.log("PASS (iOS hint logic): dismissal is remembered across reloads");

    // Reset, then violate one condition (an open draft) -> hint must be
    // hidden even though standalone+iOS still hold.
    await clearAllStorage(page);
    const draftRes = await page.request.put(`${baseUrl}/api/me/draft`, {
      data: { id: fakeUlid() },
      headers: { "content-type": "application/json" },
    });
    assert(draftRes.ok(), "failed to create a draft to violate the iOS hint condition");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(300);
    assert(
      (await bannerCount(page, "Painted in Safari")) === 0,
      "iOS hint logic: hint showed despite an existing draft (condition should have failed)",
    );
    console.log(
      "PASS (iOS hint logic): hint is hidden once any condition fails (an existing draft)",
    );

    await context.close();
  }

  // === Mutual exclusivity between the two banners =========================
  {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", {
        value: true,
        configurable: true,
      });
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
    // Fresh guest again (new context => new cookie => all iOS-hint
    // conditions hold) AND "just signed" -> on a standalone install, the
    // pre-install banner's own direct call is gated by `!isStandalone()`
    // and so must never fire, while the iOS hint (unconditional on
    // load) still does.
    await markJustSigned(page);
    await page.reload({ waitUntil: "load" });
    const hintBanner2 = page.locator('div[role="status"]:has-text("Painted in Safari")');
    await hintBanner2.waitFor({ state: "visible", timeout: 5_000 });
    assert(
      (await bannerCount(page, "Enjoying it?")) === 0 &&
        (await bannerCount(page, "Add Joy of Painting to your home screen")) === 0,
      "iOS hint logic: the pre-install banner also appeared on a standalone install " +
        "— the two should be mutually exclusive",
    );
    console.log(
      "PASS (iOS hint logic): mutually exclusive with the pre-install banner once standalone",
    );
    await context.close();
  }

  console.log("ALL PASS: pwa.js install-prompt and iOS-hint logic exercised via synthetic events.");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
