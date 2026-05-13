PRAGMA foreign_keys = ON;

CREATE VIRTUAL TABLE IF NOT EXISTS asset_search_fts USING fts5(
  asset_id UNINDEXED,
  name,
  path,
  tags,
  description,
  originator,
  license,
  rights_flags,
  format,
  codec,
  source,
  source_kind,
  source_provider,
  status,
  dates,
  stats,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS asset_search_facets (
  asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  source_kind TEXT NOT NULL,
  source_provider TEXT NOT NULL,
  source_name TEXT NOT NULL,
  collection_names TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  availability TEXT NOT NULL,
  status TEXT NOT NULL,
  license TEXT,
  rights_flags TEXT NOT NULL DEFAULT '',
  format TEXT,
  codec TEXT,
  bit_depth INTEGER,
  byte_size INTEGER,
  duration_seconds REAL,
  sample_rate INTEGER,
  channels INTEGER,
  modified_at TEXT,
  indexed_at TEXT,
  imported_at TEXT,
  rating REAL,
  peak_dbfs REAL,
  rms_dbfs REAL,
  clipping_samples INTEGER,
  headroom_db REAL,
  waveform_cached INTEGER NOT NULL DEFAULT 0 CHECK (waveform_cached IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_asset_search_facets_source ON asset_search_facets(source_id);
CREATE INDEX IF NOT EXISTS idx_asset_search_facets_provider ON asset_search_facets(source_provider);
CREATE INDEX IF NOT EXISTS idx_asset_search_facets_format_codec ON asset_search_facets(format, codec);
CREATE INDEX IF NOT EXISTS idx_asset_search_facets_status ON asset_search_facets(availability, status);
CREATE INDEX IF NOT EXISTS idx_asset_search_facets_size ON asset_search_facets(byte_size);
CREATE INDEX IF NOT EXISTS idx_asset_search_facets_dates ON asset_search_facets(modified_at, indexed_at, imported_at);
CREATE INDEX IF NOT EXISTS idx_asset_search_facets_levels ON asset_search_facets(peak_dbfs, rms_dbfs, headroom_db);
