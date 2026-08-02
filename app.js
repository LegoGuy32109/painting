import {
  applyStamp,
  argbToHex,
  BRUSH_BOUNDS,
  brushAnchor,
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  copyPixels,
  createPixels,
  hexToArgb,
  OPAQUE_WHITE,
  rasterLine,
} from "./paint-engine.js";

const BASE_COLORS = Object.freeze([
  "black",
  "red",
  "green",
  "brown",
  "blue",
  "purple",
  "cyan",
  "light-gray",
  "gray",
  "pink",
  "lime",
  "yellow",
  "light-blue",
  "magenta",
  "orange",
  "white",
]);

const EMPTY_WELL = "#ffece5";

function emit(element, name, detail) {
  element.dispatchEvent(
    new CustomEvent(name, {
      bubbles: true,
      composed: true,
      detail,
    }),
  );
}

function defaultPaletteState() {
  return {
    baseAvailable: Array(BASE_COLORS.length).fill(true),
    customWells: Array.from({ length: 12 }, () => ({
      totalRed: 0,
      totalGreen: 0,
      totalBlue: 0,
      totalMaximum: 0,
      numberOfColors: 0,
    })),
  };
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function cssColor(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(`--mc-${name}`)
    .trim();
}

class MCColor extends HTMLElement {
  static get observedAttributes() {
    return ["color", "empty", "selected", "disabled"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; inline-size: var(--well-size, 2rem); block-size: var(--well-size, 2rem); }
        .well {
          inline-size: 100%; block-size: 100%; border: 1px solid rgb(29 29 33 / 45%);
          border-radius: .125rem; background: var(--well-color, ${EMPTY_WELL});
        }
        :host([selected]) .well { outline: .1875rem solid var(--mc-blue); outline-offset: .125rem; }
        :host([disabled]) .well { opacity: .55; }
      </style>
      <div class="well"></div>
    `;
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  render() {
    const color = this.hasAttribute("empty")
      ? EMPTY_WELL
      : this.getAttribute("color") || EMPTY_WELL;
    this.style.setProperty("--well-color", color);
  }
}

class PaintPalette extends HTMLElement {
  static get observedAttributes() {
    return [
      "palette-state",
      "selected-source",
      "selected-index",
      "selected-color",
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  selection() {
    const indexValue = this.getAttribute("selected-index");
    return {
      source: this.getAttribute("selected-source") || null,
      index: indexValue === null || indexValue === "null"
        ? null
        : Number(indexValue),
      color: this.getAttribute("selected-color") || null,
    };
  }

  render() {
    const palette = parseJson(
      this.getAttribute("palette-state"),
      defaultPaletteState(),
    );
    const selection = this.selection();
    const available = palette.baseAvailable || [];

    this.shadowRoot.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; width: 100%; }
      .palette { display: grid; gap: .5rem; }
      .wells { display: flex; align-items: start; gap: .5rem; min-width: 0; }
      .selected { --well-size: 3.25rem; flex: 0 0 auto; }
      .rows { display: grid; gap: .375rem; min-width: 0; overflow-x: auto; padding: .125rem; }
      .row { display: grid; gap: .25rem; width: max-content; }
      .base { grid-template-columns: repeat(6, 2.5rem); }
      .base mc-color { --well-size: 2.5rem; cursor: crosshair; }
      @media (max-width: 42rem) {
        .wells { display: grid; grid-template-columns: 3.25rem minmax(0, 1fr); align-items: start; gap: .375rem; }
        .rows { width: 100%; overflow: visible; padding: 0; }
      }
      @media (max-width: 28rem) {
        .selected { --well-size: 3rem; }
        .wells { grid-template-columns: 3rem minmax(0, 1fr); }
        .wells { gap: .25rem; }
        .row { gap: .1875rem; }
      }
    `;

    const paletteElement = document.createElement("div");
    paletteElement.className = "palette";
    const wells = document.createElement("div");
    wells.className = "wells";

    const selected = document.createElement("mc-color");
    selected.className = "selected";
    if (selection.color) {
      selected.setAttribute("color", selection.color);
      selected.setAttribute("selected", "");
    } else {
      selected.setAttribute("empty", "");
    }
    wells.append(selected);

    const rows = document.createElement("div");
    rows.className = "rows";
    const baseRow = document.createElement("div");
    baseRow.className = "row base";
    BASE_COLORS.forEach((name, index) => {
      const well = document.createElement("mc-color");
      well.setAttribute("color", cssColor(name));
      well.setAttribute("aria-label", name);
      if (!available[index]) well.setAttribute("disabled", "");
      if (selection.source === "base" && selection.index === index) {
        well.setAttribute("selected", "");
      }
      well.addEventListener("click", () => {
        if (!available[index]) return;
        emit(this, "palette-color-selected", {
          source: "base",
          index,
          color: cssColor(name),
        });
      });
      baseRow.append(well);
    });
    rows.append(baseRow);

    wells.append(rows);
    paletteElement.append(wells);
    this.shadowRoot.append(style, paletteElement);
  }
}

class PaintCanvas extends HTMLElement {
  static get observedAttributes() {
    return [
      "paint-color",
      "brush-size",
      "erase",
      "opacity",
      "tool",
      "undo-request",
      "new-canvas-request",
      "canvas-id",
    ];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.pixels = createPixels();
    this.undoStack = [];
    this.stroke = null;
    this.cellSize = 1;
    this.displaySize = CANVAS_WIDTH;
    this.drawScale = 1;
    this.previewAnchor = null;
    this.resizeObserver = new ResizeObserver(() => this.resize());
  }

  connectedCallback() {
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; max-width: 24rem; }
        @media (min-width: 48rem) { :host { max-width: 31rem; } }
        .surface { position: relative; width: fit-content; margin-inline: auto; touch-action: none; cursor: crosshair; }
        canvas { position: absolute; inset: 0; display: block; image-rendering: pixelated; }
        .base { position: relative; }
        .overlay { pointer-events: none; }
      </style>
      <div class="surface">
        <canvas class="base" aria-label="Painting canvas"></canvas>
        <canvas class="overlay" aria-hidden="true"></canvas>
      </div>
    `;
    this.surface = this.shadowRoot.querySelector(".surface");
    this.baseCanvas = this.shadowRoot.querySelector(".base");
    this.overlayCanvas = this.shadowRoot.querySelector(".overlay");
    this.baseContext = this.baseCanvas.getContext("2d", { alpha: false });
    this.overlayContext = this.overlayCanvas.getContext("2d");
    this.surface.addEventListener(
      "pointerdown",
      (event) => this.onPointerDown(event),
    );
    this.surface.addEventListener(
      "pointermove",
      (event) => this.onPointerMove(event),
    );
    this.surface.addEventListener(
      "pointerup",
      (event) => this.onPointerUp(event),
    );
    this.surface.addEventListener(
      "pointercancel",
      (event) => this.onPointerCancel(event),
    );
    this.surface.addEventListener(
      "pointerleave",
      (event) => this.onPointerLeave(event),
    );
    this.resizeObserver.observe(this);
    this.resize();
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === "undo-request" && oldValue !== null && oldValue !== newValue) {
      this.undo();
    }
    if (
      name === "new-canvas-request" && oldValue !== null &&
      oldValue !== newValue
    ) {
      this.resetCanvas();
    }
    if (
      this.surface &&
      ["paint-color", "brush-size", "erase", "tool"].includes(name)
    ) {
      this.refreshPreview();
    }
  }

  get brushSize() {
    const size = Number(this.getAttribute("brush-size"));
    return Number.isInteger(size) && size >= 1 && size <= 4 ? size : 1;
  }

  get opacity() {
    const opacity = Number(this.getAttribute("opacity"));
    return [25, 50, 75, 100].includes(opacity) ? opacity : 100;
  }

  get tool() {
    return this.getAttribute("tool") || "paint";
  }

  get erase() {
    return this.hasAttribute("erase") && this.getAttribute("erase") !== "false";
  }

  get paintColor() {
    return hexToArgb(this.getAttribute("paint-color") || "");
  }

  get canPaint() {
    return this.tool === "paint" && (this.erase || this.paintColor !== null);
  }

  get canvasId() {
    return this.getAttribute("canvas-id") || "local-prototype";
  }

  resize() {
    if (!this.surface) return;
    const maximumCanvasSize = window.matchMedia("(min-width: 48rem)").matches
      ? 480
      : 384;
    const availableWidth = Math.min(
      Math.max(0, (this.getBoundingClientRect().width || 384) - 16),
      maximumCanvasSize,
    );
    const nextCellSize = Math.max(
      1,
      Math.floor(availableWidth / CANVAS_WIDTH),
    );
    const nextDisplaySize = nextCellSize * CANVAS_WIDTH;
    if (
      this.cellSize === nextCellSize && this.displaySize === nextDisplaySize &&
      this.baseCanvas.width > 0
    ) return;

    this.cellSize = nextCellSize;
    this.displaySize = nextDisplaySize;
    const deviceCellSize = Math.max(
      1,
      Math.round(this.cellSize * devicePixelRatio),
    );
    const deviceSize = deviceCellSize * CANVAS_WIDTH;
    this.drawScale = deviceCellSize / this.cellSize;
    this.surface.style.width = `${this.displaySize}px`;
    this.surface.style.height = `${this.displaySize}px`;

    for (const canvas of [this.baseCanvas, this.overlayCanvas]) {
      canvas.width = deviceSize;
      canvas.height = deviceSize;
      canvas.style.width = `${this.displaySize}px`;
      canvas.style.height = `${this.displaySize}px`;
    }
    this.configureContext(this.baseContext);
    this.configureContext(this.overlayContext);
    this.renderPixels();
    this.renderPreview();
  }

  configureContext(context) {
    context.setTransform(this.drawScale, 0, 0, this.drawScale, 0, 0);
    context.imageSmoothingEnabled = false;
  }

  renderPixels() {
    if (!this.baseContext) return;
    this.baseContext.fillStyle = "#f9fffe";
    this.baseContext.fillRect(0, 0, this.displaySize, this.displaySize);
    for (let index = 0; index < this.pixels.length; index += 1) {
      this.drawPixel(index, this.pixels[index]);
    }
  }

  drawPixel(index, color) {
    const x = index % CANVAS_WIDTH;
    const y = Math.floor(index / CANVAS_WIDTH);
    this.baseContext.fillStyle = argbToHex(color);
    this.baseContext.fillRect(
      x * this.cellSize,
      y * this.cellSize,
      this.cellSize,
      this.cellSize,
    );
  }

  clearPreview() {
    this.overlayContext.clearRect(0, 0, this.displaySize, this.displaySize);
  }

  renderPreview() {
    this.clearPreview();
    if (!this.previewAnchor || !this.canPaint) return;
    const bounds = BRUSH_BOUNDS[this.brushSize];
    const left = (this.previewAnchor.x + bounds.minX) * this.cellSize;
    const top = (this.previewAnchor.y + bounds.minY) * this.cellSize;
    const size = bounds.size * this.cellSize + 2;
    const context = this.overlayContext;
    context.fillStyle = "#4d4d4d";
    context.fillRect(left - 1, top - 1, size, 1);
    context.fillRect(left - 1, top + size - 2, size, 1);
    context.fillRect(left - 1, top - 1, 1, size);
    context.fillRect(left + size - 2, top - 1, 1, size);
  }

  pointForEvent(event) {
    const rect = this.surface.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    return {
      x,
      y,
      inside: x >= 0 && y >= 0 && x < rect.width && y < rect.height,
    };
  }

  anchorForEvent(event) {
    const point = this.pointForEvent(event);
    return {
      point,
      anchor: brushAnchor(point.x, point.y, this.cellSize, this.brushSize),
    };
  }

  onPointerDown(event) {
    if (
      !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)
    ) return;
    const { point, anchor } = this.anchorForEvent(event);
    if (!point.inside) return;

    if (this.tool === "picker") {
      event.preventDefault();
      emit(this, "color-picked", {
        color: argbToHex(this.pixels[anchor.y * CANVAS_WIDTH + anchor.x] ?? 0),
      });
      this.previewAnchor = null;
      this.renderPreview();
      return;
    }
    if (!this.canPaint) return;

    event.preventDefault();
    this.surface.setPointerCapture(event.pointerId);
    this.stroke = {
      id: crypto.randomUUID(),
      pointerId: event.pointerId,
      seen: new Set(),
      snapshot: copyPixels(this.pixels),
      lastAnchor: anchor,
      changed: false,
      pendingCells: [],
      progressScheduled: false,
      sequence: 0,
      paintedCellCount: 0,
      brushSize: this.brushSize,
      color: this.erase ? OPAQUE_WHITE : this.paintColor,
      opacity: this.erase ? 100 : this.opacity,
    };
    this.paintAnchor(anchor);
    if (event.pointerType !== "touch") {
      this.previewAnchor = anchor;
      this.renderPreview();
    }
  }

  onPointerMove(event) {
    const { point, anchor } = this.anchorForEvent(event);
    if (this.stroke?.pointerId === event.pointerId) {
      event.preventDefault();
      if (!point.inside) {
        this.stroke.lastAnchor = null;
        this.previewAnchor = null;
        this.renderPreview();
        return;
      }
      if (this.stroke.lastAnchor) {
        for (const lineAnchor of rasterLine(this.stroke.lastAnchor, anchor)) {
          this.paintAnchor(lineAnchor);
        }
      } else {
        this.paintAnchor(anchor);
      }
      this.stroke.lastAnchor = anchor;
      if (event.pointerType !== "touch") {
        this.previewAnchor = anchor;
        this.renderPreview();
      }
      return;
    }

    if (event.pointerType !== "touch" && point.inside && this.canPaint) {
      this.previewAnchor = anchor;
      this.renderPreview();
    }
  }

  onPointerLeave(event) {
    if (this.stroke?.pointerId === event.pointerId) {
      this.stroke.lastAnchor = null;
    }
    this.previewAnchor = null;
    this.renderPreview();
  }

  onPointerUp(event) {
    if (this.stroke?.pointerId !== event.pointerId) return;
    const { point, anchor } = this.anchorForEvent(event);
    if (point.inside) {
      if (this.stroke.lastAnchor) {
        for (const lineAnchor of rasterLine(this.stroke.lastAnchor, anchor)) {
          this.paintAnchor(lineAnchor);
        }
      } else {
        this.paintAnchor(anchor);
      }
    }
    this.finishStroke();
  }

  onPointerCancel(event) {
    if (this.stroke?.pointerId === event.pointerId) this.finishStroke();
  }

  paintAnchor(anchor) {
    const changes = applyStamp(
      this.pixels,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      anchor,
      this.stroke.brushSize,
      this.stroke.color,
      this.stroke.opacity,
      this.stroke.seen,
    );
    if (changes.length === 0) return;
    this.stroke.changed = true;
    this.stroke.paintedCellCount += changes.length;
    for (const change of changes) {
      this.drawPixel(change.index, change.color);
      this.stroke.pendingCells.push([change.index, change.color]);
    }
    this.scheduleProgress();
  }

  scheduleProgress() {
    if (this.stroke.progressScheduled) return;
    this.stroke.progressScheduled = true;
    requestAnimationFrame(() => this.flushProgress());
  }

  flushProgress() {
    if (!this.stroke || this.stroke.pendingCells.length === 0) return;
    this.stroke.progressScheduled = false;
    this.stroke.sequence += 1;
    emit(this, "paint-progress", {
      canvasId: this.canvasId,
      strokeId: this.stroke.id,
      sequence: this.stroke.sequence,
      cells: this.stroke.pendingCells.splice(0),
    });
  }

  finishStroke() {
    const stroke = this.stroke;
    if (!stroke) return;
    this.flushProgress();
    this.stroke = null;
    this.previewAnchor = null;
    this.renderPreview();

    if (stroke.changed) {
      this.undoStack.push(stroke.snapshot);
      if (this.undoStack.length > 16) this.undoStack.shift();
      emit(this, "undo-availability-changed", { canUndo: true });
      emit(this, "stroke-committed", {
        canvasId: this.canvasId,
        strokeId: stroke.id,
        sequence: stroke.sequence,
        cellCount: stroke.paintedCellCount,
      });
    }
  }

  undo() {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return;
    this.pixels = snapshot;
    this.renderPixels();
    emit(this, "undo-availability-changed", {
      canUndo: this.undoStack.length > 0,
    });
  }

  resetCanvas() {
    this.pixels = createPixels();
    this.undoStack = [];
    this.stroke = null;
    this.previewAnchor = null;
    this.renderPixels();
    this.renderPreview();
    emit(this, "undo-availability-changed", { canUndo: false });
  }

  refreshPreview() {
    if (!this.canPaint) this.previewAnchor = null;
    this.renderPreview();
  }
}

customElements.define("mc-color", MCColor);
customElements.define("paint-palette", PaintPalette);
customElements.define("paint-canvas", PaintCanvas);

function fitAppToViewport() {
  const app = document.querySelector(".app");
  if (!app) return;
  app.style.setProperty("--app-scale", "1");

  requestAnimationFrame(() => {
    const viewport = window.visualViewport;
    const availableWidth = (viewport?.width || window.innerWidth) - 16;
    const availableHeight = (viewport?.height || window.innerHeight) - 16;
    const scale = Math.min(
      1,
      availableWidth / app.offsetWidth,
      availableHeight / app.offsetHeight,
    );
    app.style.setProperty("--app-scale", String(scale));
  });
}

const app = document.querySelector(".app");
if (app) {
  new ResizeObserver(fitAppToViewport).observe(app);
  window.addEventListener("resize", fitAppToViewport);
  window.visualViewport?.addEventListener("resize", fitAppToViewport);
  fitAppToViewport();
}

export { defaultPaletteState };
