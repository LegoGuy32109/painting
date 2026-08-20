import type {
  CompleteCanvasRequest,
  PushEventPayload,
  PushEventsRequest,
} from "../shared/paint-types.d.ts";

export const MAX_EVENTS_PER_PUSH = 64;
export const MAX_JSON_BODY_BYTES = 160_000;
const MAX_CELL_BYTES = 256 * 6;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function assertCanvasId(value: string): void {
  if (!ULID.test(value)) throw new HttpError(400, "invalid canvas id");
}

export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(req.url).origin) {
    throw new HttpError(403, "cross-origin mutation rejected");
  }
}

export async function readJsonBody(
  req: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "content-type must be application/json");
  }
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "request body is too large");
  }

  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "request body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "request body must contain valid JSON");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid event field");
  }
  return value;
}

function validateCells(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "cells must be base64");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(value),
      (character) => character.charCodeAt(0),
    );
  } catch {
    throw new HttpError(400, "cells must be valid base64");
  }
  if (
    bytes.byteLength === 0 || bytes.byteLength > MAX_CELL_BYTES ||
    bytes.byteLength % 6 !== 0
  ) {
    throw new HttpError(400, "cells has an invalid length");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexes = new Set<number>();
  for (let offset = 0; offset < bytes.byteLength; offset += 6) {
    const index = view.getUint16(offset);
    if (index >= 256 || indexes.has(index)) {
      throw new HttpError(400, "cells contains an invalid pixel index");
    }
    indexes.add(index);
  }
  return value;
}

function validateEvent(value: unknown, now: number): PushEventPayload {
  const event = record(value);
  if (typeof event.id !== "string" || !ULID.test(event.id)) {
    throw new HttpError(400, "invalid event id");
  }
  if (event.kind !== "stroke" && event.kind !== "undo") {
    throw new HttpError(400, "invalid event kind");
  }
  if (
    !Number.isSafeInteger(event.clientTs) || Number(event.clientTs) < 0 ||
    Number(event.clientTs) > now + 300_000
  ) {
    throw new HttpError(400, "invalid client timestamp");
  }
  const strokeId = nullableString(event.strokeId);
  const revertsId = nullableString(event.revertsId);
  const cells = validateCells(event.cells);
  if (
    event.kind === "stroke" &&
    (!strokeId || !ULID.test(strokeId) || !cells || revertsId)
  ) {
    throw new HttpError(400, "invalid stroke event");
  }
  if (
    event.kind === "undo" &&
    (strokeId || cells || !revertsId || !ULID.test(revertsId))
  ) {
    throw new HttpError(400, "invalid undo event");
  }
  return {
    id: event.id,
    kind: event.kind,
    strokeId,
    cells,
    revertsId,
    clientTs: Number(event.clientTs),
  };
}

export function validatePushEvents(
  value: unknown,
  now = Date.now(),
): PushEventsRequest {
  const body = record(value);
  if (!Array.isArray(body.events) || body.events.length > MAX_EVENTS_PER_PUSH) {
    throw new HttpError(400, "events must be a bounded array");
  }
  if (typeof body.heartbeatActive !== "boolean") {
    throw new HttpError(400, "heartbeatActive must be boolean");
  }
  const events = body.events.map((event) => validateEvent(event, now));
  if (new Set(events.map((event) => event.id)).size !== events.length) {
    throw new HttpError(400, "event ids must be unique within a push");
  }
  return {
    events,
    heartbeatActive: body.heartbeatActive,
  };
}

export function validateCompletion(value: unknown): CompleteCanvasRequest {
  const body = record(value);
  if (typeof body.title !== "string") {
    throw new HttpError(400, "title must be text");
  }
  const title = body.title.trim();
  if (title.length === 0 || [...title].length > 16) {
    throw new HttpError(400, "title must contain 1 to 16 characters");
  }
  return { title };
}
