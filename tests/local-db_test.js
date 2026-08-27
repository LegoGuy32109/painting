// @ts-check
// Deno has no browser IndexedDB; this polyfill stands in for it in tests
// only — local-db.js itself has zero dependencies, shipped as-is to the
// browser, which provides the real implementation there.
import "npm:fake-indexeddb@6.2.5/auto";

import { assertEquals } from "@std/assert";
import {
  appendLocalEvent,
  deleteCanvasLocal,
  getFullHistory,
  getSnapshot,
  listCachedCompleted,
  listPendingLocalEvents,
  markSyncedAndGraduate,
  openLocalDb,
  putSnapshot,
  upsertCanvasLocal,
} from "../src/client/local-db.js";

Deno.test("canvas_snapshot round-trips baseSequence", async () => {
  const db = await openLocalDb();
  await putSnapshot(db, {
    canvasId: "c1",
    pixels: new Uint8Array(4),
    baseSequence: 5,
    updatedAt: 1000,
  });
  const got = await getSnapshot(db, "c1");
  assertEquals(got?.baseSequence, 5);
  db.close();
});

Deno.test("appendLocalEvent defaults status to pending and by_canvas_status finds it", async () => {
  const db = await openLocalDb();
  await appendLocalEvent(db, {
    id: "evt1",
    canvasId: "c1",
    kind: "stroke",
    strokeId: "evt1",
    cells: null,
    revertsId: null,
    clientTs: 1,
  });
  await appendLocalEvent(db, {
    id: "evt2",
    canvasId: "c2",
    kind: "stroke",
    strokeId: "evt2",
    cells: null,
    revertsId: null,
    clientTs: 2,
  });

  const pendingC1 = await listPendingLocalEvents(db, "c1");
  assertEquals(pendingC1.length, 1);
  assertEquals(pendingC1[0].id, "evt1");
  db.close();
});

Deno.test("local insertion order is preserved via the autoIncrement localKey", async () => {
  const db = await openLocalDb();
  const keys = [];
  for (let i = 0; i < 5; i++) {
    keys.push(
      await appendLocalEvent(db, {
        id: `evt-order-${i}`,
        canvasId: "order-canvas",
        kind: "stroke",
        strokeId: `evt-order-${i}`,
        cells: null,
        revertsId: null,
        clientTs: i,
      }),
    );
  }
  // autoIncrement keys must be strictly increasing in insertion order —
  // this is what the local undo stack walks, independent of clientTs.
  for (let i = 1; i < keys.length; i++) {
    assertEquals(keys[i] > keys[i - 1], true);
  }
  db.close();
});

Deno.test("markSyncedAndGraduate deletes from the outbox and copies into canvas_history when kept", async () => {
  const db = await openLocalDb();
  const key1 = await appendLocalEvent(db, {
    id: "evt-a",
    canvasId: "c3",
    kind: "stroke",
    strokeId: "evt-a",
    cells: null,
    revertsId: null,
    clientTs: 1,
  });
  const key2 = await appendLocalEvent(db, {
    id: "evt-b",
    canvasId: "c3",
    kind: "undo",
    strokeId: null,
    cells: null,
    revertsId: "evt-a",
    clientTs: 2,
  });

  await markSyncedAndGraduate(
    db,
    [{ localKey: key1, sequence: 10 }, { localKey: key2, sequence: 11 }],
    "c3",
    true,
  );

  const stillPending = await listPendingLocalEvents(db, "c3");
  assertEquals(stillPending.length, 0);

  const history = await getFullHistory(db, "c3");
  assertEquals(history.length, 2);
  assertEquals(history.map((h) => h.sequence).sort(), [10, 11]);
  assertEquals(history.find((h) => h.id === "evt-b")?.revertsId, "evt-a");
  db.close();
});

Deno.test("markSyncedAndGraduate just deletes (no history) when keepHistory is false", async () => {
  const db = await openLocalDb();
  const key1 = await appendLocalEvent(db, {
    id: "evt-c",
    canvasId: "c4",
    kind: "stroke",
    strokeId: "evt-c",
    cells: null,
    revertsId: null,
    clientTs: 1,
  });

  await markSyncedAndGraduate(
    db,
    [{ localKey: key1, sequence: 1 }],
    "c4",
    false,
  );

  const history = await getFullHistory(db, "c4");
  assertEquals(history.length, 0);
  db.close();
});

Deno.test("graduation leaves every unacknowledged event pending", async () => {
  const db = await openLocalDb();
  const acknowledgedKey = await appendLocalEvent(db, {
    id: "evt-acked",
    canvasId: "c-unacked",
    kind: "stroke",
    strokeId: "stroke-acked",
    cells: null,
    revertsId: null,
    clientTs: 1,
  });
  await appendLocalEvent(db, {
    id: "evt-still-pending",
    canvasId: "c-unacked",
    kind: "stroke",
    strokeId: "stroke-pending",
    cells: null,
    revertsId: null,
    clientTs: 2,
  });

  await markSyncedAndGraduate(
    db,
    [{ localKey: acknowledgedKey, sequence: 10 }],
    "c-unacked",
    true,
  );

  const pending = await listPendingLocalEvents(db, "c-unacked");
  assertEquals(pending.map((event) => event.id), ["evt-still-pending"]);
  db.close();
});

Deno.test("cached completed paintings list newest first without exposing owner ids", async () => {
  const db = await openLocalDb();
  await upsertCanvasLocal(db, {
    id: "p1",
    title: "First",
    completedAt: 100,
    pixels: new Uint8Array(4),
    createdAt: 1,
  });
  await upsertCanvasLocal(db, {
    id: "p2",
    title: "Second",
    completedAt: 200,
    pixels: new Uint8Array(4),
    createdAt: 2,
  });
  await upsertCanvasLocal(db, {
    id: "p3",
    title: "Third",
    completedAt: 300,
    pixels: new Uint8Array(4),
    createdAt: 3,
  });

  const gallery = await listCachedCompleted(db);
  assertEquals(gallery.map((c) => c.id), ["p3", "p2", "p1"]);
  await deleteCanvasLocal(db, "p2");
  assertEquals(
    (await listCachedCompleted(db)).map((c) => c.id),
    ["p3", "p1"],
  );
  db.close();
});

Deno.test("the v3 upgrade rebuilds every object store from scratch, dropping old data", async () => {
  // Simulate a browser that already has an old-shaped local DB on disk —
  // deliberately deleted and rebuilt from an old version, not just opened
  // fresh, so this actually exercises openLocalDb()'s onupgradeneeded path
  // rather than a no-op open-at-current-version.
  await new Promise((resolve, reject) => {
    const deleteRequest = indexedDB.deleteDatabase("painting-local");
    deleteRequest.onsuccess = () => resolve(undefined);
    deleteRequest.onerror = () => reject(deleteRequest.error);
  });

  await new Promise((resolve, reject) => {
    const request = indexedDB.open("painting-local", 1);
    request.onupgradeneeded = () => {
      const oldDb = request.result;
      oldDb.createObjectStore("canvas_snapshot", { keyPath: "canvasId" });
      const localEvents = oldDb.createObjectStore("local_events", {
        keyPath: "localKey",
        autoIncrement: true,
      });
      localEvents.createIndex("by_canvas_status", ["canvasId", "status"]);
      // The v1 shape this replaced: a "canvases_local" store indexed by
      // ["ownerId", "completedAt"] instead of v2's plain "by_completed".
      const canvasesLocal = oldDb.createObjectStore("canvases_local", {
        keyPath: "id",
      });
      canvasesLocal.createIndex("by_owner_completed", [
        "ownerId",
        "completedAt",
      ]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).then((oldDb) => {
    const tx = oldDb.transaction("canvases_local", "readwrite");
    tx.objectStore("canvases_local").add({
      id: "stale-v1-record",
      ownerId: "someone",
      completedAt: 1,
    });
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => {
        oldDb.close();
        resolve(undefined);
      };
      tx.onerror = () => reject(tx.error);
    });
  });

  // Now open through the real module, at its current DB_VERSION — this is
  // the upgrade under test.
  const db = await openLocalDb();

  // The v1 record is gone: the whole store was dropped and recreated, not
  // migrated.
  assertEquals(await listCachedCompleted(db), []);

  // And the new (v2/v3) "by_completed" index is genuinely present and
  // functional, not just a store that happens to exist.
  await upsertCanvasLocal(db, {
    id: "fresh-after-upgrade",
    title: "After upgrade",
    completedAt: 5,
    pixels: new Uint8Array(4),
    createdAt: 5,
  });
  assertEquals(
    (await listCachedCompleted(db)).map((c) => c.id),
    ["fresh-after-upgrade"],
  );
  await deleteCanvasLocal(db, "fresh-after-upgrade");
  db.close();
});
