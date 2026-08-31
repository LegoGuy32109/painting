// Generates every PWA icon PNG in public/icons/ from a tiny hand-authored
// pixel-art grid, so the icons are reproducible and reviewable as code
// rather than committed as opaque binaries someone hand-exported once.
//
// No image library, and none was added: Deno has everything needed to write
// a valid PNG by hand —
//   - CompressionStream("deflate") implements RFC1950 zlib-format DEFLATE,
//     which is exactly the compressed format a PNG IDAT chunk's payload
//     must be (not the raw RFC1951 "deflate-raw" variant).
//   - a CRC-32 table, which every PNG chunk's trailer needs.
// That is the whole encoder; see encodePng() below.
//
// The artwork itself is generated, not drawn pixel-by-pixel by hand: a
// concentric-square "bullseye" using the app's fixed 16-colour Minecraft-
// derived palette (docs/joy-of-painting-interface-spec.md), scaled up by an
// INTEGER factor with nearest-neighbour sampling only (never bilinear —
// that would destroy the pixel-art look). Two band layouts are used:
//   - FULL_BLEED_BANDS: fills almost the entire square, background is
//     transparent (icon-192/512) or the app's cream background (the
//     apple-touch icon, since iOS handles a transparent icon badly).
//   - MASKABLE_BANDS: the artwork is kept inside the ~40%-of-size safe
//     radius Android's most aggressive (circular) mask uses, with the
//     cream background filling the rest of the square so nothing but
//     intended background gets clipped.

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The app's fixed 16-colour palette — see the "Base palette" table in
// docs/joy-of-painting-interface-spec.md. Values must match exactly.
const PALETTE = {
  black: hexToRgb("#1D1D21"),
  red: hexToRgb("#B02E26"),
  green: hexToRgb("#5E7C16"),
  brown: hexToRgb("#835432"),
  blue: hexToRgb("#3C44AA"),
  purple: hexToRgb("#8932B8"),
  cyan: hexToRgb("#169C9C"),
  lightGray: hexToRgb("#9D9D97"),
  gray: hexToRgb("#474F52"),
  pink: hexToRgb("#F38BAA"),
  lime: hexToRgb("#80C71F"),
  yellow: hexToRgb("#FED83D"),
  lightBlue: hexToRgb("#3AB3DA"),
  magenta: hexToRgb("#C74EBD"),
  orange: hexToRgb("#F9801D"),
  white: hexToRgb("#F9FFFE"),
} as const satisfies Record<string, [number, number, number]>;

// Matches the app's <meta name="theme-color"> / manifest background_color.
const BACKGROUND_CREAM = hexToRgb("#F0E0AE");

type RGBA = [number, number, number, number];
type PaletteKey = keyof typeof PALETTE;

interface Band {
  /** Chebyshev distance from center, as a fraction of the distance to an edge midpoint. */
  upToFraction: number;
  color: PaletteKey;
}

const FULL_BLEED_BANDS: Band[] = [
  { upToFraction: 0.07, color: "white" },
  { upToFraction: 0.33, color: "red" },
  { upToFraction: 0.60, color: "yellow" },
  { upToFraction: 0.87, color: "lightBlue" },
];

// The outer fraction here must keep half-width * sqrt(2) <= 0.4 * size (the
// radius of Android's maskable safe-zone circle) — i.e. this fraction must
// stay under ~0.566. 0.50 leaves real margin rather than skating the edge.
const MASKABLE_BANDS: Band[] = [
  { upToFraction: 0.08, color: "white" },
  { upToFraction: 0.22, color: "red" },
  { upToFraction: 0.36, color: "yellow" },
  { upToFraction: 0.50, color: "lightBlue" },
];

function buildGrid(
  baseSize: number,
  bands: Band[],
  background: [number, number, number] | null,
): RGBA[][] {
  const center = (baseSize - 1) / 2;
  const grid: RGBA[][] = [];
  for (let y = 0; y < baseSize; y++) {
    const row: RGBA[] = [];
    for (let x = 0; x < baseSize; x++) {
      const distance = Math.max(Math.abs(x - center), Math.abs(y - center));
      const fraction = center === 0 ? 0 : distance / center;
      const band = bands.find((candidate) =>
        fraction <= candidate.upToFraction
      );
      if (band) {
        const [r, g, b] = PALETTE[band.color];
        row.push([r, g, b, 255]);
      } else if (background) {
        const [r, g, b] = background;
        row.push([r, g, b, 255]);
      } else {
        row.push([0, 0, 0, 0]);
      }
    }
    grid.push(row);
  }
  return grid;
}

/** Nearest-neighbour upscale by an INTEGER factor only — never resample. */
function upscale(
  grid: RGBA[][],
  scale: number,
): { width: number; height: number; rgba: Uint8Array } {
  if (!Number.isInteger(scale) || scale < 1) {
    throw new Error(`scale must be a positive integer, got ${scale}`);
  }
  const baseSize = grid.length;
  const size = baseSize * scale;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < size; x++) {
      const srcX = Math.floor(x / scale);
      const [r, g, b, a] = grid[srcY][srcX];
      const offset = (y * size + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }
  return { width: size, height: size, rgba };
}

// --- Minimal PNG encoder ---------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const crc = crc32(concatBytes([typeBytes, data]));
  return concatBytes([u32be(data.length), typeBytes, data, u32be(crc)]);
}

/** zlib-format (RFC1950) DEFLATE — exactly what a PNG IDAT payload must be. */
async function deflateZlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  const writePromise = writer.write(data).then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  await writePromise;
  return concatBytes(chunks);
}

async function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  const signature = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  const ihdrData = concatBytes([
    u32be(width),
    u32be(height),
    // bit depth 8, color type 6 (RGBA), compression 0, filter 0, interlace 0
    new Uint8Array([8, 6, 0, 0, 0]),
  ]);
  const ihdr = pngChunk("IHDR", ihdrData);

  const stride = width * 4;
  const raw = new Uint8Array(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    raw[rowStart] = 0; // filter type "None" for every scanline
    raw.set(rgba.subarray(y * stride, y * stride + stride), rowStart + 1);
  }
  const idat = pngChunk("IDAT", await deflateZlib(raw));
  const iend = pngChunk("IEND", new Uint8Array(0));
  return concatBytes([signature, ihdr, idat, iend]);
}

// --- Generate every icon ----------------------------------------------------

async function writeIcon(
  filename: string,
  baseSize: number,
  scale: number,
  bands: Band[],
  background: [number, number, number] | null,
): Promise<void> {
  const grid = buildGrid(baseSize, bands, background);
  const { width, height, rgba } = upscale(grid, scale);
  const png = await encodePng(width, height, rgba);
  const outDir = new URL("../public/icons/", import.meta.url);
  await Deno.mkdir(outDir, { recursive: true });
  const path = new URL(filename, outDir);
  await Deno.writeFile(path, png);
  console.log(`wrote ${filename} (${width}x${height})`);
}

if (import.meta.main) {
  // 16-base * 12 = 192; 16-base * 32 = 512 — both integer nearest-neighbour scales.
  await writeIcon("icon-192.png", 16, 12, FULL_BLEED_BANDS, null);
  await writeIcon("icon-512.png", 16, 32, FULL_BLEED_BANDS, null);
  await writeIcon(
    "icon-512-maskable.png",
    16,
    32,
    MASKABLE_BANDS,
    BACKGROUND_CREAM,
  );
  // Apple wants exactly 180x180. 15 has no clean common base with 16 that
  // also divides 512/192, so it gets its own base size: 15 * 12 = 180,
  // still an exact integer nearest-neighbour scale.
  await writeIcon(
    "apple-touch-icon-180.png",
    15,
    12,
    FULL_BLEED_BANDS,
    BACKGROUND_CREAM,
  );
}
