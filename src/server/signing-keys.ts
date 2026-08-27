// The signing keyset backing every HMAC-authenticated artifact this server
// issues. Guest session cookies (guest-session.ts) are the only consumer
// today; WebAuthn challenges, merge tokens, and account-transfer codes
// (Phases 3-5) will be the others. All of them derive their actual signing
// key from the SAME root key material via HKDF, one non-extractable subkey
// per purpose, so that a token minted for one purpose is cryptographically
// incapable of verifying as another — see SIGNING_PURPOSES below.
//
// Env format (PAINTING_KEYS): an ordered, comma-separated keyset —
//     PAINTING_KEYS=k3:<base64url-32-random-bytes>,k2:<base64url-32-random-bytes>
// The FIRST entry is the primary: everything new is SIGNED under it. Every
// entry is tried when VERIFYING, so older keys keep working through a
// rotation (see docs/signing-key-rotation.md) until they're deliberately
// dropped from the list.
//
// See guest-session.ts for how the legacy (pre-keyset) GUEST_SESSION_SECRET
// / GUEST_SESSION_SECRET_PREVIOUS env vars are still consulted — but ONLY to
// verify old tokens, never to sign anything new. This module has nothing to
// do with those; it is the keyset going forward.

const KID_PATTERN = /^[a-z0-9]{1,16}$/;

/**
 * Every purpose this server signs tokens for, defined up front so a later
 * phase cannot invent an ad-hoc HKDF info string. Only "guest-session" is
 * used as of Phase 0.75.
 */
export const SIGNING_PURPOSES = [
  "guest-session",
  "merge-token",
  "webauthn-challenge",
  "transfer-code",
] as const;
export type SigningPurpose = typeof SIGNING_PURPOSES[number];

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return Uint8Array.from(
      atob(padded),
      (character) => character.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

export { base64Url, fromBase64Url };

export interface ParsedKeyset {
  primaryKid: string;
  keys: Map<string, Uint8Array>;
}

/**
 * Pure parsing/validation of a PAINTING_KEYS-shaped string — no env access
 * and no process-wide cache, so tests can exercise every rejection path
 * directly. Malformed entries, a bad key length, a duplicate kid, or an
 * empty keyset all throw; there is no fallback. See rawKeyset() below for
 * the cached, env-reading wrapper actually used at runtime.
 */
export function parsePaintingKeysEnv(raw: string | undefined): ParsedKeyset {
  if (!raw) {
    throw new Error(
      "PAINTING_KEYS must be set. Run `deno task env:fill` to add a " +
        "generated value to .env, or see .env.example for the expected " +
        "format.",
    );
  }
  const items = raw.split(",").map((item) => item.trim()).filter((item) =>
    item.length > 0
  );
  if (items.length === 0) {
    throw new Error("PAINTING_KEYS must contain at least one key");
  }

  const keys = new Map<string, Uint8Array>();
  let primaryKid: string | null = null;
  for (const item of items) {
    const separator = item.indexOf(":");
    if (separator === -1) {
      throw new Error(
        `PAINTING_KEYS: malformed entry "${item}" (expected <kid>:<base64url>)`,
      );
    }
    const kid = item.slice(0, separator);
    const encoded = item.slice(separator + 1);
    if (!KID_PATTERN.test(kid)) {
      throw new Error(
        `PAINTING_KEYS: invalid key id "${kid}" (expected /^[a-z0-9]{1,16}$/)`,
      );
    }
    if (keys.has(kid)) {
      throw new Error(`PAINTING_KEYS: duplicate key id "${kid}"`);
    }
    const bytes = fromBase64Url(encoded);
    if (!bytes || bytes.byteLength !== 32) {
      throw new Error(
        `PAINTING_KEYS: key for id "${kid}" must decode to exactly 32 bytes`,
      );
    }
    keys.set(kid, bytes);
    if (primaryKid === null) primaryKid = kid;
  }

  return { primaryKid: primaryKid as string, keys };
}

let rawKeysetCache: ParsedKeyset | null = null;
function rawKeyset(): ParsedKeyset {
  return rawKeysetCache ??= parsePaintingKeysEnv(Deno.env.get("PAINTING_KEYS"));
}

/**
 * Verifies PAINTING_KEYS configuration eagerly at boot. A missing, empty, or
 * malformed keyset must hard-fail loudly rather than let the server start
 * and fail unpredictably per-request.
 */
export function assertSigningKeysConfigured(): void {
  rawKeyset();
}

/** The kid new tokens are signed under. */
export function primaryKid(): string {
  return rawKeyset().primaryKid;
}

/** True when `kid` is the current primary — callers use this to decide whether to re-issue. */
export function isPrimaryKid(kid: string): boolean {
  return kid === primaryKid();
}

/** True when `kid` names a configured key (primary or otherwise). */
export function hasKid(kid: string): boolean {
  return rawKeyset().keys.has(kid);
}

// HKDF root keys (one raw import per kid) and derived per-purpose HMAC keys
// are each memoized — derivation is not free and both signing and verifying
// are hot paths (every request touches guest-session).
const rootKeyPromises = new Map<string, Promise<CryptoKey>>();
function rootKey(kid: string): Promise<CryptoKey> {
  let promise = rootKeyPromises.get(kid);
  if (!promise) {
    const bytes = rawKeyset().keys.get(kid);
    if (!bytes) throw new Error(`unknown signing key id "${kid}"`);
    promise = crypto.subtle.importKey(
      "raw",
      bytes.buffer as ArrayBuffer,
      "HKDF",
      false,
      ["deriveKey"],
    );
    rootKeyPromises.set(kid, promise);
  }
  return promise;
}

const derivedKeyPromises = new Map<string, Promise<CryptoKey>>();

/** Exported for tests to assert memoization (same CryptoKey instance for a repeated kid/purpose). */
export function derivedKey(
  kid: string,
  purpose: SigningPurpose,
): Promise<CryptoKey> {
  const cacheKey = `${kid}/${purpose}`;
  let promise = derivedKeyPromises.get(cacheKey);
  if (!promise) {
    promise = (async () => {
      const root = await rootKey(kid);
      return await crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode(`painting/v1/${purpose}`),
        },
        root,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    derivedKeyPromises.set(cacheKey, promise);
  }
  return promise;
}

/**
 * Signs `payload` under the PRIMARY key's `purpose` subkey. Returns just the
 * base64url signature — callers that embed a kid in their token format (see
 * guest-session.ts's v3) already know it's `primaryKid()` and compose the
 * full token themselves.
 */
export async function signPayload(
  purpose: SigningPurpose,
  payload: string,
): Promise<string> {
  const key = await derivedKey(primaryKid(), purpose);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return base64Url(new Uint8Array(signature));
}

/**
 * Verifies `signature` over `payload` under `kid`'s `purpose` subkey. An
 * unknown kid or malformed signature returns false rather than throwing —
 * from a caller's point of view that's indistinguishable from a bad
 * signature, which is exactly the point: nothing about "why" verification
 * failed should be observable.
 */
export async function verifyPayload(
  purpose: SigningPurpose,
  payload: string,
  kid: string,
  signature: string,
): Promise<boolean> {
  if (!hasKid(kid)) return false;
  const signatureBytes = fromBase64Url(signature);
  if (!signatureBytes) return false;
  const key = await derivedKey(kid, purpose);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.buffer as ArrayBuffer,
    new TextEncoder().encode(payload),
  );
}
