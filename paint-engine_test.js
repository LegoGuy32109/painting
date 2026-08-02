import { assertEquals } from "@std/assert";
import {
  applyStamp,
  argbToHex,
  blendArgb,
  BRUSH_OFFSETS,
  brushAnchor,
  copyPixels,
  createPixels,
  hexToArgb,
  OPAQUE_WHITE,
  rasterLine,
} from "./paint-engine.js";

Deno.test("new opaque pixels use Minecraft white", () => {
  const pixels = createPixels(2, 2);
  assertEquals([...pixels], [
    OPAQUE_WHITE,
    OPAQUE_WHITE,
    OPAQUE_WHITE,
    OPAQUE_WHITE,
  ]);
});

Deno.test("brush offsets preserve the specified cell counts", () => {
  assertEquals(BRUSH_OFFSETS[1].length, 1);
  assertEquals(BRUSH_OFFSETS[2].length, 4);
  assertEquals(BRUSH_OFFSETS[3].length, 12);
  assertEquals(BRUSH_OFFSETS[4].length, 21);
});

Deno.test("brushes one and four anchor at the cell under the pointer", () => {
  assertEquals(brushAnchor(47.9, 24.1, 24, 1), { x: 1, y: 1 });
  assertEquals(brushAnchor(47.9, 24.1, 24, 4), { x: 1, y: 1 });
});

Deno.test("brushes two and three resolve halfway anchors right and down", () => {
  assertEquals(brushAnchor(12, 36, 24, 2), { x: 1, y: 2 });
  assertEquals(brushAnchor(12, 36, 24, 3), { x: 1, y: 2 });
});

Deno.test("a stamp clips cells beyond the canvas edge", () => {
  const pixels = createPixels(3, 3);
  const red = hexToArgb("#b02e26");
  const changes = applyStamp(
    pixels,
    3,
    3,
    { x: 0, y: 0 },
    4,
    red,
    100,
    new Set(),
  );

  assertEquals(changes.map(({ index }) => index), [
    6,
    7,
    3,
    4,
    5,
    0,
    1,
    2,
  ]);
  assertEquals([...pixels], [
    red,
    red,
    red,
    red,
    red,
    red,
    red,
    red,
    OPAQUE_WHITE,
  ]);
});

Deno.test("one drag never changes the same cell twice", () => {
  const pixels = createPixels(3, 3);
  const seen = new Set();
  const blue = hexToArgb("#3c44aa");
  const first = applyStamp(pixels, 3, 3, { x: 1, y: 1 }, 2, blue, 100, seen);
  const second = applyStamp(pixels, 3, 3, { x: 1, y: 1 }, 2, blue, 100, seen);

  assertEquals(first.length, 4);
  assertEquals(second.length, 0);
});

Deno.test("a stamp writes row-major pixel indexes", () => {
  const pixels = createPixels(4, 3);
  const green = hexToArgb("#5e7c16");
  applyStamp(pixels, 4, 3, { x: 2, y: 1 }, 1, green, 100, new Set());

  assertEquals(pixels[6], green);
  assertEquals(pixels[5], OPAQUE_WHITE);
});

Deno.test("undo snapshots do not share storage with later pixel writes", () => {
  const pixels = createPixels(2, 2);
  const snapshot = copyPixels(pixels);
  pixels[0] = hexToArgb("#1d1d21");

  assertEquals(snapshot[0], OPAQUE_WHITE);
  assertEquals(pixels[0], hexToArgb("#1d1d21"));
});

Deno.test("opacity blending uses the specified integer brightness gain", () => {
  const red = hexToArgb("#ff0000");
  const blue = hexToArgb("#0000ff");

  assertEquals(argbToHex(blendArgb(blue, red, 100)), "#ff0000");
  assertEquals(argbToHex(blendArgb(blue, red, 75)), "#bf003f");
  assertEquals(argbToHex(blendArgb(blue, red, 50)), "#fe00fe");
  assertEquals(argbToHex(blendArgb(blue, red, 25)), "#3f00bf");
});

Deno.test("a partially opaque stamp stores its blended result", () => {
  const pixels = new Int32Array([hexToArgb("#0000ff")]);
  const changes = applyStamp(
    pixels,
    1,
    1,
    { x: 0, y: 0 },
    1,
    hexToArgb("#ff0000"),
    50,
    new Set(),
  );

  assertEquals(argbToHex(changes[0].color), "#fe00fe");
  assertEquals(argbToHex(pixels[0]), "#fe00fe");
});

Deno.test("rasterized lines contain every anchor between fast pointer samples", () => {
  assertEquals(rasterLine({ x: 0, y: 0 }, { x: 4, y: 2 }), [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 3, y: 2 },
    { x: 4, y: 2 },
  ]);
});

Deno.test("ARGB conversion keeps stored colors signed and picker RGB opaque", () => {
  const black = hexToArgb("#1d1d21");
  assertEquals(black < 0, true);
  assertEquals(argbToHex(black), "#1d1d21");
  assertEquals(argbToHex(0), "#000000");
  assertEquals(hexToArgb("not-a-color"), null);
});
