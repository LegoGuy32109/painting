import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertCanvasId,
  assertSameOrigin,
  HttpError,
  readJsonBody,
  validateCompletion,
  validatePushEvents,
} from "../src/server/protocol.ts";
import { encodeCells } from "../src/shared/cell-codec.js";

function cellsBase64(cells: Array<[number, number]>): string {
  const bytes = encodeCells(cells);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const EVENT_ID = "01K00000000000000000000000";
const STROKE_ID = "01K00000000000000000000001";

Deno.test("validates a bounded stroke payload", () => {
  const body = validatePushEvents({
    events: [{
      id: EVENT_ID,
      kind: "stroke",
      strokeId: STROKE_ID,
      cells: cellsBase64([[0, -1], [255, -16777216]]),
      revertsId: null,
      clientTs: 100,
    }],
    heartbeatActive: true,
  }, 100);
  assertEquals(body.events.length, 1);
});

Deno.test("rejects invalid event combinations and pixel indexes", () => {
  for (
    const event of [
      {
        id: EVENT_ID,
        kind: "stroke",
        strokeId: null,
        cells: cellsBase64([[0, -1]]),
        revertsId: null,
        clientTs: 100,
      },
      {
        id: EVENT_ID,
        kind: "undo",
        strokeId: null,
        cells: cellsBase64([[0, -1]]),
        revertsId: STROKE_ID,
        clientTs: 100,
      },
      {
        id: EVENT_ID,
        kind: "stroke",
        strokeId: STROKE_ID,
        cells: cellsBase64([[256, -1]]),
        revertsId: null,
        clientTs: 100,
      },
    ]
  ) {
    assertThrows(
      () => validatePushEvents({ events: [event], heartbeatActive: true }, 100),
      HttpError,
    );
  }
});

Deno.test("validates completion titles at the server boundary", () => {
  assertEquals(validateCompletion({ title: "  Clouds  " }), {
    title: "Clouds",
  });
  assertThrows(
    () => validateCompletion({ title: "12345678901234567" }),
    HttpError,
  );
});

Deno.test("rejects duplicate event ids in one push", () => {
  const event = {
    id: EVENT_ID,
    kind: "stroke",
    strokeId: STROKE_ID,
    cells: cellsBase64([[0, -1]]),
    revertsId: null,
    clientTs: 100,
  };
  assertThrows(
    () =>
      validatePushEvents({
        events: [event, { ...event, strokeId: EVENT_ID }],
        heartbeatActive: true,
      }, 100),
    HttpError,
  );
});

Deno.test("bounds JSON bodies before parsing", async () => {
  await assertRejects(
    () =>
      readJsonBody(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
      ),
    HttpError,
  );
  await assertRejects(
    () =>
      readJsonBody(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: `"${"x".repeat(160_001)}"`,
        }),
      ),
    HttpError,
  );
});

Deno.test("rejects cross-origin mutations", () => {
  assertThrows(
    () =>
      assertSameOrigin(
        new Request("https://paint.example/canvases/id/events", {
          headers: { origin: "https://evil.example" },
        }),
      ),
    HttpError,
  );
});

Deno.test("accepts legacy canvas ids without generating new ones", () => {
  assertCanvasId("01M0DYMS702WD8ZZ6VSW");
  assertThrows(() => assertCanvasId("not-a-canvas-id"), HttpError);
});
