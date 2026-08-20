import type { CanvasEventRow } from "./db.ts";
import { composeCanvas } from "../shared/compose.js";
import type {
  CanvasReplayResponse,
  ReplayStep,
} from "../shared/paint-types.d.ts";

export const REPLAY_EVENT_LIMIT = 140;
export const MAX_REPLAY_GAP_MS = 500;
export const MAX_REPLAY_DURATION_MS = 44_000;
export const MAX_CANVAS_EVENTS = 20_000;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function pixelsBase64(events: CanvasEventRow[]): string {
  const pixels = composeCanvas(events);
  return base64(new Uint8Array(pixels.buffer));
}

/**
 * Produces a bounded event-count replay. Stroke rows remain compact diffs;
 * undo rows become snapshots because they can remove a stroke from before the
 * replay. Sequence order is authoritative. Client timestamp gaps are clamped
 * so pauses cannot stall playback, then proportionally compressed if needed
 * so the signed frame is visible before its display card leaves.
 */
export function buildCanvasReplay(
  id: string,
  title: string,
  events: CanvasEventRow[],
  eventLimit = REPLAY_EVENT_LIMIT,
): CanvasReplayResponse {
  if (events.length > MAX_CANVAS_EVENTS) {
    throw new Error("canvas has too many events to replay");
  }
  if (events.length === 0) {
    const pixels = pixelsBase64([]);
    return {
      id,
      title,
      initialPixels: pixels,
      finalPixels: pixels,
      durationMs: 0,
      steps: [],
    };
  }

  const boundedLimit = Math.max(0, Math.floor(eventLimit));
  const split = Math.max(0, events.length - boundedLimit);
  const prefix = events.slice(0, split);
  const replayEvents = events.slice(split);
  const times: number[] = [];
  let elapsed = 0;
  let previous = replayEvents[0]?.clientTs ?? 0;
  replayEvents.forEach((event, index) => {
    const current = Math.max(previous, event.clientTs);
    if (index > 0) {
      elapsed += Math.min(MAX_REPLAY_GAP_MS, current - previous);
    }
    times.push(elapsed);
    previous = current;
  });
  const scale = elapsed > MAX_REPLAY_DURATION_MS
    ? MAX_REPLAY_DURATION_MS / elapsed
    : 1;
  /** @type {ReplayStep[]} */
  const steps: ReplayStep[] = [];
  for (let index = split; index < events.length; index++) {
    const event = events[index];
    const atMs = Math.round(times[index - split] * scale);
    if (event.kind === "stroke" && event.cells) {
      steps.push({ type: "diff", atMs, cells: base64(event.cells) });
    } else if (event.kind === "undo") {
      steps.push({
        type: "snapshot",
        atMs,
        pixels: pixelsBase64(events.slice(0, index + 1)),
      });
    }
  }

  return {
    id,
    title,
    initialPixels: pixelsBase64(prefix),
    finalPixels: pixelsBase64(events),
    durationMs: Math.round(elapsed * scale),
    steps,
  };
}
