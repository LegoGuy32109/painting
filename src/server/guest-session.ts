import {
  fromBase64Url,
  hasKid,
  isPrimaryKid,
  primaryKid,
  signPayload,
  verifyPayload,
} from "./signing-keys.ts";

const COOKIE_NAME = "painting_guest";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

/** Tokens older than this are re-issued with a fresh issued-at on next use. */
const REISSUE_AFTER_MILLIS = 1000 * 60 * 60 * 24 * 30;

/** Small allowance for clock skew when validating an issued-at from the future. */
const FUTURE_SKEW_MILLIS = 1000 * 60 * 5;

const GUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KID_PATTERN = /^[a-z0-9]{1,16}$/;

// --- Legacy (pre-keyset) verification only ---------------------------------
//
// v1/v2 tokens were signed under a single flat secret (GUEST_SESSION_SECRET,
// with GUEST_SESSION_SECRET_PREVIOUS as a one-key rotation stopgap — see
// Phase 0). Phase 0.75 supersedes that scheme with signing-keys.ts's HKDF
// keyset for everything NEW, but existing guests are still carrying v1/v2
// cookies, so both env vars are kept ONLY as legacy verification inputs:
// nothing here ever signs with them again. Every v1/v2 token that verifies
// is unconditionally re-issued as v3 so guests migrate forward passively;
// once the 400-day cookie lifetime has fully turned over, these env vars
// and the functions below can be deleted.

let legacyPrimaryKeyPromise: Promise<CryptoKey | null> | null = null;
let legacyPreviousKeyPromise: Promise<CryptoKey | null> | null = null;

/**
 * The length requirement legacySecretBytes() enforces at runtime, exposed
 * as a pure check so callers that only have a candidate string (never the
 * live env var) — see scripts/env-check.ts — can validate shape without
 * duplicating the encoding logic.
 */
export function meetsLegacySecretLength(value: string): boolean {
  return new TextEncoder().encode(value).byteLength >= 32;
}

function legacySecretBytes(name: string): ArrayBuffer | null {
  const configured = Deno.env.get(name);
  if (!configured) return null;
  if (!meetsLegacySecretLength(configured)) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return new TextEncoder().encode(configured).buffer;
}

function importLegacyKey(secret: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function legacyPrimaryKey(): Promise<CryptoKey | null> {
  return legacyPrimaryKeyPromise ??= (async () => {
    const secret = legacySecretBytes("GUEST_SESSION_SECRET");
    return secret ? await importLegacyKey(secret) : null;
  })();
}

function legacyPreviousKey(): Promise<CryptoKey | null> {
  return legacyPreviousKeyPromise ??= (async () => {
    const secret = legacySecretBytes("GUEST_SESSION_SECRET_PREVIOUS");
    return secret ? await importLegacyKey(secret) : null;
  })();
}

async function verifyAgainstLegacyKey(
  key: CryptoKey,
  prefix: string,
  signature: Uint8Array,
): Promise<boolean> {
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature.buffer as ArrayBuffer,
    new TextEncoder().encode(prefix),
  );
}

// --- Token format ------------------------------------------------------

interface VerifiedToken {
  guestId: string;
  /**
   * The session_epoch this token was signed under (Phase 4). v1/v2/v3
   * tokens predate session_epoch entirely and carry none, so they're
   * treated as epoch 0 — the column's own DEFAULT, and therefore correct
   * for any profile whose epoch has never been bumped. If it HAS been
   * bumped since, a migrated-forward epoch-0 token will correctly fail
   * the epoch check on its next mutating request (see main.ts) and force
   * re-authentication — the safe, fail-closed direction, not a security
   * hole: we simply have no better information than "assume the column
   * default" for a token minted before the column had meaning.
   */
  epoch: number;
  /** True when the token should be re-issued (legacy, stale, future-dated, or a non-primary kid). */
  reissue: boolean;
}

async function verifyV1(parts: string[]): Promise<VerifiedToken | null> {
  const [version, guestId, signatureValue, extra] = parts;
  if (
    version !== "v1" || extra !== undefined || !GUEST_ID_PATTERN.test(guestId)
  ) return null;
  const signature = fromBase64Url(signatureValue);
  if (!signature) return null;
  const prefix = `v1.${guestId}`;
  const primary = await legacyPrimaryKey();
  if (primary && await verifyAgainstLegacyKey(primary, prefix, signature)) {
    return { guestId, epoch: 0, reissue: true };
  }
  const previous = await legacyPreviousKey();
  if (previous && await verifyAgainstLegacyKey(previous, prefix, signature)) {
    return { guestId, epoch: 0, reissue: true };
  }
  return null;
}

/**
 * Parses issuedAt syntactically only: non-numeric, non-safe-integer, or
 * negative values cannot have come from our own signer (signing always
 * writes Date.now()) and are rejected outright, regardless of signature.
 * Plausibility (not too far in the future) is judged separately by the
 * caller, because a signature-valid future timestamp — most likely from
 * clock skew between server instances — must still verify and simply be
 * treated as stale, not thrown away as a forgery.
 */
function parseIssuedAt(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const millis = Number(value);
  if (!Number.isSafeInteger(millis) || millis < 0) return null;
  return millis;
}

function isStale(issuedAt: number): boolean {
  const age = Date.now() - issuedAt;
  return age > REISSUE_AFTER_MILLIS || age < -FUTURE_SKEW_MILLIS;
}

async function verifyV2(parts: string[]): Promise<VerifiedToken | null> {
  const [version, issuedAtValue, guestId, signatureValue, extra] = parts;
  if (version !== "v2" || extra !== undefined) return null;
  if (!GUEST_ID_PATTERN.test(guestId)) return null;
  const issuedAt = parseIssuedAt(issuedAtValue);
  if (issuedAt === null) return null;
  const signature = fromBase64Url(signatureValue);
  if (!signature) return null;
  const prefix = `v2.${issuedAtValue}.${guestId}`;
  const primary = await legacyPrimaryKey();
  if (primary && await verifyAgainstLegacyKey(primary, prefix, signature)) {
    return { guestId, epoch: 0, reissue: true };
  }
  const previous = await legacyPreviousKey();
  if (previous && await verifyAgainstLegacyKey(previous, prefix, signature)) {
    return { guestId, epoch: 0, reissue: true };
  }
  return null;
}

/**
 * v3 predates session_epoch (Phase 4) — structurally identical to v4 minus
 * the epoch field. Kept only as a migration-forward source: every v3 token
 * verifies and is unconditionally re-issued as v4 with epoch 0 (see
 * VerifiedToken.epoch's doc comment for why 0 is the right, safe default),
 * the same way v1/v2 have always been migrated forward to whatever the
 * current format is. Nothing ever signs a NEW v3 token again.
 */
async function verifyV3(parts: string[]): Promise<VerifiedToken | null> {
  const [version, kid, issuedAtValue, guestId, signatureValue, extra] = parts;
  if (version !== "v3" || extra !== undefined) return null;
  if (!KID_PATTERN.test(kid) || !hasKid(kid)) return null;
  if (!GUEST_ID_PATTERN.test(guestId)) return null;
  const issuedAt = parseIssuedAt(issuedAtValue);
  if (issuedAt === null) return null;
  const prefix = `v3.${kid}.${issuedAtValue}.${guestId}`;
  const valid = await verifyPayload(
    "guest-session",
    prefix,
    kid,
    signatureValue,
  );
  if (!valid) return null;
  return { guestId, epoch: 0, reissue: true };
}

/**
 * Parses an embedded session_epoch syntactically only — same rules as
 * parseIssuedAt: signing always writes a non-negative safe integer, so
 * anything else cannot have come from our own signer.
 */
function parseEpoch(value: string): number | null {
  if (!/^[0-9]+$/.test(value)) return null;
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
  return epoch;
}

/**
 * Signs a fresh v4 token (issued now) under the current primary keyset
 * key, embedding `epoch` — the session_epoch this token is valid under.
 * Deliberately takes epoch as a parameter rather than reading it from the
 * database itself: this function runs on EVERY page load (via
 * guestSession() below), which must do ZERO database queries. A reissue
 * of an existing session carries its OLD epoch forward unchanged (see
 * guestSession()); only a route that already has a fresh ProfileRecord in
 * hand (registration, login, merge) passes the database's actual current
 * epoch. See main.ts for where a mismatch between a token's embedded
 * epoch and the database's current value is actually enforced — that
 * check runs only on mutating routes, which already touch the database.
 */
async function signGuestId(guestId: string, epoch: number): Promise<string> {
  const kid = primaryKid();
  const issuedAt = Date.now();
  const prefix = `v4.${kid}.${issuedAt}.${guestId}.${epoch}`;
  const signature = await signPayload("guest-session", prefix);
  return `${prefix}.${signature}`;
}

async function verifyV4(parts: string[]): Promise<VerifiedToken | null> {
  const [version, kid, issuedAtValue, guestId, epochValue, signatureValue, extra] =
    parts;
  if (version !== "v4" || extra !== undefined) return null;
  if (!KID_PATTERN.test(kid) || !hasKid(kid)) return null;
  if (!GUEST_ID_PATTERN.test(guestId)) return null;
  const issuedAt = parseIssuedAt(issuedAtValue);
  if (issuedAt === null) return null;
  const epoch = parseEpoch(epochValue);
  if (epoch === null) return null;
  const prefix = `v4.${kid}.${issuedAtValue}.${guestId}.${epochValue}`;
  const valid = await verifyPayload(
    "guest-session",
    prefix,
    kid,
    signatureValue,
  );
  if (!valid) return null;
  return { guestId, epoch, reissue: isStale(issuedAt) || !isPrimaryKid(kid) };
}

async function verifyToken(token: string): Promise<VerifiedToken | null> {
  const parts = token.split(".");
  if (parts[0] === "v1") return await verifyV1(parts);
  if (parts[0] === "v2") return await verifyV2(parts);
  if (parts[0] === "v3") return await verifyV3(parts);
  if (parts[0] === "v4") return await verifyV4(parts);
  return null;
}

function cookieValue(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return null;
}

export interface GuestSession {
  guestId: string;
  /** The session_epoch this session's cookie was signed under — see signGuestId()'s doc comment. */
  epoch: number;
  setCookie: string | null;
}

function cookieFor(req: Request, token: string): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}${secure}`;
}

export async function guestSession(
  req: Request,
  create: boolean,
): Promise<GuestSession | null> {
  const token = cookieValue(req);
  if (token) {
    const verified = await verifyToken(token);
    if (verified) {
      if (!verified.reissue) {
        return {
          guestId: verified.guestId,
          epoch: verified.epoch,
          setCookie: null,
        };
      }
      // Reissue carries the OLD epoch forward unchanged — no database
      // read here (see signGuestId()'s doc comment: page loads, which
      // drive most reissues, must do zero database queries).
      const nextToken = await signGuestId(verified.guestId, verified.epoch);
      return {
        guestId: verified.guestId,
        epoch: verified.epoch,
        setCookie: cookieFor(req, nextToken),
      };
    }
  }
  if (!create) return null;

  const guestId = crypto.randomUUID();
  const nextToken = await signGuestId(guestId, 0);
  return {
    guestId,
    epoch: 0,
    setCookie: cookieFor(req, nextToken),
  };
}

/**
 * Mints a session cookie for a SPECIFIC profile id and epoch, bypassing
 * the request's existing cookie entirely. The one legitimate use: a
 * successful sign-in or merge switching the device's cookie from its old
 * guest profile to the account profile it just authenticated as (see
 * main.ts's POST /api/auth/login/verify and POST /api/auth/merge) — both
 * of those routes already have a fresh ProfileRecord in hand, so passing
 * its real, current session_epoch here is correct and free (no extra
 * query).
 */
export async function issueSessionFor(
  req: Request,
  profileId: string,
  epoch: number,
): Promise<GuestSession> {
  const token = await signGuestId(profileId, epoch);
  return { guestId: profileId, epoch, setCookie: cookieFor(req, token) };
}

/**
 * True when a session's embedded epoch still matches the profile's
 * CURRENT database value. Callers (main.ts's mutating routes) only call
 * this where they already have a freshly-read ProfileRecord in hand for
 * an unrelated reason — see the module doc comment on signGuestId() for
 * why this can't also run on every page load.
 */
export function sessionEpochValid(
  session: GuestSession,
  currentEpoch: number,
): boolean {
  return session.epoch === currentEpoch;
}

export function withSessionCookie(
  response: Response,
  session: GuestSession,
): Response {
  if (!session.setCookie) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", session.setCookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
