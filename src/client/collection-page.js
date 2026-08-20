// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").CanvasLocalRecord} CanvasLocalRecord */
/** @typedef {import("../shared/paint-types.d.ts").GuestCanvasesResponse} GuestCanvasesResponse */
/** @typedef {import("../shared/paint-types.d.ts").PublicCanvas} PublicCanvas */

import {
  deleteCanvasLocal,
  listCachedCompleted,
  openLocalDb,
  upsertCanvasLocal,
} from "./local-db.js?v=3";
import {
  decodeBase64,
  decodePixels,
  drawPixels,
  paintingContext,
} from "../shared/pixel-render.js";

const grid =
  /** @type {HTMLElement} */ (document.getElementById("collection-grid"));
const status = /** @type {HTMLElement} */ (
  document.getElementById("collection-status")
);
const dialog = /** @type {HTMLDialogElement} */ (
  document.getElementById("delete-dialog")
);
const form = /** @type {HTMLFormElement} */ (
  document.getElementById("delete-form")
);
const deleteStatus = /** @type {HTMLElement} */ (
  document.getElementById("delete-status")
);
const deleteCopy = /** @type {HTMLElement} */ (
  document.getElementById("delete-copy")
);
const confirmDelete = /** @type {HTMLButtonElement} */ (
  document.getElementById("confirm-delete")
);
/** @type {string | null} */
let deletingId = null;
const db = await openLocalDb().catch(() => null);

/** @param {CanvasLocalRecord | PublicCanvas} canvas */
function card(canvas) {
  const article = document.createElement("article");
  article.className = "collection-card pixel-panel";
  article.dataset.canvasId = canvas.id;
  const canvasElement = document.createElement("canvas");
  const context = paintingContext(canvasElement);
  const pixels = typeof canvas.pixels === "string"
    ? decodePixels(canvas.pixels)
    : new Int32Array(
      canvas.pixels.buffer,
      canvas.pixels.byteOffset,
      canvas.pixels.byteLength / 4,
    );
  drawPixels(context, pixels);
  const title = document.createElement("h2");
  title.textContent = canvas.title || "Untitled";
  const date = document.createElement("p");
  date.textContent = canvas.completedAt
    ? `Signed ${new Date(canvas.completedAt).toLocaleDateString()}`
    : "Signed painting";
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => {
    deletingId = canvas.id;
    deleteStatus.textContent = "";
    deleteCopy.textContent = `“${
      canvas.title || "Untitled"
    }” and its replay will be removed forever.`;
    dialog.showModal();
  });
  article.append(canvasElement, title, date, remove);
  return article;
}

/** @param {Array<CanvasLocalRecord | PublicCanvas>} canvases */
function render(canvases) {
  if (canvases.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-collection pixel-panel";
    const text = document.createElement("p");
    text.textContent = "You have not signed a painting yet.";
    const link = document.createElement("a");
    link.className = "pixel-button";
    link.href = "/editor";
    link.textContent = "Paint your first one";
    empty.append(text, link);
    grid.replaceChildren(empty);
    return;
  }
  grid.replaceChildren(...canvases.map(card));
}

if (db) {
  const cached = await listCachedCompleted(db).catch(() => []);
  if (cached.length) {
    render(cached);
    status.textContent = "Showing paintings saved on this device";
  }
}

try {
  const response = await fetch("/api/me/canvases");
  if (!response.ok) throw new Error(`collection failed: ${response.status}`);
  const collection =
    /** @type {GuestCanvasesResponse} */ (await response.json());
  render(collection.completed);
  status.textContent = collection.completed.length
    ? `${collection.completed.length} signed painting${
      collection.completed.length === 1 ? "" : "s"
    }`
    : "Your collection is empty";
  if (db) {
    const serverIds = new Set(collection.completed.map((canvas) => canvas.id));
    const cached = await listCachedCompleted(db);
    await Promise.all([
      ...collection.completed.map((canvas) =>
        upsertCanvasLocal(db, {
          id: canvas.id,
          title: canvas.title,
          completedAt: canvas.completedAt,
          pixels: decodeBase64(canvas.pixels),
          createdAt: canvas.createdAt,
        })
      ),
      ...cached.filter((canvas) => !serverIds.has(canvas.id)).map((canvas) =>
        deleteCanvasLocal(db, canvas.id)
      ),
    ]);
  }
} catch {
  status.textContent = db
    ? "Offline; showing paintings saved on this device"
    : "Could not open your collection";
}

document.getElementById("cancel-delete")?.addEventListener("click", () => {
  deletingId = null;
  dialog.close();
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!deletingId) return;
  confirmDelete.disabled = true;
  deleteStatus.textContent = "Deleting…";
  const id = deletingId;
  try {
    const response = await fetch(`/api/me/canvases/${id}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`delete failed: ${response.status}`);
    if (db) await deleteCanvasLocal(db, id);
    grid.querySelector(`[data-canvas-id="${id}"]`)?.remove();
    if (!grid.querySelector(".collection-card")) render([]);
    dialog.close();
    status.textContent = "Painting deleted";
    deletingId = null;
  } catch {
    deleteStatus.textContent =
      "Could not delete this painting. Try again online.";
  } finally {
    confirmDelete.disabled = false;
  }
});
