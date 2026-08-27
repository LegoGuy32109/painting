// End-to-end regression test for completed-painting replay, run under both
// prefers-reduced-motion settings.
//
// Two behaviours are pinned here, and they were separate bugs:
//
//  1. The replay clock used to be read off the card's CSS travel animation
//     (`figure.getAnimations()[0]?.currentTime`). Wherever that animation did
//     not exist, `elapsed` stayed pinned at zero and every completed painting
//     froze on its first frame — reported from a real iPhone as cards showing
//     one or two strokes forever. Playback is now wall-clock, so the replay
//     advances whether or not the card is moving.
//
//  2. The component used to set `animation:none` on the figures under
//     `prefers-reduced-motion: reduce`, which pinned the whole gallery into a
//     static grid. That override is deliberately gone: the drifting gallery
//     is the page, so cards slide on every setting. This test asserts travel
//     is present under BOTH settings so that rule cannot quietly return.
//
// Playwright's `reducedMotion` context option sets the media feature for
// real, so the reported device condition is reproduced without a device.
// Only Chromium is available here; there is no WebKit to test Safari itself.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { chromium, type Page } from "playwright-core";
import { createDb } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";
import { seedCompletedFixtures } from "../tests/support/seed-completed-fixtures.ts";

const port = 8_358;
const baseUrl = `http://localhost:${port}`;
// Fast enough to keep the suite well under a second per sample gap while
// still giving drain() (ticking every 33ms) plenty of steps to apply
// between samples.
const completedReplayMs = 3_000;

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

interface CompletedFigureInfo {
  canvasId: string;
  animationCount: number;
  animationName: string;
}

/** Waits for at least one completed-kind figure and returns its identity
 * and travel-animation state, without assuming which slot index it lands
 * in (slot assignment order is not guaranteed). */
async function waitForCompletedFigure(
  page: Page,
): Promise<CompletedFigureInfo> {
  await page.waitForFunction(
    () =>
      [
        ...document.querySelector("painting-parade")!.shadowRoot!
          .querySelectorAll("figure"),
      ].some((figure) => (figure as HTMLElement).dataset.kind === "completed"),
    undefined,
    { timeout: 15_000 },
  );
  return await page.evaluate(() => {
    const figure = [
      ...document.querySelector("painting-parade")!.shadowRoot!
        .querySelectorAll("figure"),
    ].find((entry) => (entry as HTMLElement).dataset.kind === "completed")!;
    return {
      canvasId: (figure as HTMLElement).dataset.canvasId ?? "",
      animationCount: figure.getAnimations().length,
      animationName: getComputedStyle(figure).animationName,
    };
  });
}

/** Reads the completed card's canvas as a data URL, to diff pixel content
 * across two points in wall-clock time. */
async function canvasSnapshot(page: Page, canvasId: string): Promise<string> {
  return await page.evaluate((id) => {
    const figure = [
      ...document.querySelector("painting-parade")!.shadowRoot!
        .querySelectorAll("figure"),
    ].find((entry) => (entry as HTMLElement).dataset.canvasId === id)!;
    return figure.querySelector("canvas")!.toDataURL();
  }, canvasId);
}

async function waitForSigned(page: Page, canvasId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const figure = [
        ...document.querySelector("painting-parade")!.shadowRoot!
          .querySelectorAll("figure"),
      ].find((entry) => (entry as HTMLElement).dataset.canvasId === id);
      return figure?.querySelector(".replay")?.textContent === "SIGNED";
    },
    canvasId,
    { timeout: 20_000 },
  );
}

async function runScenario(
  page: Page,
  name: string,
  reducedMotion: "reduce" | "no-preference",
): Promise<void> {
  console.log(`Running scenario: ${name} (reducedMotion: ${reducedMotion})`);
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.bringToFront();
  assertEquals(
    await page.evaluate(() => document.visibilityState),
    "visible",
    `${name}: page must be genuinely visible, or drain() early-returns`,
  );
  await page.waitForFunction(
    () =>
      Number(
        (document.querySelector("painting-parade") as HTMLElement)?.dataset
          .slotCount,
      ) >= 2,
  );

  const info = await waitForCompletedFigure(page);
  assert(info.canvasId, `${name}: a completed figure should carry a canvas id`);

  // The parade deliberately does NOT honour prefers-reduced-motion for card
  // travel: the drifting gallery is the page, so cards must slide under both
  // settings. Asserting travel is present in BOTH scenarios is what pins
  // that decision down — the component previously set `animation:none` under
  // reduce, and silently regaining that rule would strand the gallery in a
  // static grid again.
  assert(
    info.animationCount > 0,
    `${name}: the travel animation must be present regardless of ` +
      "prefers-reduced-motion — cards are meant to slide on every setting",
  );
  assertNotEquals(
    info.animationName,
    "none",
    `${name}: computed animation-name must not be "none" under any motion setting`,
  );

  const before = await canvasSnapshot(page, info.canvasId);
  await page.waitForTimeout(Math.round(completedReplayMs * .4));
  const after = await canvasSnapshot(page, info.canvasId);
  assertNotEquals(
    before,
    after,
    `${name}: the completed card's rendered pixels should change over time ` +
      "— this is the actual regression guard for the frozen-replay bug",
  );

  await waitForSigned(page, info.canvasId);
  console.log(`PASS: ${name} reached SIGNED with a replay clock that advanced`);
}

console.log(
  "Creating ephemeral Turso database for the reduced-motion e2e run...",
);
const ephemeral = await createEphemeralDatabase("reduced-motion");
let server: Deno.ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  Deno.env.set("TURSO_DB_URL", ephemeral.url);
  Deno.env.set("TURSO_DB_TOKEN", ephemeral.token);
  const db = createDb();
  await migrateDatabase(db);
  // Only completed fixtures are needed: populateSlot() offers a completed
  // candidate only once state.active.size === 0, so this alone is enough
  // to reach the replay path without a LiveCanvasSimulator. minimumCount
  // 1 still seeds every fixture recording (7), which is plenty of variety
  // and far cheaper against a fresh cloud database than the default 21.
  await seedCompletedFixtures(db, ephemeral.url, ephemeral.token, 1);

  server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/server/main.ts"],
    cwd: new URL("..", import.meta.url),
    env: {
      ...Deno.env.toObject(),
      PORT: String(port),
      TURSO_DB_URL: ephemeral.url,
      TURSO_DB_TOKEN: ephemeral.token,
      GUEST_SESSION_SECRET: "reduced-motion-e2e-guest-session-secret-32b",
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

  const scenarios: Array<
    { name: string; reducedMotion: "reduce" | "no-preference" }
  > = [
    { name: "reduced-motion", reducedMotion: "reduce" },
    { name: "no-preference", reducedMotion: "no-preference" },
  ];

  for (const scenario of scenarios) {
    const context = await browser.newContext({
      viewport: { width: 1_440, height: 1_000 },
      reducedMotion: scenario.reducedMotion,
    });
    await context.addInitScript((testConfig) => {
      // @ts-ignore test-only timing seam read before the module evaluates
      window.__PAINTING_TEST_CONFIG__ = testConfig;
    }, { completedReplayMs });
    const page = await context.newPage();
    page.on(
      "pageerror",
      (error) => console.error(`${scenario.name} page error:`, error),
    );
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.error(`${scenario.name} console:`, message.text());
      }
    });
    try {
      await runScenario(page, scenario.name, scenario.reducedMotion);
    } finally {
      await context.close();
    }
  }

  console.log(
    "ALL PASS: completed replay advances under both motion preferences.",
  );
} finally {
  await browser?.close().catch(() => {});
  if (server) {
    try {
      server.kill("SIGTERM");
    } catch { /* already exited */ }
    await server.status.catch(() => {});
  }
  console.log(`Deleting ephemeral database: ${ephemeral.name}`);
  await ephemeral.remove();
}
