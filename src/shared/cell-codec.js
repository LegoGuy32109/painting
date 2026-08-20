// @ts-check

// Wire/storage format for a batch of pixel diffs: 2-byte unsigned index + a
// 4-byte signed ARGB color per cell. Shared by the client (encoding what it
// paints) and the server (decoding to compose the current image) — plain
// typed-array logic, no DOM, so it's safe to import from either side.

/** @param {Array<[index: number, color: number]>} cells @returns {Uint8Array} */
export function encodeCells(cells) {
  const bytes = new Uint8Array(cells.length * 6);
  const view = new DataView(bytes.buffer);
  cells.forEach(([index, color], i) => {
    view.setUint16(i * 6, index);
    view.setInt32(i * 6 + 2, color);
  });
  return bytes;
}

/** @param {Uint8Array} bytes @returns {Array<[index: number, color: number]>} */
export function decodeCells(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  /** @type {Array<[number, number]>} */
  const cells = [];
  for (let offset = 0; offset + 6 <= bytes.byteLength; offset += 6) {
    cells.push([view.getUint16(offset), view.getInt32(offset + 2)]);
  }
  return cells;
}
