// Seeds a handful of fake canvases into whatever TURSO_DB_URL/TURSO_DB_TOKEN
// currently point at (painting-local by default) so /dev/active and
// /dev/completed have something to render. Nothing in the app writes to the
// db yet — sync.js hasn't been built — so this is the only way to test those
// pages for now.
//
// Usage: deno run --allow-net --allow-env scripts/seed-dev-canvases.ts

import {
  appendEvents,
  completeCanvas,
  createCanvas,
  createDb,
} from "../src/server/db.ts";
import { ulid } from "../src/shared/ulid.js";
import { createPixels } from "../src/shared/paint-engine.js";
import { encodeCells } from "../src/shared/cell-codec.js";

const db = createDb();
const url = Deno.env.get("TURSO_DB_URL")!;
const token = Deno.env.get("TURSO_DB_TOKEN")!;
const now = Date.now();

/** The 16 base palette colours from docs/joy-of-painting-interface-spec.md. */
const PALETTE = [
  0xff1d1d21,
  0xffb02e26,
  0xff5e7c16,
  0xff835432,
  0xff3c44aa,
  0xff8932b8,
  0xff169c9c,
  0xff9d9d97,
  0xff474f52,
  0xfff38baa,
  0xff80c71f,
  0xfffed83d,
  0xff3ab3da,
  0xffc74ebd,
  0xfff9801d,
  0xfff9fffe,
].map((argb) => argb | 0);

/**
 * Builds a canvas as MANY small strokes whose client timestamps are spread
 * across `spanMs`, ending at `endTs`.
 *
 * This matters more than it looks. A seeded canvas used to be one stroke
 * stamped with a single `now`, so the server-built replay timeline came back
 * with `durationMs: 0` and `steps: 1`. In the parade that makes
 * `elapsed >= timeline.durationMs` true on the very first tick, so the card
 * jumps straight to its final frame and reads SIGNED immediately — seeded
 * content was structurally incapable of exercising, or demonstrating, the
 * replay animation at all.
 *
 * Sky on top, ground below, painted a few cells at a time in reading order
 * so the replay visibly builds the image rather than flickering at random.
 */
function timedStrokes(
  endTs: number,
  spanMs: number,
  skyColor: number,
  groundColor: number,
): Array<{
  id: string;
  kind: "stroke";
  strokeId: string;
  cells: Uint8Array;
  clientTs: number;
}> {
  const strokes = [];
  const cellsPerStroke = 4;
  const total = 256 / cellsPerStroke; // 64 strokes over a 16x16 canvas
  for (let step = 0; step < total; step++) {
    /** @type {Array<[number, number]>} */
    const cells: Array<[number, number]> = [];
    for (let n = 0; n < cellsPerStroke; n++) {
      const index = step * cellsPerStroke + n;
      const row = Math.floor(index / 16);
      // A horizon two-thirds down, with a little dithering either side of it
      // so the result reads as pixel art rather than two flat bands.
      const base = row < 10 ? skyColor : groundColor;
      const dither = (index * 7 + row * 3) % 11 === 0;
      cells.push([index, dither ? PALETTE[(row + index) % 16] : base]);
    }
    strokes.push({
      id: ulid(),
      kind: "stroke" as const,
      strokeId: ulid(),
      cells: encodeCells(cells),
      clientTs: Math.round(endTs - spanMs + (step + 1) * (spanMs / total)),
    });
  }
  return strokes;
}

// canvases_owner_draft_idx is a partial unique index enforcing exactly one
// open (unsigned) draft per owner — a deliberate, load-bearing invariant of
// this app — so a shared owner made this script runnable exactly once per
// database, failing every later run with "UNIQUE constraint failed:
// canvases.owner_id". Seeding is supposed to be repeatable.
function seedOwner(): string {
  return `dev-seed-${ulid()}`;
}

async function seedActive() {
  const id = ulid();
  await createCanvas(
    db,
    id,
    seedOwner(),
    new Uint8Array(createPixels().buffer),
    now,
  );
  await appendEvents(
    url,
    token,
    id,
    timedStrokes(now, 45_000, PALETTE[12], PALETTE[2]),
    true,
    now,
  );
  console.log("active:", id);
}

async function seedCompleted(title: string) {
  const id = ulid();
  await createCanvas(
    db,
    id,
    seedOwner(),
    new Uint8Array(createPixels().buffer),
    now,
  );
  await appendEvents(
    url,
    token,
    id,
    timedStrokes(now, 40_000, PALETTE[14], PALETTE[8]),
    false,
    now,
  );
  await completeCanvas(db, id, title, "Dev Owner", now);
  console.log("completed:", id, title);
}

await seedActive();
await seedActive();
await seedCompleted("Mountain at Dusk");
await seedCompleted("Untitled Blob");
