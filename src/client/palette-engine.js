// @ts-check

/** @typedef {import("./paint-types.d.ts").PaletteWell} PaletteWell */

export const EMPTY_WELL_COLOR = "#ffece5";

/** @returns {PaletteWell} */
export function emptyWell() {
  return {
    totalRed: 0,
    totalGreen: 0,
    totalBlue: 0,
    totalMaximum: 0,
    numberOfColors: 0,
  };
}

/** @param {PaletteWell} _well */
export function clearWell(_well) {
  return emptyWell();
}

/** @param {string} color */
export function rgbFromHex(color) {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) return null;
  return match.slice(1).map((channel) => Number.parseInt(channel, 16));
}

/** @param {number} channel */
function hexChannel(channel) {
  return Math.max(0, Math.min(255, channel)).toString(16).padStart(2, "0");
}

/** @param {PaletteWell} well */
export function colorFromWell(well) {
  if (well.numberOfColors === 0) return EMPTY_WELL_COLOR;

  const red = Math.floor(well.totalRed / well.numberOfColors);
  const green = Math.floor(well.totalGreen / well.numberOfColors);
  const blue = Math.floor(well.totalBlue / well.numberOfColors);
  const maximum = Math.floor(well.totalMaximum / well.numberOfColors);
  const highest = Math.max(red, green, blue);
  const gain = highest === 0 ? 0 : Math.floor(maximum / highest);
  return `#${hexChannel(gain * red)}${hexChannel(gain * green)}${hexChannel(gain * blue)}`;
}

/** @param {PaletteWell} well @param {string} color */
export function addColorToWell(well, color) {
  const rgb = rgbFromHex(color);
  if (!rgb) return well;
  const [red, green, blue] = rgb;
  return {
    totalRed: well.totalRed + red,
    totalGreen: well.totalGreen + green,
    totalBlue: well.totalBlue + blue,
    totalMaximum: well.totalMaximum + Math.max(red, green, blue),
    numberOfColors: well.numberOfColors + 1,
  };
}
