// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").LiveStreamMessage} LiveStreamMessage */

const messageTypes = new Set([
  "sync",
  "snapshot",
  "diff",
  "completed",
  "inactive",
]);

/** Parse and validate one untrusted SSE payload. @param {string} text @returns {LiveStreamMessage | null} */
export function parseLiveStreamMessage(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!record(value) || value.version !== 1 || !messageTypes.has(value.type)) {
    return null;
  }
  if (value.type === "sync") {
    if (!Array.isArray(value.canvases)) return null;
    return value.canvases.every((item) =>
        record(item) && canvas(item.canvas) && sequence(item.headSequence)
      )
      ? /** @type {LiveStreamMessage} */ (value)
      : null;
  }
  if (value.type === "snapshot" || value.type === "completed") {
    return canvas(value.canvas) && sequence(value.headSequence)
      ? /** @type {LiveStreamMessage} */ (value)
      : null;
  }
  if (value.type === "inactive") {
    return typeof value.canvasId === "string" && value.canvasId.length > 0 &&
        ["idle", "completed", "missing"].includes(value.reason)
      ? /** @type {LiveStreamMessage} */ (value)
      : null;
  }
  if (
    typeof value.canvasId !== "string" || value.canvasId.length === 0 ||
    !sequence(value.headSequence) || !Array.isArray(value.batches)
  ) return null;
  return value.batches.every((batch) =>
      record(batch) && sequence(batch.sequence) && finite(batch.ts) &&
      Array.isArray(batch.cells) && batch.cells.every((cell) =>
        Array.isArray(cell) && cell.length === 2 &&
        Number.isSafeInteger(cell[0]) && cell[0] >= 0 && cell[0] < 4_096 &&
        Number.isInteger(cell[1]) && cell[1] >= -2_147_483_648 &&
        cell[1] <= 2_147_483_647
      )
    )
    ? /** @type {LiveStreamMessage} */ (value)
    : null;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value */
function sequence(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/** @param {unknown} value */
function canvas(value) {
  return record(value) && typeof value.id === "string" && value.id.length > 0 &&
    (value.title === null || typeof value.title === "string") &&
    typeof value.pixels === "string" && finite(value.createdAt) &&
    (value.lastStrokeAt === null || finite(value.lastStrokeAt)) &&
    (value.completedAt === null || finite(value.completedAt));
}
