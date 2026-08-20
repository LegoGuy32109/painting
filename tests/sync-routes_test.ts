// Smoke tests for the sync-handshake HTTP routes, against a live database
// (TURSO_DB_URL/TURSO_DB_TOKEN — painting-local by default). Isolated from
// tests/main_test.ts (which requires no net/env perms) the same way
// tests/db_test.ts is isolated from the plain unit-test task.

import { assertEquals } from "@std/assert";
import { handler } from "../src/server/main.ts";
import { createDb } from "../src/server/db.ts";
import { ulid } from "../src/server/ulid.ts";
import { encodeCells } from "../src/client/cell-codec.js";

function cellsBase64(cells: Array<[number, number]>): string {
  const bytes = encodeCells(cells);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const db = createDb();

async function dropCanvas(id: string) {
  await db.execute({ sql: "DELETE FROM canvases WHERE id = ?", args: [id] });
}

function post(path: string, body: unknown, ownerId = "test-owner") {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-owner-id": ownerId },
      body: JSON.stringify(body),
    }),
  );
}

function get(path: string) {
  return handler(new Request(`http://localhost${path}`));
}

Deno.test("push lazily creates the canvas row and appends events", async () => {
  const canvasId = ulid();
  try {
    const strokeId = ulid();
    const res = await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: strokeId,
        kind: "stroke",
        cells: null,
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    assertEquals(res.status, 200);

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(pulled.headSequence > 0, true);
    assertEquals(pulled.events.length, 1);
    assertEquals(pulled.events[0].id, strokeId);

    const activeRes = await get("/dev/api/active");
    const active = await activeRes.json();
    assertEquals(
      active.canvases.some((c: { id: string }) => c.id === canvasId),
      true,
    );
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("a retried push with the same event id is a no-op (idempotent)", async () => {
  const canvasId = ulid();
  try {
    const event = {
      id: ulid(),
      kind: "stroke",
      cells: null,
      revertsId: null,
      clientTs: Date.now(),
    };
    await post(`/canvases/${canvasId}/events`, {
      events: [event],
      heartbeatActive: true,
    });
    await post(`/canvases/${canvasId}/events`, {
      events: [event],
      heartbeatActive: true,
    });

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(pulled.events.length, 1);
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("a heartbeat-only push (empty events) updates client_reported_active without inserting", async () => {
  const canvasId = ulid();
  try {
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        cells: null,
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    await post(`/canvases/${canvasId}/events`, {
      events: [],
      heartbeatActive: false,
    });

    const activeRes = await get("/dev/api/active");
    const active = await activeRes.json();
    assertEquals(
      active.canvases.some((c: { id: string }) => c.id === canvasId),
      false,
    );
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("sign sets title/completedAt, appends a complete event, and drops out of active", async () => {
  const canvasId = ulid();
  try {
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        cells: null,
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    const signRes = await post(`/canvases/${canvasId}/complete`, {
      title: "Route Smoke Test",
    });
    assertEquals(signRes.status, 200);

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(
      pulled.events.some((e: { kind: string }) => e.kind === "complete"),
      true,
    );

    const completedRes = await get("/dev/api/completed");
    const completed = await completedRes.json();
    const mine = completed.canvases.find((c: { id: string }) =>
      c.id === canvasId
    );
    assertEquals(mine?.title, "Route Smoke Test");
    assertEquals(mine?.completedAt !== null, true);

    const activeRes = await get("/dev/api/active");
    const active = await activeRes.json();
    assertEquals(
      active.canvases.some((c: { id: string }) => c.id === canvasId),
      false,
    );
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("an undo event carries revertsId pointing at the reverted stroke's id, and doesn't delete it", async () => {
  const canvasId = ulid();
  try {
    const strokeId = ulid();
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: strokeId,
        kind: "stroke",
        cells: null,
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "undo",
        cells: null,
        revertsId: strokeId,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(
      pulled.events.length,
      2,
      "the stroke event must still be present, untouched",
    );

    const strokeEvent = pulled.events.find((e: { id: string }) =>
      e.id === strokeId
    );
    assertEquals(strokeEvent.kind, "stroke");

    const undoEvent = pulled.events.find((e: { kind: string }) =>
      e.kind === "undo"
    );
    assertEquals(undoEvent.revertsId, strokeId);
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("a push from a different owner than the canvas's creator is rejected", async () => {
  const canvasId = ulid();
  try {
    await post(
      `/canvases/${canvasId}/events`,
      {
        events: [{
          id: ulid(),
          kind: "stroke",
          cells: null,
          revertsId: null,
          clientTs: Date.now(),
        }],
        heartbeatActive: true,
      },
      "owner-a",
    );
    const res = await post(
      `/canvases/${canvasId}/events`,
      {
        events: [{
          id: ulid(),
          kind: "stroke",
          cells: null,
          revertsId: null,
          clientTs: Date.now(),
        }],
        heartbeatActive: true,
      },
      "owner-b",
    );
    assertEquals(res.status, 403);

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(
      pulled.events.length,
      1,
      "the rejected push must not have been appended",
    );

    const signRes = await post(`/canvases/${canvasId}/complete`, {
      title: "Hijack Attempt",
    }, "owner-b");
    assertEquals(
      signRes.status,
      403,
      "a different owner must not be able to sign the canvas either",
    );
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("stroke cells round-trip through base64 over the wire", async () => {
  const canvasId = ulid();
  try {
    // index 5, ARGB color -1 (0xFFFFFFFF as int32), encoded as the client
    // would: 2-byte index + 4-byte signed color, base64'd.
    const cells = cellsBase64([[5, -1]]);

    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        cells,
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(pulled.events[0].cells, cells);
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("dev API responses embed composed pixels reflecting cells and a stroke_id-scoped undo", async () => {
  const canvasId = ulid();
  try {
    const strokeA = ulid();
    const strokeB = ulid();
    // Two devices interleaving: A paints pixel 0, B paints pixel 1, A undoes
    // its own stroke — B's pixel must survive.
    await post(`/canvases/${canvasId}/events`, {
      events: [
        {
          id: ulid(),
          kind: "stroke",
          strokeId: strokeA,
          cells: cellsBase64([[0, -1]]),
          revertsId: null,
          clientTs: 1,
        },
        {
          id: ulid(),
          kind: "stroke",
          strokeId: strokeB,
          cells: cellsBase64([[1, -256]]),
          revertsId: null,
          clientTs: 2,
        },
      ],
      heartbeatActive: true,
    });
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "undo",
        strokeId: null,
        cells: null,
        revertsId: strokeA,
        clientTs: 3,
      }],
      heartbeatActive: true,
    });

    const activeRes = await get("/dev/api/active");
    const active = await activeRes.json();
    const mine = active.canvases.find((c: { id: string }) => c.id === canvasId);
    const pixelBytes = Uint8Array.from(
      atob(mine.pixels),
      (c) => c.charCodeAt(0),
    );
    const pixels = new Int32Array(pixelBytes.buffer);
    assertEquals(pixels[1], -256, "B's pixel must survive A's undo");
    assertEquals(
      pixels[1] !== pixels[0],
      true,
      "A's pixel must have been reverted, unlike B's",
    );
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("the SSE stream sends real diffs for strokes, and a full resync only for undo", async () => {
  const canvasId = ulid();
  try {
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId: ulid(),
        cells: cellsBase64([[3, -16776961]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });

    const streamRes = await handler(
      new Request(`http://localhost/canvases/${canvasId}/stream`),
    );
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Persists leftover buffer across calls — a read() chunk can contain
    // more than one "data: ...\n\n" frame (or a partial one), so discarding
    // unconsumed bytes after extracting the first frame would silently drop
    // or misalign later messages.
    async function nextMessage(): Promise<
      { type: string; [k: string]: unknown }
    > {
      while (!buffer.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before a message arrived");
        buffer += decoder.decode(value, { stream: true });
      }
      const separatorIndex = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (frame.startsWith(": ")) return await nextMessage(); // keep-alive comment
      return JSON.parse(frame.replace(/^data: /, ""));
    }

    // The cross-instance poll-loop backstop can independently notice the
    // same change the immediate same-process broadcast already sent,
    // producing a harmless redundant "diff" — skip any of those while
    // waiting for a message of a specific type.
    async function nextMessageOfType(type: string) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const msg = await nextMessage();
        if (msg.type === type) return msg;
      }
      throw new Error(`no "${type}" message arrived within 5 messages`);
    }

    const initial = await nextMessage();
    assertEquals(initial.type, "snapshot");

    const strokeId = ulid();
    const strokeClientTs = Date.now();
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId,
        cells: cellsBase64([[10, -65536]]),
        revertsId: null,
        clientTs: strokeClientTs,
      }],
      heartbeatActive: true,
    });
    const diffMsg = await nextMessageOfType("diff");
    assertEquals(diffMsg.batches, [{
      ts: strokeClientTs,
      cells: [[10, -65536]],
    }]);

    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "undo",
        strokeId: null,
        cells: null,
        revertsId: strokeId,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    await nextMessageOfType("snapshot");

    await reader.cancel();
  } finally {
    await dropCanvas(canvasId);
  }
});
