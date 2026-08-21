import {
  appendEvents,
  type CanvasEventRow,
  type CanvasRecord,
  type CanvasSummary,
  type Client,
  completeCanvas,
  createDb,
  deleteCompletedCanvas,
  deleteGuestDraft,
  ensureCanvas,
  eventAcknowledgments,
  getCanvasAccess,
  getCompletedCanvas,
  getGuestDraft,
  getOrCreateDraft,
  headSequence,
  listActiveCanvases,
  listGuestCompleted,
  listRandomCompleted,
  listRecentlyCompleted,
  type NewEvent,
  pullEventsSince,
  storeCanvasPixels,
} from "./db.ts";
import { createPixels } from "../shared/paint-engine.js";
import { decodeCells } from "../shared/cell-codec.js";
import { composeCanvas } from "../shared/compose.js";
import {
  assertGuestSessionConfigured,
  guestSession,
  withSessionCookie,
} from "./guest-session.ts";
import {
  assertCanvasId,
  assertSameOrigin,
  HttpError,
  readJsonBody,
  validateCompletion,
  validateEnsureDraft,
  validatePushEvents,
} from "./protocol.ts";
import { consumeGuestMutation } from "./rate-limit.ts";
import { buildCanvasReplay } from "./replay.ts";
import type {
  DisplayFeedResponse,
  EnsureDraftResponse,
  GuestCanvasesResponse,
  PublicCanvas,
  PushEventsResponse,
} from "../shared/paint-types.d.ts";

const publicFile = (path: string) =>
  new URL(`../../public/${path}`, import.meta.url);
const clientFile = (path: string) =>
  new URL(`../client/${path}`, import.meta.url);
const sharedFile = (path: string) =>
  new URL(`../shared/${path}`, import.meta.url);

function staticHeaders(contentType: string, immutable = false): HeadersInit {
  return {
    "content-type": contentType,
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "public, max-age=0, must-revalidate",
    "deno-cdn-cache-control": immutable
      ? "public, s-maxage=31536000"
      : "public, s-maxage=60",
  };
}

function htmlHeaders(): HeadersInit {
  return {
    "content-type": "text/html",
    "cache-control": "no-cache",
    "deno-cdn-cache-control": "public, s-maxage=60",
    "content-security-policy":
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

// Created lazily (not at module load) so importing this module — as
// tests/main_test.ts does — doesn't require TURSO_DB_URL/TURSO_DB_TOKEN or
// --allow-net/--allow-env unless a db-backed route is actually hit.
let db: Client | null = null;
function getDb(): Client {
  return db ??= createDb();
}

function getDbCreds(): { url: string; token: string } {
  const url = Deno.env.get("TURSO_DB_URL");
  const token = Deno.env.get("TURSO_DB_TOKEN");
  if (!url || !token) {
    throw new Error("TURSO_DB_URL and TURSO_DB_TOKEN must be set");
  }
  return { url, token };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function blankPixels(): Uint8Array {
  return new Uint8Array(createPixels().buffer);
}

// Live-view fan-out: one canvas can have several viewers, each holding open
// an SSE connection to THIS instance. broadcastEvents() is the same-instance
// fast path — free, and often the only path taken, since the new
// (non-Classic) Deno Deploy platform runs a small number of regions/
// instances. It is not sufficient alone: that platform has no
// BroadcastChannel or other cross-instance pub/sub (BroadcastChannel is
// Classic-only, sunsetting 2026-07-20), so a push landing on instance A
// never reaches a viewer's SSE connection held on instance B through
// broadcastEvents() alone. ensurePolling() below is the cross-instance
// backstop, using Turso itself — already the single source of truth for
// everything else here — as the coordination point instead of standing up a
// new pub/sub service.
const subscribers = new Map<string, Set<ReadableStreamDefaultController>>();

async function snapshotChunk(canvasId: string): Promise<Uint8Array> {
  const { events } = await pullEventsSince(getDb(), canvasId, 0);
  const pixels = composeCanvas(events as CanvasEventRow[]);
  const payload = JSON.stringify({
    type: "snapshot",
    pixels: bytesToBase64(new Uint8Array(pixels.buffer)),
  });
  return new TextEncoder().encode(`data: ${payload}\n\n`);
}

/**
 * A viewer needs to see cells land in the order they were actually painted,
 * not "the image looks different now" every few seconds — so the normal
 * case sends only the new cells, in order, as a real diff. Undo is the one
 * exception: it can retroactively exclude cells from anywhere earlier in
 * the whole history (that's the point of stroke_id exclusion over a
 * sequence-range rollback — see compose.ts), so there's no correct
 * incremental delta for it and a full recompose is required.
 *
 * Each row's own client_ts rides along as its batch's `ts`, unclamped: this
 * project enforces one writer per canvas (see the owner check in the events
 * POST handler below), so there's no cross-device clock skew to defend
 * against here, and the viewer's replay clock (see active.html) can trust
 * client_ts as the real recorded timing rather than the server's.
 */
function diffChunk(
  events: Array<{ kind: string; cells?: Uint8Array | null; clientTs: number }>,
): Uint8Array {
  const batches = events
    .filter((e) => e.kind === "stroke" && e.cells)
    .map((e) => ({
      ts: e.clientTs,
      cells: decodeCells(e.cells as Uint8Array),
    }));
  const payload = JSON.stringify({ type: "diff", batches });
  return new TextEncoder().encode(`data: ${payload}\n\n`);
}

async function broadcastEvents(
  canvasId: string,
  events: Array<{ kind: string; cells?: Uint8Array | null; clientTs: number }>,
): Promise<void> {
  const subs = subscribers.get(canvasId);
  if (!subs || subs.size === 0) return;
  const chunk = events.some((e) => e.kind === "undo")
    ? await snapshotChunk(canvasId)
    : diffChunk(events);
  for (const controller of subs) {
    try {
      controller.enqueue(chunk);
    } catch {
      subs.delete(controller);
    }
  }
}

const POLL_INTERVAL_MS = 200;
const pollIntervals = new Map<string, ReturnType<typeof setInterval>>();
const lastKnownSequence = new Map<string, number>();

/**
 * Starts polling Turso for this canvas's head sequence, only while this
 * instance has at least one local subscriber for it, and stops itself once
 * the last one disconnects. A cheap SELECT MAX(sequence) most ticks; only on
 * a tick where it moved does it pull the rows since the last known sequence
 * and forward them as a real diff — whether the change came from a push
 * this instance handled itself (already broadcast via broadcastEvents,
 * redundant here but harmless) or one a different instance handled.
 */
function ensurePolling(canvasId: string): void {
  if (pollIntervals.has(canvasId)) return;
  const interval = setInterval(async () => {
    const subs = subscribers.get(canvasId);
    if (!subs || subs.size === 0) {
      clearInterval(interval);
      pollIntervals.delete(canvasId);
      lastKnownSequence.delete(canvasId);
      return;
    }
    try {
      const head = await headSequence(getDb(), canvasId);
      const known = lastKnownSequence.get(canvasId);
      if (known === undefined) {
        // First tick for this canvas on this instance: the subscriber
        // already got a full snapshot at connect time, so just establish
        // the baseline rather than re-sending everything from scratch.
        lastKnownSequence.set(canvasId, head);
        return;
      }
      if (head !== known) {
        const { events } = await pullEventsSince(getDb(), canvasId, known);
        lastKnownSequence.set(canvasId, head);
        await broadcastEvents(canvasId, events);
      }
    } catch {
      // transient db error — try again next tick
    }
  }, POLL_INTERVAL_MS);
  pollIntervals.set(canvasId, interval);
}

// ensureCanvas is idempotent (INSERT OR IGNORE) but still costs a full round
// trip — wasted on every push after the first for a given canvas, right
// when pushes are happening most frequently (mid-stroke). Once this process
// has confirmed a canvas exists, skip re-asking Turso.
const ensuredCanvases = new Set<string>();
let displayFeedCache:
  | { expiresAt: number; response: DisplayFeedResponse }
  | null = null;

// Re-check ownership and completion for every mutation. Multiplayer painting
// isn't a goal here: only the signed guest profile that created a canvas may
// push events or complete it, and a completed canvas is immutable.
async function accessOfCanvas(canvasId: string) {
  return await getCanvasAccess(getDb(), canvasId);
}

async function withComposedPixels(
  canvases: CanvasSummary[],
): Promise<
  Array<Omit<CanvasSummary, "ownerId"> & { pixels: string }>
> {
  return Promise.all(canvases.map(async (canvas) => {
    const { events } = await pullEventsSince(getDb(), canvas.id, 0);
    const composed = composeCanvas(events as CanvasEventRow[]);
    const { ownerId: _ownerId, ...publicCanvas } = canvas;
    return {
      ...publicCanvas,
      pixels: bytesToBase64(new Uint8Array(composed.buffer)),
    };
  }));
}

function publicCanvas(canvas: CanvasRecord): PublicCanvas {
  return {
    id: canvas.id,
    title: canvas.title,
    pixels: bytesToBase64(canvas.pixels),
    createdAt: canvas.createdAt,
    lastStrokeAt: canvas.lastStrokeAt,
    completedAt: canvas.completedAt,
  };
}

async function publicDraft(canvas: CanvasRecord): Promise<PublicCanvas> {
  const { events } = await pullEventsSince(getDb(), canvas.id, 0);
  const pixels = composeCanvas(events);
  return {
    ...publicCanvas(canvas),
    pixels: bytesToBase64(new Uint8Array(pixels.buffer)),
  };
}

/**
 * Deno.serve is documented to catch a handler's thrown/rejected error and
 * respond 500 on its own — this wrapper exists anyway as an explicit,
 * un-bypassable backstop, since a single request hitting a real db error
 * (a conflict-retry exhaustion, a malformed pipeline response) should never
 * have a path to crashing the whole process regardless of the exact
 * mechanism.
 */
export async function handler(req: Request): Promise<Response> {
  try {
    const response = await route(req);
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "same-origin");
    headers.set("x-frame-options", "DENY");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (err) {
    if (err instanceof HttpError) {
      return new Response(err.message, { status: err.status });
    }
    console.error(
      "unhandled error handling request:",
      req.method,
      req.url,
      err,
    );
    return new Response("internal error", { status: 500 });
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);

  const page = new Map([
    ["/", "index.html"],
    ["/editor", "editor.html"],
    ["/editor.html", "editor.html"],
    ["/display", "display.html"],
    ["/display.html", "display.html"],
    ["/collection", "collection.html"],
    ["/collection.html", "collection.html"],
  ]).get(url.pathname);
  if (page && req.method === "GET") {
    const html = await Deno.readTextFile(publicFile(page));
    const session = await guestSession(req, true);
    return withSessionCookie(
      new Response(html, { headers: htmlHeaders() }),
      session as NonNullable<typeof session>,
    );
  }

  if (url.pathname === "/api/me/canvases" && req.method === "GET") {
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    const [draft, completed] = await Promise.all([
      getGuestDraft(getDb(), session.guestId),
      listGuestCompleted(getDb(), session.guestId),
    ]);
    const response: GuestCanvasesResponse = {
      draft: draft ? await publicDraft(draft) : null,
      completed: completed.map(publicCanvas),
    };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (url.pathname === "/api/me/draft" && req.method === "PUT") {
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    const body = validateEnsureDraft(await readJsonBody(req));
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const draft = await getOrCreateDraft(
      getDb(),
      body.id,
      session.guestId,
      blankPixels(),
      Date.now(),
    );
    ensuredCanvases.add(draft.id);
    const response: EnsureDraftResponse = {
      draft: await publicDraft(draft),
      acceptedPreferredId: draft.id === body.id,
    };
    return Response.json(response);
  }

  if (url.pathname === "/api/me/draft" && req.method === "DELETE") {
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    await deleteGuestDraft(getDb(), session.guestId);
    return new Response(null, { status: 204 });
  }

  const ownedCanvasMatch = url.pathname.match(
    /^\/api\/me\/canvases\/([^/]+)$/,
  );
  if (ownedCanvasMatch && req.method === "DELETE") {
    const canvasId = ownedCanvasMatch[1];
    assertCanvasId(canvasId);
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const deleted = await deleteCompletedCanvas(
      getDb(),
      canvasId,
      session.guestId,
    );
    if (!deleted) {
      return new Response("completed painting not found", { status: 404 });
    }
    ensuredCanvases.delete(canvasId);
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/display-feed" && req.method === "GET") {
    const requested = Number(url.searchParams.get("limit") ?? "8");
    const limit = Number.isSafeInteger(requested)
      ? Math.max(1, Math.min(12, requested))
      : 8;
    const now = Date.now();
    if (!displayFeedCache || displayFeedCache.expiresAt <= now) {
      const [active, completed] = await Promise.all([
        listActiveCanvases(getDb()),
        listRandomCompleted(getDb(), 12),
      ]);
      displayFeedCache = {
        expiresAt: now + 2_000,
        response: {
          active: (await withComposedPixels(active.slice(0, 12))).map((
            canvas,
          ) => ({
            id: canvas.id,
            title: canvas.title,
            pixels: canvas.pixels,
            createdAt: canvas.createdAt,
            lastStrokeAt: canvas.lastStrokeAt,
            completedAt: canvas.completedAt,
          })),
          completed: completed.map(publicCanvas),
        },
      };
    }
    const response: DisplayFeedResponse = {
      active: displayFeedCache.response.active.slice(0, limit),
      completed: displayFeedCache.response.completed.slice(0, limit),
    };
    return Response.json(response, {
      headers: {
        "cache-control": "public, max-age=1, stale-while-revalidate=4",
      },
    });
  }

  const replayMatch = url.pathname.match(/^\/canvases\/([^/]+)\/replay$/);
  if (replayMatch && req.method === "GET") {
    const canvasId = replayMatch[1];
    assertCanvasId(canvasId);
    const access = await accessOfCanvas(canvasId);
    if (!access || access.completedAt === null) {
      return new Response("completed painting not found", { status: 404 });
    }
    const completed = await getCompletedCanvas(getDb(), canvasId);
    if (!completed) {
      return new Response("completed painting not found", { status: 404 });
    }
    const { events } = await pullEventsSince(getDb(), canvasId, 0);
    return Response.json(
      buildCanvasReplay(
        canvasId,
        completed.title ?? "Untitled",
        events,
      ),
      {
        headers: {
          "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
          "deno-cdn-cache-control": "public, s-maxage=86400",
        },
      },
    );
  }

  const eventsMatch = url.pathname.match(/^\/canvases\/([^/]+)\/events$/);
  if (eventsMatch && req.method === "POST") {
    const canvasId = eventsMatch[1];
    assertCanvasId(canvasId);
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    const body = validatePushEvents(await readJsonBody(req));
    const mutationCost = 1 + Math.ceil(body.events.length / 8);
    if (!consumeGuestMutation(session.guestId, mutationCost)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const now = Date.now();

    if (!ensuredCanvases.has(canvasId)) {
      await ensureCanvas(
        getDb(),
        canvasId,
        session.guestId,
        blankPixels(),
        now,
      );
      ensuredCanvases.add(canvasId);
    }

    const access = await accessOfCanvas(canvasId);
    if (!access) {
      const draft = await getGuestDraft(getDb(), session.guestId);
      if (draft && draft.id !== canvasId) {
        return Response.json({
          error: "draft_conflict",
          draftId: draft.id,
        }, { status: 409 });
      }
      return new Response("canvas not found", { status: 404 });
    }
    if (access.ownerId !== session.guestId) {
      return new Response("forbidden: canvas is owned by a different client", {
        status: 403,
      });
    }
    if (access.completedAt !== null) {
      return new Response("canvas is already signed", { status: 409 });
    }

    if (body.events.length > 0) {
      const events: NewEvent[] = body.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        strokeId: e.strokeId ?? null,
        cells: e.cells ? base64ToBytes(e.cells) : null,
        revertsId: e.revertsId ?? null,
        clientTs: e.clientTs,
      }));
      const { url: dbUrl, token } = getDbCreds();
      await appendEvents(
        dbUrl,
        token,
        canvasId,
        events,
        body.heartbeatActive,
        now,
      );
      // Fire-and-forget by design (a slow SSE fan-out must not gate the
      // push response) — but an un-awaited rejection here is an unhandled
      // promise rejection, and Deno terminates the whole process on one of
      // those by default. Contain it to this push instead.
      void broadcastEvents(canvasId, events).catch((err) => {
        console.error(`broadcastEvents failed for canvas ${canvasId}:`, err);
      });
    } else {
      // Heartbeat-only push (e.g. a pagehide/blur sendBeacon with no new
      // strokes) — still record the liveness flag without going through
      // appendEvents' BEGIN CONCURRENT path, since there's nothing to insert.
      await getDb().execute({
        sql: "UPDATE canvases SET client_reported_active = ? WHERE id = ?",
        args: [body.heartbeatActive ? 1 : 0, canvasId],
      });
    }
    const acknowledgments = await eventAcknowledgments(
      getDb(),
      canvasId,
      body.events.map((event) => event.id),
    );
    const response: PushEventsResponse = {
      ok: true,
      acknowledgments,
      headSequence: await headSequence(getDb(), canvasId),
    };
    if (acknowledgments.length !== body.events.length) {
      return new Response("canvas was signed while events were saving", {
        status: 409,
      });
    }
    return Response.json(response);
  }

  if (eventsMatch && req.method === "GET") {
    const canvasId = eventsMatch[1];
    assertCanvasId(canvasId);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    const access = await accessOfCanvas(canvasId);
    if (!access || access.ownerId !== session.guestId) {
      throw new HttpError(
        403,
        "forbidden: canvas is owned by a different client",
      );
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    if (!Number.isSafeInteger(since) || since < 0) {
      throw new HttpError(400, "since must be a non-negative integer");
    }
    const { events, headSequence } = await pullEventsSince(
      getDb(),
      canvasId,
      since,
    );
    return Response.json({
      headSequence,
      events: events.map((e) => ({
        sequence: e.sequence,
        id: e.id,
        kind: e.kind,
        strokeId: e.strokeId,
        cells: e.cells ? bytesToBase64(e.cells) : null,
        revertsId: e.revertsId,
        clientTs: e.clientTs,
        receivedAt: e.receivedAt,
      })),
    });
  }

  const completeMatch = url.pathname.match(/^\/canvases\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const canvasId = completeMatch[1];
    assertCanvasId(canvasId);
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    const body = validateCompletion(await readJsonBody(req));
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const access = await accessOfCanvas(canvasId);
    if (!access || access.ownerId !== session.guestId) {
      return new Response("forbidden: canvas is owned by a different client", {
        status: 403,
      });
    }
    if (access.completedAt !== null) {
      return new Response("canvas is already signed", { status: 409 });
    }
    const now = Date.now();
    const completed = await completeCanvas(getDb(), canvasId, body.title, now);
    if (!completed) {
      return new Response("canvas is already signed", { status: 409 });
    }
    const { events } = await pullEventsSince(getDb(), canvasId, 0);
    const pixels = new Uint8Array(composeCanvas(events).buffer);
    await storeCanvasPixels(getDb(), canvasId, pixels);
    const record = await getCompletedCanvas(getDb(), canvasId);
    if (!record) throw new Error("completed canvas disappeared");
    return Response.json({
      ok: true,
      canvas: publicCanvas(record),
    });
  }

  const streamMatch = url.pathname.match(/^\/canvases\/([^/]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    const canvasId = streamMatch[1];
    assertCanvasId(canvasId);
    let keepAlive: ReturnType<typeof setInterval>;
    let thisController: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        thisController = controller;
        if (!subscribers.has(canvasId)) subscribers.set(canvasId, new Set());
        subscribers.get(canvasId)!.add(controller);
        ensurePolling(canvasId);
        controller.enqueue(await snapshotChunk(canvasId));
        keepAlive = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          } catch {
            clearInterval(keepAlive);
          }
        }, 15_000);
      },
      cancel() {
        subscribers.get(canvasId)?.delete(thisController);
        clearInterval(keepAlive);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  if (url.pathname === "/dev/api/active") {
    const canvases = await listActiveCanvases(getDb());
    return Response.json({ canvases: await withComposedPixels(canvases) });
  }

  if (url.pathname === "/dev/api/completed") {
    const canvases = await listRecentlyCompleted(getDb(), 50);
    return Response.json({ canvases: await withComposedPixels(canvases) });
  }

  if (url.pathname === "/dev/active" || url.pathname === "/dev/completed") {
    const html = await Deno.readTextFile(
      publicFile(`${url.pathname.slice("/dev/".length)}.html`),
    );
    return new Response(html, { headers: htmlHeaders() });
  }

  if (url.pathname === "/datastar.js") {
    const ds = await Deno.readTextFile(publicFile("datastar.js"));
    return new Response(ds, {
      headers: staticHeaders("application/javascript"),
    });
  }

  const stylesheet = url.pathname.match(
    /^\/(base|style|gallery|collection)\.css$/,
  );
  if (stylesheet) {
    const css = await Deno.readTextFile(publicFile(`${stylesheet[1]}.css`));
    return new Response(css, {
      headers: staticHeaders("text/css; charset=utf-8"),
    });
  }

  if (
    url.pathname === "/app.js" || url.pathname === "/sync.js" ||
    url.pathname === "/local-db.js" || url.pathname === "/live-replay.js" ||
    url.pathname === "/site-nav.js" ||
    url.pathname === "/painting-parade.js" ||
    url.pathname === "/collection-page.js" ||
    url.pathname === "/editor-page.js"
  ) {
    const source = await Deno.readTextFile(clientFile(url.pathname.slice(1)));
    return new Response(source, {
      headers: staticHeaders("application/javascript; charset=utf-8"),
    });
  }

  const sharedModule = url.pathname.match(
    /^\/shared\/(paint-engine|palette-engine|ulid|cell-codec|compose|pixel-render)\.js$/,
  );
  if (sharedModule) {
    const source = await Deno.readTextFile(sharedFile(`${sharedModule[1]}.js`));
    return new Response(source, {
      headers: staticHeaders("application/javascript; charset=utf-8"),
    });
  }

  if (url.pathname === "/Minecraftia-Regular.ttf") {
    const font = await Deno.readFile(publicFile("Minecraftia-Regular.ttf"));
    return new Response(font, {
      headers: staticHeaders("font/ttf", true),
    });
  }

  if (url.pathname === "/favicon.ico") {
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "public, max-age=86400" },
    });
  }

  if (url.pathname === "/update") {
    return new Response(`<div id="output">Hello from server land 😲</div>`, {
      headers: { "content-type": "text/html" },
    });
  }

  return new Response("not found", { status: 404 });
}

if (import.meta.main) {
  assertGuestSessionConfigured();
  Deno.serve({ automaticCompression: true }, handler);
}
