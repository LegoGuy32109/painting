import { assertEquals } from "@std/assert";
import { buildCanvasReplay } from "../src/server/replay.ts";
import type { CanvasEventRow } from "../src/server/db.ts";
import { encodeCells } from "../src/shared/cell-codec.js";

function event(
  sequence: number,
  kind: "stroke" | "undo",
  clientTs: number,
  options: Partial<CanvasEventRow> = {},
): CanvasEventRow {
  return {
    sequence,
    id: `event-${sequence}`,
    canvasId: "canvas",
    kind,
    strokeId: null,
    cells: null,
    revertsId: null,
    clientTs,
    receivedAt: clientTs,
    ...options,
  };
}

Deno.test("completed replay keeps only the final event-time window", () => {
  const replay = buildCanvasReplay("canvas", "Clouds", [
    event(1, "stroke", 0, {
      strokeId: "old",
      cells: encodeCells([[0, -65536]]),
    }),
    event(2, "stroke", 50_000, {
      strokeId: "new",
      cells: encodeCells([[1, -16711936]]),
    }),
  ]);
  assertEquals(replay.durationMs, 40_000);
  assertEquals(replay.steps.length, 1);
  assertEquals(replay.steps[0].atMs, 40_000);
});

Deno.test("undo inside a replay window becomes a corrected snapshot", () => {
  const replay = buildCanvasReplay("canvas", "Undo", [
    event(1, "stroke", 0, {
      strokeId: "painted",
      cells: encodeCells([[0, -65536]]),
    }),
    event(2, "undo", 45_000, { revertsId: "painted" }),
  ]);
  assertEquals(replay.steps.length, 1);
  const step = replay.steps[0];
  assertEquals(step.type, "snapshot");
  if (step.type === "snapshot") {
    assertEquals(replay.finalPixels, step.pixels);
  }
});

Deno.test("replay timestamps never move backward", () => {
  const replay = buildCanvasReplay("canvas", "Clock", [
    event(1, "stroke", 100, {
      strokeId: "one",
      cells: encodeCells([[0, -1]]),
    }),
    event(2, "stroke", 50, {
      strokeId: "two",
      cells: encodeCells([[1, -1]]),
    }),
  ]);
  assertEquals(replay.steps.map((step) => step.atMs), [0, 0]);
});
