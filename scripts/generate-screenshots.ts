// Captures the two PWA install-dialog screenshots referenced from
// manifest.webmanifest (public/icons/screenshot-{narrow,wide}.png). Real
// captures only — if this can't run (no browser, no server), it must fail
// loudly rather than produce a placeholder; a fabricated screenshot is
// worse than an omitted `screenshots` key.
//
// Deliberately does NOT touch Turso: both captured routes ("/" and
// "/editor") are server-rendered by main.ts's page route, which never
// touches the database — only PAINTING_KEYS/GUEST_SESSION_SECRET are needed
// to sign the guest cookie. No ephemeral database is created here.

import { chromium } from "playwright-core";

const port = 8_331;
const baseUrl = `http://127.0.0.1:${port}`;

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

let server: Deno.ChildProcess | null = null;
let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

try {
  server = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/server/main.ts"],
    cwd: new URL("..", import.meta.url),
    env: {
      ...Deno.env.toObject(),
      PORT: String(port),
      PAINTING_KEYS: `screenshot:${randomKey()}`,
      GUEST_SESSION_SECRET: "screenshot-generation-guest-secret-32-bytes",
    },
    stdout: "null",
    stderr: "inherit",
  }).spawn();
  await waitForServer();

  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });

  const outDir = new URL("../public/icons/", import.meta.url);
  await Deno.mkdir(outDir, { recursive: true });

  // wide: the marketing landing page, desktop-ish viewport.
  {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.screenshot({
      path: new URL("screenshot-wide.png", outDir).pathname,
    });
    await context.close();
  }

  // narrow: the editor, the app's actual purpose, phone-ish viewport.
  {
    const context = await browser.newContext({
      viewport: { width: 720, height: 1280 },
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/editor`, { waitUntil: "networkidle" });
    await page.screenshot({
      path: new URL("screenshot-narrow.png", outDir).pathname,
    });
    await context.close();
  }

  console.log("wrote screenshot-wide.png and screenshot-narrow.png");
} finally {
  await browser?.close();
  server?.kill();
  await server?.status;
}
