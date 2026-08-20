// @ts-check

import { createPixels } from "./paint-engine.js";
import { decodeCells } from "./cell-codec.js";

/**
 * Same algorithm as src/server/compose.ts: exclude every 'stroke' whose
 * strokeId was later undone (order-independent — see compose.ts for why
 * that matters once other devices' diffs can land in between), then apply
 * the rest in order. `events` must already be in the order they actually
 * happened — sequence order for synced history, then insertion order for
 * anything still locally pending (unsynced).
 * @param {Array<{ kind: string, strokeId: string | null, cells: Uint8Array | null, revertsId: string | null }>} events
 * @returns {Int32Array}
 */
export function composeCanvas(events) {
  const pixels = createPixels();
  const revertedStrokeIds = new Set(
    events
      .filter((e) => e.kind === "undo" && e.revertsId)
      .map((e) => /** @type {string} */ (e.revertsId)),
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
