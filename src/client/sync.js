// @ts-check

/** @typedef {import("./paint-types.d.ts").PaintProgressDetail} PaintProgressDetail */
/** @typedef {import("./paint-types.d.ts").StrokeCommittedDetail} StrokeCommittedDetail */
/** @typedef {import("./paint-types.d.ts").UndoCommittedDetail} UndoCommittedDetail */
/** @typedef {import("./paint-types.d.ts").LocalEventRecord} LocalEventRecord */

import {
  appendLocalEvent,
  getFullHistory,
  listPendingLocalEvents,
  markSyncedAndGraduate,
  openLocalDb,
} from "./local-db.js";
import { localUlid } from "./ulid.js";
import { encodeCells } from "./cell-codec.js";
import { composeCanvas } from "./compose.js";

const IDLE_TIMEOUT_MS = 30_000;
const SYNC_INTERVAL_MS = 4_000;
// This is the actual temporal resolution of replay: each flush becomes its
// own canvas_events row, stamped with one client_ts covering exactly this
// window's cells. There's no separate per-cell timestamp — a batch's own
// client_ts already means "these pixels changed in this window," so
// finer replay fidelity comes from making the window smaller, not from a
// new field. Multiple flushed batches still travel together in one network
// push whenever the outbox is behind (see drainOutbox) — tightening this
// doesn't add HTTP round trips, just makes each recorded row more precise.
const PROGRESS_FLUSH_MS = 50;

// Opt-in timing trace for tuning replay smoothness against /dev/active — off
// by default so ordinary painters never see it. Enable from devtools with
// `localStorage.setItem("paintDebugTiming", "1")`, then reload.
const DEBUG_TIMING = typeof localStorage !== "undefined" &&
  localStorage.getItem("paintDebugTiming") === "1";
/** @param {string} label @param {Record<string, unknown>} data */
function debugTiming(label, data) {
  if (DEBUG_TIMING) console.debug(`[paint:sync] ${label}`, data);
}

/** @param {string} key @returns {string} */
function getOrCreatePersistentId(key) {
  let id = localStorage.getItem(key);
  if (!id) {
    id = localUlid();
    localStorage.setItem(key, id);
  }
  return id;
}

/** @param {Uint8Array} bytes @returns {string} */
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Sets up the outbox pipeline (paint events -> IndexedDB outbox -> server),
 * the client-liveness heartbeat, and the sign flow, for one canvas element.
 * @param {HTMLElement} canvasElement
 */
export function initSync(canvasElement) {
  const ownerId = getOrCreatePersistentId("ownerId");
  let canvasId = localStorage.getItem("currentCanvasId");
  if (canvasId) canvasElement.setAttribute("canvas-id", canvasId);

  const dbPromise = openLocalDb();

  // Restore a painting-in-progress on load — the client previously only
  // remembered the canvas id, not its pixels, so refreshing looked like it
  // wiped the painting even though the server (and local_events/
  // canvas_history) had the full history the whole time.
  if (canvasId) {
    const id = canvasId;
    void (async () => {
      const db = await dbPromise;
      const [history, pending] = await Promise.all([
        getFullHistory(db, id),
        listPendingLocalEvents(db, id),
      ]);
      const pixels = composeCanvas([...history, ...pending]);
      const restorable = /** @type {{ loadPixels?: (p: Int32Array) => void }} */ (canvasElement);
      restorable.loadPixels?.(pixels);
    })();
  }

  /** @type {Map<string, Array<[number, number]>>} */
  const strokeBuffers = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const flushTimers = new Map();
  let heartbeatActive = false;
  let headSequence = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;
  let syncing = false;
  let signed = false;

  function markActive() {
    heartbeatActive = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      heartbeatActive = false;
    }, IDLE_TIMEOUT_MS);
  }

  function ensureCanvasId() {
    if (canvasId) return;
    canvasId = localUlid();
    localStorage.setItem("currentCanvasId", canvasId);
    canvasElement.setAttribute("canvas-id", canvasId);
  }

  /** @param {string} strokeId */
  async function flushStroke(strokeId) {
    const timer = flushTimers.get(strokeId);
    if (timer) {
      clearTimeout(timer);
      flushTimers.delete(strokeId);
    }
    const cells = strokeBuffers.get(strokeId);
    strokeBuffers.delete(strokeId);
    if (!cells || cells.length === 0 || !canvasId) return;

    const clientTs = Date.now();
    debugTiming("flush", { strokeId, cellCount: cells.length, clientTs });

    const db = await dbPromise;
    await appendLocalEvent(db, {
      id: localUlid(),
      canvasId,
      kind: "stroke",
      strokeId,
      cells: encodeCells(cells),
      revertsId: null,
      clientTs,
    });
    void drainOutbox();
  }

  /** @param {CustomEvent<PaintProgressDetail>} event */
  function onPaintProgress(event) {
    ensureCanvasId();
    const { strokeId, cells } = event.detail;
    const existing = strokeBuffers.get(strokeId) ?? [];
    existing.push(...cells);
    strokeBuffers.set(strokeId, existing);
    markActive();
    if (!flushTimers.has(strokeId)) {
      flushTimers.set(
        strokeId,
        setTimeout(() => void flushStroke(strokeId), PROGRESS_FLUSH_MS),
      );
    }
  }

  /** @param {CustomEvent<StrokeCommittedDetail>} event */
  async function onStrokeCommitted(event) {
    await flushStroke(event.detail.strokeId);
  }

  /** @param {CustomEvent<UndoCommittedDetail>} event */
  async function onUndoCommitted(event) {
    if (!canvasId) return;
    const { revertsId } = event.detail;
    const db = await dbPromise;
    await appendLocalEvent(db, {
      id: localUlid(),
      canvasId,
      kind: "undo",
      strokeId: null,
      cells: null,
      revertsId,
      clientTs: Date.now(),
    });
    void drainOutbox();
  }

  // A round trip through drainOutbox is two sequential requests (push, then
  // a self-resync pull) — easily >150ms, longer than the flush cadence that
  // triggers it. Simply bailing while `syncing` is true (the old behavior)
  // silently dropped every flush that landed mid-round-trip, with only the
  // 4s SYNC_INTERVAL_MS fallback left to catch up — which is what produced
  // multi-second batches arriving as one big jump instead of a smooth
  // stream. `dirty` makes a flush that arrives mid-drain schedule exactly
  // one more drain immediately after the current one finishes, instead of
  // disappearing.
  let dirty = false;

  async function drainOutbox() {
    if (!canvasId || !navigator.onLine) return;
    if (syncing) {
      dirty = true;
      return;
    }
    syncing = true;
    dirty = false;
    try {
      const id = canvasId;
      const db = await dbPromise;
      const pending = await listPendingLocalEvents(db, id);
      if (pending.length === 0) return;

      const pushStart = Date.now();
      const oldestClientTs = Math.min(...pending.map((e) => e.clientTs));
      debugTiming("push start", {
        pendingCount: pending.length,
        oldestBacklogMs: pushStart - oldestClientTs,
      });

      const pushRes = await fetch(`/canvases/${id}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-owner-id": ownerId },
        body: JSON.stringify({
          events: pending.map((e) => ({
            id: e.id,
            kind: e.kind,
            strokeId: e.strokeId,
            cells: e.cells ? bytesToBase64(e.cells) : null,
            revertsId: e.revertsId,
            clientTs: e.clientTs,
          })),
          heartbeatActive,
        }),
      });
      debugTiming("push done", {
        durationMs: Date.now() - pushStart,
        ok: pushRes.ok,
      });
      if (!pushRes.ok) {
        dirty = true;
        return;
      }

      // Self-resync (learns each event's server-assigned sequence, for
      // offline-replay graduation) is fire-and-forget: it must not gate the
      // next drain, or it reintroduces the same round-trip-blocks-live-feel
      // problem this rewrite exists to fix.
      void resyncAndGraduate(id, pending);
    } catch (err) {
      debugTiming("push error", { error: String(err) });
      dirty = true;
    } finally {
      syncing = false;
      if (dirty) void drainOutbox();
    }
  }

  /**
   * @param {string} id
   * @param {LocalEventRecord[]} pending
   */
  async function resyncAndGraduate(id, pending) {
    try {
      const pullRes = await fetch(
        `/canvases/${id}/events?since=${headSequence}`,
        { headers: { "x-owner-id": ownerId } },
      );
      if (!pullRes.ok) return;
      /** @type {{ events: Array<{ id: string, sequence: number }>, headSequence: number }} */
      const pulled = await pullRes.json();
      headSequence = pulled.headSequence;
      const sequenceById = new Map(
        pulled.events.map((e) => [e.id, e.sequence]),
      );
      const acked = pending
        .filter((e) => e.localKey !== undefined)
        .map((e) => ({
          localKey: /** @type {number} */ (e.localKey),
          sequence: sequenceById.get(e.id) ?? null,
        }));
      const db = await dbPromise;
      await markSyncedAndGraduate(db, acked, id, true);
    } catch {
      // Graduation failed, but the push already succeeded — these events
      // stay "pending" locally and get re-pushed next drain, which is a
      // harmless no-op server-side (INSERT OR IGNORE on the same ids).
    }
  }

  /** @param {string} title */
  async function sign(title) {
    if (!canvasId || signed) return;
    await drainOutbox();
    const res = await fetch(`/canvases/${canvasId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": ownerId },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) return;
    signed = true;
    heartbeatActive = false;
    localStorage.removeItem("currentCanvasId");
    canvasElement.setAttribute("disabled", "");
    canvasElement.style.pointerEvents = "none";
  }

  canvasElement.addEventListener(
    "paint-progress",
    /** @type {EventListener} */ (onPaintProgress),
  );
  canvasElement.addEventListener(
    "stroke-committed",
    /** @type {EventListener} */ (/** @type {unknown} */ (onStrokeCommitted)),
  );
  canvasElement.addEventListener(
    "undo-committed",
    /** @type {EventListener} */ (/** @type {unknown} */ (onUndoCommitted)),
  );

  setInterval(drainOutbox, SYNC_INTERVAL_MS);
  addEventListener("online", drainOutbox);

  function sendInactiveBeacon() {
    heartbeatActive = false;
    if (!canvasId || !navigator.onLine) return;
    navigator.sendBeacon(
      `/canvases/${canvasId}/events`,
      new Blob(
        [JSON.stringify({ events: [], heartbeatActive: false, ownerId })],
        { type: "application/json" },
      ),
    );
  }
  // Watching /dev/active normally moves the painter into a background tab.
  // That is still a live session: its next stroke should stream to the
  // viewer. A real navigation-away/close, unlike blur, ends the session and
  // reports inactive immediately. Canvases abandoned without pagehide still
  // fall out of the feed through listActiveCanvases()' stroke-age timeout.
  addEventListener("pagehide", sendInactiveBeacon);

  return { sign };
}
