export const CANVAS_WIDTH = 16;
export const CANVAS_HEIGHT = 16;
export const OPAQUE_WHITE = 0xfff9fffe | 0;

export const BRUSH_OFFSETS = Object.freeze({
  1: Object.freeze([[0, 0]]),
  2: Object.freeze([[0, 0], [-1, 0], [0, -1], [-1, -1]]),
  3: Object.freeze([
    [-1, 1],
    [0, 1],
    [-2, 0],
    [-1, 0],
    [0, 0],
    [1, 0],
    [-2, -1],
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, -2],
    [0, -2],
  ]),
  4: Object.freeze([
    [-1, 2],
    [0, 2],
    [1, 2],
    [-2, 1],
    [-1, 1],
    [0, 1],
    [1, 1],
    [2, 1],
    [-2, 0],
    [-1, 0],
    [0, 0],
    [1, 0],
    [2, 0],
    [-2, -1],
    [-1, -1],
    [0, -1],
    [1, -1],
    [2, -1],
    [-1, -2],
    [0, -2],
    [1, -2],
  ]),
});

export const BRUSH_BOUNDS = Object.freeze({
  1: Object.freeze({ minX: 0, minY: 0, size: 1 }),
  2: Object.freeze({ minX: -1, minY: -1, size: 2 }),
  3: Object.freeze({ minX: -2, minY: -2, size: 4 }),
  4: Object.freeze({ minX: -2, minY: -2, size: 5 }),
});

export function createPixels(
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
  color = OPAQUE_WHITE,
) {
  return new Int32Array(width * height).fill(color);
}

export function cellIndex(x, y, width) {
  return y * width + x;
}

export function cellUnderPointer(position, cellSize) {
  return Math.floor(position / cellSize);
}

export function brushAnchor(x, y, cellSize, brushSize) {
  if (brushSize === 2 || brushSize === 3) {
    return {
      x: Math.floor((x + cellSize / 2) / cellSize),
      y: Math.floor((y + cellSize / 2) / cellSize),
    };
  }

  return {
    x: cellUnderPointer(x, cellSize),
    y: cellUnderPointer(y, cellSize),
  };
}

export function cellsForStamp(anchor, brushSize, width, height) {
  return BRUSH_OFFSETS[brushSize]
    .map(([offsetX, offsetY]) => ({
      x: anchor.x + offsetX,
      y: anchor.y + offsetY,
    }))
    .filter(({ x, y }) => x >= 0 && y >= 0 && x < width && y < height);
}

export function rasterLine(from, to) {
  const cells = [];
  let x = from.x;
  let y = from.y;
  const deltaX = Math.abs(to.x - from.x);
  const stepX = from.x < to.x ? 1 : -1;
  const deltaY = -Math.abs(to.y - from.y);
  const stepY = from.y < to.y ? 1 : -1;
  let error = deltaX + deltaY;

  while (true) {
    cells.push({ x, y });
    if (x === to.x && y === to.y) break;
    const doubledError = 2 * error;
    if (doubledError >= deltaY) {
      error += deltaY;
      x += stepX;
    }
    if (doubledError <= deltaX) {
      error += deltaX;
      y += stepY;
    }
  }

  return cells;
}

export function applyStamp(
  pixels,
  width,
  height,
  anchor,
  brushSize,
  color,
  seen,
) {
  const changes = [];

  for (const cell of cellsForStamp(anchor, brushSize, width, height)) {
    const index = cellIndex(cell.x, cell.y, width);
    if (seen.has(index)) continue;
    seen.add(index);

    const previous = pixels[index];
    if (previous === color) continue;
    pixels[index] = color;
    changes.push({ index, previous, color });
  }

  return changes;
}

export function hexToArgb(hex) {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return (0xff000000 | Number.parseInt(value, 16)) | 0;
}

export function argbToHex(argb) {
  const alpha = (argb >>> 24) & 0xff;
  if (alpha === 0) return "#000000";
  return `#${(argb >>> 0).toString(16).slice(2).padStart(6, "0")}`;
}

export function copyPixels(pixels) {
  return new Int32Array(pixels);
}
