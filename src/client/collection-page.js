// @ts-check

/** @typedef {import("../shared/paint-types.d.ts").CanvasLocalRecord} CanvasLocalRecord */
/** @typedef {import("../shared/paint-types.d.ts").GuestCanvasesResponse} GuestCanvasesResponse */
/** @typedef {import("../shared/paint-types.d.ts").PublicCanvas} PublicCanvas */
/** @typedef {import("../shared/paint-types.d.ts").ProfileSummaryResponse} ProfileSummaryResponse */
/** @typedef {import("../shared/paint-types.d.ts").CredentialSummary} CredentialSummary */
/** @typedef {import("../shared/paint-types.d.ts").DraftMergeSummary} DraftMergeSummary */
/** @typedef {import("../shared/paint-types.d.ts").LoginVerifyPendingResponse} LoginVerifyPendingResponse */

import {
  deleteCanvasLocal,
  listCachedCompleted,
  openLocalDb,
  seedCanvasHistory,
  upsertCanvasLocal,
} from "./local-db.js";
import {
  decodeBase64,
  decodePixels,
  drawPixels,
  paintingContext,
} from "../shared/pixel-render.js";
import {
  deleteCredential as deletePasskey,
  fetchProfile,
  isPasskeySupported,
  logout,
  registerPasskey,
  renameHandle,
  requestTransferCode,
  resolveMerge,
  signInWithPasskey,
  submitTransferCode,
} from "./passkey.js";
import { formatTransferCodeForDisplay } from "../shared/transfer-code.js";

const UPGRADE_NUDGE_DISMISSED_KEY = "upgradeNudgeDismissed";
const accountPanel = /** @type {HTMLElement} */ (
  document.getElementById("account-panel")
);

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
const mergeDialog = /** @type {HTMLDialogElement} */ (
  document.getElementById("merge-dialog")
);
const mergeStatus = /** @type {HTMLElement} */ (
  document.getElementById("merge-status")
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
  // .textContent only — author is public text a handle-holder chose (or
  // was minted for them), rendered from the palette-restricted charset
  // validateHandleRename() enforces, but it's still never trusted as
  // markup.
  const author = document.createElement("p");
  if (canvas.author) author.textContent = `by ${canvas.author}`;
  const actions = document.createElement("div");
  actions.className = "card-actions";
  // A plain navigable link, not a fetch()+blob dance: the server already
  // sends `content-disposition: attachment` on this route (see
  // src/server/main.ts's /canvases/:id/jpaint handler), so the browser
  // downloads it as a file on click without any client-side JS needed.
  const download = document.createElement("a");
  download.className = "pixel-button";
  download.href = `/canvases/${canvas.id}/jpaint`;
  download.textContent = "Download .jpaint";
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
  actions.append(download, remove);
  article.append(canvasElement, title, date, author, actions);
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
          author: canvas.author,
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

// --- Account panel -----------------------------------------------------
//
// Never reads or renders a profile id or user_handle — ProfileSummaryResponse
// (see src/shared/paint-types.d.ts) doesn't carry either, by design.

/** @param {string} key @returns {boolean} */
function flagSet(key) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** @param {string} key */
function setFlag(key) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // Re-showing the nudge once more next visit isn't harmful.
  }
}

// --- Transfer codes (Phase 5) --------------------------------------------
//
// Generation is offered from BOTH the guest nudge and the account view —
// moving a profile to another device/browser is meaningful either way
// (see docs/transfer-codes.md: bootstrapping a second device, recovery
// when passkey sync isn't available, and the iOS install-jar trap, which
// is specifically a GUEST with no credentials at all). Consumption's
// entry field is scoped to the guest/signed-out view only, alongside
// "Sign in with a passkey" — per the same design, an already-signed-in
// account isn't the case this is built for.

let transferCountdownInterval = /** @type {ReturnType<typeof setInterval> | null} */ (
  null
);

function clearTransferCountdown() {
  if (transferCountdownInterval !== null) {
    clearInterval(transferCountdownInterval);
    transferCountdownInterval = null;
  }
}

/**
 * Large, clearly-legible, grouped-for-readability display of a freshly
 * generated code, with a live countdown to its expiry and a
 * copy-to-clipboard action — the code is short-lived and single-use, and
 * the display says so plainly rather than leaving that implicit.
 * @param {string} code @param {number} expiresAt @returns {HTMLElement}
 */
function renderTransferCodeDisplay(code, expiresAt) {
  clearTransferCountdown();
  const wrap = document.createElement("div");
  wrap.className = "transfer-code-display";
  const value = document.createElement("p");
  value.className = "transfer-code-value";
  value.textContent = formatTransferCodeForDisplay(code);
  const countdown = document.createElement("p");
  countdown.className = "transfer-code-countdown";
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.textContent = "Copy";
  copyButton.addEventListener("click", () => {
    navigator.clipboard?.writeText(code).then(() => {
      copyButton.textContent = "Copied!";
      setTimeout(() => {
        copyButton.textContent = "Copy";
      }, 2000);
    }).catch(() => {
      // Clipboard access can be denied; the code is still on-screen to
      // type by hand.
    });
  });
  function tick() {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      countdown.textContent = "Expired — generate a new one if you still need it.";
      clearTransferCountdown();
      return;
    }
    const minutes = Math.floor(remainingMs / 60_000);
    const seconds = Math.floor((remainingMs % 60_000) / 1000);
    countdown.textContent =
      `Single use — expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
  }
  tick();
  transferCountdownInterval = setInterval(tick, 1000);
  wrap.append(value, countdown, copyButton);
  return wrap;
}

/** @returns {HTMLElement} */
function renderTransferGenerateSection() {
  const section = document.createElement("div");
  section.className = "transfer-generate";
  const intro = document.createElement("p");
  intro.textContent =
    "Move this profile to another device or browser with a one-time code.";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Generate a transfer code";
  const status = document.createElement("p");
  status.className = "dialog-status";
  button.addEventListener("click", async () => {
    button.disabled = true;
    status.textContent = "";
    const result = await requestTransferCode();
    button.disabled = false;
    if (!result.ok) {
      status.textContent = result.message;
      return;
    }
    const display = renderTransferCodeDisplay(result.code, result.expiresAt);
    section.replaceChildren(intro, display);
  });
  section.append(intro, button, status);
  return section;
}

/** @returns {HTMLElement} */
function renderTransferConsumeSection() {
  const form = document.createElement("form");
  form.className = "transfer-consume-form";
  const label = document.createElement("label");
  const labelText = document.createElement("span");
  labelText.textContent = "Have a transfer code from another device?";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "ABCD-1234";
  input.maxLength = 9;
  label.append(labelText, input);
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "pixel-button";
  submit.textContent = "Use code";
  const status = document.createElement("p");
  status.className = "dialog-status";
  form.append(label, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    status.textContent = "";
    submit.disabled = true;
    const result = await submitTransferCode(input.value);
    submit.disabled = false;
    if (!result.ok) {
      status.textContent = result.message;
      return;
    }
    if (result.merge.pending) {
      const merged = await showMergeDialog(result.merge);
      if (merged) location.reload();
      return;
    }
    location.reload();
  });
  return form;
}

function renderGuestNudge() {
  clearTransferCountdown();
  if (flagSet(UPGRADE_NUDGE_DISMISSED_KEY)) {
    accountPanel.replaceChildren();
    accountPanel.hidden = true;
    return;
  }
  // Ordering with pwa.js's post-signing install banner — see the note by
  // showInstallBanner() there: if that banner claimed this exact page
  // load, hold the account nudge back for it and show it on the next
  // visit instead, so a fresh guest isn't asked two things in one breath
  // right after signing.
  let installBannerShownThisLoad = false;
  try {
    installBannerShownThisLoad =
      sessionStorage.getItem("pwaInstallBannerShownThisLoad") === "1";
  } catch {
    // Fall through — worst case both affordances show together.
  }
  if (installBannerShownThisLoad) {
    accountPanel.replaceChildren();
    accountPanel.hidden = true;
    return;
  }
  accountPanel.hidden = false;
  const nudge = document.createElement("div");
  nudge.className = "account-nudge";
  const text = document.createElement("p");
  text.textContent = "Accounts let your paintings follow you to other devices.";
  const actions = document.createElement("div");
  actions.className = "handle-row";
  const upgrade = document.createElement("button");
  upgrade.type = "button";
  upgrade.className = "pixel-button primary-action";
  upgrade.textContent = "Create an account";
  upgrade.disabled = !isPasskeySupported();
  upgrade.title = upgrade.disabled
    ? "Passkeys aren't supported in this browser."
    : "";
  upgrade.addEventListener("click", () => void handleUpgradeClick(upgrade));
  const signIn = document.createElement("button");
  signIn.type = "button";
  signIn.textContent = "Sign in with a passkey";
  signIn.disabled = !isPasskeySupported();
  signIn.title = signIn.disabled
    ? "Passkeys aren't supported in this browser."
    : "";
  signIn.addEventListener("click", () => void handleSignInClick(signIn));
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  dismiss.addEventListener("click", () => {
    setFlag(UPGRADE_NUDGE_DISMISSED_KEY);
    renderGuestNudge();
  });
  actions.append(upgrade, signIn, dismiss);
  nudge.append(text, actions);
  nudge.append(renderTransferGenerateSection(), renderTransferConsumeSection());
  accountPanel.replaceChildren(nudge);
}

/**
 * @param {DraftMergeSummary} draft
 * @returns {string}
 */
function mergeDraftMetaText(draft) {
  const strokes = `${draft.strokeCount} stroke${
    draft.strokeCount === 1 ? "" : "s"
  }`;
  const when = new Date(draft.lastActivityAt).toLocaleDateString();
  return `${strokes} · last touched ${when}`;
}

/** @param {string} elementId @param {DraftMergeSummary} draft */
function renderMergeDraft(elementId, draft) {
  const container = /** @type {HTMLElement} */ (
    document.getElementById(elementId)
  );
  const canvasElement = /** @type {HTMLCanvasElement} */ (
    container.querySelector("canvas")
  );
  const context = paintingContext(canvasElement);
  drawPixels(context, decodePixels(draft.pixels));
  const meta = /** @type {HTMLElement} */ (
    container.querySelector(".merge-draft-meta")
  );
  meta.textContent = mergeDraftMetaText(draft);
}

/**
 * Shows the merge dialog and resolves once the user has either backed out
 * (nothing touched, server or local — resolves false) or chosen a side
 * (merged, local cleanup done, account panel refreshed — resolves true).
 * See resolveMerge() in passkey.js and POST /api/auth/merge for why
 * backing out is completely free — the mergeToken is simply discarded
 * here, nothing to undo.
 * @param {LoginVerifyPendingResponse["merge"]} merge
 * @returns {Promise<boolean>}
 */
async function showMergeDialog(merge) {
  renderMergeDraft("merge-draft-device", merge.deviceDraft);
  renderMergeDraft("merge-draft-account", merge.accountDraft);
  mergeStatus.textContent = "";
  mergeDialog.showModal();

  return await new Promise((resolve) => {
    /** @param {"device" | "account"} keep */
    const chooseKeep = async (keep) => {
      keepDeviceButton.disabled = true;
      keepAccountButton.disabled = true;
      backOutButton.disabled = true;
      mergeStatus.textContent = "Signing in…";
      const result = await resolveMerge(merge.mergeToken, keep);
      if (!result.ok) {
        mergeStatus.textContent = result.message;
        keepDeviceButton.disabled = false;
        keepAccountButton.disabled = false;
        backOutButton.disabled = false;
        return;
      }
      await cleanUpAfterMerge(keep, merge.deviceDraft, merge.accountDraft);
      cleanup();
      mergeDialog.close();
      setFlag(UPGRADE_NUDGE_DISMISSED_KEY);
      resolve(true);
    };
    const onBackOut = () => {
      // Free by construction: the mergeToken is simply never sent again.
      // Nothing server-side or local has changed at any point up to now.
      cleanup();
      mergeDialog.close();
      resolve(false);
    };
    const keepDeviceButton = /** @type {HTMLButtonElement} */ (
      document.getElementById("merge-keep-device")
    );
    const keepAccountButton = /** @type {HTMLButtonElement} */ (
      document.getElementById("merge-keep-account")
    );
    const backOutButton = /** @type {HTMLButtonElement} */ (
      document.getElementById("merge-back-out")
    );
    const onKeepDevice = () => void chooseKeep("device");
    const onKeepAccount = () => void chooseKeep("account");
    function cleanup() {
      keepDeviceButton.removeEventListener("click", onKeepDevice);
      keepAccountButton.removeEventListener("click", onKeepAccount);
      backOutButton.removeEventListener("click", onBackOut);
      keepDeviceButton.disabled = false;
      keepAccountButton.disabled = false;
      backOutButton.disabled = false;
    }
    keepDeviceButton.addEventListener("click", onKeepDevice);
    keepAccountButton.addEventListener("click", onKeepAccount);
    backOutButton.addEventListener("click", onBackOut);
  });
}

/**
 * The local-side half of resolving a merge decision: purges the
 * discarded draft's outbox/snapshot/history (so sync.js's periodic flush
 * stops trying to push strokes for a canvas this profile no longer owns —
 * see local-db.js's deleteCanvasLocal()), repoints
 * localStorage.currentCanvasId at the kept draft, and — only when the
 * kept draft is the ACCOUNT's (this device has never painted on it
 * locally) — pulls its full history before the editor can open on it.
 * @param {"device" | "account"} keep
 * @param {DraftMergeSummary} deviceDraft
 * @param {DraftMergeSummary} accountDraft
 */
async function cleanUpAfterMerge(keep, deviceDraft, accountDraft) {
  const discardedId = keep === "device" ? accountDraft.id : deviceDraft.id;
  const keptId = keep === "device" ? deviceDraft.id : accountDraft.id;
  const db = await openLocalDb().catch(() => null);
  if (db) {
    await deleteCanvasLocal(db, discardedId).catch(() => {});
  }
  try {
    localStorage.setItem("currentCanvasId", keptId);
  } catch {
    // The next editor open will mint a fresh local id and hit the
    // existing draft_conflict recovery path instead — not silent data
    // loss, just a slightly slower reconciliation.
  }
  if (keep === "account" && db) {
    try {
      const res = await fetch(`/canvases/${keptId}/events?since=0`);
      if (res.ok) {
        const body = await res.json();
        await seedCanvasHistory(
          db,
          body.events.map(
            /** @param {{ sequence: number, id: string, kind: "stroke" | "undo", strokeId: string | null, cells: string | null, revertsId: string | null, clientTs: number, receivedAt: number }} event */
            (event) => ({
              canvasId: keptId,
              sequence: event.sequence,
              id: event.id,
              kind: event.kind,
              strokeId: event.strokeId,
              cells: event.cells ? decodeBase64(event.cells) : null,
              revertsId: event.revertsId,
              clientTs: event.clientTs,
              receivedAt: event.receivedAt,
            }),
          ),
        );
      }
    } catch {
      // Best-effort: sync.js's existing draft-conflict recovery (see
      // resolveDraftConflict() in sync.js) is the fallback the next time
      // the editor pushes against this canvas — not silent data loss,
      // just a cold local cache until then.
    }
  }
}

/** @param {HTMLButtonElement} button */
async function handleSignInClick(button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Signing in…";
  const result = await signInWithPasskey();
  if (!result.ok) {
    button.disabled = false;
    button.textContent = originalText;
    const message = document.createElement("p");
    message.textContent = result.message;
    accountPanel.append(message);
    return;
  }
  if (result.merge.pending) {
    button.disabled = false;
    button.textContent = originalText;
    // Reload either way once a decision is made — see chooseKeep()'s
    // local cleanup, which repoints currentCanvasId and warms the local
    // cache for whichever draft was kept; a full reload is the simplest
    // way to get the collection grid, account panel, and everything else
    // on this page consistent with the new profile in one step (back-out
    // resolves false and correctly does nothing).
    const merged = await showMergeDialog(result.merge);
    if (merged) location.reload();
    return;
  }
  setFlag(UPGRADE_NUDGE_DISMISSED_KEY);
  // A full reload — not just refreshAccountPanel() — because the
  // collection GRID (this profile's signed paintings) also needs to
  // reflect the account just signed into, and there is no standalone
  // "reload the grid" entrypoint to call instead.
  location.reload();
}

/** @param {HTMLButtonElement} button */
async function handleUpgradeClick(button) {
  button.disabled = true;
  const originalText = button.textContent;
  button.textContent = "Creating passkey…";
  const result = await registerPasskey();
  if (result.ok) {
    setFlag(UPGRADE_NUDGE_DISMISSED_KEY);
    await refreshAccountPanel();
    return;
  }
  button.disabled = false;
  button.textContent = originalText;
  const message = document.createElement("p");
  message.textContent = result.message;
  accountPanel.append(message);
}

/** @param {CredentialSummary} credential */
function credentialRow(credential) {
  const row = document.createElement("li");
  row.className = "credential-row";
  row.dataset.credentialId = credential.credentialId;
  const meta = document.createElement("div");
  meta.className = "credential-meta";
  const created = document.createElement("span");
  created.textContent = `Added ${
    new Date(credential.createdAt).toLocaleDateString()
  }`;
  const badge = document.createElement("span");
  badge.className = `credential-badge ${
    credential.backedUp ? "synced" : "device-bound"
  }`;
  badge.textContent = credential.backedUp ? "Synced" : "This device only";
  meta.append(created, badge);
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger-button";
  remove.textContent = "Remove";
  remove.addEventListener("click", () =>
    void handleRemoveCredential(
      credential.credentialId,
      row,
    ));
  row.append(meta, remove);
  return row;
}

/** @param {string} credentialId @param {HTMLElement} row */
async function handleRemoveCredential(credentialId, row) {
  const confirmed = confirm(
    "Remove this passkey? You'll need another way into this account if it's your last one.",
  );
  if (!confirmed) return;
  const result = await deletePasskey(credentialId);
  if (result.ok) {
    row.remove();
    await refreshAccountPanel();
    return;
  }
  alert(result.message);
}

/** @param {ProfileSummaryResponse} profile */
function renderAccountView(profile) {
  clearTransferCountdown();
  accountPanel.hidden = false;
  const heading = document.createElement("h2");
  heading.textContent = "Your account";

  const handleRow = document.createElement("div");
  handleRow.className = "handle-row";
  const handleText = document.createElement("p");
  handleText.textContent = profile.handle ?? "";
  const renameButton = document.createElement("button");
  renameButton.type = "button";
  renameButton.textContent = "Rename";
  renameButton.addEventListener("click", () => {
    renameForm.hidden = !renameForm.hidden;
  });
  handleRow.append(handleText, renameButton);

  const renameForm = document.createElement("form");
  renameForm.className = "handle-rename-form";
  renameForm.hidden = true;
  const renameInput = document.createElement("input");
  renameInput.type = "text";
  renameInput.value = profile.handle ?? "";
  renameInput.minLength = 3;
  renameInput.maxLength = 32;
  renameInput.required = true;
  const renameSubmit = document.createElement("button");
  renameSubmit.type = "submit";
  renameSubmit.className = "pixel-button";
  renameSubmit.textContent = "Save";
  const renameStatus = document.createElement("p");
  renameForm.append(renameInput, renameSubmit, renameStatus);
  renameForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    renameStatus.textContent = "";
    renameSubmit.disabled = true;
    const result = await renameHandle(renameInput.value);
    renameSubmit.disabled = false;
    if (result.ok) {
      renameForm.hidden = true;
      await refreshAccountPanel();
      return;
    }
    renameStatus.textContent = result.message;
  });

  const list = document.createElement("ul");
  list.className = "credential-list";
  list.append(...profile.credentials.map(credentialRow));

  const anyDeviceBound = profile.credentials.some((c) => !c.backedUp);
  const children =
    /** @type {HTMLElement[]} */ ([heading, handleRow, renameForm, list]);
  if (anyDeviceBound) {
    const warning = document.createElement("p");
    warning.className = "account-warning";
    warning.textContent = profile.credentials.length === 1
      ? "This passkey only lives on this device — losing it means losing " +
        "this account. Add a second passkey as a backup."
      : "At least one of your passkeys only lives on its device, with no " +
        "backup elsewhere.";
    children.push(warning);
  }

  const addAnother = document.createElement("button");
  addAnother.type = "button";
  addAnother.className = "pixel-button";
  addAnother.textContent = "Add another passkey";
  addAnother.disabled = !isPasskeySupported();
  addAnother.addEventListener(
    "click",
    () => void handleUpgradeClick(addAnother),
  );
  children.push(addAnother);

  const signOut = document.createElement("button");
  signOut.type = "button";
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", () => void handleSignOutClick());
  children.push(signOut);

  children.push(renderTransferGenerateSection());

  accountPanel.replaceChildren(...children);
}

async function handleSignOutClick() {
  await logout();
  // A fresh guest cookie is already set by the response — reloading is
  // the simplest way to get every already-rendered piece of this page
  // (the account panel, any cached collection state) consistent with the
  // new, signed-out session, rather than trying to reset each by hand.
  location.reload();
}

async function refreshAccountPanel() {
  const profile = await fetchProfile();
  if (!profile) {
    accountPanel.hidden = true;
    accountPanel.replaceChildren();
    return;
  }
  if (profile.isAccount) {
    renderAccountView(profile);
  } else {
    renderGuestNudge();
  }
}

void refreshAccountPanel();
