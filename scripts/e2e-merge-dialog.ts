// End-to-end coverage for resolveSignInMerge()'s four-case decision table
// (src/server/main.ts) — the ONE thing that previously had no isolated
// automated test, because reaching the branch selection needs a genuine
// signed WebAuthn assertion (see e2e-passkey.ts). This reuses that exact
// mechanism: a CDP virtual authenticator gives us a real
// navigator.credentials.create()/get() ceremony, and the SAME
// browser-context trick e2e-passkey.ts uses (clear cookies+localStorage
// on one page rather than opening a second context) simulates "a
// different device" signing back in while keeping the resident
// credential available on the same virtual authenticator.
//
// Device draft state is set up with a DIRECT API push as the guest (PUT
// /api/me/draft), not through the editor UI — see the brief this script
// was written against: driving the real editor UI is preferred but a
// direct API push as the guest is acceptable when the UI would just slow
// the run down for no extra coverage of the merge logic itself, which is
// what this script exists to test. Every ceremony that matters (register,
// sign in) still goes through the real browser/WebAuthn path.
//
// Modeled on scripts/e2e-passkey.ts's server-spawning / ephemeral-Turso
// shape.

import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import { createDb, getGuestDraft } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_353;
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

/** A crude 26-char Crockford-base32-ish id, valid against the server's ULID regex. */
function fakeUlid(): string {
  const chars = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Creates an open draft for whichever guest cookie `page` currently carries. */
async function createDraftAsCurrentGuest(page: Page): Promise<string> {
  const id = fakeUlid();
  const res = await page.request.put(`${baseUrl}/api/me/draft`, {
    data: { id },
    headers: { "content-type": "application/json" },
  });
  if (!res.ok()) {
    throw new Error(
      `failed to create draft: ${res.status()} ${await res.text()}`,
    );
  }
  const body = await res.json();
  return body.draft.id as string;
}

async function currentMe(page: Page): Promise<{ handle: string | null; isAccount: boolean }> {
  const res = await page.request.get(`${baseUrl}/api/me`);
  if (!res.ok()) throw new Error(`GET /api/me -> ${res.status()}`);
  return await res.json();
}

async function guestCookieValue(context: BrowserContext): Promise<string | undefined> {
  const cookie = (await context.cookies()).find((c) => c.name === "painting_guest");
  return cookie?.value;
}

/** Registers a fresh passkey as whichever guest the page currently is. Returns the account profile id. */
async function registerAsCurrentGuest(
  page: Page,
  cdp: CDPSession,
): Promise<void> {
  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
  const upgradeButton = page.locator(
    "#account-panel button:has-text('Create an account')",
  );
  await upgradeButton.waitFor({ state: "visible", timeout: 10_000 });
  await upgradeButton.click();
  const handleText = page.locator("#account-panel h2:has-text('Your account')");
  await handleText.waitFor({ state: "visible", timeout: 15_000 });
  void cdp; // authenticator already attached before this is called
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
  const signInButton = page.locator(
    "#account-panel button:has-text('Sign in with a passkey')",
  );
  await signInButton.waitFor({ state: "visible", timeout: 10_000 });
  await signInButton.click();
}

async function mergeDialogIsOpen(page: Page): Promise<boolean> {
  return (await page.locator("#merge-dialog[open]").count()) > 0;
}

async function assertNoDialogAndSignedIn(page: Page, label: string): Promise<void> {
  const handleText = page.locator("#account-panel h2:has-text('Your account')");
  await handleText.waitFor({ state: "visible", timeout: 15_000 });
  if (await mergeDialogIsOpen(page)) {
    throw new Error(`${label}: merge dialog appeared but should have been silent`);
  }
  console.log(`PASS (${label}): silent row, no merge dialog`);
}

async function newAuthenticatedPage(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
): Promise<{ context: BrowserContext; page: Page; cdp: CDPSession; authenticatorId: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { context, page, cdp, authenticatorId };
}

/**
 * Clears cookies + localStorage on `page`'s context, simulating "device
 * lost its session" while the resident credential stays on the same
 * virtual authenticator, then navigates so the server mints a brand new
 * guest cookie (a page GET is the only route that creates one — see
 * guestSession()'s `create` flag) before any direct API push as that
 * fresh guest.
 */
async function becomeFreshDevice(page: Page, context: BrowserContext): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await context.clearCookies();
  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });
}

console.log("Creating ephemeral Turso database for the merge-dialog e2e run...");
const ephemeral = await createEphemeralDatabase("merge-dialog");
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
      GUEST_SESSION_SECRET: "merge-dialog-e2e-guest-session-secret-32-bytes",
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

  async function snapshotCanvases(): Promise<unknown> {
    const res = await db.execute(
      "SELECT id, owner_id, completed_at FROM canvases ORDER BY id",
    );
    return res.rows.map((row) => ({ ...row }));
  }

  // --- Row 1: account draft none, device draft none -> silent, no dialog ---
  {
    const { context, page, cdp, authenticatorId } = await newAuthenticatedPage(browser);
    await registerAsCurrentGuest(page, cdp);
    // No account draft created. Become a fresh device with no draft either.
    await becomeFreshDevice(page, context);
    await signIn(page);
    await assertNoDialogAndSignedIn(page, "row 1 (none/none)");
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }

  // --- Row 2: account draft none, device draft yes -> silent, device draft re-owned ---
  {
    const { context, page, cdp, authenticatorId } = await newAuthenticatedPage(browser);
    await registerAsCurrentGuest(page, cdp);
    const registeredHandle = (await currentMe(page)).handle;
    if (!registeredHandle) throw new Error("row 2: registration produced no handle");
    const accountRows2 = await db.execute({
      sql: "SELECT id FROM profiles WHERE handle = ?",
      args: [registeredHandle],
    });
    const accountId = String(accountRows2.rows[0].id);

    await becomeFreshDevice(page, context);
    const deviceDraftId = await createDraftAsCurrentGuest(page);

    await signIn(page);
    await assertNoDialogAndSignedIn(page, "row 2 (none/yes)");

    const reowned = await getGuestDraft(db, accountId);
    if (!reowned || reowned.id !== deviceDraftId) {
      throw new Error(
        `row 2: expected device draft ${deviceDraftId} to be re-owned by account ${accountId}, ` +
          `found ${reowned?.id ?? "none"}`,
      );
    }
    console.log(`PASS (row 2): device draft ${deviceDraftId} re-owned by account`);
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }

  // --- Row 3: account draft yes, device draft none -> silent, account draft loads ---
  let row3AccountId = "";
  let row3AccountDraftId = "";
  {
    const { context, page, cdp, authenticatorId } = await newAuthenticatedPage(browser);
    await registerAsCurrentGuest(page, cdp);
    // Still signed in as the account (registration upgrades the current
    // guest's own profile in place — see resolveSignInMerge()'s doc
    // comment) — create the account's draft BEFORE losing the session.
    const registeredHandle3 = (await currentMe(page)).handle;
    if (!registeredHandle3) throw new Error("row 3: registration produced no handle");
    row3AccountDraftId = await createDraftAsCurrentGuest(page);
    const accountRow = await db.execute({
      sql: "SELECT id FROM profiles WHERE handle = ?",
      args: [registeredHandle3],
    });
    row3AccountId = String(accountRow.rows[0].id);

    await becomeFreshDevice(page, context);
    // No device draft created.

    await signIn(page);
    await assertNoDialogAndSignedIn(page, "row 3 (yes/none)");

    const stillThere = await getGuestDraft(db, row3AccountId);
    if (!stillThere || stillThere.id !== row3AccountDraftId) {
      throw new Error(
        `row 3: expected account draft ${row3AccountDraftId} to remain, found ${
          stillThere?.id ?? "none"
        }`,
      );
    }
    console.log(`PASS (row 3): account draft ${row3AccountDraftId} loaded, unchanged`);
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }

  // --- Row 4: account draft yes, device draft yes -> merge DIALOG ---------
  //
  // Also exercises: backing out (no cookie change, no DB change, still the
  // original guest), and then the follow-up claim that signing the
  // device's draft and signing in again takes the silent row.
  {
    const { context, page, cdp, authenticatorId } = await newAuthenticatedPage(browser);
    await registerAsCurrentGuest(page, cdp);
    const registeredHandle4 = (await currentMe(page)).handle;
    if (!registeredHandle4) throw new Error("row 4: registration produced no handle");
    const accountDraftId = await createDraftAsCurrentGuest(page);
    const accountRow = await db.execute({
      sql: "SELECT id FROM profiles WHERE handle = ?",
      args: [registeredHandle4],
    });
    const accountId = String(accountRow.rows[0].id);

    await becomeFreshDevice(page, context);
    const preBackOutCookie = await guestCookieValue(context);
    const deviceDraftId = await createDraftAsCurrentGuest(page);
    const meBeforeBackOut = await currentMe(page);

    const preBackOutSnapshot = JSON.stringify(await snapshotCanvases());

    await signIn(page);
    try {
      await page.locator("#merge-dialog[open]").waitFor({
        state: "visible",
        timeout: 15_000,
      });
    } catch {
      throw new Error("row 4: merge dialog did not appear for two conflicting drafts");
    }
    console.log("PASS (row 4): merge dialog appeared for conflicting drafts");

    // --- Back out ---------------------------------------------------------
    const backOutButton = page.locator("#merge-back-out");
    await backOutButton.click();
    await page.locator("#merge-dialog[open]").waitFor({ state: "hidden", timeout: 5_000 });

    const postBackOutCookie = await guestCookieValue(context);
    if (postBackOutCookie !== preBackOutCookie) {
      throw new Error("row 4: backing out changed the session cookie, but it must not");
    }
    const postBackOutSnapshot = JSON.stringify(await snapshotCanvases());
    if (postBackOutSnapshot !== preBackOutSnapshot) {
      throw new Error("row 4: backing out changed the database, but it must not");
    }
    const meAfterBackOut = await currentMe(page);
    if (meAfterBackOut.isAccount || meAfterBackOut.handle !== meBeforeBackOut.handle) {
      throw new Error(
        "row 4: backing out should leave the device as its original guest profile",
      );
    }
    console.log(
      "PASS (row 4 back-out): cookie unchanged, database unchanged, still original guest",
    );

    // --- Sign the device's draft, then sign in again: should now be silent ---
    const signRes = await page.request.post(
      `${baseUrl}/canvases/${deviceDraftId}/complete`,
      {
        data: { title: "Row4" },
        headers: { "content-type": "application/json" },
      },
    );
    if (!signRes.ok()) {
      throw new Error(
        `row 4: failed to sign device draft: ${signRes.status()} ${await signRes.text()}`,
      );
    }

    await signIn(page);
    await assertNoDialogAndSignedIn(page, "row 4 (after signing device draft)");

    const finalAccountDraft = await getGuestDraft(db, accountId);
    if (!finalAccountDraft || finalAccountDraft.id !== accountDraftId) {
      throw new Error(
        "row 4: account's own draft should still be the open one after the silent re-sign-in",
      );
    }
    const completedRow = await db.execute({
      sql: "SELECT owner_id, completed_at FROM canvases WHERE id = ?",
      args: [deviceDraftId],
    });
    if (completedRow.rows.length !== 1) {
      throw new Error("row 4: signed device canvas disappeared");
    }
    if (String(completedRow.rows[0].owner_id) !== accountId) {
      throw new Error(
        "row 4: signed device painting should have been re-owned to the account silently",
      );
    }
    if (completedRow.rows[0].completed_at === null) {
      throw new Error("row 4: signed device painting lost its completed_at");
    }
    console.log(
      "PASS (row 4 follow-up): after signing the device draft, re-sign-in took the silent " +
        "row and re-owned the completed painting",
    );

    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    await context.close();
  }

  console.log("ALL PASS: all four resolveSignInMerge() rows exercised end-to-end.");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
