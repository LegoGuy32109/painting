// A minimal PNG decoder, purpose-built as the read-side counterpart to
// scripts/generate-icons.ts's hand-rolled encoder. It only needs to handle
// what that encoder ever produces: 8-bit RGBA (colorType 6), non-interlaced,
// zlib-format (RFC1950) IDAT data — so this deliberately does NOT support
// palette/grayscale images, bit depths other than 8, or interlacing. Any of
// those throw rather than silently misdecoding.
//
// Unfiltering (the per-scanline None/Sub/Up/Average/Paeth reconstruction)
// IS implemented in full per the PNG spec, even though the encoder only
// ever emits filter type "None" today — decoding what the file actually
// says, rather than assuming the encoder's current behavior, is the whole
// point of testing against real bytes instead of the source pixel grid.

const SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Uint8Array;
  at(x: number, y: number): [r: number, g: number, b: number, a: number];
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) | bytes[offset + 3]
  ) >>> 0;
}

async function inflateZlib(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate");
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
  let length = 0;
  for (const chunk of chunks) length += chunk.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decodes a PNG produced by scripts/generate-icons.ts's encoder (8-bit RGBA, non-interlaced). */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) {
      throw new Error("not a PNG file (bad signature)");
    }
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Uint8Array[] = [];

  let offset = SIGNATURE.length;
  while (offset < bytes.length) {
    const length = readU32BE(bytes, offset);
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = readU32BE(data, 0);
      height = readU32BE(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `unsupported PNG shape: bitDepth=${bitDepth} colorType=${colorType} ` +
        `(this decoder only handles 8-bit RGBA)`,
    );
  }
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");

  let idatLength = 0;
  for (const part of idatParts) idatLength += part.byteLength;
  const idat = new Uint8Array(idatLength);
  {
    let o = 0;
    for (const part of idatParts) {
      idat.set(part, o);
      o += part.byteLength;
    }
  }

  const raw = await inflateZlib(idat);
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = new Uint8Array(width * height * bytesPerPixel);
  let prevRow = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + stride);
    const filterType = raw[rowStart];
    const filtered = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const outRow = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= bytesPerPixel ? outRow[i - bytesPerPixel] : 0;
      const up = prevRow[i];
      const upLeft = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = filtered[i];
          break;
        case 1:
          value = filtered[i] + left;
          break;
        case 2:
          value = filtered[i] + up;
          break;
        case 3:
          value = filtered[i] + Math.floor((left + up) / 2);
          break;
        case 4:
          value = filtered[i] + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`unknown PNG filter type ${filterType}`);
      }
      outRow[i] = value & 0xff;
    }
    pixels.set(outRow, y * stride);
    prevRow = outRow;
  }

  return {
    width,
    height,
    pixels,
    at(x: number, y: number) {
      const o = (y * width + x) * 4;
      return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]];
    },
  };
}
