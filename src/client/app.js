// @ts-check

/** @typedef {import("./paint-types.d.ts").PaletteSelection} PaletteSelection */
/** @typedef {import("./paint-types.d.ts").BrushSize} BrushSize */
/** @typedef {import("./paint-types.d.ts").OpacityPercent} OpacityPercent */
/** @typedef {import("./paint-types.d.ts").PaintProgressDetail} PaintProgressDetail */
/** @typedef {import("./paint-types.d.ts").StrokeCommittedDetail} StrokeCommittedDetail */
/** @typedef {import("./paint-types.d.ts").UndoAvailabilityDetail} UndoAvailabilityDetail */
/** @typedef {import("./paint-types.d.ts").ColorPickedDetail} ColorPickedDetail */
/** @typedef {import("./paint-types.d.ts").Cell} Cell */
/** @typedef {import("./paint-types.d.ts").PaletteState} PaletteState */
/** @typedef {import("./paint-types.d.ts").PaletteStateChangedDetail} PaletteStateChangedDetail */
/** @typedef {import("./paint-types.d.ts").PixelChange} PixelChange */
/** @typedef {import("./paint-types.d.ts").Stroke} Stroke */

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
import {
  addColorToWell,
  colorFromWell,
  clearWell,
  EMPTY_WELL_COLOR,
  emptyWell,
} from "./palette-engine.js";

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

/** @param {EventTarget} element @param {string} name @param {unknown} detail */
function emit(element, name, detail) {
  element.dispatchEvent(
    new CustomEvent(name, {
      bubbles: true,
      composed: true,
      detail,
    }),
  );
}

/** @returns {PaletteState} */
function defaultPaletteState() {
  return {
    baseAvailable: Array(BASE_COLORS.length).fill(true),
    customWells: Array.from({ length: 12 }, emptyWell),
  };
}

/** @param {string | null} value @param {unknown} fallback @returns {unknown} */
function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

/** @param {string} name @returns {string} */
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
    this.root = this.attachShadow({ mode: "open" });
    this.root.innerHTML = `
      <style>
        :host { display: block; inline-size: var(--well-size, 2rem); block-size: var(--well-size, 2rem); }
        .well {
          inline-size: 100%; block-size: 100%; border: 1px solid rgb(29 29 33 / 45%);
          border-radius: .125rem; background: var(--well-color, ${EMPTY_WELL_COLOR});
        }
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
      ? EMPTY_WELL_COLOR
      : this.getAttribute("color") || EMPTY_WELL_COLOR;
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
    this.root = this.attachShadow({ mode: "open" });
    /** @type {any} */
    this.drag = null;
    this.suppressClick = false;
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerEnd = this.onPointerEnd.bind(this);
    this.onClick = this.onClick.bind(this);
  }

  connectedCallback() {
    this.render();
    document.addEventListener("pointerdown", this.onPointerDown);
    document.addEventListener("pointermove", this.onPointerMove);
    document.addEventListener("pointerup", this.onPointerEnd);
    document.addEventListener("pointercancel", this.onPointerEnd);
    document.addEventListener("click", this.onClick, true);
  }

  disconnectedCallback() {
    document.removeEventListener("pointerdown", this.onPointerDown);
    document.removeEventListener("pointermove", this.onPointerMove);
    document.removeEventListener("pointerup", this.onPointerEnd);
    document.removeEventListener("pointercancel", this.onPointerEnd);
    document.removeEventListener("click", this.onClick, true);
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  /** @returns {PaletteSelection} */
  selection() {
    const indexValue = this.getAttribute("selected-index");
    return {
      source: /** @type {PaletteSelection["source"]} */ (
        this.getAttribute("selected-source") || null
      ),
      index: indexValue === null || indexValue === "null"
        ? null
        : Number(indexValue),
      color: this.getAttribute("selected-color") || null,
    };
  }

  /** @returns {PaletteState} */
  palette() {
    return /** @type {PaletteState} */ (parseJson(
      this.getAttribute("palette-state"),
      defaultPaletteState(),
    ));
  }

  /** @param {PointerEvent} event */
  onPointerDown(event) {
    if (event.button !== 0 || this.drag) return;
    const sourceElement = event.composedPath().find((node) =>
      node instanceof HTMLElement && node.dataset.paletteSource
    );
    if (!(sourceElement instanceof HTMLElement) || sourceElement.hasAttribute("disabled")) return;
    const source = sourceElement.dataset.paletteSource;
    const color = sourceElement.dataset.paletteColor ||
      sourceElement.getAttribute("color");
    if (source !== "water" && !color) return;
    this.drag = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      source: source || "",
      sourceIndex: Number(sourceElement.dataset.paletteIndex),
      color,
      element: sourceElement,
      active: false,
      target: null,
      ghost: null,
    };
    sourceElement.setPointerCapture?.(event.pointerId);
  }

  /** @param {PointerEvent} event */
  onPointerMove(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY);
    if (!drag.active && distance < 6) return;
    if (!drag.active) this.startDrag(drag, event);
    event.preventDefault();
    this.updateDrag(drag, event);
  }

  /** @param {PointerEvent} event */
  onPointerEnd(event) {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = null;
    drag.element.releasePointerCapture?.(event.pointerId);
    if (!drag.active) return;
    this.suppressClick = true;
    const targetIndex = drag.target ? Number(drag.target.dataset.paletteIndex) : -1;
    const valid = targetIndex >= 0 && !(drag.source === "custom" && drag.sourceIndex === targetIndex);
    if (valid) this.commitDrop(drag, targetIndex);
    this.finishDrag(drag, valid);
  }

  /** @param {MouseEvent} event */
  onClick(event) {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** @param {any} drag @param {PointerEvent} event */
  startDrag(drag, event) {
    drag.active = true;
    this.root.querySelectorAll("mc-color[data-palette-target]").forEach((well) => {
      if (
        well instanceof HTMLElement &&
        (drag.source !== "custom" || well.dataset.paletteIndex !== String(drag.sourceIndex))
      ) {
        well.setAttribute("drop-eligible", "");
      }
    });
    const ghost = document.createElement("div");
    ghost.style.cssText = `position:fixed; z-index:10; width:2.5rem; height:2.5rem; border:1px solid #8b7144; border-radius:.125rem; pointer-events:none; background:${drag.source === "water" ? "#d9f2ff" : drag.color}; opacity:0; transform:translate(-50%, -50%) scale(.85); transition:opacity 120ms ease, transform 120ms ease, left 160ms ease, top 160ms ease;`;
    document.body.append(ghost);
    drag.ghost = ghost;
    this.updateDrag(drag, event);
    if (!this.prefersReducedMotion()) {
      requestAnimationFrame(() => {
        ghost.style.opacity = "0.9";
        ghost.style.transform = "translate(-50%, -50%) scale(1)";
      });
    } else ghost.style.opacity = "0.9";
  }

  /** @param {any} drag @param {PointerEvent} event */
  updateDrag(drag, event) {
    drag.ghost.style.left = `${event.clientX}px`;
    drag.ghost.style.top = `${event.clientY}px`;
    const target = this.root.elementFromPoint(event.clientX, event.clientY)
      ?.closest("mc-color[data-palette-target]") || null;
    if (target === drag.target) return;
    drag.target?.removeAttribute("drop-target");
    drag.target = target;
    target?.setAttribute("drop-target", "");
  }

  /** @param {any} drag @param {number} targetIndex */
  commitDrop(drag, targetIndex) {
    this.confirmedTarget = targetIndex;
    window.setTimeout(() => {
      this.confirmedTarget = null;
      if (this.isConnected) this.render();
    }, this.prefersReducedMotion() ? 0 : 300);
    const palette = this.palette();
    const customWells = palette.customWells.map((well, index) => {
      if (index !== targetIndex) return { ...well };
      return drag.source === "water" ? clearWell(well) : addColorToWell(well, drag.color);
    });
    const nextPalette = { baseAvailable: [...palette.baseAvailable], customWells };
    const selection = this.selection();
    /** @type {PaletteSelection} */
    let nextSelection = selection;
    if (selection.source === "custom" && selection.index === targetIndex) {
      nextSelection = customWells[targetIndex].numberOfColors === 0
        ? { source: null, index: null, color: null }
        : { source: "custom", index: targetIndex, color: colorFromWell(customWells[targetIndex]) };
    }
    /** @type {PaletteStateChangedDetail} */
    const detail = { palette: nextPalette, selection: nextSelection };
    emit(this, "palette-state-changed", detail);
  }

  /** @param {any} drag @param {boolean} success */
  finishDrag(drag, success) {
    this.root.querySelectorAll("[drop-eligible], [drop-target]").forEach((well) => {
      well.removeAttribute("drop-eligible");
      well.removeAttribute("drop-target");
    });
    if (!drag.ghost) return;
    if (success || this.prefersReducedMotion()) drag.ghost.style.opacity = "0";
    else {
      const sourceBounds = drag.element.getBoundingClientRect();
      drag.ghost.style.left = `${sourceBounds.left + sourceBounds.width / 2}px`;
      drag.ghost.style.top = `${sourceBounds.top + sourceBounds.height / 2}px`;
    }
    window.setTimeout(() => drag.ghost.remove(), this.prefersReducedMotion() ? 0 : 160);
  }

  prefersReducedMotion() {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  render() {
    const palette = this.palette();
    const selection = this.selection();
    const available = palette.baseAvailable || [];

    this.root.replaceChildren();
    const style = document.createElement("style");
    style.textContent = `
      :host { display: block; width: 100%; container-type: inline-size; }
      .palette { display: grid; gap: .5rem; }
      .rows { display: grid; gap: .5rem; min-width: 0; }
      .row { display: grid; gap: .25rem; width: max-content; }
      .base { grid-template-columns: repeat(6, 2.5rem); }
      .custom { grid-template-columns: repeat(6, 2.5rem); }
      .base mc-color, .custom mc-color {
        --well-size: 2.5rem;
        cursor: crosshair;
        touch-action: none;
        -webkit-user-select: none;
        user-select: none;
      }
      mc-color[drop-eligible] { animation: target-pulse 800ms ease-in-out infinite alternate; }
      mc-color[drop-target] { transform: scale(1.08); filter: brightness(1.12); }
      mc-color[drop-confirmed] { animation: drop-confirm 300ms ease-out; }
      @keyframes target-pulse { to { filter: brightness(1.08); } }
      @keyframes drop-confirm { 50% { transform: scale(1.12); filter: brightness(1.25); } }
      @media (prefers-reduced-motion: reduce) { mc-color[drop-eligible] { animation: none; } }
      @container (min-width: 23rem) {
        .base { grid-template-columns: repeat(8, 2.5rem); }
      }
    `;

    const paletteElement = document.createElement("div");
    paletteElement.className = "palette";
    const rows = document.createElement("div");
    rows.className = "rows";
    const baseRow = document.createElement("div");
    baseRow.className = "row base";
    BASE_COLORS.forEach((name, index) => {
      const well = document.createElement("mc-color");
      well.dataset.paletteSource = "base";
      well.dataset.paletteIndex = String(index);
      well.dataset.paletteColor = cssColor(name);
      well.setAttribute("role", "button");
      well.setAttribute("color", cssColor(name));
      well.setAttribute("aria-label", name);
      if (!available[index]) {
        well.setAttribute("disabled", "");
        well.setAttribute("aria-disabled", "true");
        well.tabIndex = -1;
      } else well.tabIndex = 0;
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
      well.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          well.click();
        }
      });
      baseRow.append(well);
    });
    rows.append(baseRow);

    const customRow = document.createElement("div");
    customRow.className = "row custom";
    palette.customWells.forEach((well, index) => {
      const customWell = document.createElement("mc-color");
      customWell.dataset.paletteTarget = "";
      customWell.dataset.paletteIndex = String(index);
      const empty = well.numberOfColors === 0;
      const color = colorFromWell(well);
      if (empty) customWell.setAttribute("empty", "");
      else {
        customWell.setAttribute("color", color);
        customWell.dataset.paletteSource = "custom";
        customWell.dataset.paletteColor = color;
        customWell.setAttribute("role", "button");
        customWell.tabIndex = 0;
      }
      customWell.setAttribute(
        "aria-label",
        empty ? `Custom color ${index + 1}, empty` : `Custom color ${index + 1}`,
      );
      if (selection.source === "custom" && selection.index === index) {
        customWell.setAttribute("selected", "");
      }
      if (this.confirmedTarget === index) customWell.setAttribute("drop-confirmed", "");
      customWell.addEventListener("click", () => {
        if (empty) return;
        emit(this, "palette-color-selected", {
          source: "custom",
          index,
          color,
        });
      });
      customWell.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          customWell.click();
        }
      });
      customRow.append(customWell);
    });
    rows.append(customRow);

    paletteElement.append(rows);
    this.root.append(style, paletteElement);
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
    this.root = this.attachShadow({ mode: "open" });
    this.pixels = createPixels();
    /** @type {Int32Array[]} */
    this.undoStack = [];
    /** @type {Stroke | null} */
    this.stroke = null;
    /** @type {HTMLDivElement} */
    this.surface = /** @type {HTMLDivElement} */ (/** @type {unknown} */ (null));
    /** @type {HTMLCanvasElement} */
    this.baseCanvas = /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (null));
    /** @type {HTMLCanvasElement} */
    this.overlayCanvas = /** @type {HTMLCanvasElement} */ (/** @type {unknown} */ (null));
    /** @type {CanvasRenderingContext2D} */
    this.baseContext = /** @type {CanvasRenderingContext2D} */ (/** @type {unknown} */ (null));
    /** @type {CanvasRenderingContext2D} */
    this.overlayContext = /** @type {CanvasRenderingContext2D} */ (/** @type {unknown} */ (null));
    this.cellSize = 1;
    this.displaySize = CANVAS_WIDTH;
    this.drawScale = 1;
    this.previewAnchor = null;
    this.resizeScheduled = false;
    this.scheduleResize = this.scheduleResize.bind(this);
    this.preventSurfaceGesture = this.preventSurfaceGesture.bind(this);
    this.resizeObserver = new ResizeObserver(this.scheduleResize);
  }

  connectedCallback() {
    this.root.innerHTML = `
      <style>
        :host { display: block; width: 100%; }
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
    this.surface = /** @type {HTMLDivElement} */ (this.root.querySelector(".surface"));
    this.baseCanvas = /** @type {HTMLCanvasElement} */ (this.root.querySelector(".base"));
    this.overlayCanvas = /** @type {HTMLCanvasElement} */ (this.root.querySelector(".overlay"));
    this.baseContext = /** @type {CanvasRenderingContext2D} */ (this.baseCanvas.getContext("2d", { alpha: false }));
    this.overlayContext = /** @type {CanvasRenderingContext2D} */ (this.overlayCanvas.getContext("2d"));
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
    this.surface.addEventListener("touchstart", this.preventSurfaceGesture, {
      passive: false,
    });
    this.surface.addEventListener("touchmove", this.preventSurfaceGesture, {
      passive: false,
    });
    this.surface.addEventListener("gesturestart", this.preventSurfaceGesture, {
      passive: false,
    });
    this.surface.addEventListener("gesturechange", this.preventSurfaceGesture, {
      passive: false,
    });
    this.resizeObserver.observe(this);
    window.addEventListener("resize", this.scheduleResize);
    window.visualViewport?.addEventListener("resize", this.scheduleResize);
    document.addEventListener("fullscreenchange", this.scheduleResize);
    this.resize();
  }

  disconnectedCallback() {
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.scheduleResize);
    window.visualViewport?.removeEventListener("resize", this.scheduleResize);
    document.removeEventListener("fullscreenchange", this.scheduleResize);
  }

  /** @param {string} name @param {string | null} oldValue @param {string | null} newValue */
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

  /** @returns {BrushSize} */
  get brushSize() {
    const size = Number(this.getAttribute("brush-size"));
    return Number.isInteger(size) && size >= 1 && size <= 4
      ? /** @type {BrushSize} */ (size)
      : 1;
  }

  /** @returns {OpacityPercent} */
  get opacity() {
    const opacity = Number(this.getAttribute("opacity"));
    return [25, 50, 75, 100].includes(opacity)
      ? /** @type {OpacityPercent} */ (opacity)
      : 100;
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

  /** @param {Event} event */
  preventSurfaceGesture(event) {
    event.preventDefault();
  }

  scheduleResize() {
    if (this.resizeScheduled) return;
    this.resizeScheduled = true;
    requestAnimationFrame(() => {
      this.resizeScheduled = false;
      this.resize();
    });
  }

  resize() {
    if (!this.surface) return;
    const availableWidth = Math.max(
      0,
      this.getBoundingClientRect().width || CANVAS_WIDTH,
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

  /** @param {CanvasRenderingContext2D} context */
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

  /** @param {number} index @param {number} color */
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

  /** @param {PointerEvent} event */
  pointForEvent(event) {
    const rect = this.surface.getBoundingClientRect();
    const x = (event.clientX - rect.left) * this.displaySize / rect.width;
    const y = (event.clientY - rect.top) * this.displaySize / rect.height;
    return {
      x,
      y,
      inside: x >= 0 && y >= 0 && x < this.displaySize && y < this.displaySize,
    };
  }

  /** @param {PointerEvent} event @returns {{ point: { x: number, y: number, inside: boolean }, anchor: Cell }} */
  anchorForEvent(event) {
    const point = this.pointForEvent(event);
    return {
      point,
      anchor: brushAnchor(point.x, point.y, this.cellSize, this.brushSize),
    };
  }

  /** @param {PointerEvent} event */
  onPointerDown(event) {
    if (
      !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)
    ) return;
    const { point, anchor } = this.anchorForEvent(event);
    if (!point.inside) return;
    event.preventDefault();

    if (this.tool === "picker") {
      emit(this, "color-picked", {
        color: argbToHex(this.pixels[anchor.y * CANVAS_WIDTH + anchor.x] ?? 0),
      });
      this.previewAnchor = null;
      this.renderPreview();
      return;
    }
    if (!this.canPaint) return;

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
      color: this.erase ? OPAQUE_WHITE : /** @type {number} */ (this.paintColor),
      opacity: this.erase ? 100 : this.opacity,
    };
    this.paintAnchor(anchor);
    if (event.pointerType !== "touch") {
      this.previewAnchor = anchor;
      this.renderPreview();
    }
  }

  /** @param {PointerEvent} event */
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

  /** @param {PointerEvent} event */
  onPointerLeave(event) {
    if (this.stroke?.pointerId === event.pointerId) {
      this.stroke.lastAnchor = null;
    }
    this.previewAnchor = null;
    this.renderPreview();
  }

  /** @param {PointerEvent} event */
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

  /** @param {PointerEvent} event */
  onPointerCancel(event) {
    if (this.stroke?.pointerId === event.pointerId) this.finishStroke();
  }

  /** @param {Cell} anchor */
  paintAnchor(anchor) {
    const stroke = /** @type {Stroke} */ (this.stroke);
    const changes = applyStamp(
      this.pixels,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
      anchor,
      stroke.brushSize,
      stroke.color,
      stroke.opacity,
      stroke.seen,
    );
    if (changes.length === 0) return;
    stroke.changed = true;
    stroke.paintedCellCount += changes.length;
    for (const change of changes) {
      this.drawPixel(change.index, change.color);
      stroke.pendingCells.push([change.index, change.color]);
    }
    this.scheduleProgress();
  }

  scheduleProgress() {
    const stroke = /** @type {Stroke} */ (this.stroke);
    if (stroke.progressScheduled) return;
    stroke.progressScheduled = true;
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

export { defaultPaletteState };
