import {
  appendEvents,
  type CanvasEventRow,
  type CanvasRecord,
  type CanvasSummary,
  type Client,
  completeCanvas,
  consumeChallenge,
  consumeTransferCode,
  createChallenge,
  createDb,
  createTransferCode,
  type CredentialRecord,
  deleteCompletedCanvas,
  deleteCredential,
  deleteGuestDraft,
  ensureCanvas,
  ensureProfile,
  eventAcknowledgments,
  getCanvasAccess,
  getCompletedCanvas,
  getCredentialById,
  getGuestDraft,
  getOrCreateDraft,
  getProfile,
  getProfileByUserHandle,
  headSequence,
  insertCredential,
  isHandleTaken,
  listActiveCanvases,
  listCompletedByOwnerPrefix,
  listCompletedPage,
  listCredentials,
  listGuestCompleted,
  listRandomCompleted,
  listRecentlyCompleted,
  markProfileUpgraded,
  mergeProfiles,
  type NewEvent,
  type ProfileRecord,
  pullEventsForCanvases,
  pullEventsSince,
  recordCredentialUse,
  recordTransferCodeFailure,
  renameHandle,
  storeCanvasPixels,
} from "./db.ts";
import { LiveHub } from "./live-hub.ts";
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  createPixels,
} from "../shared/paint-engine.js";
import { decodeCells } from "../shared/cell-codec.js";
import { composeCanvas } from "../shared/compose.js";
import { generateTransferCode } from "../shared/transfer-code.js";
import {
  type GuestSession,
  guestSession,
  issueSessionFor,
  sessionEpochValid,
  withSessionCookie,
} from "./guest-session.ts";
import { assertSigningKeysConfigured, fromBase64Url } from "./signing-keys.ts";
import { signMergeToken, verifyMergeToken } from "./merge-token.ts";
import { mintUniqueHandle } from "./handles.ts";
import { requireRelyingParty } from "./webauthn-config.ts";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  assertCanvasId,
  assertSameOrigin,
  HttpError,
  readJsonBody,
  validateCompletion,
  validateEnsureDraft,
  validateHandleRename,
  validateMergeRequest,
  validatePushEvents,
  validateTransferConsume,
} from "./protocol.ts";
import { consumeGuestMutation, consumeIpMutation } from "./rate-limit.ts";
import { buildCanvasReplay } from "./replay.ts";
import { buildJpaintDocument } from "../shared/jpaint.js";
import { attachmentDisposition } from "./content-disposition.ts";
import {
  type AssetManifest,
  buildImportMap,
  getAssetManifest,
  readAsset,
} from "./asset-manifest.ts";
import type {
  CompletedFeedResponse,
  CredentialSummary,
  DisplayFeedResponse,
  DraftMergeSummary,
  EnsureDraftResponse,
  GuestCanvasesResponse,
  LoginOptionsResponse,
  LoginVerifyResponse,
  LogoutResponse,
  MergeResponse,
  ProfileSummaryResponse,
  PublicCanvas,
  PushEventsResponse,
  RegisterOptionsResponse,
  RegisterVerifyResponse,
  RenameHandleResponse,
  TransferGenerateResponse,
} from "../shared/paint-types.d.ts";

const publicFile = (path: string) =>
  new URL(`../../public/${path}`, import.meta.url);
// Only for the service worker and its statically-imported helper module:
// a service worker has no import map to redirect a relative specifier
// through, so both must be served at fixed, unhashed, always-fresh URLs —
// see the /sw.js and /sw-routing.js routes below. Every OTHER browser
// module goes through asset-manifest.ts's content-hashed pipeline instead.
const clientFile = (path: string) =>
  new URL(`../client/${path}`, import.meta.url);

function isDevMode(): boolean {
  return Deno.env.get("PAINTING_DEV") === "1";
}

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
      "img-src 'self' data: blob:; manifest-src 'self'; worker-src 'self'; " +
      "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
// Phase 5: transfer codes. See docs/transfer-codes.md for the full
// reasoning behind these numbers (TTL, generation cost, consume cost) —
// summarized where they're used, below.
const TRANSFER_CODE_TTL_MS = 10 * 60 * 1000;
const TRANSFER_GENERATE_IP_COST = 5;
const TRANSFER_CONSUME_IP_COST = 1;

const ensuredCanvases = new Set<string>();
// Mirrors ensuredCanvases: the events POST route is the high-frequency
// mutation (one push per sync interval while painting), so profile
// creation there is gated the same way canvas creation already is,
// rather than re-upserting on every single push.
const ensuredProfiles = new Set<string>();
let displayFeedCache:
  | { expiresAt: number; response: DisplayFeedResponse }
  | null = null;

// Re-check ownership and completion for every mutation. Multiplayer painting
// isn't a goal here: only the signed guest profile that created a canvas may
// push events or complete it, and a completed canvas is immutable.
async function accessOfCanvas(canvasId: string) {
  return await getCanvasAccess(getDb(), canvasId);
}

/**
 * The session_epoch enforcement point (Phase 4): rejects a mutating
 * request whose cookie carries a stale epoch — a profile whose
 * session_epoch has been bumped since this cookie was signed. Callers are
 * every mutating route that has ALREADY fetched a fresh ProfileRecord for
 * an unrelated reason (ensureProfile, getProfile) — this adds a
 * comparison, not a query. Deliberately NOT called from any page/GET
 * route: those must stay at zero database queries (see guest-session.ts's
 * signGuestId() doc comment), so a stale-epoch page load is simply never
 * checked — only the next mutation from it is rejected. That is enough:
 * reading a stale page is harmless, only a mutation matters.
 */
function assertSessionEpoch(
  session: GuestSession,
  profile: Pick<ProfileRecord, "sessionEpoch">,
): void {
  if (!sessionEpochValid(session, profile.sessionEpoch)) {
    throw new HttpError(401, "session expired; please sign in again");
  }
}

/** One draft's summary for the Phase 4 merge dialog — see DraftMergeSummary. */
async function draftMergeSummary(canvas: CanvasRecord): Promise<DraftMergeSummary> {
  const { events } = await pullEventsSince(getDb(), canvas.id, 0);
  const pixels = composeCanvas(events);
  return {
    id: canvas.id,
    pixels: bytesToBase64(new Uint8Array(pixels.buffer)),
    strokeCount: events.filter((event) => event.kind === "stroke").length,
    lastActivityAt: canvas.lastStrokeAt ?? canvas.createdAt,
  };
}

/**
 * The single implementation of the four-case merge table (see
 * docs/jpaint... no — see the Phase 4 design notes above POST
 * /api/auth/merge, and docs/transfer-codes.md for the Phase 5 addition).
 * Called from BOTH POST /api/auth/login/verify (after a WebAuthn
 * assertion verifies) and POST /api/auth/transfer/consume (after a
 * transfer code is consumed) — the two are different ways of proving
 * "I am this profile," but from this point on the situation, the
 * decision, and the response shape are identical, so this is the ONE
 * place that logic exists. Anything wrong here is wrong for both sign-in
 * paths at once, which is deliberate: duplicating it was the actual risk,
 * not a shared function being slightly less local to each caller.
 *
 * `accountProfile` is the profile the caller has just proven it is,
 * however it proved it. The device's EXISTING guest session (read but
 * never written until a decision is reached) is compared against it:
 *
 *   - same profile already: nothing to do, just re-affirm the cookie.
 *   - only one side (or neither) has an open draft: silent — re-own
 *     whatever the device had (completed work unconditionally, the open
 *     draft only if the account doesn't already have one) and set the
 *     account cookie in this same response.
 *   - both sides have an open draft: return a merge token and both
 *     drafts' summaries; touch NEITHER the cookie NOR the database.
 *     POST /api/auth/merge is the only thing that can resolve this,
 *     and backing out (never calling it) costs nothing.
 */
async function resolveSignInMerge(
  req: Request,
  accountProfile: ProfileRecord,
  now: number,
): Promise<Response> {
  const deviceSession = await guestSession(req, false);
  const guestProfileId = deviceSession?.guestId ?? null;

  if (guestProfileId === accountProfile.id) {
    const session = await issueSessionFor(
      req,
      accountProfile.id,
      accountProfile.sessionEpoch,
    );
    const response: LoginVerifyResponse = {
      ok: true,
      handle: accountProfile.handle ?? "",
      merge: { pending: false },
    };
    return withSessionCookie(
      Response.json(response, {
        headers: { "cache-control": "private, no-store" },
      }),
      session,
    );
  }

  const guestDraft = guestProfileId
    ? await getGuestDraft(getDb(), guestProfileId)
    : null;
  const accountDraft = await getGuestDraft(getDb(), accountProfile.id);

  if (guestDraft && accountDraft) {
    const mergeToken = await signMergeToken({
      guestProfileId: guestProfileId as string,
      accountProfileId: accountProfile.id,
      now,
    });
    const response: LoginVerifyResponse = {
      ok: true,
      merge: {
        pending: true,
        mergeToken,
        deviceDraft: await draftMergeSummary(guestDraft),
        accountDraft: await draftMergeSummary(accountDraft),
      },
    };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (guestProfileId) {
    await mergeProfiles(getDb(), {
      guestProfileId,
      accountProfileId: accountProfile.id,
      discardDraftId: null,
      reownDraftId: guestDraft ? guestDraft.id : null,
    });
  }
  const session = await issueSessionFor(
    req,
    accountProfile.id,
    accountProfile.sessionEpoch,
  );
  const response: LoginVerifyResponse = {
    ok: true,
    handle: accountProfile.handle ?? "",
    merge: { pending: false },
  };
  return withSessionCookie(
    Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    }),
    session,
  );
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
    author: canvas.author,
    // Deliberately no ownerId field — see the README's "JavaScript never
    // receives an owner identifier" design property. author is public by
    // design (Phase 3.5); ownerId stays private forever. Keep it that way
    // if this function ever grows more fields.
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

function publicCredential(credential: CredentialRecord): CredentialSummary {
  return {
    credentialId: credential.credentialId,
    createdAt: credential.createdAt,
    nickname: credential.nickname,
    backedUp: credential.backedUp,
  };
}

/**
 * Reads the `challenge` field out of a WebAuthn response's clientDataJSON
 * WITHOUT verifying anything — that's still verifyRegistrationResponse's
 * job. This is only how the server knows WHICH stored challenge row to
 * look up and consume (see consumeChallenge()); the actual cryptographic
 * check happens after, against the value this returns.
 */
function decodeClientDataChallenge(clientDataJSON: string): string | null {
  const bytes = fromBase64Url(clientDataJSON);
  if (!bytes) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed.challenge === "string" ? parsed.challenge : null;
  } catch {
    return null;
  }
}

async function activeStreamCanvases() {
  const active = await listActiveCanvases(getDb());
  const events = await pullEventsForCanvases(
    getDb(),
    active.map((canvas) => canvas.id),
  );
  const byCanvas = Map.groupBy(events, (event) => event.canvasId);
  return active.map((canvas) => {
    const canvasEvents = byCanvas.get(canvas.id) ?? [];
    const { ownerId: _ownerId, ...summary } = canvas;
    return {
      canvas: {
        ...summary,
        pixels: bytesToBase64(
          new Uint8Array(composeCanvas(canvasEvents).buffer),
        ),
      },
      headSequence: canvasEvents.at(-1)?.sequence ?? 0,
    };
  });
}

let liveHub: LiveHub | null = null;
function getLiveHub(): LiveHub {
  return liveHub ??= new LiveHub(getDb(), {
    active: activeStreamCanvases,
    async snapshot(canvasId) {
      const canvases = await activeStreamCanvases();
      return canvases.find((item) => item.canvas.id === canvasId) ?? null;
    },
    async completed(canvasId) {
      const canvas = await getCompletedCanvas(getDb(), canvasId);
      return canvas
        ? {
          canvas: publicCanvas(canvas),
          headSequence: await headSequence(getDb(), canvasId),
        }
        : null;
    },
  });
}

function encodeCompletedCursor(completedAt: number, id: string): string {
  return btoa(JSON.stringify([completedAt, id]));
}

function decodeCompletedCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(atob(value));
    if (
      !Array.isArray(parsed) || parsed.length !== 2 ||
      !Number.isSafeInteger(parsed[0]) || typeof parsed[1] !== "string"
    ) throw new Error();
    return { completedAt: parsed[0] as number, id: parsed[1] as string };
  } catch {
    throw new HttpError(400, "invalid completed cursor");
  }
}

/**
 * Best-effort client IP for the transfer-code rate limiters
 * (rate-limit.ts's consumeIpMutation) — NOT cryptographically
 * trustworthy, and not used for anything beyond throttling.
 *
 * `info.remoteAddr` (the second argument Deno.serve's handler receives)
 * is the direct TCP peer — on Deno Deploy that is the platform's OWN edge
 * proxy, never the real visitor, so it is useless here except as a
 * last-resort fallback for local dev (`deno task dev`, where there IS no
 * proxy in front and remoteAddr genuinely is the caller). In front of a
 * proxy, the standard signal is the `x-forwarded-for` header; this reads
 * its LAST comma-separated entry, not the first — the first entry in a
 * multi-hop chain is whatever the ORIGINAL client sent and is entirely
 * attacker-controlled, while the last entry is the one the closest
 * (most-trusted, hardest to spoof) proxy hop appended. For this app's
 * single-hop Deno Deploy topology that last entry is the address Deno
 * Deploy's own edge recorded. A request carrying neither header nor
 * connection info (as in plain unit tests calling handler(req) directly)
 * collapses to the literal string "unknown" — every such caller then
 * shares one rate-limit bucket, which is fine for tests and means this
 * path fails safe (over-throttling a shared "unknown" bucket) rather than
 * unsafe (no limiting at all).
 */
function clientIp(req: Request, info?: Deno.ServeHandlerInfo): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  if (info?.remoteAddr && "hostname" in info.remoteAddr) {
    return info.remoteAddr.hostname;
  }
  return "unknown";
}

/**
 * Deno.serve is documented to catch a handler's thrown/rejected error and
 * respond 500 on its own — this wrapper exists anyway as an explicit,
 * un-bypassable backstop, since a single request hitting a real db error
 * (a conflict-retry exhaustion, a malformed pipeline response) should never
 * have a path to crashing the whole process regardless of the exact
 * mechanism.
 */
export async function handler(
  req: Request,
  info?: Deno.ServeHandlerInfo,
): Promise<Response> {
  try {
    const response = await route(req, clientIp(req, info));
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

/**
 * Server-side asset rewriting for the four real pages (not the /dev/*
 * diagnostics, which stay untouched — see Phase 0.5 notes). Replaces every
 * plain `href="/x.css"` / `src="/x.js"` reference with its content-hashed
 * URL and injects a `<script type="importmap">` covering the *entire*
 * client+shared module graph — not just the entry points named directly in
 * HTML — since only specifiers present in the map get redirected, and a
 * relative import inside a hashed module (e.g. "./local-db.js" inside
 * sync.<hash>.js) still needs to resolve to its own hashed file.
 */
function rewriteHtml(html: string, manifest: AssetManifest): string {
  let out = html;
  for (const entry of manifest.entries) {
    if (entry.hashedPath === entry.logicalPath) continue;
    const attr = entry.kind === "css" ? "href" : "src";
    out = out.replaceAll(
      `${attr}="${entry.logicalPath}"`,
      `${attr}="${entry.hashedPath}"`,
    );
  }
  const importMapJson = JSON.stringify(buildImportMap(manifest));
  return out.replace(
    "<head>",
    `<head>\n    <script type="importmap">${importMapJson}</script>`,
  );
}

// Rewritten HTML is cached per source filename (not per request) so the
// string rewriting above happens once per process, not once per page view.
// Bypassed entirely in dev mode, where the manifest is an identity map and
// the raw file already references the right (unhashed) paths — see
// asset-manifest.ts.
const renderedPageCache = new Map<string, string>();

async function renderPage(
  page: string,
  manifest: AssetManifest,
): Promise<string> {
  const html = await Deno.readTextFile(publicFile(page));
  if (manifest.devMode) return html;
  const cached = renderedPageCache.get(page);
  if (cached !== undefined) return cached;
  const rendered = rewriteHtml(html, manifest);
  renderedPageCache.set(page, rendered);
  return rendered;
}

async function route(req: Request, ip: string): Promise<Response> {
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
    const manifest = await getAssetManifest(isDevMode());
    const html = await renderPage(page, manifest);
    const session = await guestSession(req, true);
    return withSessionCookie(
      new Response(html, { headers: htmlHeaders() }),
      session as NonNullable<typeof session>,
    );
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    // Matches the sibling /api/me/* routes: a cookie-less visitor 401s
    // rather than getting a 200-with-nulls, for consistency with
    // /api/me/canvases below. This is a plain read — it never creates a
    // profiles row; see ensureProfile()'s call sites for the only place
    // that happens. A guest who has never mutated anything simply has no
    // row yet, which reads identically to a guest profile with zero
    // credentials (both show as the same not-an-account shape) — there is
    // no need to distinguish "no row" from "row, not upgraded" here.
    //
    // Never expose the profile id or user_handle to JavaScript — the
    // README states as a design property that "JavaScript never receives
    // an owner identifier," and that applies just as much to the new
    // profile id as it always has to the guest id.
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    const profile = await getProfile(getDb(), session.guestId);
    const credentials = profile
      ? await listCredentials(getDb(), profile.id)
      : [];
    const response: ProfileSummaryResponse = {
      handle: profile?.handle ?? null,
      isAccount: credentials.length > 0,
      credentialCount: credentials.length,
      credentials: credentials.map(publicCredential),
    };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (url.pathname === "/api/me/handle" && req.method === "PUT") {
    // Available to guests AND accounts — a handle predates account-ness
    // now (see ensureProfile()), and there's no reason to gate renaming
    // behind having a passkey.
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const body = validateHandleRename(await readJsonBody(req));
    const profile = await ensureProfile(getDb(), session.guestId, Date.now());
    assertSessionEpoch(session, profile);
    const result = await renameHandle(getDb(), session.guestId, body.handle);
    if (result === "conflict") {
      return new Response("that handle is already taken", { status: 409 });
    }
    const response: RenameHandleResponse = { ok: true, handle: body.handle };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (
    url.pathname === "/api/auth/register/options" && req.method === "POST"
  ) {
    assertSameOrigin(req);
    const rp = requireRelyingParty(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const now = Date.now();
    const profile = await ensureProfile(getDb(), session.guestId, now);
    assertSessionEpoch(session, profile);
    // Defensive fallback only — every profile gets a handle at creation
    // (see ensureProfile()) now, so this should never actually run.
    let handle = profile.handle;
    if (!handle) {
      handle = await mintUniqueHandle(
        profile.id,
        (candidate) => isHandleTaken(getDb(), candidate),
      );
      await renameHandle(getDb(), profile.id, handle);
    }
    const existingCredentials = await listCredentials(getDb(), profile.id);
    const options = await generateRegistrationOptions({
      rpID: rp.rpId,
      rpName: rp.rpName,
      userID: profile.userHandle as Uint8Array<ArrayBuffer>,
      userName: handle,
      userDisplayName: handle,
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "preferred",
      },
      excludeCredentials: existingCredentials.map((credential) => ({
        id: credential.credentialId,
        transports: credential.transports ?? undefined,
      })) as Parameters<
        typeof generateRegistrationOptions
      >[0]["excludeCredentials"],
      supportedAlgorithmIDs: [-7, -257],
    });
    await createChallenge(getDb(), {
      challenge: options.challenge,
      profileId: profile.id,
      purpose: "register",
      now,
    });
    const response: RegisterOptionsResponse = { options };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (
    url.pathname === "/api/auth/register/verify" && req.method === "POST"
  ) {
    assertSameOrigin(req);
    const rp = requireRelyingParty(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const now = Date.now();
    const profile = await ensureProfile(getDb(), session.guestId, now);
    assertSessionEpoch(session, profile);
    // Defensive fallback only — see the identical comment in
    // /api/auth/register/options; should never actually run.
    let handle = profile.handle;
    if (!handle) {
      handle = await mintUniqueHandle(
        profile.id,
        (candidate) => isHandleTaken(getDb(), candidate),
      );
      await renameHandle(getDb(), profile.id, handle);
    }
    const body = await readJsonBody(req) as { credential?: unknown };
    const credential = body.credential as RegistrationResponseJSON | undefined;
    if (
      !credential || typeof credential.response?.clientDataJSON !== "string"
    ) {
      throw new HttpError(400, "malformed registration response");
    }
    const clientDataChallenge = decodeClientDataChallenge(
      credential.response.clientDataJSON,
    );
    if (!clientDataChallenge) {
      throw new HttpError(400, "malformed registration response");
    }
    const consumed = await consumeChallenge(getDb(), {
      challenge: clientDataChallenge,
      purpose: "register",
      profileId: profile.id,
      now,
    });
    if (!consumed) {
      return new Response(
        "registration challenge missing, expired, or already used",
        { status: 401 },
      );
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credential as unknown as Parameters<
          typeof verifyRegistrationResponse
        >[0]["response"],
        expectedChallenge: clientDataChallenge,
        expectedOrigin: rp.expectedOrigins,
        expectedRPID: rp.rpId,
      });
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error
          ? error.message
          : "passkey registration verification failed",
      );
    }
    if (!verification.verified || !verification.registrationInfo) {
      return new Response("passkey registration could not be verified", {
        status: 401,
      });
    }

    const info = verification.registrationInfo;
    // The BE/BS flags are the entire recovery story for this account: BS
    // true means the platform (iCloud Keychain, Google Password Manager,
    // ...) has a synced backup, BE (credentialDeviceType === "multiDevice")
    // means it's ELIGIBLE to be backed up. Both are stored and surfaced to
    // the user (see CredentialSummary / the /collection panel) — this is
    // the only place either flag is knowable, so losing it here loses it
    // for good.
    //
    // The counter is stored as reported and NOT used for our own clone
    // detection: synced platform passkeys always report 0 and never
    // increment, so treating a non-incrementing counter as evidence of a
    // cloned authenticator would lock out every iCloud Keychain / Google
    // Password Manager user. @simplewebauthn/server enforces monotonic
    // counters internally on the (unimplemented this phase) authentication
    // path; that's the right layer for it, not a second check here.
    await insertCredential(getDb(), {
      credentialId: info.credential.id,
      profileId: profile.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports ?? null,
      aaguid: info.aaguid ?? null,
      backupEligible: info.credentialDeviceType === "multiDevice",
      backedUp: info.credentialBackedUp,
      createdAt: now,
    });
    await markProfileUpgraded(getDb(), profile.id, now);

    const response: RegisterVerifyResponse = {
      ok: true,
      handle,
      backedUp: info.credentialBackedUp,
    };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  const credentialMatch = url.pathname.match(
    /^\/api\/auth\/credentials\/([^/]+)$/,
  );
  if (credentialMatch && req.method === "DELETE") {
    // Deliberately NOT gated behind requireRelyingParty(): deletion
    // performs no WebAuthn ceremony (no rpID/origin binding to verify at
    // all) — it's a plain database delete, in the same family as
    // PUT /api/me/handle, which is also ungated. A user must always be
    // able to remove a credential they no longer trust, including from a
    // non-canonical origin where they can't register a NEW one — that's
    // precisely the moment removal matters most. Only register/options
    // and register/verify genuinely need a pinned RP ID.
    assertSameOrigin(req);
    const credentialId = credentialMatch[1];
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const epochProfile = await ensureProfile(getDb(), session.guestId, Date.now());
    assertSessionEpoch(session, epochProfile);
    const result = await deleteCredential(
      getDb(),
      session.guestId,
      credentialId,
    );
    if (result === "not-found") {
      return new Response("credential not found", { status: 404 });
    }
    if (result === "last-credential") {
      return new Response(
        "cannot remove your last passkey — it is the only way into this account",
        { status: 400 },
      );
    }
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "private, no-store" },
    });
  }

  // --- Phase 4: passkey sign-in and draft merge --------------------------

  if (url.pathname === "/api/auth/login/options" && req.method === "POST") {
    assertSameOrigin(req);
    const rp = requireRelyingParty(req);
    const now = Date.now();
    // NO allowCredentials: there is no username in this product, so
    // sign-in relies entirely on discoverable credentials — the
    // authenticator itself knows which credential(s) it holds for this
    // rpID (residentKey: "required" at registration time is what makes
    // this possible) and presents them without the server ever saying
    // which id to use.
    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: "preferred",
    });
    await createChallenge(getDb(), {
      challenge: options.challenge,
      profileId: null,
      purpose: "authenticate",
      now,
    });
    const response: LoginOptionsResponse = { options };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (url.pathname === "/api/auth/login/verify" && req.method === "POST") {
    assertSameOrigin(req);
    const rp = requireRelyingParty(req);
    const now = Date.now();
    const body = await readJsonBody(req) as { credential?: unknown };
    const credential = body.credential as
      | Parameters<typeof verifyAuthenticationResponse>[0]["response"]
      | undefined;
    if (
      !credential || typeof credential.response?.clientDataJSON !== "string"
    ) {
      throw new HttpError(400, "malformed authentication response");
    }
    const clientDataChallenge = decodeClientDataChallenge(
      credential.response.clientDataJSON,
    );
    if (!clientDataChallenge) {
      throw new HttpError(400, "malformed authentication response");
    }
    const consumed = await consumeChallenge(getDb(), {
      challenge: clientDataChallenge,
      purpose: "authenticate",
      profileId: null,
      now,
    });
    if (!consumed) {
      return new Response(
        "sign-in challenge missing, expired, or already used",
        { status: 401 },
      );
    }

    // Resolve which credential this is: normally by credential_id (the
    // fast, exact path — the authenticator hands back the same id it was
    // registered with). Falls back to the response's userHandle — the
    // profile's own 32 opaque random bytes, minted at registration for
    // exactly this purpose (see /api/auth/register/options) — only if
    // that lookup misses.
    let stored = await getCredentialById(getDb(), credential.id);
    if (!stored) {
      const userHandleValue = credential.response.userHandle;
      const userHandleBytes = typeof userHandleValue === "string"
        ? fromBase64Url(userHandleValue)
        : null;
      const byHandle = userHandleBytes
        ? await getProfileByUserHandle(getDb(), userHandleBytes)
        : null;
      if (!byHandle) {
        return new Response("passkey not recognized", { status: 401 });
      }
      const own = await listCredentials(getDb(), byHandle.id);
      stored = own.find((c) => c.credentialId === credential.id) ?? null;
      if (!stored) {
        return new Response("passkey not recognized", { status: 401 });
      }
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: credential,
        expectedChallenge: clientDataChallenge,
        expectedOrigin: rp.expectedOrigins,
        expectedRPID: rp.rpId,
        credential: {
          id: stored.credentialId,
          publicKey: stored.publicKey as Uint8Array<ArrayBuffer>,
          counter: stored.counter,
          transports: stored.transports as
            | Parameters<typeof verifyAuthenticationResponse>[0]["credential"]["transports"]
            | undefined,
        },
      });
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error
          ? error.message
          : "passkey sign-in verification failed",
      );
    }
    if (!verification.verified) {
      return new Response("passkey sign-in could not be verified", {
        status: 401,
      });
    }

    // Stored as reported, same as registration — see the comment on this
    // exact tradeoff in /api/auth/register/verify: synced platform
    // passkeys always report a counter of 0 and never increment it, so
    // treating a non-incrementing counter as evidence of a cloned
    // authenticator would lock out every iCloud Keychain / Google
    // Password Manager user. @simplewebauthn/server already enforces
    // monotonicity internally against the counter we hand it above.
    await recordCredentialUse(
      getDb(),
      stored.credentialId,
      verification.authenticationInfo.newCounter,
      now,
    );

    const accountProfile = await getProfile(getDb(), stored.profileId);
    if (!accountProfile) {
      throw new HttpError(500, "credential referenced a missing profile");
    }
    return await resolveSignInMerge(req, accountProfile, now);
  }

  // Resolves the fourth (dialog) row of the merge table: the user has
  // chosen which draft to keep. Nothing was written to the database by
  // login/verify above to get here — this is the FIRST database write in
  // the whole sign-in flow when there's a merge decision to make, and the
  // account session cookie is only set in THIS response, after the merge
  // actually lands. Backing out of the dialog (never calling this route
  // at all) is therefore free: the mergeToken is simply discarded
  // client-side, and the device stays on its original guest cookie with
  // an unmodified database underneath it — there is nothing to undo.
  if (url.pathname === "/api/auth/merge" && req.method === "POST") {
    assertSameOrigin(req);
    requireRelyingParty(req);
    const now = Date.now();
    const body = validateMergeRequest(await readJsonBody(req));
    const payload = await verifyMergeToken(body.mergeToken, now);
    if (!payload) {
      return new Response("merge token missing, expired, or invalid", {
        status: 401,
      });
    }
    // The token is bound to the device that received it: this request
    // must still be carrying that SAME device's original guest cookie
    // (login/verify never touched it) — not, say, a merge token
    // intercepted and replayed from a different browser.
    const deviceSession = await guestSession(req, false);
    if (!deviceSession || deviceSession.guestId !== payload.guestProfileId) {
      return new Response(
        "merge token does not match this device's session",
        { status: 401 },
      );
    }
    const guestProfile = await getProfile(getDb(), payload.guestProfileId);
    if (!guestProfile) {
      throw new HttpError(401, "session expired; please sign in again");
    }
    assertSessionEpoch(deviceSession, guestProfile);
    const accountProfile = await getProfile(getDb(), payload.accountProfileId);
    if (!accountProfile) {
      throw new HttpError(500, "merge token referenced a missing profile");
    }

    // Re-derived fresh, not trusted from the token: this is what makes a
    // REPLAY of an already-used merge token a safe no-op rather than
    // something requiring its own single-use ledger. Once a merge has
    // actually happened, one side of this pair no longer has an open
    // draft (it was either discarded or re-owned), so a second call with
    // the same token fails this check and changes nothing.
    const guestDraft = await getGuestDraft(getDb(), payload.guestProfileId);
    const accountDraft = await getGuestDraft(getDb(), payload.accountProfileId);
    if (!guestDraft || !accountDraft) {
      return new Response(
        "nothing to merge — this was already resolved or is no longer current",
        { status: 409 },
      );
    }

    await mergeProfiles(getDb(), {
      guestProfileId: payload.guestProfileId,
      accountProfileId: payload.accountProfileId,
      discardDraftId: body.keep === "device" ? accountDraft.id : guestDraft.id,
      reownDraftId: body.keep === "device" ? guestDraft.id : null,
    });

    const session = await issueSessionFor(
      req,
      accountProfile.id,
      accountProfile.sessionEpoch,
    );
    const response: MergeResponse = {
      ok: true,
      handle: accountProfile.handle ?? "",
    };
    return withSessionCookie(
      Response.json(response, {
        headers: { "cache-control": "private, no-store" },
      }),
      session,
    );
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    assertSameOrigin(req);
    // Guest is the ground state, not a degraded one: a user must always
    // be able to paint, so signing out issues a FRESH guest profile
    // cookie rather than leaving the client cookie-less. This is a brand
    // new random guest id, deliberately not the account's old (pre-
    // upgrade) guest id — there is no way back to that association, by
    // the same "JavaScript never receives an owner identifier" design
    // property that keeps every other id server-only.
    const guestId = crypto.randomUUID();
    const session = await issueSessionFor(req, guestId, 0);
    const response: LogoutResponse = { ok: true };
    return withSessionCookie(
      Response.json(response, {
        headers: { "cache-control": "private, no-store" },
      }),
      session,
    );
  }

  // --- Phase 5: transfer codes --------------------------------------------
  //
  // See docs/transfer-codes.md for the full design and threat model.
  // Available to GUESTS, not just accounts — the iOS install-jar trap
  // (see pwa.js) is precisely a guest with no credentials at all needing
  // to move a profile from a Safari tab into the installed app, and
  // gating this behind an account would make transfer useless for the
  // exact case that most needs it. Deliberately NOT gated behind
  // requireRelyingParty(): a transfer code performs no WebAuthn ceremony,
  // and is specifically the fallback for when a passkey ceremony ISN'T
  // available on the current origin at all.

  if (url.pathname === "/api/auth/transfer" && req.method === "POST") {
    assertSameOrigin(req);
    const session = await guestSession(req, false);
    if (!session) throw new HttpError(401, "guest session required");
    // IP-keyed, on top of the existing per-guest bucket below: minting a
    // fresh guest cookie is free, so a flood of generation calls from
    // many disposable guests off the SAME IP would otherwise sail
    // straight past a guest-keyed limiter. See rate-limit.ts's
    // consumeIpMutation() doc comment for the exact numbers/reasoning.
    if (!consumeIpMutation(ip, TRANSFER_GENERATE_IP_COST)) {
      return new Response("too many requests", {
        status: 429,
        headers: { "retry-after": "60" },
      });
    }
    if (!consumeGuestMutation(session.guestId)) {
      return new Response("too many write requests", {
        status: 429,
        headers: { "retry-after": "1" },
      });
    }
    const now = Date.now();
    const profile = await ensureProfile(getDb(), session.guestId, now);
    assertSessionEpoch(session, profile);

    // A collision against another still-live code is astronomically
    // unlikely (~1 in 2^40) — this retry loop exists only as the same
    // kind of defensive belt-and-suspenders getOrCreateDraft() already
    // uses for its own id collisions, not because a collision is
    // expected.
    let code = "";
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      code = generateTransferCode();
      try {
        await createTransferCode(getDb(), {
          code,
          profileId: profile.id,
          now,
          ttlMs: TRANSFER_CODE_TTL_MS,
        });
        inserted = true;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("UNIQUE constraint failed")
        ) {
          throw error;
        }
      }
    }
    if (!inserted) {
      throw new HttpError(500, "could not generate a transfer code");
    }

    const response: TransferGenerateResponse = {
      ok: true,
      code,
      expiresAt: now + TRANSFER_CODE_TTL_MS,
    };
    return Response.json(response, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  if (url.pathname === "/api/auth/transfer/consume" && req.method === "POST") {
    assertSameOrigin(req);
    if (!consumeIpMutation(ip, TRANSFER_CONSUME_IP_COST)) {
      return new Response("too many requests", {
        status: 429,
        headers: { "retry-after": "15" },
      });
    }
    const now = Date.now();
    const body = validateTransferConsume(await readJsonBody(req));
    const profileId = await consumeTransferCode(getDb(), body.code, now);
    if (!profileId) {
      // Same message regardless of WHY: unknown, expired, already used,
      // or already exhausted by failed attempts — distinguishing any of
      // those for the caller would hand a guessing attacker a signal
      // ("that one exists but is dead" vs "that one never existed") this
      // response must not leak. Recording the failure (best-effort,
      // never blocking the response on it) is what lets
      // recordTransferCodeFailure() invalidate a specific code after
      // TRANSFER_CODE_MAX_ATTEMPTS wrong/dead submissions — see its own
      // doc comment in db.ts.
      await recordTransferCodeFailure(getDb(), body.code);
      return new Response("that code is invalid, expired, or already used", {
        status: 401,
      });
    }
    const accountProfile = await getProfile(getDb(), profileId);
    if (!accountProfile) {
      throw new HttpError(500, "transfer code referenced a missing profile");
    }
    return await resolveSignInMerge(req, accountProfile, now);
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
    // Lazy profile row creation: the FIRST mutation for a guest is where
    // its `profiles` row is born — never on a page load. See db.ts's
    // ensureProfile() and the Phase 2 notes in migrations/001_initial.sql.
    const epochProfile = await ensureProfile(getDb(), session.guestId, Date.now());
    assertSessionEpoch(session, epochProfile);
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
    const epochProfile = await ensureProfile(getDb(), session.guestId, Date.now());
    assertSessionEpoch(session, epochProfile);
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
    const epochProfile = await ensureProfile(getDb(), session.guestId, Date.now());
    assertSessionEpoch(session, epochProfile);
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
            author: canvas.author,
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

  if (url.pathname === "/api/completed-feed" && req.method === "GET") {
    const requested = Number(url.searchParams.get("limit") ?? "20");
    const limit = Number.isSafeInteger(requested)
      ? Math.max(1, Math.min(50, requested))
      : 20;
    const cursor = decodeCompletedCursor(url.searchParams.get("cursor"));
    const page = await listCompletedPage(getDb(), limit + 1, cursor);
    const hasMore = page.length > limit;
    const paintings = page.slice(0, limit);
    const last = paintings.at(-1);
    const response: CompletedFeedResponse = {
      paintings: paintings.map(publicCanvas),
      nextCursor:
        hasMore && last?.completedAt !== null && last?.completedAt !== undefined
          ? encodeCompletedCursor(last.completedAt, last.id)
          : null,
    };
    return Response.json(response, {
      headers: {
        "cache-control": "public, max-age=2, stale-while-revalidate=8",
      },
    });
  }

  if (url.pathname === "/api/live-stream" && req.method === "GET") {
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let streamController:
      | ReadableStreamDefaultController<Uint8Array>
      | undefined;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        streamController = controller;
        await getLiveHub().subscribe(controller);
        keepAlive = setInterval(() => {
          try {
            controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
          } catch {
            if (keepAlive) clearInterval(keepAlive);
          }
        }, 15_000);
      },
      cancel() {
        if (streamController) getLiveHub().unsubscribe(streamController);
        if (keepAlive) clearInterval(keepAlive);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "x-accel-buffering": "no",
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
    // author comes straight off the already-fetched `completed` record —
    // no extra query. Serializes as a plain JSON `null` for a completed
    // canvas that predates author capture (Phase 3.5) and hasn't been
    // backfilled (see scripts/backfill-profiles.ts); the client already
    // treats other CanvasReplayResponse/PublicCanvas fields (`title`) as
    // possibly absent-ish, so a new nullable field is not a breaking
    // change. No cache-key bump needed either: this route is cached by
    // URL, adding a field is purely additive, and the client (see
    // painting-parade.js's use of `timeline`) only ever reads
    // initialPixels/finalPixels/durationMs/steps off this response, never
    // title or author — an already-cached response missing the field
    // simply expires on its own within the existing max-age=3600.
    return Response.json(
      buildCanvasReplay(
        canvasId,
        completed.title ?? "Untitled",
        completed.author,
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

  const jpaintMatch = url.pathname.match(/^\/canvases\/([^/]+)\/jpaint$/);
  if (jpaintMatch && req.method === "GET") {
    const canvasId = jpaintMatch[1];
    assertCanvasId(canvasId);
    const access = await accessOfCanvas(canvasId);
    if (!access || access.completedAt === null) {
      return new Response("completed painting not found", { status: 404 });
    }
    const completed = await getCompletedCanvas(getDb(), canvasId);
    if (!completed) {
      return new Response("completed painting not found", { status: 404 });
    }
    // The FULL, unbounded event log — deliberately NOT routed through
    // buildCanvasReplay(), which bounds/clamps for the live ambient
    // display. See docs/jpaint-format.md: losslessness w.r.t. our own
    // model is this format's entire interop guarantee, and a truncated
    // log would silently break that for any painting with a long edit
    // history.
    //
    // `?events=none` lets a caller who only wants the finished image skip
    // the (potentially large, unbounded) event log; any other value, or
    // omitting the param, returns the full log — see docs/jpaint-format.md
    // for why full-by-default is the right call for an archival format.
    const includeEvents = url.searchParams.get("events") !== "none";
    const events = includeEvents
      ? (await pullEventsSince(getDb(), canvasId, 0)).events
      : [];
    const document = buildJpaintDocument(
      completed,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      events,
    );
    // Response.json() hardcodes `content-type: application/json` — this is
    // its own media type, not plain JSON, so the content-type is set
    // explicitly here instead.
    //
    // The `events` query param safely participates in caching: both
    // standard HTTP caches and Deno Deploy's edge cache key on the full
    // request URL (method + path + query string) per RFC 9111 semantics
    // (Deno Deploy's own caching docs state the cache follows RFC 9110/9111
    // semantics) — ?events=none and the default full-log response are
    // different URLs and therefore different cache entries. This mirrors
    // existing precedent in this file: /api/completed-feed is also
    // publicly cached and already varies its response by `limit`/`cursor`
    // query params without any special handling.
    return new Response(JSON.stringify(document), {
      headers: {
        "content-type": "application/x-jpaint+json",
        "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
        "deno-cdn-cache-control": "public, s-maxage=86400",
        "content-disposition": attachmentDisposition(
          completed.title,
          canvasId,
          ".jpaint",
        ),
      },
    });
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

    if (!ensuredProfiles.has(session.guestId)) {
      const profile = await ensureProfile(getDb(), session.guestId, now);
      // Only checked the FIRST time per process for this guest, same as
      // ensureProfile()'s own last_seen_at touch above it — see
      // ensuredProfiles' doc comment. A session_epoch bump that lands
      // between two pushes from an already-warm process isn't caught
      // until the process restarts or this guest's memo entry is
      // otherwise cleared; that's a deliberate, documented gap traded for
      // not adding a query to the hottest mutation path in the app.
      assertSessionEpoch(session, profile);
      ensuredProfiles.add(session.guestId);
    }

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
    // author is ALWAYS derived here, server-side, from the authenticated
    // session's own profile — never from the request body (validateCompletion
    // above only ever reads `title`, so a client attempting to also send an
    // `author` field has it silently structurally dropped, not merely
    // overridden). This is the whole security property Phase 3.5 rests on:
    // nobody can sign a painting under someone else's name.
    const signer = await ensureProfile(getDb(), session.guestId, Date.now());
    assertSessionEpoch(session, signer);
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
    // Snapshot semantics, deliberately: this copies signer.handle as it is
    // RIGHT NOW into canvases.author. A later rename (PUT /api/me/handle)
    // must never retroactively change an already-signed painting's
    // author — see the schema comment on canvases.author and the
    // "author snapshot" test in tests/sync-routes_test.ts.
    const completed = await completeCanvas(
      getDb(),
      canvasId,
      body.title,
      signer.handle,
      now,
    );
    if (!completed) {
      return new Response("canvas is already signed", { status: 409 });
    }
    const { events } = await pullEventsSince(getDb(), canvasId, 0);
    const pixels = new Uint8Array(composeCanvas(events).buffer);
    await storeCanvasPixels(getDb(), canvasId, pixels);
    const record = await getCompletedCanvas(getDb(), canvasId);
    if (!record) throw new Error("completed canvas disappeared");
    const completedHead = await headSequence(getDb(), canvasId);
    getLiveHub().completed(publicCanvas(record), completedHead);
    displayFeedCache = null;
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

  if (
    url.pathname === "/dev/api/e2e/sign-simulated" && req.method === "POST" &&
    Deno.env.get("PAINTING_E2E") === "1"
  ) {
    const now = Date.now();
    await getDb().execute({
      sql:
        "UPDATE canvases SET title = 'Signed simulation', completed_at = ?, client_reported_active = 0 " +
        "WHERE owner_id LIKE 'e2e-live-%' AND completed_at IS NULL",
      args: [now],
    });
    const completed = await listCompletedByOwnerPrefix(getDb(), "e2e-live-");
    const events = await pullEventsForCanvases(
      getDb(),
      completed.map((canvas) => canvas.id),
    );
    const byCanvas = Map.groupBy(events, (event) => event.canvasId);
    for (const canvas of completed) {
      getLiveHub().completed(
        publicCanvas(canvas),
        byCanvas.get(canvas.id)?.at(-1)?.sequence ?? 0,
      );
    }
    return Response.json({ signed: completed.length });
  }

  if (Deno.env.get("PAINTING_E2E") === "1") {
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
  }

  if (url.pathname === "/datastar.js") {
    const ds = await Deno.readTextFile(publicFile("datastar.js"));
    return new Response(ds, {
      headers: staticHeaders("application/javascript"),
    });
  }

  // Content-hashed client/shared/css assets — see asset-manifest.ts for the
  // served-file enumeration (derived from the filesystem, not hand-listed)
  // and the hashing scheme. In dev mode the manifest is an identity map, so this
  // also serves the plain logical paths (/app.js, /shared/compose.js,
  // /base.css, ...) directly with no-store, same as always.
  const manifest = await getAssetManifest(isDevMode());
  const asset = manifest.byHashedPath.get(url.pathname);
  if (asset) {
    const body = await readAsset(asset);
    return new Response(
      body,
      manifest.devMode
        ? {
          headers: {
            "content-type": asset.contentType,
            "cache-control": "no-store",
          },
        }
        : { headers: staticHeaders(asset.contentType, true) },
    );
  }

  if (url.pathname === "/asset-manifest.json") {
    return Response.json(
      {
        manifestDigest: manifest.manifestDigest,
        assets: Object.fromEntries(
          manifest.entries.map((
            entry,
          ) => [entry.logicalPath, entry.hashedPath]),
        ),
      },
      { headers: { "cache-control": "no-cache" } },
    );
  }

  if (url.pathname === "/manifest.webmanifest") {
    const text = await Deno.readTextFile(publicFile("manifest.webmanifest"));
    return new Response(text, {
      headers: staticHeaders("application/manifest+json"),
    });
  }

  const iconMatch = url.pathname.match(/^\/icons\/([a-z0-9-]+\.png)$/);
  if (iconMatch) {
    const png = await Deno.readFile(publicFile(`icons/${iconMatch[1]}`));
    return new Response(png, { headers: staticHeaders("image/png") });
  }

  // Not part of the four navigable pages, so it's not in the `page` Map
  // above (no guest session needed for an offline fallback), but it still
  // needs the same content-hashed asset rewrite as those pages — its own
  // <link rel="stylesheet" href="/base.css"> would 404 in production
  // otherwise, since Phase 0.5 stopped serving unhashed logical paths.
  if (url.pathname === "/offline.html" && req.method === "GET") {
    const html = await renderPage("offline.html", manifest);
    return new Response(html, { headers: htmlHeaders() });
  }

  // The service worker and its statically-imported routing module. Both
  // MUST be served unhashed at a fixed URL — a service worker has no
  // import map to redirect a relative specifier through — and with
  // Cache-Control: no-cache, which is what makes the browser's byte-level
  // update check on /sw.js actually notice a new version was deployed.
  // Service-Worker-Allowed grants root scope explicitly, matching the
  // manifest's "scope": "/" (already implied since this route serves from
  // "/", but explicit is cheap insurance against a future path change).
  if (url.pathname === "/sw.js") {
    const source = await Deno.readTextFile(clientFile("sw.js"));
    return new Response(source, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
        "service-worker-allowed": "/",
      },
    });
  }

  if (url.pathname === "/sw-routing.js") {
    const source = await Deno.readTextFile(clientFile("sw-routing.js"));
    return new Response(source, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-cache",
      },
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
  assertSigningKeysConfigured();
  const configuredPort = Number(Deno.env.get("PORT") ?? "8000");
  Deno.serve({ automaticCompression: true, port: configuredPort }, handler);
}
