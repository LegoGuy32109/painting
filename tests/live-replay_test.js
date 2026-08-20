// @ts-check

import { assertEquals } from "@std/assert";
import fixtures from "./fixtures/live-paintings.json" with { type: "json" };
import { decodeCells } from "../src/shared/cell-codec.js";
import { LiveReplay } from "../src/client/live-replay.js";
import { composeCanvas } from "../src/shared/compose.js";

/** @typedef {{ sequence: number, id: string, kind: string, strokeId: string | null, cells: number[] | null, revertsId: string | null, clientTs: number }} FixtureEvent */

/** @param {FixtureEvent} event */
function batchFor(event) {
  return {
    ts: event.clientTs,
    cells: decodeCells(new Uint8Array(event.cells ?? [])),
  };
}

/** @param {FixtureEvent[]} events */
function expectedPixels(events) {
  return composeCanvas(events.map((event) => ({
    ...event,
    cells: event.cells ? new Uint8Array(event.cells) : null,
  })));
}

for (const recording of fixtures.recordings) {
  Deno.test(`live replay keeps ${recording.title}'s ${recording.events.length} recorded batches in paint order`, () => {
    /** @type {FixtureEvent[]} */
    const strokes = recording.events.filter((event) =>
      event.kind === "stroke" && event.cells
    );
    const replay = new LiveReplay();
    const receivedAt = 10_000;

    // This is intentionally harsher than the normal 200ms cross-instance
    // poll: one SSE delivery carries an entire painting. Playback must still
    // follow the painter's timestamps rather than snap to its arrival time.
    replay.receive(strokes.map(batchFor), receivedAt);

    /** @type {Array<{ ts: number, cells: Array<[number, number]> }>} */
    const painted = [];
    for (const stroke of strokes) {
      const due = replay.drain(replay.targetTime(stroke.clientTs));
      painted.push(...due);
    }

    assertEquals(painted, strokes.map(batchFor));
    assertEquals(replay.queuedBatches, 0);
  });
}

Deno.test("live replay recovers from snake in clouds' undo snapshot without retaining stale queued strokes", () => {
  const recording = fixtures.recordings.find((entry) =>
    entry.title === "snake in clouds"
  );
  if (!recording) throw new Error("snake in clouds fixture is missing");

  const replay = new LiveReplay();
  const pixels = new Int32Array(256);
  let localTime = 50_000;

  for (let index = 0; index < recording.events.length; index++) {
    /** @type {FixtureEvent} */
    const event = recording.events[index];
    if (event.kind === "undo") {
      // The viewer receives a snapshot on undo because the server cannot
      // correctly express a retroactive stroke exclusion as an incremental
      // pixel diff. This mirrors active.html's snapshot branch.
      pixels.set(expectedPixels(recording.events.slice(0, index + 1)));
      replay.reset();
      continue;
    }
    if (event.kind !== "stroke" || !event.cells) continue;
    replay.receive([batchFor(event)], localTime);
    localTime = replay.targetTime(event.clientTs);
    for (const batch of replay.drain(localTime)) {
      for (const [cell, color] of batch.cells) pixels[cell] = color;
    }
    localTime += 30;
  }

  for (const batch of replay.drain(Number.POSITIVE_INFINITY)) {
    for (const [cell, color] of batch.cells) pixels[cell] = color;
  }
  assertEquals([...pixels], [...expectedPixels(recording.events)]);
});
