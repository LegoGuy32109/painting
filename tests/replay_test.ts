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
    { length: 4_001 },
    (_, index) =>
      event(index + 1, "stroke", index, {
        strokeId: `stroke-${index}`,
        cells: encodeCells([[index % 256, -65536]]),
      }),
  );
  const replay = buildCanvasReplay("canvas", "Clouds", "Test Author", events);
  assertEquals(replay.steps.length, 4_000);
  assertEquals(replay.steps[0].atMs, 0);
  assertEquals(replay.durationMs, 3_999);
});

Deno.test("replay gaps are capped at half a second", () => {
  const replay = buildCanvasReplay("canvas", "Clouds", "Test Author", [
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

Deno.test("long replays preserve their capped relative timeline", () => {
  const replay = buildCanvasReplay(
    "canvas",
    "Long pause",
    "Test Author",
    Array.from(
      { length: 140 },
      (_, index) =>
        event(index + 1, "stroke", index * 1_000, {
          strokeId: `stroke-${index}`,
          cells: encodeCells([[index % 256, -1]]),
        }),
    ),
  );
  assertEquals(replay.durationMs, 69_500);
  const gaps = replay.steps.slice(1).map((step, index) =>
    step.atMs - replay.steps[index].atMs
  );
  assertEquals(gaps.every((gap) => gap <= 500), true);
});

Deno.test("undo inside a replay window becomes a corrected snapshot", () => {
  const replay = buildCanvasReplay("canvas", "Undo", "Test Author", [
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
  const replay = buildCanvasReplay("canvas", "Clock", "Test Author", [
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

Deno.test("buildCanvasReplay threads author straight through, including null", () => {
  const events = [
    event(1, "stroke", 0, {
      strokeId: "one",
      cells: encodeCells([[0, -1]]),
    }),
  ];
  const withAuthor = buildCanvasReplay(
    "canvas",
    "Signed",
    "Cerulean Otter",
    events,
  );
  assertEquals(withAuthor.author, "Cerulean Otter");

  // A canvas whose owner has no profiles row (an orphaned owner_id) has no
  // handle to report — serializes as a plain JSON null, not an empty
  // string or an omitted field.
  const withoutAuthor = buildCanvasReplay(
    "canvas",
    "Pre-existing",
    null,
    events,
  );
  assertEquals(withoutAuthor.author, null);
  assertEquals(JSON.parse(JSON.stringify(withoutAuthor)).author, null);
});
