/**
 * Copies the three hand-painted recordings from painting-local into a stable
 * test fixture. Tests then replay real sessions without network credentials.
 *
 * deno run --allow-env --allow-net --allow-write scripts/capture-live-replay-fixtures.ts
 */
import { createDb, pullEventsSince } from "../src/server/db.ts";

const canvases = [
  { id: "01M0DZ4Z9QM663V6FB9S", title: "claude returning" },
  { id: "01M0E6962H4EQREDJSTM", title: "bubblegum man" },
  { id: "01M0E6F0ZT4F7RKYET0A", title: "snake in clouds" },
];

const db = createDb();
const recordings = await Promise.all(canvases.map(async ({ id, title }) => {
  const { events } = await pullEventsSince(db, id, 0);
  return {
    id,
    title,
    events: events.map((event) => ({
      sequence: event.sequence,
      id: event.id,
      kind: event.kind,
      strokeId: event.strokeId,
      cells: event.cells ? Array.from(event.cells) : null,
      revertsId: event.revertsId,
      clientTs: event.clientTs,
      receivedAt: event.receivedAt,
    })),
  };
}));

await Deno.writeTextFile(
  new URL("../tests/fixtures/live-paintings.json", import.meta.url),
  `${JSON.stringify({ recordings }, null, 2)}\n`,
);
