// @ts-check

import { assertEquals } from "@std/assert";
import {
  addColorToWell,
  clearWell,
  colorFromWell,
  emptyWell,
  rgbFromHex,
} from "../src/client/palette-engine.js";

Deno.test("custom wells start empty and display the specified empty color", () => {
  assertEquals(emptyWell(), {
    totalRed: 0,
    totalGreen: 0,
    totalBlue: 0,
    totalMaximum: 0,
    numberOfColors: 0,
  });
  assertEquals(colorFromWell(emptyWell()), "#ffece5");
});

Deno.test("mixing stores each source RGB value and its maximum", () => {
  const mixed = addColorToWell(emptyWell(), "#b02e26");
  assertEquals(mixed, {
    totalRed: 176,
    totalGreen: 46,
    totalBlue: 38,
    totalMaximum: 176,
    numberOfColors: 1,
  });
  assertEquals(colorFromWell(mixed), "#b02e26");
});

Deno.test("mixing uses integer averages and brightness gain", () => {
  const redThenBlue = addColorToWell(
    addColorToWell(emptyWell(), "#ff0000"),
    "#0000ff",
  );
  assertEquals(colorFromWell(redThenBlue), "#fe00fe");
});

Deno.test("invalid source colors leave a well unchanged", () => {
  const well = emptyWell();
  assertEquals(addColorToWell(well, "rgb(0 0 0)"), well);
  assertEquals(rgbFromHex("#abc"), null);
});

Deno.test("water clearing resets every custom-well accumulator", () => {
  const filled = addColorToWell(emptyWell(), "#3c44aa");
  assertEquals(clearWell(filled), emptyWell());
});
