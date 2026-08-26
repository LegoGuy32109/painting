import type { CanvasEventRow, Client } from "./db.ts";
import { globalHeadSequence, pullGlobalEventsSince } from "./db.ts";
import { decodeCells } from "../shared/cell-codec.js";
import type {
  LiveStreamMessage,
  PublicCanvas,
} from "../shared/paint-types.d.ts";

const encoder = new TextEncoder();

export interface LiveHubSource {
  active(): Promise<Array<{ canvas: PublicCanvas; headSequence: number }>>;
  snapshot(canvasId: string): Promise<
    {
      canvas: PublicCanvas;
      headSequence: number;
    } | null
  >;
  completed(canvasId: string): Promise<
    {
      canvas: PublicCanvas;
      headSequence: number;
    } | null
  >;
}

/** One database cursor and one active-set poll fan out to every local viewer. */
export class LiveHub {
  #db: Client;
  #source: LiveHubSource;
  #subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  #activeIds = new Set<string>();
  #missingPolls = new Map<string, number>();
  #activeCanvases: Array<{ canvas: PublicCanvas; headSequence: number }> = [];
  #cursor = 0;
  #eventTimer: number | null = null;
  #activeTimer: number | null = null;
  #running = false;

  constructor(db: Client, source: LiveHubSource) {
    this.#db = db;
    this.#source = source;
  }

  async subscribe(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    this.#subscribers.add(controller);
    const canvases = this.#running
      ? this.#activeCanvases
      : await this.#source.active();
    this.#activeCanvases = canvases;
    this.#activeIds = new Set(canvases.map(({ canvas }) => canvas.id));
    this.#send(controller, { version: 1, type: "sync", canvases });
    await this.#start();
  }

  unsubscribe(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#subscribers.delete(controller);
    if (this.#subscribers.size === 0) this.#stop();
  }

  completed(canvas: PublicCanvas, headSequence: number): void {
    this.#activeIds.delete(canvas.id);
    this.#broadcast({
      version: 1,
      type: "completed",
      canvas,
      headSequence,
    });
  }

  async #start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#cursor = await globalHeadSequence(this.#db);
    this.#eventTimer = setInterval(() => void this.#pollEvents(), 200);
    this.#activeTimer = setInterval(() => void this.#reconcileActive(), 1_000);
  }

  #stop(): void {
    this.#running = false;
    if (this.#eventTimer !== null) clearInterval(this.#eventTimer);
    if (this.#activeTimer !== null) clearInterval(this.#activeTimer);
    this.#eventTimer = null;
    this.#activeTimer = null;
  }

  async #pollEvents(): Promise<void> {
    if (!this.#running) return;
    try {
      // Drain in bounded pages. sequence is global, so this remains one query
      // stream regardless of whether 2 or 200 canvases are active.
      for (;;) {
        const events = await pullGlobalEventsSince(this.#db, this.#cursor, 500);
        if (events.length === 0) break;
        this.#cursor = events.at(-1)!.sequence;
        await this.#publishEvents(events);
        if (events.length < 500) break;
      }
    } catch {
      // Turso is the cross-instance backstop. A transient miss is retried from
      // the same sequence on the next tick.
    }
  }

  async #publishEvents(events: CanvasEventRow[]): Promise<void> {
    const grouped = Map.groupBy(events, (event) => event.canvasId);
    for (const [canvasId, canvasEvents] of grouped) {
      if (!this.#activeIds.has(canvasId)) continue;
      if (canvasEvents.some((event) => event.kind === "undo")) {
        const snapshot = await this.#source.snapshot(canvasId);
        if (snapshot) {
          this.#broadcast({ version: 1, type: "snapshot", ...snapshot });
        }
        continue;
      }
      const batches = canvasEvents.flatMap((event) =>
        event.cells
          ? [{
            sequence: event.sequence,
            ts: event.clientTs,
            cells: decodeCells(event.cells),
          }]
          : []
      );
      if (batches.length === 0) continue;
      this.#broadcast({
        version: 1,
        type: "diff",
        canvasId,
        headSequence: canvasEvents.at(-1)!.sequence,
        batches,
      });
    }
  }

  async #reconcileActive(): Promise<void> {
    if (!this.#running) return;
    try {
      const previous = new Map(
        this.#activeCanvases.map((item) => [item.canvas.id, item]),
      );
      const canvases = await this.#source.active();
      const next = new Set(canvases.map(({ canvas }) => canvas.id));
      for (const item of canvases) {
        this.#missingPolls.delete(item.canvas.id);
        if (!this.#activeIds.has(item.canvas.id)) {
          this.#broadcast({ version: 1, type: "snapshot", ...item });
        }
      }
      for (const canvasId of this.#activeIds) {
        if (!next.has(canvasId)) {
          const missingPolls = (this.#missingPolls.get(canvasId) ?? 0) + 1;
          this.#missingPolls.set(canvasId, missingPolls);
          if (missingPolls < 2) {
            next.add(canvasId);
            continue;
          }
          this.#missingPolls.delete(canvasId);
          const completed = await this.#source.completed(canvasId);
          if (completed) {
            this.#broadcast({
              version: 1,
              type: "completed",
              canvas: completed.canvas,
              headSequence: completed.headSequence,
            });
          } else {
            this.#broadcast({
              version: 1,
              type: "inactive",
              canvasId,
              reason: "idle",
            });
          }
        }
      }
      this.#activeCanvases = [
        ...canvases,
        ...[...next].flatMap((canvasId) => {
          if (canvases.some((item) => item.canvas.id === canvasId)) return [];
          const item = previous.get(canvasId);
          return item ? [item] : [];
        }),
      ];
      this.#activeIds = next;
    } catch {
      // Preserve the last authoritative set until the next reconciliation.
    }
  }

  #broadcast(message: LiveStreamMessage): void {
    for (const controller of this.#subscribers) this.#send(controller, message);
  }

  #send(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: LiveStreamMessage,
  ): void {
    try {
      controller.enqueue(
        encoder.encode(
          `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`,
        ),
      );
    } catch {
      this.unsubscribe(controller);
    }
  }
}
