// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").CanvasSnapshotRecord} CanvasSnapshotRecord */
/** @typedef {import("../shared/paint-types.d.ts").LocalEventRecord} LocalEventRecord */
/** @typedef {import("../shared/paint-types.d.ts").CanvasLocalRecord} CanvasLocalRecord */
/** @typedef {import("../shared/paint-types.d.ts").CanvasHistoryRecord} CanvasHistoryRecord */

const DB_NAME = "painting-local";
const DB_VERSION = 3;

/** @param {IDBRequest} request @returns {Promise<any>} */
function toPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @returns {Promise<IDBDatabase>} */
export function openLocalDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    // Pre-production, no real users yet: every upgrade unconditionally
    // rebuilds every object store from scratch instead of branching per
    // oldVersion (the v1->v2 index-swap this replaced was already getting
    // awkward at just one prior version). This DROPS any existing
    // local_events/canvases_local/canvas_snapshot/canvas_history content —
    // i.e. it wipes unsynced local strokes for anyone with an existing
    // local DB (in practice, this project's own dev browser) — which is an
    // acceptable, deliberate simplification pre-prod, not something to
    // repeat once real users exist.
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of [...db.objectStoreNames]) {
        db.deleteObjectStore(name);
      }
      db.createObjectStore("canvas_snapshot", { keyPath: "canvasId" });
      const localEvents = db.createObjectStore("local_events", {
        keyPath: "localKey",
        autoIncrement: true,
      });
      localEvents.createIndex("by_canvas_status", ["canvasId", "status"]);
      const canvasesLocal = db.createObjectStore("canvases_local", {
        keyPath: "id",
      });
      canvasesLocal.createIndex("by_completed", "completedAt");
      const canvasHistory = db.createObjectStore("canvas_history", {
        keyPath: ["canvasId", "sequence"],
      });
      canvasHistory.createIndex("by_canvas", "canvasId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @param {IDBDatabase} db @param {string} storeName @param {IDBTransactionMode} mode */
function store(db, storeName, mode) {
  return db.transaction(storeName, mode).objectStore(storeName);
}

/** @param {IDBDatabase} db @param {CanvasSnapshotRecord} snapshot */
export function putSnapshot(db, snapshot) {
  return toPromise(store(db, "canvas_snapshot", "readwrite").put(snapshot));
}

/** @param {IDBDatabase} db @param {string} canvasId @returns {Promise<CanvasSnapshotRecord | undefined>} */
export function getSnapshot(db, canvasId) {
  return toPromise(store(db, "canvas_snapshot", "readonly").get(canvasId));
}

/**
 * Appends a locally-drawn event to the outbox. Always the first write for any
 * stroke/undo/complete action — synchronous to the render path is the
 * caller's job; this call itself is async and must never block painting.
 * @param {IDBDatabase} db @param {Omit<LocalEventRecord, "localKey" | "status">} event
 * @returns {Promise<number>} the assigned localKey
 */
export function appendLocalEvent(db, event) {
  return toPromise(
    store(db, "local_events", "readwrite").add({ ...event, status: "pending" }),
  );
}

/** @param {IDBDatabase} db @param {string} canvasId @returns {Promise<LocalEventRecord[]>} */
export function listPendingLocalEvents(db, canvasId) {
  return new Promise((resolve, reject) => {
    const index = store(db, "local_events", "readonly").index(
      "by_canvas_status",
    );
    const range = IDBKeyRange.only([canvasId, "pending"]);
    /** @type {LocalEventRecord[]} */
    const results = [];
    const request = index.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Marks local events as synced, and — for canvases being kept as a permanent
 * offline replay cache — copies each into canvas_history at its
 * server-assigned sequence instead of just deleting it. Pass `history: null`
 * to simply delete synced events for canvases that aren't cached.
 * @param {IDBDatabase} db
 * @param {Array<{ localKey: number, sequence: number }>} acked
 * @param {string} canvasId
 * @param {boolean} keepHistory
 */
export async function markSyncedAndGraduate(db, acked, canvasId, keepHistory) {
  const tx = db.transaction(["local_events", "canvas_history"], "readwrite");
  const localEvents = tx.objectStore("local_events");
  const history = tx.objectStore("canvas_history");

  for (const { localKey, sequence } of acked) {
    const record = await toPromise(localEvents.get(localKey));
    if (!record) continue;
    if (keepHistory) {
      history.put({
        canvasId,
        sequence,
        id: record.id,
        kind: record.kind,
        strokeId: record.strokeId,
        cells: record.cells,
        revertsId: record.revertsId,
        clientTs: record.clientTs,
        receivedAt: Date.now(),
      });
    }
    localEvents.delete(localKey);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {IDBDatabase} db @param {CanvasLocalRecord} record */
export function upsertCanvasLocal(db, record) {
  return toPromise(store(db, "canvases_local", "readwrite").put(record));
}

/** @param {IDBDatabase} db @param {string} ownerId @returns {Promise<CanvasLocalRecord[]>} */
export function listMyGallery(db, ownerId) {
  void ownerId;
  return listCachedCompleted(db);
}

/** @param {IDBDatabase} db @returns {Promise<CanvasLocalRecord[]>} */
export function listCachedCompleted(db) {
  return new Promise((resolve, reject) => {
    const index = store(db, "canvases_local", "readonly").index(
      "by_completed",
    );
    /** @type {CanvasLocalRecord[]} */
    const results = [];
    const request = index.openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/** @param {IDBDatabase} db @param {string} canvasId */
export function deleteCanvasLocal(db, canvasId) {
  const tx = db.transaction(
    ["canvases_local", "canvas_snapshot", "canvas_history", "local_events"],
    "readwrite",
  );
  tx.objectStore("canvases_local").delete(canvasId);
  tx.objectStore("canvas_snapshot").delete(canvasId);
  const history = tx.objectStore("canvas_history").index("by_canvas");
  history.openKeyCursor(IDBKeyRange.only(canvasId)).onsuccess = (event) => {
    const cursor = /** @type {IDBRequest} */ (event.target).result;
    if (cursor) {
      tx.objectStore("canvas_history").delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  for (const status of ["pending", "synced"]) {
    const events = tx.objectStore("local_events").index("by_canvas_status");
    events.openKeyCursor(IDBKeyRange.only([canvasId, status])).onsuccess = (
      event,
    ) => {
      const cursor = /** @type {IDBRequest} */ (event.target).result;
      if (cursor) {
        tx.objectStore("local_events").delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Every still-unsynced event across EVERY canvas, grouped by canvas id.
 * listPendingLocalEvents() above answers "what does this canvas still owe
 * the server," which is all a running editor needs; this answers "does this
 * device still owe the server anything at all," which is what sign-out has
 * to know before it is allowed to erase local storage. There is no index
 * for "pending, any canvas" — the by_canvas_status index is keyed
 * [canvasId, status] — so this walks the store. That is fine: it runs once,
 * on an explicit user action, over an outbox that is empty in the normal
 * case.
 * @param {IDBDatabase} db
 * @returns {Promise<Map<string, LocalEventRecord[]>>}
 */
export function listAllPendingLocalEvents(db) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, LocalEventRecord[]>} */
    const byCanvas = new Map();
    const request = store(db, "local_events", "readonly").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(byCanvas);
      const record = /** @type {LocalEventRecord} */ (cursor.value);
      if (record.status === "pending") {
        const existing = byCanvas.get(record.canvasId);
        if (existing) existing.push(record);
        else byCanvas.set(record.canvasId, [record]);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Moves this canvas's still-unsynced events onto a different canvas id.
 * Used when the server refuses a preferred draft id (see sync.js's
 * resolveDraftConflict): the strokes are the user's real work and are still
 * wanted, but the id they were recorded against turned out to belong to
 * someone else, so they have to be replayed onto the draft the server
 * actually granted. Only "pending" events move — a synced event is already
 * on the server under the old canvas and is not ours to re-push.
 * @param {IDBDatabase} db @param {string} fromCanvasId @param {string} toCanvasId
 * @returns {Promise<number>} how many events were moved
 */
export function rekeyPendingLocalEvents(db, fromCanvasId, toCanvasId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("local_events", "readwrite");
    const index = tx.objectStore("local_events").index("by_canvas_status");
    let moved = 0;
    index.openCursor(IDBKeyRange.only([fromCanvasId, "pending"])).onsuccess = (
      event,
    ) => {
      const cursor = /** @type {IDBRequest<IDBCursorWithValue>} */ (
        event.target
      ).result;
      if (!cursor) return;
      cursor.update({ ...cursor.value, canvasId: toCanvasId });
      moved++;
      cursor.continue();
    };
    tx.oncomplete = () => resolve(moved);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Empties every store. This is the sign-out teardown: local painting state
 * is scoped to whoever was signed in, and none of it is scoped BY profile
 * — there is no owner column on any of these stores, and by design the
 * client is never told an owner id it could put in one. So the only correct
 * thing to do when the profile changes out from under it is to drop the lot.
 * Callers must push anything still pending first (see sync.js's
 * flushPendingLocalEvents) — this is unconditional destruction.
 * @param {IDBDatabase} db
 */
export function clearAllLocal(db) {
  const names = [
    "canvases_local",
    "canvas_snapshot",
    "canvas_history",
    "local_events",
  ];
  const tx = db.transaction(names, "readwrite");
  for (const name of names) tx.objectStore(name).clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Seeds canvas_history with a canvas's server-side event log — used after
 * a Phase 4 sign-in/merge adopts a draft this device has never painted on
 * locally (the account's pre-existing draft, kept over the device's own),
 * so initSync()'s local-first load (see sync.js) already has the right
 * history without waiting on a live sync round trip. See
 * collection-page.js's post-merge cleanup.
 * @param {IDBDatabase} db @param {CanvasHistoryRecord[]} records
 */
export function seedCanvasHistory(db, records) {
  const tx = db.transaction("canvas_history", "readwrite");
  const history = tx.objectStore("canvas_history");
  for (const record of records) history.put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {IDBDatabase} db @param {string} canvasId @returns {Promise<CanvasHistoryRecord[]>} */
export function getFullHistory(db, canvasId) {
  return new Promise((resolve, reject) => {
    const index = store(db, "canvas_history", "readonly").index("by_canvas");
    /** @type {CanvasHistoryRecord[]} */
    const results = [];
    const request = index.openCursor(IDBKeyRange.only(canvasId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}
