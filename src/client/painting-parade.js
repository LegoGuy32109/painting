// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").CanvasReplayResponse} CanvasReplayResponse */
/** @typedef {import("../shared/paint-types.d.ts").CompletedFeedResponse} CompletedFeedResponse */
/** @typedef {import("../shared/paint-types.d.ts").LiveStreamMessage} LiveStreamMessage */
/** @typedef {import("../shared/paint-types.d.ts").PublicCanvas} PublicCanvas */
/** @typedef {{ canvas: PublicCanvas, kind: "active" | "completed" }} ParadeCandidate */
/** @typedef {{ index: number, id: string | null, kind: "active" | "completed" | "placeholder", figure: HTMLElement, context: CanvasRenderingContext2D, title: HTMLElement, state: HTMLElement, pixels: Int32Array, replay: LiveReplay | null, timeline: CanvasReplayResponse | null, nextStep: number, animation: Animation | null, playbackStartedAt: number, playbackDurationMs: number, assignment: number, hydrating: boolean, pendingCandidate: ParadeCandidate | null }} ParadeSlot */

import { LiveReplay } from "./live-replay.js";
import { parseLiveStreamMessage } from "./live-stream-message.js";
import { ParadeState } from "./parade-state.js";
import { createPixels } from "../shared/paint-engine.js";
import {
  applyEncodedCells,
  decodePixels,
  drawPixels,
  paintingContext,
} from "../shared/pixel-render.js";

const config = {
  speedPxPerSecond: 28,
  slotIntervalSeconds: 6,
  completedResumeDelayMs: 5_000,
  ...(/** @type {any} */ (window).__PAINTING_TEST_CONFIG__ ?? {}),
};

class PaintingParade extends HTMLElement {
  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    this.state = new ParadeState();
    /** @type {ParadeSlot[]} */
    this.slots = [];
    /** @type {Map<string, Int32Array>} */
    this.livePixels = new Map();
    /** @type {Map<string, number>} */
    this.liveSequences = new Map();
    /** @type {Map<string, Promise<CanvasReplayResponse>>} */
    this.replayCache = new Map();
    /** @type {Array<() => Promise<void>>} */
    this.replayQueue = [];
    this.replayRequestsInFlight = 0;
    /** @type {HTMLElement} */
    this.stage = /** @type {any} */ (null);
    /** @type {EventSource | null} */
    this.source = null;
    /** @type {ResizeObserver | null} */
    this.resizeObserver = null;
    this.resizeFrame = 0;
    this.drainTimer = 0;
    this.completedResumeTimer = 0;
    this.fetchingCompleted = false;
    this.hidden = document.visibilityState !== "visible";
    this.liveSynced = false;
    this.hadLive = false;
    this.completedResumeAt = 0;
    this.onVisibility = this.onVisibility.bind(this);
  }

  connectedCallback() {
    if (this.root.childNodes.length === 0) this.build();
    document.addEventListener("visibilitychange", this.onVisibility);
    this.rebuildSlots();
    this.resizeObserver = new ResizeObserver(() => this.scheduleSlotRebuild());
    this.resizeObserver.observe(this);
    this.connect();
    void this.fetchCompletedPage();
    this.drainTimer = setInterval(() => this.drain(), 33);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    cancelAnimationFrame(this.resizeFrame);
    clearInterval(this.drainTimer);
    clearTimeout(this.completedResumeTimer);
    this.source?.close();
    this.source = null;
    this.releaseSlots();
  }

  get mode() {
    return this.getAttribute("mode") === "display" ? "display" : "ambient";
  }

  build() {
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; position:absolute; inset:0; overflow:hidden; pointer-events:none; contain:strict; }
      .stage { position:absolute; inset:0; overflow:hidden; }
      figure { --size:clamp(7rem,18vw,13rem); position:absolute; z-index:1; right:100%; width:var(--size); margin:0; padding:.5rem; color:#1d1d21; border:.1875rem solid #5d482c; background:#fff8e5; box-shadow:.35rem .35rem 0 rgb(45 32 18 / 28%); animation:travel var(--travel-duration,52s) linear infinite; will-change:transform; }
      figure[data-row="top"] { top:18%; }
      figure[data-row="bottom"] { top:66%; }
      canvas { display:block; width:100%; aspect-ratio:1; image-rendering:pixelated; background:#fff9ff; }
      figure[data-kind="placeholder"] canvas { opacity:.38; animation:loading-pulse .9s steps(2,end) infinite; }
      figure[data-kind="placeholder"] figcaption { color:#796f5e; }
      figcaption { display:flex; justify-content:space-between; gap:.5rem; min-height:1.3rem; padding-top:.45rem; overflow:hidden; font:clamp(.55rem,1.4vw,.72rem)/1.2 ui-monospace,monospace; white-space:nowrap; }
      .title { overflow:hidden; text-overflow:ellipsis; }
      .live { color:#b02e26; }
      :host([mode="ambient"]) { opacity:.55; filter:saturate(.85); }
      :host([mode="ambient"]) figure { --size:clamp(6rem,15vw,10rem); }
      :host([mode="display"]) figure[data-row="top"] { top:26%; }
      :host([mode="display"]) figure[data-row="bottom"] { top:59%; }
      :host([paused]) figure { animation-play-state:paused; }
      @keyframes travel { from { transform:translate3d(0,0,0); } to { transform:translate3d(calc(100vw + 170%),0,0); } }
      @keyframes loading-pulse { 50% { opacity:.62; } }
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
      for (const slot of this.slots) {
        if (
          slot.kind === "active" && slot.id && !this.state.active.has(slot.id)
        ) {
          this.recycleSlot(slot);
        }
      }
      void this.fillSlots();
      return;
    }
    if (message.type === "snapshot") {
      this.state.addActive(message.canvas, true);
      this.updateLivePriority();
      const pixels = decodePixels(message.canvas.pixels);
      this.livePixels.set(message.canvas.id, pixels);
      this.liveSequences.set(message.canvas.id, message.headSequence);
      for (const slot of this.assignedSlots(message.canvas.id)) {
        slot.pixels = pixels.slice();
        slot.replay?.reset();
        drawPixels(slot.context, slot.pixels);
      }
      void this.fillSlots();
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
      for (const slot of this.assignedSlots(message.canvasId)) {
        slot.replay?.receive(fresh, Date.now());
      }
      return;
    }
    if (message.type === "completed") {
      this.state.complete(message.canvas);
      this.updateLivePriority();
      this.livePixels.delete(message.canvas.id);
      this.liveSequences.delete(message.canvas.id);
      for (const slot of this.assignedSlots(message.canvas.id)) {
        this.recycleSlot(slot);
      }
      void this.fillSlots();
      return;
    }
    this.state.removeActive(message.canvasId);
    this.updateLivePriority();
    this.livePixels.delete(message.canvasId);
    this.liveSequences.delete(message.canvasId);
    for (const slot of this.assignedSlots(message.canvasId)) {
      this.recycleSlot(slot);
    }
    if (this.state.active.size === 0) void this.fetchCompletedPage();
  }

  scheduleSlotRebuild() {
    cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = requestAnimationFrame(() => this.rebuildSlots());
  }

  rebuildSlots() {
    this.releaseSlots();
    this.stage.replaceChildren();
    const probe = this.createSlot(0);
    this.stage.append(probe.figure);
    const cardWidth = probe.figure.getBoundingClientRect().width;
    probe.figure.remove();
    const stageWidth = this.stage.getBoundingClientRect().width || innerWidth;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const narrow = matchMedia("(max-width: 40rem)").matches;
    const distance = stageWidth + cardWidth * 1.7;
    const durationSeconds = reduced ? 0 : distance / config.speedPxPerSecond;
    let slotCount = reduced ? narrow ? 4 : 8 : Math.max(
      2,
      Math.min(64, Math.ceil(durationSeconds / config.slotIntervalSeconds)),
    );
    if (slotCount % 2 !== 0) slotCount++;
    const slotIntervalSeconds = reduced ? 0 : durationSeconds / slotCount;
    this.dataset.slotCount = String(slotCount);
    this.dataset.travelDuration = String(durationSeconds);
    this.dataset.slotInterval = String(slotIntervalSeconds);
    for (let index = 0; index < slotCount; index++) {
      const slot = this.createSlot(index);
      const phase = reduced ? 0 : (slotCount - index - 1) * slotIntervalSeconds;
      slot.figure.dataset.phaseSeconds = String(phase);
      slot.figure.style.setProperty("--travel-duration", `${durationSeconds}s`);
      slot.figure.style.animationDelay = reduced ? "0s" : `${-phase}s`;
      this.slots.push(slot);
      this.stage.append(slot.figure);
    }
    void this.fillSlots();
  }

  releaseSlots() {
    for (const slot of this.slots) {
      slot.assignment++;
      if (slot.pendingCandidate) this.releaseCandidate(slot.pendingCandidate);
      else if (slot.id && slot.kind !== "placeholder") {
        const canvas = slot.kind === "active"
          ? this.state.active.get(slot.id)
          : this.state.completed.get(slot.id);
        if (canvas) this.releaseCandidate({ canvas, kind: slot.kind });
      }
    }
    this.slots = [];
  }

  /** @param {number} index @returns {ParadeSlot} */
  createSlot(index) {
    const figure = document.createElement("figure");
    const row = index % 2 === 0 ? "top" : "bottom";
    const narrow = matchMedia("(max-width: 40rem)").matches;
    const columns = narrow ? 2 : 4;
    const column = Math.floor(index / 2) % columns;
    figure.dataset.slotIndex = String(index);
    figure.dataset.canvasId = "";
    figure.dataset.kind = "placeholder";
    figure.dataset.row = row;
    figure.style.setProperty(
      "--still-x",
      `${columns === 2 ? 5 + column * 50 : 4 + column * 24}%`,
    );
    const canvas = document.createElement("canvas");
    const context = paintingContext(canvas);
    const title = document.createElement("span");
    title.className = "title";
    const state = document.createElement("span");
    const caption = document.createElement("figcaption");
    caption.append(title, state);
    figure.append(canvas, caption);
    const slot = /** @type {ParadeSlot} */ ({
      index,
      id: null,
      kind: "placeholder",
      figure,
      context,
      title,
      state,
      pixels: createPixels(),
      replay: null,
      timeline: null,
      nextStep: 0,
      animation: null,
      playbackStartedAt: 0,
      playbackDurationMs: 0,
      assignment: 0,
      hydrating: false,
      pendingCandidate: null,
    });
    this.showPlaceholder(slot);
    figure.addEventListener("animationiteration", () => this.recycleSlot(slot));
    return slot;
  }

  /** @param {ParadeSlot} slot */
  recycleSlot(slot) {
    if (!this.slots.includes(slot)) return;
    if (slot.hydrating) return;
    slot.assignment++;
    if (slot.pendingCandidate) this.releaseCandidate(slot.pendingCandidate);
    this.showPlaceholder(slot);
    void this.populateSlot(slot);
  }

  async fillSlots() {
    if (!this.liveSynced) return;
    await Promise.all(
      this.slots.filter((slot) =>
        slot.kind === "placeholder" && !slot.hydrating
      ).map((slot) => this.populateSlot(slot)),
    );
  }

  /** @param {ParadeSlot} slot */
  async populateSlot(slot) {
    if (
      !this.liveSynced || slot.hydrating ||
      (this.state.active.size === 0 && Date.now() < this.completedResumeAt)
    ) return;
    if (this.state.needsCompletedPage()) void this.fetchCompletedPage();
    const visibleIds = new Set(
      this.slots.flatMap((entry) => {
        const id = entry.id ?? entry.pendingCandidate?.canvas.id;
        return id ? [id] : [];
      }),
    );
    const candidate = /** @type {ParadeCandidate | null} */ (
      this.state.next(visibleIds)
    );
    if (!candidate) return;
    const assignment = ++slot.assignment;
    slot.hydrating = true;
    slot.pendingCandidate = candidate;
    try {
      if (candidate.kind === "active") {
        if (slot.assignment !== assignment) return;
        this.showActive(slot, candidate.canvas);
      } else {
        const timeline = await this.completedReplay(candidate.canvas.id);
        if (slot.assignment !== assignment) return;
        if (this.state.active.size > 0) {
          this.releaseCandidate(candidate);
          this.showPlaceholder(slot);
          return;
        }
        this.showCompleted(slot, candidate.canvas, timeline);
      }
      slot.pendingCandidate = null;
      this.recordAssignment(slot);
    } catch (error) {
      if (slot.assignment === assignment) {
        this.releaseCandidate(candidate);
        this.showPlaceholder(slot);
        this.dispatchEvent(new CustomEvent("parade-error", { detail: error }));
      }
    } finally {
      if (slot.assignment === assignment) {
        slot.hydrating = false;
        slot.pendingCandidate = null;
      }
    }
  }

  /** @param {ParadeCandidate} candidate */
  releaseCandidate(candidate) {
    const id = candidate.canvas.id;
    if (candidate.kind === "active") {
      if (this.state.active.has(id) && !this.state.activeRound.includes(id)) {
        this.state.activeRound.unshift(id);
      }
      return;
    }
    if (
      this.state.completed.has(id) &&
      !this.state.signedFirst.includes(id) &&
      !this.state.unseenCompleted.includes(id) &&
      !this.state.repeatBag.includes(id)
    ) this.state.unseenCompleted.unshift(id);
  }

  /** @param {ParadeSlot} slot */
  showPlaceholder(slot) {
    slot.id = null;
    slot.kind = "placeholder";
    slot.hydrating = false;
    slot.pendingCandidate = null;
    slot.figure.dataset.canvasId = "";
    slot.figure.dataset.kind = "placeholder";
    slot.title.textContent = "Loading painting";
    slot.state.className = "loading";
    slot.state.textContent = "LOADING";
    slot.pixels = createPixels();
    slot.replay = null;
    slot.timeline = null;
    slot.nextStep = 0;
    drawPixels(slot.context, slot.pixels);
  }

  /** @param {ParadeSlot} slot @param {PublicCanvas} canvas */
  showActive(slot, canvas) {
    slot.id = canvas.id;
    slot.kind = "active";
    slot.figure.dataset.canvasId = canvas.id;
    slot.figure.dataset.kind = "active";
    slot.title.textContent = canvas.title || "Painting now";
    slot.state.className = "live";
    slot.state.textContent = "LIVE";
    slot.pixels =
      (this.livePixels.get(canvas.id) ?? decodePixels(canvas.pixels)).slice();
    slot.replay = new LiveReplay({ lagMs: 500, catchUpThresholdMs: 2_000 });
    slot.timeline = null;
    slot.nextStep = 0;
    drawPixels(slot.context, slot.pixels);
  }

  /** @param {ParadeSlot} slot @param {PublicCanvas} canvas @param {CanvasReplayResponse} timeline */
  showCompleted(slot, canvas, timeline) {
    slot.id = canvas.id;
    slot.kind = "completed";
    slot.figure.dataset.canvasId = canvas.id;
    slot.figure.dataset.kind = "completed";
    slot.title.textContent = canvas.title || "Untitled";
    slot.state.className = "replay";
    slot.state.textContent = "REPLAY";
    slot.pixels = decodePixels(timeline.initialPixels);
    slot.replay = null;
    slot.timeline = timeline;
    slot.nextStep = 0;
    drawPixels(slot.context, slot.pixels);
    this.startCompletedPlayback(slot);
  }

  /** @param {string} canvasId */
  async completedReplay(canvasId) {
    let replay = this.replayCache.get(canvasId);
    if (!replay) {
      replay = this.queueReplayRequest(async () => {
        const response = await fetch(`/canvases/${canvasId}/replay`);
        if (!response.ok) throw new Error(`replay failed: ${response.status}`);
        return await response.json();
      });
      this.replayCache.set(canvasId, replay);
      void replay.catch(() => {
        if (this.replayCache.get(canvasId) === replay) {
          this.replayCache.delete(canvasId);
        }
      });
    }
    return await replay;
  }

  /** @template T @param {() => Promise<T>} request @returns {Promise<T>} */
  queueReplayRequest(request) {
    return new Promise((resolve, reject) => {
      this.replayQueue.push(async () => {
        try {
          resolve(await request());
        } catch (error) {
          reject(error);
        }
      });
      this.drainReplayQueue();
    });
  }

  drainReplayQueue() {
    while (this.replayRequestsInFlight < 2 && this.replayQueue.length > 0) {
      const request = this.replayQueue.shift();
      if (!request) return;
      this.replayRequestsInFlight++;
      void request().finally(() => {
        this.replayRequestsInFlight--;
        this.drainReplayQueue();
      });
    }
  }

  /** @param {ParadeSlot} slot */
  startCompletedPlayback(slot) {
    slot.animation = slot.figure.getAnimations()[0] ?? null;
    const duration = Number(
      slot.animation?.effect?.getComputedTiming().duration ?? 0,
    );
    const currentTime = Number(slot.animation?.currentTime ?? 0);
    const phase = duration > 0 ? currentTime % duration : 0;
    slot.playbackStartedAt = currentTime - phase;
    slot.playbackDurationMs = Math.max(1, duration * .68);
  }

  /** @param {string} canvasId */
  assignedSlots(canvasId) {
    return this.slots.filter((slot) => slot.id === canvasId);
  }

  /** @param {ParadeSlot} slot */
  recordAssignment(slot) {
    this.dispatchEvent(
      new CustomEvent("parade-spawn", {
        detail: {
          id: slot.id,
          kind: slot.kind,
          row: slot.figure.dataset.row,
          slot: slot.index,
        },
      }),
    );
    const diagnostics = /** @type {any} */ (window);
    diagnostics.__PAINTING_PARADE_EVENTS__ ??= [];
    diagnostics.__PAINTING_PARADE_EVENTS__.push({
      id: slot.id,
      kind: slot.kind,
      row: slot.figure.dataset.row,
      slot: slot.index,
      at: performance.now(),
    });
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
      if (this.liveSynced) void this.fillSlots();
    } catch (error) {
      this.dispatchEvent(new CustomEvent("parade-error", { detail: error }));
    } finally {
      this.fetchingCompleted = false;
    }
  }

  drain() {
    if (this.hidden) return;
    for (const slot of this.slots) {
      if (slot.kind === "active") {
        let changed = false;
        for (const batch of slot.replay?.drain(Date.now()) ?? []) {
          for (const [index, color] of batch.cells) slot.pixels[index] = color;
          changed = true;
        }
        if (changed) drawPixels(slot.context, slot.pixels);
        continue;
      }
      if (slot.kind !== "completed" || !slot.timeline) continue;
      const animationTime = Number(
        slot.animation?.currentTime ?? slot.playbackStartedAt,
      );
      const elapsed = Math.max(0, animationTime - slot.playbackStartedAt) *
        slot.timeline.durationMs / slot.playbackDurationMs;
      let changed = false;
      while (
        slot.nextStep < slot.timeline.steps.length &&
        slot.timeline.steps[slot.nextStep].atMs <= elapsed
      ) {
        const step = slot.timeline.steps[slot.nextStep++];
        if (step.type === "snapshot") slot.pixels = decodePixels(step.pixels);
        else applyEncodedCells(slot.pixels, step.cells);
        changed = true;
      }
      if (changed) drawPixels(slot.context, slot.pixels);
      if (
        elapsed >= slot.timeline.durationMs &&
        slot.state.textContent !== "SIGNED"
      ) {
        slot.pixels = decodePixels(slot.timeline.finalPixels);
        drawPixels(slot.context, slot.pixels);
        slot.state.textContent = "SIGNED";
      }
    }
  }

  updateLivePriority() {
    clearTimeout(this.completedResumeTimer);
    if (this.state.active.size > 0) {
      this.hadLive = true;
      this.completedResumeAt = Number.POSITIVE_INFINITY;
    } else if (this.hadLive) {
      this.completedResumeAt = Date.now() + config.completedResumeDelayMs;
      this.completedResumeTimer = setTimeout(
        () => void this.fillSlots(),
        config.completedResumeDelayMs,
      );
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
  }
}

customElements.define("painting-parade", PaintingParade);
