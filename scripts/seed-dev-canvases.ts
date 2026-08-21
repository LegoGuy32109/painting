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

/** A small diagonal streak of a given color, so seeded canvases are visibly non-blank. */
function diagonalStreak(argb: number): Array<[number, number]> {
  return Array.from({ length: 6 }, (_, i) => [i * 17 + i, argb]);
}

async function seedActive() {
  const id = ulid();
  await createCanvas(
    db,
    id,
    "dev-owner",
    new Uint8Array(createPixels().buffer),
    now,
  );
  await appendEvents(
    url,
    token,
    id,
    [{
      id: ulid(),
      kind: "stroke",
      strokeId: ulid(),
      cells: encodeCells(diagonalStreak(0xffef7d57 | 0)),
      clientTs: now,
    }],
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
    "dev-owner",
    new Uint8Array(createPixels().buffer),
    now,
  );
  await appendEvents(
    url,
    token,
    id,
    [{
      id: ulid(),
      kind: "stroke",
      strokeId: ulid(),
      cells: encodeCells(diagonalStreak(0xff5b8dd9 | 0)),
      clientTs: now,
    }],
    false,
    now,
  );
  await completeCanvas(db, id, title, now);
  console.log("completed:", id, title);
}

await seedActive();
await seedActive();
await seedCompleted("Mountain at Dusk");
await seedCompleted("Untitled Blob");
