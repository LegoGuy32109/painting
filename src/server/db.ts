// @tursodatabase/serverless: pure fetch()-based, zero native dependencies —
// a better fit for Deno than @libsql/client (which pulls in platform-specific
// native binaries and Node-only deps we never use, since we always talk to
// Turso over plain HTTPS). Its /compat subpath exposes the same createClient
// API @libsql/client does, so nothing else in this file needs to change.
// It doesn't support BEGIN CONCURRENT yet, which is why ConcurrentTx below
// still talks to the Hrana pipeline endpoint directly with a hand-rolled
// fetch() call instead.
import {
  type Client,
  createClient,
  type InValue,
} from "@tursodatabase/serverless/compat";
import { ulid } from "../shared/ulid.js";
import { mintUniqueHandle } from "./handles.ts";
export type { Client };

/** @typedef {"stroke" | "undo"} EventKind */
export type EventKind = "stroke" | "undo";

export interface NewEvent {
  id: string;
  kind: EventKind;
  strokeId?: string | null;
  cells?: Uint8Array | null;
  revertsId?: string | null;
  clientTs: number;
}

export interface CanvasEventRow {
  sequence: number;
  id: string;
  canvasId: string;
  kind: EventKind;
  strokeId: string | null;
  cells: Uint8Array | null;
  revertsId: string | null;
  clientTs: number;
  receivedAt: number;
}

export interface CanvasSummary {
  id: string;
  ownerId: string;
  title: string | null;
  createdAt: number;
  lastStrokeAt: number | null;
  clientReportedActive: boolean;
  completedAt: number | null;
  /** The owner profile's CURRENT handle, joined from `profiles` at read time — null if the owner has no profile row (e.g. a reaped or otherwise orphaned owner_id). Not stored on `canvases`; see the LEFT JOIN in every query that selects it. */
  author: string | null;
}

export interface CanvasAccess {
  ownerId: string;
  completedAt: number | null;
}

export interface CanvasRecord extends CanvasSummary {
  pixels: Uint8Array;
}

/**
 * A transaction conflict from Turso's MVCC engine (BEGIN CONCURRENT). Confirmed
 * empirically: the losing side's COMMIT fails with a "Transaction error"
 * message (observed exact text: "cannot commit - no transaction is active");
 * the message text isn't documented as stable, so callers should match on the
 * "Transaction error" substring, not the full string.
 */
export class ConcurrencyConflictError extends Error {}

/**
 * Two distinct error shapes were observed empirically for a losing side of a
 * BEGIN CONCURRENT row conflict: "Write-write conflict" (surfacing mid-
 * transaction, at the statement that touched the contended row) and
 * "Transaction error: cannot commit - no transaction is active" (surfacing
 * at COMMIT, when the conflict was only detected there). Neither message is
 * documented as stable, so match loosely on "conflict" / "Transaction error"
 * rather than the full string.
 */
function isConflictMessage(message: string): boolean {
  return message.includes("conflict") || message.includes("Transaction error");
}

export function createDb(): Client {
  const url = Deno.env.get("TURSO_DB_URL");
  const authToken = Deno.env.get("TURSO_DB_TOKEN");
  if (!url || !authToken) {
    throw new Error("TURSO_DB_URL and TURSO_DB_TOKEN must be set");
  }
  return createClient({ url, authToken });
}

export interface ProfileRecord {
  id: string;
  handle: string | null;
  userHandle: Uint8Array;
  sessionEpoch: number;
  createdAt: number;
  lastSeenAt: number;
  upgradedAt: number | null;
}

/**
 * Creates the profile row on first use (any mutating route) and just
 * touches last_seen_at on every call after that. Deliberately NOT called
 * from any page route or read-only GET: a drive-by visitor who never
 * paints must stay purely cookie-shaped, with no database row at all. See
 * main.ts's mutating routes for every call site, and the Phase 2 notes in
 * migrations/001_initial.sql for why.
 *
 * A handle (see handles.ts) is minted on this FIRST creation, not deferred
 * to account upgrade — a guest who paints gets a real, renameable name
 * immediately, and upgrading to an account later changes nothing
 * user-visible about it. That name also becomes registration's user.name/
 * displayName (see main.ts's /api/auth/register/options), so the WebAuthn
 * prompt shows a name the user already recognizes rather than minting one
 * in the same breath as a biometric prompt.
 *
 * Checks for an existing row first rather than a blind upsert, because
 * minting a handle requires an uniqueness check (mintUniqueHandle against
 * isHandleTaken) that only needs to happen once per profile, not on every
 * mutation. The INSERT can still race a concurrent first mutation from the
 * same guest (two tabs); on a unique-constraint failure there, re-reading
 * the now-existing row is correct and safe — whichever tab's insert won,
 * the row is the same profile either way.
 */
export async function ensureProfile(
  db: Client,
  id: string,
  now: number,
): Promise<ProfileRecord> {
  const existing = await getProfile(db, id);
  if (existing) {
    await db.execute({
      sql: "UPDATE profiles SET last_seen_at = ? WHERE id = ?",
      args: [now, id],
    });
    return { ...existing, lastSeenAt: now };
  }

  const userHandle = crypto.getRandomValues(new Uint8Array(32));
  const handle = await mintUniqueHandle(
    id,
    (candidate) => isHandleTaken(db, candidate),
  );
  try {
    await db.execute({
      sql:
        "INSERT INTO profiles (id, handle, user_handle, created_at, last_seen_at) " +
        "VALUES (?, ?, ?, ?, ?)",
      args: [id, handle, userHandle, now, now],
    });
  } catch (error) {
    const raced = await getProfile(db, id);
    if (raced) return raced;
    throw error;
  }
  const created = await getProfile(db, id);
  if (!created) throw new Error("profile disappeared immediately after insert");
  return created;
}

/**
 * Renames an existing profile's handle. Available to guests and accounts
 * alike — a handle is not itself what makes a profile an account
 * (credentialCount > 0 is). Returns "conflict" on a UNIQUE violation
 * (someone already has that exact handle) rather than throwing, so the
 * caller can respond 409 instead of 500.
 */
export async function renameHandle(
  db: Client,
  profileId: string,
  handle: string,
): Promise<"ok" | "conflict"> {
  try {
    // A canvas's author is now derived at read time by joining
    // profiles.handle off canvases.owner_id (see e.g. getGuestDraft(),
    // listGuestCompleted() below) — there is nothing on canvases itself to
    // propagate. Renaming the profile's handle here is automatically
    // reflected the next time any of that profile's paintings are read,
    // signed or not, and can never touch another profile's paintings since
    // this UPDATE is scoped to a single profile id.
    await db.execute({
      sql: "UPDATE profiles SET handle = ? WHERE id = ?",
      args: [handle, profileId],
    });
    return "ok";
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed")
    ) {
      return "conflict";
    }
    throw error;
  }
}

/**
 * Marks the profile upgraded (has a passkey) exactly once — COALESCE means
 * a second, third, ... registration for the same profile leaves the
 * original upgraded_at untouched.
 */
export async function markProfileUpgraded(
  db: Client,
  profileId: string,
  now: number,
): Promise<void> {
  await db.execute({
    sql:
      "UPDATE profiles SET upgraded_at = COALESCE(upgraded_at, ?) WHERE id = ?",
    args: [now, profileId],
  });
}

export async function getProfile(
  db: Client,
  id: string,
): Promise<ProfileRecord | null> {
  const res = await db.execute({
    sql:
      "SELECT id, handle, user_handle, session_epoch, created_at, last_seen_at, upgraded_at " +
      "FROM profiles WHERE id = ?",
    args: [id],
  });
  return res.rows.length === 0 ? null : rowToProfile(res.rows[0]);
}

/**
 * An account is a profile with at least one credential — there is no
 * separate "is this an account" flag to keep in sync. Always 0 until
 * Phase 3 actually inserts into credentials.
 */
export async function countCredentials(
  db: Client,
  profileId: string,
): Promise<number> {
  const res = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM credentials WHERE profile_id = ?",
    args: [profileId],
  });
  return Number(res.rows[0].n);
}

/** For handles.ts's mintUniqueHandle() collision-retry loop (wired here for Phase 3's upgrade route). */
export async function isHandleTaken(
  db: Client,
  handle: string,
): Promise<boolean> {
  const res = await db.execute({
    sql: "SELECT 1 FROM profiles WHERE handle = ?",
    args: [handle],
  });
  return res.rows.length > 0;
}

// --- Credentials (passkeys) -------------------------------------------

export interface CredentialRecord {
  credentialId: string;
  profileId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  aaguid: string | null;
  backupEligible: boolean;
  backedUp: boolean;
  nickname: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface NewCredential {
  credentialId: string;
  profileId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  aaguid: string | null;
  backupEligible: boolean;
  backedUp: boolean;
  createdAt: number;
}

export async function insertCredential(
  db: Client,
  credential: NewCredential,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO credentials (credential_id, profile_id, public_key, counter, transports, " +
      "aaguid, backup_eligible, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      credential.credentialId,
      credential.profileId,
      credential.publicKey,
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      credential.aaguid,
      credential.backupEligible ? 1 : 0,
      credential.backedUp ? 1 : 0,
      credential.createdAt,
    ],
  });
}

export async function listCredentials(
  db: Client,
  profileId: string,
): Promise<CredentialRecord[]> {
  const res = await db.execute({
    sql:
      "SELECT credential_id, profile_id, public_key, counter, transports, aaguid, " +
      "backup_eligible, backed_up, nickname, created_at, last_used_at " +
      "FROM credentials WHERE profile_id = ? ORDER BY created_at ASC",
    args: [profileId],
  });
  return res.rows.map(rowToCredential);
}

/**
 * Deletes one credential, refusing to remove the LAST one for a profile —
 * that would silently demote an account back to an unreachable guest
 * (there is no other way in, by product design: no password, no email).
 * "not-found" covers both a genuinely unknown credential id and one that
 * belongs to a different profile — same response either way, so a caller
 * can't probe for other profiles' credential ids.
 */
export async function deleteCredential(
  db: Client,
  profileId: string,
  credentialId: string,
): Promise<"deleted" | "not-found" | "last-credential"> {
  const owned = await db.execute({
    sql: "SELECT 1 FROM credentials WHERE credential_id = ? AND profile_id = ?",
    args: [credentialId, profileId],
  });
  if (owned.rows.length === 0) return "not-found";
  const total = await countCredentials(db, profileId);
  if (total <= 1) return "last-credential";
  await db.execute({
    sql: "DELETE FROM credentials WHERE credential_id = ? AND profile_id = ?",
    args: [credentialId, profileId],
  });
  return "deleted";
}

// deno-lint-ignore no-explicit-any
function rowToCredential(row: any): CredentialRecord {
  return {
    credentialId: String(row.credential_id),
    profileId: String(row.profile_id),
    publicKey: row.public_key instanceof Uint8Array
      ? row.public_key
      : new Uint8Array(row.public_key),
    counter: Number(row.counter),
    transports: row.transports ? JSON.parse(row.transports) : null,
    aaguid: row.aaguid ?? null,
    backupEligible: Number(row.backup_eligible) === 1,
    backedUp: Number(row.backed_up) === 1,
    nickname: row.nickname ?? null,
    createdAt: Number(row.created_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  };
}

/**
 * Resolves a credential by its (globally unique, primary-key) credential_id
 * — the normal, fast path for sign-in: the authenticator returns the exact
 * credential id it used, no fallback lookup needed.
 */
export async function getCredentialById(
  db: Client,
  credentialId: string,
): Promise<CredentialRecord | null> {
  const res = await db.execute({
    sql:
      "SELECT credential_id, profile_id, public_key, counter, transports, aaguid, " +
      "backup_eligible, backed_up, nickname, created_at, last_used_at " +
      "FROM credentials WHERE credential_id = ?",
    args: [credentialId],
  });
  return res.rows.length === 0 ? null : rowToCredential(res.rows[0]);
}

/**
 * Fallback path for POST /api/auth/login/verify: if the credential_id from
 * the assertion isn't found (e.g. it was deleted from OUR db but the
 * platform authenticator still offered it), the response's userHandle —
 * the profile's 32 random opaque bytes, handed back by every discoverable
 * credential — resolves the profile directly. This is exactly what
 * userHandle is minted for; see main.ts's /api/auth/register/options.
 */
export async function getProfileByUserHandle(
  db: Client,
  userHandle: Uint8Array,
): Promise<ProfileRecord | null> {
  const res = await db.execute({
    sql:
      "SELECT id, handle, user_handle, session_epoch, created_at, last_seen_at, upgraded_at " +
      "FROM profiles WHERE user_handle = ?",
    args: [userHandle],
  });
  return res.rows.length === 0 ? null : rowToProfile(res.rows[0]);
}

/**
 * Persists what @simplewebauthn/server's verifyAuthenticationResponse()
 * reported after a successful sign-in: the authenticator's own counter
 * (stored as reported, never compared against our own clone-detection
 * logic — see the comment on this same tradeoff in main.ts's
 * /api/auth/register/verify) and last_used_at, for the credential list the
 * user sees in /collection.
 */
export async function recordCredentialUse(
  db: Client,
  credentialId: string,
  counter: number,
  now: number,
): Promise<void> {
  await db.execute({
    sql:
      "UPDATE credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?",
    args: [counter, now, credentialId],
  });
}

/**
 * Bumps a profile's session_epoch — the "sign out everywhere" primitive.
 * Every outstanding session cookie for this profile (this device's
 * current one included, unless it's reissued after the bump) carries the
 * OLD epoch baked into its signed payload (see guest-session.ts), so the
 * next mutating request under any of them fails the epoch check and is
 * rejected, forcing re-authentication. See main.ts for where that check
 * actually runs; there is no dedicated route calling this yet (see
 * Phase 4 notes) — it exists as a correct, ready-to-use mechanism.
 */
export async function bumpSessionEpoch(
  db: Client,
  profileId: string,
): Promise<void> {
  await db.execute({
    sql: "UPDATE profiles SET session_epoch = session_epoch + 1 WHERE id = ?",
    args: [profileId],
  });
}

/**
 * Performs the actual re-owning/discarding decided by main.ts's merge
 * logic (see POST /api/auth/login/verify's silent rows and POST
 * /api/auth/merge's dialog row), atomically:
 *   - every COMPLETED canvas owned by guestProfileId moves to
 *     accountProfileId unconditionally — completed work never conflicts,
 *     there is no constraint on it (canvases_owner_draft_idx only covers
 *     open drafts);
 *   - if discardDraftId is given, that (open, unsigned) draft is deleted
 *     outright;
 *   - if reownDraftId is given, that (open, unsigned) draft's owner_id is
 *     switched to accountProfileId.
 * Both draft params are optional and independent — a caller passes at
 * most one non-null per merge (the "losing" side is discarded, the
 * "winning" side, if it was the device's, is re-owned; if the winning
 * side was already the account's draft, neither is needed). Never called
 * with BOTH accountProfileId already owning an open draft AND
 * reownDraftId set to a DIFFERENT open draft — that would violate
 * canvases_owner_draft_idx and the UPDATE would fail; callers must
 * discard first (same batch, so this can't land half-applied).
 *
 * One batch (not BEGIN CONCURRENT — this is a rare, single-writer
 * operation, not the hot concurrent stroke-push path ConcurrentTx exists
 * for in this file) so a crash mid-merge can't leave two open drafts for
 * one owner, or a draft orphaned from an otherwise-completed re-own.
 */
export async function mergeProfiles(
  db: Client,
  params: {
    guestProfileId: string;
    accountProfileId: string;
    discardDraftId: string | null;
    reownDraftId: string | null;
  },
): Promise<void> {
  const statements: Array<{ sql: string; args: InValue[] }> = [
    {
      sql:
        "UPDATE canvases SET owner_id = ? WHERE owner_id = ? AND completed_at IS NOT NULL",
      args: [params.accountProfileId, params.guestProfileId],
    },
  ];
  if (params.discardDraftId) {
    // Same EXISTS guard, same reason, as deleteCompletedCanvas() above: the
    // events go first but only if the canvas delete below will actually
    // match, so a draft that was signed between the merge decision and this
    // write keeps its history instead of being silently gutted.
    statements.push({
      sql: "DELETE FROM canvas_events WHERE canvas_id = ? AND EXISTS (" +
        "SELECT 1 FROM canvases WHERE id = ? AND completed_at IS NULL)",
      args: [params.discardDraftId, params.discardDraftId],
    });
    statements.push({
      sql: "DELETE FROM canvases WHERE id = ? AND completed_at IS NULL",
      args: [params.discardDraftId],
    });
  }
  if (params.reownDraftId) {
    statements.push({
      sql:
        "UPDATE canvases SET owner_id = ? WHERE id = ? AND completed_at IS NULL",
      args: [params.accountProfileId, params.reownDraftId],
    });
  }
  await db.batch(statements, "write");
}

// --- Transfer codes (Phase 5) --------------------------------------------
//
// The one bootstrap/recovery primitive in a product with no email, no
// password, and no recovery flow — see docs/transfer-codes.md. Unlike a
// merge token (merge-token.ts), a transfer code is short enough to retype
// by hand, which means it cannot carry its own signed payload: it MUST be
// a database lookup, not a signed token.

export const TRANSFER_CODE_MAX_ATTEMPTS = 3;

export interface TransferCodeRecord {
  code: string;
  profileId: string;
  expiresAt: number;
  consumedAt: number | null;
  failedAttempts: number;
}

/**
 * Records a fresh code. Opportunistically sweeps dead rows first (expired
 * OR already consumed) — same reasoning as createChallenge()'s sweep — so
 * no cron is needed to keep this table from growing unbounded.
 */
export async function createTransferCode(
  db: Client,
  params: { code: string; profileId: string; now: number; ttlMs: number },
): Promise<void> {
  await db.execute({
    sql:
      "DELETE FROM transfer_codes WHERE expires_at < ? OR consumed_at IS NOT NULL",
    args: [params.now],
  });
  await db.execute({
    sql:
      "INSERT INTO transfer_codes (code, profile_id, expires_at) VALUES (?, ?, ?)",
    args: [params.code, params.profileId, params.now + params.ttlMs],
  });
}

/**
 * Consumes a code — single-use via one conditional UPDATE (code matches,
 * not already consumed, not expired, not already exhausted by failed
 * attempts), exactly the read-free pattern consumeChallenge() already
 * uses for WebAuthn challenges: two simultaneous requests for the same
 * code cannot both "win" a race, because only one UPDATE can ever affect
 * a row that a WHERE clause this specific still matches. Returns the
 * profile id on success, null on any failure (code unknown, expired,
 * already consumed, or already at TRANSFER_CODE_MAX_ATTEMPTS) — the
 * caller is responsible for not distinguishing those cases in what it
 * tells the requester (see main.ts).
 */
export async function consumeTransferCode(
  db: Client,
  code: string,
  now: number,
): Promise<string | null> {
  const result = await db.execute({
    sql: "UPDATE transfer_codes SET consumed_at = ? " +
      "WHERE code = ? AND consumed_at IS NULL AND expires_at >= ? AND failed_attempts < ?",
    args: [now, code, now, TRANSFER_CODE_MAX_ATTEMPTS],
  });
  if (result.rowsAffected !== 1) return null;
  const row = await db.execute({
    sql: "SELECT profile_id FROM transfer_codes WHERE code = ?",
    args: [code],
  });
  return row.rows.length === 0 ? null : String(row.rows[0].profile_id);
}

/**
 * Records a failed attempt against a SPECIFIC, already-submitted code
 * value (right-but-dead, or simply absent — a no-op if the code doesn't
 * exist at all, since there is no row to bound). This is a second,
 * independent layer under the IP-keyed rate limiter in rate-limit.ts:
 * that limiter bounds how fast any ONE IP can try DIFFERENT candidates,
 * while this bounds how many times ANY ONE candidate string can be tried
 * at all, regardless of how many different IPs it's tried from — see
 * docs/transfer-codes.md.
 */
export async function recordTransferCodeFailure(
  db: Client,
  code: string,
): Promise<void> {
  await db.execute({
    sql:
      "UPDATE transfer_codes SET failed_attempts = failed_attempts + 1 WHERE code = ?",
    args: [code],
  });
}

// --- WebAuthn challenges -------------------------------------------------
//
// Stored in the db (see migrations/001_initial.sql), not a cookie: a
// cookie-held challenge is replayable within its window and unbound to the
// requesting session. A db row can be made genuinely single-use (DELETE on
// consume) and bound to a specific profile.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type ChallengePurpose = "register" | "authenticate";

/**
 * Records a fresh challenge. Opportunistically sweeps expired rows first —
 * cheap (one indexed-by-primary-key-adjacent DELETE), and means no cron is
 * needed to keep the table from growing unbounded.
 */
export async function createChallenge(
  db: Client,
  params: {
    challenge: string;
    profileId: string | null;
    purpose: ChallengePurpose;
    now: number;
    ttlMs?: number;
  },
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM webauthn_challenges WHERE expires_at < ?",
    args: [params.now],
  });
  await db.execute({
    sql:
      "INSERT INTO webauthn_challenges (challenge, profile_id, purpose, expires_at) " +
      "VALUES (?, ?, ?, ?)",
    args: [
      params.challenge,
      params.profileId,
      params.purpose,
      params.now + (params.ttlMs ?? CHALLENGE_TTL_MS),
    ],
  });
}

/**
 * Consumes (deletes) a challenge if — and only if — it exists, matches the
 * expected purpose, hasn't expired, and (when profileId is given) was
 * issued to that exact profile. Any mismatch, including a replay of an
 * already-consumed challenge, returns false: single-use, TTL, and
 * profile-binding are all enforced by this one statement.
 */
export async function consumeChallenge(
  db: Client,
  params: {
    challenge: string;
    purpose: ChallengePurpose;
    profileId: string | null;
    now: number;
  },
): Promise<boolean> {
  const res = await db.execute({
    sql:
      "DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? " +
      "AND expires_at >= ? AND profile_id IS ?",
    args: [params.challenge, params.purpose, params.now, params.profileId],
  });
  return res.rowsAffected === 1;
}

// deno-lint-ignore no-explicit-any
function rowToProfile(row: any): ProfileRecord {
  return {
    id: String(row.id),
    handle: row.handle ?? null,
    userHandle: row.user_handle instanceof Uint8Array
      ? row.user_handle
      : new Uint8Array(row.user_handle),
    sessionEpoch: Number(row.session_epoch),
    createdAt: Number(row.created_at),
    lastSeenAt: Number(row.last_seen_at),
    upgradedAt: row.upgraded_at === null ? null : Number(row.upgraded_at),
  };
}

export async function createCanvas(
  db: Client,
  id: string,
  ownerId: string,
  pixels: Uint8Array,
  now: number,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT INTO canvases (id, owner_id, pixels, created_at, client_reported_active) VALUES (?, ?, ?, ?, 0)",
    args: [id, ownerId, pixels, now],
  });
}

/**
 * Lazily creates the canvas row on its first sync push, since the client
 * mints canvas ids locally (offline-first) and the server only learns a
 * canvas exists once a push arrives. Safe to call on every push — a no-op
 * once the row exists.
 */
export async function ensureCanvas(
  db: Client,
  id: string,
  ownerId: string,
  blankPixels: Uint8Array,
  now: number,
): Promise<void> {
  await db.execute({
    sql:
      "INSERT OR IGNORE INTO canvases (id, owner_id, pixels, created_at, client_reported_active) " +
      "VALUES (?, ?, ?, ?, 0)",
    args: [id, ownerId, blankPixels, now],
  });
}

const MAX_DRAFT_ID_ATTEMPTS = 5;

/**
 * Creates (or recovers) the caller's one open draft, preferring the client's
 * locally-known canvas id. `INSERT OR IGNORE` silently no-ops when a row
 * with `preferredId` already exists under a DIFFERENT owner — e.g. after
 * Defect 1 minted a fresh guest identity for a returning user whose
 * localStorage still names their old draft id. In that case, fall back to a
 * freshly generated id instead of throwing; the caller (PUT /api/me/draft)
 * already reports back whichever id was actually used.
 */
export async function getOrCreateDraft(
  db: Client,
  preferredId: string,
  ownerId: string,
  blankPixels: Uint8Array,
  now: number,
): Promise<CanvasRecord> {
  let candidateId = preferredId;
  for (let attempt = 0; attempt < MAX_DRAFT_ID_ATTEMPTS; attempt++) {
    await db.execute({
      sql:
        "INSERT OR IGNORE INTO canvases (id, owner_id, pixels, created_at, client_reported_active) " +
        "VALUES (?, ?, ?, ?, 0)",
      args: [candidateId, ownerId, blankPixels, now],
    });
    const draft = await getGuestDraft(db, ownerId);
    if (draft) return draft;
    // The insert was ignored: candidateId belongs to someone else, and this
    // owner has no other open draft. Try again with a fresh id.
    candidateId = ulid();
  }
  throw new Error("could not create or recover guest draft");
}

export async function getGuestDraft(
  db: Client,
  ownerId: string,
): Promise<CanvasRecord | null> {
  const result = await db.execute({
    sql:
      "SELECT c.id, c.owner_id, c.title, c.pixels, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.owner_id = ? AND c.completed_at IS NULL LIMIT 1",
    args: [ownerId],
  });
  return result.rows.length === 0 ? null : rowToRecord(result.rows[0]);
}

export async function listGuestCompleted(
  db: Client,
  ownerId: string,
  limit = 200,
): Promise<CanvasRecord[]> {
  const result = await db.execute({
    sql:
      "SELECT c.id, c.owner_id, c.title, c.pixels, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.owner_id = ? AND c.completed_at IS NOT NULL " +
      "ORDER BY c.completed_at DESC LIMIT ?",
    args: [ownerId, limit],
  });
  return result.rows.map(rowToRecord);
}

export async function listRandomCompleted(
  db: Client,
  limit: number,
): Promise<CanvasRecord[]> {
  const result = await db.execute({
    sql:
      "SELECT c.id, c.owner_id, c.title, c.pixels, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.completed_at IS NOT NULL ORDER BY RANDOM() LIMIT ?",
    args: [limit],
  });
  return result.rows.map(rowToRecord);
}

export async function getCompletedCanvas(
  db: Client,
  canvasId: string,
): Promise<CanvasRecord | null> {
  const result = await db.execute({
    sql:
      "SELECT c.id, c.owner_id, c.title, c.pixels, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.id = ? AND c.completed_at IS NOT NULL",
    args: [canvasId],
  });
  return result.rows.length === 0 ? null : rowToRecord(result.rows[0]);
}

// --- Deleting a canvas ----------------------------------------------------
//
// `canvas_events.canvas_id` declares REFERENCES canvases(id) ON DELETE
// CASCADE, but that cascade NEVER fires for a serving instance and must not
// be relied on. SQLite's foreign_keys pragma is off by default and is
// per-connection: migrations.ts turns it on for its own migration
// connection, which does nothing for the app's. We cannot simply turn it on
// in createDb() either — getDb() is synchronous and used from ~60 call
// sites, so a pragma issued there races the first query, and the
// fetch()-based Turso client may transparently re-establish its stream and
// silently drop the setting anyway.
//
// So every delete below removes the dependent canvas_events rows itself, in
// the SAME batch as the canvas row, and each dependent delete repeats the
// ownership/state predicate of the canvas delete via EXISTS. That guard is
// load-bearing: without it, a DELETE that matches no canvas (wrong owner, or
// already signed) would still wipe that canvas's event history — turning a
// rejected request into cross-owner data destruction.
//
// This was not theoretical: before this change, dev held 768 orphaned
// canvas_events rows against 14 live canvases.

export async function deleteCompletedCanvas(
  db: Client,
  canvasId: string,
  ownerId: string,
): Promise<boolean> {
  const results = await db.batch([
    {
      sql: "DELETE FROM canvas_events WHERE canvas_id = ? AND EXISTS (" +
        "SELECT 1 FROM canvases WHERE id = ? AND owner_id = ? AND completed_at IS NOT NULL)",
      args: [canvasId, canvasId, ownerId],
    },
    {
      sql:
        "DELETE FROM canvases WHERE id = ? AND owner_id = ? AND completed_at IS NOT NULL",
      args: [canvasId, ownerId],
    },
  ], "write");
  return results[1].rowsAffected === 1;
}

export async function deleteGuestDraft(
  db: Client,
  ownerId: string,
): Promise<boolean> {
  const results = await db.batch([
    {
      sql: "DELETE FROM canvas_events WHERE canvas_id IN (" +
        "SELECT id FROM canvases WHERE owner_id = ? AND completed_at IS NULL)",
      args: [ownerId],
    },
    {
      sql: "DELETE FROM canvases WHERE owner_id = ? AND completed_at IS NULL",
      args: [ownerId],
    },
  ], "write");
  return results[1].rowsAffected === 1;
}

/**
 * The single writer allowed to paint this canvas — enforced by the server on
 * every push (see main.ts's events POST handler) so a second device can't
 * paint over someone else's in-progress canvas. Anonymous per-device id
 * today, same as owner_id everywhere else in this file.
 */
export async function getCanvasOwnerId(
  db: Client,
  canvasId: string,
): Promise<string | null> {
  const res = await db.execute({
    sql: "SELECT owner_id FROM canvases WHERE id = ?",
    args: [canvasId],
  });
  if (res.rows.length === 0) return null;
  return (res.rows[0].owner_id as string | null) ?? null;
}

export async function getCanvasAccess(
  db: Client,
  canvasId: string,
): Promise<CanvasAccess | null> {
  const res = await db.execute({
    sql: "SELECT owner_id, completed_at FROM canvases WHERE id = ?",
    args: [canvasId],
  });
  if (res.rows.length === 0) return null;
  return {
    ownerId: String(res.rows[0].owner_id),
    completedAt: res.rows[0].completed_at === null
      ? null
      : Number(res.rows[0].completed_at),
  };
}

export async function eventAcknowledgments(
  db: Client,
  canvasId: string,
  eventIds: string[],
): Promise<Array<{ id: string; sequence: number }>> {
  if (eventIds.length === 0) return [];
  const placeholders = eventIds.map(() => "?").join(", ");
  const res = await db.execute({
    sql:
      `SELECT id, sequence FROM canvas_events WHERE canvas_id = ? AND id IN (${placeholders})`,
    args: [canvasId, ...eventIds],
  });
  const byId = new Map(
    res.rows.map((row) => [String(row.id), Number(row.sequence)]),
  );
  return eventIds.flatMap((id) => {
    const sequence = byId.get(id);
    return sequence === undefined ? [] : [{ id, sequence }];
  });
}

export async function headSequence(
  db: Client,
  canvasId: string,
): Promise<number> {
  const res = await db.execute({
    sql:
      "SELECT COALESCE(MAX(sequence), 0) as head FROM canvas_events WHERE canvas_id = ?",
    args: [canvasId],
  });
  return Number(res.rows[0].head);
}

/**
 * There is no `author` to write here: it's derived at read time by joining
 * `profiles.handle` off `canvases.owner_id` (see e.g. getGuestDraft() below),
 * so a canvas's author always reflects the owning profile's CURRENT handle,
 * including handles changed after this canvas was signed.
 */
export async function completeCanvas(
  db: Client,
  canvasId: string,
  title: string,
  now: number,
): Promise<boolean> {
  const result = await db.execute({
    sql:
      "UPDATE canvases SET title = ?, completed_at = ?, client_reported_active = 0 " +
      "WHERE id = ? AND completed_at IS NULL",
    args: [title, now, canvasId],
  });
  return result.rowsAffected === 1;
}

export async function storeCanvasPixels(
  db: Client,
  canvasId: string,
  pixels: Uint8Array,
): Promise<void> {
  await db.execute({
    sql:
      "UPDATE canvases SET pixels = ? WHERE id = ? AND completed_at IS NOT NULL",
    args: [pixels, canvasId],
  });
}

/**
 * "Active" here is server-affirmed, not just the client's self-reported flag:
 * a crashed/closed client can leave client_reported_active=1 behind forever,
 * so this also requires a stroke within the last `staleAfterMs` (default
 * 120s) as the real backstop. The client's own idle timer never pushes a
 * network update on its own while there's nothing new to sync (see
 * IDLE_TIMEOUT_MS in src/shared/paint-engine.js) — a painter who's just
 * thinking between strokes, not gone, relies entirely on this window
 * staying generous enough to outlast normal pauses. A backgrounded painter
 * remains active so the same browser can open /dev/active; pagehide reports
 * inactive immediately, while this stroke-age window removes abandoned tabs.
 */
export async function listActiveCanvases(
  db: Client,
  now = Date.now(),
  staleAfterMs = 120_000,
): Promise<CanvasSummary[]> {
  const res = await db.execute({
    sql: "SELECT c.id, c.owner_id, c.title, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.client_reported_active = 1 AND c.last_stroke_at > ? " +
      "ORDER BY c.last_stroke_at DESC",
    args: [now - staleAfterMs],
  });
  return res.rows.map(rowToSummary);
}

export async function listRecentlyCompleted(
  db: Client,
  limit: number,
): Promise<CanvasSummary[]> {
  const res = await db.execute({
    sql: "SELECT c.id, c.owner_id, c.title, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.completed_at IS NOT NULL ORDER BY c.completed_at DESC LIMIT ?",
    args: [limit],
  });
  return res.rows.map(rowToSummary);
}

export interface CompletedCursor {
  completedAt: number;
  id: string;
}

/**
 * Pages signed paintings without scanning or returning the whole collection.
 * The id tie-breaker makes the keyset stable when several paintings are
 * signed during the same millisecond.
 */
export async function listCompletedPage(
  db: Client,
  limit: number,
  cursor: CompletedCursor | null = null,
): Promise<CanvasRecord[]> {
  const where = cursor
    ? "WHERE c.completed_at IS NOT NULL AND (c.completed_at < ? OR (c.completed_at = ? AND c.id < ?)) "
    : "WHERE c.completed_at IS NOT NULL ";
  const args = cursor
    ? [cursor.completedAt, cursor.completedAt, cursor.id, limit]
    : [limit];
  const res = await db.execute({
    sql:
      "SELECT c.id, c.owner_id, c.title, c.pixels, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      `${where}ORDER BY c.completed_at DESC, c.id DESC LIMIT ?`,
    args,
  });
  return res.rows.map(rowToRecord);
}

export async function listCompletedByOwnerPrefix(
  db: Client,
  ownerPrefix: string,
): Promise<CanvasRecord[]> {
  const res = await db.execute({
    sql:
      "SELECT c.id, c.owner_id, c.title, c.pixels, c.created_at, c.last_stroke_at, " +
      "c.client_reported_active, c.completed_at, p.handle AS author " +
      "FROM canvases c LEFT JOIN profiles p ON p.id = c.owner_id " +
      "WHERE c.completed_at IS NOT NULL AND c.owner_id LIKE ? ORDER BY c.completed_at DESC",
    args: [`${ownerPrefix}%`],
  });
  return res.rows.map(rowToRecord);
}

export async function globalHeadSequence(db: Client): Promise<number> {
  const res = await db.execute(
    "SELECT COALESCE(MAX(sequence), 0) AS head FROM canvas_events",
  );
  return Number(res.rows[0].head);
}

export async function pullGlobalEventsSince(
  db: Client,
  since: number,
  limit = 500,
): Promise<CanvasEventRow[]> {
  const res = await db.execute({
    sql:
      "SELECT sequence, id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at " +
      "FROM canvas_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
    args: [since, limit],
  });
  return res.rows.map(rowToEvent);
}

export async function pullEventsForCanvases(
  db: Client,
  canvasIds: string[],
): Promise<CanvasEventRow[]> {
  if (canvasIds.length === 0) return [];
  const placeholders = canvasIds.map(() => "?").join(", ");
  const res = await db.execute({
    sql:
      "SELECT sequence, id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at " +
      `FROM canvas_events WHERE canvas_id IN (${placeholders}) ORDER BY sequence ASC`,
    args: canvasIds,
  });
  return res.rows.map(rowToEvent);
}

export async function pullEventsSince(
  db: Client,
  canvasId: string,
  since: number,
): Promise<{ events: CanvasEventRow[]; headSequence: number }> {
  const res = await db.execute({
    sql:
      "SELECT sequence, id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at " +
      "FROM canvas_events WHERE canvas_id = ? AND sequence > ? ORDER BY sequence ASC",
    args: [canvasId, since],
  });
  const events = res.rows.map(rowToEvent);
  const head = await headSequence(db, canvasId);
  return { events, headSequence: head };
}

// deno-lint-ignore no-explicit-any
function rowToSummary(row: any): CanvasSummary {
  return {
    id: row.id,
    ownerId: String(row.owner_id),
    title: row.title ?? null,
    createdAt: Number(row.created_at),
    lastStrokeAt: row.last_stroke_at === null
      ? null
      : Number(row.last_stroke_at),
    clientReportedActive: Number(row.client_reported_active) === 1,
    completedAt: row.completed_at === null ? null : Number(row.completed_at),
    author: row.author ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function rowToRecord(row: any): CanvasRecord {
  return {
    ...rowToSummary(row),
    pixels: row.pixels instanceof Uint8Array
      ? row.pixels
      : new Uint8Array(row.pixels),
  };
}

// deno-lint-ignore no-explicit-any
function rowToEvent(row: any): CanvasEventRow {
  return {
    sequence: Number(row.sequence),
    id: row.id,
    canvasId: row.canvas_id,
    kind: row.kind,
    strokeId: row.stroke_id ?? null,
    cells: row.cells ?? null,
    revertsId: row.reverts_id ?? null,
    clientTs: Number(row.client_ts),
    receivedAt: Number(row.received_at),
  };
}

// --- Concurrent-write push path ---
//
// @libsql/client's execute()/batch()/transaction() only know "write" | "read"
// | "deferred" transaction modes and reject "BEGIN CONCURRENT" as invalid SQL
// when issued through them. BEGIN CONCURRENT only works over the raw hrana
// /v2/pipeline HTTP endpoint. This was verified empirically against a live
// tursodb database — see tests/db_test.ts.
//
// Every statement in the transaction (BEGIN, each INSERT, the heartbeat
// UPDATE, COMMIT) is sent as ONE batched pipeline request, not one HTTP
// round trip per statement — pipelining's whole point is bundling multiple
// statements into a single call. Measured against a real Turso cloud
// endpoint: 4 separate sequential round trips (begin/insert/update/commit)
// took ~400ms; the same transaction batched into one request took ~200ms,
// and the gap widens further with more statements per push. Splitting them
// was the actual cause of "the live view snaps once or twice then stalls" —
// a push this slow can never keep up with continuous painting, so the
// outbox backs up far behind what a client-side retry fix alone can cure.

interface PipelineResponse {
  baton: string | null;
  results: Array<
    { type: "ok"; response: unknown } | {
      type: "error";
      error: { message: string };
    }
  >;
}

class ConcurrentTx {
  #baseUrl: string;
  #token: string;

  constructor(dbUrl: string, authToken: string) {
    this.#baseUrl = dbUrl.replace(/^libsql:\/\//, "https://");
    this.#token = authToken;
  }

  /**
   * Runs BEGIN CONCURRENT, every statement, and COMMIT as one pipeline HTTP
   * request. Throws ConcurrencyConflictError if this transaction lost a row
   * conflict (surfacing on any statement, or at commit).
   */
  async runBatch(
    statements: Array<{ sql: string; args?: unknown[] }>,
  ): Promise<void> {
    const requests = [
      { type: "execute", stmt: { sql: "BEGIN CONCURRENT" } },
      ...statements.map((s) => ({
        type: "execute",
        stmt: { sql: s.sql, args: (s.args ?? []).map(toHranaArg) },
      })),
      { type: "execute", stmt: { sql: "COMMIT" } },
      { type: "close" },
    ];
    const res = await fetch(`${this.#baseUrl}/v2/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ baton: null, requests }),
    });

    // A non-2xx status, a connection reset mid-body, or a rate-limit page
    // can all land here as something other than the {results: [...]} shape
    // this code used to assume unconditionally — that crashed as a bare
    // "Cannot read properties of undefined (reading 'find')" with no way to
    // tell what actually went wrong. Read as text first so a malformed body
    // still gets surfaced with its real status and content.
    const rawBody = await res.text();
    let body: PipelineResponse;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new Error(
        `pipeline request failed: non-JSON response (status ${res.status}): ` +
          rawBody.slice(0, 500),
      );
    }
    if (!res.ok || !Array.isArray(body.results)) {
      throw new Error(
        `pipeline request failed (status ${res.status}): ` +
          rawBody.slice(0, 500),
      );
    }
    throwOnError(body);
  }
}

function toHranaArg(value: unknown) {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "number") {
    return { type: "integer", value: String(value) };
  }
  if (value instanceof Uint8Array) {
    return { type: "blob", base64: btoa(String.fromCharCode(...value)) };
  }
  return { type: "text", value: String(value) };
}

function throwOnError(result: PipelineResponse): void {
  const err = result.results.find((r) => r.type === "error");
  if (err && err.type === "error") {
    if (isConflictMessage(err.error.message)) {
      throw new ConcurrencyConflictError(err.error.message);
    }
    throw new Error(err.error.message);
  }
}

/** Exponential backoff with full jitter, capped at 500ms, for conflict retries. */
function conflictBackoffMs(attempt: number): number {
  const cap = 500;
  const exp = Math.min(cap, 20 * 2 ** attempt);
  return Math.random() * exp;
}

/**
 * Appends events for a single push (the sync handshake), inside a single
 * BEGIN CONCURRENT transaction, and updates the canvas heartbeat fields.
 * Retries automatically on a row-level conflict (another device pushed to
 * the same canvas at the same moment) — safe to retry because event ids are
 * client-generated ULIDs (INSERT OR IGNORE makes re-applying a retried push
 * a no-op).
 */
export async function appendEvents(
  dbUrl: string,
  authToken: string,
  canvasId: string,
  events: NewEvent[],
  heartbeatActive: boolean,
  now: number,
  maxAttempts = 8,
): Promise<void> {
  const statements = [
    ...events.map((event) => ({
      sql: "INSERT OR IGNORE INTO canvas_events " +
        "(id, canvas_id, kind, stroke_id, cells, reverts_id, client_ts, received_at) " +
        "SELECT ?, ?, ?, ?, ?, ?, ?, ? " +
        "WHERE EXISTS (SELECT 1 FROM canvases WHERE id = ? AND completed_at IS NULL)",
      args: [
        event.id,
        canvasId,
        event.kind,
        event.strokeId ?? null,
        event.cells ?? null,
        event.revertsId ?? null,
        event.clientTs,
        now,
        canvasId,
      ],
    })),
    {
      sql:
        "UPDATE canvases SET last_stroke_at = ?, client_reported_active = ? WHERE id = ? AND completed_at IS NULL",
      args: [now, heartbeatActive ? 1 : 0, canvasId],
    },
  ];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await new ConcurrentTx(dbUrl, authToken).runBatch(statements);
      return;
    } catch (e) {
      if (e instanceof ConcurrencyConflictError && attempt < maxAttempts - 1) {
        // Retrying with no delay lets many concurrent writers to the same
        // canvas collide again in lockstep — confirmed in practice: 20
        // concurrent pushes to one canvas exhausted all 5 immediate retries
        // for 2 of them. Jittered exponential backoff spreads retries out so
        // they stop colliding with each other on the way back in.
        await new Promise((resolve) =>
          setTimeout(resolve, conflictBackoffMs(attempt))
        );
        continue;
      }
      throw e;
    }
  }
}
