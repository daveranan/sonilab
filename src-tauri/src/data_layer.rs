use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::indexing::tagging::canonicalize_tag;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct DataRepository {
    connection: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SourceRecord {
    pub id: String,
    pub kind: String,
    pub provider: String,
    pub display_name: String,
    pub root_uri: String,
    pub status: String,
    pub settings_json: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SourceInput {
    pub id: Option<String>,
    pub kind: String,
    pub provider: String,
    pub display_name: String,
    pub root_uri: String,
    pub status: Option<String>,
    pub settings_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssetRecord {
    pub id: String,
    pub source_id: String,
    pub stable_key: String,
    pub path_or_url: String,
    pub name: String,
    pub availability: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetInput {
    pub id: Option<String>,
    pub source_id: String,
    pub folder_id: Option<String>,
    pub stable_key: String,
    pub provider_asset_id: Option<String>,
    pub path_or_url: String,
    pub preview_url: Option<String>,
    pub source_url: Option<String>,
    pub name: String,
    pub extension: Option<String>,
    pub format: Option<String>,
    pub duration_seconds: Option<f64>,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub byte_size: Option<i64>,
    pub modified_at: Option<String>,
    pub content_hash: Option<String>,
    pub license: Option<String>,
    pub attribution: Option<String>,
    pub originator: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub metadata_json: Option<String>,
    pub availability: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderRecord {
    pub id: String,
    pub source_id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub name: String,
    pub indexed_status: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FolderInput {
    pub id: Option<String>,
    pub source_id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub name: String,
    pub child_count: Option<i64>,
    pub asset_count: Option<i64>,
    pub indexed_status: Option<String>,
    pub last_indexed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionRecord {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub sort_order: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CollectionItemRecord {
    pub id: String,
    pub collection_id: String,
    pub item_kind: String,
    pub asset_id: Option<String>,
    pub source_id: Option<String>,
    pub folder_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityInput {
    pub id: Option<String>,
    pub activity_type: String,
    pub asset_id: Option<String>,
    pub source_id: Option<String>,
    pub folder_id: Option<String>,
    pub collection_id: Option<String>,
    pub export_job_id: Option<String>,
    pub query: Option<String>,
    pub message: String,
    pub status: Option<String>,
    pub payload_json: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityRecord {
    pub id: String,
    pub activity_type: String,
    pub asset_id: Option<String>,
    pub source_id: Option<String>,
    pub folder_id: Option<String>,
    pub collection_id: Option<String>,
    pub export_job_id: Option<String>,
    pub query: Option<String>,
    pub message: String,
    pub status: String,
    pub payload_json: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CacheEntryRecord {
    pub id: String,
    pub cache_key: String,
    pub kind: String,
    pub asset_id: Option<String>,
    pub path: String,
    pub byte_size: i64,
    pub pinned: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CacheEntryInput {
    pub id: Option<String>,
    pub cache_key: String,
    pub kind: String,
    pub asset_id: Option<String>,
    pub path: String,
    pub byte_size: i64,
    pub pinned: bool,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetSearchDocument {
    pub asset_id: String,
    pub source_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub path: String,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub originator: Option<String>,
    pub license: Option<String>,
    pub rights_flags: Vec<String>,
    pub format: Option<String>,
    pub codec: Option<String>,
    pub source_name: String,
    pub source_kind: String,
    pub source_provider: String,
    pub status: String,
    pub collection_names: Vec<String>,
    pub favorite: bool,
    pub duration_seconds: Option<f64>,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub byte_size: Option<i64>,
    pub modified_at: Option<String>,
    pub indexed_at: Option<String>,
    pub imported_at: Option<String>,
    pub rating: Option<f64>,
    pub peak_dbfs: Option<f64>,
    pub rms_dbfs: Option<f64>,
    pub clipping_samples: Option<i64>,
    pub headroom_db: Option<f64>,
    pub waveform_cached: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetSearchRequest {
    pub query: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssetSearchHit {
    pub asset_id: String,
    pub name: String,
    pub path: String,
    pub source_name: String,
    pub score: f64,
}

impl DataRepository {
    pub fn new(connection: Connection) -> Result<Self, String> {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 PRAGMA temp_store = MEMORY;
                 PRAGMA cache_size = -200000;
                 PRAGMA mmap_size = 268435456;
                 PRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| error.to_string())?;
        Ok(Self { connection })
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn create_source(&self, input: SourceInput) -> Result<SourceRecord, String> {
        let id = input.id.unwrap_or_else(|| make_id("source"));
        let status = input.status.unwrap_or_else(|| "active".to_string());
        let settings_json = input.settings_json.unwrap_or_else(|| "{}".to_string());

        self.connection
            .execute(
                "INSERT INTO sources (
                    id, kind, provider, display_name, root_uri, status, settings_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    input.kind,
                    input.provider,
                    input.display_name,
                    input.root_uri,
                    status,
                    settings_json
                ],
            )
            .map_err(|error| error.to_string())?;

        self.get_source(&id)?
            .ok_or_else(|| "created source was not found".to_string())
    }

    pub fn create_local_source(
        &self,
        display_name: &str,
        root_path: &str,
    ) -> Result<SourceRecord, String> {
        self.create_source(SourceInput {
            id: None,
            kind: "local".to_string(),
            provider: "local".to_string(),
            display_name: display_name.to_string(),
            root_uri: root_path.to_string(),
            status: None,
            settings_json: None,
        })
    }

    #[allow(dead_code)]
    pub fn create_cloud_source(
        &self,
        provider: &str,
        display_name: &str,
        root_uri: &str,
        settings_json: Option<String>,
    ) -> Result<SourceRecord, String> {
        self.create_source(SourceInput {
            id: None,
            kind: "cloud".to_string(),
            provider: provider.to_string(),
            display_name: display_name.to_string(),
            root_uri: root_uri.to_string(),
            status: None,
            settings_json,
        })
    }

    pub fn get_source(&self, id: &str) -> Result<Option<SourceRecord>, String> {
        self.connection
            .query_row(
                "SELECT id, kind, provider, display_name, root_uri, status, settings_json
                 FROM sources
                 WHERE id = ?1",
                params![id],
                |row| {
                    Ok(SourceRecord {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        provider: row.get(2)?,
                        display_name: row.get(3)?,
                        root_uri: row.get(4)?,
                        status: row.get(5)?,
                        settings_json: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn list_sources(&self) -> Result<Vec<SourceRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, kind, provider, display_name, root_uri, status, settings_json
                 FROM sources
                 ORDER BY kind, display_name",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(SourceRecord {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    provider: row.get(2)?,
                    display_name: row.get(3)?,
                    root_uri: row.get(4)?,
                    status: row.get(5)?,
                    settings_json: row.get(6)?,
                })
            })
            .map_err(|error| error.to_string())?;

        let mut sources = Vec::new();
        for row in rows {
            sources.push(row.map_err(|error| error.to_string())?);
        }
        Ok(sources)
    }

    pub fn update_source(&self, input: SourceInput) -> Result<Option<SourceRecord>, String> {
        let id = input
            .id
            .ok_or_else(|| "source id is required for update".to_string())?;
        let source_id = id.clone();
        let status = input.status.unwrap_or_else(|| "active".to_string());
        let settings_json = input.settings_json.unwrap_or_else(|| "{}".to_string());
        let changed = self
            .connection
            .execute(
                "UPDATE sources
                 SET kind = ?2,
                     provider = ?3,
                     display_name = ?4,
                     root_uri = ?5,
                     status = ?6,
                     settings_json = ?7,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![
                    id,
                    input.kind,
                    input.provider,
                    input.display_name,
                    input.root_uri,
                    status,
                    settings_json
                ],
            )
            .map_err(|error| error.to_string())?;

        if changed == 0 {
            return Ok(None);
        }

        self.get_source(&source_id)
    }

    pub fn update_source_status(&self, id: &str, status: &str) -> Result<bool, String> {
        let changed = self
            .connection
            .execute(
                "UPDATE sources
                 SET status = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, status],
            )
            .map_err(|error| error.to_string())?;
        Ok(changed > 0)
    }

    pub fn delete_source(&self, id: &str) -> Result<bool, String> {
        let changed = self
            .connection
            .execute("DELETE FROM sources WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        Ok(changed > 0)
    }

    pub fn upsert_folder(&self, input: FolderInput) -> Result<FolderRecord, String> {
        let id = input.id.unwrap_or_else(|| make_id("folder"));
        let source_id = input.source_id.clone();
        let path = input.path.clone();
        let child_count = input.child_count.unwrap_or_default();
        let asset_count = input.asset_count.unwrap_or_default();
        let indexed_status = input
            .indexed_status
            .unwrap_or_else(|| "pending".to_string());

        self.connection
            .execute(
                "INSERT INTO folders (
                    id, source_id, parent_id, path, name, child_count, asset_count,
                    indexed_status, last_indexed_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(source_id, path) DO UPDATE SET
                    parent_id = excluded.parent_id,
                    name = excluded.name,
                    child_count = excluded.child_count,
                    asset_count = excluded.asset_count,
                    indexed_status = excluded.indexed_status,
                    last_indexed_at = excluded.last_indexed_at,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    id,
                    input.source_id,
                    input.parent_id,
                    input.path,
                    input.name,
                    child_count,
                    asset_count,
                    indexed_status,
                    input.last_indexed_at
                ],
            )
            .map_err(|error| error.to_string())?;

        self.get_folder_by_path(&source_id, &path)?
            .ok_or_else(|| "folder was not found after upsert".to_string())
    }

    pub fn get_folder_by_path(
        &self,
        source_id: &str,
        path: &str,
    ) -> Result<Option<FolderRecord>, String> {
        self.connection
            .query_row(
                "SELECT id, source_id, parent_id, path, name, indexed_status
                 FROM folders
                 WHERE source_id = ?1 AND path = ?2",
                params![source_id, path],
                |row| {
                    Ok(FolderRecord {
                        id: row.get(0)?,
                        source_id: row.get(1)?,
                        parent_id: row.get(2)?,
                        path: row.get(3)?,
                        name: row.get(4)?,
                        indexed_status: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn list_folders(&self, source_id: &str) -> Result<Vec<FolderRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, source_id, parent_id, path, name, indexed_status
                 FROM folders
                 WHERE source_id = ?1
                 ORDER BY path",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![source_id], |row| {
                Ok(FolderRecord {
                    id: row.get(0)?,
                    source_id: row.get(1)?,
                    parent_id: row.get(2)?,
                    path: row.get(3)?,
                    name: row.get(4)?,
                    indexed_status: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?;

        let mut folders = Vec::new();
        for row in rows {
            folders.push(row.map_err(|error| error.to_string())?);
        }
        Ok(folders)
    }

    pub fn upsert_asset(&self, input: AssetInput) -> Result<AssetRecord, String> {
        let id = input.id.unwrap_or_else(|| make_id("asset"));
        let source_id = input.source_id.clone();
        let stable_key = input.stable_key.clone();
        let metadata_json = input.metadata_json.unwrap_or_else(|| "{}".to_string());
        let availability = input
            .availability
            .unwrap_or_else(|| "available".to_string());

        self.connection
            .execute(
                "INSERT INTO assets (
                    id, source_id, folder_id, stable_key, provider_asset_id, path_or_url,
                    preview_url, source_url,
                    name, extension, format, duration_seconds, sample_rate, bit_depth,
                    channels, byte_size, modified_at, content_hash, license, originator,
                    attribution, description, metadata_json, availability
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24
                 )
                 ON CONFLICT(source_id, stable_key) DO UPDATE SET
                    folder_id = excluded.folder_id,
                    provider_asset_id = excluded.provider_asset_id,
                    path_or_url = excluded.path_or_url,
                    preview_url = excluded.preview_url,
                    source_url = excluded.source_url,
                    name = excluded.name,
                    extension = excluded.extension,
                    format = excluded.format,
                    duration_seconds = excluded.duration_seconds,
                    sample_rate = excluded.sample_rate,
                    bit_depth = excluded.bit_depth,
                    channels = excluded.channels,
                    byte_size = excluded.byte_size,
                    modified_at = excluded.modified_at,
                    content_hash = excluded.content_hash,
                    license = excluded.license,
                    attribution = excluded.attribution,
                    originator = excluded.originator,
                    description = excluded.description,
                    metadata_json = excluded.metadata_json,
                    availability = excluded.availability,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    id,
                    input.source_id,
                    input.folder_id,
                    input.stable_key,
                    input.provider_asset_id,
                    input.path_or_url,
                    input.preview_url,
                    input.source_url,
                    input.name,
                    input.extension,
                    input.format,
                    input.duration_seconds,
                    input.sample_rate,
                    input.bit_depth,
                    input.channels,
                    input.byte_size,
                    input.modified_at,
                    input.content_hash,
                    input.license,
                    input.originator,
                    input.attribution,
                    input.description,
                    metadata_json,
                    availability
                ],
            )
            .map_err(|error| error.to_string())?;

        let asset = self.get_asset_by_stable_key(&source_id, &stable_key)?;
        self.replace_asset_tags(&asset.id, input.tags)?;
        self.index_asset_for_search(&asset.id)?;
        Ok(asset)
    }

    pub fn get_asset_by_stable_key(
        &self,
        source_id: &str,
        stable_key: &str,
    ) -> Result<AssetRecord, String> {
        self.connection
            .query_row(
                "SELECT id, source_id, stable_key, path_or_url, name, availability
                 FROM assets
                 WHERE source_id = ?1 AND stable_key = ?2",
                params![source_id, stable_key],
                |row| {
                    Ok(AssetRecord {
                        id: row.get(0)?,
                        source_id: row.get(1)?,
                        stable_key: row.get(2)?,
                        path_or_url: row.get(3)?,
                        name: row.get(4)?,
                        availability: row.get(5)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    pub fn asset_index_state(
        &self,
        source_id: &str,
        stable_key: &str,
    ) -> Result<Option<(i64, Option<String>)>, String> {
        self.connection
            .query_row(
                "SELECT
                    COALESCE(json_extract(metadata_json, '$.tagEnrichment.version'), 0),
                    folder_id
                 FROM assets
                 WHERE source_id = ?1
                   AND stable_key = ?2
                   AND availability = 'available'",
                params![source_id, stable_key],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn asset_tags(&self, asset_id: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT tag FROM asset_tags WHERE asset_id = ?1 ORDER BY tag")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![asset_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;

        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|error| error.to_string())?);
        }
        Ok(tags)
    }

    pub fn rebuild_asset_search_index(&self) -> Result<usize, String> {
        self.connection
            .execute("DELETE FROM asset_search_fts", [])
            .map_err(|error| error.to_string())?;
        self.connection
            .execute("DELETE FROM asset_search_facets", [])
            .map_err(|error| error.to_string())?;

        let mut statement = self
            .connection
            .prepare("SELECT id FROM assets ORDER BY id")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut count = 0;
        for row in rows {
            let asset_id = row.map_err(|error| error.to_string())?;
            self.index_asset_for_search(&asset_id)?;
            count += 1;
        }
        Ok(count)
    }

    pub fn index_asset_for_search(&self, asset_id: &str) -> Result<(), String> {
        let document = self.asset_search_document(asset_id)?;
        self.upsert_asset_search_document(document)
    }

    pub fn upsert_asset_search_document(
        &self,
        document: AssetSearchDocument,
    ) -> Result<(), String> {
        let tags = document.tags.join(" ");
        let rights_flags = document.rights_flags.join(" ");
        let collection_names = document.collection_names.join(" ");
        let dates = [
            document.modified_at.as_deref().unwrap_or_default(),
            document.indexed_at.as_deref().unwrap_or_default(),
            document.imported_at.as_deref().unwrap_or_default(),
        ]
        .join(" ");
        let stats = format!(
            "duration:{} rate:{} bitdepth:{} channels:{} size:{} rating:{} peak:{} rms:{} clipping:{} headroom:{}",
            optional_f64(document.duration_seconds),
            optional_i64(document.sample_rate),
            optional_i64(document.bit_depth),
            optional_i64(document.channels),
            optional_i64(document.byte_size),
            optional_f64(document.rating),
            optional_f64(document.peak_dbfs),
            optional_f64(document.rms_dbfs),
            optional_i64(document.clipping_samples),
            optional_f64(document.headroom_db)
        );

        self.connection
            .execute(
                "DELETE FROM asset_search_fts WHERE asset_id = ?1",
                params![document.asset_id],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT INTO asset_search_fts (
                    asset_id, name, path, tags, description, originator, license,
                    rights_flags, format, codec, source, source_kind, source_provider,
                    status, dates, stats
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    document.asset_id,
                    document.name,
                    document.path,
                    tags,
                    document.description,
                    document.originator,
                    document.license,
                    rights_flags,
                    document.format,
                    document.codec,
                    document.source_name,
                    document.source_kind,
                    document.source_provider,
                    document.status,
                    dates,
                    stats
                ],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "INSERT INTO asset_search_facets (
                    asset_id, source_id, folder_id, source_kind, source_provider, source_name,
                    collection_names, favorite, availability, status, license, rights_flags,
                    format, codec, bit_depth, byte_size, duration_seconds, sample_rate,
                    channels, modified_at, indexed_at, imported_at, rating, peak_dbfs,
                    rms_dbfs, clipping_samples, headroom_db, waveform_cached, updated_at
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26,
                    ?27, ?28, CURRENT_TIMESTAMP
                )
                ON CONFLICT(asset_id) DO UPDATE SET
                    source_id = excluded.source_id,
                    folder_id = excluded.folder_id,
                    source_kind = excluded.source_kind,
                    source_provider = excluded.source_provider,
                    source_name = excluded.source_name,
                    collection_names = excluded.collection_names,
                    favorite = excluded.favorite,
                    availability = excluded.availability,
                    status = excluded.status,
                    license = excluded.license,
                    rights_flags = excluded.rights_flags,
                    format = excluded.format,
                    codec = excluded.codec,
                    bit_depth = excluded.bit_depth,
                    byte_size = excluded.byte_size,
                    duration_seconds = excluded.duration_seconds,
                    sample_rate = excluded.sample_rate,
                    channels = excluded.channels,
                    modified_at = excluded.modified_at,
                    indexed_at = excluded.indexed_at,
                    imported_at = excluded.imported_at,
                    rating = excluded.rating,
                    peak_dbfs = excluded.peak_dbfs,
                    rms_dbfs = excluded.rms_dbfs,
                    clipping_samples = excluded.clipping_samples,
                    headroom_db = excluded.headroom_db,
                    waveform_cached = excluded.waveform_cached,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    document.asset_id,
                    document.source_id,
                    document.folder_id,
                    document.source_kind,
                    document.source_provider,
                    document.source_name,
                    collection_names,
                    bool_to_i64(document.favorite),
                    document.status,
                    document.status,
                    document.license,
                    rights_flags,
                    document.format,
                    document.codec,
                    document.bit_depth,
                    document.byte_size,
                    document.duration_seconds,
                    document.sample_rate,
                    document.channels,
                    document.modified_at,
                    document.indexed_at,
                    document.imported_at,
                    document.rating,
                    document.peak_dbfs,
                    document.rms_dbfs,
                    document.clipping_samples,
                    document.headroom_db,
                    bool_to_i64(document.waveform_cached)
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn search_assets(
        &self,
        request: AssetSearchRequest,
    ) -> Result<Vec<AssetSearchHit>, String> {
        let limit = request.limit.unwrap_or(100).clamp(1, 500);
        let query = request.query.unwrap_or_default();
        if query.trim().is_empty() {
            return self.recent_asset_search_hits(limit);
        }

        let mut statement = self
            .connection
            .prepare(
                "SELECT f.asset_id, f.name, f.path, f.source, bm25(asset_search_fts) AS score
                 FROM asset_search_fts AS f
                 WHERE asset_search_fts MATCH ?1
                 ORDER BY score, f.asset_id
                 LIMIT ?2",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![query, limit], |row| {
                Ok(AssetSearchHit {
                    asset_id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    source_name: row.get(3)?,
                    score: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row.map_err(|error| error.to_string())?);
        }
        Ok(hits)
    }

    fn recent_asset_search_hits(&self, limit: i64) -> Result<Vec<AssetSearchHit>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT f.asset_id, f.name, f.path, f.source
                 FROM asset_search_fts AS f
                 ORDER BY f.asset_id
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![limit], |row| {
                Ok(AssetSearchHit {
                    asset_id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    source_name: row.get(3)?,
                    score: 0.0,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut hits = Vec::new();
        for row in rows {
            hits.push(row.map_err(|error| error.to_string())?);
        }
        Ok(hits)
    }

    fn asset_search_document(&self, asset_id: &str) -> Result<AssetSearchDocument, String> {
        let mut document = self
            .connection
            .query_row(
                "SELECT
                    a.id, a.source_id, a.folder_id, a.name, a.path_or_url, a.description,
                    a.originator, a.license, a.format, a.duration_seconds, a.sample_rate,
                    a.bit_depth, a.channels, a.byte_size, a.modified_at, a.availability,
                    a.metadata_json, a.created_at, s.display_name, s.kind, s.provider,
                    an.peak_dbfs, an.rms_dbfs, an.clipping_samples
                 FROM assets AS a
                 JOIN sources AS s ON s.id = a.source_id
                 LEFT JOIN analysis AS an ON an.asset_id = a.id
                    AND an.scope = 'full'
                    AND an.processing_hash = 'processing:none'
                 WHERE a.id = ?1
                 ORDER BY an.analyzed_at DESC
                 LIMIT 1",
                params![asset_id],
                |row| {
                    let metadata_json: String = row.get(16)?;
                    let metadata = serde_json::from_str::<serde_json::Value>(&metadata_json)
                        .unwrap_or(serde_json::Value::Null);
                    let peak_dbfs: Option<f64> = row.get(21)?;
                    let headroom_db = peak_dbfs.map(|peak| 0.0 - peak);
                    Ok(AssetSearchDocument {
                        asset_id: row.get(0)?,
                        source_id: row.get(1)?,
                        folder_id: row.get(2)?,
                        name: row.get(3)?,
                        path: row.get(4)?,
                        tags: Vec::new(),
                        description: row.get(5)?,
                        originator: row.get(6)?,
                        license: row.get(7)?,
                        rights_flags: string_array_from_metadata(&metadata, "rightsFlags"),
                        format: row.get(8)?,
                        codec: optional_string_from_metadata(&metadata, "codec"),
                        source_name: row.get(18)?,
                        source_kind: row.get(19)?,
                        source_provider: row.get(20)?,
                        status: row.get(15)?,
                        collection_names: Vec::new(),
                        favorite: bool_from_metadata(&metadata, "favorite"),
                        duration_seconds: row.get(9)?,
                        sample_rate: row.get(10)?,
                        bit_depth: row.get(11)?,
                        channels: row.get(12)?,
                        byte_size: row.get(13)?,
                        modified_at: row.get(14)?,
                        indexed_at: row.get(17)?,
                        imported_at: optional_string_from_metadata(&metadata, "importedAt"),
                        rating: f64_from_metadata(&metadata, "rating"),
                        peak_dbfs,
                        rms_dbfs: row.get(22)?,
                        clipping_samples: row.get(23)?,
                        headroom_db,
                        waveform_cached: false,
                    })
                },
            )
            .map_err(|error| error.to_string())?;

        document.tags = self.asset_tags(&document.asset_id)?;
        document.tags.extend(self.asset_user_tags(&document.asset_id)?);
        document.tags.sort();
        document.tags.dedup();
        document.collection_names = self.collection_names_for_asset(&document.asset_id)?;
        if document
            .collection_names
            .iter()
            .any(|name| name.eq_ignore_ascii_case("favorites"))
        {
            document.favorite = true;
        }
        document.waveform_cached = self.waveform_cached_for_asset(&document.asset_id)?;
        Ok(document)
    }

    fn asset_user_tags(&self, asset_id: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT tag FROM asset_user_tags WHERE asset_id = ?1 ORDER BY tag")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![asset_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;

        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|error| error.to_string())?);
        }
        Ok(tags)
    }

    fn collection_names_for_asset(&self, asset_id: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT c.name
                 FROM collection_items AS ci
                 JOIN collections AS c ON c.id = ci.collection_id
                 WHERE ci.asset_id = ?1
                 ORDER BY c.name",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![asset_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut names = Vec::new();
        for row in rows {
            names.push(row.map_err(|error| error.to_string())?);
        }
        Ok(names)
    }

    fn waveform_cached_for_asset(&self, asset_id: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM waveform_peaks WHERE asset_id = ?1)",
                params![asset_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| error.to_string())
    }

    fn replace_asset_tags(&self, asset_id: &str, tags: Vec<String>) -> Result<(), String> {
        self.connection
            .execute(
                "DELETE FROM asset_tags WHERE asset_id = ?1",
                params![asset_id],
            )
            .map_err(|error| error.to_string())?;

        let mut insert = self
            .connection
            .prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?1, ?2)")
            .map_err(|error| error.to_string())?;
        for tag in tags {
            let Some(normalized) = canonicalize_tag(&tag) else {
                continue;
            };

            insert
                .execute(params![asset_id, normalized])
                .map_err(|error| error.to_string())?;
        }

        Ok(())
    }

    pub fn create_collection(
        &self,
        parent_id: Option<&str>,
        name: &str,
        sort_order: i64,
    ) -> Result<CollectionRecord, String> {
        let name = validate_collection_name(name)?;
        if let Some(parent_id) = parent_id {
            if self.get_collection(parent_id)?.is_none() {
                return Err("parent collection not found".to_string());
            }
            if self.is_system_collection(parent_id)? {
                return Err("system collections cannot contain nested collections".to_string());
            }
        }
        let id = make_id("collection");
        self.connection
            .execute(
                "INSERT INTO collections (id, parent_id, name, sort_order)
                 VALUES (?1, ?2, ?3, ?4)",
                params![id, parent_id, name, sort_order],
            )
            .map_err(|error| error.to_string())?;

        self.get_collection(&id)?
            .ok_or_else(|| "created collection was not found".to_string())
    }

    pub fn get_collection(&self, id: &str) -> Result<Option<CollectionRecord>, String> {
        self.connection
            .query_row(
                "SELECT id, parent_id, name, sort_order, updated_at FROM collections WHERE id = ?1",
                params![id],
                |row| {
                    Ok(CollectionRecord {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        name: row.get(2)?,
                        sort_order: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn list_collections(&self) -> Result<Vec<CollectionRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, parent_id, name, sort_order, updated_at
                 FROM collections
                 ORDER BY parent_id IS NOT NULL, sort_order, updated_at DESC, name",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(CollectionRecord {
                    id: row.get(0)?,
                    parent_id: row.get(1)?,
                    name: row.get(2)?,
                    sort_order: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|error| error.to_string())?;

        let mut collections = Vec::new();
        for row in rows {
            collections.push(row.map_err(|error| error.to_string())?);
        }
        Ok(collections)
    }

    fn is_system_collection(&self, id: &str) -> Result<bool, String> {
        self.connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM collections
                    WHERE id = ?1
                      AND parent_id IS NULL
                      AND name IN ('Favorites', 'Export Queue')
                 )",
                params![id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())
    }

    pub fn ensure_system_collections(&self) -> Result<Vec<CollectionRecord>, String> {
        for (name, sort_order) in [("Favorites", 90), ("Export Queue", 100)] {
            self.connection
                .execute(
                    "INSERT OR IGNORE INTO collections (id, parent_id, name, sort_order)
                     VALUES (?1, NULL, ?2, ?3)",
                    params![make_id("collection"), name, sort_order],
                )
                .map_err(|error| error.to_string())?;
        }
        self.list_collections()
    }

    pub fn rename_collection(
        &self,
        id: &str,
        name: &str,
    ) -> Result<Option<CollectionRecord>, String> {
        let name = validate_collection_name(name)?;
        if self.is_system_collection(id)? {
            return Err("system collections cannot be renamed".to_string());
        }
        let asset_ids = self.asset_ids_for_collection(id)?;
        let changed = self
            .connection
            .execute(
                "UPDATE collections
                 SET name = ?2, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![id, name],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Ok(None);
        }
        for asset_id in asset_ids {
            self.index_asset_for_search(&asset_id)?;
        }
        self.get_collection(id)
    }

    pub fn delete_collection(&self, id: &str) -> Result<bool, String> {
        if self.is_system_collection(id)? {
            return Err("system collections cannot be deleted".to_string());
        }
        let asset_ids = self.asset_ids_for_collection(id)?;
        let changed = self
            .connection
            .execute("DELETE FROM collections WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        if changed > 0 {
            for asset_id in asset_ids {
                self.index_asset_for_search(&asset_id)?;
            }
        }
        Ok(changed > 0)
    }

    pub fn add_collection_asset(
        &self,
        collection_id: &str,
        asset_id: &str,
        note: Option<&str>,
    ) -> Result<CollectionItemRecord, String> {
        let item =
            self.add_collection_item(collection_id, "asset", Some(asset_id), None, None, note)?;
        self.index_asset_for_search(asset_id)?;
        Ok(item)
    }

    pub fn add_collection_folder_ref(
        &self,
        collection_id: &str,
        folder_id: &str,
        note: Option<&str>,
    ) -> Result<CollectionItemRecord, String> {
        self.add_collection_item(
            collection_id,
            "folder_ref",
            None,
            None,
            Some(folder_id),
            note,
        )
    }

    pub fn add_collection_source_ref(
        &self,
        collection_id: &str,
        source_id: &str,
        note: Option<&str>,
    ) -> Result<CollectionItemRecord, String> {
        self.add_collection_item(
            collection_id,
            "source_ref",
            None,
            Some(source_id),
            None,
            note,
        )
    }

    fn add_collection_item(
        &self,
        collection_id: &str,
        item_kind: &str,
        asset_id: Option<&str>,
        source_id: Option<&str>,
        folder_id: Option<&str>,
        note: Option<&str>,
    ) -> Result<CollectionItemRecord, String> {
        if let Some(existing) =
            self.get_collection_item(collection_id, item_kind, asset_id, source_id, folder_id)?
        {
            return Ok(existing);
        }

        let id = make_id("collection_item");
        self.connection
            .execute(
                "INSERT INTO collection_items (
                    id, collection_id, item_kind, asset_id, source_id, folder_id, note
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    id,
                    collection_id,
                    item_kind,
                    asset_id,
                    source_id,
                    folder_id,
                    note
                ],
            )
            .map_err(|error| error.to_string())?;
        self.connection
            .execute(
                "UPDATE collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![collection_id],
            )
            .map_err(|error| error.to_string())?;

        self.connection
            .query_row(
                "SELECT id, collection_id, item_kind, asset_id, source_id, folder_id
                 FROM collection_items
                 WHERE id = ?1",
                params![id],
                |row| {
                    Ok(CollectionItemRecord {
                        id: row.get(0)?,
                        collection_id: row.get(1)?,
                        item_kind: row.get(2)?,
                        asset_id: row.get(3)?,
                        source_id: row.get(4)?,
                        folder_id: row.get(5)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    fn get_collection_item(
        &self,
        collection_id: &str,
        item_kind: &str,
        asset_id: Option<&str>,
        source_id: Option<&str>,
        folder_id: Option<&str>,
    ) -> Result<Option<CollectionItemRecord>, String> {
        self.connection
            .query_row(
                "SELECT id, collection_id, item_kind, asset_id, source_id, folder_id
                 FROM collection_items
                 WHERE collection_id = ?1
                   AND item_kind = ?2
                   AND (?3 IS NULL OR asset_id = ?3)
                   AND (?4 IS NULL OR source_id = ?4)
                   AND (?5 IS NULL OR folder_id = ?5)",
                params![collection_id, item_kind, asset_id, source_id, folder_id],
                |row| {
                    Ok(CollectionItemRecord {
                        id: row.get(0)?,
                        collection_id: row.get(1)?,
                        item_kind: row.get(2)?,
                        asset_id: row.get(3)?,
                        source_id: row.get(4)?,
                        folder_id: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn list_collection_items(
        &self,
        collection_id: &str,
    ) -> Result<Vec<CollectionItemRecord>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, collection_id, item_kind, asset_id, source_id, folder_id
                 FROM collection_items
                 WHERE collection_id = ?1
                 ORDER BY sort_order, added_at",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![collection_id], |row| {
                Ok(CollectionItemRecord {
                    id: row.get(0)?,
                    collection_id: row.get(1)?,
                    item_kind: row.get(2)?,
                    asset_id: row.get(3)?,
                    source_id: row.get(4)?,
                    folder_id: row.get(5)?,
                })
            })
            .map_err(|error| error.to_string())?;

        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|error| error.to_string())?);
        }
        Ok(items)
    }

    fn asset_ids_for_collection(&self, collection_id: &str) -> Result<Vec<String>, String> {
        let mut statement = self
            .connection
            .prepare(
                "WITH RECURSIVE collection_tree(id) AS (
                    SELECT id FROM collections WHERE id = ?1
                    UNION ALL
                    SELECT c.id
                    FROM collections AS c
                    JOIN collection_tree AS tree ON c.parent_id = tree.id
                 )
                 SELECT ci.asset_id
                 FROM collection_items AS ci
                 JOIN collection_tree AS tree ON tree.id = ci.collection_id
                 WHERE ci.item_kind = 'asset'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![collection_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        let mut asset_ids = Vec::new();
        for row in rows {
            asset_ids.push(row.map_err(|error| error.to_string())?);
        }
        Ok(asset_ids)
    }

    pub fn record_activity(&self, input: ActivityInput) -> Result<String, String> {
        let id = input.id.unwrap_or_else(|| make_id("activity"));
        let activity_type = validate_activity_type(&input.activity_type)?;
        let status = validate_activity_status(input.status.as_deref().unwrap_or("info"))?;
        let message = input.message.trim();
        if message.is_empty() {
            return Err("activity message is required".to_string());
        }
        let payload_json = input.payload_json.unwrap_or_else(|| "{}".to_string());
        serde_json::from_str::<serde_json::Value>(&payload_json)
            .map_err(|_| "activity payload_json must be valid JSON".to_string())?;

        self.connection
            .execute(
                "INSERT INTO activity (
                    id, activity_type, asset_id, source_id, folder_id, collection_id,
                    export_job_id, query, message, status, payload_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    id,
                    activity_type,
                    input.asset_id,
                    input.source_id,
                    input.folder_id,
                    input.collection_id,
                    input.export_job_id,
                    input.query,
                    message,
                    status,
                    payload_json
                ],
            )
            .map_err(|error| error.to_string())?;

        Ok(id)
    }

    pub fn list_activity(&self, limit: Option<i64>) -> Result<Vec<ActivityRecord>, String> {
        let limit = limit.unwrap_or(50).clamp(1, 500);
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, activity_type, asset_id, source_id, folder_id, collection_id,
                        export_job_id, query, message, status, payload_json, created_at
                 FROM activity
                 ORDER BY created_at DESC, id DESC
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![limit], |row| {
                Ok(ActivityRecord {
                    id: row.get(0)?,
                    activity_type: row.get(1)?,
                    asset_id: row.get(2)?,
                    source_id: row.get(3)?,
                    folder_id: row.get(4)?,
                    collection_id: row.get(5)?,
                    export_job_id: row.get(6)?,
                    query: row.get(7)?,
                    message: row.get(8)?,
                    status: row.get(9)?,
                    payload_json: row.get(10)?,
                    created_at: row.get(11)?,
                })
            })
            .map_err(|error| error.to_string())?;
        let mut activity = Vec::new();
        for row in rows {
            activity.push(row.map_err(|error| error.to_string())?);
        }
        Ok(activity)
    }

    pub fn delete_activity(&self, id: &str) -> Result<bool, String> {
        let changed = self
            .connection
            .execute("DELETE FROM activity WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        Ok(changed > 0)
    }

    pub fn clear_activity(&self, activity_type: Option<&str>) -> Result<usize, String> {
        if let Some(activity_type) = activity_type {
            let activity_type = validate_activity_type(activity_type)?;
            return self
                .connection
                .execute(
                    "DELETE FROM activity WHERE activity_type = ?1",
                    params![activity_type],
                )
                .map_err(|error| error.to_string());
        }
        self.connection
            .execute("DELETE FROM activity", [])
            .map_err(|error| error.to_string())
    }

    pub fn upsert_cache_entry(&self, input: CacheEntryInput) -> Result<CacheEntryRecord, String> {
        let id = input.id.unwrap_or_else(|| make_id("cache"));
        let pinned = if input.pinned { 1 } else { 0 };

        self.connection
            .execute(
                "INSERT INTO cache_entries (
                    id, cache_key, kind, asset_id, path, byte_size, pinned, expires_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(cache_key) DO UPDATE SET
                    kind = excluded.kind,
                    asset_id = excluded.asset_id,
                    path = excluded.path,
                    byte_size = excluded.byte_size,
                    pinned = excluded.pinned,
                    expires_at = excluded.expires_at,
                    last_accessed_at = CURRENT_TIMESTAMP",
                params![
                    id,
                    input.cache_key,
                    input.kind,
                    input.asset_id,
                    input.path,
                    input.byte_size,
                    pinned,
                    input.expires_at
                ],
            )
            .map_err(|error| error.to_string())?;

        self.get_cache_entry(&input.cache_key)?
            .ok_or_else(|| "cache entry was not found after upsert".to_string())
    }

    pub fn get_cache_entry(&self, cache_key: &str) -> Result<Option<CacheEntryRecord>, String> {
        self.connection
            .query_row(
                "SELECT id, cache_key, kind, asset_id, path, byte_size, pinned
                 FROM cache_entries
                 WHERE cache_key = ?1",
                params![cache_key],
                |row| {
                    let pinned: i64 = row.get(6)?;
                    Ok(CacheEntryRecord {
                        id: row.get(0)?,
                        cache_key: row.get(1)?,
                        kind: row.get(2)?,
                        asset_id: row.get(3)?,
                        path: row.get(4)?,
                        byte_size: row.get(5)?,
                        pinned: pinned == 1,
                    })
                },
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn touch_cache_entry(&self, cache_key: &str) -> Result<bool, String> {
        let changed = self
            .connection
            .execute(
                "UPDATE cache_entries
                 SET last_accessed_at = CURRENT_TIMESTAMP
                 WHERE cache_key = ?1",
                params![cache_key],
            )
            .map_err(|error| error.to_string())?;
        Ok(changed > 0)
    }
}

pub fn stable_local_asset_key(
    normalized_path: &str,
    byte_size: i64,
    modified_at: &str,
    content_hash: Option<&str>,
) -> String {
    match content_hash {
        Some(hash) if !hash.is_empty() => format!("local:{normalized_path}:{byte_size}:{hash}"),
        _ => format!("local:{normalized_path}:{byte_size}:{modified_at}"),
    }
}

pub fn stable_cloud_asset_key(provider_asset_id: &str) -> String {
    format!("cloud:{provider_asset_id}")
}

fn make_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{nanos}_{sequence}")
}

fn optional_i64(value: Option<i64>) -> String {
    value.map(|value| value.to_string()).unwrap_or_default()
}

fn optional_f64(value: Option<f64>) -> String {
    value.map(|value| value.to_string()).unwrap_or_default()
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn validate_collection_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("collection name is required".to_string());
    }
    if trimmed.len() > 120 {
        return Err("collection name is too long".to_string());
    }
    Ok(trimmed)
}

fn validate_activity_type(activity_type: &str) -> Result<&str, String> {
    let trimmed = activity_type.trim();
    if trimmed.is_empty() {
        return Err("activity type is required".to_string());
    }
    if trimmed.len() > 64
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
    {
        return Err("activity type must be lowercase snake_case".to_string());
    }
    Ok(trimmed)
}

fn validate_activity_status(status: &str) -> Result<&str, String> {
    match status {
        "info" | "success" | "warning" | "error" => Ok(status),
        _ => Err("activity status must be info, success, warning, or error".to_string()),
    }
}

fn optional_string_from_metadata(metadata: &serde_json::Value, key: &str) -> Option<String> {
    metadata
        .get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

fn f64_from_metadata(metadata: &serde_json::Value, key: &str) -> Option<f64> {
    metadata.get(key).and_then(|value| value.as_f64())
}

fn bool_from_metadata(metadata: &serde_json::Value, key: &str) -> bool {
    metadata
        .get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn string_array_from_metadata(metadata: &serde_json::Value, key: &str) -> Vec<String> {
    metadata
        .get(key)
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(|value| value.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_repo() -> DataRepository {
        let connection = Connection::open_in_memory().expect("open sqlite memory database");
        connection
            .execute_batch(include_str!("../migrations/001_core_data_layer.up.sql"))
            .expect("apply core data migration");
        connection
            .execute_batch(include_str!("../migrations/002_search_index.up.sql"))
            .expect("apply search index migration");
        connection
            .execute_batch(include_str!("../migrations/005_user_annotations.up.sql"))
            .expect("apply user annotations migration");
        DataRepository::new(connection).expect("create data repository")
    }

    fn sample_asset_input(source_id: &str, stable_key: String, name: &str) -> AssetInput {
        AssetInput {
            id: None,
            source_id: source_id.to_string(),
            folder_id: None,
            stable_key,
            provider_asset_id: None,
            path_or_url: format!("F:/Audio/{name}"),
            preview_url: None,
            source_url: None,
            name: name.to_string(),
            extension: Some("wav".to_string()),
            format: Some("wav".to_string()),
            duration_seconds: Some(1.25),
            sample_rate: Some(48_000),
            bit_depth: Some(24),
            channels: Some(2),
            byte_size: Some(1024),
            modified_at: Some("2026-01-01T00:00:00Z".to_string()),
            content_hash: None,
            license: Some("cc0".to_string()),
            attribution: None,
            originator: None,
            description: None,
            tags: vec!["Impact".to_string(), "metal".to_string()],
            metadata_json: None,
            availability: None,
        }
    }

    fn sample_folder_input(source_id: &str, path: &str, name: &str) -> FolderInput {
        FolderInput {
            id: None,
            source_id: source_id.to_string(),
            parent_id: None,
            path: path.to_string(),
            name: name.to_string(),
            child_count: Some(0),
            asset_count: Some(0),
            indexed_status: None,
            last_indexed_at: None,
        }
    }

    #[test]
    fn migration_rolls_back_core_tables() {
        let connection = Connection::open_in_memory().expect("open sqlite memory database");
        connection
            .execute_batch(include_str!("../migrations/001_core_data_layer.up.sql"))
            .expect("apply up migration");
        connection
            .execute_batch(include_str!("../migrations/001_core_data_layer.down.sql"))
            .expect("apply down migration");

        let table_count: i64 = connection
            .query_row(
                "SELECT COUNT(*)
                 FROM sqlite_master
                 WHERE type = 'table' AND name IN (
                    'sources', 'assets', 'collections', 'activity', 'cache_entries'
                 )",
                [],
                |row| row.get(0),
            )
            .expect("query table count");
        assert_eq!(table_count, 0);
    }

    #[test]
    fn source_crud_handles_local_and_cloud_sources() {
        let repo = migrated_repo();
        let local = repo
            .create_local_source("Main SFX", "F:/Audio/SFX")
            .expect("create local source");
        let cloud = repo
            .create_cloud_source(
                "freesound",
                "Freesound",
                "https://freesound.org",
                Some(r#"{"credentialRef":"keychain:freesound"}"#.to_string()),
            )
            .expect("create cloud source");

        assert_eq!(local.kind, "local");
        assert_eq!(cloud.kind, "cloud");
        assert_eq!(repo.list_sources().expect("list sources").len(), 2);

        repo.update_source_status(&local.id, "offline")
            .expect("update source status");
        assert_eq!(
            repo.get_source(&local.id)
                .expect("read source")
                .expect("source exists")
                .status,
            "offline"
        );

        assert!(repo.delete_source(&cloud.id).expect("delete source"));
        assert!(repo
            .get_source(&cloud.id)
            .expect("read deleted source")
            .is_none());
    }

    #[test]
    fn folders_upsert_by_source_and_path() {
        let repo = migrated_repo();
        let source = repo
            .create_local_source("Main SFX", "F:/Audio/SFX")
            .expect("create local source");

        let first = repo
            .upsert_folder(sample_folder_input(&source.id, "f:/audio/sfx", "sfx"))
            .expect("insert folder");
        let second = repo
            .upsert_folder(sample_folder_input(&source.id, "f:/audio/sfx", "SFX"))
            .expect("update folder");

        assert_eq!(first.id, second.id);
        assert_eq!(second.name, "SFX");
        assert_eq!(
            repo.list_folders(&source.id).expect("list folders").len(),
            1
        );
    }

    #[test]
    fn asset_upsert_preserves_id_for_stable_source_path_content_key() {
        let repo = migrated_repo();
        let source = repo
            .create_local_source("Main SFX", "F:/Audio/SFX")
            .expect("create local source");
        let key =
            stable_local_asset_key("f:/audio/sfx/hit.wav", 1024, "2026-01-01T00:00:00Z", None);

        let first = repo
            .upsert_asset(sample_asset_input(&source.id, key.clone(), "hit.wav"))
            .expect("insert asset");
        let mut changed = sample_asset_input(&source.id, key, "hit-renamed.wav");
        changed.tags = vec!["Wood".to_string()];
        let second = repo.upsert_asset(changed).expect("update asset");

        assert_eq!(first.id, second.id);
        assert_eq!(second.name, "hit-renamed.wav");
        assert_eq!(
            repo.asset_tags(&second.id).expect("read tags"),
            vec!["wood"]
        );
    }

    #[test]
    fn asset_upsert_writes_search_index_document() {
        let repo = migrated_repo();
        let source = repo
            .create_local_source("Main SFX", "F:/Audio/SFX")
            .expect("create local source");
        let mut input = sample_asset_input(
            &source.id,
            stable_local_asset_key("impact.wav", 1024, "2026-01-01T00:00:00Z", None),
            "metal impact.wav",
        );
        input.description = Some("Heavy metal hit".to_string());
        input.metadata_json = Some(
            serde_json::json!({
                "codec": "pcm",
                "rightsFlags": ["commercial", "cc0"],
                "favorite": true,
                "rating": 4.5,
                "importedAt": "2026-01-02T00:00:00Z"
            })
            .to_string(),
        );

        let asset = repo.upsert_asset(input).expect("insert indexed asset");
        let hits = repo
            .search_assets(AssetSearchRequest {
                query: Some("metal pcm commercial".to_string()),
                limit: Some(10),
            })
            .expect("search assets");

        assert_eq!(hits[0].asset_id, asset.id);
        let favorite: i64 = repo
            .connection()
            .query_row(
                "SELECT favorite FROM asset_search_facets WHERE asset_id = ?1",
                params![asset.id],
                |row| row.get(0),
            )
            .expect("read facet");
        assert_eq!(favorite, 1);
    }

    #[test]
    fn collection_folders_and_items_reference_assets() {
        let repo = migrated_repo();
        let source = repo
            .create_local_source("Main SFX", "F:/Audio/SFX")
            .expect("create local source");
        let asset = repo
            .upsert_asset(sample_asset_input(
                &source.id,
                stable_cloud_asset_key("provider-asset-1"),
                "impact.wav",
            ))
            .expect("insert asset");
        let folder = repo
            .upsert_folder(sample_folder_input(
                &source.id,
                "f:/audio/sfx/impacts",
                "impacts",
            ))
            .expect("insert folder");
        let project = repo
            .create_collection(None, "Current Project", 0)
            .expect("create root collection");
        let impacts = repo
            .create_collection(Some(&project.id), "Impacts", 0)
            .expect("create child collection");
        let item = repo
            .add_collection_asset(&impacts.id, &asset.id, Some("use for prototype"))
            .expect("add asset item");
        let folder_item = repo
            .add_collection_folder_ref(&impacts.id, &folder.id, None)
            .expect("add folder ref");

        assert_eq!(impacts.parent_id, Some(project.id));
        assert_eq!(item.item_kind, "asset");
        assert_eq!(folder_item.item_kind, "folder_ref");
        assert_eq!(
            repo.list_collection_items(&impacts.id)
                .expect("list collection items")
                .len(),
            2
        );
    }

    #[test]
    fn collection_crud_and_system_collections_are_available() {
        let repo = migrated_repo();
        let source = repo
            .create_local_source("Main SFX", "F:/Audio/SFX")
            .expect("create local source");
        let asset = repo
            .upsert_asset(sample_asset_input(
                &source.id,
                stable_local_asset_key("favorite.wav", 1024, "2026-01-01T00:00:00Z", None),
                "favorite.wav",
            ))
            .expect("insert asset");

        let system = repo
            .ensure_system_collections()
            .expect("ensure system collections");
        let favorites = system
            .iter()
            .find(|collection| collection.name == "Favorites")
            .expect("favorites exists");
        repo.add_collection_asset(&favorites.id, &asset.id, None)
            .expect("favorite asset");
        let facet_favorite: i64 = repo
            .connection()
            .query_row(
                "SELECT favorite FROM asset_search_facets WHERE asset_id = ?1",
                params![asset.id],
                |row| row.get(0),
            )
            .expect("read favorite facet");
        assert_eq!(facet_favorite, 1);

        let project = repo
            .create_collection(None, "Current Project", 0)
            .expect("create collection");
        let renamed = repo
            .rename_collection(&project.id, "Current Project Renamed")
            .expect("rename collection")
            .expect("renamed collection");
        assert_eq!(renamed.name, "Current Project Renamed");
        assert!(repo
            .delete_collection(&renamed.id)
            .expect("delete collection"));
        assert!(repo
            .get_collection(&renamed.id)
            .expect("get deleted collection")
            .is_none());
    }

    #[test]
    fn collection_commands_validate_names_and_protect_system_collections() {
        let repo = migrated_repo();
        let system = repo
            .ensure_system_collections()
            .expect("ensure system collections");
        let favorites = system
            .iter()
            .find(|collection| collection.name == "Favorites")
            .expect("favorites exists");

        assert!(repo.create_collection(None, "   ", 0).is_err());
        assert!(repo
            .create_collection(Some(&favorites.id), "Nested", 0)
            .is_err());
        assert!(repo
            .rename_collection(&favorites.id, "Renamed Favorites")
            .is_err());
        assert!(repo.delete_collection(&favorites.id).is_err());
        assert!(repo
            .get_collection(&favorites.id)
            .expect("read favorites")
            .is_some());
    }

    #[test]
    fn activity_rejects_invalid_payloads_and_statuses() {
        let repo = migrated_repo();

        assert!(repo
            .record_activity(ActivityInput {
                id: None,
                activity_type: "Search".to_string(),
                asset_id: None,
                source_id: None,
                folder_id: None,
                collection_id: None,
                export_job_id: None,
                query: None,
                message: "bad type".to_string(),
                status: Some("success".to_string()),
                payload_json: Some("{}".to_string()),
            })
            .is_err());
        assert!(repo
            .record_activity(ActivityInput {
                id: None,
                activity_type: "search".to_string(),
                asset_id: None,
                source_id: None,
                folder_id: None,
                collection_id: None,
                export_job_id: None,
                query: None,
                message: "bad payload".to_string(),
                status: Some("done".to_string()),
                payload_json: Some("{".to_string()),
            })
            .is_err());
    }

    #[test]
    fn activity_and_cache_metadata_are_written() {
        let repo = migrated_repo();
        let source = repo
            .create_cloud_source("freesound", "Freesound", "https://freesound.org", None)
            .expect("create cloud source");
        let activity_id = repo
            .record_activity(ActivityInput {
                id: None,
                activity_type: "search".to_string(),
                asset_id: None,
                source_id: Some(source.id),
                folder_id: None,
                collection_id: None,
                export_job_id: None,
                query: Some("tag:impact".to_string()),
                message: "Searched Freesound".to_string(),
                status: Some("success".to_string()),
                payload_json: Some(r#"{"tab":"cloud"}"#.to_string()),
            })
            .expect("record activity");

        let activity_count: i64 = repo
            .connection()
            .query_row(
                "SELECT COUNT(*) FROM activity WHERE id = ?1",
                params![activity_id],
                |row| row.get(0),
            )
            .expect("count activity");
        assert_eq!(activity_count, 1);
        let activity = repo.list_activity(Some(10)).expect("list activity");
        assert_eq!(activity[0].activity_type, "search");
        assert_eq!(activity[0].query.as_deref(), Some("tag:impact"));

        let cache = repo
            .upsert_cache_entry(CacheEntryInput {
                id: None,
                cache_key: "waveform:asset:1".to_string(),
                kind: "waveform".to_string(),
                asset_id: None,
                path: "F:/Cache/waveform.json".to_string(),
                byte_size: 512,
                pinned: false,
                expires_at: None,
            })
            .expect("write cache entry");

        assert_eq!(cache.byte_size, 512);
        assert!(repo
            .touch_cache_entry(&cache.cache_key)
            .expect("touch cache"));
    }
}
