CREATE TABLE IF NOT EXISTS waveform_peak_files (
  cache_key TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  content_key TEXT NOT NULL,
  peak_version INTEGER NOT NULL,
  channel_mode TEXT NOT NULL,
  resolution INTEGER NOT NULL,
  peak_count INTEGER NOT NULL,
  channel_count INTEGER NOT NULL,
  duration_seconds REAL,
  sample_rate INTEGER,
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL,
  clipping_json TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_waveform_peak_files_asset
  ON waveform_peak_files(asset_id, content_key, channel_mode, resolution);

CREATE INDEX IF NOT EXISTS idx_waveform_peak_files_eviction
  ON waveform_peak_files(status, last_accessed_at);
