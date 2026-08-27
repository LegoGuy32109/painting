import {
  appendEvents,
  type Client,
  completeCanvas,
  pullEventsSince,
  storeCanvasPixels,
} from "../../src/server/db.ts";
import { createPixels } from "../../src/shared/paint-engine.js";
import { encodeCells } from "../../src/shared/cell-codec.js";
import { composeCanvas } from "../../src/shared/compose.js";
import { ulid } from "../../src/shared/ulid.js";

export const SIMULATOR_PREFIX = "e2e-live-";

export interface LiveCanvasSimulatorOptions {
  count?: number;
  strokeIntervalMs?: number;
}

export class LiveCanvasSimulator {
  #db: Client;
  #url: string;
  #token: string;
  #count: number;
  #strokeIntervalMs: number;
  #timer: number | null = null;
  #stopped = true;
  #cursor = 0;
  readonly canvasIds: string[] = [];

  constructor(
    db: Client,
    url: string,
    token: string,
    options: LiveCanvasSimulatorOptions = {},
  ) {
    this.#db = db;
    this.#url = url;
    this.#token = token;
    this.#count = options.count ?? 24;
    this.#strokeIntervalMs = options.strokeIntervalMs ?? 250;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    const now = Date.now();
    const statements: Array<{
      sql: string;
      args: Array<string | number | Uint8Array>;
    }> = [];
    for (let index = 0; index < this.#count; index++) {
      const id = ulid(now + index);
      this.canvasIds.push(id);
      const color =
        [0xff5b8dd9, 0xffef7d57, 0xff83c55b, 0xffc74ebd][index % 4] |
        0;
      statements.push(
        {
          sql:
            "INSERT INTO canvases (id, owner_id, pixels, created_at, last_stroke_at, client_reported_active) " +
            "VALUES (?, ?, ?, ?, ?, 1)",
          args: [
            id,
            `${SIMULATOR_PREFIX}owner-${index}`,
            new Uint8Array(createPixels().buffer),
            now + index,
            now + index,
          ],
        },
        {
          sql:
            "INSERT INTO canvas_events (id, canvas_id, kind, stroke_id, cells, client_ts, received_at) " +
            "VALUES (?, ?, 'stroke', ?, ?, ?, ?)",
          args: [
            ulid(),
            id,
            ulid(),
            encodeCells([[index, color]]),
            now + index,
            now + index,
          ],
        },
      );
    }
    await retry(() => this.#db.batch(statements));
    this.#scheduleStroke();
  }

  async sign(index: number, title = `Signed live ${index + 1}`): Promise<void> {
    const id = this.canvasIds[index];
    if (!id) throw new Error(`no simulated canvas at index ${index}`);
    const now = Date.now();
    await retry(() => completeCanvas(this.#db, id, title, now));
    const { events } = await retry(() => pullEventsSince(this.#db, id, 0));
    await retry(() =>
      storeCanvasPixels(
        this.#db,
        id,
        new Uint8Array(composeCanvas(events).buffer),
      )
    );
  }

  async signAll(): Promise<void> {
    this.stop();
    await retry(() =>
      this.#db.execute({
        sql:
          "UPDATE canvases SET title = 'Signed simulation', completed_at = ?, client_reported_active = 0 " +
          "WHERE owner_id LIKE ? AND completed_at IS NULL",
        args: [Date.now(), `${SIMULATOR_PREFIX}%`],
      })
    );
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #scheduleStroke(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(async () => {
      const index = this.#cursor++ % this.canvasIds.length;
      try {
        await this.stroke(index);
      } catch (error) {
        console.error("simulated stroke failed", error);
      }
      this.#scheduleStroke();
    }, this.#strokeIntervalMs);
  }

  async cleanup(): Promise<void> {
    this.stop();
    await this.#db.execute({
      sql: "DELETE FROM canvases WHERE owner_id LIKE ?",
      args: [`${SIMULATOR_PREFIX}%`],
    });
  }

  /** Add one deterministic stroke to a selected simulated canvas. */
  async stroke(index: number): Promise<void> {
    const id = this.canvasIds[index];
    if (!id) return;
    const phase = this.#cursor + index;
    const x = (phase * 3 + index) % 16;
    const y = (phase * 5 + index * 2) % 16;
    const color = [0xff5b8dd9, 0xffef7d57, 0xff83c55b, 0xffc74ebd][index % 4] |
      0;
    const now = Date.now();
    const event = {
      id: ulid(),
      kind: "stroke" as const,
      strokeId: ulid(),
      cells: encodeCells([[y * 16 + x, color]]),
      clientTs: now,
    };
    await retry(() =>
      appendEvents(
        this.#url,
        this.#token,
        id,
        [event],
        true,
        now,
      )
    );
  }
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
  throw lastError;
}
