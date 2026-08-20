// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").CanvasReplayResponse} CanvasReplayResponse */
/** @typedef {import("../shared/paint-types.d.ts").DisplayFeedResponse} DisplayFeedResponse */
/** @typedef {import("../shared/paint-types.d.ts").PublicCanvas} PublicCanvas */
/** @typedef {{ id: string, kind: "active" | "completed", figure: HTMLElement, context: CanvasRenderingContext2D, pixels: Int32Array, state: HTMLElement, source: EventSource | null, replay: LiveReplay | null, timeline: CanvasReplayResponse | null, nextStep: number, startedAt: number }} ParadeEntry */

import { LiveReplay } from "./live-replay.js";
import {
  applyEncodedCells,
  decodePixels,
  drawPixels,
  paintingContext,
} from "../shared/pixel-render.js";

const SPAWN_INTERVAL_MS = 6_000;
const TRAVEL_DURATION_SECONDS = 52;
const RECENT_COMPLETED_LIMIT = 10;

class PaintingParade extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    /** @type {Array<{canvas: PublicCanvas, kind: "active" | "completed"}>} */
    this.queue = [];
    /** @type {Map<string, any>} */
    this.visible = new Map();
    this.queuedIds = new Set();
    /** @type {string[]} */
    this.recentCompleted = [];
    /** @type {HTMLElement} */
    this.stage = /** @type {any} */ (null);
    this.refreshTimer = 0;
    this.spawnTimer = 0;
    this.drainTimer = 0;
    this.refreshing = false;
    this.hidden = document.visibilityState !== "visible";
    this.spawnSequence = 0;
    this.onVisibility = this.onVisibility.bind(this);
  }

  connectedCallback() {
    if (this.root.childNodes.length === 0) this.build();
    document.addEventListener("visibilitychange", this.onVisibility);
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 5_000);
    this.scheduleNextSpawn();
    this.drainTimer = setInterval(() => this.drain(), 33);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearInterval(this.refreshTimer);
    clearInterval(this.spawnTimer);
    clearInterval(this.drainTimer);
    for (const entry of this.visible.values()) entry.source?.close();
    this.visible.clear();
  }

  get mode() {
    return this.getAttribute("mode") === "display" ? "display" : "ambient";
  }

  get capacity() {
    const narrow = matchMedia("(max-width: 40rem)").matches;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return narrow ? 4 : 8;
    }
    return 10;
  }

  build() {
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; position:absolute; inset:0; overflow:hidden; pointer-events:none; contain:strict; }
      .stage { position:absolute; inset:0; overflow:hidden; }
      figure { --size:clamp(7rem,18vw,13rem); position:absolute; z-index:1; right:100%; width:var(--size); margin:0; padding:.5rem; color:#1d1d21; border:.1875rem solid #5d482c; background:#fff8e5; box-shadow:.35rem .35rem 0 rgb(45 32 18 / 28%); animation:travel ${TRAVEL_DURATION_SECONDS}s linear forwards; will-change:transform; }
      figure[data-row="top"] { top:18%; }
      figure[data-row="bottom"] { top:66%; }
      canvas { display:block; width:100%; aspect-ratio:1; image-rendering:pixelated; background:#fff9ff; }
      figcaption { display:flex; justify-content:space-between; gap:.5rem; min-height:1.3rem; padding-top:.45rem; overflow:hidden; font:clamp(.55rem,1.4vw,.72rem)/1.2 ui-monospace,monospace; white-space:nowrap; }
      .title { overflow:hidden; text-overflow:ellipsis; }
      .live { color:#b02e26; }
      :host([mode="ambient"]) { opacity:.55; filter:saturate(.85); }
      :host([mode="ambient"]) figure { --size:clamp(6rem,15vw,10rem); }
      :host([mode="display"]) figure[data-row="top"] { top:26%; }
      :host([mode="display"]) figure[data-row="bottom"] { top:59%; }
      :host([paused]) figure { animation-play-state:paused; }
      @keyframes travel { from { transform:translate3d(0,0,0); } to { transform:translate3d(calc(100vw + 170%),0,0); } }
      @media (prefers-reduced-motion:reduce) { figure { right:auto; left:var(--still-x); animation:none; } }
    `;
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.setAttribute("aria-live", this.mode === "display" ? "polite" : "off");
    if (this.mode === "ambient") stage.setAttribute("aria-hidden", "true");
    this.root.append(style, stage);
    this.stage = stage;
  }

  async refresh() {
    if (this.refreshing || this.hidden) return;
    this.refreshing = true;
    try {
      const response = await fetch(`/api/display-feed?limit=${this.capacity}`);
      if (!response.ok) {
        throw new Error(`display feed failed: ${response.status}`);
      }
      const feed = /** @type {DisplayFeedResponse} */ (await response.json());
      const additions = [];
      for (const canvas of feed.active) {
        if (!this.visible.has(canvas.id) && !this.queuedIds.has(canvas.id)) {
          additions.push({ canvas, kind: /** @type {const} */ ("active") });
        }
      }
      const completedAvailable = feed.completed.filter((canvas) =>
        !this.visible.has(canvas.id) && !this.queuedIds.has(canvas.id)
      );
      let completedAdditions = completedAvailable.filter((canvas) =>
        !this.recentCompleted.includes(canvas.id)
      );
      const completedInFlight = this.queue.some((item) =>
        item.kind === "completed"
      ) || [...this.visible.values()].some((entry) =>
        entry.kind === "completed"
      );
      if (
        completedAdditions.length === 0 && completedAvailable.length > 0 &&
        !completedInFlight
      ) {
        this.recentCompleted.length = 0;
        completedAdditions = completedAvailable;
      }
      for (const canvas of completedAdditions) {
        additions.push({ canvas, kind: /** @type {const} */ ("completed") });
      }
      const activeAdditions = additions.filter((item) =>
        item.kind === "active"
      );
      const queuedCompletedAdditions = additions.filter((item) =>
        item.kind === "completed"
      );
      this.queue = [
        ...activeAdditions,
        ...this.queue,
        ...queuedCompletedAdditions,
      ];
      for (const addition of additions) {
        this.queuedIds.add(addition.canvas.id);
      }
      if (this.visible.size === 0 && this.queue.length) {
        await this.spawnNext();
      }
    } catch (error) {
      this.dispatchEvent(new CustomEvent("parade-error", { detail: error }));
    } finally {
      this.refreshing = false;
    }
  }

  async spawnNext() {
    if (this.hidden) return;
    if (this.visible.size >= this.capacity) {
      this.scheduleNextSpawn();
      return;
    }
    const candidate = this.queue.shift();
    if (!candidate) {
      void this.refresh();
      this.scheduleNextSpawn();
      return;
    }
    this.queuedIds.delete(candidate.canvas.id);
    try {
      const entry = candidate.kind === "active"
        ? this.activeEntry(candidate.canvas)
        : await this.completedEntry(candidate.canvas);
      this.visible.set(candidate.canvas.id, entry);
      this.stage.append(entry.figure);
      this.scheduleNextSpawn();
    } catch {
      setTimeout(() => void this.spawnNext(), 250);
    }
  }

  scheduleNextSpawn() {
    clearTimeout(this.spawnTimer);
    this.spawnTimer = setTimeout(
      () => void this.spawnNext(),
      SPAWN_INTERVAL_MS,
    );
  }

  /** @param {PublicCanvas} canvas @param {"active" | "completed"} kind @returns {ParadeEntry} */
  baseEntry(canvas, kind) {
    const figure = document.createElement("figure");
    const sequence = this.spawnSequence++;
    const row = sequence % 2 === 0 ? "top" : "bottom";
    const narrow = matchMedia("(max-width: 40rem)").matches;
    const columns = narrow ? 2 : 4;
    const column = Math.floor(sequence / 2) % columns;
    const stillX = columns === 2 ? 5 + column * 50 : 4 + column * 24;
    figure.dataset.row = row;
    figure.dataset.sequence = String(sequence);
    figure.style.setProperty("--still-x", `${stillX}%`);
    const canvasElement = document.createElement("canvas");
    const context = paintingContext(canvasElement);
    const pixels = decodePixels(canvas.pixels);
    drawPixels(context, pixels);
    const caption = document.createElement("figcaption");
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = canvas.title ||
      (kind === "active" ? "Painting now" : "Untitled");
    const state = document.createElement("span");
    state.className = kind === "active" ? "live" : "replay";
    state.textContent = kind === "active" ? "LIVE" : "REPLAY";
    caption.append(title, state);
    figure.append(canvasElement, caption);
    const entry = /** @type {ParadeEntry} */ ({
      id: canvas.id,
      kind,
      figure,
      context,
      pixels,
      state,
      source: null,
      replay: null,
      timeline: null,
      nextStep: 0,
      startedAt: performance.now(),
    });
    figure.addEventListener("animationend", () => this.retire(entry), {
      once: true,
    });
    return entry;
  }

  /** @param {PublicCanvas} canvas */
  activeEntry(canvas) {
    const entry = this.baseEntry(canvas, "active");
    entry.replay = new LiveReplay({ lagMs: 500, catchUpThresholdMs: 2_000 });
    this.connect(entry);
    return entry;
  }

  /** @param {PublicCanvas} canvas */
  async completedEntry(canvas) {
    const response = await fetch(`/canvases/${canvas.id}/replay?v=2`);
    if (!response.ok) throw new Error(`replay failed: ${response.status}`);
    const timeline =
      /** @type {CanvasReplayResponse} */ (await response.json());
    const entry = this.baseEntry(
      { ...canvas, pixels: timeline.initialPixels },
      "completed",
    );
    entry.timeline = timeline;
    entry.startedAt = performance.now();
    this.recentCompleted.push(canvas.id);
    if (this.recentCompleted.length > RECENT_COMPLETED_LIMIT) {
      this.recentCompleted.shift();
    }
    return entry;
  }

  /** @param {ParadeEntry} entry */
  connect(entry) {
    entry.source?.close();
    entry.replay?.reset();
    const source = new EventSource(`/canvases/${entry.id}/stream`);
    entry.source = source;
    source.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "snapshot") {
        entry.pixels = decodePixels(message.pixels);
        entry.replay?.reset();
        drawPixels(entry.context, entry.pixels);
      } else if (message.type === "diff") {
        entry.replay?.receive(message.batches, Date.now());
      }
    };
  }

  drain() {
    if (this.hidden) return;
    const now = performance.now();
    for (const entry of this.visible.values()) {
      if (entry.kind === "active") {
        let changed = false;
        for (const batch of entry.replay?.drain(Date.now()) ?? []) {
          for (const [index, color] of batch.cells) entry.pixels[index] = color;
          changed = true;
        }
        if (changed) drawPixels(entry.context, entry.pixels);
        continue;
      }
      if (!entry.timeline) continue;
      const elapsed = now - entry.startedAt;
      let changed = false;
      while (
        entry.nextStep < entry.timeline.steps.length &&
        entry.timeline.steps[entry.nextStep].atMs <= elapsed
      ) {
        const step = entry.timeline.steps[entry.nextStep++];
        if (step.type === "snapshot") entry.pixels = decodePixels(step.pixels);
        else applyEncodedCells(entry.pixels, step.cells);
        changed = true;
      }
      if (changed) drawPixels(entry.context, entry.pixels);
      if (
        entry.nextStep === entry.timeline.steps.length &&
        entry.state.textContent !== "SIGNED"
      ) {
        entry.pixels = decodePixels(entry.timeline.finalPixels);
        drawPixels(entry.context, entry.pixels);
        entry.state.textContent = "SIGNED";
      }
    }
  }

  /** @param {ParadeEntry} entry */
  retire(entry) {
    entry.source?.close();
    entry.figure.remove();
    this.visible.delete(entry.id);
  }

  onVisibility() {
    this.hidden = document.visibilityState !== "visible";
    this.toggleAttribute("paused", this.hidden);
    if (this.hidden) {
      for (const entry of this.visible.values()) entry.source?.close();
      return;
    }
    for (const entry of this.visible.values()) {
      if (entry.kind === "active") this.connect(entry);
    }
    void this.refresh();
    this.scheduleNextSpawn();
  }
}

customElements.define("painting-parade", PaintingParade);
