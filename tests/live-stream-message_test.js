import { assertEquals, assertExists } from "@std/assert";
import { parseLiveStreamMessage } from "../src/client/live-stream-message.js";

const canvas = {
  id: "01LIVE",
  title: null,
  pixels: "AAAA",
  createdAt: 1,
  lastStrokeAt: 2,
  completedAt: null,
};

Deno.test("live-stream parser accepts every protocol message", () => {
  const messages = [
    { version: 1, type: "sync", canvases: [{ canvas, headSequence: 2 }] },
    { version: 1, type: "snapshot", canvas, headSequence: 2 },
    {
      version: 1,
      type: "diff",
      canvasId: canvas.id,
      headSequence: 3,
      batches: [{ sequence: 3, ts: 4, cells: [[0, -1], [4_095, 0]] }],
    },
    { version: 1, type: "completed", canvas, headSequence: 3 },
    { version: 1, type: "inactive", canvasId: canvas.id, reason: "idle" },
  ];
  for (const message of messages) {
    assertExists(parseLiveStreamMessage(JSON.stringify(message)));
  }
});

Deno.test("live-stream parser rejects malformed and unsupported payloads", () => {
  const invalid = [
    "not json",
    JSON.stringify({ version: 2, type: "sync", canvases: [] }),
    JSON.stringify({ version: 1, type: "sync", canvases: [{ canvas }] }),
    JSON.stringify({
      version: 1,
      type: "snapshot",
      canvas: {},
      headSequence: 0,
    }),
    JSON.stringify({
      version: 1,
      type: "diff",
      canvasId: canvas.id,
      headSequence: 3,
      batches: [{ sequence: 3, ts: 4, cells: [[4_096, 0]] }],
    }),
    JSON.stringify({
      version: 1,
      type: "inactive",
      canvasId: canvas.id,
      reason: "unknown",
    }),
  ];
  for (const payload of invalid) {
    assertEquals(parseLiveStreamMessage(payload), null);
  }
});
