// @ts-check
// Client-side mirror of tests/compose_test.ts — same algorithm, same
// correctness claim (exclude by strokeId, not a sequence-range rollback),
// now exercised through src/shared/compose.js directly.

import { assertEquals } from "@std/assert";
import { composeCanvas } from "../src/shared/compose.js";
import { encodeCells } from "../src/shared/cell-codec.js";
import { createPixels } from "../src/shared/paint-engine.js";

/** @param {string} strokeId @param {Array<[number, number]>} cells */
function strokeEvent(strokeId, cells) {
  return {
    kind: "stroke",
    strokeId,
    cells: encodeCells(cells),
    revertsId: null,
  };
}

/** @param {string} revertsId */
function undoEvent(revertsId) {
  return { kind: "undo", strokeId: null, cells: null, revertsId };
}

Deno.test("client composeCanvas applies stroke cells in order, last write wins per index", () => {
  const pixels = composeCanvas([
    strokeEvent("a", [[0, 111]]),
    strokeEvent("b", [[0, 222]]),
  ]);
  assertEquals(pixels[0], 222);
});

Deno.test("client composeCanvas: undo excludes only the reverted stroke, surviving another device's interleaved diff", () => {
  const events = [
    strokeEvent("a", [[0, 111]]),
    strokeEvent("b", [[1, 222]]),
    strokeEvent("a", [[0, 333]]),
    undoEvent("a"),
  ];
  const blank = createPixels();
  const pixels = composeCanvas(events);
  assertEquals(pixels[0], blank[0], "A's pixel must be reverted");
  assertEquals(pixels[1], 222, "B's pixel must survive A's undo");
});
