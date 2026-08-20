// Pure unit tests for composeCanvas — no db, no network. The core claim
// being verified: excluding by stroke_id (not a sequence-range rollback) is
// what keeps undo correct when another device's diffs land in between the
// undone stroke's own diff rows.

import { assertEquals } from "@std/assert";
import { composeCanvas } from "../src/shared/compose.js";
import { encodeCells } from "../src/shared/cell-codec.js";
import { createPixels } from "../src/shared/paint-engine.js";
import type { CanvasEventRow } from "../src/server/db.ts";

let seq = 0;
function strokeRow(
  strokeId: string,
  cells: Array<[number, number]>,
): CanvasEventRow {
  seq += 1;
  return {
    sequence: seq,
    id: `evt-${seq}`,
    canvasId: "c1",
    kind: "stroke",
    strokeId,
    cells: encodeCells(cells),
    revertsId: null,
    clientTs: seq,
    receivedAt: seq,
  };
}

function undoRow(revertsId: string): CanvasEventRow {
  seq += 1;
  return {
    sequence: seq,
    id: `evt-${seq}`,
    canvasId: "c1",
    kind: "undo",
    strokeId: null,
    cells: null,
    revertsId,
    clientTs: seq,
    receivedAt: seq,
  };
}

Deno.test("composeCanvas applies stroke cells in sequence order, last write wins per index", () => {
  const events = [
    strokeRow("a", [[0, 111]]),
    strokeRow("b", [[0, 222]]),
  ];
  const pixels = composeCanvas(events);
  assertEquals(pixels[0], 222);
});

Deno.test("undo excludes only the reverted stroke's own diffs, even split across multiple rows", () => {
  const events = [
    strokeRow("a", [[0, 111]]),
    strokeRow("a", [[1, 111]]), // same gesture, a second flushed chunk
    undoRow("a"),
  ];
  const blank = createPixels();
  const pixels = composeCanvas(events);
  assertEquals(pixels[0], blank[0]);
  assertEquals(pixels[1], blank[1]);
});

Deno.test("undoing one device's stroke does not affect another device's diffs that landed in between", () => {
  const events = [
    strokeRow("a", [[0, 111]]), // device A starts painting pixel 0
    strokeRow("b", [[1, 222]]), // device B paints pixel 1 mid-way through A's gesture
    strokeRow("a", [[0, 333]]), // device A continues, still touching pixel 0
    undoRow("a"), // A undoes its own stroke
  ];
  const blank = createPixels();
  const pixels = composeCanvas(events);
  assertEquals(pixels[0], blank[0], "A's pixel must be reverted");
  assertEquals(pixels[1], 222, "B's pixel must survive A's undo");
});
