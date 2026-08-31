// @ts-check

// Builds and decodes the .jpaint export document for one signed painting —
// see docs/jpaint-format.md for the full format description. This is an
// APP-NATIVE format: our own field names throughout, not the source mod's
// (`ct`/`v`/`name`/`generation` do not appear here — see the doc for why).
//
// This module is DOM-free domain logic (base64/typed-array plumbing only),
// so it lives in src/shared/ rather than src/server/: the browser needs it
// too (a client-side .jpaint decoder is useless if the format can only be
// read on the server). See AGENTS.md for the src/shared/ convention.

/** @typedef {import("./paint-types.d.ts").JpaintDocument} JpaintDocument */
/** @typedef {import("./paint-types.d.ts").JpaintEvent} JpaintEvent */

export const JPAINT_FORMAT_VERSION = 1;

/**
 * Raised by decodeJpaintDocument() for any structurally invalid input —
 * unknown/future format version, a missing required field, a pixel buffer
 * whose length doesn't match width×height, or malformed base64. Decoding
 * either succeeds with a fully-populated JpaintDocument or throws; it never
 * returns a half-built document.
 */
export class JpaintFormatError extends Error {}

/** @param {Uint8Array} bytes @returns {string} */
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** @param {string} value @returns {Uint8Array} */
function base64ToBytes(value) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch (error) {
    throw new JpaintFormatError(
      `not valid base64: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The shape of one row of a canvas's event log, as needed to build a
 * JpaintEvent. Structurally the same as `CanvasEventRow` in
 * `src/server/db.ts` — not imported from there directly, since that file is
 * server-only TypeScript and this module must stay importable from the
 * browser too.
 * @typedef {Object} JpaintEventSource
 * @property {number} sequence
 * @property {string} id
 * @property {"stroke" | "undo"} kind
 * @property {string | null} strokeId
 * @property {Uint8Array | null} cells
 * @property {string | null} revertsId
 * @property {number} clientTs
 */

/** @param {JpaintEventSource} row @returns {JpaintEvent} */
function jpaintEvent(row) {
  return {
    sequence: row.sequence,
    id: row.id,
    kind: row.kind,
    strokeId: row.strokeId,
    cells: row.cells ? bytesToBase64(row.cells) : null,
    revertsId: row.revertsId,
    clientTs: row.clientTs,
  };
}

/**
 * @typedef {Object} JpaintSource
 * @property {string} id
 * @property {string | null} title
 * @property {string | null} author
 * @property {Uint8Array} pixels
 * @property {number} createdAt
 * @property {number | null} completedAt
 */

/**
 * `events` must be the canvas's COMPLETE event log (e.g.
 * `pullEventsSince(db, canvasId, 0).events`, unfiltered) — never the
 * bounded/clamped-timeline output buildCanvasReplay() produces for the
 * live ambient display. Losslessness w.r.t. our own model is this
 * format's whole interop guarantee; a truncated log would silently break
 * that guarantee for any painting with a long edit history.
 *
 * width/height are passed in explicitly rather than inferred from
 * `source.pixels.length` — a 32x16 canvas and a 16x32 canvas have the
 * same pixel count, so buffer length alone cannot distinguish them (this
 * app is fixed at 16x16 today per CANVAS_WIDTH/CANVAS_HEIGHT in
 * paint-engine.js, but the format itself must not bake that assumption in).
 *
 * @param {JpaintSource} source
 * @param {number} width
 * @param {number} height
 * @param {JpaintEventSource[]} events
 * @returns {JpaintDocument}
 */
export function buildJpaintDocument(source, width, height, events) {
  return {
    jpaint: JPAINT_FORMAT_VERSION,
    id: source.id,
    title: source.title,
    author: source.author,
    width,
    height,
    createdAt: source.createdAt,
    completedAt: source.completedAt,
    pixels: bytesToBase64(source.pixels),
    events: events.map(jpaintEvent),
  };
}

/** @param {unknown} value @param {string} field */
function requireString(value, field) {
  if (typeof value !== "string") {
    throw new JpaintFormatError(`"${field}" must be a string`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireStringOrNull(value, field) {
  if (value !== null && typeof value !== "string") {
    throw new JpaintFormatError(`"${field}" must be a string or null`);
  }
  return /** @type {string | null} */ (value);
}

/** @param {unknown} value @param {string} field */
function requireNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new JpaintFormatError(`"${field}" must be a number`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireNumberOrNull(value, field) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new JpaintFormatError(`"${field}" must be a number or null`);
  }
  return /** @type {number | null} */ (value);
}

/** @param {unknown} value @param {string} field */
function requirePositiveInteger(value, field) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new JpaintFormatError(`"${field}" must be a positive integer`);
  }
  return value;
}

const REQUIRED_DOCUMENT_FIELDS = [
  "jpaint",
  "id",
  "title",
  "author",
  "width",
  "height",
  "createdAt",
  "completedAt",
  "pixels",
  "events",
];

const REQUIRED_EVENT_FIELDS = [
  "sequence",
  "id",
  "kind",
  "strokeId",
  "cells",
  "revertsId",
  "clientTs",
];

/**
 * @param {unknown} rawEvent
 * @param {number} index
 * @returns {JpaintEvent}
 */
function decodeJpaintEvent(rawEvent, index) {
  if (typeof rawEvent !== "object" || rawEvent === null) {
    throw new JpaintFormatError(`events[${index}] must be an object`);
  }
  const event = /** @type {Record<string, unknown>} */ (rawEvent);
  for (const field of REQUIRED_EVENT_FIELDS) {
    if (!(field in event)) {
      throw new JpaintFormatError(
        `events[${index}] is missing required field "${field}"`,
      );
    }
  }
  if (event.kind !== "stroke" && event.kind !== "undo") {
    throw new JpaintFormatError(
      `events[${index}].kind must be "stroke" or "undo", got ${
        JSON.stringify(event.kind)
      }`,
    );
  }
  const cells = requireStringOrNull(event.cells, `events[${index}].cells`);
  if (cells !== null) base64ToBytes(cells); // validate, but keep the base64 string on the wire

  return {
    sequence: requireNumber(event.sequence, `events[${index}].sequence`),
    id: requireString(event.id, `events[${index}].id`),
    kind: event.kind,
    strokeId: requireStringOrNull(event.strokeId, `events[${index}].strokeId`),
    cells,
    revertsId: requireStringOrNull(
      event.revertsId,
      `events[${index}].revertsId`,
    ),
    clientTs: requireNumber(event.clientTs, `events[${index}].clientTs`),
  };
}

/**
 * Decodes and VALIDATES a .jpaint document. Accepts either the raw file
 * text or an already-`JSON.parse()`d value. Rejects — throwing
 * JpaintFormatError — on:
 *   - a format version other than JPAINT_FORMAT_VERSION (including a
 *     future version this build doesn't understand yet);
 *   - a missing required field, at the document or per-event level;
 *   - a `pixels` buffer whose decoded byte length doesn't match
 *     width×height×4 (4 bytes per Int32Array pixel);
 *   - malformed base64 in `pixels` or in any event's `cells`;
 *   - JSON that doesn't parse, or that parses to something other than an
 *     object.
 *
 * There is no partial-success path: a malformed file always throws before
 * any part of a document is returned, never a half-built one.
 *
 * @param {string | unknown} input
 * @returns {JpaintDocument}
 */
export function decodeJpaintDocument(input) {
  /** @type {unknown} */
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch (error) {
      throw new JpaintFormatError(
        `.jpaint document is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new JpaintFormatError(".jpaint document must be a JSON object");
  }
  const doc = /** @type {Record<string, unknown>} */ (raw);

  for (const field of REQUIRED_DOCUMENT_FIELDS) {
    if (!(field in doc)) {
      throw new JpaintFormatError(
        `.jpaint document is missing required field "${field}"`,
      );
    }
  }

  if (doc.jpaint !== JPAINT_FORMAT_VERSION) {
    throw new JpaintFormatError(
      `unsupported .jpaint format version ${
        JSON.stringify(doc.jpaint)
      } (this build only reads version ${JPAINT_FORMAT_VERSION})`,
    );
  }

  const id = requireString(doc.id, "id");
  const title = requireStringOrNull(doc.title, "title");
  const author = requireStringOrNull(doc.author, "author");
  const width = requirePositiveInteger(doc.width, "width");
  const height = requirePositiveInteger(doc.height, "height");
  const createdAt = requireNumber(doc.createdAt, "createdAt");
  const completedAt = requireNumberOrNull(doc.completedAt, "completedAt");
  const pixels = requireString(doc.pixels, "pixels");

  const pixelBytes = base64ToBytes(pixels);
  const expectedBytes = width * height * 4;
  if (pixelBytes.byteLength !== expectedBytes) {
    throw new JpaintFormatError(
      `"pixels" decodes to ${pixelBytes.byteLength} bytes, but width×height×4 ` +
        `(${width}×${height}×4) requires ${expectedBytes} bytes`,
    );
  }

  if (!Array.isArray(doc.events)) {
    throw new JpaintFormatError('"events" must be an array');
  }
  const events = doc.events.map((rawEvent, index) =>
    decodeJpaintEvent(rawEvent, index)
  );

  return {
    jpaint: JPAINT_FORMAT_VERSION,
    id,
    title,
    author,
    width,
    height,
    createdAt,
    completedAt,
    pixels,
    events,
  };
}
