PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'cloud')),
  provider TEXT NOT NULL,
  display_name TEXT NOT NULL,
  root_uri TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'indexing', 'paused', 'offline', 'error', 'disabled')
  ),
  last_indexed_at TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (kind, provider, root_uri)
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  child_count INTEGER NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  indexed_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    indexed_status IN ('pending', 'indexing', 'indexed', 'missing', 'error')
  ),
  last_indexed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, path)
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  stable_key TEXT NOT NULL,
  provider_asset_id TEXT,
  path_or_url TEXT NOT NULL,
  preview_url TEXT,
  source_url TEXT,
  name TEXT NOT NULL,
  extension TEXT,
  format TEXT,
  duration_seconds REAL,
  sample_rate INTEGER,
  bit_depth INTEGER,
  channels INTEGER,
  byte_size INTEGER,
  modified_at TEXT,
  content_hash TEXT,
  license TEXT,
  attribution TEXT,
  originator TEXT,
  description TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  availability TEXT NOT NULL DEFAULT 'available' CHECK (
    availability IN (
      'available',
      'missing',
      'moved_candidate',
      'probe_failed',
      'unsupported',
      'offline',
      'download_required',
      'error'
    )
  ),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, stable_key)
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (asset_id, tag)
);

CREATE TABLE IF NOT EXISTS analysis (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('full', 'region')),
  processing_hash TEXT NOT NULL DEFAULT 'processing:none',
  region_start_seconds REAL NOT NULL DEFAULT 0,
  region_end_seconds REAL NOT NULL DEFAULT 0,
  peak_dbfs REAL,
  true_peak_dbtp REAL,
  rms_dbfs REAL,
  lufs_i REAL,
  lufs_short_term_max REAL,
  clipping_samples INTEGER NOT NULL DEFAULT 0,
  channel_count INTEGER,
  analyzer_version TEXT NOT NULL,
  analyzed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (scope = 'full' AND region_start_seconds = 0 AND region_end_seconds = 0) OR
    (scope = 'region' AND region_end_seconds > region_start_seconds)
  ),
  UNIQUE (
    asset_id,
    scope,
    processing_hash,
    region_start_seconds,
    region_end_seconds,
    analyzer_version
  )
);

CREATE TABLE IF NOT EXISTS waveform_peaks (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  content_key TEXT NOT NULL,
  resolution INTEGER NOT NULL,
  channel_count INTEGER NOT NULL,
  duration_seconds REAL,
  peak_count INTEGER NOT NULL,
  cache_key TEXT NOT NULL,
  peaks_json TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (asset_id, content_key, resolution, channel_count)
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (parent_id, name)
);

CREATE TABLE IF NOT EXISTS collection_items (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('asset', 'folder_ref', 'source_ref')),
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (item_kind = 'asset' AND asset_id IS NOT NULL AND source_id IS NULL AND folder_id IS NULL) OR
    (item_kind = 'folder_ref' AND asset_id IS NULL AND source_id IS NULL AND folder_id IS NOT NULL) OR
    (item_kind = 'source_ref' AND asset_id IS NULL AND source_id IS NOT NULL AND folder_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  activity_type TEXT NOT NULL,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  export_job_id TEXT REFERENCES export_jobs(id) ON DELETE SET NULL,
  query TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'info' CHECK (status IN ('info', 'success', 'warning', 'error')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  gain_db REAL NOT NULL DEFAULT 0,
  normalize_enabled INTEGER NOT NULL DEFAULT 0 CHECK (normalize_enabled IN (0, 1)),
  normalize_target_lufs REAL,
  limiter_enabled INTEGER NOT NULL DEFAULT 0 CHECK (limiter_enabled IN (0, 1)),
  eq_settings_json TEXT NOT NULL DEFAULT '{}',
  processing_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  source_query_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (
    status IN ('queued', 'analyzing', 'processing', 'exporting', 'complete', 'failed', 'cancelled')
  ),
  output_folder TEXT NOT NULL,
  filename_pattern TEXT NOT NULL,
  export_scope TEXT NOT NULL DEFAULT 'full' CHECK (export_scope IN ('full', 'region')),
  region_start_seconds REAL,
  region_end_seconds REAL,
  format TEXT NOT NULL CHECK (format IN ('wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a', 'mp4')),
  format_settings_json TEXT NOT NULL DEFAULT '{}',
  processing_json TEXT NOT NULL DEFAULT '{}',
  preserve_folder_structure INTEGER NOT NULL DEFAULT 0 CHECK (preserve_folder_structure IN (0, 1)),
  include_attribution_sidecar INTEGER NOT NULL DEFAULT 0 CHECK (include_attribution_sidecar IN (0, 1)),
  overwrite_mode TEXT NOT NULL DEFAULT 'skip' CHECK (overwrite_mode IN ('skip', 'replace', 'rename')),
  output_path TEXT,
  error_message TEXT,
  progress REAL NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS cache_entries (
  id TEXT PRIMARY KEY,
  cache_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (
    kind IN ('preview', 'waveform', 'analysis', 'cloud_preview', 'export_temp')
  ),
  asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sources_kind_provider ON sources(kind, provider);
CREATE INDEX IF NOT EXISTS idx_folders_source_parent ON folders(source_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_assets_source_folder ON assets(source_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
CREATE INDEX IF NOT EXISTS idx_assets_format ON assets(format);
CREATE INDEX IF NOT EXISTS idx_assets_license ON assets(license);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);
CREATE INDEX IF NOT EXISTS idx_analysis_asset ON analysis(asset_id, scope, processing_hash);
CREATE INDEX IF NOT EXISTS idx_waveform_asset ON waveform_peaks(asset_id, content_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_root_name ON collections(name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collections_child_name ON collections(parent_id, name) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_collections_parent ON collections(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_collection_items_collection ON collection_items(collection_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON export_jobs(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_cache_entries_eviction ON cache_entries(kind, pinned, last_accessed_at);
