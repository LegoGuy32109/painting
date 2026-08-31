import { assertEquals, assertThrows } from "@std/assert";
import {
  buildJpaintDocument,
  decodeJpaintDocument,
  JpaintFormatError,
  JPAINT_FORMAT_VERSION,
} from "../src/shared/jpaint.js";
import type { CanvasEventRow } from "../src/server/db.ts";
import { encodeCells } from "../src/shared/cell-codec.js";
import FIXTURE_JSON from "./fixtures/sample.jpaint.json" with { type: "json" };

function event(
  sequence: number,
  overrides: Partial<CanvasEventRow> = {},
): CanvasEventRow {
  return {
    sequence,
    id: `event-${sequence}`,
    canvasId: "canvas-1",
    kind: "stroke",
    strokeId: `stroke-${sequence}`,
    cells: encodeCells([[sequence, -1]]),
    revertsId: null,
    clientTs: sequence * 1000,
    receivedAt: sequence * 1000,
    ...overrides,
  };
}

const SOURCE = {
  id: "canvas-1",
  title: "Clouds",
  author: "Cerulean Otter 4F2A",
  pixels: new Uint8Array([1, 2, 3, 4]),
  createdAt: 1000,
  completedAt: 2000,
};

Deno.test("buildJpaintDocument's format version is 1 and is the FIRST key", () => {
  const doc = buildJpaintDocument(SOURCE, 16, 16, []);
  assertEquals(doc.jpaint, 1);
  assertEquals(JPAINT_FORMAT_VERSION, 1);
  assertEquals(Object.keys(doc)[0], "jpaint");
  // Also verify it's really first in the serialized wire form, not just
  // object insertion order in memory.
  const serialized = JSON.stringify(doc);
  assertEquals(serialized.startsWith('{"jpaint":1,'), true);
});

Deno.test("buildJpaintDocument records width/height explicitly, never inferring from pixel count", () => {
  // A 32x16 and a 16x32 canvas would have the identical pixels.length —
  // the document must still say which shape it actually is.
  const long = buildJpaintDocument(SOURCE, 32, 16, []);
  const tall = buildJpaintDocument(SOURCE, 16, 32, []);
  assertEquals([long.width, long.height], [32, 16]);
  assertEquals([tall.width, tall.height], [16, 32]);
});

Deno.test("buildJpaintDocument carries metadata straight through, including a null author/title", () => {
  const doc = buildJpaintDocument(
    { ...SOURCE, title: null, author: null, completedAt: null },
    16,
    16,
    [],
  );
  assertEquals(doc.title, null);
  assertEquals(doc.author, null);
  assertEquals(doc.completedAt, null);
  assertEquals(doc.id, SOURCE.id);
  assertEquals(doc.createdAt, SOURCE.createdAt);
});

Deno.test("buildJpaintDocument includes the FULL event log, unbounded — not buildCanvasReplay()'s clamped timeline", () => {
  const events = Array.from({ length: 50 }, (_, index) => event(index + 1));
  const doc = buildJpaintDocument(SOURCE, 16, 16, events);
  assertEquals(doc.events.length, 50);
  assertEquals(
    doc.events.map((e) => e.sequence),
    events.map((e) => e.sequence),
  );
  // Cells are base64, same wire shape as PushEventPayload.cells elsewhere.
  assertEquals(typeof doc.events[0].cells, "string");
});

Deno.test("buildJpaintDocument round-trips an undo event's null cells and its revertsId", () => {
  const events = [
    event(1),
    event(2, {
      kind: "undo",
      strokeId: null,
      cells: null,
      revertsId: "stroke-1",
    }),
  ];
  const doc = buildJpaintDocument(SOURCE, 16, 16, events);
  assertEquals(doc.events[1].kind, "undo");
  assertEquals(doc.events[1].cells, null);
  assertEquals(doc.events[1].revertsId, "stroke-1");
});

// --- Golden fixture: tests/fixtures/sample.jpaint.json --------------------
//
// A small 16x16 signed painting with three strokes and an undo of the
// third stroke. Checked in BOTH directions so the fixture can catch silent
// format drift in either buildJpaintDocument() or decodeJpaintDocument(),
// not just in whichever one happens to have produced it.

// Imported as a JSON module (same convention tests/live-replay_test.js
// uses for tests/fixtures/live-paintings.json) rather than read from disk
// at runtime, so this test needs no extra --allow-read scope. FIXTURE_TEXT
// re-derives the raw-text form to exercise decodeJpaintDocument()'s
// string/JSON.parse path, not just its already-parsed-object path.
const FIXTURE_TEXT = JSON.stringify(FIXTURE_JSON);

Deno.test("decodeJpaintDocument decodes the golden fixture's values correctly", () => {
  const doc = decodeJpaintDocument(FIXTURE_TEXT);
  assertEquals(doc.jpaint, 1);
  assertEquals(doc.id, "01JPAINTFIXTURE00000000000");
  assertEquals(doc.title, "Fixture Painting");
  assertEquals(doc.author, "Cerulean Otter 4F2A");
  assertEquals(doc.width, 16);
  assertEquals(doc.height, 16);
  assertEquals(doc.createdAt, 1700000000000);
  assertEquals(doc.completedAt, 1700000005000);
  assertEquals(doc.events.length, 4);
  assertEquals(doc.events.map((e) => e.kind), [
    "stroke",
    "stroke",
    "stroke",
    "undo",
  ]);
  assertEquals(doc.events[3].revertsId, "stroke-3");
  assertEquals(doc.events[3].cells, null);
  // The final pixel state reflects strokes 1 and 2 but NOT stroke 3, since
  // event 4 undoes it.
  const pixelBytes = Uint8Array.from(
    atob(doc.pixels),
    (c) => c.charCodeAt(0),
  );
  const pixels = new Int32Array(
    pixelBytes.buffer,
    pixelBytes.byteOffset,
    pixelBytes.byteLength / 4,
  );
  assertEquals(pixels[0], -65536);
  assertEquals(pixels[1], -16776961);
  assertEquals(pixels[2], 0);
});

Deno.test("decodeJpaintDocument also accepts an already-parsed value, not just a string", () => {
  const doc = decodeJpaintDocument(FIXTURE_JSON);
  assertEquals(doc.id, FIXTURE_JSON.id);
});

Deno.test("buildJpaintDocument produces output matching the golden fixture byte-for-byte", () => {
  const pixelBytes = Uint8Array.from(
    atob(FIXTURE_JSON.pixels),
    (c: string) => c.charCodeAt(0),
  );
  type FixtureEvent = {
    sequence: number;
    id: string;
    kind: "stroke" | "undo";
    strokeId: string | null;
    cells: string | null;
    revertsId: string | null;
    clientTs: number;
  };
  const fixtureEvents = FIXTURE_JSON.events as unknown as FixtureEvent[];
  const events: CanvasEventRow[] = fixtureEvents.map((e) => ({
    sequence: e.sequence,
    id: e.id,
    canvasId: FIXTURE_JSON.id,
    kind: e.kind,
    strokeId: e.strokeId,
    cells: e.cells
      ? Uint8Array.from(atob(e.cells), (c) => c.charCodeAt(0))
      : null,
    revertsId: e.revertsId,
    clientTs: e.clientTs,
    receivedAt: e.clientTs,
  }));

  const doc = buildJpaintDocument(
    {
      id: FIXTURE_JSON.id,
      title: FIXTURE_JSON.title,
      author: FIXTURE_JSON.author,
      pixels: pixelBytes,
      createdAt: FIXTURE_JSON.createdAt,
      completedAt: FIXTURE_JSON.completedAt,
    },
    FIXTURE_JSON.width,
    FIXTURE_JSON.height,
    events,
  );

  assertEquals(JSON.parse(JSON.stringify(doc)), FIXTURE_JSON);
});

// --- Decoder rejection paths -----------------------------------------------

Deno.test("decodeJpaintDocument rejects an unknown/future format version", () => {
  assertThrows(
    () => decodeJpaintDocument({ ...FIXTURE_JSON, jpaint: 2 }),
    JpaintFormatError,
    "unsupported .jpaint format version",
  );
});

Deno.test("decodeJpaintDocument rejects a document missing a required field", () => {
  const { width: _width, ...withoutWidth } = FIXTURE_JSON;
  assertThrows(
    () => decodeJpaintDocument(withoutWidth),
    JpaintFormatError,
    'missing required field "width"',
  );
});

Deno.test("decodeJpaintDocument rejects a pixel buffer length inconsistent with width x height", () => {
  assertThrows(
    () =>
      decodeJpaintDocument({
        ...FIXTURE_JSON,
        // 4 bytes decodes fine as base64, but 16x16x4 = 1024 bytes are
        // required — a truncated/corrupt buffer must be rejected outright,
        // not silently accepted as a smaller canvas.
        pixels: btoa("abcd"),
      }),
    JpaintFormatError,
    "requires",
  );
});

Deno.test("decodeJpaintDocument rejects malformed base64 in pixels", () => {
  assertThrows(
    () =>
      decodeJpaintDocument({
        ...FIXTURE_JSON,
        pixels: "not valid base64 at all!!",
      }),
    JpaintFormatError,
    "not valid base64",
  );
});

Deno.test("decodeJpaintDocument never returns a half-built document on a malformed file", () => {
  let thrown: unknown;
  let doc: unknown;
  try {
    doc = decodeJpaintDocument({ ...FIXTURE_JSON, jpaint: 999 });
  } catch (error) {
    thrown = error;
  }
  assertEquals(doc, undefined);
  assertEquals(thrown instanceof JpaintFormatError, true);
});
