import { assert, assertEquals } from "@std/assert";
import { chromium, type Page } from "playwright-core";
import { createDb, listActiveCanvases } from "../src/server/db.ts";
import { migrateDatabase } from "../src/server/migrations.ts";
import { createEphemeralDatabase } from "../tests/support/ephemeral-turso.ts";
import { LiveCanvasSimulator } from "../tests/support/live-canvas-simulator.ts";
import { seedCompletedFixtures } from "../tests/support/seed-completed-fixtures.ts";

const headed = Deno.args.includes("--headed");
const port = 8_321;
const baseUrl = `http://127.0.0.1:${port}`;
const runId = new Date().toISOString().replaceAll(":", "-").replace(".", "-");
const artifactDir = new URL(
  `../test-results/carousel/${runId}/`,
  import.meta.url,
);
await Deno.mkdir(artifactDir, { recursive: true });

console.log("Creating ephemeral Turso database for 24 live canvases...");
const ephemeral = await createEphemeralDatabase("carousel");
Deno.env.set("TURSO_DB_URL", ephemeral.url);
Deno.env.set("TURSO_DB_TOKEN", ephemeral.token);
const db = createDb();
let simulator: LiveCanvasSimulator | null = null;
let server: Deno.ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  await migrateDatabase(db);
  await seedCompletedFixtures(db, ephemeral.url, ephemeral.token);
  simulator = new LiveCanvasSimulator(db, ephemeral.url, ephemeral.token, {
    count: 24,
    strokeIntervalMs: 250,
  });
  await simulator.start();
  await waitForActiveCanvases(24);

  server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/server/main.ts"],
    cwd: new URL("..", import.meta.url),
    env: {
      ...Deno.env.toObject(),
      PORT: String(port),
      TURSO_DB_URL: ephemeral.url,
      TURSO_DB_TOKEN: ephemeral.token,
      GUEST_SESSION_SECRET: "carousel-e2e-guest-session-secret-32-bytes",
      PAINTING_E2E: "1",
    },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  await waitForServer();

  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    headless: !headed,
    args: ["--no-sandbox"],
  });
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 430, height: 932 },
  });
  for (const context of [desktop, mobile]) {
    await context.addInitScript(() => {
      // @ts-ignore test-only timing seam read before the module evaluates
      window.__PAINTING_TEST_CONFIG__ = {
        spawnIntervalMs: 100,
        travelDurationSeconds: 2,
        bootstrapCount: 2,
        completedResumeDelayMs: 1_500,
      };
    });
  }

  const cases = [
    { name: "landing-desktop", page: await desktop.newPage(), path: "/" },
    {
      name: "display-desktop",
      page: await desktop.newPage(),
      path: "/display",
    },
    { name: "landing-mobile", page: await mobile.newPage(), path: "/" },
    { name: "display-mobile", page: await mobile.newPage(), path: "/display" },
  ];
  const requests = new Map<Page, string[]>();
  for (const testCase of cases) {
    console.log(`Opening ${testCase.name}...`);
    requests.set(testCase.page, []);
    testCase.page.on(
      "pageerror",
      (error) => console.error(`${testCase.name} page error:`, error),
    );
    testCase.page.on("console", (message) => {
      if (message.type() === "error") {
        console.error(`${testCase.name} console:`, message.text());
      }
    });
    testCase.page.on(
      "request",
      (request) => requests.get(testCase.page)!.push(request.url()),
    );
    await testCase.page.route("**/api/live-stream", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await testCase.page.goto(`${baseUrl}${testCase.path}`, {
      waitUntil: "domcontentloaded",
    });
    await testCase.page.waitForFunction(() =>
      (document.querySelector("painting-parade")?.shadowRoot?.querySelectorAll(
        'figure[data-kind="placeholder"]',
      ).length ?? 0) >= 3
    );
    const initialFlow = await testCase.page.evaluate(() =>
      [
        ...document.querySelector("painting-parade")!.shadowRoot!
          .querySelectorAll("figure"),
      ].slice(0, 3).map((figure) => ({
        kind: /** @type {HTMLElement} */ (figure).dataset.kind,
        row: /** @type {HTMLElement} */ (figure).dataset.row,
        left: figure.getBoundingClientRect().left,
      }))
    );
    assertEquals(
      initialFlow.map((entry) => entry.kind),
      ["placeholder", "placeholder", "placeholder"],
    );
    assertEquals(
      initialFlow.map((entry) => entry.row),
      ["top", "bottom", "top"],
    );
    assert(
      initialFlow[0].left > initialFlow[1].left + 10,
      `${testCase.name}: first two loading cards should be time-staggered`,
    );
    await testCase.page.screenshot({
      path: new URL(`${testCase.name}-loading.png`, artifactDir).pathname,
      fullPage: true,
    });
    await testCase.page.waitForFunction(
      () =>
        (document.querySelector("painting-parade")?.shadowRoot
          ?.querySelectorAll(
            'figure:not([data-kind="placeholder"])',
          ).length ?? 0) >= 2,
      undefined,
      { timeout: 60_000 },
    );
    const bootstrapInside = await testCase.page.evaluate(() => {
      const parade = document.querySelector("painting-parade")!;
      const figures = [
        ...parade.shadowRoot!.querySelectorAll("figure"),
      ];
      return figures.slice(0, 2).every((figure) => {
        const bounds = figure.getBoundingClientRect();
        return bounds.left >= -1 && bounds.right <= innerWidth + 1;
      });
    });
    assert(
      bootstrapInside,
      `${testCase.name}: bootstrap cards should begin fully in view`,
    );
    await testCase.page.screenshot({
      path: new URL(`${testCase.name}-live.png`, artifactDir).pathname,
      fullPage: true,
    });
    if (testCase.name === "landing-mobile") {
      assert(
        await testCase.page.evaluate(() => {
          const hero = document.querySelector(".hero")!.getBoundingClientRect();
          const figures = [
            ...document.querySelector("painting-parade")!.shadowRoot!
              .querySelectorAll("figure"),
          ];
          return figures.every((figure) => {
            const card = figure.getBoundingClientRect();
            return card.bottom <= hero.top || card.top >= hero.bottom;
          });
        }),
        "landing-mobile: painting rows should not sit behind the hero",
      );
    }
  }

  await Promise.all([
    recordVideo(cases[0].page, "landing-carousel-live"),
    recordVideo(cases[1].page, "display-carousel-live"),
  ]);

  for (const testCase of cases) {
    await testCase.page.waitForFunction(() =>
      // @ts-ignore test diagnostic
      (window.__PAINTING_PARADE_EVENTS__?.length ?? 0) >= 25
    );
    const events = await testCase.page.evaluate(() =>
      // @ts-ignore test diagnostic
      window.__PAINTING_PARADE_EVENTS__
    );
    assertEquals(
      new Set(events.slice(0, 24).map((event: { id: string }) => event.id))
        .size,
      24,
    );
    assert(
      events.slice(0, 25).every((event: { kind: string }) =>
        event.kind === "active"
      ),
      `${testCase.name}: completed painting appeared while live work remained: ${
        JSON.stringify(events.slice(0, 25))
      }`,
    );
    const pageRequests = requests.get(testCase.page)!;
    assertEquals(
      pageRequests.filter((url) => url.endsWith("/api/live-stream")).length,
      1,
    );
    assertEquals(
      pageRequests.filter((url) => /\/canvases\/[^/]+\/stream/.test(url))
        .length,
      0,
    );
    assertEquals(
      pageRequests.filter((url) => url.includes("/replay")).length,
      0,
    );
    const rows = await testCase.page.evaluate(() =>
      new Set(
        [
          ...document.querySelector("painting-parade")!.shadowRoot!
            .querySelectorAll("figure"),
        ]
          .map((figure) => /** @type {HTMLElement} */ (figure).dataset.row),
      ).size
    );
    assertEquals(rows, 2);
  }

  const beforeSequence = await sequenceTotal(cases[0].page);
  await cases[0].page.waitForTimeout(1_000);
  assert(
    await sequenceTotal(cases[0].page) > beforeSequence,
    "live diffs should advance without opening another stream",
  );

  const signedId = simulator.canvasIds[0];
  await simulator.sign(0);
  await cases[0].page.waitForFunction(
    (id) => {
      const state = (document.querySelector("painting-parade") as any).state;
      return state.active.size === 23 && !state.active.has(id) &&
        state.signedFirst.includes(id);
    },
    signedId,
  );
  const afterRemoval = await spawnedEvents(cases[0].page);
  await cases[0].page.waitForFunction(
    (count) =>
      // @ts-ignore test diagnostic
      window.__PAINTING_PARADE_EVENTS__.length >= count + 3,
    afterRemoval.length,
  );
  const afterSingleSign = await spawnedEvents(cases[0].page);
  const postSignEvents = afterSingleSign.slice(afterRemoval.length);
  assert(
    postSignEvents.every((event) =>
      event.kind === "active" && event.id !== signedId
    ),
    "signed canvas should wait while the other 23 live canvases continue",
  );
  const kindsWithLiveRemaining = await spawnedKinds(cases[0].page);
  assertEquals(kindsWithLiveRemaining.at(-1), "active");

  simulator.stop();
  const reconnectCanvasId = simulator.canvasIds[1];
  const sequenceBeforeDisconnect = await cases[0].page.evaluate(
    (id) =>
      (document.querySelector("painting-parade") as any).liveSequences.get(id),
    reconnectCanvasId,
  );
  const streamCountBefore = requests.get(cases[0].page)!.filter((url) =>
    url.endsWith("/api/live-stream")
  ).length;
  await cases[0].page.evaluate(() => {
    const parade = document.querySelector("painting-parade")! as any;
    parade.source.close();
  });
  await simulator.stroke(1);
  await cases[0].page.waitForTimeout(1_200);
  await cases[0].page.evaluate(() =>
    (document.querySelector("painting-parade") as any).connect()
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    const streamCount = requests.get(cases[0].page)!.filter((url) =>
      url.endsWith("/api/live-stream")
    ).length;
    if (streamCount > streamCountBefore) {
      break;
    }
    if (attempt === 99) {
      throw new Error("multiplexed stream did not reconnect");
    }
    await cases[0].page.waitForTimeout(100);
  }
  const databaseHead = await db.execute({
    sql: "SELECT max(sequence) AS head FROM canvas_events WHERE canvas_id = ?",
    args: [reconnectCanvasId],
  });
  const expectedHead = Number(databaseHead.rows[0].head);
  await cases[0].page.waitForFunction(
    ({ id, head }) =>
      (document.querySelector("painting-parade") as any).liveSequences.get(
        id,
      ) ===
        head,
    { id: reconnectCanvasId, head: expectedHead },
  );
  const repairedSequence = await cases[0].page.evaluate(
    (id) =>
      (document.querySelector("painting-parade") as any).liveSequences.get(id),
    reconnectCanvasId,
  );
  assert(
    repairedSequence > sequenceBeforeDisconnect,
    "reconnect sync should repair a stroke received while disconnected",
  );
  await cases[0].page.waitForTimeout(500);
  assertEquals(
    await cases[0].page.evaluate(
      (id) =>
        (document.querySelector("painting-parade") as any).liveSequences.get(
          id,
        ),
      reconnectCanvasId,
    ),
    repairedSequence,
    "the repaired stroke should not be applied twice",
  );

  const savedCursor = await cases[0].page.evaluate(() =>
    (document.querySelector("painting-parade") as any).state.completedCursor
  );
  assert(savedCursor, "completed pagination should hold a saved cursor");
  simulator.stop();
  const signedResponse = await fetch(`${baseUrl}/dev/api/e2e/sign-simulated`, {
    method: "POST",
  });
  assert(signedResponse.ok, "test server should sign every simulated canvas");
  assertEquals((await signedResponse.json()).signed, 24);
  await cases[0].page.waitForFunction(
    () =>
      // @ts-ignore test diagnostic
      window.__PAINTING_PARADE_EVENTS__?.some((event) =>
        event.kind === "completed"
      ),
    undefined,
    { timeout: 20_000 },
  );
  const firstCompleted = (await spawnedEvents(cases[0].page)).find((event) =>
    event.kind === "completed"
  );
  assert(
    firstCompleted && simulator.canvasIds.includes(firstCompleted.id),
    "a newly signed painting should lead the resumed completed queue",
  );
  assertEquals(
    await cases[0].page.evaluate(() =>
      (document.querySelector("painting-parade") as any).state.completedCursor
    ),
    savedCursor,
  );
  await cases[0].page.evaluate(async () => {
    const parade = document.querySelector("painting-parade") as any;
    parade.state.signedFirst = [];
    parade.state.unseenCompleted = [];
    await parade.fetchCompletedPage();
  });
  assert(
    requests.get(cases[0].page)!.some((url) =>
      url.includes(
        `/api/completed-feed?limit=20&cursor=${
          encodeURIComponent(savedCursor)
        }`,
      )
    ),
    "completed pagination should resume with its saved cursor",
  );
  await cases[0].page.screenshot({
    path: new URL("landing-completed-resume.png", artifactDir).pathname,
    fullPage: true,
  });

  console.log(`Carousel E2E passed. Artifacts: ${artifactDir.pathname}`);
} finally {
  simulator?.stop();
  await browser?.close().catch(() => {});
  if (server) {
    try {
      server.kill("SIGTERM");
    } catch { /* already exited */ }
    await server.status.catch(() => {});
  }
  await simulator?.cleanup().catch(() => {});
  console.log(`Deleting ephemeral database: ${ephemeral.name}`);
  await ephemeral.remove();
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      if ((await fetch(baseUrl)).ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not start");
}

async function waitForActiveCanvases(expected: number): Promise<void> {
  let stableReads = 0;
  for (let attempt = 0; attempt < 80; attempt++) {
    const count = (await listActiveCanvases(db)).length;
    stableReads = count === expected ? stableReads + 1 : 0;
    if (stableReads >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `ephemeral database never exposed ${expected} active canvases`,
  );
}

async function sequenceTotal(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const parade = document.querySelector("painting-parade")! as any;
    return [...parade.liveSequences.values()].reduce(
      (sum, value) => sum + value,
      0,
    );
  });
}

async function spawnedKinds(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    // @ts-ignore test diagnostic
    window.__PAINTING_PARADE_EVENTS__.map((event) => event.kind)
  );
}

async function spawnedEvents(
  page: Page,
): Promise<Array<{ id: string; kind: string; row: string }>> {
  return await page.evaluate(() =>
    // @ts-ignore test diagnostic
    window.__PAINTING_PARADE_EVENTS__.map((event) => ({ ...event }))
  );
}

async function recordVideo(page: Page, name: string): Promise<void> {
  const frames = new URL(`${name}-frames/`, artifactDir);
  await Deno.mkdir(frames, { recursive: true });
  for (let index = 0; index < 20; index++) {
    await page.screenshot({
      path:
        new URL(`frame-${String(index).padStart(3, "0")}.png`, frames).pathname,
    });
    await page.waitForTimeout(70);
  }
  const output = new URL(`${name}.mp4`, artifactDir).pathname;
  const command = new Deno.Command("ffmpeg", {
    args: [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      "10",
      "-i",
      new URL("frame-%03d.png", frames).pathname,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      output,
    ],
  });
  const result = await command.output();
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
}
