import {
  appendEvents,
  type Client,
  completeCanvas,
  createCanvas,
  storeCanvasPixels,
} from "../../src/server/db.ts";
import { createPixels } from "../../src/shared/paint-engine.js";
import { composeCanvas } from "../../src/shared/compose.js";
import type { CanvasEventRow, NewEvent } from "../../src/server/db.ts";

interface FixtureEvent {
  id: string;
  kind: "stroke" | "undo";
  strokeId: string | null;
  cells: number[] | null;
  revertsId: string | null;
  clientTs: number;
}

interface FixtureRecording {
  id: string;
  title: string;
  events: FixtureEvent[];
}

export async function seedCompletedFixtures(
  db: Client,
  url: string,
  token: string,
  minimumCount = 21,
): Promise<string[]> {
  const fixture = JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/live-paintings.json", import.meta.url),
    ),
  ) as { recordings: FixtureRecording[] };
  const ids: string[] = [];
  const count = Math.max(minimumCount, fixture.recordings.length);
  for (let recordingIndex = 0; recordingIndex < count; recordingIndex++) {
    const recording =
      fixture.recordings[recordingIndex % fixture.recordings.length];
    // The full recordings remain unit-test fixtures. Browser setup only needs
    // enough real strokes to prove replay timing and rendering without sending
    // thousands of fixture INSERTs to a newly provisioned cloud database.
    const fixtureEvents = recording.events.slice(0, 40);
    const id = `01${String(recordingIndex + 1).padStart(24, "0")}`;
    ids.push(id);
    await createCanvas(
      db,
      id,
      `e2e-fixture-owner-${recordingIndex}`,
      new Uint8Array(createPixels().buffer),
      fixtureEvents[0]?.clientTs ?? Date.now(),
    );
    const events: NewEvent[] = fixtureEvents.map((event, eventIndex) => ({
      id: `FIXTURE-EVENT-${recordingIndex}-${eventIndex}`,
      kind: event.kind,
      strokeId: event.strokeId,
      cells: event.cells ? new Uint8Array(event.cells) : null,
      revertsId: event.revertsId,
      clientTs: event.clientTs,
    }));
    await appendEvents(url, token, id, events, false, Date.now());
    await completeCanvas(
      db,
      id,
      `${recording.title} ${recordingIndex + 1}`,
      Date.now() + recordingIndex,
    );
    const rows = fixtureEvents.map((event, index) => ({
      sequence: index + 1,
      id: events[index].id,
      canvasId: id,
      kind: event.kind,
      strokeId: event.strokeId,
      cells: event.cells ? new Uint8Array(event.cells) : null,
      revertsId: event.revertsId,
      clientTs: event.clientTs,
      receivedAt: event.clientTs,
    })) as CanvasEventRow[];
    await storeCanvasPixels(
      db,
      id,
      new Uint8Array(composeCanvas(rows).buffer),
    );
  }
  return ids;
}
