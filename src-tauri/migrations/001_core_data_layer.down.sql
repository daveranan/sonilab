PRAGMA foreign_keys = OFF;

DROP INDEX IF EXISTS idx_cache_entries_eviction;
DROP INDEX IF EXISTS idx_export_jobs_status;
DROP INDEX IF EXISTS idx_activity_created;
DROP INDEX IF EXISTS idx_collection_items_collection;
DROP INDEX IF EXISTS idx_collections_parent;
DROP INDEX IF EXISTS idx_collections_child_name;
DROP INDEX IF EXISTS idx_collections_root_name;
DROP INDEX IF EXISTS idx_waveform_asset;
DROP INDEX IF EXISTS idx_analysis_asset;
DROP INDEX IF EXISTS idx_asset_tags_tag;
DROP INDEX IF EXISTS idx_assets_license;
DROP INDEX IF EXISTS idx_assets_format;
DROP INDEX IF EXISTS idx_assets_name;
DROP INDEX IF EXISTS idx_assets_source_folder;
DROP INDEX IF EXISTS idx_folders_source_parent;
DROP INDEX IF EXISTS idx_sources_kind_provider;

DROP TABLE IF EXISTS cache_entries;
DROP TABLE IF EXISTS export_jobs;
DROP TABLE IF EXISTS presets;
DROP TABLE IF EXISTS activity;
DROP TABLE IF EXISTS collection_items;
DROP TABLE IF EXISTS collections;
DROP TABLE IF EXISTS waveform_peaks;
DROP TABLE IF EXISTS analysis;
DROP TABLE IF EXISTS asset_tags;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS sources;

PRAGMA foreign_keys = ON;
