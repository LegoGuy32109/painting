// @ts-check
//
// Passkey registration and sign-in, vanilla and dependency-free (no
// @simplewebauthn/browser — AGENTS.md keeps src/client/ at zero client
// dependencies).

/** @typedef {import("../shared/paint-types.d.ts").RegisterOptionsResponse} RegisterOptionsResponse */
/** @typedef {import("../shared/paint-types.d.ts").RegisterVerifyResponse} RegisterVerifyResponse */
/** @typedef {import("../shared/paint-types.d.ts").RenameHandleResponse} RenameHandleResponse */
/** @typedef {import("../shared/paint-types.d.ts").ProfileSummaryResponse} ProfileSummaryResponse */
/** @typedef {import("../shared/paint-types.d.ts").LoginOptionsResponse} LoginOptionsResponse */
/** @typedef {import("../shared/paint-types.d.ts").LoginVerifyResponse} LoginVerifyResponse */
/** @typedef {import("../shared/paint-types.d.ts").MergeResponse} MergeResponse */
/** @typedef {import("../shared/paint-types.d.ts").LogoutResponse} LogoutResponse */
/** @typedef {import("../shared/paint-types.d.ts").TransferGenerateResponse} TransferGenerateResponse */
/** @typedef {import("../shared/paint-types.d.ts").TransferConsumeResponse} TransferConsumeResponse */

import { normalizeTransferCode } from "../shared/transfer-code.js";

const RP_ID_KEY = "webauthnRpId";
const USER_ID_KEY = "webauthnUserId";

/** @returns {boolean} */
export function isPasskeySupported() {
  return (
    typeof PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function"
  );
}

/** @returns {Promise<boolean>} whether this device can verify the user locally (Face/Touch ID, Windows Hello, ...) — purely informational, never gates the create() call. */
export async function hasPlatformAuthenticator() {
  try {
    if (
      typeof PublicKeyCredential === "undefined" ||
      typeof PublicKeyCredential
          .isUserVerifyingPlatformAuthenticatorAvailable !==
        "function"
    ) {
      return false;
    }
    return await PublicKeyCredential
      .isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** @param {string} value @returns {ArrayBuffer} */
function base64UrlToBuffer(value) {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = padded.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes.buffer;
}

/** @param {ArrayBuffer | Uint8Array} value @returns {string} */
function bufferToBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

/**
 * Prefers the native parser (Chrome 122+, Safari 18+); falls back to a
 * manual base64url decode for older browsers that support WebAuthn but
 * not yet the JSON convenience methods.
 * @param {PublicKeyCredentialCreationOptionsJSON} optionsJson
 * @returns {PublicKeyCredentialCreationOptions}
 */
function parseCreationOptions(optionsJson) {
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(optionsJson);
  }
  // Same rationale as encodeCredential()'s fallback: this path only runs
  // in browsers old enough to lack parseCreationOptionsFromJSON, and the
  // JSON wire types (plain `string` fields) are deliberately looser than
  // the exact literal-union DOM types this constructs, so the object is
  // built loosely and cast at the boundary rather than fighting each
  // field's type individually.
  return /** @type {PublicKeyCredentialCreationOptions} */ (
    /** @type {unknown} */ ({
      ...optionsJson,
      challenge: base64UrlToBuffer(optionsJson.challenge),
      user: {
        ...optionsJson.user,
        id: base64UrlToBuffer(optionsJson.user.id),
      },
      excludeCredentials: optionsJson.excludeCredentials?.map(
        (credential) => ({
          id: base64UrlToBuffer(credential.id),
          type: "public-key",
          transports: credential.transports,
        }),
      ),
    })
  );
}

/**
 * Prefers the native `credential.toJSON()` (same browser support as
 * `parseCreationOptionsFromJSON` above); falls back to a manual encode.
 * @param {PublicKeyCredential} credential
 * @returns {RegistrationResponseJSON}
 */
function encodeCredential(credential) {
  const withToJson =
    /** @type {{ toJSON?: () => RegistrationResponseJSON }} */ (
      /** @type {unknown} */ (credential)
    );
  if (typeof withToJson.toJSON === "function") {
    return withToJson.toJSON();
  }
  const response = /** @type {AuthenticatorAttestationResponse} */ (
    credential.response
  );
  // Older browsers that lack toJSON() (pre-2023) also lack the
  // getAuthenticatorData()/getPublicKeyAlgorithm() methods the current
  // AuthenticatorAttestationResponseJSON type wants; the server-side
  // verifier only needs clientDataJSON + attestationObject regardless, so
  // this fallback is cast rather than fought into exact structural shape.
  return /** @type {RegistrationResponseJSON} */ (/** @type {unknown} */ ({
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: response.getTransports?.(),
    },
  }));
}

/**
 * Maps a WebAuthn ceremony failure to a message worth showing a user.
 * `InvalidStateError` specifically means excludeCredentials matched — the
 * user tried to register a passkey their browser/device already has for
 * this account, which deserves its own message, not a generic failure.
 * @param {unknown} error
 * @returns {string}
 */
export function friendlyPasskeyError(error) {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
      return "Passkey creation was cancelled.";
    case "AbortError":
      return "Passkey creation timed out. Try again.";
    case "InvalidStateError":
      return "This passkey is already registered.";
    default:
      return "Could not create a passkey. Try again.";
  }
}

/**
 * @returns {Promise<{ ok: true, handle: string, backedUp: boolean } | { ok: false, message: string }>}
 */
export async function registerPasskey() {
  if (!isPasskeySupported()) {
    return { ok: false, message: "Passkeys aren't supported in this browser." };
  }

  const optionsRes = await fetch("/api/auth/register/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (optionsRes.status === 501) {
    return {
      ok: false,
      message: "Accounts are only available on the canonical domain.",
    };
  }
  if (!optionsRes.ok) {
    return { ok: false, message: "Could not start passkey registration." };
  }
  /** @type {RegisterOptionsResponse} */
  const { options } = await optionsRes.json();

  // Cache rpId and the (already-opaque, already-client-visible) user.id —
  // see signalCurrentUserDetails()/signalCredentialRemoved() below — for
  // reuse on a LATER page load, the same way sync.js persists
  // currentCanvasId. Never the profile id: user.id is 32 random bytes with
  // no relation to it.
  try {
    localStorage.setItem(RP_ID_KEY, options.rp.id ?? "");
    localStorage.setItem(USER_ID_KEY, options.user.id);
  } catch {
    // Non-fatal — only means a later rename can't also update the
    // password manager's copy of the name.
  }

  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: parseCreationOptions(options),
    });
  } catch (error) {
    return { ok: false, message: friendlyPasskeyError(error) };
  }
  if (!(credential instanceof PublicKeyCredential)) {
    return { ok: false, message: "Could not create a passkey. Try again." };
  }

  const verifyRes = await fetch("/api/auth/register/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: encodeCredential(credential) }),
  });
  if (!verifyRes.ok) {
    const text = await verifyRes.text().catch(() => "");
    return {
      ok: false,
      message: text || "Could not verify the new passkey.",
    };
  }
  /** @type {RegisterVerifyResponse} */
  const verified = await verifyRes.json();
  return { ok: true, handle: verified.handle, backedUp: verified.backedUp };
}

/**
 * @param {string} credentialId
 * @returns {Promise<{ ok: true } | { ok: false, message: string }>}
 */
export async function deleteCredential(credentialId) {
  const res = await fetch(
    `/api/auth/credentials/${encodeURIComponent(credentialId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, message: text || "Could not remove that passkey." };
  }
  await signalCredentialRemoved(credentialId);
  return { ok: true };
}

/**
 * Tells the browser this credential is gone, so it stops offering it in a
 * future sign-in sheet instead of lingering as a dead option. Chrome and
 * Safari support this; Firefox does not yet — feature-detected, and never
 * allowed to affect the outcome of the delete itself: the server-side
 * deletion (deleteCredential() above) has already committed by the time
 * this runs and always succeeds regardless of what happens here.
 *
 * The server's DELETE route itself is deliberately NOT gated on
 * WEBAUTHN_RP_ID/WEBAUTHN_ORIGINS being configured — deletion is a plain
 * database delete, not a WebAuthn ceremony, and a user must always be able
 * to remove a credential, including on a non-canonical origin. rpId here
 * is only ever populated (see RP_ID_KEY) from a PRIOR successful
 * registration's options response, so if it's missing — RP config was
 * never available on this origin, or localStorage was cleared — this
 * simply skips the signal rather than guessing at an RP ID.
 * @param {string} credentialId
 */
async function signalCredentialRemoved(credentialId) {
  try {
    const rpId = localStorage.getItem(RP_ID_KEY);
    const withSignal =
      /** @type {{ signalUnknownCredential?: (options: { rpId: string, credentialId: string }) => Promise<void> }} */ (
        /** @type {unknown} */ (PublicKeyCredential)
      );
    if (rpId && typeof withSignal.signalUnknownCredential === "function") {
      await withSignal.signalUnknownCredential({ rpId, credentialId });
    }
  } catch {
    // Best-effort only.
  }
}

/**
 * Renames the profile's handle, then — if this profile has a passkey —
 * tells the browser to update the name it shows in the sign-in sheet.
 * WebAuthn freezes user.name/displayName in the password manager at
 * registration time; without this, the OS sheet would keep showing the
 * ORIGINAL name forever after a rename, silently diverging from the DB.
 * @param {string} handle
 * @returns {Promise<{ ok: true, handle: string } | { ok: false, message: string }>}
 */
export async function renameHandle(handle) {
  const res = await fetch("/api/me/handle", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    const message = res.status === 409
      ? "That handle is already taken."
      : (await res.text().catch(() => "")) || "Could not rename.";
    return { ok: false, message };
  }
  /** @type {RenameHandleResponse} */
  const body = await res.json();
  await signalRenamed(body.handle);
  return { ok: true, handle: body.handle };
}

/** @param {string} handle */
async function signalRenamed(handle) {
  try {
    const rpId = localStorage.getItem(RP_ID_KEY);
    const userId = localStorage.getItem(USER_ID_KEY);
    const withSignal =
      /** @type {{ signalCurrentUserDetails?: (options: { rpId: string, userId: string, name: string, displayName: string }) => Promise<void> }} */ (
        /** @type {unknown} */ (PublicKeyCredential)
      );
    if (
      rpId && userId &&
      typeof withSignal.signalCurrentUserDetails === "function"
    ) {
      await withSignal.signalCurrentUserDetails({
        rpId,
        userId,
        name: handle,
        displayName: handle,
      });
    }
  } catch {
    // Best-effort only — the rename already committed server-side.
  }
}

/** @returns {Promise<ProfileSummaryResponse | null>} */
export async function fetchProfile() {
  const res = await fetch("/api/me");
  if (!res.ok) return null;
  return await res.json();
}

// --- Sign-in (Phase 4) --------------------------------------------------
//
// Discoverable-credential sign-in: no username field anywhere in this
// product, so the server never sends allowCredentials (see
// POST /api/auth/login/options) and the authenticator itself offers
// whichever resident credential(s) it holds for this RP.

/**
 * Prefers the native parser, same rationale as parseCreationOptions()
 * above.
 * @param {PublicKeyCredentialRequestOptionsJSON} optionsJson
 * @returns {PublicKeyCredentialRequestOptions}
 */
function parseRequestOptions(optionsJson) {
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(optionsJson);
  }
  return /** @type {PublicKeyCredentialRequestOptions} */ (
    /** @type {unknown} */ ({
      ...optionsJson,
      challenge: base64UrlToBuffer(optionsJson.challenge),
      allowCredentials: optionsJson.allowCredentials?.map((credential) => ({
        id: base64UrlToBuffer(credential.id),
        type: "public-key",
        transports: credential.transports,
      })),
    })
  );
}

/**
 * Prefers the native `credential.toJSON()`, same rationale as
 * encodeCredential() above.
 * @param {PublicKeyCredential} credential
 * @returns {AuthenticationResponseJSON}
 */
function encodeAssertion(credential) {
  const withToJson =
    /** @type {{ toJSON?: () => AuthenticationResponseJSON }} */ (
      /** @type {unknown} */ (credential)
    );
  if (typeof withToJson.toJSON === "function") {
    return withToJson.toJSON();
  }
  const response = /** @type {AuthenticatorAssertionResponse} */ (
    credential.response
  );
  return /** @type {AuthenticationResponseJSON} */ (/** @type {unknown} */ ({
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle
        ? bufferToBase64Url(response.userHandle)
        : undefined,
    },
  }));
}

/**
 * @returns {Promise<
 *   | { ok: true, merge: { pending: false }, handle: string }
 *   | { ok: true, merge: LoginVerifyResponse["merge"] & { pending: true } }
 *   | { ok: false, message: string }
 * >}
 */
export async function signInWithPasskey() {
  if (!isPasskeySupported()) {
    return { ok: false, message: "Passkeys aren't supported in this browser." };
  }

  const optionsRes = await fetch("/api/auth/login/options", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (optionsRes.status === 501) {
    return {
      ok: false,
      message: "Accounts are only available on the canonical domain.",
    };
  }
  if (!optionsRes.ok) {
    return { ok: false, message: "Could not start passkey sign-in." };
  }
  /** @type {LoginOptionsResponse} */
  const { options } = await optionsRes.json();

  let credential;
  try {
    credential = await navigator.credentials.get({
      publicKey: parseRequestOptions(options),
    });
  } catch (error) {
    return { ok: false, message: friendlyPasskeyError(error) };
  }
  if (!(credential instanceof PublicKeyCredential)) {
    return { ok: false, message: "Could not sign in with a passkey." };
  }

  const verifyRes = await fetch("/api/auth/login/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: encodeAssertion(credential) }),
  });
  if (!verifyRes.ok) {
    const text = await verifyRes.text().catch(() => "");
    return { ok: false, message: text || "Could not verify sign-in." };
  }
  /** @type {LoginVerifyResponse} */
  const verified = await verifyRes.json();
  if (verified.merge.pending) {
    return { ok: true, merge: verified.merge };
  }
  return {
    ok: true,
    merge: { pending: false },
    handle: /** @type {{ handle: string }} */ (verified).handle,
  };
}

/**
 * Resolves the merge dialog's decision — see collection-page.js. Returns
 * the account handle on success so the caller can refresh the account
 * panel without a second round trip.
 * @param {string} mergeToken
 * @param {"device" | "account"} keep
 * @returns {Promise<{ ok: true, handle: string } | { ok: false, message: string }>}
 */
export async function resolveMerge(mergeToken, keep) {
  const res = await fetch("/api/auth/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mergeToken, keep }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, message: text || "Could not complete sign-in." };
  }
  /** @type {MergeResponse} */
  const body = await res.json();
  return { ok: true, handle: body.handle };
}

/**
 * Signs out. The server always issues a fresh guest cookie in the same
 * response — guest is this app's ground state, never a cookie-less one —
 * so the caller can keep painting immediately.
 * @returns {Promise<boolean>}
 */
export async function logout() {
  const res = await fetch("/api/auth/logout", { method: "POST" });
  return res.ok;
}

// --- Transfer codes (Phase 5) --------------------------------------------

/**
 * @returns {Promise<{ ok: true, code: string, expiresAt: number } | { ok: false, message: string }>}
 */
export async function requestTransferCode() {
  const res = await fetch("/api/auth/transfer", { method: "POST" });
  if (res.status === 429) {
    return {
      ok: false,
      message: "Too many attempts — wait a bit and try again.",
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, message: text || "Could not generate a transfer code." };
  }
  /** @type {TransferGenerateResponse} */
  const body = await res.json();
  return { ok: true, code: body.code, expiresAt: body.expiresAt };
}

/**
 * Normalizes `rawCode` (case, hyphens, whitespace — see
 * normalizeTransferCode()) before sending it. The server's own error
 * message deliberately never distinguishes "no such code" from "wrong
 * code" — this function passes that message straight through rather
 * than trying to add its own more specific one.
 * @param {string} rawCode
 * @returns {Promise<
 *   | { ok: true, merge: { pending: false }, handle: string }
 *   | { ok: true, merge: TransferConsumeResponse["merge"] & { pending: true } }
 *   | { ok: false, message: string }
 * >}
 */
export async function submitTransferCode(rawCode) {
  const code = normalizeTransferCode(rawCode);
  if (!code) {
    return { ok: false, message: "That doesn't look like a transfer code." };
  }
  const res = await fetch("/api/auth/transfer/consume", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (res.status === 429) {
    return {
      ok: false,
      message: "Too many attempts — wait a bit and try again.",
    };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      message: text || "That code is invalid, expired, or already used.",
    };
  }
  /** @type {TransferConsumeResponse} */
  const verified = await res.json();
  if (verified.merge.pending) {
    return { ok: true, merge: verified.merge };
  }
  return {
    ok: true,
    merge: { pending: false },
    handle: /** @type {{ handle: string }} */ (verified).handle,
  };
}
