// @ts-check
// Deno has no browser IndexedDB; this polyfill stands in for it in tests
// only — local-db.js itself has zero dependencies, shipped as-is to the
// browser, which provides the real implementation there.
import "npm:fake-indexeddb@6.2.5/auto";

import { assertEquals } from "@std/assert";
import {
  appendLocalEvent,
  getFullHistory,
  getSnapshot,
  listMyGallery,
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

  await markSyncedAndGraduate(db, [{ localKey: key1, sequence: 1 }], "c4", false);

  const history = await getFullHistory(db, "c4");
  assertEquals(history.length, 0);
  db.close();
});

Deno.test("by_owner_completed lists a gallery newest-completed-first, scoped to the owner", async () => {
  const db = await openLocalDb();
  await upsertCanvasLocal(db, {
    id: "p1",
    title: "First",
    completedAt: 100,
    pixels: new Uint8Array(4),
    ownerId: "owner-x",
    createdAt: 1,
  });
  await upsertCanvasLocal(db, {
    id: "p2",
    title: "Second",
    completedAt: 200,
    pixels: new Uint8Array(4),
    ownerId: "owner-x",
    createdAt: 2,
  });
  await upsertCanvasLocal(db, {
    id: "p3",
    title: "Someone else's",
    completedAt: 300,
    pixels: new Uint8Array(4),
    ownerId: "owner-y",
    createdAt: 3,
  });

  const gallery = await listMyGallery(db, "owner-x");
  assertEquals(gallery.map((c) => c.id), ["p2", "p1"]);
  db.close();
});
