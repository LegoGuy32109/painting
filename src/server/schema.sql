-- Schema for the painting app's Turso (tursodb engine) database.
-- Applied by src/server/db.ts's migrate() on startup; safe to re-run (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS canvases (
  id                      TEXT PRIMARY KEY,              -- ULID
  owner_id                TEXT,                           -- anonymous per-device id today, real account id later
  title                   TEXT,                           -- set together with completed_at at sign time
  pixels                  BLOB NOT NULL,                  -- current snapshot, 1 byte/pixel palette index
  created_at              INTEGER NOT NULL,
  last_stroke_at          INTEGER,                        -- server-observed heartbeat, the real timeout backstop
  client_reported_active  INTEGER NOT NULL DEFAULT 0,     -- 0/1, unauthoritative client signal
  completed_at            INTEGER                         -- nullable, terminal ("signed")
);

CREATE INDEX IF NOT EXISTS canvases_active_idx
  ON canvases(client_reported_active, last_stroke_at DESC);

CREATE INDEX IF NOT EXISTS canvases_completed_idx
  ON canvases(completed_at DESC) WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS canvases_owner_completed_idx
  ON canvases(owner_id, completed_at DESC) WHERE completed_at IS NOT NULL;

-- One row per literal pixel-diff batch (a live-streamed chunk of a gesture,
-- flushed every ~400ms while painting, not one row per whole stroke). Every
-- 'stroke' row from the same gesture shares stroke_id; 'undo' rows exclude a
-- whole stroke_id from composition (never delete/mutate anything), which is
-- what keeps undo correct even when another device's diffs land in between.
CREATE TABLE IF NOT EXISTS canvas_events (
  sequence    INTEGER PRIMARY KEY AUTOINCREMENT,          -- authoritative order, server-assigned only
  id          TEXT NOT NULL UNIQUE,                        -- ULID, client-generated, the idempotency key for this row
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('stroke', 'undo', 'complete')),
  stroke_id   TEXT,                                        -- groups a gesture's diff rows; null for 'complete'
  cells       BLOB,                                        -- this row's own {index,color} diffs; null for undo/complete
  reverts_id  TEXT,                                        -- for kind='undo': the stroke_id it excludes
  client_ts   INTEGER NOT NULL,                             -- advisory only, never used for ordering
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS canvas_events_canvas_idx
  ON canvas_events(canvas_id, sequence);
