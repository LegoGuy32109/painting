// @ts-check

import { initSync } from "./sync.js?v=3";

const canvas = document.querySelector("paint-canvas");
const status = document.getElementById("sync-status");
if (!(canvas instanceof HTMLElement) || !status) {
  throw new Error("editor shell is incomplete");
}
const sync = initSync(canvas, (next) => {
  status.textContent = next.message;
  status.dataset.state = next.kind;
});

const dialog = /** @type {HTMLDialogElement} */ (
  document.getElementById("sign-dialog")
);
const form =
  /** @type {HTMLFormElement} */ (document.getElementById("sign-form"));
const title = /** @type {HTMLInputElement} */ (
  document.getElementById("painting-title")
);
const count =
  /** @type {HTMLElement} */ (document.getElementById("title-count"));
const dialogStatus = /** @type {HTMLElement} */ (
  document.getElementById("sign-status")
);
const confirm = /** @type {HTMLButtonElement} */ (
  document.getElementById("confirm-sign")
);

document.getElementById("sign-button")?.addEventListener("click", () => {
  dialogStatus.textContent = "";
  title.value = "";
  count.textContent = "0";
  dialog.showModal();
  title.focus();
});
document.getElementById("cancel-sign")?.addEventListener("click", () => {
  dialog.close();
});
title.addEventListener("input", () => {
  count.textContent = String([...title.value].length);
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = title.value.trim();
  if (!value) {
    title.focus();
    return;
  }
  confirm.disabled = true;
  title.disabled = true;
  dialogStatus.textContent = "Signing and saving…";
  const signed = await sync.sign(value);
  if (signed) {
    location.assign("/collection");
    return;
  }
  confirm.disabled = false;
  title.disabled = false;
  dialogStatus.textContent =
    "Could not sign yet. Check the save status and try again.";
  title.focus();
});

const draftDialog = /** @type {HTMLDialogElement} */ (
  document.getElementById("draft-dialog")
);
const draftStatus = /** @type {HTMLElement} */ (
  document.getElementById("draft-status")
);
window.addEventListener("draft-conflict", () => {
  draftStatus.textContent = "";
  draftDialog.showModal();
});

/** @param {"server" | "local"} choice */
async function recoverDraft(choice) {
  const buttons = [...draftDialog.querySelectorAll("button")];
  buttons.forEach((button) => button.disabled = true);
  draftStatus.textContent = choice === "server"
    ? "Restoring the saved draft…"
    : "Keeping and saving this device’s draft…";
  try {
    const recovered = await sync.resolveDraftConflict(choice);
    if (!recovered) throw new Error("recovery failed");
    draftDialog.close();
  } catch {
    draftStatus.textContent =
      "Could not recover while offline. Try again when connected.";
  } finally {
    buttons.forEach((button) => button.disabled = false);
  }
}

document.getElementById("restore-server-draft")?.addEventListener(
  "click",
  () => void recoverDraft("server"),
);
document.getElementById("restore-local-draft")?.addEventListener(
  "click",
  () => void recoverDraft("local"),
);
