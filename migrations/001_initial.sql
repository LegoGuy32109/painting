-- The first production schema. Migration files are immutable once applied.

CREATE TABLE IF NOT EXISTS canvases (
  id                      TEXT PRIMARY KEY,
  owner_id                TEXT NOT NULL,
  title                   TEXT,
  pixels                  BLOB NOT NULL,
  created_at              INTEGER NOT NULL,
  last_stroke_at          INTEGER,
  client_reported_active  INTEGER NOT NULL DEFAULT 0,
  completed_at            INTEGER
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
