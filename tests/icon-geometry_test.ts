// Verifies public/icons/icon-512-maskable.png keeps its artwork inside
// Android's circular maskable safe zone — the OS is free to clip anything
// outside the central 80%-diameter circle (40% radius) when it applies its
// own mask shape, so anything drawn past that boundary can be cut off on a
// real device even though it renders fine everywhere else.
//
// This decodes the ACTUAL shipped PNG bytes (see tests/support/png-decode.ts)
// rather than re-deriving the source pixel grid from
// scripts/generate-icons.ts — so a regression in the encoder itself, or a
// hand-edited/replaced icon file, would be caught here too.
//
// No browser needed: runs under `deno task test`, which already grants
// --allow-read=public,src/client,src/shared.

import { assert } from "@std/assert";
import { decodePng } from "./support/png-decode.ts";

const BACKGROUND_CREAM: [number, number, number] = [0xf0, 0xe0, 0xae];

Deno.test("icon-512-maskable.png keeps all artwork inside the 80% safe circle", async () => {
  const bytes = await Deno.readFile(
    new URL("../public/icons/icon-512-maskable.png", import.meta.url),
  );
  const png = await decodePng(bytes);
  assert(png.width === png.height, "maskable icon must be square");

  const size = png.width;
  const center = (size - 1) / 2;
  // Android's maskable icon spec: the safe zone is a circle of diameter
  // 80% of the icon size, centered — i.e. radius 40% of size.
  const safeRadius = 0.4 * size;

  let nonBackgroundCount = 0;
  const offenders: Array<{ x: number; y: number; distance: number }> = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = png.at(x, y);
      const isBackground = a === 0 ||
        (r === BACKGROUND_CREAM[0] && g === BACKGROUND_CREAM[1] &&
          b === BACKGROUND_CREAM[2]);
      if (isBackground) continue;
      nonBackgroundCount++;
      const dx = x - center;
      const dy = y - center;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > safeRadius) {
        offenders.push({ x, y, distance });
      }
    }
  }

  // Sanity check on the decoder/fixture itself: an icon with NO artwork at
  // all would trivially "pass" a geometry check that never runs, so make
  // sure there is actually something drawn to test.
  assert(
    nonBackgroundCount > 0,
    "decoded icon has no non-background pixels at all — decoder or fixture is wrong",
  );

  if (offenders.length > 0) {
    const worst = offenders.reduce((a, b) => a.distance > b.distance ? a : b);
    throw new Error(
      `${offenders.length} non-background pixel(s) fall outside the safe ` +
        `circle (radius ${safeRadius.toFixed(1)}px); worst offender at ` +
        `(${worst.x}, ${worst.y}), distance ${worst.distance.toFixed(1)}px ` +
        `from center`,
    );
  }
});
