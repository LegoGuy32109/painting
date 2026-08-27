// @ts-check
//
// PWA shell glue loaded on every real page: service worker registration
// and its "new version ready" affordance, requesting persistent storage
// after the first committed stroke, surfacing that outcome in the sync
// status line, and a restrained install-prompt affordance shown once,
// after the user has earned some goodwill by signing a painting.

/** @typedef {import("../shared/paint-types.d.ts").SyncStatus} SyncStatus */

const JUST_SIGNED_KEY = "paintingJustSigned";
const INSTALL_SETTLED_KEY = "installPromptSettled";
// Set the moment the install banner actually renders (not merely eligible)
// so collection-page.js's account-upgrade nudge can hold off for this same
// page load — see the ordering note in showInstallBanner() below.
const INSTALL_BANNER_SHOWN_KEY = "pwaInstallBannerShownThisLoad";
const PERSIST_REQUESTED_KEY = "storagePersistRequested";

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
    // Best-effort only; re-showing an affordance once more isn't harmful.
  }
}

// --- Service worker registration + update affordance -----------------------

/** @param {ServiceWorkerRegistration} registration */
function watchForUpdate(registration) {
  /** @param {ServiceWorker | null} worker */
  function trackInstalling(worker) {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // A worker that reaches "installed" while a controller already exists
      // is an UPDATE, not the first-ever install — the two look identical
      // apart from that check, and only the update case should prompt.
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        showUpdateBanner(worker);
      }
    });
  }
  trackInstalling(registration.installing);
  registration.addEventListener("updatefound", () => {
    trackInstalling(registration.installing);
  });
}

/** @param {ServiceWorker} waitingWorker */
function showUpdateBanner(waitingWorker) {
  const banner = createBanner(
    "A new version is ready.",
    "Reload",
    () => {
      waitingWorker.postMessage("SKIP_WAITING");
    },
  );
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    banner.remove();
    location.reload();
  });
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    // type: "module" is required because sw.js uses a static `import` for
    // sw-routing.js — registering it as a classic script would fail to
    // parse (import declarations are a syntax error outside a module).
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      type: "module",
    });
    watchForUpdate(registration);
  } catch {
    // The app still works fully online without a service worker; offline
    // support is a progressive enhancement, not a hard requirement.
  }
}

// --- Persistent storage -----------------------------------------------------

/** @type {boolean | null} null = not yet known */
let persistedGranted = null;

async function refreshPersistedState() {
  try {
    if (navigator.storage?.persisted) {
      persistedGranted = await navigator.storage.persisted();
    }
  } catch {
    persistedGranted = null;
  }
}

/**
 * `local_events` in IndexedDB is the sole copy of unsynced strokes, and
 * Safari can evict IndexedDB after about a week of inactivity for a site
 * that hasn't been installed. Requesting persistence right after the FIRST
 * committed stroke (rather than on page load) matters: Chrome grants this
 * based on engagement signals, and a cold-load request is likelier to be
 * silently denied than one following a real interaction.
 */
async function requestPersistedStorageOnce() {
  if (flagSet(PERSIST_REQUESTED_KEY)) {
    await refreshPersistedState();
    return;
  }
  setFlag(PERSIST_REQUESTED_KEY);
  try {
    if (navigator.storage?.persist) {
      persistedGranted = await navigator.storage.persist();
      return;
    }
  } catch {
    // Fall through to refreshPersistedState()'s own try/catch below.
  }
  await refreshPersistedState();
}

/**
 * Augments a sync status message with a persistence warning when there's
 * something at stake: unsynced local changes AND storage isn't persisted.
 * Reuses the existing SyncStatus shape rather than inventing new UI.
 * @param {SyncStatus} status
 * @returns {SyncStatus}
 */
export function describeSyncStatus(status) {
  const pendingKinds = new Set(["local", "offline", "retrying"]);
  if (persistedGranted !== false || !pendingKinds.has(status.kind)) {
    return status;
  }
  return {
    kind: status.kind,
    message:
      `${status.message} — browser storage isn't persisted; clearing site data could lose this`,
  };
}

// --- Install prompt ----------------------------------------------------------

/** @type {Event & { prompt?: () => Promise<void>, userChoice?: Promise<{ outcome: string }> } | null} */
let deferredInstallPrompt = null;

function isStandalone() {
  try {
    return matchMedia("(display-mode: standalone)").matches ||
      // @ts-expect-error — iOS-only, not in the DOM lib types.
      navigator.standalone === true;
  } catch {
    return false;
  }
}

function markInstallSettled() {
  setFlag(INSTALL_SETTLED_KEY);
}

/**
 * @param {string} message
 * @param {string} actionLabel
 * @param {() => void} onAction
 * @param {() => void} [onDismiss]
 */
function createBanner(message, actionLabel, onAction, onDismiss = markInstallSettled) {
  const banner = document.createElement("div");
  banner.setAttribute("role", "status");
  banner.style.cssText = [
    "position:fixed",
    "left:0",
    "right:0",
    "bottom:0",
    "z-index:1000",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "gap:0.75rem",
    "flex-wrap:wrap",
    "padding:0.75rem calc(1rem + env(safe-area-inset-right)) calc(0.75rem + env(safe-area-inset-bottom)) calc(1rem + env(safe-area-inset-left))",
    "background:var(--ui-panel,#48484c)",
    "color:var(--ui-text,#f9fffe)",
    "border-top:0.1875rem solid #000",
    "font-family:inherit",
    "font-size:0.85rem",
  ].join(";");

  const text = document.createElement("span");
  text.textContent = message;
  banner.append(text);

  const action = document.createElement("button");
  action.className = "pixel-button";
  action.textContent = actionLabel;
  action.addEventListener("click", () => {
    onAction();
    banner.remove();
  });
  banner.append(action);

  const dismiss = document.createElement("button");
  dismiss.className = "pixel-button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    onDismiss();
    banner.remove();
  });
  banner.append(dismiss);

  document.body.append(banner);
  return banner;
}

/**
 * Ordering with the /collection account-upgrade nudge (collection-page.js):
 * both are "asks" that can land on the same page view right after signing
 * a painting — the install banner is triggered by the same "just signed"
 * moment, the account nudge is a standing until-dismissed affordance for
 * any plain guest. Stacking two asks in the same breath, right after the
 * biggest emotional payoff of the whole flow, is worse than either alone,
 * so the install banner claims that moment: it sets
 * INSTALL_BANNER_SHOWN_KEY the instant it actually renders (not merely
 * when eligible), and collection-page.js checks that flag before deciding
 * whether to also render the upgrade nudge THIS page load. The account
 * nudge otherwise reappears on the guest's next visit, undismissed —
 * nothing is lost, only deferred by one page view. This is a soft,
 * best-effort ordering (beforeinstallprompt can fire asynchronously,
 * after collection-page.js's own top-level code already ran), not a hard
 * guarantee, which is the right amount of engineering for a cosmetic
 * first-impression nicety.
 */
function markInstallBannerShownThisLoad() {
  try {
    sessionStorage.setItem(INSTALL_BANNER_SHOWN_KEY, "1");
  } catch {
    // Best-effort only — see the ordering note above this function.
  }
}

function showInstallBanner() {
  if (flagSet(INSTALL_SETTLED_KEY)) return;
  const prompt = deferredInstallPrompt;
  if (prompt?.prompt) {
    markInstallBannerShownThisLoad();
    createBanner(
      "Enjoying it? You can install Joy of Painting as an app.",
      "Install",
      () => {
        markInstallSettled();
        void prompt.prompt?.();
      },
    );
    return;
  }
  if (!isStandalone() && isIos()) {
    markInstallBannerShownThisLoad();
    createBanner(
      "Add Joy of Painting to your home screen: tap Share, then " +
        "“Add to Home Screen”.",
      "Got it",
      markInstallSettled,
    );
  }
}

function isIos() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

// --- iOS install-jar hint ---------------------------------------------------
//
// On iOS, a home-screen web app gets its OWN cookie jar and storage,
// completely separate from Safari's — there is no API that bridges them.
// A guest who painted in a Safari tab and then installs the app lands in
// a brand-new, empty profile with no way to tell the two jars apart; from
// their point of view, their paintings just vanished. A transfer code
// generated in the Safari tab and entered here is the only way to carry
// that profile across (see docs/transfer-codes.md). This does not arise
// on Android/Chrome, where the installed PWA shares storage with the
// browser — easy to miss in testing for exactly that reason.
const IOS_TRANSFER_HINT_KEY = "iosTransferHintSettled";

/**
 * @typedef {{ isAccount: boolean }} MeShape
 * @typedef {{ draft: unknown, completed: unknown[] }} CanvasesShape
 */

/**
 * Shown at most once, only when ALL of: running standalone, on iOS, no
 * account, no draft, no completed paintings — i.e. this profile has
 * never painted anything, which on iOS is exactly as consistent with "I
 * just installed and my Safari work is stuck in the other jar" as it is
 * with "I am a genuinely brand new user." Either way, the hint costs a
 * guest nothing to dismiss, and is the ONLY way to recover from the
 * former case, so it errs toward showing it.
 */
async function maybeShowIosTransferHint() {
  if (!isStandalone() || !isIos()) return;
  if (flagSet(IOS_TRANSFER_HINT_KEY)) return;
  try {
    const [meRes, canvasesRes] = await Promise.all([
      fetch("/api/me"),
      fetch("/api/me/canvases"),
    ]);
    if (!meRes.ok || !canvasesRes.ok) return;
    const me = /** @type {MeShape} */ (await meRes.json());
    const canvases = /** @type {CanvasesShape} */ (await canvasesRes.json());
    if (me.isAccount || canvases.draft || canvases.completed.length > 0) {
      return;
    }
  } catch {
    return;
  }
  createBanner(
    "Painted in Safari before installing? That work lives in a separate " +
      "jar Safari can't share with this app — a transfer code from that " +
      "tab is the only way to bring it over.",
    "Enter code",
    () => {
      setFlag(IOS_TRANSFER_HINT_KEY);
      location.href = "/collection";
    },
    () => setFlag(IOS_TRANSFER_HINT_KEY),
  );
}

function wasPaintingJustSigned() {
  try {
    const flagged = sessionStorage.getItem(JUST_SIGNED_KEY) === "1";
    if (flagged) sessionStorage.removeItem(JUST_SIGNED_KEY);
    return flagged;
  } catch {
    return false;
  }
}

/** Call right before navigating away after a successful sign, so the next page can show the install affordance. */
export function markPaintingSigned() {
  try {
    sessionStorage.setItem(JUST_SIGNED_KEY, "1");
  } catch {
    // The install affordance is a nice-to-have; missing it once is fine.
  }
}

// Read (and consume) the "just signed" flag exactly once — beforeinstallprompt
// fires asynchronously, sometimes well after this module runs, so both
// checks below share this one value rather than each calling
// wasPaintingJustSigned() themselves and racing over who clears it first.
const justSignedThisLoad = wasPaintingJustSigned();

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  if (justSignedThisLoad) showInstallBanner();
});

window.addEventListener("appinstalled", markInstallSettled);

// --- Wire-up -----------------------------------------------------------------

void registerServiceWorker();
void refreshPersistedState();

let persistRequested = false;
window.addEventListener("stroke-committed", () => {
  if (persistRequested) return;
  persistRequested = true;
  void requestPersistedStorageOnce();
});

if (justSignedThisLoad && !isStandalone()) {
  // The beforeinstallprompt listener above already tries when that event
  // itself arrives; this call covers the iOS hint, which has no such event.
  showInstallBanner();
}

// Mutually exclusive with the install banner above by construction (that
// one only ever fires pre-install; this one only when already standalone
// on iOS), so there is no ordering/stacking concern between the two.
void maybeShowIosTransferHint();
