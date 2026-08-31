// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").PaintProgressDetail} PaintProgressDetail */
/** @typedef {import("../shared/paint-types.d.ts").StrokeCommittedDetail} StrokeCommittedDetail */
/** @typedef {import("../shared/paint-types.d.ts").UndoCommittedDetail} UndoCommittedDetail */
/** @typedef {import("../shared/paint-types.d.ts").LocalEventRecord} LocalEventRecord */
/** @typedef {import("../shared/paint-types.d.ts").PushEventsResponse} PushEventsResponse */
/** @typedef {import("../shared/paint-types.d.ts").EnsureDraftResponse} EnsureDraftResponse */
/** @typedef {import("../shared/paint-types.d.ts").SyncStatus} SyncStatus */

import {
  appendLocalEvent,
  deleteCanvasLocal,
  getFullHistory,
  listAllPendingLocalEvents,
  listPendingLocalEvents,
  markSyncedAndGraduate,
  openLocalDb,
  rekeyPendingLocalEvents,
} from "./local-db.js";
import { localUlid } from "../shared/ulid.js";
import { encodeCells } from "../shared/cell-codec.js";
import { composeCanvas } from "../shared/compose.js";
import { decodePixels } from "../shared/pixel-render.js";

const IDLE_TIMEOUT_MS = 30_000;
const SYNC_INTERVAL_MS = 4_000;
const PROGRESS_FLUSH_MS = 50;
const MAX_PUSH_EVENTS = 64;
const MAX_RETRY_MS = 60_000;

let DEBUG_TIMING = false;
try {
  DEBUG_TIMING = typeof localStorage !== "undefined" &&
    localStorage.getItem("paintDebugTiming") === "1";
} catch {
  // Storage access can be denied while the painting surface still works.
}

/** @param {string} label @param {Record<string, unknown>} data */
function debugTiming(label, data) {
  if (DEBUG_TIMING) console.debug(`[paint:sync] ${label}`, data);
}

/** @param {string} key @returns {string | null} */
function storedValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function storeValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // IndexedDB remains the authoritative local event store.
  }
}

/** @param {string} key */
function removeStoredValue(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // The signed server record remains authoritative.
  }
}

/** @param {Uint8Array} bytes @returns {string} */
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Pushes every still-unsynced event this device holds, across all canvases,
 * and reports whether the outbox ended up empty.
 *
 * Standalone on purpose: it is called from /collection's sign-out, where no
 * editor — and therefore no initSync() drain loop — exists at all, but
 * where local storage is about to be erased. Sign-out must not silently
 * throw away strokes the server has never seen.
 *
 * One pass, no retry loop and no backoff: the caller is a person waiting on
 * a button, so a failure here has to surface as "we could not save your
 * work, decide what you want to do" rather than as a spinner that retries
 * for a minute. A 4xx (a canvas this profile no longer owns) is permanent
 * and counts as failure too — those events can never be pushed, which is
 * precisely what the caller needs to be told before erasing them.
 * @returns {Promise<{ drained: boolean, remaining: number }>}
 */
export async function flushPendingLocalEvents() {
  const db = await openLocalDb().catch(() => null);
  if (!db) return { drained: true, remaining: 0 };
  let remaining = 0;
  const byCanvas = await listAllPendingLocalEvents(db).catch(() => null);
  if (!byCanvas) return { drained: false, remaining: -1 };

  for (const [canvasId, events] of byCanvas) {
    for (let offset = 0; offset < events.length; offset += MAX_PUSH_EVENTS) {
      const batch = events.slice(offset, offset + MAX_PUSH_EVENTS);
      try {
        const res = await fetch(`/canvases/${canvasId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            events: batch.map((event) => ({
              id: event.id,
              kind: event.kind,
              strokeId: event.strokeId,
              cells: event.cells ? bytesToBase64(event.cells) : null,
              revertsId: event.revertsId,
              clientTs: event.clientTs,
            })),
            heartbeatActive: false,
          }),
        });
        if (!res.ok) {
          remaining += events.length - offset;
          break;
        }
        const body = /** @type {PushEventsResponse} */ (await res.json());
        const bySequence = new Map(
          body.acknowledgments.map((ack) => [ack.id, ack.sequence]),
        );
        const acked = batch.flatMap((event) => {
          const sequence = bySequence.get(event.id);
          // A record read back out of the outbox always carries its
          // autoIncrement key; the type allows undefined only because the
          // same shape is used for not-yet-stored events on the way in.
          return sequence === undefined || event.localKey === undefined
            ? []
            : [{ localKey: event.localKey, sequence }];
        });
        await markSyncedAndGraduate(db, acked, canvasId, false);
        remaining += batch.length - acked.length;
      } catch {
        remaining += events.length - offset;
        break;
      }
    }
  }
  return { drained: remaining === 0, remaining };
}

/**
 * Sets up local persistence and server synchronization for one canvas.
 * @param {HTMLElement} canvasElement
 * @param {(status: SyncStatus) => void} [onStatus]
 */
export function initSync(canvasElement, onStatus = () => {}) {
  let canvasId = storedValue("currentCanvasId");
  if (!canvasId) {
    canvasId = localUlid();
    storeValue("currentCanvasId", canvasId);
  }
  canvasElement.setAttribute("canvas-id", canvasId);

  const canvas = /** @type {HTMLElement & {
     *   setReady?: (ready: boolean) => void,
     *   loadPixels?: (pixels: Int32Array) => void,
     *   setReadOnly?: (readOnly: boolean) => void
     * }} */
    (canvasElement);
  canvas.setReady?.(false);
  onStatus({ kind: "restoring", message: "Opening local painting" });

  const dbPromise = openLocalDb().catch((error) => {
    debugTiming("local database unavailable", { error: String(error) });
    return null;
  });
  /** @type {LocalEventRecord[]} */
  let memoryEvents = [];
  let memoryKey = -1;
  /** @type {{ localId: string, serverDraft: import("../shared/paint-types.d.ts").PublicCanvas } | null} */
  let draftConflict = null;

  const ready = (async () => {
    const db = await dbPromise;
    let restored = true;
    let restoredEventCount = 0;
    try {
      if (canvasId && db) {
        const [history, pending] = await Promise.all([
          getFullHistory(db, canvasId),
          listPendingLocalEvents(db, canvasId),
        ]);
        restoredEventCount = history.length + pending.length;
        canvas.loadPixels?.(composeCanvas([...history, ...pending]));
      }
    } catch (error) {
      restored = false;
      debugTiming("local restore failed", { error: String(error) });
    }

    try {
      const preferredId = canvasId;
      const response = await fetch("/api/me/draft", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: preferredId }),
      });
      if (!response.ok) {
        throw new Error(`draft registration failed: ${response.status}`);
      }
      const result = /** @type {EnsureDraftResponse} */ (await response.json());
      if (result.draft.id !== canvasId) {
        const pending = db && canvasId
          ? await listPendingLocalEvents(db, canvasId)
          : memoryEvents;
        if (pending.length > 0) {
          restored = false;
          draftConflict = {
            localId: /** @type {string} */ (canvasId),
            serverDraft: result.draft,
          };
          onStatus({
            kind: "blocked",
            message: "A saved draft and local changes both need recovery",
          });
          window.dispatchEvent(
            new CustomEvent("draft-conflict", {
              detail: {
                localId: canvasId,
                serverId: result.draft.id,
              },
            }),
          );
        } else {
          canvasId = result.draft.id;
          storeValue("currentCanvasId", canvasId);
          canvasElement.setAttribute("canvas-id", canvasId);
          canvas.loadPixels?.(decodePixels(result.draft.pixels));
        }
      } else if (restoredEventCount === 0) {
        canvas.loadPixels?.(decodePixels(result.draft.pixels));
      }
    } catch (error) {
      debugTiming("draft registration unavailable", { error: String(error) });
    }
    canvas.setReady?.(true);
    if (db && restored) {
      onStatus({
        kind: navigator.onLine ? "local" : "offline",
        message: navigator.onLine
          ? "Online; saved on this device"
          : "Offline; saved locally",
      });
      void navigator.storage?.persist?.().catch(() => false);
    } else {
      onStatus({
        kind: "blocked",
        message: db
          ? "Could not restore local changes"
          : "Local storage unavailable; keep this page open",
      });
    }
  })();

  /** @type {Map<string, Array<[number, number]>>} */
  const strokeBuffers = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const flushTimers = new Map();
  let heartbeatActive = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let idleTimer = null;
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
    storeValue("currentCanvasId", canvasId);
    canvasElement.setAttribute("canvas-id", canvasId);
  }

  /** @param {Omit<LocalEventRecord, "localKey" | "status">} event */
  async function appendEvent(event) {
    const db = await dbPromise;
    let stored = false;
    if (db) {
      try {
        await appendLocalEvent(db, event);
        stored = true;
      } catch (error) {
        debugTiming("local write failed", { error: String(error) });
      }
    }
    if (!stored) {
      memoryEvents.push({ ...event, status: "pending", localKey: memoryKey-- });
    }
    onStatus(
      stored
        ? {
          kind: navigator.onLine ? "local" : "offline",
          message: navigator.onLine
            ? "Online; saved on this device"
            : "Offline; saved locally",
        }
        : {
          kind: "blocked",
          message: "Local storage unavailable; keep this page open",
        },
    );
  }

  /** @param {string} id @returns {Promise<LocalEventRecord[]>} */
  async function pendingEvents(id) {
    const db = await dbPromise;
    if (!db) return [...memoryEvents];
    try {
      return [...await listPendingLocalEvents(db, id), ...memoryEvents];
    } catch (error) {
      debugTiming("local outbox read failed", { error: String(error) });
      return [...memoryEvents];
    }
  }

  /** @param {LocalEventRecord[]} pending @param {PushEventsResponse} response */
  async function graduate(pending, response) {
    const sequenceById = new Map(
      response.acknowledgments.map((ack) => [ack.id, ack.sequence]),
    );
    const acknowledged = pending.flatMap((event) => {
      const sequence = sequenceById.get(event.id);
      return event.localKey === undefined || sequence === undefined
        ? []
        : [{ localKey: event.localKey, sequence }];
    });
    if (acknowledged.length === 0 && pending.length > 0) {
      throw new Error("server did not acknowledge the pushed events");
    }
    const db = await dbPromise;
    if (db) {
      const durableAcknowledgments = acknowledged.filter((ack) =>
        ack.localKey >= 0
      );
      if (durableAcknowledgments.length > 0) {
        await markSyncedAndGraduate(
          db,
          durableAcknowledgments,
          canvasId || "",
          true,
        );
      }
    }
    const acknowledgedIds = new Set(
      response.acknowledgments.map((ack) => ack.id),
    );
    memoryEvents = memoryEvents.filter((event) =>
      !acknowledgedIds.has(event.id)
    );
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
    await appendEvent({
      id: localUlid(),
      canvasId,
      kind: "stroke",
      strokeId,
      cells: encodeCells(cells),
      revertsId: null,
      clientTs,
    });
    void requestDrain();
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
    await appendEvent({
      id: localUlid(),
      canvasId,
      kind: "undo",
      strokeId: null,
      cells: null,
      revertsId: event.detail.revertsId,
      clientTs: Date.now(),
    });
    void requestDrain();
  }

  let drainRequested = false;
  /** @type {Promise<boolean> | null} */
  let drainPromise = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let retryTimer = null;
  let retryAttempt = 0;
  let syncBlocked = false;

  function scheduleRetry() {
    if (retryTimer || syncBlocked || signed) return;
    const cap = Math.min(MAX_RETRY_MS, 1000 * 2 ** retryAttempt++);
    const delay = Math.round(cap / 2 + Math.random() * cap / 2);
    onStatus({
      kind: "retrying",
      message: `Network unavailable; retrying in ${Math.ceil(delay / 1000)}s`,
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void requestDrain(true);
    }, delay);
  }

  /** @returns {Promise<boolean>} */
  async function drainLoop() {
    await ready;
    while (drainRequested && !signed) {
      drainRequested = false;
      if (!canvasId) return true;
      if (!navigator.onLine) {
        onStatus({ kind: "offline", message: "Offline; saved locally" });
        return false;
      }

      const pending = (await pendingEvents(canvasId)).slice(0, MAX_PUSH_EVENTS);
      if (pending.length === 0) {
        retryAttempt = 0;
        onStatus({ kind: "synced", message: "Saved" });
        return true;
      }

      onStatus({ kind: "syncing", message: "Saving" });
      try {
        const pushStart = Date.now();
        const pushRes = await fetch(`/canvases/${canvasId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            events: pending.map((event) => ({
              id: event.id,
              kind: event.kind,
              strokeId: event.strokeId,
              cells: event.cells ? bytesToBase64(event.cells) : null,
              revertsId: event.revertsId,
              clientTs: event.clientTs,
            })),
            heartbeatActive,
          }),
        });
        debugTiming("push done", {
          durationMs: Date.now() - pushStart,
          status: pushRes.status,
        });
        if (pushRes.status >= 400 && pushRes.status < 500) {
          syncBlocked = true;
          onStatus({
            kind: "blocked",
            message: pushRes.status === 409
              ? "This painting is already signed"
              : "Saving blocked; reload to restore your guest profile",
          });
          return false;
        }
        if (!pushRes.ok) throw new Error(`push failed with ${pushRes.status}`);
        const response =
          /** @type {PushEventsResponse} */ (await pushRes.json());
        await graduate(pending, response);
        retryAttempt = 0;
        drainRequested = true;
      } catch (error) {
        debugTiming("push error", { error: String(error) });
        drainRequested = true;
        scheduleRetry();
        return false;
      }
    }
    return true;
  }

  /** @param {boolean} [force] @returns {Promise<boolean>} */
  function requestDrain(force = false) {
    drainRequested = true;
    if (syncBlocked && !force) return Promise.resolve(false);
    if (force) syncBlocked = false;
    if (retryTimer && !force) return Promise.resolve(false);
    if (force && retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (drainPromise) return drainPromise;
    drainPromise = drainLoop().finally(() => {
      drainPromise = null;
      if (drainRequested && !retryTimer && !syncBlocked && !signed) {
        void requestDrain();
      }
    });
    return drainPromise;
  }

  /** @param {string} title @returns {Promise<boolean>} */
  async function sign(title) {
    if (!canvasId || signed) return false;
    await ready;
    await Promise.all([...strokeBuffers.keys()].map(flushStroke));
    const drained = await requestDrain(true);
    if (!drained || (await pendingEvents(canvasId)).length > 0) {
      onStatus({
        kind: navigator.onLine ? "retrying" : "offline",
        message: navigator.onLine
          ? "Finish saving before signing"
          : "Go online before signing",
      });
      return false;
    }

    try {
      const res = await fetch(`/canvases/${canvasId}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        onStatus({ kind: "blocked", message: "Could not sign this painting" });
        return false;
      }
    } catch {
      scheduleRetry();
      return false;
    }

    signed = true;
    heartbeatActive = false;
    removeStoredValue("currentCanvasId");
    canvas.setReadOnly?.(true);
    onStatus({ kind: "signed", message: "Signed and saved" });
    return true;
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

  setInterval(() => void requestDrain(), SYNC_INTERVAL_MS);
  addEventListener("online", () => {
    onStatus({ kind: "local", message: "Online; saving local changes" });
    void requestDrain(true);
  });
  addEventListener("offline", () => {
    onStatus({ kind: "offline", message: "Offline; saved locally" });
  });

  function flushBufferedStrokes() {
    for (const strokeId of strokeBuffers.keys()) void flushStroke(strokeId);
  }

  function sendInactiveBeacon() {
    heartbeatActive = false;
    flushBufferedStrokes();
    if (!canvasId || !navigator.onLine || signed) return;
    navigator.sendBeacon(
      `/canvases/${canvasId}/events`,
      new Blob(
        [JSON.stringify({ events: [], heartbeatActive: false })],
        { type: "application/json" },
      ),
    );
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushBufferedStrokes();
  });
  addEventListener("pagehide", sendInactiveBeacon);

  /** @param {"server" | "local"} choice */
  async function resolveDraftConflict(choice) {
    await ready;
    if (!draftConflict) return true;
    const conflict = draftConflict;
    const db = await dbPromise;
    if (choice === "server") {
      if (db) await deleteCanvasLocal(db, conflict.localId);
      memoryEvents = memoryEvents.filter((event) =>
        event.canvasId !== conflict.localId
      );
      canvasId = conflict.serverDraft.id;
      storeValue("currentCanvasId", canvasId);
      canvasElement.setAttribute("canvas-id", canvasId);
      canvas.loadPixels?.(decodePixels(conflict.serverDraft.pixels));
      draftConflict = null;
      syncBlocked = false;
      onStatus({ kind: "local", message: "Online; saved draft restored" });
      return true;
    }

    const removed = await fetch("/api/me/draft", { method: "DELETE" });
    if (!removed.ok) return false;
    const registered = await fetch("/api/me/draft", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: conflict.localId }),
    });
    if (!registered.ok) return false;
    // Use the id the server GRANTED, never the one we asked for. Deleting
    // our own draft above usually frees the preferred id, so it is normally
    // granted — but not when that id already belongs to a DIFFERENT
    // profile, which is exactly the state a device is in after signing out
    // with local work still on it. Assuming the preferred id was accepted
    // pointed the editor at a canvas this profile does not own, and every
    // subsequent push 403'd forever with the user's strokes stuck in the
    // outbox. acceptedPreferredId exists to tell us this; honour it.
    const result = /** @type {EnsureDraftResponse} */ (await registered.json());
    const grantedId = result.draft.id;
    if (grantedId !== conflict.localId) {
      const db2 = await dbPromise;
      if (db2) {
        // The strokes are still the user's work and still wanted — replay
        // them onto the draft we actually got. The old canvas's synced
        // history is not ours to keep: it describes a canvas owned by
        // someone else, and leaving it behind is what renders a stranger's
        // painting into this editor on the next load.
        await rekeyPendingLocalEvents(db2, conflict.localId, grantedId);
        await deleteCanvasLocal(db2, conflict.localId);
      }
      for (const event of memoryEvents) {
        if (event.canvasId === conflict.localId) event.canvasId = grantedId;
      }
    }
    canvasId = grantedId;
    storeValue("currentCanvasId", canvasId);
    canvasElement.setAttribute("canvas-id", canvasId);
    draftConflict = null;
    syncBlocked = false;
    onStatus({ kind: "syncing", message: "Saving recovered local draft" });
    return await requestDrain(true);
  }

  return { sign, ready, resolveDraftConflict };
}
