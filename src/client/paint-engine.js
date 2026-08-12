// @ts-check

/** @typedef {import("./paint-types.d.ts").BrushBounds} BrushBounds */
/** @typedef {import("./paint-types.d.ts").BrushSize} BrushSize */
/** @typedef {import("./paint-types.d.ts").Cell} Cell */
/** @typedef {import("./paint-types.d.ts").OpacityPercent} OpacityPercent */
/** @typedef {import("./paint-types.d.ts").PixelChange} PixelChange */

export const CANVAS_WIDTH = 16;
export const CANVAS_HEIGHT = 16;
export const OPAQUE_WHITE = 0xfff9fffe | 0;

/** @type {Readonly<Record<BrushSize, readonly number[][]>>} */
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

/** @type {Readonly<Record<BrushSize, Readonly<BrushBounds>>>} */
export const BRUSH_BOUNDS = Object.freeze({
  1: Object.freeze({ minX: 0, minY: 0, size: 1 }),
  2: Object.freeze({ minX: -1, minY: -1, size: 2 }),
  3: Object.freeze({ minX: -2, minY: -2, size: 4 }),
  4: Object.freeze({ minX: -2, minY: -2, size: 5 }),
});

/**
 * @param {number} [width]
 * @param {number} [height]
 * @param {number} [color]
 * @returns {Int32Array}
 */
export function createPixels(
  width = CANVAS_WIDTH,
  height = CANVAS_HEIGHT,
  color = OPAQUE_WHITE,
) {
  return new Int32Array(width * height).fill(color);
}

/** @param {number} x @param {number} y @param {number} width */
export function cellIndex(x, y, width) {
  return y * width + x;
}

/** @param {number} position @param {number} cellSize */
export function cellUnderPointer(position, cellSize) {
  return Math.floor(position / cellSize);
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} cellSize
 * @param {BrushSize} brushSize
 * @returns {Cell}
 */
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

/**
 * @param {Cell} anchor
 * @param {BrushSize} brushSize
 * @param {number} width
 * @param {number} height
 * @returns {Cell[]}
 */
export function cellsForStamp(anchor, brushSize, width, height) {
  return BRUSH_OFFSETS[brushSize]
    .map(([offsetX, offsetY]) => ({
      x: anchor.x + offsetX,
      y: anchor.y + offsetY,
    }))
    .filter(({ x, y }) => x >= 0 && y >= 0 && x < width && y < height);
}

/** @param {Cell} from @param {Cell} to @returns {Cell[]} */
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

/**
 * @param {number} existingColor
 * @param {number} paintColor
 * @param {OpacityPercent} opacityPercent
 * @returns {number}
 */
export function blendArgb(existingColor, paintColor, opacityPercent) {
  if (![25, 50, 75, 100].includes(opacityPercent)) {
    throw new RangeError("Opacity must be 25, 50, 75, or 100");
  }

  const paintRed = (paintColor >>> 16) & 0xff;
  const paintGreen = (paintColor >>> 8) & 0xff;
  const paintBlue = paintColor & 0xff;
  const existingRed = (existingColor >>> 16) & 0xff;
  const existingGreen = (existingColor >>> 8) & 0xff;
  const existingBlue = existingColor & 0xff;
  const remainingOpacity = 100 - opacityPercent;
  /** @param {number} paint @param {number} existing */
  const blendChannel = (paint, existing) =>
    Math.floor(opacityPercent * paint / 100) +
    Math.floor(remainingOpacity * existing / 100);
  const red = blendChannel(paintRed, existingRed);
  const green = blendChannel(paintGreen, existingGreen);
  const blue = blendChannel(paintBlue, existingBlue);
  const targetPeak = Math.floor(
    opacityPercent * Math.max(paintRed, paintGreen, paintBlue) / 100,
  ) +
    Math.floor(
      remainingOpacity * Math.max(existingRed, existingGreen, existingBlue) /
        100,
    );
  const unscaledPeak = Math.max(red, green, blue);
  const gain = unscaledPeak === 0 ? 0 : Math.floor(targetPeak / unscaledPeak);

  return (0xff000000 | gain * red << 16 | gain * green << 8 | gain * blue) | 0;
}

/**
 * @param {Int32Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {Cell} anchor
 * @param {BrushSize} brushSize
 * @param {number} color
 * @param {OpacityPercent} opacityPercent
 * @param {Set<number>} seen
 * @returns {PixelChange[]}
 */
export function applyStamp(
  pixels,
  width,
  height,
  anchor,
  brushSize,
  color,
  opacityPercent,
  seen,
) {
  const changes = [];

  for (const cell of cellsForStamp(anchor, brushSize, width, height)) {
    const index = cellIndex(cell.x, cell.y, width);
    if (seen.has(index)) continue;
    seen.add(index);

    const previous = pixels[index];
    const blendedColor = blendArgb(previous, color, opacityPercent);
    if (previous === blendedColor) continue;
    pixels[index] = blendedColor;
    changes.push({ index, previous, color: blendedColor });
  }

  return changes;
}

/** @param {string} hex @returns {number | null} */
export function hexToArgb(hex) {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return (0xff000000 | Number.parseInt(value, 16)) | 0;
}

/** @param {number} argb @returns {string} */
export function argbToHex(argb) {
  const alpha = (argb >>> 24) & 0xff;
  if (alpha === 0) return "#000000";
  return `#${(argb >>> 0).toString(16).slice(2).padStart(6, "0")}`;
}

/** @param {Int32Array} pixels @returns {Int32Array} */
export function copyPixels(pixels) {
  return new Int32Array(pixels);
}
