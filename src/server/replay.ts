import type { CanvasEventRow } from "./db.ts";
import { composeCanvas } from "../shared/compose.js";
import type {
  CanvasReplayResponse,
  ReplayStep,
} from "../shared/paint-types.d.ts";

export const MAX_REPLAY_WINDOW_MS = 40_000;
export const MAX_REPLAY_EVENTS = 20_000;

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
 * Produces a bounded playback window. Stroke rows remain compact diffs; undo
 * rows become snapshots because they can remove a stroke from before the
 * window. Sequence order is authoritative and timestamps are clamped forward
 * so a skewed clock cannot make playback reverse or stall.
 */
export function buildCanvasReplay(
  id: string,
  title: string,
  events: CanvasEventRow[],
  windowMs = MAX_REPLAY_WINDOW_MS,
): CanvasReplayResponse {
  if (events.length > MAX_REPLAY_EVENTS) {
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

  const times: number[] = [];
  let previous = events[0].clientTs;
  for (const event of events) {
    previous = Math.max(previous, event.clientTs);
    times.push(previous);
  }
  const end = times.at(-1) as number;
  const start = Math.max(times[0], end - Math.max(0, windowMs));
  let split = 0;
  while (split < times.length && times[split] < start) split++;

  const prefix = events.slice(0, split);
  /** @type {ReplayStep[]} */
  const steps: ReplayStep[] = [];
  for (let index = split; index < events.length; index++) {
    const event = events[index];
    const atMs = Math.max(0, times[index] - start);
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
    durationMs: Math.max(0, end - start),
    steps,
  };
}
