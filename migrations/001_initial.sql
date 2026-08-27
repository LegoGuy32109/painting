-- The first production schema. Migration files are immutable once applied.

CREATE TABLE IF NOT EXISTS canvases (
  id                      TEXT PRIMARY KEY,
  owner_id                TEXT NOT NULL,
  title                   TEXT,
  pixels                  BLOB NOT NULL,
  created_at              INTEGER NOT NULL,
  last_stroke_at          INTEGER,
  client_reported_active  INTEGER NOT NULL DEFAULT 0,
  completed_at            INTEGER,
  -- Phase 3.5: the signer's profiles.handle AT THE MOMENT OF SIGNING,
  -- copied here rather than joined live. This is deliberate snapshot
  -- semantics, matching the "author: string | null, include only for
  -- signed work" field in docs/joy-of-painting-interface-spec.md's Canvas
  -- record: a later handle rename must NOT retroactively change the
  -- author of an already-signed painting. Public (rendered on /collection
  -- and the display feed) — unlike owner_id, which stays private forever.
  -- Server-derived only: never accepted from a client request body (see
  -- validateCompletion in protocol.ts, which only reads `title`).
  author                  TEXT
);

CREATE INDEX IF NOT EXISTS canvases_active_idx
  ON canvases(client_reported_active, last_stroke_at DESC);

CREATE INDEX IF NOT EXISTS canvases_completed_idx
  ON canvases(completed_at DESC) WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS canvases_owner_completed_idx
  ON canvases(owner_id, completed_at DESC) WHERE completed_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS canvases_owner_draft_idx
  ON canvases(owner_id) WHERE completed_at IS NULL;

CREATE TABLE IF NOT EXISTS canvas_events (
  sequence    INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('stroke', 'undo')),
  stroke_id   TEXT,
  cells       BLOB,
  reverts_id  TEXT,
  client_ts   INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS canvas_events_canvas_idx
  ON canvas_events(canvas_id, sequence);

-- Phase 2: the identity model. A profile is the same opaque guest UUID
-- that has always been canvases.owner_id, promoted to a real row — an
-- "account" is simply a profile with at least one credential. Signing up
-- (Phase 3) only ever adds a credentials row; it never touches canvases or
-- migrates ownership, so a passkey bug can never corrupt canvas ownership.
-- profiles rows are created lazily, on a guest's first mutating request —
-- never on a page load — so a drive-by visitor who never paints stays
-- purely cookie-shaped with no database row at all.
CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  handle        TEXT UNIQUE,
  user_handle   BLOB NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  upgraded_at   INTEGER
);

CREATE TABLE IF NOT EXISTS credentials (
  credential_id   TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports      TEXT,
  aaguid          TEXT,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up       INTEGER NOT NULL DEFAULT 0,
  nickname        TEXT,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS credentials_profile_idx
  ON credentials(profile_id);

-- Unused until Phase 3 (registration/authentication ceremonies) — created
-- now so those phases don't each need their own schema change.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge   TEXT PRIMARY KEY,
  profile_id  TEXT,
  purpose     TEXT NOT NULL CHECK (purpose IN ('register', 'authenticate')),
  expires_at  INTEGER NOT NULL
);

-- Unused until Phase 5 (account transfer between devices) — created now
-- for the same reason.
CREATE TABLE IF NOT EXISTS transfer_codes (
  code            TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at      INTEGER NOT NULL,
  consumed_at     INTEGER,
  -- Per-code failed-attempt counter so a specific code can be invalidated
  -- after a small number of wrong/dead attempts against it (see
  -- docs/transfer-codes.md and POST /api/auth/transfer/consume in
  -- src/server/main.ts). This is a security control, not a performance
  -- guard, so it has to survive across server instances and restarts — an
  -- in-memory counter cannot guarantee that under Deno Deploy's
  -- multi-isolate model, unlike the purely perf-motivated per-process
  -- caches elsewhere in this codebase (ensuredCanvases/ensuredProfiles in
  -- main.ts).
  failed_attempts INTEGER NOT NULL DEFAULT 0
);
