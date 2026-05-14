PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS asset_user_metadata (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS asset_user_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_id, tag)
);

CREATE TABLE IF NOT EXISTS asset_region_notes (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  start_seconds REAL NOT NULL,
  end_seconds REAL NOT NULL,
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (end_seconds > start_seconds)
);

CREATE INDEX IF NOT EXISTS idx_asset_user_tags_tag ON asset_user_tags(tag);
CREATE INDEX IF NOT EXISTS idx_asset_region_notes_asset ON asset_region_notes(asset_id, start_seconds);
