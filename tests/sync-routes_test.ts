// Smoke tests for the sync-handshake HTTP routes, against a live database
// (TURSO_DB_URL/TURSO_DB_TOKEN — painting-local by default). Isolated from
// tests/main_test.ts (which requires no net/env perms) the same way
// tests/db_test.ts is isolated from the plain unit-test task.

import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import { handler } from "../src/server/main.ts";
import { createDb } from "../src/server/db.ts";
import { ulid } from "../src/shared/ulid.js";
import { encodeCells } from "../src/shared/cell-codec.js";
import {
  type GuestSession,
  guestSession,
} from "../src/server/guest-session.ts";
import { base64Url } from "../src/server/signing-keys.ts";

if (!Deno.env.get("GUEST_SESSION_SECRET")) {
  Deno.env.set(
    "GUEST_SESSION_SECRET",
    "test-only-guest-session-secret-32-bytes",
  );
}
if (!Deno.env.get("PAINTING_KEYS")) {
  Deno.env.set(
    "PAINTING_KEYS",
    `routes:${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
  );
}

// Exercises the /dev/api/active and /dev/api/completed diagnostic routes
// directly, which are gated behind PAINTING_E2E outside of e2e runs.
if (!Deno.env.get("PAINTING_E2E")) {
  Deno.env.set("PAINTING_E2E", "1");
}

function cellsBase64(cells: Array<[number, number]>): string {
  const bytes = encodeCells(cells);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const db = createDb();
const SESSION_A = (await guestSession(
  new Request("http://localhost/"),
  true,
)) as GuestSession;
const SESSION_B = (await guestSession(
  new Request("http://localhost/"),
  true,
)) as GuestSession;

function cookie(session: GuestSession): string {
  return session.setCookie?.split(";", 1)[0] ?? "";
}

async function dropCanvas(id: string) {
  await db.execute({ sql: "DELETE FROM canvases WHERE id = ?", args: [id] });
}

function post(path: string, body: unknown, session = SESSION_A) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie(session) },
      body: JSON.stringify(body),
    }),
  );
}

function put(path: string, body: unknown, session = SESSION_A) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: cookie(session) },
      body: JSON.stringify(body),
    }),
  );
}

function remove(path: string, session = SESSION_A) {
  return handler(
    new Request(`http://localhost${path}`, {
      method: "DELETE",
      headers: { cookie: cookie(session) },
    }),
  );
}

function get(path: string, session = SESSION_A) {
  return handler(
    new Request(`http://localhost${path}`, {
      headers: { cookie: cookie(session) },
    }),
  );
}

Deno.test("guest draft and completed collection lifecycle is owner scoped", async () => {
  const preferredId = ulid();
  const ignoredSecondId = ulid();
  try {
    const created = await put("/api/me/draft", { id: preferredId });
    assertEquals(created.status, 200);
    const first = await created.json();
    assertEquals(first.draft.id, preferredId);
    assertEquals(first.acceptedPreferredId, true);

    const repeated = await put("/api/me/draft", { id: ignoredSecondId });
    const second = await repeated.json();
    assertEquals(second.draft.id, preferredId);
    assertEquals(second.acceptedPreferredId, false);

    await post(`/canvases/${preferredId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId: ulid(),
        cells: cellsBase64([[0, -65536]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    const signed = await post(`/canvases/${preferredId}/complete`, {
      title: "My Painting",
    });
    assertEquals(signed.status, 200);

    const mine = await (await get("/api/me/canvases")).json();
    assertEquals(mine.draft, null);
    assertEquals(mine.completed[0].id, preferredId);
    const someoneElse = await (await get("/api/me/canvases", SESSION_B)).json();
    assertEquals(someoneElse.completed.length, 0);

    const feed = await (await get("/api/display-feed?limit=12")).json();
    assertEquals(
      feed.completed.some((canvas: { id: string }) =>
        canvas.id === preferredId
      ),
      true,
    );
    const replayResponse = await get(`/canvases/${preferredId}/replay`);
    assertEquals(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assertEquals(replay.id, preferredId);
    assertEquals(replay.title, "My Painting");
    assertEquals(replay.steps.length > 0, true);

    assertEquals(
      (await remove(`/api/me/canvases/${preferredId}`, SESSION_B)).status,
      404,
    );
    assertEquals(
      (await remove(`/api/me/canvases/${preferredId}`)).status,
      204,
    );
  } finally {
    await dropCanvas(preferredId);
    await dropCanvas(ignoredSecondId);
  }
});

Deno.test("push lazily creates the canvas row and appends events", async () => {
  const canvasId = ulid();
  try {
    const strokeId = ulid();
    const eventId = ulid();
    const res = await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: eventId,
        kind: "stroke",
        strokeId,
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    assertEquals(res.status, 200);
    const pushed = await res.json();
    assertEquals(pushed.acknowledgments.length, 1);
    assertEquals(pushed.acknowledgments[0].id, eventId);

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(pulled.headSequence > 0, true);
    assertEquals(pulled.events.length, 1);
    assertEquals(pulled.events[0].id, eventId);

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
      strokeId: ulid(),
      cells: cellsBase64([[0, -1]]),
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
    const strokeId = ulid();
    const strokeEventId = ulid();
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: strokeEventId,
        kind: "stroke",
        strokeId,
        cells: cellsBase64([[0, -1]]),
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

Deno.test("sign atomically sets completion and rejects later strokes", async () => {
  const canvasId = ulid();
  try {
    const strokeId = ulid();
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId,
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    const signRes = await post(`/canvases/${canvasId}/complete`, {
      title: "Route Smoke Test",
    });
    assertEquals(signRes.status, 200);

    const afterSign = await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId: ulid(),
        cells: cellsBase64([[1, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: false,
    });
    assertEquals(afterSign.status, 409);

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

Deno.test("author is server-derived from the signer's own profile; a client-supplied author field is ignored, not honoured", async () => {
  const canvasId = ulid();
  try {
    await put("/api/me/draft", { id: canvasId });
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId: ulid(),
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });

    // validateCompletion only ever reads `title` (see protocol.ts), and
    // completeCanvas() no longer even accepts an author argument — the
    // author reported below is always the joined profiles.handle for this
    // canvas's owner_id, so a client-supplied `author` field has no path
    // to influence it at all, not merely one that gets overridden.
    const signRes = await post(`/canvases/${canvasId}/complete`, {
      title: "Attribution Test",
      author: "Someone Else Entirely",
    });
    assertEquals(signRes.status, 200);

    const realHandle = (await (await get("/api/me")).json()).handle;
    const mine = await (await get("/api/me/canvases")).json();
    const signed = mine.completed.find((c: { id: string }) =>
      c.id === canvasId
    );
    assertEquals(signed?.author, realHandle);
    assertNotEquals(signed?.author, "Someone Else Entirely");
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("GET /canvases/:id/jpaint 404s for a draft and exports the full event log for a signed painting", async () => {
  const canvasId = ulid();
  try {
    await put("/api/me/draft", { id: canvasId });

    // Not yet signed: no export.
    const draftExport = await get(`/canvases/${canvasId}/jpaint`);
    assertEquals(draftExport.status, 404);

    const strokeIds = [ulid(), ulid(), ulid()];
    for (const [index, strokeId] of strokeIds.entries()) {
      await post(`/canvases/${canvasId}/events`, {
        events: [{
          id: ulid(),
          kind: "stroke",
          strokeId,
          cells: cellsBase64([[index, -1]]),
          revertsId: null,
          clientTs: Date.now(),
        }],
        heartbeatActive: true,
      });
    }
    await post(`/canvases/${canvasId}/complete`, { title: "Exported" });

    const res = await get(`/canvases/${canvasId}/jpaint`);
    assertEquals(res.status, 200);
    // Its own media type, not plain JSON — Response.json() would hardcode
    // application/json, so the route must set this explicitly.
    assertEquals(res.headers.get("content-type"), "application/x-jpaint+json");
    // The title, not the id — a ULID in a downloads folder tells the user
    // nothing. Sanitized, with an RFC 5987 filename* alongside the ASCII
    // fallback; see src/server/content-disposition.ts.
    const disposition = res.headers.get("content-disposition") ?? "";
    assertStringIncludes(disposition, 'filename="Exported.jpaint"');
    assertStringIncludes(disposition, "filename*=UTF-8''Exported.jpaint");
    const doc = await res.json();
    assertEquals(doc.jpaint, 1);
    assertEquals(doc.id, canvasId);
    assertEquals(doc.title, "Exported");
    assertEquals(typeof doc.author, "string");
    assertEquals(doc.width, 16);
    assertEquals(doc.height, 16);
    assertEquals(typeof doc.pixels, "string");
    // The FULL event log: every stroke pushed above, none dropped —
    // buildCanvasReplay()'s bounding/clamping never applies to this route.
    assertEquals(doc.events.length, strokeIds.length);
    assertEquals(
      doc.events.map((e: { strokeId: string }) => e.strokeId),
      strokeIds,
    );

    // `?events=none` omits the (potentially large, unbounded) event log
    // for a caller who only wants the finished image, but keeps every
    // other field intact.
    const noEventsRes = await get(`/canvases/${canvasId}/jpaint?events=none`);
    assertEquals(noEventsRes.status, 200);
    const noEventsDoc = await noEventsRes.json();
    assertEquals(noEventsDoc.events.length, 0);
    assertEquals(noEventsDoc.pixels, doc.pixels);
    assertEquals(noEventsDoc.title, doc.title);
  } finally {
    await dropCanvas(canvasId);
  }
});

Deno.test("after a rename, the renamer's signed painting reports the new handle in /api/me/canvases; another profile's painting is unaffected", async () => {
  const canvasId = ulid();
  const otherSession = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  const otherCanvasId = ulid();
  try {
    // Someone else's signed painting, to prove the rename is scoped.
    await put("/api/me/draft", { id: otherCanvasId }, otherSession);
    await post(`/canvases/${otherCanvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId: ulid(),
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    }, otherSession);
    await post(
      `/canvases/${otherCanvasId}/complete`,
      { title: "Someone Else" },
      otherSession,
    );
    const otherBefore = await (await get("/api/me/canvases", otherSession))
      .json();
    const otherAuthor = otherBefore.completed.find(
      (c: { id: string }) => c.id === otherCanvasId,
    )?.author;
    assertEquals(typeof otherAuthor, "string");

    await put("/api/me/draft", { id: canvasId });
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: ulid(),
        kind: "stroke",
        strokeId: ulid(),
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
    await post(`/canvases/${canvasId}/complete`, { title: "Follows Rename" });

    const beforeRename = await (await get("/api/me/canvases")).json();
    const authorBeforeRename = beforeRename.completed.find(
      (c: { id: string }) => c.id === canvasId,
    )?.author;
    assertEquals(typeof authorBeforeRename, "string");

    // author is derived at read time by joining profiles.handle off
    // owner_id (see getGuestDraft()/listGuestCompleted() etc. in db.ts) —
    // there is nothing stored on the canvas to rewrite. Renaming the
    // profile's handle is automatically reflected the next time this
    // profile's own signed painting is read...
    const newHandle = `Renamed ${ulid().slice(0, 4)}`;
    const renamed = await put("/api/me/handle", { handle: newHandle });
    assertEquals(renamed.status, 200);
    assertNotEquals(newHandle, authorBeforeRename);

    const afterRename = await (await get("/api/me/canvases")).json();
    assertEquals(
      afterRename.completed.find((c: { id: string }) => c.id === canvasId)
        ?.author,
      newHandle,
      "the renamer's own signed painting should carry the new handle",
    );

    // ...and strictly nowhere else. This is the property that matters: the
    // UPDATE (in renameHandle()) is scoped to a single profile id, so one
    // profile's rename can never relabel another profile's public work.
    const otherAfter = await (await get("/api/me/canvases", otherSession))
      .json();
    assertEquals(
      otherAfter.completed.find((c: { id: string }) => c.id === otherCanvasId)
        ?.author,
      otherAuthor,
      "another profile's painting must be untouched by someone else's rename",
    );
  } finally {
    await dropCanvas(canvasId);
    await dropCanvas(otherCanvasId);
    await dropProfile(otherSession.guestId);
  }
});

Deno.test("an undo event carries revertsId pointing at the reverted stroke's id, and doesn't delete it", async () => {
  const canvasId = ulid();
  try {
    const strokeId = ulid();
    const strokeEventId = ulid();
    await post(`/canvases/${canvasId}/events`, {
      events: [{
        id: strokeEventId,
        kind: "stroke",
        strokeId,
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: Date.now(),
      }],
      heartbeatActive: true,
    });
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

    const pullRes = await get(`/canvases/${canvasId}/events?since=0`);
    const pulled = await pullRes.json();
    assertEquals(
      pulled.events.length,
      2,
      "the stroke event must still be present, untouched",
    );

    const strokeEvent = pulled.events.find((e: { id: string }) =>
      e.id === strokeEventId
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
    const firstStrokeId = ulid();
    await post(
      `/canvases/${canvasId}/events`,
      {
        events: [{
          id: ulid(),
          kind: "stroke",
          strokeId: firstStrokeId,
          cells: cellsBase64([[0, -1]]),
          revertsId: null,
          clientTs: Date.now(),
        }],
        heartbeatActive: true,
      },
      SESSION_A,
    );
    const secondStrokeId = ulid();
    const res = await post(
      `/canvases/${canvasId}/events`,
      {
        events: [{
          id: ulid(),
          kind: "stroke",
          strokeId: secondStrokeId,
          cells: cellsBase64([[1, -1]]),
          revertsId: null,
          clientTs: Date.now(),
        }],
        heartbeatActive: true,
      },
      SESSION_B,
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
    }, SESSION_B);
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
        strokeId: ulid(),
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
    assertEquals(
      "ownerId" in mine,
      false,
      "public canvas data must omit ownerId",
    );
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

    // The cross-instance poll-loop backstop (200ms interval — see
    // POLL_INTERVAL_MS in main.ts) can independently notice the same
    // change the immediate same-process broadcast already sent, producing
    // a harmless redundant "diff"/"snapshot" — skip any of those while
    // waiting for a message of a specific type.
    //
    // The budget here is deliberately generous (was 5; this flaked once
    // in three runs at that budget after Phase 2 added a database round
    // trip — ensureProfile() — to the first events-POST push per profile
    // per process, ahead of this test in file order). Investigated
    // directly: ran this file against a real ephemeral Turso database
    // twice more here and it passed both times at ~1-2s per test, so the
    // failure did not reproduce in this environment — but the causal
    // mechanism is real and traceable to our own change regardless: any
    // extra latency on the push path (a slow round trip here, ordinary
    // network jitter to Turso elsewhere) gives the fixed-interval poller
    // more 200ms windows to fire redundant messages before the awaited
    // one arrives, and a small fixed message-count budget racing an
    // unbounded-in-practice background poller is fragile on its own
    // terms, independent of whether this specific run reproduces it.
    // Widening the margin costs nothing (each extra attempt is one more
    // already-arrived-or-imminent SSE frame, not a new wait), so this
    // errs generous rather than re-tightening a budget already shown to
    // flake.
    async function nextMessageOfType(type: string) {
      const maxAttempts = 20;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const msg = await nextMessage();
        if (msg.type === type) return msg;
      }
      throw new Error(
        `no "${type}" message arrived within ${maxAttempts} messages`,
      );
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

async function dropProfile(id: string) {
  await db.execute({ sql: "DELETE FROM profiles WHERE id = ?", args: [id] });
}

Deno.test("a mutation lazily creates exactly one profiles row, and a repeat mutation does not duplicate it", async () => {
  const session = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  const draftId = ulid();
  try {
    const before = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM profiles WHERE id = ?",
      args: [session.guestId],
    });
    assertEquals(Number(before.rows[0].n), 0);

    await put("/api/me/draft", { id: draftId }, session);
    const afterFirst = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM profiles WHERE id = ?",
      args: [session.guestId],
    });
    assertEquals(Number(afterFirst.rows[0].n), 1);

    // A second mutation for the same guest must not create a second row —
    // ensureProfile() upserts, it never inserts twice.
    await remove("/api/me/draft", session);
    const afterSecond = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM profiles WHERE id = ?",
      args: [session.guestId],
    });
    assertEquals(Number(afterSecond.rows[0].n), 1);
  } finally {
    await dropCanvas(draftId);
    await dropProfile(session.guestId);
  }
});

Deno.test("GET /api/me reflects a plain guest, then an upgraded account, and never leaks the profile id or credential internals", async () => {
  const session = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  const draftId = ulid();
  try {
    // A guest who has never mutated anything: no row yet, reads as the
    // same "not an account" shape as a fresh guest row would.
    const beforeAnyMutation = await (await get("/api/me", session)).json();
    assertEquals(beforeAnyMutation, {
      handle: null,
      isAccount: false,
      credentialCount: 0,
      credentials: [],
    });
    assertEquals("id" in beforeAnyMutation, false);

    // Mutate once, so the profiles row now exists. A handle is minted at
    // creation (Phase 3 change request #2) — still a guest, zero
    // credentials, but handle is no longer null.
    await put("/api/me/draft", { id: draftId }, session);
    const guestRes = await get("/api/me", session);
    assertEquals(guestRes.headers.get("cache-control"), "private, no-store");
    const guestBody = await guestRes.json();
    assertMatch(guestBody.handle, /^[A-Za-z ]+ [A-Za-z]+ [0-9A-F]{4}$/);
    assertEquals(guestBody.isAccount, false);
    assertEquals(guestBody.credentialCount, 0);
    assertEquals(guestBody.credentials, []);
    const rawGuestBody = JSON.stringify(guestBody);
    assertEquals(rawGuestBody.includes(session.guestId), false);

    // Simulate an "account" the way the real registration route does: a
    // credentials row attached to the same profile (handle already set).
    const credentialId = ulid();
    await db.execute({
      sql:
        "INSERT INTO credentials (credential_id, profile_id, public_key, created_at, nickname) " +
        "VALUES (?, ?, ?, ?, ?)",
      args: [
        credentialId,
        session.guestId,
        new Uint8Array([1, 2, 3]),
        Date.now(),
        null,
      ],
    });
    const accountBody = await (await get("/api/me", session)).json();
    assertEquals(accountBody.handle, guestBody.handle);
    assertEquals(accountBody.isAccount, true);
    assertEquals(accountBody.credentialCount, 1);
    assertEquals(accountBody.credentials.length, 1);
    assertEquals(accountBody.credentials[0].credentialId, credentialId);
    assertEquals(accountBody.credentials[0].nickname, null);
    assertEquals(accountBody.credentials[0].backedUp, false);
    assertEquals(typeof accountBody.credentials[0].createdAt, "number");
    // The point of this test: nothing beyond the CredentialSummary shape
    // ever appears — no profile id, no user_handle, no public key, no
    // counter, anywhere in the response.
    const rawAccountBody = JSON.stringify(accountBody);
    assertEquals(rawAccountBody.includes(session.guestId), false);
    assertEquals(
      Object.keys(accountBody.credentials[0]).sort(),
      ["backedUp", "createdAt", "credentialId", "nickname"],
    );
  } finally {
    await db.execute({
      sql: "DELETE FROM credentials WHERE profile_id = ?",
      args: [session.guestId],
    });
    await dropCanvas(draftId);
    await dropProfile(session.guestId);
  }
});

Deno.test("PUT /api/me/handle renames and rejects a duplicate with 409", async () => {
  const sessionA = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  const sessionB = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  try {
    const nameA = `Rename Test ${ulid().slice(0, 4)}`;
    const renamed = await put("/api/me/handle", { handle: nameA }, sessionA);
    assertEquals(renamed.status, 200);
    const renamedBody = await renamed.json();
    assertEquals(renamedBody, { ok: true, handle: nameA });

    const meAfter = await (await get("/api/me", sessionA)).json();
    assertEquals(meAfter.handle, nameA);

    // sessionB claims the same handle A already has — 409, not 500.
    const conflict = await put("/api/me/handle", { handle: nameA }, sessionB);
    assertEquals(conflict.status, 409);

    const tooShort = await put("/api/me/handle", { handle: "a" }, sessionB);
    assertEquals(tooShort.status, 400);

    const badChars = await put(
      "/api/me/handle",
      { handle: "bad\nname" },
      sessionB,
    );
    assertEquals(badChars.status, 400);

    // A naive "collapse \s+ to a space" normalizer would launder these
    // into legal-looking text ("bad name") before the charset check ever
    // ran — the fix validates the raw input first, so all of these must
    // still 400.
    const tabName = await put(
      "/api/me/handle",
      { handle: "bad\tname" },
      sessionB,
    );
    assertEquals(tabName.status, 400);
    const crlfName = await put(
      "/api/me/handle",
      { handle: "bad\r\nname" },
      sessionB,
    );
    assertEquals(crlfName.status, 400);
  } finally {
    await dropProfile(sessionA.guestId);
    await dropProfile(sessionB.guestId);
  }
});

Deno.test("DELETE /api/auth/credentials/:id refuses to remove the last passkey", async () => {
  const session = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  const credentialA = ulid();
  const credentialB = ulid();
  try {
    // ensureProfile via any mutation first, then attach credentials directly
    // (bypassing the real WebAuthn ceremony — that's covered by the
    // Playwright CDP virtual-authenticator e2e test instead).
    await put(
      "/api/me/handle",
      { handle: `Cred Test ${ulid().slice(0, 4)}` },
      session,
    );
    await db.execute({
      sql:
        "INSERT INTO credentials (credential_id, profile_id, public_key, created_at) VALUES (?, ?, ?, ?)",
      args: [credentialA, session.guestId, new Uint8Array([1]), Date.now()],
    });
    await db.execute({
      sql:
        "INSERT INTO credentials (credential_id, profile_id, public_key, created_at) VALUES (?, ?, ?, ?)",
      args: [credentialB, session.guestId, new Uint8Array([2]), Date.now()],
    });

    const firstDelete = await remove(
      `/api/auth/credentials/${credentialA}`,
      session,
    );
    assertEquals(firstDelete.status, 204);

    const lastDelete = await remove(
      `/api/auth/credentials/${credentialB}`,
      session,
    );
    assertEquals(lastDelete.status, 400);

    const notFound = await remove(
      `/api/auth/credentials/${ulid()}`,
      session,
    );
    assertEquals(notFound.status, 404);
  } finally {
    await db.execute({
      sql: "DELETE FROM credentials WHERE profile_id = ?",
      args: [session.guestId],
    });
    await dropProfile(session.guestId);
  }
});

Deno.test("register/options and register/verify 501 when WEBAUTHN_RP_ID/ORIGINS aren't configured; credential deletion is never gated", async () => {
  // This test file never sets WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS, so the two
  // routes that actually perform a WebAuthn ceremony must 501 — guest
  // flows (everything tested above) must keep working regardless, which
  // the rest of this file already proves.
  const session = (await guestSession(
    new Request("http://localhost/"),
    true,
  )) as GuestSession;
  try {
    const options = await post("/api/auth/register/options", {}, session);
    assertEquals(options.status, 501);
    const verify = await post(
      "/api/auth/register/verify",
      { credential: {} },
      session,
    );
    assertEquals(verify.status, 501);

    // DELETE performs no WebAuthn ceremony (no rpID/origin binding to
    // check) and must never 501 — a user must always be able to remove a
    // credential, including from a non-canonical origin. No credential
    // exists here, so this exercises the ordinary 404 path, proving the
    // request got PAST any RP gate rather than being rejected by one.
    const remove = await handler(
      new Request(
        `http://localhost/api/auth/credentials/${ulid()}`,
        { method: "DELETE", headers: { cookie: cookie(session) } },
      ),
    );
    assertEquals(remove.status, 404);
  } finally {
    await dropProfile(session.guestId);
  }
});
