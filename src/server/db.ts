// @tursodatabase/serverless: pure fetch()-based, zero native dependencies —
// a better fit for Deno than @libsql/client (which pulls in platform-specific
// native binaries and Node-only deps we never use, since we always talk to
// Turso over plain HTTPS). Its /compat subpath exposes the same createClient
// API @libsql/client does, so nothing else in this file needs to change.
// It doesn't support BEGIN CONCURRENT yet, which is why ConcurrentTx below
// still talks to the Hrana pipeline endpoint directly with a hand-rolled
// fetch() call instead.
import { type Client, createClient } from "@tursodatabase/serverless/compat";
export type { Client };

/** @typedef {"stroke" | "undo"} EventKind */
export type EventKind = "stroke" | "undo";

export interface NewEvent {
  id: string;
  kind: EventKind;
  strokeId?: string | null;
  cells?: Uint8Array | null;
  revertsId?: string | null;
  clientTs: number;
}

export interface CanvasEventRow {
  sequence: number;
  id: string;
  canvasId: string;
  kind: EventKind;
  strokeId: string | null;
  cells: Uint8Array | null;
  revertsId: string | null;
  clientTs: number;
  receivedAt: number;
}

export interface CanvasSummary {
  id: string;
  ownerId: string;
  title: string | null;
  createdAt: number;
  lastStrokeAt: number | null;
  clientReportedActive: boolean;
  completedAt: number | null;
}

export interface CanvasAccess {
  ownerId: string;
  completedAt: number | null;
}

export interface CanvasRecord extends CanvasSummary {
  pixels: Uint8Array;
}

/**
 * A transaction conflict from Turso's MVCC engine (BEGIN CONCURRENT). Confirmed
 * empirically: the losing side's COMMIT fails with a "Transaction error"
 * message (observed exact text: "cannot commit - no transaction is active");
 * the message text isn't documented as stable, so callers should match on the
 * "Transaction error" substring, not the full string.
 */
export class ConcurrencyConflictError extends Error {}

/**
 * Two distinct error shapes were observed empirically for a losing side of a
 * BEGIN CONCURRENT row conflict: "Write-write conflict" (surfacing mid-
 * transaction, at the statement that touched the contended row) and
 * "Transaction error: cannot commit - no transaction is active" (surfacing
 * at COMMIT, when the conflict was only detected there). Neither message is
 * documented as stable, so match loosely on "conflict" / "Transaction error"
 * rather than the full string.
 */
function isConflictMessage(message: string): boolean {
  return message.includes("conflict") || message.includes("Transaction error");
}

export function createDb(): Client {
  const url = Deno.env.get("TURSO_DB_URL");
  const authToken = Deno.env.get("TURSO_DB_TOKEN");
  if (!url || !authToken) {
    throw new Error("TURSO_DB_URL and TURSO_DB_TOKEN must be set");
  }
  return createClient({ url, authToken });
}

export async function createCanvas(
  db: Client,
  id: string,
  ownerId: string,
  pixels: Uint8Array,
  now: number,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO canvases (id, owner_id, pixels, created_at, client_reported_active) VALUES (?, ?, ?, ?, 0)",
    args: [id, ownerId, pixels, now],
  });
}

/**
 * Lazily creates the canvas row on its first sync push, since the client
 * mints canvas ids locally (offline-first) and the server only learns a
 * canvas exists once a push arrives. Safe to call on every push — a no-op
 * once the row exists.
 */
export async function ensureCanvas(
  db: Client,
  id: string,
  ownerId: string,
  blankPixels: Uint8Array,
  now: number,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT OR IGNORE INTO canvases (id, owner_id, pixels, created_at, client_reported_active) " +
      "VALUES (?, ?, ?, ?, 0)",
    args: [id, ownerId, blankPixels, now],
  });
}

export async function getOrCreateDraft(
  db: Client,
  preferredId: string,
  ownerId: string,
  blankPixels: Uint8Array,
  now: number,
): Promise<CanvasRecord> {
  await db.execute({
    sql:
      "INSERT OR IGNORE INTO canvases (id, owner_id, pixels, created_at, client_reported_active) " +
      "VALUES (?, ?, ?, ?, 0)",
    args: [preferredId, ownerId, blankPixels, now],
  });
  const draft = await getGuestDraft(db, ownerId);
  if (!draft) throw new Error("could not create or recover guest draft");
  return draft;
}

export async function getGuestDraft(
  db: Client,
  ownerId: string,
): Promise<CanvasRecord | null> {
  const result = await db.execute({
    sql:
      "SELECT id, owner_id, title, pixels, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE owner_id = ? AND completed_at IS NULL LIMIT 1",
    args: [ownerId],
  });
  return result.rows.length === 0 ? null : rowToRecord(result.rows[0]);
}

export async function listGuestCompleted(
  db: Client,
  ownerId: string,
  limit = 200,
): Promise<CanvasRecord[]> {
  const result = await db.execute({
    sql:
      "SELECT id, owner_id, title, pixels, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE owner_id = ? AND completed_at IS NOT NULL " +
      "ORDER BY completed_at DESC LIMIT ?",
    args: [ownerId, limit],
  });
  return result.rows.map(rowToRecord);
}

export async function listRandomCompleted(
  db: Client,
  limit: number,
): Promise<CanvasRecord[]> {
  const result = await db.execute({
    sql:
      "SELECT id, owner_id, title, pixels, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE completed_at IS NOT NULL ORDER BY RANDOM() LIMIT ?",
    args: [limit],
  });
  return result.rows.map(rowToRecord);
}

export async function getCompletedCanvas(
  db: Client,
  canvasId: string,
): Promise<CanvasRecord | null> {
  const result = await db.execute({
    sql:
      "SELECT id, owner_id, title, pixels, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE id = ? AND completed_at IS NOT NULL",
    args: [canvasId],
  });
  return result.rows.length === 0 ? null : rowToRecord(result.rows[0]);
}

export async function deleteCompletedCanvas(
  db: Client,
  canvasId: string,
  ownerId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql:
      "DELETE FROM canvases WHERE id = ? AND owner_id = ? AND completed_at IS NOT NULL",
    args: [canvasId, ownerId],
  });
  return result.rowsAffected === 1;
}

export async function deleteGuestDraft(
  db: Client,
  ownerId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: "DELETE FROM canvases WHERE owner_id = ? AND completed_at IS NULL",
    args: [ownerId],
  });
  return result.rowsAffected === 1;
}

/**
 * The single writer allowed to paint this canvas — enforced by the server on
 * every push (see main.ts's events POST handler) so a second device can't
 * paint over someone else's in-progress canvas. Anonymous per-device id
 * today, same as owner_id everywhere else in this file.
 */
export async function getCanvasOwnerId(
  db: Client,
  canvasId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: "SELECT owner_id FROM canvases WHERE id = ?",
    args: [canvasId],
  });
  if (res.rows.length === 0) return null;
  return (res.rows[0].owner_id as string | null) ?? null;
}

export async function getCanvasAccess(
  db: Client,
  canvasId: string,
): Promise<CanvasAccess | null> {
  const res = await db.execute({
    sql: "SELECT owner_id, completed_at FROM canvases WHERE id = ?",
    args: [canvasId],
  });
  if (res.rows.length === 0) return null;
  return {
    ownerId: String(res.rows[0].owner_id),
    completedAt: res.rows[0].completed_at === null
      ? null
      : Number(res.rows[0].completed_at),
  };
}

export async function eventAcknowledgments(
  db: Client,
  canvasId: string,
  eventIds: string[],
): Promise<Array<{ id: string; sequence: number }>> {
  if (eventIds.length === 0) return [];
  const placeholders = eventIds.map(() => "?").join(", ");
  const res = await db.execute({
    sql:
      `SELECT id, sequence FROM canvas_events WHERE canvas_id = ? AND id IN (${placeholders})`,
    args: [canvasId, ...eventIds],
  });
  const byId = new Map(
    res.rows.map((row) => [String(row.id), Number(row.sequence)]),
  );
  return eventIds.flatMap((id) => {
    const sequence = byId.get(id);
    return sequence === undefined ? [] : [{ id, sequence }];
  });
}

export async function headSequence(
  db: Client,
  canvasId: string,
): Promise<number> {
  const res = await db.execute({
    sql:
      "SELECT COALESCE(MAX(sequence), 0) as head FROM canvas_events WHERE canvas_id = ?",
    args: [canvasId],
  });
  return Number(res.rows[0].head);
}

export async function completeCanvas(
  db: Client,
  canvasId: string,
  title: string,
  now: number,
): Promise<boolean> {
  const result = await db.execute({
    sql:
      "UPDATE canvases SET title = ?, completed_at = ?, client_reported_active = 0 WHERE id = ? AND completed_at IS NULL",
    args: [title, now, canvasId],
  });
  return result.rowsAffected === 1;
}

export async function storeCanvasPixels(
  db: Client,
  canvasId: string,
  pixels: Uint8Array,
): Promise<void> {
  await db.execute({
    sql:
      "UPDATE canvases SET pixels = ? WHERE id = ? AND completed_at IS NOT NULL",
    args: [pixels, canvasId],
  });
}

/**
 * "Active" here is server-affirmed, not just the client's self-reported flag:
 * a crashed/closed client can leave client_reported_active=1 behind forever,
 * so this also requires a stroke within the last `staleAfterMs` (default
 * 120s) as the real backstop. The client's own idle timer never pushes a
 * network update on its own while there's nothing new to sync (see
 * IDLE_TIMEOUT_MS in src/shared/paint-engine.js) — a painter who's just
 * thinking between strokes, not gone, relies entirely on this window
 * staying generous enough to outlast normal pauses. A backgrounded painter
 * remains active so the same browser can open /dev/active; pagehide reports
 * inactive immediately, while this stroke-age window removes abandoned tabs.
 */
export async function listActiveCanvases(
  db: Client,
  now = Date.now(),
  staleAfterMs = 120_000,
): Promise<CanvasSummary[]> {
  const res = await db.execute({
    sql:
      "SELECT id, owner_id, title, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE client_reported_active = 1 AND last_stroke_at > ? ORDER BY last_stroke_at DESC",
    args: [now - staleAfterMs],
  });
  return res.rows.map(rowToSummary);
}

export async function listRecentlyCompleted(
  db: Client,
  limit: number,
): Promise<CanvasSummary[]> {
  const res = await db.execute({
    sql:
      "SELECT id, owner_id, title, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ?",
    args: [limit],
  });
  return res.rows.map(rowToSummary);
}

export interface CompletedCursor {
  completedAt: number;
  id: string;
}

/**
 * Pages signed paintings without scanning or returning the whole collection.
 * The id tie-breaker makes the keyset stable when several paintings are
 * signed during the same millisecond.
 */
export async function listCompletedPage(
  db: Client,
  limit: number,
  cursor: CompletedCursor | null = null,
): Promise<CanvasRecord[]> {
  const where = cursor
    ? "WHERE completed_at IS NOT NULL AND (completed_at < ? OR (completed_at = ? AND id < ?)) "
    : "WHERE completed_at IS NOT NULL ";
  const args = cursor
    ? [cursor.completedAt, cursor.completedAt, cursor.id, limit]
    : [limit];
  const res = await db.execute({
    sql:
      "SELECT id, owner_id, title, pixels, created_at, last_stroke_at, client_reported_active, completed_at " +
      `FROM canvases ${where}ORDER BY completed_at DESC, id DESC LIMIT ?`,
    args,
  });
  return res.rows.map(rowToRecord);
}

export async function listCompletedByOwnerPrefix(
  db: Client,
  ownerPrefix: string,
): Promise<CanvasRecord[]> {
  const res = await db.execute({
    sql:
      "SELECT id, owner_id, title, pixels, created_at, last_stroke_at, client_reported_active, completed_at " +
      "FROM canvases WHERE completed_at IS NOT NULL AND owner_id LIKE ? ORDER BY completed_at DESC",
    args: [`${ownerPrefix}%`],
  });
  return res.rows.map(rowToRecord);
}

export async function globalHeadSequence(db: Client): Promise<number> {
  const res = await db.execute(
    "SELECT COALESCE(MAX(sequence), 0) AS head FROM canvas_events",
  );
  return Number(res.rows[0].head);
}

export async function pullGlobalEventsSince(
  db: Client,
  since: number,
  limit = 500,
): Promise<CanvasEventRow[]> {
  const res = await db.execute({
    sql:
      "SELECT sequence, id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at " +
      "FROM canvas_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    args: [since, limit],
  });
  return res.rows.map(rowToEvent);
}

export async function pullEventsForCanvases(
  db: Client,
  canvasIds: string[],
): Promise<CanvasEventRow[]> {
  if (canvasIds.length === 0) return [];
  const placeholders = canvasIds.map(() => "?").join(", ");
  const res = await db.execute({
    sql:
      "SELECT sequence, id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at " +
      `FROM canvas_events WHERE canvas_id IN (${placeholders}) ORDER BY sequence ASC`,
    args: canvasIds,
  });
  return res.rows.map(rowToEvent);
}

export async function pullEventsSince(
  db: Client,
  canvasId: string,
  since: number,
): Promise<{ events: CanvasEventRow[]; headSequence: number }> {
  const res = await db.execute({
    sql:
      "SELECT sequence, id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at " +
      "FROM canvas_events WHERE canvas_id = ? AND sequence > ? ORDER BY sequence ASC",
    args: [canvasId, since],
  });
  const events = res.rows.map(rowToEvent);
  const head = await headSequence(db, canvasId);
  return { events, headSequence: head };
}

// deno-lint-ignore no-explicit-any
function rowToSummary(row: any): CanvasSummary {
  return {
    id: row.id,
    ownerId: String(row.owner_id),
    title: row.title ?? null,
    createdAt: Number(row.created_at),
    lastStrokeAt: row.last_stroke_at === null
      ? null
      : Number(row.last_stroke_at),
    clientReportedActive: Number(row.client_reported_active) === 1,
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
  };
}

// deno-lint-ignore no-explicit-any
function rowToRecord(row: any): CanvasRecord {
  return {
    ...rowToSummary(row),
    pixels: row.pixels instanceof Uint8Array
      ? row.pixels
      : new Uint8Array(row.pixels),
  };
}

// deno-lint-ignore no-explicit-any
function rowToEvent(row: any): CanvasEventRow {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    canvasId: row.canvas_id,
    kind: row.kind,
    strokeId: row.stroke_id ?? null,
    cells: row.cells ?? null,
    revertsId: row.reverts_id ?? null,
    clientTs: Number(row.client_ts),
    receivedAt: Number(row.received_at),
  };
}

// --- Concurrent-write push path ---
//
// @libsql/client's execute()/batch()/transaction() only know "write" | "read"
// | "deferred" transaction modes and reject "BEGIN CONCURRENT" as invalid SQL
// when issued through them. BEGIN CONCURRENT only works over the raw hrana
// /v2/pipeline HTTP endpoint. This was verified empirically against a live
// tursodb database — see tests/db_test.ts.
//
// Every statement in the transaction (BEGIN, each INSERT, the heartbeat
// UPDATE, COMMIT) is sent as ONE batched pipeline request, not one HTTP
// round trip per statement — pipelining's whole point is bundling multiple
// statements into a single call. Measured against a real Turso cloud
// endpoint: 4 separate sequential round trips (begin/insert/update/commit)
// took ~400ms; the same transaction batched into one request took ~200ms,
// and the gap widens further with more statements per push. Splitting them
// was the actual cause of "the live view snaps once or twice then stalls" —
// a push this slow can never keep up with continuous painting, so the
// outbox backs up far behind what a client-side retry fix alone can cure.

interface PipelineResponse {
  baton: string | null;
  results: Array<
    { type: "ok"; response: unknown } | {
      type: "error";
      error: { message: string };
    }
  >;
}

class ConcurrentTx {
  #baseUrl: string;
  #token: string;

  constructor(dbUrl: string, authToken: string) {
    this.#baseUrl = dbUrl.replace(/^libsql:\/\//, "https://");
    this.#token = authToken;
  }

  /**
   * Runs BEGIN CONCURRENT, every statement, and COMMIT as one pipeline HTTP
   * request. Throws ConcurrencyConflictError if this transaction lost a row
   * conflict (surfacing on any statement, or at commit).
   */
  async runBatch(
    statements: Array<{ sql: string; args?: unknown[] }>,
  ): Promise<void> {
    const requests = [
      { type: "execute", stmt: { sql: "BEGIN CONCURRENT" } },
      ...statements.map((s) => ({
        type: "execute",
        stmt: { sql: s.sql, args: (s.args ?? []).map(toHranaArg) },
      })),
      { type: "execute", stmt: { sql: "COMMIT" } },
      { type: "close" },
    ];
    const res = await fetch(`${this.#baseUrl}/v2/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ baton: null, requests }),
    });

    // A non-2xx status, a connection reset mid-body, or a rate-limit page
    // can all land here as something other than the {results: [...]} shape
    // this code used to assume unconditionally — that crashed as a bare
    // "Cannot read properties of undefined (reading 'find')" with no way to
    // tell what actually went wrong. Read as text first so a malformed body
    // still gets surfaced with its real status and content.
    const rawBody = await res.text();
    let body: PipelineResponse;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new Error(
        `pipeline request failed: non-JSON response (status ${res.status}): ` +
          rawBody.slice(0, 500),
      );
    }
    if (!res.ok || !Array.isArray(body.results)) {
      throw new Error(
        `pipeline request failed (status ${res.status}): ` +
          rawBody.slice(0, 500),
      );
    }
    throwOnError(body);
  }
}

function toHranaArg(value: unknown) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") {
    return { type: "integer", value: String(value) };
  }
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: btoa(String.fromCharCode(...value)) };
  }
  return { type: "text", value: String(value) };
}

function throwOnError(result: PipelineResponse): void {
  const err = result.results.find((r) => r.type === "error");
  if (err && err.type === "error") {
    if (isConflictMessage(err.error.message)) {
      throw new ConcurrencyConflictError(err.error.message);
    }
    throw new Error(err.error.message);
  }
}

/** Exponential backoff with full jitter, capped at 500ms, for conflict retries. */
function conflictBackoffMs(attempt: number): number {
  const cap = 500;
  const exp = Math.min(cap, 20 * 2 ** attempt);
  return Math.random() * exp;
}

/**
 * Appends events for a single push (the sync handshake), inside a single
 * BEGIN CONCURRENT transaction, and updates the canvas heartbeat fields.
 * Retries automatically on a row-level conflict (another device pushed to
 * the same canvas at the same moment) — safe to retry because event ids are
 * client-generated ULIDs (INSERT OR IGNORE makes re-applying a retried push
 * a no-op).
 */
export async function appendEvents(
  dbUrl: string,
  authToken: string,
  canvasId: string,
  events: NewEvent[],
  heartbeatActive: boolean,
  now: number,
  maxAttempts = 8,
): Promise<void> {
  const statements = [
    ...events.map((event) => ({
      sql: "INSERT OR IGNORE INTO canvas_events " +
        "(id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM canvases WHERE id = ? AND completed_at IS NULL)",
      args: [
        event.id,
        canvasId,
        event.kind,
        event.strokeId ?? null,
        event.cells ?? null,
        event.revertsId ?? null,
        event.clientTs,
        now,
        canvasId,
      ],
    })),
    {
      sql:
        "UPDATE canvases SET last_stroke_at = ?, client_reported_active = ? WHERE id = ? AND completed_at IS NULL",
      args: [now, heartbeatActive ? 1 : 0, canvasId],
    },
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await new ConcurrentTx(dbUrl, authToken).runBatch(statements);
      return;
    } catch (e) {
      if (e instanceof ConcurrencyConflictError && attempt < maxAttempts - 1) {
        // Retrying with no delay lets many concurrent writers to the same
        // canvas collide again in lockstep — confirmed in practice: 20
        // concurrent pushes to one canvas exhausted all 5 immediate retries
        // for 2 of them. Jittered exponential backoff spreads retries out so
        // they stop colliding with each other on the way back in.
        await new Promise((resolve) =>
          setTimeout(resolve, conflictBackoffMs(attempt))
        );
        continue;
      }
      throw e;
    }
  }
}
