// @ts-check

import { CANVAS_HEIGHT, CANVAS_WIDTH } from "./paint-engine.js";
import { decodeCells } from "./cell-codec.js";

/** @param {string} value @returns {Uint8Array} */
export function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

/** @param {string} value @returns {Int32Array} */
export function decodePixels(value) {
  const bytes = decodeBase64(value);
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

/** @param {CanvasRenderingContext2D} context @param {Int32Array} pixels */
export function drawPixels(context, pixels) {
  const image = context.createImageData(CANVAS_WIDTH, CANVAS_HEIGHT);
  for (let index = 0; index < pixels.length; index++) {
    const argb = pixels[index];
    image.data[index * 4] = (argb >>> 16) & 0xff;
    image.data[index * 4 + 1] = (argb >>> 8) & 0xff;
    image.data[index * 4 + 2] = argb & 0xff;
    image.data[index * 4 + 3] = (argb >>> 24) & 0xff;
  }
  context.putImageData(image, 0, 0);
}

/** @param {Int32Array} pixels @param {string} encodedCells */
export function applyEncodedCells(pixels, encodedCells) {
  for (const [index, color] of decodeCells(decodeBase64(encodedCells))) {
    pixels[index] = color;
  }
}

/** @param {HTMLCanvasElement} canvas */
export function paintingContext(canvas) {
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  return /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d", {
    alpha: false,
  }));
}
