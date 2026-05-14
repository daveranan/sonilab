mod app_core;
mod audio;
mod cloud;
mod data_layer;
mod export;
mod indexing;
mod infra;
mod migrations;
mod os_drag;
mod reliability;

use app_core::AppStatus;
use data_layer::{
    stable_local_asset_key, ActivityInput, ActivityRecord, AssetInput, AssetRecord, AssetSearchHit,
    AssetSearchRequest, CacheEntryInput, CacheEntryRecord, CollectionItemRecord, CollectionRecord,
    DataRepository, FolderInput, FolderRecord, SourceInput, SourceRecord,
};
use indexing::tagging::{canonicalize_tag, TAG_ENRICHMENT_VERSION};
use indexing::{
    CancellationResult, IndexedAssetMetadata, IndexedFolder, IndexingErrorRecord,
    IndexingJobHandle, IndexingJobMode, IndexingJobRequest, IndexingRepository, IndexingRuntime,
    KnownAssetPath, ReindexMode,
};
use infra::{
    app_paths as read_app_paths, export_local_logs as export_logs,
    validate_ffmpeg_sidecar as validate_ffmpeg, write_structured_log as write_log,
    StructuredLogInput,
};
use migrations::{migration_status as read_migration_status, run_migrations as apply_migrations};
use reliability::{
    database_integrity_check as check_database_integrity,
    enforce_cache_limit as enforce_cache_limit_bytes,
    mark_unavailable_local_sources as mark_unavailable_sources,
    recover_interrupted_jobs as recover_jobs_after_restart,
};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow, Window,
    WindowEvent,
};

#[tauri::command]
fn app_status() -> AppStatus {
    AppStatus::ready()
}

#[tauri::command]
fn app_paths(app: AppHandle) -> Result<infra::AppPaths, String> {
    read_app_paths(&app)
}

#[tauri::command]
fn migration_status(app: AppHandle) -> Result<migrations::MigrationReport, String> {
    read_migration_status(&app)
}

#[tauri::command]
fn run_migrations(app: AppHandle) -> Result<migrations::MigrationReport, String> {
    apply_migrations(&app)
}

#[tauri::command]
fn write_structured_log(app: AppHandle, event: StructuredLogInput) -> Result<(), String> {
    write_log(&app, event)
}

#[tauri::command]
fn export_local_logs(app: AppHandle) -> Result<infra::LogExport, String> {
    export_logs(&app)
}

#[tauri::command]
fn validate_ffmpeg_sidecar(
    app: AppHandle,
    configured_path: Option<String>,
    minimum_version: Option<String>,
) -> Result<infra::FfmpegValidation, String> {
    validate_ffmpeg(&app, configured_path, minimum_version)
}

#[derive(Debug, Serialize)]
struct LocalFolderRegistration {
    source: SourceRecord,
    job: Option<IndexingJobHandle>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseSourceScopeInput {
    kind: String,
    source_id: Option<String>,
    provider: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDatabaseRequest {
    source_scope: BrowseSourceScopeInput,
    folder_id: Option<String>,
    collection_id: Option<String>,
    collection_name: Option<String>,
    favorite_filter: Option<bool>,
    query: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagSummaryRequest {
    source_scope: BrowseSourceScopeInput,
    limit: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TagSummaryRow {
    tag: String,
    count: i64,
    source: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetUserMetadata {
    asset_id: String,
    user_tags: Vec<String>,
    user_comment: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegionNote {
    id: String,
    asset_id: String,
    start_seconds: f64,
    end_seconds: f64,
    comment: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DatabaseBrowseRow {
    #[serde(rename = "folder", rename_all = "camelCase")]
    Folder {
        id: String,
        name: String,
        child_count: Option<i64>,
        source_id: String,
        path: String,
        status: String,
    },
    #[serde(rename = "asset", rename_all = "camelCase")]
    Asset {
        id: String,
        name: String,
        duration_seconds: Option<f64>,
        sample_rate: Option<i64>,
        bit_depth: Option<i64>,
        channels: Option<i64>,
        format: Option<String>,
        codec: Option<String>,
        file_size_bytes: Option<i64>,
        peak_dbfs: Option<f64>,
        rms_dbfs: Option<f64>,
        clipping: Option<bool>,
        headroom_db: Option<f64>,
        source_name: String,
        provider: Option<String>,
        relative_path: String,
        license: Option<String>,
        metadata_file: Option<String>,
        originator: Option<String>,
        attribution: Option<String>,
        description: Option<String>,
        tags: Vec<String>,
        imported: bool,
        favorite: bool,
        availability: String,
    },
}

struct DbAssetBrowseRecord {
    id: String,
    source_id: String,
    name: String,
    duration_seconds: Option<f64>,
    sample_rate: Option<i64>,
    bit_depth: Option<i64>,
    channels: Option<i64>,
    format: Option<String>,
    codec: Option<String>,
    byte_size: Option<i64>,
    peak_dbfs: Option<f64>,
    rms_dbfs: Option<f64>,
    clipping_samples: Option<i64>,
    headroom_db: Option<f64>,
    source_name: String,
    provider: String,
    path_or_url: String,
    license: Option<String>,
    source_settings_json: String,
    originator: Option<String>,
    attribution: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
    availability: String,
    favorite: bool,
    folder_path: Option<String>,
    metadata_json: String,
}

#[tauri::command]
fn register_local_folder(
    app: AppHandle,
    runtime: State<IndexingRuntime>,
    path: String,
    index_now: Option<bool>,
) -> Result<LocalFolderRegistration, String> {
    let root_path = canonical_folder_path(&path)?;
    reject_internal_export_drag_path(&root_path)?;
    let root_uri = root_path.to_string_lossy().to_string();
    let repo = data_repository(&app)?;
    let source = match repo
        .list_sources()?
        .into_iter()
        .find(|source| source.kind == "local" && source.root_uri == root_uri)
    {
        Some(source) => source,
        None => {
            let display_name = root_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&root_uri);
            repo.create_local_source(display_name, &root_uri)?
        }
    };

    let job = if index_now.unwrap_or(true) {
        Some(start_indexing_request(
            &app,
            &runtime,
            IndexingJobRequest {
                source_id: source.id.clone(),
                root_path: source.root_uri.clone(),
                relative_path: None,
                mode: IndexingJobMode::IndexSource,
                reindex_mode: Some(ReindexMode::Metadata),
            },
        )?)
    } else {
        None
    };

    let _ = repo.record_activity(ActivityInput {
        id: None,
        activity_type: "import".to_string(),
        asset_id: None,
        source_id: Some(source.id.clone()),
        folder_id: None,
        collection_id: None,
        export_job_id: None,
        query: None,
        message: format!("Imported {}", source.root_uri),
        status: Some("success".to_string()),
        payload_json: Some(format!(r#"{{"path":{}}}"#, json_string(&source.root_uri))),
    });

    Ok(LocalFolderRegistration { source, job })
}

#[tauri::command]
fn start_indexing_job(
    app: AppHandle,
    runtime: State<IndexingRuntime>,
    request: IndexingJobRequest,
) -> Result<IndexingJobHandle, String> {
    start_indexing_request(&app, &runtime, request)
}

#[tauri::command]
fn cancel_indexing_job(runtime: State<IndexingRuntime>, job_id: String) -> CancellationResult {
    runtime.cancel_job(&job_id)
}

#[tauri::command]
fn reindex_local_source(
    app: AppHandle,
    runtime: State<IndexingRuntime>,
    source_id: String,
    mode: ReindexMode,
) -> Result<IndexingJobHandle, String> {
    let source = data_repository(&app)?
        .get_source(&source_id)?
        .ok_or_else(|| "source not found".to_string())?;
    if source.kind != "local" {
        return Err("reindex_local_source only supports local sources".to_string());
    }
    start_indexing_request(
        &app,
        &runtime,
        IndexingJobRequest {
            source_id,
            root_path: source.root_uri,
            relative_path: None,
            mode: IndexingJobMode::ReindexSource,
            reindex_mode: Some(mode),
        },
    )
}

#[tauri::command]
fn reindex_local_folder(
    app: AppHandle,
    runtime: State<IndexingRuntime>,
    source_id: String,
    relative_path: String,
    mode: ReindexMode,
) -> Result<IndexingJobHandle, String> {
    let source = data_repository(&app)?
        .get_source(&source_id)?
        .ok_or_else(|| "source not found".to_string())?;
    if source.kind != "local" {
        return Err("reindex_local_folder only supports local sources".to_string());
    }
    start_indexing_request(
        &app,
        &runtime,
        IndexingJobRequest {
            source_id,
            root_path: source.root_uri,
            relative_path: Some(relative_path),
            mode: IndexingJobMode::ReindexFolder,
            reindex_mode: Some(mode),
        },
    )
}

#[tauri::command]
fn remove_failed_assets(
    app: AppHandle,
    source_id: String,
    relative_path: Option<String>,
) -> Result<usize, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let deleted = delete_failed_assets_in_scope(&connection, &source_id, relative_path.as_deref())?;
    mark_removed_failed_scope(&connection, &source_id, relative_path.as_deref())?;
    Ok(deleted)
}

#[tauri::command]
fn retry_failed_assets(
    app: AppHandle,
    runtime: State<IndexingRuntime>,
    source_id: String,
    relative_path: Option<String>,
) -> Result<IndexingJobHandle, String> {
    let source = data_repository(&app)?
        .get_source(&source_id)?
        .ok_or_else(|| "source not found".to_string())?;
    if source.kind != "local" {
        return Err("retry_failed_assets only supports local sources".to_string());
    }
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let _ = delete_failed_assets_in_scope(&connection, &source_id, relative_path.as_deref())?;
    mark_retrying_failed_scope(&connection, &source_id, relative_path.as_deref())?;
    start_indexing_request(
        &app,
        &runtime,
        IndexingJobRequest {
            source_id,
            root_path: source.root_uri,
            relative_path,
            mode: IndexingJobMode::ReindexFolder,
            reindex_mode: Some(ReindexMode::Metadata),
        },
    )
}

#[tauri::command]
fn start_folder_watch(
    app: AppHandle,
    runtime: State<IndexingRuntime>,
    source_id: String,
) -> Result<(), String> {
    apply_migrations(&app)?;
    let source = data_repository(&app)?
        .get_source(&source_id)?
        .ok_or_else(|| "source not found".to_string())?;
    let db_path = migrations::app_database_path(&app)?;
    let app_for_progress = app.clone();
    runtime.start_watcher(
        source.id.clone(),
        source.root_uri,
        Arc::new(move || SqliteIndexingRepository::new(db_path.clone())),
        Arc::new(move || TauriProgressSink {
            app: app_for_progress.clone(),
        }),
    )
}

#[tauri::command]
fn stop_folder_watch(runtime: State<IndexingRuntime>, source_id: String) -> bool {
    runtime.stop_watcher(&source_id)
}

#[tauri::command]
fn create_source(app: AppHandle, input: SourceInput) -> Result<SourceRecord, String> {
    data_repository(&app)?.create_source(input)
}

#[tauri::command]
fn update_source(app: AppHandle, input: SourceInput) -> Result<Option<SourceRecord>, String> {
    data_repository(&app)?.update_source(input)
}

#[tauri::command]
fn list_sources(app: AppHandle) -> Result<Vec<SourceRecord>, String> {
    data_repository(&app)?.list_sources()
}

#[tauri::command]
fn delete_source(app: AppHandle, id: String) -> Result<bool, String> {
    data_repository(&app)?.delete_source(&id)
}

#[tauri::command]
fn update_source_status(app: AppHandle, id: String, status: String) -> Result<bool, String> {
    data_repository(&app)?.update_source_status(&id, &status)
}

#[tauri::command]
fn upsert_folder(app: AppHandle, input: FolderInput) -> Result<FolderRecord, String> {
    data_repository(&app)?.upsert_folder(input)
}

#[tauri::command]
fn list_source_folders(app: AppHandle, source_id: String) -> Result<Vec<FolderRecord>, String> {
    data_repository(&app)?.list_folders(&source_id)
}

#[tauri::command]
fn upsert_asset(app: AppHandle, input: AssetInput) -> Result<AssetRecord, String> {
    data_repository(&app)?.upsert_asset(input)
}

#[tauri::command]
fn get_asset_by_stable_key(
    app: AppHandle,
    source_id: String,
    stable_key: String,
) -> Result<AssetRecord, String> {
    data_repository(&app)?.get_asset_by_stable_key(&source_id, &stable_key)
}

#[tauri::command]
fn asset_tags(app: AppHandle, asset_id: String) -> Result<Vec<String>, String> {
    data_repository(&app)?.asset_tags(&asset_id)
}

#[tauri::command]
fn asset_user_metadata(app: AppHandle, asset_id: String) -> Result<AssetUserMetadata, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let user_comment = connection
        .query_row(
            "SELECT comment FROM asset_user_metadata WHERE asset_id = ?1",
            params![&asset_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let user_tags = read_asset_user_tags(&connection, &asset_id)?;
    Ok(AssetUserMetadata {
        asset_id,
        user_tags,
        user_comment,
    })
}

#[tauri::command]
fn update_asset_user_metadata(
    app: AppHandle,
    asset_id: String,
    user_tags: Vec<String>,
    user_comment: String,
) -> Result<AssetUserMetadata, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO asset_user_metadata (asset_id, comment, updated_at)
             VALUES (?1, ?2, CURRENT_TIMESTAMP)
             ON CONFLICT(asset_id) DO UPDATE SET
                comment = excluded.comment,
                updated_at = CURRENT_TIMESTAMP",
            params![&asset_id, user_comment.trim()],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM asset_user_tags WHERE asset_id = ?1",
            params![&asset_id],
        )
        .map_err(|error| error.to_string())?;

    let mut normalized_tags = user_tags
        .iter()
        .filter_map(|tag| normalize_user_tag(tag))
        .collect::<Vec<_>>();
    normalized_tags.sort();
    normalized_tags.dedup();
    {
        let mut insert = connection
            .prepare("INSERT OR IGNORE INTO asset_user_tags (asset_id, tag) VALUES (?1, ?2)")
            .map_err(|error| error.to_string())?;
        for tag in &normalized_tags {
            insert
                .execute(params![&asset_id, tag])
                .map_err(|error| error.to_string())?;
        }
    }
    DataRepository::new(connection)?.index_asset_for_search(&asset_id)?;

    Ok(AssetUserMetadata {
        asset_id,
        user_tags: normalized_tags,
        user_comment: user_comment.trim().to_string(),
    })
}

#[tauri::command]
fn list_region_notes(app: AppHandle, asset_id: String) -> Result<Vec<RegionNote>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    read_region_notes(&connection, &asset_id)
}

#[tauri::command]
fn upsert_region_note(
    app: AppHandle,
    id: Option<String>,
    asset_id: String,
    start_seconds: f64,
    end_seconds: f64,
    comment: String,
) -> Result<RegionNote, String> {
    if end_seconds <= start_seconds {
        return Err("Region note end must be after start.".to_string());
    }
    let trimmed = comment.trim();
    if trimmed.is_empty() {
        return Err("Region note comment is required.".to_string());
    }
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let note_id = id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("region-note-{}-{}", asset_id, now_millis()));
    connection
        .execute(
            "INSERT INTO asset_region_notes (
                id, asset_id, start_seconds, end_seconds, comment, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, CURRENT_TIMESTAMP)
             ON CONFLICT(id) DO UPDATE SET
                start_seconds = excluded.start_seconds,
                end_seconds = excluded.end_seconds,
                comment = excluded.comment,
                updated_at = CURRENT_TIMESTAMP",
            params![&note_id, &asset_id, start_seconds, end_seconds, trimmed],
        )
        .map_err(|error| error.to_string())?;
    read_region_note(&connection, &note_id)
}

#[tauri::command]
fn delete_region_note(app: AppHandle, id: String) -> Result<bool, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let changed = connection
        .execute("DELETE FROM asset_region_notes WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    Ok(changed > 0)
}

fn read_asset_user_tags(connection: &Connection, asset_id: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
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

fn read_region_notes(connection: &Connection, asset_id: &str) -> Result<Vec<RegionNote>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, asset_id, start_seconds, end_seconds, comment, created_at, updated_at
             FROM asset_region_notes
             WHERE asset_id = ?1
             ORDER BY start_seconds, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![asset_id], region_note_from_row)
        .map_err(|error| error.to_string())?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|error| error.to_string())?);
    }
    Ok(notes)
}

fn read_region_note(connection: &Connection, id: &str) -> Result<RegionNote, String> {
    connection
        .query_row(
            "SELECT id, asset_id, start_seconds, end_seconds, comment, created_at, updated_at
             FROM asset_region_notes
             WHERE id = ?1",
            params![id],
            region_note_from_row,
        )
        .map_err(|error| error.to_string())
}

fn region_note_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RegionNote> {
    Ok(RegionNote {
        id: row.get(0)?,
        asset_id: row.get(1)?,
        start_seconds: row.get(2)?,
        end_seconds: row.get(3)?,
        comment: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn normalize_user_tag(tag: &str) -> Option<String> {
    if let Some((category, label)) = tag.split_once(':') {
        let category = canonicalize_tag(category)?;
        let label = canonicalize_tag(label)?;
        return Some(format!("{category}:{label}"));
    }
    canonicalize_tag(tag)
}

#[tauri::command]
fn rebuild_asset_search_index(app: AppHandle) -> Result<usize, String> {
    data_repository(&app)?.rebuild_asset_search_index()
}

#[tauri::command]
fn search_assets(
    app: AppHandle,
    request: AssetSearchRequest,
) -> Result<Vec<AssetSearchHit>, String> {
    data_repository(&app)?.search_assets(request)
}

#[tauri::command]
fn browse_database(
    app: AppHandle,
    request: BrowseDatabaseRequest,
) -> Result<Vec<DatabaseBrowseRow>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let repo = DataRepository::new(connection)?;
    let source_ids = browse_source_ids(&repo, &request.source_scope)?;
    let current_folder = request
        .folder_id
        .as_deref()
        .map(|folder_id| browse_folder_path(repo.connection(), folder_id))
        .transpose()?;
    let current_path = current_folder.as_deref().unwrap_or("");
    let limit = request.limit.unwrap_or(1_000).clamp(1, 50_000);
    let query = request.query.unwrap_or_default();
    let search_ids = if query.trim().is_empty() {
        None
    } else {
        Some(
            search_asset_ids(repo.connection(), &query, limit)?
                .into_iter()
                .collect::<HashSet<_>>(),
        )
    };

    if let Some(collection_id) = resolve_browse_collection_id(
        repo.connection(),
        request.collection_id.as_deref(),
        request.collection_name.as_deref(),
    )? {
        let mut rows = Vec::new();
        for asset in browse_assets_for_collection(repo.connection(), &collection_id, limit)? {
            if !source_ids.contains(&asset.source_id) {
                continue;
            }
            if !asset_in_browse_scope(&asset, current_path) {
                continue;
            }
            if search_ids
                .as_ref()
                .map(|ids| !ids.contains(&asset.id))
                .unwrap_or(false)
            {
                continue;
            }
            if !asset_matches_favorite_filter(&asset, request.favorite_filter) {
                continue;
            }
            rows.push(asset_browse_row(asset));
            if rows.len() >= limit as usize {
                break;
            }
        }
        return Ok(rows);
    }

    let mut rows = Vec::new();
    if query.trim().is_empty() {
        for source_id in &source_ids {
            let folders = repo.list_folders(source_id)?;
            let assets = browse_assets_for_source(repo.connection(), source_id)?;
            if request.favorite_filter.is_none() {
                for folder in folders
                    .iter()
                    .filter(|folder| direct_child_path(&folder.path, current_path))
                {
                    rows.push(DatabaseBrowseRow::Folder {
                        id: folder.id.clone(),
                        name: folder.name.clone(),
                        child_count: Some(child_count(&folders, &assets, &folder.path)),
                        source_id: folder.source_id.clone(),
                        path: folder.path.clone(),
                        status: folder_status(&folder.indexed_status),
                    });
                }
            }
            for asset in assets {
                if asset_in_browse_scope(&asset, current_path) {
                    if !asset_matches_favorite_filter(&asset, request.favorite_filter) {
                        continue;
                    }
                    rows.push(asset_browse_row(asset));
                }
                if rows.len() >= limit as usize {
                    return Ok(rows);
                }
            }
        }
        return Ok(rows);
    }

    for asset_id in search_ids.unwrap_or_default() {
        if let Some(asset) = browse_asset_by_id(repo.connection(), &asset_id)? {
            if !source_ids.contains(&asset.source_id) {
                continue;
            }
            if !asset_in_browse_scope(&asset, current_path) {
                continue;
            }
            if !asset_matches_favorite_filter(&asset, request.favorite_filter) {
                continue;
            }
            rows.push(asset_browse_row(asset));
        }
    }
    Ok(rows)
}

#[tauri::command]
fn tag_summary(app: AppHandle, request: TagSummaryRequest) -> Result<Vec<TagSummaryRow>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let repo = DataRepository::new(connection)?;
    let source_ids = browse_source_ids(&repo, &request.source_scope)?;
    if source_ids.is_empty() {
        return Ok(Vec::new());
    }

    let limit = request.limit.unwrap_or(300).clamp(1, 10_000);
    let placeholders = std::iter::repeat("?")
        .take(source_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH tag_counts AS (
            SELECT t.tag, COUNT(*) AS tag_count, t.source
            FROM (
                SELECT asset_id, tag, 'local' AS source FROM asset_tags
                UNION
                SELECT asset_id, tag, 'user' AS source FROM asset_user_tags
            ) AS t
            JOIN assets AS a ON a.id = t.asset_id
            WHERE a.source_id IN ({placeholders})
              AND a.availability = 'available'
            GROUP BY t.source, t.tag
         ),
         ranked_tags AS (
            SELECT tag, tag_count, source,
                   ROW_NUMBER() OVER (
                       PARTITION BY source
                       ORDER BY tag_count DESC, tag
                   ) AS source_rank
            FROM tag_counts
         )
         SELECT tag, tag_count, source
         FROM ranked_tags
         WHERE source_rank <= ?
         ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END, tag_count DESC, tag"
    );
    let mut query_params = source_ids;
    query_params.push(limit.to_string());
    let mut statement = repo
        .connection()
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(query_params.iter()), |row| {
            Ok(TagSummaryRow {
                tag: row.get(0)?,
                count: row.get(1)?,
                source: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut summary = Vec::new();
    for row in rows {
        let row = row.map_err(|error| error.to_string())?;
        summary.push(row);
    }
    Ok(summary)
}

#[tauri::command]
fn resolve_browse_row_path(
    app: AppHandle,
    row_id: String,
    row_kind: String,
) -> Result<String, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    match row_kind.as_str() {
        "asset" => connection
            .query_row(
                "SELECT path_or_url FROM assets WHERE id = ?1",
                params![row_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "asset not found".to_string()),
        "folder" => resolve_folder_absolute_path(&connection, &row_id),
        _ => Err("row_kind must be asset or folder".to_string()),
    }
}

#[tauri::command]
fn delete_browse_row(app: AppHandle, row_id: String, row_kind: String) -> Result<bool, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    match row_kind.as_str() {
        "asset" => delete_asset_row(&connection, &row_id),
        "folder" => delete_folder_row(&connection, &row_id),
        _ => Err("row_kind must be asset or folder".to_string()),
    }
}

#[tauri::command]
fn create_collection(
    app: AppHandle,
    parent_id: Option<String>,
    name: String,
    sort_order: i64,
) -> Result<CollectionRecord, String> {
    data_repository(&app)?.create_collection(parent_id.as_deref(), &name, sort_order)
}

#[tauri::command]
fn list_collections(app: AppHandle) -> Result<Vec<CollectionRecord>, String> {
    data_repository(&app)?.ensure_system_collections()
}

#[tauri::command]
fn rename_collection(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<Option<CollectionRecord>, String> {
    data_repository(&app)?.rename_collection(&id, &name)
}

#[tauri::command]
fn delete_collection(app: AppHandle, id: String) -> Result<bool, String> {
    data_repository(&app)?.delete_collection(&id)
}

#[tauri::command]
fn add_collection_asset(
    app: AppHandle,
    collection_id: String,
    asset_id: String,
    note: Option<String>,
) -> Result<CollectionItemRecord, String> {
    data_repository(&app)?.add_collection_asset(&collection_id, &asset_id, note.as_deref())
}

#[tauri::command]
fn add_collection_folder_ref(
    app: AppHandle,
    collection_id: String,
    folder_id: String,
    note: Option<String>,
) -> Result<CollectionItemRecord, String> {
    data_repository(&app)?.add_collection_folder_ref(&collection_id, &folder_id, note.as_deref())
}

#[tauri::command]
fn add_collection_source_ref(
    app: AppHandle,
    collection_id: String,
    source_id: String,
    note: Option<String>,
) -> Result<CollectionItemRecord, String> {
    data_repository(&app)?.add_collection_source_ref(&collection_id, &source_id, note.as_deref())
}

#[tauri::command]
fn list_collection_items(
    app: AppHandle,
    collection_id: String,
) -> Result<Vec<CollectionItemRecord>, String> {
    data_repository(&app)?.list_collection_items(&collection_id)
}

#[tauri::command]
fn record_activity(app: AppHandle, input: ActivityInput) -> Result<String, String> {
    data_repository(&app)?.record_activity(input)
}

#[tauri::command]
fn list_activity(app: AppHandle, limit: Option<i64>) -> Result<Vec<ActivityRecord>, String> {
    data_repository(&app)?.list_activity(limit)
}

#[tauri::command]
fn delete_activity(app: AppHandle, id: String) -> Result<bool, String> {
    data_repository(&app)?.delete_activity(&id)
}

#[tauri::command]
fn clear_activity(app: AppHandle, activity_type: Option<String>) -> Result<usize, String> {
    data_repository(&app)?.clear_activity(activity_type.as_deref())
}

#[tauri::command]
fn upsert_cache_entry(app: AppHandle, input: CacheEntryInput) -> Result<CacheEntryRecord, String> {
    data_repository(&app)?.upsert_cache_entry(input)
}

#[tauri::command]
fn touch_cache_entry(app: AppHandle, cache_key: String) -> Result<bool, String> {
    data_repository(&app)?.touch_cache_entry(&cache_key)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheKindSummary {
    kind: String,
    entries: i64,
    bytes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheManagementSummary {
    cache_dir: String,
    total_entries: i64,
    total_bytes: i64,
    disk_bytes: i64,
    by_kind: Vec<CacheKindSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LicenseAttributionRow {
    asset_id: String,
    name: String,
    source_name: String,
    path: String,
    license: Option<String>,
    attribution: Option<String>,
    originator: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFlowStatus {
    current_version: String,
    channel: String,
    endpoint_configured: bool,
    signing_public_key_configured: bool,
    update_check_available: bool,
    message: String,
}

#[tauri::command]
fn cache_management_summary(app: AppHandle) -> Result<CacheManagementSummary, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let mut statement = connection
        .prepare(
            "SELECT kind, COUNT(*), COALESCE(SUM(byte_size), 0)
             FROM cache_entries
             GROUP BY kind
             ORDER BY kind",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(CacheKindSummary {
                kind: row.get(0)?,
                entries: row.get(1)?,
                bytes: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut by_kind = Vec::new();
    for row in rows {
        by_kind.push(row.map_err(|error| error.to_string())?);
    }
    let total_entries = by_kind.iter().map(|row| row.entries).sum();
    let total_bytes = by_kind.iter().map(|row| row.bytes).sum();

    Ok(CacheManagementSummary {
        cache_dir: cache_root.display().to_string(),
        total_entries,
        total_bytes,
        disk_bytes: directory_size_bytes(&cache_root),
        by_kind,
    })
}

#[tauri::command]
fn license_attribution_report(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<LicenseAttributionRow>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let limit = limit.unwrap_or(200).clamp(1, 500);
    let mut statement = connection
        .prepare(
            "SELECT a.id, a.name, s.display_name, a.path_or_url, a.license,
                    a.attribution, a.originator, a.description,
                    COALESCE(GROUP_CONCAT(t.tag, ','), '')
             FROM assets AS a
             JOIN sources AS s ON s.id = a.source_id
             LEFT JOIN asset_tags AS t ON t.asset_id = a.id
             WHERE s.kind = 'local'
               AND (
                    a.license IS NOT NULL OR a.attribution IS NOT NULL OR
                    a.originator IS NOT NULL OR a.description IS NOT NULL OR
                    t.tag IS NOT NULL
               )
             GROUP BY a.id
             ORDER BY a.updated_at DESC, a.name
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![limit], |row| {
            let tags: String = row.get(8)?;
            Ok(LicenseAttributionRow {
                asset_id: row.get(0)?,
                name: row.get(1)?,
                source_name: row.get(2)?,
                path: row.get(3)?,
                license: row.get(4)?,
                attribution: row.get(5)?,
                originator: row.get(6)?,
                description: row.get(7)?,
                tags: tags
                    .split(',')
                    .filter(|tag| !tag.is_empty())
                    .map(|tag| tag.to_string())
                    .collect(),
            })
        })
        .map_err(|error| error.to_string())?;
    let mut report = Vec::new();
    for row in rows {
        report.push(row.map_err(|error| error.to_string())?);
    }
    Ok(report)
}

#[tauri::command]
fn update_flow_status(app: AppHandle) -> UpdateFlowStatus {
    let endpoint_configured = true;
    let signing_public_key_configured = true;
    let update_check_available = endpoint_configured && signing_public_key_configured;
    let message = if update_check_available {
        "GitHub Releases updater is configured. Release builds still require the private signing key."
    } else {
        "Update flow is wired for readiness checks; configure endpoint and signing key before release."
    };

    UpdateFlowStatus {
        current_version: app.package_info().version.to_string(),
        channel: std::env::var("SONILABS_UPDATE_CHANNEL").unwrap_or_else(|_| "stable".to_string()),
        endpoint_configured,
        signing_public_key_configured,
        update_check_available,
        message: message.to_string(),
    }
}

#[tauri::command]
fn enforce_cache_limit(
    app: AppHandle,
    limit_bytes: i64,
) -> Result<reliability::CacheEnforcementReport, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    enforce_cache_limit_bytes(&connection, &cache_root, limit_bytes)
}

#[tauri::command]
fn database_integrity_check(
    app: AppHandle,
) -> Result<reliability::DatabaseIntegrityReport, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    check_database_integrity(&connection)
}

#[tauri::command]
fn app_restart_recovery(app: AppHandle) -> Result<reliability::RestartRecoveryReport, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let report = recover_jobs_after_restart(&connection)?;
    let _ = mark_unavailable_sources(&connection);
    Ok(report)
}

#[tauri::command]
fn resolve_preview_file(
    app: AppHandle,
    asset_id: String,
    requested_mode: String,
) -> Result<audio::PreviewFileResolution, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    audio::resolve_preview_file(&connection, &asset_id, &requested_mode)
}

#[tauri::command]
fn read_preview_file_bytes(app: AppHandle, asset_id: String) -> Result<Vec<u8>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    audio::read_preview_file_bytes(&connection, &asset_id)
}

#[tauri::command]
fn setup_freesound_credentials(
    app: AppHandle,
    runtime: State<cloud::CloudRuntime>,
    input: cloud::FreesoundCredentialSetup,
) -> Result<cloud::FreesoundCredentialSetupResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::setup_freesound_credentials(&connection, &runtime, input)
}

#[tauri::command]
fn freesound_search(
    app: AppHandle,
    runtime: State<cloud::CloudRuntime>,
    request: cloud::FreesoundSearchRequest,
) -> Result<cloud::FreesoundSearchResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::search_freesound(&connection, &runtime, request)
}

#[tauri::command]
fn cache_freesound_preview(
    app: AppHandle,
    runtime: State<cloud::CloudRuntime>,
    asset_id: String,
) -> Result<cloud::CloudPreviewCacheResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::cache_freesound_preview(&app, &connection, &runtime, &asset_id)
}

#[tauri::command]
fn import_freesound_original(
    app: AppHandle,
    runtime: State<cloud::CloudRuntime>,
    asset_id: String,
) -> Result<cloud::CloudOriginalImportResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::import_freesound_original(&app, &connection, &runtime, &asset_id)
}

#[tauri::command]
fn set_cloud_provider_enabled(
    app: AppHandle,
    request: cloud::CloudProviderEnabledRequest,
) -> Result<cloud::CloudProviderEnabledResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::set_cloud_provider_enabled(&connection, request)
}

#[tauri::command]
fn internet_archive_search(
    app: AppHandle,
    runtime: State<cloud::CloudRuntime>,
    request: cloud::InternetArchiveSearchRequest,
) -> Result<cloud::InternetArchiveSearchResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::search_internet_archive(&connection, &runtime, request)
}

#[tauri::command]
fn import_manual_cloud_asset(
    app: AppHandle,
    request: cloud::ManualCloudImportRequest,
) -> Result<cloud::ManualCloudImportResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::import_manual_cloud_asset(&connection, request)
}

#[tauri::command]
fn import_cloud_original(
    app: AppHandle,
    runtime: State<cloud::CloudRuntime>,
    asset_id: String,
) -> Result<cloud::CloudOriginalImportResult, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    cloud::import_cloud_original(&app, &connection, &runtime, &asset_id)
}

#[tauri::command]
async fn get_waveform_peaks(
    app: AppHandle,
    runtime: State<'_, audio::AudioRuntime>,
    asset_id: String,
    content_key: String,
    channel_mode: String,
    samples_per_peak: i64,
) -> Result<audio::WaveformPeakData, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_migrations(&app)?;
        let path = migrations::app_database_path(&app)?;
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        let cache_root = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        let resource_dir = app.path().resource_dir().ok();
        audio::get_waveform_peaks_with_sidecar(
            &runtime,
            &connection,
            &cache_root,
            resource_dir.as_deref(),
            &asset_id,
            &content_key,
            &channel_mode,
            samples_per_peak,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_cached_waveform_peaks(
    app: AppHandle,
    asset_id: String,
    content_key: String,
    channel_mode: String,
    samples_per_peak: i64,
) -> Result<Option<audio::WaveformPeakData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_migrations(&app)?;
        let path = migrations::app_database_path(&app)?;
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        audio::get_cached_waveform_peaks_with_files(
            &connection,
            &asset_id,
            &content_key,
            &channel_mode,
            samples_per_peak,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_cached_waveform_peak_range(
    app: AppHandle,
    asset_id: String,
    content_key: String,
    channel_mode: String,
    samples_per_peak: i64,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<Option<audio::WaveformPeakData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        apply_migrations(&app)?;
        let path = migrations::app_database_path(&app)?;
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        audio::get_cached_waveform_peak_range(
            &connection,
            &asset_id,
            &content_key,
            &channel_mode,
            samples_per_peak,
            start_seconds,
            end_seconds,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn analyze_audio_levels(
    app: AppHandle,
    runtime: State<audio::AudioRuntime>,
    asset_id: String,
    gain_db: f64,
) -> Result<audio::LevelAnalysisPair, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    audio::analyze_audio_levels(&runtime, &connection, &asset_id, gain_db)
}

#[tauri::command]
fn cancel_audio_job(runtime: State<audio::AudioRuntime>, job_id: String) -> bool {
    runtime.cancel_job(&job_id)
}

#[tauri::command]
fn audio_runtime_status(runtime: State<audio::AudioRuntime>) -> audio::AudioRuntimeStatus {
    runtime.status()
}

#[tauri::command]
fn queue_export_job(
    app: AppHandle,
    runtime: State<export::ExportRuntime>,
    asset_id: String,
    format: String,
    output_folder: String,
    filename_pattern: Option<String>,
    export_scope: String,
    region_start_seconds: Option<f64>,
    region_end_seconds: Option<f64>,
    format_settings_json: Option<String>,
    processing_json: String,
    processing_hash: String,
    preserve_folder_structure: Option<bool>,
    include_attribution_sidecar: Option<bool>,
    overwrite_mode: Option<String>,
) -> Result<export::ExportJobSnapshot, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let queued = export::queue_export_job(
        &connection,
        export::ExportJobInput {
            asset_id,
            format,
            output_folder,
            filename_pattern: filename_pattern.unwrap_or_else(|| "{name}_processed".to_string()),
            export_scope,
            region_start_seconds,
            region_end_seconds,
            format_settings_json: format_settings_json.unwrap_or_else(|| "{}".to_string()),
            processing_json,
            processing_hash,
            preserve_folder_structure: preserve_folder_structure.unwrap_or(false),
            include_attribution_sidecar: include_attribution_sidecar.unwrap_or(false),
            overwrite_mode: overwrite_mode.unwrap_or_else(|| "rename".to_string()),
        },
    )?;
    let resource_dir = app.path().resource_dir().ok();
    let completed = runtime
        .run_jobs(&connection, resource_dir, Some(vec![queued.id.clone()]))
        .into_iter()
        .next()
        .unwrap_or(queued);
    record_export_activity(&connection, &[completed.clone()])?;
    Ok(completed)
}

#[tauri::command]
fn queue_export_jobs(
    app: AppHandle,
    runtime: State<export::ExportRuntime>,
    asset_ids: Vec<String>,
    format: String,
    output_folder: String,
    filename_pattern: String,
    export_scope: String,
    region_start_seconds: Option<f64>,
    region_end_seconds: Option<f64>,
    format_settings_json: String,
    processing_json: String,
    processing_hash: String,
    preserve_folder_structure: bool,
    include_attribution_sidecar: bool,
    overwrite_mode: String,
) -> Result<Vec<export::ExportJobSnapshot>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    let queued = export::queue_export_jobs(
        &connection,
        export::ExportBatchInput {
            asset_ids,
            format,
            output_folder,
            filename_pattern,
            export_scope,
            region_start_seconds,
            region_end_seconds,
            format_settings_json,
            processing_json,
            processing_hash,
            preserve_folder_structure,
            include_attribution_sidecar,
            overwrite_mode,
        },
    )?;
    let job_ids = queued.iter().map(|job| job.id.clone()).collect::<Vec<_>>();
    let resource_dir = app.path().resource_dir().ok();
    let completed = runtime.run_jobs(&connection, resource_dir, Some(job_ids));
    record_export_activity(&connection, &completed)?;
    Ok(completed)
}

#[tauri::command]
fn list_export_jobs(
    app: AppHandle,
    limit: Option<i64>,
) -> Result<Vec<export::ExportJobSnapshot>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    export::list_export_jobs(&connection, limit)
}

#[tauri::command]
fn retry_export_job(
    app: AppHandle,
    runtime: State<export::ExportRuntime>,
    job_id: String,
) -> Result<Vec<export::ExportJobSnapshot>, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    export::retry_export_job(&connection, &job_id)?;
    let resource_dir = app.path().resource_dir().ok();
    let completed = runtime.run_jobs(&connection, resource_dir, Some(vec![job_id]));
    record_export_activity(&connection, &completed)?;
    Ok(completed)
}

#[tauri::command]
fn cancel_export_job(
    app: AppHandle,
    runtime: State<export::ExportRuntime>,
    job_id: String,
) -> Result<bool, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(&path).map_err(|error| error.to_string())?;
    runtime.cancel_job(&connection, &job_id)
}

#[tauri::command]
fn prepare_region_drag_file(
    app: AppHandle,
    asset_id: String,
    display_name: Option<String>,
    format: String,
    region_start_seconds: f64,
    region_end_seconds: f64,
    loop_crossfade_seconds: Option<f64>,
    loop_crossfade_slope: Option<f64>,
    region_fade_gap_seconds: Option<f64>,
    region_fade_in_seconds: Option<f64>,
    region_fade_in_slope: Option<f64>,
    region_fade_out_seconds: Option<f64>,
    region_fade_out_slope: Option<f64>,
    format_settings_json: Option<String>,
    processing_json: String,
    processing_hash: String,
    temp_folder: Option<String>,
) -> Result<export::PreparedRegionDragFile, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let resource_dir = app.path().resource_dir().ok();
    let temp_root = resolve_export_drag_temp_root(temp_folder)?;
    export::prepare_region_drag_file(
        &connection,
        &temp_root,
        resource_dir.as_deref(),
        export::TempRegionExportInput {
            asset_id,
            display_name,
            format,
            region_start_seconds,
            region_end_seconds,
            loop_crossfade_seconds,
            loop_crossfade_slope,
            region_fade_gap_seconds,
            region_fade_in_seconds,
            region_fade_in_slope,
            region_fade_out_seconds,
            region_fade_out_slope,
            format_settings_json: format_settings_json.unwrap_or_else(|| "{}".to_string()),
            processing_json,
            processing_hash,
        },
    )
}

#[tauri::command]
fn prepare_asset_drag_file(
    app: AppHandle,
    asset_id: String,
    display_name: Option<String>,
    format: String,
    export_scope: String,
    region_start_seconds: Option<f64>,
    region_end_seconds: Option<f64>,
    loop_crossfade_seconds: Option<f64>,
    loop_crossfade_slope: Option<f64>,
    region_fade_gap_seconds: Option<f64>,
    region_fade_in_seconds: Option<f64>,
    region_fade_in_slope: Option<f64>,
    region_fade_out_seconds: Option<f64>,
    region_fade_out_slope: Option<f64>,
    format_settings_json: Option<String>,
    processing_json: String,
    processing_hash: String,
    temp_folder: Option<String>,
) -> Result<export::PreparedRegionDragFile, String> {
    apply_migrations(&app)?;
    let path = migrations::app_database_path(&app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    let resource_dir = app.path().resource_dir().ok();
    let temp_root = resolve_export_drag_temp_root(temp_folder)?;
    export::prepare_asset_drag_file(
        &connection,
        &temp_root,
        resource_dir.as_deref(),
        export::TempAssetDragExportInput {
            asset_id,
            display_name,
            format,
            export_scope,
            region_start_seconds,
            region_end_seconds,
            loop_crossfade_seconds,
            loop_crossfade_slope,
            region_fade_gap_seconds,
            region_fade_in_seconds,
            region_fade_in_slope,
            region_fade_out_seconds,
            region_fade_out_slope,
            format_settings_json: format_settings_json.unwrap_or_else(|| "{}".to_string()),
            processing_json,
            processing_hash,
        },
    )
}

#[tauri::command]
fn delete_prepared_drag_files(paths: Vec<String>) -> Result<usize, String> {
    export::delete_prepared_drag_files(paths)
}

#[tauri::command]
fn start_native_file_drag(
    window: WebviewWindow,
    request: os_drag::StartNativeFileDragRequest,
) -> os_drag::StartNativeFileDragResponse {
    let (sender, receiver) = mpsc::channel();
    let schedule_result = window.run_on_main_thread(move || {
        let _ = sender.send(os_drag::start_native_file_drag_on_window_thread(request));
    });
    if let Err(error) = schedule_result {
        return os_drag::StartNativeFileDragResponse {
            ok: false,
            effect: "none".to_string(),
            error: Some(format!(
                "failed to schedule native drag on window thread: {error}"
            )),
            diagnostics: Vec::new(),
        };
    }
    receiver
        .recv()
        .unwrap_or_else(|error| os_drag::StartNativeFileDragResponse {
            ok: false,
            effect: "none".to_string(),
            error: Some(format!("native drag window thread failed: {error}")),
            diagnostics: Vec::new(),
        })
}

#[tauri::command]
fn diagnose_native_file_drag_payload(
    request: os_drag::StartNativeFileDragRequest,
) -> os_drag::StartNativeFileDragResponse {
    os_drag::diagnose_native_file_drag_payload(request)
}

#[derive(Clone)]
struct TauriProgressSink {
    app: AppHandle,
}

impl indexing::progress::ProgressSink for TauriProgressSink {
    fn emit_progress(&self, payload: indexing::progress::IndexingProgressPayload) {
        let _ = self.app.emit("indexing://progress", payload);
    }
}

#[derive(Clone)]
struct SqliteIndexingRepository {
    database_path: PathBuf,
}

impl SqliteIndexingRepository {
    fn new(database_path: PathBuf) -> Self {
        Self { database_path }
    }

    fn repository(&self) -> Result<DataRepository, String> {
        let connection =
            Connection::open(&self.database_path).map_err(|error| error.to_string())?;
        DataRepository::new(connection)
    }
}

impl IndexingRepository for SqliteIndexingRepository {
    fn upsert_source_scan_state(&self, source_id: &str, status: &str) -> Result<(), String> {
        self.repository()?.update_source_status(source_id, status)?;
        Ok(())
    }

    fn upsert_folder(&self, folder: IndexedFolder) -> Result<(), String> {
        self.repository()?.upsert_folder(FolderInput {
            id: None,
            source_id: folder.source_id,
            parent_id: None,
            path: folder.relative_path,
            name: folder.display_name,
            child_count: None,
            asset_count: None,
            indexed_status: Some(folder.indexed_status),
            last_indexed_at: Some(indexing::progress::now_stamp()),
        })?;
        Ok(())
    }

    fn upsert_folders_batch(&self, folders: Vec<IndexedFolder>) -> Result<usize, String> {
        let repo = self.repository()?;
        repo.connection()
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            let mut count = 0;
            for folder in folders {
                repo.upsert_folder(FolderInput {
                    id: None,
                    source_id: folder.source_id,
                    parent_id: None,
                    path: folder.relative_path,
                    name: folder.display_name,
                    child_count: None,
                    asset_count: None,
                    indexed_status: Some(folder.indexed_status),
                    last_indexed_at: Some(indexing::progress::now_stamp()),
                })?;
                count += 1;
            }
            Ok::<usize, String>(count)
        })();
        match result {
            Ok(count) => {
                repo.connection()
                    .execute_batch("COMMIT")
                    .map_err(|error| error.to_string())?;
                Ok(count)
            }
            Err(error) => {
                let _ = repo.connection().execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn upsert_asset_metadata(&self, asset: IndexedAssetMetadata) -> Result<(), String> {
        let repo = self.repository()?;
        upsert_indexed_asset(&repo, asset)?;
        Ok(())
    }

    fn upsert_asset_metadata_batch(
        &self,
        assets: Vec<IndexedAssetMetadata>,
    ) -> Result<usize, String> {
        let repo = self.repository()?;
        repo.connection()
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            let mut count = 0;
            for asset in assets {
                upsert_indexed_asset(&repo, asset)?;
                count += 1;
            }
            Ok::<usize, String>(count)
        })();
        match result {
            Ok(count) => {
                repo.connection()
                    .execute_batch("COMMIT")
                    .map_err(|error| error.to_string())?;
                Ok(count)
            }
            Err(error) => {
                let _ = repo.connection().execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn mark_asset_missing(
        &self,
        source_id: &str,
        normalized_relative_path: &str,
    ) -> Result<(), String> {
        let connection =
            Connection::open(&self.database_path).map_err(|error| error.to_string())?;
        for (id, metadata_json) in asset_ids_and_metadata(&connection, source_id)? {
            if metadata_relative_path(&metadata_json).as_deref() == Some(normalized_relative_path) {
                connection
                    .execute(
                        "UPDATE assets SET availability = 'missing', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                        params![id],
                    )
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    fn mark_asset_probe_failed(
        &self,
        source_id: &str,
        normalized_relative_path: &str,
        absolute_path: &str,
        error: &str,
    ) -> Result<(), String> {
        let repo = self.repository()?;
        let path = Path::new(absolute_path);
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(absolute_path)
            .to_string();
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase());
        let metadata_json = serde_json::json!({
            "normalizedRelativePath": normalized_relative_path,
            "probeError": error
        })
        .to_string();
        repo.upsert_asset(AssetInput {
            id: None,
            source_id: source_id.to_string(),
            folder_id: None,
            stable_key: format!("local:{normalized_relative_path}:probe_failed"),
            provider_asset_id: None,
            path_or_url: absolute_path.to_string(),
            preview_url: None,
            source_url: None,
            name,
            extension,
            format: None,
            duration_seconds: None,
            sample_rate: None,
            bit_depth: None,
            channels: None,
            byte_size: None,
            modified_at: None,
            content_hash: None,
            license: None,
            attribution: None,
            originator: None,
            description: None,
            tags: Vec::new(),
            metadata_json: Some(metadata_json),
            availability: Some("probe_failed".to_string()),
        })?;
        Ok(())
    }

    fn record_indexing_error(&self, error: IndexingErrorRecord) -> Result<(), String> {
        self.repository()?.record_activity(ActivityInput {
            id: None,
            activity_type: "indexing_error".to_string(),
            asset_id: None,
            source_id: Some(error.source_id),
            folder_id: None,
            collection_id: None,
            export_job_id: None,
            query: error.path,
            message: error.message,
            status: Some("error".to_string()),
            payload_json: Some(serde_json::json!({ "scope": error.scope }).to_string()),
        })?;
        Ok(())
    }

    fn record_activity(&self, source_id: &str, message: &str, status: &str) -> Result<(), String> {
        self.repository()?.record_activity(ActivityInput {
            id: None,
            activity_type: "indexing".to_string(),
            asset_id: None,
            source_id: Some(source_id.to_string()),
            folder_id: None,
            collection_id: None,
            export_job_id: None,
            query: None,
            message: message.to_string(),
            status: Some(status.to_string()),
            payload_json: None,
        })?;
        Ok(())
    }

    fn source_settings_json(&self, source_id: &str) -> Result<String, String> {
        Ok(self
            .repository()?
            .get_source(source_id)?
            .map(|source| source.settings_json)
            .unwrap_or_else(|| "{}".to_string()))
    }

    fn list_known_asset_paths(&self, source_id: &str) -> Result<Vec<KnownAssetPath>, String> {
        let connection =
            Connection::open(&self.database_path).map_err(|error| error.to_string())?;
        Ok(asset_ids_and_metadata(&connection, source_id)?
            .into_iter()
            .filter_map(|(_, metadata_json)| metadata_relative_path(&metadata_json))
            .map(|normalized_relative_path| KnownAssetPath {
                normalized_relative_path,
            })
            .collect())
    }
}

fn upsert_indexed_asset(repo: &DataRepository, asset: IndexedAssetMetadata) -> Result<(), String> {
    let folder_id = folder_path_for_asset(&asset.relative_path)
        .and_then(|folder_path| {
            repo.get_folder_by_path(&asset.source_id, &folder_path)
                .ok()
                .flatten()
        })
        .map(|folder| folder.id);
    let stable_key = stable_local_asset_key(
        &asset.normalized_relative_path,
        asset.byte_size,
        &asset.modified_at,
        None,
    );
    if let Some((tag_version, existing_folder_id)) =
        repo.asset_index_state(&asset.source_id, &stable_key)?
    {
        if tag_version >= TAG_ENRICHMENT_VERSION && existing_folder_id == folder_id {
            return Ok(());
        }
    }
    repo.upsert_asset(AssetInput {
        id: None,
        source_id: asset.source_id,
        folder_id,
        stable_key,
        provider_asset_id: None,
        path_or_url: asset.absolute_path,
        preview_url: None,
        source_url: None,
        name: asset.name,
        extension: Some(asset.extension),
        format: Some(asset.format),
        duration_seconds: asset.duration_seconds,
        sample_rate: asset.sample_rate,
        bit_depth: asset.bit_depth,
        channels: asset.channels,
        byte_size: Some(asset.byte_size),
        modified_at: Some(asset.modified_at),
        content_hash: None,
        license: asset.license,
        attribution: asset.attribution,
        originator: asset.originator,
        description: asset.description,
        tags: asset.tags,
        metadata_json: Some(asset.metadata_json),
        availability: Some("available".to_string()),
    })?;
    Ok(())
}

fn start_indexing_request(
    app: &AppHandle,
    runtime: &State<IndexingRuntime>,
    request: IndexingJobRequest,
) -> Result<IndexingJobHandle, String> {
    apply_migrations(app)?;
    let database_path = migrations::app_database_path(app)?;
    runtime.start_job(
        request,
        SqliteIndexingRepository::new(database_path),
        TauriProgressSink { app: app.clone() },
    )
}

fn canonical_folder_path(path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(path);
    let metadata = std::fs::metadata(&root).map_err(|error| error.to_string())?;
    let folder = if metadata.is_dir() {
        root
    } else {
        root.parent()
            .ok_or_else(|| "file has no parent folder".to_string())?
            .to_path_buf()
    };
    std::fs::canonicalize(folder).map_err(|error| error.to_string())
}

fn reject_internal_export_drag_path(path: &Path) -> Result<(), String> {
    if path.components().any(|component| {
        component
            .as_os_str()
            .eq_ignore_ascii_case("sonilabs-export-drag")
    }) {
        return Err("internal export drag folder cannot be added as a local library".to_string());
    }
    Ok(())
}

fn folder_path_for_asset(relative_path: &str) -> Option<String> {
    relative_path
        .rsplit_once('/')
        .map(|(folder, _)| folder.to_string())
        .filter(|folder| !folder.is_empty())
}

fn asset_ids_and_metadata(
    connection: &Connection,
    source_id: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut statement = connection
        .prepare("SELECT id, metadata_json FROM assets WHERE source_id = ?1")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![source_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let mut assets = Vec::new();
    for row in rows {
        assets.push(row.map_err(|error| error.to_string())?);
    }
    Ok(assets)
}

fn metadata_relative_path(metadata_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|value| {
            value
                .get("normalizedRelativePath")
                .and_then(|path| path.as_str())
                .map(|path| path.to_string())
        })
}

fn data_repository(app: &AppHandle) -> Result<DataRepository, String> {
    apply_migrations(app)?;
    let path = migrations::app_database_path(app)?;
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    DataRepository::new(connection)
}

fn browse_source_ids(
    repo: &DataRepository,
    scope: &BrowseSourceScopeInput,
) -> Result<Vec<String>, String> {
    Ok(repo
        .list_sources()?
        .into_iter()
        .filter(|source| source.status != "disabled")
        .filter(|source| match scope.kind.as_str() {
            "all" => true,
            "local" => source.kind == "local",
            "cloud" => {
                source.kind == "cloud"
                    && scope
                        .provider
                        .as_deref()
                        .map(|provider| source.provider == provider)
                        .unwrap_or(true)
            }
            "source" => scope
                .source_id
                .as_deref()
                .map(|source_id| source.id == source_id)
                .unwrap_or(false),
            _ => false,
        })
        .map(|source| source.id)
        .collect())
}

fn resolve_folder_absolute_path(
    connection: &Connection,
    folder_id: &str,
) -> Result<String, String> {
    let (root_uri, folder_path): (String, String) = connection
        .query_row(
            "SELECT s.root_uri, f.path
             FROM folders AS f
             JOIN sources AS s ON s.id = f.source_id
             WHERE f.id = ?1",
            params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "folder not found".to_string())?;
    let mut path = PathBuf::from(root_uri);
    for part in folder_path.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    Ok(path.to_string_lossy().to_string())
}

fn delete_asset_row(connection: &Connection, asset_id: &str) -> Result<bool, String> {
    connection
        .execute(
            "DELETE FROM asset_search_fts WHERE asset_id = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM asset_search_facets WHERE asset_id = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "DELETE FROM collection_items WHERE asset_id = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    let deleted = connection
        .execute("DELETE FROM assets WHERE id = ?1", params![asset_id])
        .map_err(|error| error.to_string())?;
    Ok(deleted > 0)
}

fn delete_folder_row(connection: &Connection, folder_id: &str) -> Result<bool, String> {
    let (source_id, folder_path): (String, String) = connection
        .query_row(
            "SELECT source_id, path FROM folders WHERE id = ?1",
            params![folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "folder not found".to_string())?;
    let prefix = format!("{folder_path}/");
    let mut folder_ids = Vec::new();
    let mut folder_statement = connection
        .prepare(
            "SELECT id FROM folders
             WHERE source_id = ?1 AND (path = ?2 OR path LIKE ?3)",
        )
        .map_err(|error| error.to_string())?;
    let rows = folder_statement
        .query_map(
            params![source_id, folder_path, format!("{prefix}%")],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    for row in rows {
        folder_ids.push(row.map_err(|error| error.to_string())?);
    }

    let mut asset_ids = Vec::new();
    for id in &folder_ids {
        let mut statement = connection
            .prepare("SELECT id FROM assets WHERE folder_id = ?1")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            asset_ids.push(row.map_err(|error| error.to_string())?);
        }
    }

    for asset_id in asset_ids {
        delete_asset_row(connection, &asset_id)?;
    }
    for id in &folder_ids {
        connection
            .execute(
                "DELETE FROM collection_items WHERE folder_id = ?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
    }
    let deleted = connection
        .execute(
            "DELETE FROM folders WHERE source_id = ?1 AND (path = ?2 OR path LIKE ?3)",
            params![source_id, folder_path, format!("{prefix}%")],
        )
        .map_err(|error| error.to_string())?;
    Ok(deleted > 0)
}

fn delete_failed_assets_in_scope(
    connection: &Connection,
    source_id: &str,
    relative_path: Option<&str>,
) -> Result<usize, String> {
    let normalized_scope = relative_path
        .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
        .filter(|path| !path.is_empty());
    let failed_ids = if let Some(scope) = normalized_scope.as_deref() {
        let prefix = format!("{scope}/%");
        let mut statement = connection
            .prepare(
                "SELECT id
                 FROM assets
                 WHERE source_id = ?1
                   AND availability = 'probe_failed'
                   AND (
                     json_extract(metadata_json, '$.normalizedRelativePath') = ?2 OR
                     json_extract(metadata_json, '$.normalizedRelativePath') LIKE ?3
                   )",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![source_id, scope, prefix], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        let mut statement = connection
            .prepare(
                "SELECT id
                 FROM assets
                 WHERE source_id = ?1
                   AND availability = 'probe_failed'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![source_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let result = (|| {
        let mut deleted = 0;
        for asset_id in failed_ids {
            if delete_asset_row(connection, &asset_id)? {
                deleted += 1;
            }
        }
        Ok::<usize, String>(deleted)
    })();
    match result {
        Ok(deleted) => {
            connection
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string())?;
            Ok(deleted)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn mark_retrying_failed_scope(
    connection: &Connection,
    source_id: &str,
    relative_path: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE sources
             SET status = 'indexing', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![source_id],
        )
        .map_err(|error| error.to_string())?;

    let normalized_scope = relative_path
        .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
        .filter(|path| !path.is_empty());
    if let Some(scope) = normalized_scope.as_deref() {
        connection
            .execute(
                "UPDATE folders
                 SET indexed_status = 'pending', updated_at = CURRENT_TIMESTAMP
                 WHERE source_id = ?1
                   AND indexed_status = 'error'
                   AND (path = ?2 OR path LIKE ?3)",
                params![source_id, scope, format!("{scope}/%")],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "UPDATE folders
                 SET indexed_status = 'pending', updated_at = CURRENT_TIMESTAMP
                 WHERE source_id = ?1
                   AND indexed_status = 'error'",
                params![source_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn mark_removed_failed_scope(
    connection: &Connection,
    source_id: &str,
    relative_path: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE sources
             SET status = 'active', updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1
               AND status IN ('error', 'offline')",
            params![source_id],
        )
        .map_err(|error| error.to_string())?;

    let normalized_scope = relative_path
        .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
        .filter(|path| !path.is_empty());
    if let Some(scope) = normalized_scope.as_deref() {
        connection
            .execute(
                "UPDATE folders
                 SET indexed_status = 'indexed', updated_at = CURRENT_TIMESTAMP
                 WHERE source_id = ?1
                   AND indexed_status = 'error'
                   AND (path = ?2 OR path LIKE ?3)",
                params![source_id, scope, format!("{scope}/%")],
            )
            .map_err(|error| error.to_string())?;
    } else {
        connection
            .execute(
                "UPDATE folders
                 SET indexed_status = 'indexed', updated_at = CURRENT_TIMESTAMP
                 WHERE source_id = ?1
                   AND indexed_status = 'error'",
                params![source_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn browse_folder_path(connection: &Connection, folder_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT path FROM folders WHERE id = ?1",
            params![folder_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "folder not found".to_string())
}

fn browse_assets_for_source(
    connection: &Connection,
    source_id: &str,
) -> Result<Vec<DbAssetBrowseRecord>, String> {
    let sql = asset_browse_sql("a.source_id = ?1");
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![source_id], db_asset_from_row)
        .map_err(|error| error.to_string())?;
    collect_db_assets(rows)
}

fn browse_asset_by_id(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<DbAssetBrowseRecord>, String> {
    let sql = asset_browse_sql("a.id = ?1");
    connection
        .query_row(&sql, params![asset_id], db_asset_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn resolve_browse_collection_id(
    connection: &Connection,
    collection_id: Option<&str>,
    collection_name: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(id) = collection_id.filter(|id| !id.trim().is_empty()) {
        if collection_exists(connection, id)? {
            return Ok(Some(id.to_string()));
        }
    }

    let name = collection_name;
    let Some(name) = name.map(normalize_collection_lookup) else {
        return Ok(None);
    };

    connection
        .query_row(
            "SELECT id
             FROM collections
             WHERE parent_id IS NULL
               AND (
                 lower(name) = ?1 OR
                 replace(lower(name), ' ', '-') = ?1 OR
                 replace(lower(name), ' ', '') = replace(?1, '-', '')
               )
             ORDER BY sort_order, name
             LIMIT 1",
            params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn collection_exists(connection: &Connection, collection_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM collections WHERE id = ?1)",
            params![collection_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn normalize_collection_lookup(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_lowercase()
}

fn browse_assets_for_collection(
    connection: &Connection,
    collection_id: &str,
    limit: i64,
) -> Result<Vec<DbAssetBrowseRecord>, String> {
    let sql = format!(
        "WITH RECURSIVE collection_tree(id) AS (
            SELECT id FROM collections WHERE id = ?1
            UNION ALL
            SELECT c.id
            FROM collections AS c
            JOIN collection_tree AS tree ON c.parent_id = tree.id
         ),
         referenced_folders(source_id, path) AS (
            SELECT f.source_id, f.path
            FROM collection_items AS ci
            JOIN collection_tree AS tree ON tree.id = ci.collection_id
            JOIN folders AS f ON f.id = ci.folder_id
            WHERE ci.item_kind = 'folder_ref'
         ),
         referenced_sources(source_id) AS (
            SELECT ci.source_id
            FROM collection_items AS ci
            JOIN collection_tree AS tree ON tree.id = ci.collection_id
            WHERE ci.item_kind = 'source_ref'
         ),
         collection_asset_ids(asset_id) AS (
            SELECT ci.asset_id
            FROM collection_items AS ci
            JOIN collection_tree AS tree ON tree.id = ci.collection_id
            WHERE ci.item_kind = 'asset'
            UNION
            SELECT a.id
            FROM assets AS a
            JOIN folders AS f ON f.id = a.folder_id
            JOIN referenced_folders AS rf
              ON rf.source_id = f.source_id
             AND (f.path = rf.path OR f.path LIKE rf.path || '/%')
            UNION
            SELECT a.id
            FROM assets AS a
            JOIN referenced_sources AS rs ON rs.source_id = a.source_id
         )
         {}
         LIMIT ?2",
        asset_browse_sql("a.id IN (SELECT asset_id FROM collection_asset_ids)")
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![collection_id, limit], db_asset_from_row)
        .map_err(|error| error.to_string())?;
    collect_db_assets(rows)
}

fn search_asset_ids(
    connection: &Connection,
    query: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    if let Some(tag_query) = query.strip_prefix("__tag_any__:") {
        return search_asset_ids_by_any_tag(connection, tag_query, limit);
    }
    if let Some(tag_query) = query.strip_prefix("__user_tag_any__:") {
        return search_asset_ids_by_user_tag(connection, tag_query, limit);
    }
    if let Some(tag_query) = query.strip_prefix("__user_tag__:") {
        return search_asset_ids_by_user_tag(connection, tag_query, limit);
    }

    let mut statement = connection
        .prepare(
            "SELECT asset_id
             FROM asset_search_fts
             WHERE asset_search_fts MATCH ?1
             ORDER BY bm25(asset_search_fts), asset_id
             LIMIT ?2",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![query, limit], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

fn search_asset_ids_by_user_tag(
    connection: &Connection,
    tag_query: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut tags = tag_query
        .split('|')
        .filter_map(normalize_user_tag)
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    if tags.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(tags.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT asset_id
         FROM asset_user_tags
         WHERE tag IN ({placeholders})
         GROUP BY asset_id
         ORDER BY asset_id
         LIMIT ?"
    );
    let mut params = tags;
    params.push(limit.to_string());
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

fn search_asset_ids_by_any_tag(
    connection: &Connection,
    tag_query: &str,
    limit: i64,
) -> Result<Vec<String>, String> {
    let mut tags = tag_query
        .split('|')
        .flat_map(|tag| [canonicalize_tag(tag), normalize_user_tag(tag)])
        .flatten()
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    if tags.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(tags.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT asset_id
         FROM (
            SELECT asset_id, tag FROM asset_tags
            UNION
            SELECT asset_id, tag FROM asset_user_tags
         )
         WHERE tag IN ({placeholders})
         GROUP BY asset_id
         ORDER BY asset_id
         LIMIT ?"
    );
    let mut params = tags;
    params.push(limit.to_string());
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(params.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

fn asset_browse_sql(predicate: &str) -> String {
    format!(
        "SELECT a.id, a.source_id, a.name, a.duration_seconds, a.sample_rate,
                a.bit_depth, a.channels, a.format,
                json_extract(a.metadata_json, '$.codec') AS codec,
                a.byte_size,
                NULL AS peak_dbfs, NULL AS rms_dbfs, NULL AS clipping_samples,
                NULL AS headroom_db,
                s.display_name, s.provider, a.path_or_url, a.license,
                s.settings_json, a.originator, a.attribution, a.description,
                COALESCE(
                    (
                        SELECT json_group_array(tag)
                        FROM (
                            SELECT tag FROM asset_tags WHERE asset_id = a.id
                            UNION
                            SELECT tag FROM asset_user_tags WHERE asset_id = a.id
                        )
                    ),
                    '[]'
                ) AS tags_json,
                a.availability, COALESCE(facet.favorite, 0), f.path, a.metadata_json
         FROM assets AS a
         JOIN sources AS s ON s.id = a.source_id
         LEFT JOIN folders AS f ON f.id = a.folder_id
         LEFT JOIN asset_search_facets AS facet ON facet.asset_id = a.id
         WHERE {predicate}
         ORDER BY a.name, a.id"
    )
}

fn db_asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DbAssetBrowseRecord> {
    Ok(DbAssetBrowseRecord {
        id: row.get(0)?,
        source_id: row.get(1)?,
        name: row.get(2)?,
        duration_seconds: row.get(3)?,
        sample_rate: row.get(4)?,
        bit_depth: row.get(5)?,
        channels: row.get(6)?,
        format: row.get(7)?,
        codec: row.get(8)?,
        byte_size: row.get(9)?,
        peak_dbfs: row.get(10)?,
        rms_dbfs: row.get(11)?,
        clipping_samples: row.get(12)?,
        headroom_db: row.get(13)?,
        source_name: row.get(14)?,
        provider: row.get(15)?,
        path_or_url: row.get(16)?,
        license: row.get(17)?,
        source_settings_json: row.get(18)?,
        originator: row.get(19)?,
        attribution: row.get(20)?,
        description: row.get(21)?,
        tags: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(22)?).unwrap_or_default(),
        availability: row.get(23)?,
        favorite: row.get::<_, i64>(24)? == 1,
        folder_path: row.get(25)?,
        metadata_json: row.get(26)?,
    })
}

fn collect_db_assets<F>(
    rows: rusqlite::MappedRows<'_, F>,
) -> Result<Vec<DbAssetBrowseRecord>, String>
where
    F: FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<DbAssetBrowseRecord>,
{
    let mut assets = Vec::new();
    for row in rows {
        assets.push(row.map_err(|error| error.to_string())?);
    }
    Ok(assets)
}

fn direct_child_path(path: &str, parent_path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if parent_path.is_empty() {
        return !path.contains('/');
    }
    path.strip_prefix(parent_path)
        .and_then(|rest| rest.strip_prefix('/'))
        .map(|rest| !rest.is_empty() && !rest.contains('/'))
        .unwrap_or(false)
}

fn child_count(folders: &[FolderRecord], assets: &[DbAssetBrowseRecord], parent_path: &str) -> i64 {
    let folder_count = folders
        .iter()
        .filter(|folder| direct_child_path(&folder.path, parent_path))
        .count();
    let asset_count = assets
        .iter()
        .filter(|asset| asset_direct_folder(asset) == parent_path)
        .count();
    (folder_count + asset_count) as i64
}

fn asset_in_browse_scope(asset: &DbAssetBrowseRecord, current_path: &str) -> bool {
    path_in_browse_scope(&asset_direct_folder(asset), current_path)
}

fn path_in_browse_scope(path: &str, current_path: &str) -> bool {
    if current_path.is_empty() {
        return true;
    }
    path == current_path
        || path
            .strip_prefix(current_path)
            .and_then(|rest| rest.strip_prefix('/'))
            .is_some()
}

#[cfg(test)]
mod browse_path_tests {
    use super::{direct_child_path, path_in_browse_scope};

    #[test]
    fn direct_child_path_includes_only_next_level_folders() {
        assert!(!direct_child_path("", ""));
        assert!(direct_child_path("sound", ""));
        assert!(direct_child_path("sound/ui", "sound"));
        assert!(!direct_child_path("sound/ui/buttons", "sound"));
        assert!(!direct_child_path("sound", "sound"));
        assert!(!direct_child_path("soundtrack/ui", "sound"));
    }

    #[test]
    fn path_in_browse_scope_includes_current_and_nested_assets() {
        assert!(path_in_browse_scope("sound", "sound"));
        assert!(path_in_browse_scope("sound/ui", "sound"));
        assert!(path_in_browse_scope("sound/ui/buttons", "sound"));
        assert!(!path_in_browse_scope("soundtrack/ui", "sound"));
    }
}

fn asset_direct_folder(asset: &DbAssetBrowseRecord) -> String {
    asset
        .folder_path
        .clone()
        .or_else(|| metadata_folder_path(&asset.metadata_json))
        .unwrap_or_default()
}

fn metadata_folder_path(metadata_json: &str) -> Option<String> {
    let relative = serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|value| {
            value
                .get("normalizedRelativePath")
                .or_else(|| value.get("relativePath"))
                .and_then(|path| path.as_str())
                .map(|path| path.replace('\\', "/"))
        })?;
    relative
        .rsplit_once('/')
        .map(|(folder, _)| folder.to_string())
        .filter(|folder| !folder.is_empty())
}

fn asset_relative_path(asset: &DbAssetBrowseRecord) -> String {
    serde_json::from_str::<serde_json::Value>(&asset.metadata_json)
        .ok()
        .and_then(|value| {
            value
                .get("relativePath")
                .or_else(|| value.get("normalizedRelativePath"))
                .and_then(|path| path.as_str())
                .map(|path| path.to_string())
        })
        .unwrap_or_else(|| asset.path_or_url.clone())
}

fn source_metadata_file(settings_json: &str) -> Option<String> {
    let settings = serde_json::from_str::<serde_json::Value>(settings_json).ok()?;
    if !settings
        .get("metadataImportEnabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    settings
        .get("metadataFile")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Path::new(value)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(value)
                .to_string()
        })
}

fn folder_status(status: &str) -> String {
    match status {
        "indexing" => "indexing",
        "error" => "error",
        "missing" => "partial",
        _ => "indexed",
    }
    .to_string()
}

fn asset_availability(status: &str) -> String {
    match status {
        "available" => "available",
        "download_required" => "download-required",
        _ => "missing",
    }
    .to_string()
}

fn asset_matches_favorite_filter(
    asset: &DbAssetBrowseRecord,
    favorite_filter: Option<bool>,
) -> bool {
    favorite_filter
        .map(|expected| asset.favorite == expected)
        .unwrap_or(true)
}

fn asset_browse_row(asset: DbAssetBrowseRecord) -> DatabaseBrowseRow {
    let relative_path = asset_relative_path(&asset);
    let metadata_file = source_metadata_file(&asset.source_settings_json);
    DatabaseBrowseRow::Asset {
        id: asset.id,
        name: asset.name,
        duration_seconds: asset.duration_seconds,
        sample_rate: asset.sample_rate,
        bit_depth: asset.bit_depth,
        channels: asset.channels,
        format: asset.format,
        codec: asset.codec,
        file_size_bytes: asset.byte_size,
        peak_dbfs: asset.peak_dbfs,
        rms_dbfs: asset.rms_dbfs,
        clipping: asset.clipping_samples.map(|count| count > 0),
        headroom_db: asset.headroom_db,
        source_name: asset.source_name,
        provider: Some(asset.provider),
        relative_path,
        license: asset.license,
        metadata_file,
        originator: asset.originator,
        attribution: asset.attribution,
        description: asset.description,
        tags: asset.tags,
        imported: true,
        favorite: asset.favorite,
        availability: asset_availability(&asset.availability),
    }
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn directory_size_bytes(path: &Path) -> i64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            entry
                .metadata()
                .map(|metadata| {
                    if metadata.is_dir() {
                        directory_size_bytes(&entry.path())
                    } else {
                        metadata.len() as i64
                    }
                })
                .unwrap_or(0)
        })
        .sum()
}

fn resolve_export_drag_temp_root(temp_folder: Option<String>) -> Result<PathBuf, String> {
    let path = temp_folder
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    if !path.is_dir() {
        return Err("temp export folder must be a directory".to_string());
    }
    std::fs::canonicalize(path).map_err(|error| error.to_string())
}

fn backend_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{prefix}_{nanos}")
}

fn record_export_activity(
    connection: &Connection,
    jobs: &[export::ExportJobSnapshot],
) -> Result<(), String> {
    connection
        .execute(
            "INSERT OR IGNORE INTO collections (id, parent_id, name, sort_order)
             VALUES (?1, NULL, 'Export Queue', 100)",
            params![backend_id("collection"),],
        )
        .map_err(|error| error.to_string())?;
    let export_queue_id: String = connection
        .query_row(
            "SELECT id FROM collections WHERE parent_id IS NULL AND name = 'Export Queue'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    for job in jobs {
        if let Some(asset_id) = job.asset_id.as_deref() {
            connection
                .execute(
                    "INSERT INTO collection_items (
                        id, collection_id, item_kind, asset_id, source_id, folder_id, note
                     )
                     SELECT ?1, ?2, 'asset', ?3, NULL, NULL, 'queued export'
                     WHERE NOT EXISTS (
                        SELECT 1 FROM collection_items
                        WHERE collection_id = ?2 AND item_kind = 'asset' AND asset_id = ?3
                     )",
                    params![backend_id("collection_item"), export_queue_id, asset_id],
                )
                .map_err(|error| error.to_string())?;
        }
        let is_failure = job.status == "failed";
        let activity_type = if is_failure {
            "export_failed"
        } else {
            "export"
        };
        let status = if is_failure { "error" } else { "success" };
        let message = if is_failure {
            format!(
                "Export failed: {}",
                job.error_message
                    .as_deref()
                    .unwrap_or("unknown export error")
            )
        } else {
            format!(
                "Exported {}",
                job.output_path
                    .as_deref()
                    .unwrap_or(job.output_folder.as_str())
            )
        };
        let payload_json = serde_json::json!({
            "viewKind": "export",
            "queryText": "collection:\"export queue\"",
            "jobId": job.id,
        })
        .to_string();
        connection
            .execute(
                "INSERT INTO activity (
                    id, activity_type, asset_id, source_id, folder_id, collection_id,
                    export_job_id, query, message, status, payload_json
                 ) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    backend_id("activity"),
                    activity_type,
                    job.asset_id.as_deref(),
                    export_queue_id,
                    job.id.as_str(),
                    "collection:\"export queue\"",
                    message,
                    status,
                    payload_json
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MainWindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn main_window_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|error| error.to_string())?;
    Ok(config_dir.join("main-window-state.json"))
}

fn restore_main_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let Ok(path) = main_window_state_path(app) else {
        return;
    };
    let Ok(json) = fs::read_to_string(path) else {
        return;
    };
    let Ok(state) = serde_json::from_str::<MainWindowState>(&json) else {
        return;
    };
    if state.width >= 640 && state.height >= 480 {
        let _ = window.set_size(PhysicalSize::new(state.width, state.height));
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    }
    if state.maximized {
        let _ = window.maximize();
    }
}

fn save_main_window_state(window: &Window) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let Ok(path) = main_window_state_path(app) else {
        return;
    };
    let Ok(position) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    if size.width < 640 || size.height < 480 {
        return;
    }
    let state = MainWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };
    if let Ok(json) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(path, json);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(IndexingRuntime::new())
        .manage(audio::AudioRuntime::new())
        .manage(cloud::CloudRuntime::new())
        .manage(export::ExportRuntime::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if apply_migrations(&app.handle().clone()).is_ok() {
                if let Ok(path) = migrations::app_database_path(&app.handle().clone()) {
                    if let Ok(connection) = Connection::open(path) {
                        let _ = recover_jobs_after_restart(&connection);
                        let _ = mark_unavailable_sources(&connection);
                    }
                }
            }
            restore_main_window_state(&app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_)
            | WindowEvent::Resized(_)
            | WindowEvent::CloseRequested { .. } => {
                save_main_window_state(window);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app_status,
            app_paths,
            migration_status,
            run_migrations,
            write_structured_log,
            export_local_logs,
            validate_ffmpeg_sidecar,
            register_local_folder,
            start_indexing_job,
            cancel_indexing_job,
            reindex_local_source,
            reindex_local_folder,
            remove_failed_assets,
            retry_failed_assets,
            start_folder_watch,
            stop_folder_watch,
            create_source,
            update_source,
            list_sources,
            delete_source,
            update_source_status,
            upsert_folder,
            list_source_folders,
            upsert_asset,
            get_asset_by_stable_key,
            asset_tags,
            asset_user_metadata,
            update_asset_user_metadata,
            list_region_notes,
            upsert_region_note,
            delete_region_note,
            rebuild_asset_search_index,
            search_assets,
            browse_database,
            tag_summary,
            resolve_browse_row_path,
            delete_browse_row,
            create_collection,
            list_collections,
            rename_collection,
            delete_collection,
            add_collection_asset,
            add_collection_folder_ref,
            add_collection_source_ref,
            list_collection_items,
            record_activity,
            list_activity,
            delete_activity,
            clear_activity,
            upsert_cache_entry,
            touch_cache_entry,
            cache_management_summary,
            license_attribution_report,
            update_flow_status,
            enforce_cache_limit,
            database_integrity_check,
            app_restart_recovery,
            resolve_preview_file,
            read_preview_file_bytes,
            setup_freesound_credentials,
            freesound_search,
            cache_freesound_preview,
            import_freesound_original,
            set_cloud_provider_enabled,
            internet_archive_search,
            import_manual_cloud_asset,
            import_cloud_original,
            get_cached_waveform_peak_range,
            get_cached_waveform_peaks,
            get_waveform_peaks,
            analyze_audio_levels,
            cancel_audio_job,
            audio_runtime_status,
            queue_export_job,
            queue_export_jobs,
            list_export_jobs,
            retry_export_job,
            cancel_export_job,
            prepare_region_drag_file,
            prepare_asset_drag_file,
            delete_prepared_drag_files,
            start_native_file_drag,
            diagnose_native_file_drag_payload,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
