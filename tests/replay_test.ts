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

Deno.test("completed replay keeps only the final event count", () => {
  const events = Array.from(
    { length: 141 },
    (_, index) =>
      event(index + 1, "stroke", index, {
        strokeId: `stroke-${index}`,
        cells: encodeCells([[index % 256, -65536]]),
      }),
  );
  const replay = buildCanvasReplay("canvas", "Clouds", events);
  assertEquals(replay.steps.length, 140);
  assertEquals(replay.steps[0].atMs, 0);
  assertEquals(replay.durationMs, 139);
});

Deno.test("replay gaps are capped at half a second", () => {
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
  assertEquals(replay.durationMs, 500);
  assertEquals(replay.steps.map((step) => step.atMs), [0, 500]);
});

Deno.test("long replays finish before their display card leaves", () => {
  const replay = buildCanvasReplay(
    "canvas",
    "Long pause",
    Array.from(
      { length: 140 },
      (_, index) =>
        event(index + 1, "stroke", index * 1_000, {
          strokeId: `stroke-${index}`,
          cells: encodeCells([[index % 256, -1]]),
        }),
    ),
  );
  assertEquals(replay.durationMs, 44_000);
  const gaps = replay.steps.slice(1).map((step, index) =>
    step.atMs - replay.steps[index].atMs
  );
  assertEquals(gaps.every((gap) => gap <= 500), true);
});

Deno.test("undo inside a replay window becomes a corrected snapshot", () => {
  const replay = buildCanvasReplay("canvas", "Undo", [
    event(1, "stroke", 0, {
      strokeId: "painted",
      cells: encodeCells([[0, -65536]]),
    }),
    event(2, "undo", 45_000, { revertsId: "painted" }),
  ]);
  assertEquals(replay.steps.length, 2);
  const step = replay.steps[1];
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
