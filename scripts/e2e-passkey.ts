// End-to-end passkey registration test, driven through a REAL Chromium
// instance via Playwright's CDP WebAuthn virtual authenticator — this is
// the only way to exercise the actual navigator.credentials.create() path
// (options -> browser ceremony -> verify) rather than just unit-testing
// the server logic around it.
//
// Modeled on scripts/carousel-e2e.ts (server spawning, ephemeral Turso
// database) and scripts/generate-screenshots.ts (Playwright + Chromium
// launch shape). Needs a real database — registering a passkey writes to
// `profiles`/`credentials` — so, unlike generate-screenshots.ts, this
// script DOES need Turso credentials (TURSO_API_KEY/TURSO_ORG_SLUG, to
// mint the ephemeral database) and cannot run credential-free.

import { chromium } from "playwright-core";
import { createDb, getProfile, listCredentials } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";

const port = 8_351;
// RP ID "localhost" is only valid for requests whose host is literally
// "localhost" — 127.0.0.1 would not match, so both the browser navigation
// and WEBAUTHN_ORIGINS below must agree on this exact host.
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

console.log("Creating ephemeral Turso database for the passkey e2e run...");
const ephemeral = await createEphemeralDatabase("passkey");
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
      GUEST_SESSION_SECRET: "passkey-e2e-guest-session-secret-32-bytes",
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

  // Enable the CDP WebAuthn domain and attach a virtual, discoverable,
  // user-verifying authenticator BEFORE any WebAuthn ceremony runs.
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

  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });

  const upgradeButton = page.locator(
    "#account-panel button:has-text('Create an account')",
  );
  await upgradeButton.waitFor({ state: "visible", timeout: 10_000 });
  await upgradeButton.click();

  const handleText = page.locator("#account-panel h2:has-text('Your account')");
  await handleText.waitFor({ state: "visible", timeout: 15_000 });

  const credentialRow = page.locator("#account-panel .credential-row");
  const credentialCount = await credentialRow.count();
  if (credentialCount !== 1) {
    throw new Error(
      `expected exactly one credential row after registration, got ${credentialCount}`,
    );
  }

  // Confirm server-side state directly, not just the DOM.
  const guestCookie = (await context.cookies())
    .find((cookie) => cookie.name === "painting_guest");
  if (!guestCookie) throw new Error("no guest cookie after registering");
  // The guest cookie doesn't expose the profile id to us either — the
  // point of this whole design — so instead confirm indirectly: exactly
  // one profile in the ephemeral db should now be upgraded, with exactly
  // one credential.
  const profilesRes = await db.execute(
    "SELECT id FROM profiles WHERE upgraded_at IS NOT NULL",
  );
  if (profilesRes.rows.length !== 1) {
    throw new Error(
      `expected exactly one upgraded profile, found ${profilesRes.rows.length}`,
    );
  }
  const profileId = String(profilesRes.rows[0].id);
  const profile = await getProfile(db, profileId);
  const credentials = await listCredentials(db, profileId);
  if (!profile?.handle) throw new Error("upgraded profile has no handle");
  if (credentials.length !== 1) {
    throw new Error(
      `expected exactly one credential row, got ${credentials.length}`,
    );
  }
  console.log(
    `PASS: registered passkey for profile with handle "${profile.handle}", ` +
      `credential backed_up=${credentials[0].backedUp} backup_eligible=${
        credentials[0].backupEligible
      }`,
  );

  // --- Phase 4: sign in as the SAME profile from a "fresh" session -------
  //
  // Clearing cookies and navigating fresh simulates the device losing its
  // session (a cleared cookie jar, a different browser profile, ...) while
  // the passkey itself persists on the (virtual) authenticator — resident
  // credentials are how sign-in finds it again with no username anywhere.
  // Also clear localStorage — collection-page.js persists the "upgrade
  // nudge dismissed" flag there (see UPGRADE_NUDGE_DISMISSED_KEY), and
  // registering above sets it. clearCookies() alone would leave it
  // behind, hiding the guest nudge (and therefore the sign-in button)
  // even after the session cookie is gone.
  await page.evaluate(() => localStorage.clear());
  await context.clearCookies();
  await page.goto(`${baseUrl}/collection`, { waitUntil: "load" });

  const signInButton = page.locator(
    "#account-panel button:has-text('Sign in with a passkey')",
  );
  await signInButton.waitFor({ state: "visible", timeout: 10_000 });
  await signInButton.click();

  // This fresh session had no draft of its own and the account already
  // had none either — the table's first (silent) row — so the account
  // view should appear directly, with NO merge dialog.
  const signedInHandleText = page.locator(
    "#account-panel h2:has-text('Your account')",
  );
  await signedInHandleText.waitFor({ state: "visible", timeout: 15_000 });
  const mergeDialogVisible = await page.locator("#merge-dialog[open]").count();
  if (mergeDialogVisible !== 0) {
    throw new Error(
      "merge dialog appeared for a sign-in with no conflicting drafts",
    );
  }

  const stillOneUpgradedProfile = await db.execute(
    "SELECT id FROM profiles WHERE upgraded_at IS NOT NULL",
  );
  if (stillOneUpgradedProfile.rows.length !== 1) {
    throw new Error(
      `expected sign-in to reuse the SAME profile, found ${stillOneUpgradedProfile.rows.length} upgraded profiles`,
    );
  }
  if (String(stillOneUpgradedProfile.rows[0].id) !== profileId) {
    throw new Error("sign-in landed on a different profile than registration created");
  }

  const signInCookie = (await context.cookies())
    .find((cookie) => cookie.name === "painting_guest");
  if (!signInCookie) throw new Error("no guest cookie after signing in");
  if (signInCookie.value === guestCookie.value) {
    throw new Error(
      "cookie did not change after sign-in — still the pre-sign-in guest session",
    );
  }

  console.log(
    `PASS: signed back in as the same profile (handle "${profile.handle}") ` +
      "after clearing the session cookie",
  );

  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  await context.close();
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
  console.log("Deleting ephemeral database...");
  await ephemeral.remove();
}
