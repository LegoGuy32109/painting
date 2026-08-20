import { createPixels } from "../client/paint-engine.js";
import { decodeCells } from "../client/cell-codec.js";
import type { CanvasEventRow } from "./db.ts";

/**
 * Composes the current pixel state from the full ordered event log: exclude
 * every 'stroke' row whose stroke_id was later undone (regardless of when
 * the undo event arrives relative to other devices' strokes — exclusion by
 * id is order-independent, unlike a sequence-range rollback), then apply the
 * rest in sequence order. Cheap to just always do this from scratch — these
 * canvases are 16x16 and event counts are small.
 */
export function composeCanvas(events: CanvasEventRow[]): Int32Array {
  const pixels = createPixels();
  const revertedStrokeIds = new Set(
    events
      .filter((e) => e.kind === "undo" && e.revertsId)
      .map((e) => e.revertsId as string),
  );

  for (const event of events) {
    if (event.kind !== "stroke" || !event.cells) continue;
    if (event.strokeId && revertedStrokeIds.has(event.strokeId)) continue;
    for (const [index, color] of decodeCells(event.cells)) {
      pixels[index] = color;
    }
  }

  return pixels;
}
