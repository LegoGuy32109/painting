// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").CanvasReplayResponse} CanvasReplayResponse */
/** @typedef {import("../shared/paint-types.d.ts").CompletedFeedResponse} CompletedFeedResponse */
/** @typedef {import("../shared/paint-types.d.ts").LiveStreamMessage} LiveStreamMessage */
/** @typedef {import("../shared/paint-types.d.ts").PublicCanvas} PublicCanvas */
/** @typedef {{ id: string, kind: "active" | "completed", figure: HTMLElement, context: CanvasRenderingContext2D, pixels: Int32Array, state: HTMLElement, replay: LiveReplay | null, timeline: CanvasReplayResponse | null, nextStep: number, animation: Animation | null, playbackStartedAt: number, playbackDurationMs: number }} ParadeEntry */

import { LiveReplay } from "./live-replay.js";
import { parseLiveStreamMessage } from "./live-stream-message.js";
import { ParadeState } from "./parade-state.js";
import {
  applyEncodedCells,
  decodePixels,
  drawPixels,
  paintingContext,
} from "../shared/pixel-render.js";

const config = {
  spawnIntervalMs: 6_000,
  travelDurationSeconds: 52,
  bootstrapCount: 2,
  completedResumeDelayMs: 5_000,
  ...(/** @type {any} */ (window).__PAINTING_TEST_CONFIG__ ?? {}),
};

class PaintingParade extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.state = new ParadeState();
    /** @type {Map<string, ParadeEntry>} */
    this.visible = new Map();
    /** @type {Map<string, Int32Array>} */
    this.livePixels = new Map();
    /** @type {Map<string, number>} */
    this.liveSequences = new Map();
    /** @type {Map<string, Promise<CanvasReplayResponse>>} */
    this.replayCache = new Map();
    /** @type {HTMLElement} */
    this.stage = /** @type {any} */ (null);
    /** @type {EventSource | null} */
    this.source = null;
    this.spawnTimer = 0;
    this.drainTimer = 0;
    this.fetchingCompleted = false;
    this.hidden = document.visibilityState !== "visible";
    this.spawnSequence = 0;
    this.bootstrapped = false;
    this.liveSynced = false;
    this.hadLive = false;
    this.completedResumeAt = 0;
    this.onVisibility = this.onVisibility.bind(this);
  }

  connectedCallback() {
    if (this.root.childNodes.length === 0) this.build();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.connect();
    void this.fetchCompletedPage();
    this.drainTimer = setInterval(() => this.drain(), 33);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    clearTimeout(this.spawnTimer);
    clearInterval(this.drainTimer);
    this.source?.close();
    this.source = null;
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
      figure { --size:clamp(7rem,18vw,13rem); position:absolute; z-index:1; right:100%; width:var(--size); margin:0; padding:.5rem; color:#1d1d21; border:.1875rem solid #5d482c; background:#fff8e5; box-shadow:.35rem .35rem 0 rgb(45 32 18 / 28%); animation:travel ${config.travelDurationSeconds}s linear forwards; will-change:transform; }
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
      @media (max-width:34rem) {
        :host([mode="ambient"]) figure[data-row="top"] { top:18%; }
        :host([mode="ambient"]) figure[data-row="bottom"] { top:calc(18% + clamp(9rem,30vw,11rem)); }
      }
      @media (prefers-reduced-motion:reduce) { figure { right:auto; left:var(--still-x); animation:none; } }
    `;
    const stage = document.createElement("div");
    stage.className = "stage";
    stage.setAttribute("aria-live", this.mode === "display" ? "polite" : "off");
    if (this.mode === "ambient") stage.setAttribute("aria-hidden", "true");
    this.root.append(style, stage);
    this.stage = stage;
  }

  connect() {
    this.source?.close();
    const source = new EventSource("/api/live-stream");
    this.source = source;
    this.dataset.streamCount = "1";
    for (const type of ["sync", "snapshot", "diff", "completed", "inactive"]) {
      source.addEventListener(type, (event) => {
        const message = parseLiveStreamMessage(
          /** @type {MessageEvent} */ (event).data,
        );
        if (message) this.receive(message);
        else {
          this.dispatchEvent(
            new CustomEvent("parade-error", {
              detail: new Error(`invalid ${type} live-stream message`),
            }),
          );
        }
      });
    }
    source.onerror = () =>
      this.dispatchEvent(
        new CustomEvent("parade-error", {
          detail: new Error("live stream disconnected; EventSource will retry"),
        }),
      );
  }

  /** @param {LiveStreamMessage} message */
  receive(message) {
    if (message.version !== 1) return;
    if (message.type === "sync") {
      this.liveSynced = true;
      this.state.syncActive(message.canvases);
      this.updateLivePriority();
      for (const item of message.canvases) {
        this.livePixels.set(item.canvas.id, decodePixels(item.canvas.pixels));
        this.liveSequences.set(item.canvas.id, item.headSequence);
      }
      if (!this.bootstrapped) void this.bootstrap();
      return;
    }
    if (message.type === "snapshot") {
      this.state.addActive(message.canvas, true);
      this.updateLivePriority();
      const pixels = decodePixels(message.canvas.pixels);
      this.livePixels.set(message.canvas.id, pixels);
      this.liveSequences.set(message.canvas.id, message.headSequence);
      const visible = this.visible.get(message.canvas.id);
      if (visible) {
        visible.pixels = pixels.slice();
        visible.replay?.reset();
        drawPixels(visible.context, visible.pixels);
      }
      this.scheduleNextSpawn(0);
      return;
    }
    if (message.type === "diff") {
      const known = this.liveSequences.get(message.canvasId) ?? 0;
      const fresh = message.batches.filter((batch) => batch.sequence > known);
      if (fresh.length === 0) return;
      const pixels = this.livePixels.get(message.canvasId);
      if (pixels) {
        for (const batch of fresh) {
          for (const [index, color] of batch.cells) pixels[index] = color;
        }
      }
      this.liveSequences.set(message.canvasId, message.headSequence);
      this.visible.get(message.canvasId)?.replay?.receive(fresh, Date.now());
      return;
    }
    if (message.type === "completed") {
      this.state.complete(message.canvas);
      this.updateLivePriority();
      this.livePixels.delete(message.canvas.id);
      this.liveSequences.delete(message.canvas.id);
      const visible = this.visible.get(message.canvas.id);
      if (visible) {
        visible.state.textContent = "SIGNED";
        visible.figure.dataset.kind = "completed";
      }
      this.scheduleNextSpawn(0);
      return;
    }
    this.state.removeActive(message.canvasId);
    this.updateLivePriority();
    this.livePixels.delete(message.canvasId);
    this.liveSequences.delete(message.canvasId);
    if (this.state.active.size === 0) {
      void this.fetchCompletedPage();
      this.scheduleNextSpawn(0);
    }
  }

  async bootstrap() {
    this.bootstrapped = true;
    await Promise.all(
      Array.from(
        { length: Math.min(config.bootstrapCount, this.capacity) },
        () => this.spawnNext(true),
      ),
    );
    this.scheduleNextSpawn();
  }

  async fetchCompletedPage() {
    if (this.fetchingCompleted || !this.state.needsCompletedPage()) return;
    this.fetchingCompleted = true;
    try {
      const cursor = this.state.completedCursor
        ? `&cursor=${encodeURIComponent(this.state.completedCursor)}`
        : "";
      const response = await fetch(`/api/completed-feed?limit=20${cursor}`);
      if (!response.ok) {
        throw new Error(`completed feed failed: ${response.status}`);
      }
      const page = /** @type {CompletedFeedResponse} */ (await response.json());
      this.state.addCompletedPage(page.paintings, page.nextCursor);
      if (!this.liveSynced) return;
      if (!this.bootstrapped && this.state.active.size === 0) {
        void this.bootstrap();
      } else this.scheduleNextSpawn(0);
    } catch (error) {
      this.dispatchEvent(new CustomEvent("parade-error", { detail: error }));
    } finally {
      this.fetchingCompleted = false;
    }
  }

  /** @param {boolean} [bootstrap] */
  async spawnNext(bootstrap = false) {
    if (this.hidden || this.visible.size >= this.capacity) return;
    if (
      this.state.active.size === 0 && Date.now() < this.completedResumeAt
    ) {
      this.scheduleNextSpawn(this.completedResumeAt - Date.now());
      return;
    }
    if (this.state.needsCompletedPage()) void this.fetchCompletedPage();
    const candidate = this.state.next(new Set(this.visible.keys()));
    if (!candidate) return;
    try {
      const entry = candidate.kind === "active"
        ? this.activeEntry(candidate.canvas)
        : await this.completedEntry(candidate.canvas);
      if (candidate.kind === "completed" && this.state.active.size > 0) {
        this.state.signedFirst.unshift(candidate.canvas.id);
        return;
      }
      this.visible.set(candidate.canvas.id, entry);
      this.stage.append(entry.figure);
      if (bootstrap) this.seekIntoView(entry);
      if (entry.kind === "completed") this.startCompletedPlayback(entry);
      this.dispatchEvent(
        new CustomEvent("parade-spawn", {
          detail: {
            id: entry.id,
            kind: entry.kind,
            row: entry.figure.dataset.row,
          },
        }),
      );
      const diagnostics = /** @type {any} */ (window);
      diagnostics.__PAINTING_PARADE_EVENTS__ ??= [];
      diagnostics.__PAINTING_PARADE_EVENTS__.push({
        id: entry.id,
        kind: entry.kind,
        row: entry.figure.dataset.row,
        at: performance.now(),
      });
    } catch (error) {
      this.dispatchEvent(new CustomEvent("parade-error", { detail: error }));
    }
  }

  /** @param {number} [delay] */
  scheduleNextSpawn(delay = config.spawnIntervalMs) {
    clearTimeout(this.spawnTimer);
    this.spawnTimer = setTimeout(async () => {
      await this.spawnNext();
      this.scheduleNextSpawn();
    }, delay);
  }

  /** @param {PublicCanvas} canvas @param {"active" | "completed"} kind @param {Int32Array} pixels */
  baseEntry(canvas, kind, pixels) {
    const figure = document.createElement("figure");
    const sequence = this.spawnSequence++;
    const row = sequence % 2 === 0 ? "top" : "bottom";
    const narrow = matchMedia("(max-width: 40rem)").matches;
    const columns = narrow ? 2 : 4;
    const column = Math.floor(sequence / 2) % columns;
    figure.dataset.canvasId = canvas.id;
    figure.dataset.kind = kind;
    figure.dataset.row = row;
    figure.dataset.sequence = String(sequence);
    figure.style.setProperty(
      "--still-x",
      `${columns === 2 ? 5 + column * 50 : 4 + column * 24}%`,
    );
    const canvasElement = document.createElement("canvas");
    const context = paintingContext(canvasElement);
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
      replay: null,
      timeline: null,
      nextStep: 0,
      animation: null,
      playbackStartedAt: 0,
      playbackDurationMs: 0,
    });
    figure.addEventListener("animationend", () => this.retire(entry), {
      once: true,
    });
    return entry;
  }

  /** @param {PublicCanvas} canvas */
  activeEntry(canvas) {
    const pixels =
      (this.livePixels.get(canvas.id) ?? decodePixels(canvas.pixels)).slice();
    const entry = this.baseEntry(canvas, "active", pixels);
    entry.replay = new LiveReplay({ lagMs: 500, catchUpThresholdMs: 2_000 });
    return entry;
  }

  /** @param {PublicCanvas} canvas */
  async completedEntry(canvas) {
    let replay = this.replayCache.get(canvas.id);
    if (!replay) {
      replay = fetch(`/canvases/${canvas.id}/replay?v=5`).then((response) => {
        if (!response.ok) throw new Error(`replay failed: ${response.status}`);
        return response.json();
      });
      this.replayCache.set(canvas.id, replay);
    }
    const timeline = await replay;
    const entry = this.baseEntry(
      canvas,
      "completed",
      decodePixels(timeline.initialPixels),
    );
    entry.timeline = timeline;
    return entry;
  }

  /** @param {ParadeEntry} entry */
  seekIntoView(entry) {
    const animation = entry.figure.getAnimations()[0];
    if (!animation) return;
    const duration = Number(animation.effect?.getComputedTiming().duration);
    const width = entry.figure.getBoundingClientRect().width;
    const distance = this.stage.getBoundingClientRect().width + width * 1.7;
    if (duration > 0 && distance > 0) {
      animation.currentTime = duration * width * 1.08 / distance;
    }
  }

  /** @param {ParadeEntry} entry */
  startCompletedPlayback(entry) {
    entry.animation = entry.figure.getAnimations()[0] ?? null;
    const duration = Number(
      entry.animation?.effect?.getComputedTiming().duration ?? 0,
    );
    entry.playbackStartedAt = Number(entry.animation?.currentTime ?? 0);
    entry.playbackDurationMs = Math.max(1, duration * .68);
  }

  drain() {
    if (this.hidden) return;
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
      const animationTime = Number(
        entry.animation?.currentTime ?? entry.playbackStartedAt,
      );
      const elapsed = Math.max(0, animationTime - entry.playbackStartedAt) *
        entry.timeline.durationMs / entry.playbackDurationMs;
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
        elapsed >= entry.timeline.durationMs &&
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
    entry.figure.remove();
    this.visible.delete(entry.id);
    this.scheduleNextSpawn(0);
  }

  updateLivePriority() {
    if (this.state.active.size > 0) {
      this.hadLive = true;
      this.completedResumeAt = Number.POSITIVE_INFINITY;
    } else if (this.hadLive) {
      this.completedResumeAt = Date.now() + config.completedResumeDelayMs;
    }
  }

  onVisibility() {
    this.hidden = document.visibilityState !== "visible";
    this.toggleAttribute("paused", this.hidden);
    if (this.hidden) {
      this.source?.close();
      this.source = null;
      return;
    }
    this.connect();
    this.scheduleNextSpawn(0);
  }
}

customElements.define("painting-parade", PaintingParade);
