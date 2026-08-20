// @ts-check

/** @typedef {import("./paint-types.d.ts").CanvasSnapshotRecord} CanvasSnapshotRecord */
/** @typedef {import("./paint-types.d.ts").LocalEventRecord} LocalEventRecord */
/** @typedef {import("./paint-types.d.ts").CanvasLocalRecord} CanvasLocalRecord */
/** @typedef {import("./paint-types.d.ts").CanvasHistoryRecord} CanvasHistoryRecord */

const DB_NAME = "painting-local";
const DB_VERSION = 1;

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
    request.onupgradeneeded = () => {
      const db = request.result;

      db.createObjectStore("canvas_snapshot", { keyPath: "canvasId" });

      const localEvents = db.createObjectStore("local_events", {
        keyPath: "localKey",
        autoIncrement: true,
      });
      localEvents.createIndex("by_canvas_status", ["canvasId", "status"]);

      const canvasesLocal = db.createObjectStore("canvases_local", { keyPath: "id" });
      canvasesLocal.createIndex("by_owner_completed", ["ownerId", "completedAt"]);

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
    const index = store(db, "local_events", "readonly").index("by_canvas_status");
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
 * @param {Array<{ localKey: number, sequence: number | null }>} acked
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
    if (keepHistory && sequence !== null) {
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
  return new Promise((resolve, reject) => {
    const index = store(db, "canvases_local", "readonly").index("by_owner_completed");
    const range = IDBKeyRange.bound([ownerId, 0], [ownerId, Infinity]);
    /** @type {CanvasLocalRecord[]} */
    const results = [];
    const request = index.openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(results);
      results.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
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
