use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::Duration;

use reqwest::blocking::{Client, Response};
use reqwest::{StatusCode, Url};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::data_layer::{stable_cloud_asset_key, SourceRecord};

const FREESOUND_API_ROOT: &str = "https://freesound.org/apiv2";
const FREESOUND_SOURCE_ROOT: &str = "https://freesound.org";
const FREESOUND_FIELDS: &str = "id,name,description,tags,username,license,duration,type,filesize,previews,url,download,avg_rating,created,num_downloads";
const ARCHIVE_API_ROOT: &str = "https://archive.org";
const ARCHIVE_SOURCE_ROOT: &str = "https://archive.org/details";
const OPENGAMEART_SOURCE_ROOT: &str = "https://opengameart.org";
const PIXABAY_SOURCE_ROOT: &str = "https://pixabay.com";
const USER_AGENT: &str = "Sonilabs Sound Library Processor";
static NEXT_CLOUD_ID: AtomicU64 = AtomicU64::new(1);

pub struct CloudRuntime {
    session_tokens: Mutex<HashMap<String, String>>,
    client: Client,
}

impl CloudRuntime {
    pub fn new() -> Self {
        Self {
            session_tokens: Mutex::new(HashMap::new()),
            client: Client::new(),
        }
    }

    fn remember_token(&self, source_id: &str, token: Option<&str>) {
        let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else {
            return;
        };
        if let Ok(mut tokens) = self.session_tokens.lock() {
            tokens.insert(source_id.to_string(), token.to_string());
        }
    }

    fn token_for_source(&self, source: &SourceRecord) -> Result<String, String> {
        if let Ok(tokens) = self.session_tokens.lock() {
            if let Some(token) = tokens.get(&source.id) {
                return Ok(token.clone());
            }
        }
        let settings: Value =
            serde_json::from_str(&source.settings_json).unwrap_or_else(|_| serde_json::json!({}));
        let credential_ref = settings
            .get("credentialRef")
            .and_then(|value| value.as_str())
            .unwrap_or("env:FREESOUND_API_TOKEN");
        if let Some(env_name) = credential_ref.strip_prefix("env:") {
            return std::env::var(env_name)
                .map_err(|_| format!("{env_name} is not set for Freesound credentials"));
        }
        Err("Freesound token is not available in this session".to_string())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreesoundCredentialSetup {
    pub source_id: Option<String>,
    pub display_name: Option<String>,
    pub token: Option<String>,
    pub token_ref: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreesoundCredentialSetupResult {
    pub source: SourceRecord,
    pub credential_ref: String,
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FreesoundSearchRequest {
    pub source_id: Option<String>,
    pub query: Option<String>,
    pub license: Option<String>,
    pub duration_min: Option<f64>,
    pub duration_max: Option<f64>,
    pub tags: Vec<String>,
    pub format: Option<String>,
    pub rating_min: Option<f64>,
    pub uploader: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
    pub allow_non_commercial: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FreesoundSearchResult {
    pub source_id: String,
    pub imported: usize,
    pub total: Option<u32>,
    pub query_url: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InternetArchiveSearchRequest {
    pub source_id: Option<String>,
    pub query: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InternetArchiveSearchResult {
    pub source_id: String,
    pub imported: usize,
    pub total: Option<u32>,
    pub query_url: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderEnabledRequest {
    pub provider: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProviderEnabledResult {
    pub source: SourceRecord,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCloudImportRequest {
    pub provider: String,
    pub file_path: String,
    pub asset_page: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub license: Option<String>,
    pub attribution_text: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualCloudImportResult {
    pub source_id: String,
    pub asset_id: String,
    pub license: String,
    pub license_status: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPreviewCacheResult {
    pub asset_id: String,
    pub path: String,
    pub byte_size: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudOriginalImportResult {
    pub asset_id: String,
    pub path: String,
    pub byte_size: i64,
}

#[derive(Debug, Deserialize)]
struct FreesoundSearchResponse {
    count: Option<u32>,
    results: Vec<FreesoundSound>,
}

#[derive(Debug, Deserialize)]
struct ArchiveSearchResponse {
    response: ArchiveSearchBody,
}

#[derive(Debug, Deserialize)]
struct ArchiveSearchBody {
    #[serde(rename = "numFound")]
    num_found: Option<u32>,
    docs: Vec<ArchiveSearchDoc>,
}

#[derive(Debug, Deserialize, Clone)]
struct ArchiveSearchDoc {
    identifier: String,
}

#[derive(Debug, Deserialize)]
struct ArchiveMetadataResponse {
    metadata: Value,
    #[serde(default)]
    files: Vec<ArchiveFile>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
struct ArchiveFile {
    name: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    length: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    mtime: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct FreesoundSound {
    id: u64,
    name: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
    username: Option<String>,
    license: Option<String>,
    duration: Option<f64>,
    #[serde(rename = "type")]
    sound_type: Option<String>,
    filesize: Option<i64>,
    previews: Option<FreesoundPreviews>,
    url: Option<String>,
    download: Option<String>,
    avg_rating: Option<f64>,
    created: Option<String>,
    num_downloads: Option<u64>,
}

#[derive(Debug, Deserialize, Clone, Serialize)]
struct FreesoundPreviews {
    #[serde(default)]
    #[serde(rename = "preview-hq-mp3")]
    hq_mp3: Option<String>,
    #[serde(default)]
    #[serde(rename = "preview-lq-mp3")]
    lq_mp3: Option<String>,
    #[serde(default)]
    #[serde(rename = "preview-hq-ogg")]
    hq_ogg: Option<String>,
    #[serde(default)]
    #[serde(rename = "preview-lq-ogg")]
    lq_ogg: Option<String>,
}

pub fn setup_freesound_credentials(
    connection: &Connection,
    runtime: &CloudRuntime,
    input: FreesoundCredentialSetup,
) -> Result<FreesoundCredentialSetupResult, String> {
    let credential_ref = input
        .token_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("env:FREESOUND_API_TOKEN")
        .to_string();
    let settings_json = serde_json::json!({
        "credentialRef": credential_ref,
        "hasSessionToken": input.token.as_deref().map(str::trim).is_some_and(|token| !token.is_empty()),
        "secretStored": false
    })
    .to_string();
    let source = match input.source_id.as_deref() {
        Some(source_id) => update_freesound_source(
            connection,
            source_id,
            input.display_name.as_deref().unwrap_or("Freesound"),
            &settings_json,
        )?,
        None => match find_freesound_source(connection)? {
            Some(existing) => update_freesound_source(
                connection,
                &existing.id,
                input
                    .display_name
                    .as_deref()
                    .unwrap_or(&existing.display_name),
                &settings_json,
            )?,
            None => create_freesound_source(
                connection,
                input.display_name.as_deref().unwrap_or("Freesound"),
                &settings_json,
            )?,
        },
    };
    runtime.remember_token(&source.id, input.token.as_deref());
    let warning = if input
        .token
        .as_deref()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .is_some()
    {
        Some(
            "Session token is in memory only; set an env: credential ref for persistence."
                .to_string(),
        )
    } else {
        None
    };
    Ok(FreesoundCredentialSetupResult {
        source,
        credential_ref,
        warning,
    })
}

pub fn search_freesound(
    connection: &Connection,
    runtime: &CloudRuntime,
    request: FreesoundSearchRequest,
) -> Result<FreesoundSearchResult, String> {
    let source = resolve_freesound_source(connection, request.source_id.as_deref())?;
    ensure_source_enabled(&source)?;
    let token = runtime.token_for_source(&source)?;
    let url = build_freesound_search_url(FREESOUND_API_ROOT, &request, None)?;
    let response = execute_with_retry(|| {
        runtime
            .client
            .get(url.clone())
            .header("User-Agent", USER_AGENT)
            .header(reqwest::header::AUTHORIZATION, format!("Token {token}"))
            .send()
            .map_err(|error| error.to_string())
    })?;
    let query_url = strip_token(url.as_str());
    let payload: FreesoundSearchResponse = response.json().map_err(|error| error.to_string())?;
    let mut imported = 0;
    for sound in payload.results {
        upsert_freesound_sound(connection, &source.id, sound)?;
        imported += 1;
    }
    Ok(FreesoundSearchResult {
        source_id: source.id,
        imported,
        total: payload.count,
        query_url,
        warnings: Vec::new(),
    })
}

pub fn set_cloud_provider_enabled(
    connection: &Connection,
    request: CloudProviderEnabledRequest,
) -> Result<CloudProviderEnabledResult, String> {
    let provider = normalize_provider_id(&request.provider)?;
    let source = ensure_cloud_source(
        connection,
        &provider,
        provider_display_name(&provider),
        provider_root_uri(&provider),
        &provider_settings_json(request.enabled),
        if request.enabled {
            "active"
        } else {
            "disabled"
        },
    )?;
    Ok(CloudProviderEnabledResult {
        enabled: source_is_enabled(&source),
        source,
    })
}

pub fn search_internet_archive(
    connection: &Connection,
    runtime: &CloudRuntime,
    request: InternetArchiveSearchRequest,
) -> Result<InternetArchiveSearchResult, String> {
    let source = resolve_or_create_provider_source(
        connection,
        "internet_archive",
        "Internet Archive",
        ARCHIVE_SOURCE_ROOT,
    )?;
    ensure_source_enabled(&source)?;
    if let Some(source_id) = request.source_id.as_deref() {
        if source_id != source.id {
            return Err("Internet Archive source not found".to_string());
        }
    }

    let url = build_internet_archive_search_url(ARCHIVE_API_ROOT, &request)?;
    let response = execute_with_retry(|| {
        runtime
            .client
            .get(url.clone())
            .header("User-Agent", USER_AGENT)
            .send()
            .map_err(|error| error.to_string())
    })?;
    let payload: ArchiveSearchResponse = response.json().map_err(|error| error.to_string())?;
    let mut imported = 0;
    let mut warnings = Vec::new();
    for doc in payload.response.docs {
        match fetch_archive_metadata(&runtime.client, &doc.identifier) {
            Ok(metadata) => match upsert_archive_item(connection, &source.id, metadata) {
                Ok(count) => imported += count,
                Err(error) => warnings.push(format!("{}: {error}", doc.identifier)),
            },
            Err(error) => warnings.push(format!("{}: {error}", doc.identifier)),
        }
    }
    Ok(InternetArchiveSearchResult {
        source_id: source.id,
        imported,
        total: payload.response.num_found,
        query_url: url.to_string(),
        warnings,
    })
}

pub fn import_manual_cloud_asset(
    connection: &Connection,
    request: ManualCloudImportRequest,
) -> Result<ManualCloudImportResult, String> {
    let provider = normalize_provider_id(&request.provider)?;
    if provider != "opengameart" && provider != "pixabay" {
        return Err("Manual cloud import supports OpenGameArt and Pixabay only".to_string());
    }
    let file_path = request.file_path.trim();
    if file_path.is_empty() {
        return Err("Manual import file path is required".to_string());
    }
    if !Path::new(file_path).is_file() {
        return Err("Manual import file path does not exist".to_string());
    }
    let asset_page = request.asset_page.trim();
    if asset_page.is_empty() {
        return Err("Manual import source page is required".to_string());
    }
    let source = resolve_or_create_provider_source(
        connection,
        &provider,
        provider_display_name(&provider),
        provider_root_uri(&provider),
    )?;
    ensure_source_enabled(&source)?;
    let license_raw = request.license.as_deref().unwrap_or("unknown");
    let license = normalize_license(license_raw);
    let license_status = license_status(&license, license_raw);
    let author = request
        .author
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let title = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            Path::new(file_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("Manual cloud asset")
                .to_string()
        });
    let attribution = request
        .attribution_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| attribution_text(&license, author, asset_page));
    let extension = extension_from_name(file_path);
    let tags = request.tags.clone();
    let metadata_json = serde_json::json!({
        "provider": provider,
        "sourceUrl": asset_page,
        "assetPage": asset_page,
        "author": author,
        "licenseRaw": license_raw,
        "license": license,
        "licenseStatus": license_status,
        "attributionText": attribution,
        "rightsFlags": rights_flags_for_license(&license, &license_status),
        "manualImport": true,
        "importedAt": now_millis_string()
    })
    .to_string();
    let stable_key = stable_cloud_asset_key(&format!("{provider}:{asset_page}:{file_path}"));
    let asset_id = make_cloud_id("asset");
    connection
        .execute(
            "INSERT INTO assets (
                id, source_id, folder_id, stable_key, provider_asset_id, path_or_url,
                preview_url, source_url, name, extension, format, duration_seconds,
                sample_rate, bit_depth, channels, byte_size, modified_at, content_hash,
                license, attribution, originator, description, metadata_json, availability
             ) VALUES (
                ?1, ?2, NULL, ?3, ?4, ?5,
                NULL, ?6, ?7, ?8, ?8, NULL,
                NULL, NULL, NULL, NULL, NULL, NULL,
                ?9, ?10, ?11, ?12, ?13, 'available'
             )
             ON CONFLICT(source_id, stable_key) DO UPDATE SET
                path_or_url = excluded.path_or_url,
                source_url = excluded.source_url,
                name = excluded.name,
                extension = excluded.extension,
                format = excluded.format,
                license = excluded.license,
                attribution = excluded.attribution,
                originator = excluded.originator,
                description = excluded.description,
                metadata_json = excluded.metadata_json,
                availability = excluded.availability,
                updated_at = CURRENT_TIMESTAMP",
            params![
                asset_id,
                &source.id,
                stable_key,
                asset_page,
                file_path,
                asset_page,
                title,
                extension,
                license,
                attribution,
                author,
                request.description,
                metadata_json
            ],
        )
        .map_err(|error| error.to_string())?;
    let stored_asset = connection
        .query_row(
            "SELECT id FROM assets WHERE source_id = ?1 AND stable_key = ?2",
            params![&source.id, stable_key],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    replace_cloud_tags(connection, &stored_asset, &tags)?;
    index_cloud_asset(connection, &stored_asset)?;
    Ok(ManualCloudImportResult {
        source_id: source.id.clone(),
        asset_id: stored_asset,
        license,
        license_status,
    })
}

pub fn cache_freesound_preview(
    app: &AppHandle,
    connection: &Connection,
    runtime: &CloudRuntime,
    asset_id: &str,
) -> Result<CloudPreviewCacheResult, String> {
    if let Some(cached) = cached_cloud_preview(connection, asset_id)? {
        return Ok(cached);
    }
    let preview_url = connection
        .query_row(
            "SELECT preview_url FROM assets WHERE id = ?1",
            params![asset_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .flatten()
        .ok_or_else(|| "asset has no Freesound preview URL".to_string())?;
    let bytes = download_url(&runtime.client, &preview_url, None)?;
    let path = cloud_cache_dir(app)?
        .join("previews")
        .join(format!("{asset_id}.mp3"));
    write_cache_file(&path, &bytes)?;
    let byte_size = bytes.len() as i64;
    connection
        .execute(
            "INSERT INTO cache_entries (id, cache_key, kind, asset_id, path, byte_size, pinned)
             VALUES (?1, ?2, 'cloud_preview', ?3, ?4, ?5, 0)
             ON CONFLICT(cache_key) DO UPDATE SET
                path = excluded.path,
                byte_size = excluded.byte_size,
                last_accessed_at = CURRENT_TIMESTAMP",
            params![
                make_cloud_id("cache"),
                format!("cloud-preview:{asset_id}"),
                asset_id,
                path.to_string_lossy(),
                byte_size
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(CloudPreviewCacheResult {
        asset_id: asset_id.to_string(),
        path: path.to_string_lossy().to_string(),
        byte_size,
    })
}

pub fn import_freesound_original(
    app: &AppHandle,
    connection: &Connection,
    runtime: &CloudRuntime,
    asset_id: &str,
) -> Result<CloudOriginalImportResult, String> {
    let (source_id, metadata_json, name, format): (String, String, String, Option<String>) =
        connection
            .query_row(
                "SELECT source_id, metadata_json, name, format FROM assets WHERE id = ?1",
                params![asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
    let source = resolve_freesound_source(connection, Some(&source_id))?;
    let token = runtime.token_for_source(&source)?;
    let metadata: Value =
        serde_json::from_str(&metadata_json).unwrap_or_else(|_| serde_json::json!({}));
    let original_url = metadata
        .get("downloadUrl")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "Freesound original download URL is missing".to_string())?;
    let bytes = download_url(
        &runtime.client,
        original_url,
        Some(("Bearer", token.as_str())),
    )
    .map_err(|error| {
        format!("{error}; original Freesound downloads require an OAuth2 access token")
    })?;
    let extension = format
        .as_deref()
        .filter(|value| !value.is_empty())
        .or_else(|| name.rsplit_once('.').map(|(_, ext)| ext))
        .unwrap_or("audio");
    let safe_name = sanitize_file_name(&name);
    let path = cloud_cache_dir(app)?
        .join("originals")
        .join(format!("{asset_id}-{safe_name}.{extension}"));
    write_cache_file(&path, &bytes)?;
    let byte_size = bytes.len() as i64;
    connection
        .execute(
            "UPDATE assets
             SET path_or_url = ?2, availability = 'available', byte_size = COALESCE(byte_size, ?3), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![asset_id, path.to_string_lossy(), byte_size],
        )
        .map_err(|error| error.to_string())?;
    Ok(CloudOriginalImportResult {
        asset_id: asset_id.to_string(),
        path: path.to_string_lossy().to_string(),
        byte_size,
    })
}

pub fn import_cloud_original(
    app: &AppHandle,
    connection: &Connection,
    runtime: &CloudRuntime,
    asset_id: &str,
) -> Result<CloudOriginalImportResult, String> {
    let provider: String = connection
        .query_row(
            "SELECT s.provider
             FROM assets AS a
             JOIN sources AS s ON s.id = a.source_id
             WHERE a.id = ?1",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if provider == "freesound" {
        return import_freesound_original(app, connection, runtime, asset_id);
    }
    let (source_id, path_or_url, name, format): (String, String, String, Option<String>) =
        connection
            .query_row(
                "SELECT source_id, path_or_url, name, format FROM assets WHERE id = ?1",
                params![asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|error| error.to_string())?;
    let source = source_by_id(connection, &source_id)?
        .ok_or_else(|| "cloud source not found".to_string())?;
    ensure_source_enabled(&source)?;
    if Path::new(&path_or_url).is_file() {
        return Ok(CloudOriginalImportResult {
            asset_id: asset_id.to_string(),
            path: path_or_url,
            byte_size: 0,
        });
    }
    let bytes = download_url(&runtime.client, &path_or_url, None)?;
    let extension = format
        .as_deref()
        .filter(|value| !value.is_empty())
        .or_else(|| name.rsplit_once('.').map(|(_, ext)| ext))
        .unwrap_or("audio");
    let safe_name = sanitize_file_name(&name);
    let path = cloud_cache_dir(app)?
        .join(&provider)
        .join("originals")
        .join(format!("{asset_id}-{safe_name}.{extension}"));
    write_cache_file(&path, &bytes)?;
    let byte_size = bytes.len() as i64;
    connection
        .execute(
            "UPDATE assets
             SET path_or_url = ?2, availability = 'available', byte_size = COALESCE(byte_size, ?3), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![asset_id, path.to_string_lossy(), byte_size],
        )
        .map_err(|error| error.to_string())?;
    Ok(CloudOriginalImportResult {
        asset_id: asset_id.to_string(),
        path: path.to_string_lossy().to_string(),
        byte_size,
    })
}

pub fn build_freesound_search_url(
    api_root: &str,
    request: &FreesoundSearchRequest,
    _token: Option<&str>,
) -> Result<Url, String> {
    let mut url = Url::parse(&format!("{}/search/", api_root.trim_end_matches('/')))
        .map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("query", request.query.as_deref().unwrap_or(""))
        .append_pair("fields", FREESOUND_FIELDS)
        .append_pair("filter", &build_freesound_filter(request)?)
        .append_pair("page", &request.page.unwrap_or(1).max(1).to_string())
        .append_pair(
            "page_size",
            &request.page_size.unwrap_or(50).clamp(1, 150).to_string(),
        );
    Ok(url)
}

pub fn build_internet_archive_search_url(
    api_root: &str,
    request: &InternetArchiveSearchRequest,
) -> Result<Url, String> {
    let mut url = Url::parse(&format!(
        "{}/advancedsearch.php",
        api_root.trim_end_matches('/')
    ))
    .map_err(|error| error.to_string())?;
    let user_query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("*:*");
    let archive_query = if user_query == "*:*" {
        "mediatype:audio".to_string()
    } else {
        format!("({user_query}) AND mediatype:audio")
    };
    let fields = [
        "identifier",
        "title",
        "creator",
        "date",
        "description",
        "licenseurl",
        "rights",
        "mediatype",
        "publicdate",
        "downloads",
        "subject",
        "runtime",
    ];
    {
        let mut pairs = url.query_pairs_mut();
        pairs
            .append_pair("q", &archive_query)
            .append_pair("output", "json")
            .append_pair("page", &request.page.unwrap_or(1).max(1).to_string())
            .append_pair(
                "rows",
                &request.page_size.unwrap_or(25).clamp(1, 50).to_string(),
            );
        for field in fields {
            pairs.append_pair("fl[]", field);
        }
    }
    Ok(url)
}

pub fn build_freesound_filter(request: &FreesoundSearchRequest) -> Result<String, String> {
    let mut parts = Vec::new();
    let license = request.license.as_deref().unwrap_or("cc0");
    if is_non_commercial_license(license) && request.allow_non_commercial != Some(true) {
        return Err("Non-commercial Freesound licenses require explicit opt-in".to_string());
    }
    parts.push(format!("license:\"{}\"", freesound_license_name(license)));
    if request.duration_min.is_some() || request.duration_max.is_some() {
        parts.push(format!(
            "duration:[{} TO {}]",
            request
                .duration_min
                .map(|value| value.to_string())
                .unwrap_or_else(|| "*".to_string()),
            request
                .duration_max
                .map(|value| value.to_string())
                .unwrap_or_else(|| "*".to_string())
        ));
    }
    for tag in &request.tags {
        let tag = tag.trim();
        if !tag.is_empty() {
            parts.push(format!("tag:\"{}\"", tag.replace('"', "")));
        }
    }
    if let Some(format) = request
        .format
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("type:\"{}\"", format.replace('"', "")));
    }
    if let Some(rating) = request.rating_min {
        parts.push(format!("avg_rating:[{} TO *]", rating));
    }
    if let Some(uploader) = request
        .uploader
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("username:\"{}\"", uploader.replace('"', "")));
    }
    Ok(parts.join(" "))
}

pub fn retry_delay(
    status: StatusCode,
    retry_after: Option<&str>,
    attempt: usize,
) -> Option<Duration> {
    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        if let Some(seconds) = retry_after.and_then(|value| value.parse::<u64>().ok()) {
            return Some(Duration::from_secs(seconds.min(30)));
        }
        return Some(Duration::from_millis(
            250 * 2_u64.saturating_pow(attempt as u32),
        ));
    }
    None
}

fn execute_with_retry<F>(mut send: F) -> Result<Response, String>
where
    F: FnMut() -> Result<Response, String>,
{
    let mut attempt = 0;
    loop {
        let response = send()?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if attempt >= 3 {
            return Err(format!(
                "Freesound request failed with {status} after retry policy was exhausted"
            ));
        }
        if let Some(delay) = retry_delay(status, retry_after.as_deref(), attempt) {
            sleep(delay);
            attempt += 1;
            continue;
        }
        return Err(format!("Freesound request failed with {status}"));
    }
}

fn upsert_freesound_sound(
    connection: &Connection,
    source_id: &str,
    sound: FreesoundSound,
) -> Result<(), String> {
    let previews = sound.previews.clone();
    let preview_url = previews.as_ref().and_then(best_preview_url);
    let source_url = sound
        .url
        .clone()
        .unwrap_or_else(|| format!("{FREESOUND_SOURCE_ROOT}/s/{}/", sound.id));
    let license_raw = sound
        .license
        .clone()
        .unwrap_or_else(|| "unknown".to_string());
    let license = normalize_license(&license_raw);
    let license_status = license_status(&license, &license_raw);
    let attribution = attribution_text(&license, sound.username.as_deref(), &source_url);
    let tags = sound.tags.clone().unwrap_or_default();
    let metadata_json = serde_json::json!({
        "provider": "freesound",
        "freesoundId": sound.id,
        "uploader": sound.username,
        "licenseRaw": license_raw,
        "license": license,
        "licenseStatus": license_status,
        "rightsFlags": rights_flags_for_license(&license, &license_status),
        "tags": tags,
        "previews": previews,
        "previewUrl": preview_url,
        "sourceUrl": source_url,
        "downloadUrl": sound.download,
        "rating": sound.avg_rating,
        "created": sound.created,
        "downloadCount": sound.num_downloads,
        "attributionRequired": license != "cc0",
        "attributionText": attribution,
        "originalDownloadAvailable": sound.download.is_some()
    })
    .to_string();
    let stable_key = stable_cloud_asset_key(&format!("freesound:{}", sound.id));
    let asset_id = make_cloud_id("asset");
    let name = sound.name;
    let format = sound.sound_type;
    let originator = sound.username;
    let description = sound.description;
    let modified_at = sound.created;
    connection
        .execute(
            "INSERT INTO assets (
                id, source_id, folder_id, stable_key, provider_asset_id, path_or_url,
                preview_url, source_url, name, extension, format, duration_seconds,
                sample_rate, bit_depth, channels, byte_size, modified_at, content_hash,
                license, attribution, originator, description, metadata_json, availability
             ) VALUES (
                ?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                NULL, NULL, NULL, ?12, ?13, NULL, ?14, ?15, ?16, ?17, ?18, 'download_required'
             )
             ON CONFLICT(source_id, stable_key) DO UPDATE SET
                provider_asset_id = excluded.provider_asset_id,
                path_or_url = excluded.path_or_url,
                preview_url = excluded.preview_url,
                source_url = excluded.source_url,
                name = excluded.name,
                extension = excluded.extension,
                format = excluded.format,
                duration_seconds = excluded.duration_seconds,
                byte_size = excluded.byte_size,
                modified_at = excluded.modified_at,
                license = excluded.license,
                attribution = excluded.attribution,
                originator = excluded.originator,
                description = excluded.description,
                metadata_json = excluded.metadata_json,
                availability = excluded.availability,
                updated_at = CURRENT_TIMESTAMP",
            params![
                asset_id,
                source_id,
                stable_key,
                sound.id.to_string(),
                source_url,
                preview_url,
                source_url,
                name,
                format,
                format,
                sound.duration,
                sound.filesize,
                modified_at,
                license,
                attribution,
                originator,
                description,
                metadata_json
            ],
        )
        .map_err(|error| error.to_string())?;
    let stored_asset = connection
        .query_row(
            "SELECT id FROM assets WHERE source_id = ?1 AND stable_key = ?2",
            params![source_id, stable_key],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| error.to_string())?;
    replace_cloud_tags(connection, &stored_asset, &tags)?;
    index_cloud_asset(connection, &stored_asset)?;
    Ok(())
}

fn fetch_archive_metadata(
    client: &Client,
    identifier: &str,
) -> Result<ArchiveMetadataResponse, String> {
    let mut url =
        Url::parse(&format!("{ARCHIVE_API_ROOT}/metadata/")).map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "invalid Internet Archive metadata URL".to_string())?
        .push(identifier);
    let response = execute_with_retry(|| {
        client
            .get(url.clone())
            .header("User-Agent", USER_AGENT)
            .send()
            .map_err(|error| error.to_string())
    })?;
    response.json().map_err(|error| error.to_string())
}

fn upsert_archive_item(
    connection: &Connection,
    source_id: &str,
    item: ArchiveMetadataResponse,
) -> Result<usize, String> {
    let identifier = metadata_text(&item.metadata, "identifier")
        .ok_or_else(|| "Internet Archive item is missing identifier".to_string())?;
    let item_title = metadata_text(&item.metadata, "title").unwrap_or_else(|| identifier.clone());
    let source_url = format!("{ARCHIVE_SOURCE_ROOT}/{identifier}");
    let creator = metadata_text(&item.metadata, "creator")
        .or_else(|| metadata_text(&item.metadata, "uploader"));
    let description = metadata_text(&item.metadata, "description");
    let license_raw = metadata_text(&item.metadata, "licenseurl")
        .or_else(|| metadata_text(&item.metadata, "rights"))
        .unwrap_or_else(|| "unknown".to_string());
    let license = normalize_license(&license_raw);
    let license_status = license_status(&license, &license_raw);
    let attribution = attribution_text(&license, creator.as_deref(), &source_url);
    let subjects = metadata_text_list(&item.metadata, "subject");
    let files: Vec<ArchiveFile> = item
        .files
        .into_iter()
        .filter(is_archive_audio_file)
        .collect();
    let file_count = files.len();
    for file in &files {
        let file_url = archive_download_url(&identifier, &file.name)?;
        let format = archive_file_format(file);
        let name = file.title.clone().unwrap_or_else(|| file.name.clone());
        let metadata_json = serde_json::json!({
            "provider": "internet_archive",
            "archiveIdentifier": identifier,
            "archiveFile": file,
            "itemTitle": item_title,
            "sourceUrl": source_url,
            "downloadUrl": file_url,
            "licenseRaw": license_raw,
            "license": license,
            "licenseStatus": license_status,
            "rightsFlags": rights_flags_for_license(&license, &license_status),
            "attributionRequired": license != "cc0",
            "attributionText": attribution,
            "fileListFetched": true
        })
        .to_string();
        let stable_key =
            stable_cloud_asset_key(&format!("internet_archive:{identifier}:{}", file.name));
        let asset_id = make_cloud_id("asset");
        connection
            .execute(
                "INSERT INTO assets (
                    id, source_id, folder_id, stable_key, provider_asset_id, path_or_url,
                    preview_url, source_url, name, extension, format, duration_seconds,
                    sample_rate, bit_depth, channels, byte_size, modified_at, content_hash,
                    license, attribution, originator, description, metadata_json, availability
                 ) VALUES (
                    ?1, ?2, NULL, ?3, ?4, ?5,
                    ?5, ?6, ?7, ?8, ?9, ?10,
                    NULL, NULL, NULL, ?11, ?12, NULL,
                    ?13, ?14, ?15, ?16, ?17, 'download_required'
                 )
                 ON CONFLICT(source_id, stable_key) DO UPDATE SET
                    provider_asset_id = excluded.provider_asset_id,
                    path_or_url = excluded.path_or_url,
                    preview_url = excluded.preview_url,
                    source_url = excluded.source_url,
                    name = excluded.name,
                    extension = excluded.extension,
                    format = excluded.format,
                    duration_seconds = excluded.duration_seconds,
                    byte_size = excluded.byte_size,
                    modified_at = excluded.modified_at,
                    license = excluded.license,
                    attribution = excluded.attribution,
                    originator = excluded.originator,
                    description = excluded.description,
                    metadata_json = excluded.metadata_json,
                    availability = excluded.availability,
                    updated_at = CURRENT_TIMESTAMP",
                params![
                    asset_id,
                    source_id,
                    stable_key,
                    format!("{identifier}/{}", file.name),
                    file_url,
                    &source_url,
                    name,
                    extension_from_name(&file.name),
                    format,
                    parse_optional_f64(file.length.as_deref()),
                    parse_optional_i64(file.size.as_deref()),
                    file.mtime.clone(),
                    &license,
                    &attribution,
                    &creator,
                    &description,
                    metadata_json
                ],
            )
            .map_err(|error| error.to_string())?;
        let stored_asset = connection
            .query_row(
                "SELECT id FROM assets WHERE source_id = ?1 AND stable_key = ?2",
                params![source_id, stable_key],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| error.to_string())?;
        replace_cloud_tags(connection, &stored_asset, &subjects)?;
        index_cloud_asset(connection, &stored_asset)?;
    }
    Ok(file_count)
}

fn resolve_freesound_source(
    connection: &Connection,
    source_id: Option<&str>,
) -> Result<SourceRecord, String> {
    if let Some(source_id) = source_id {
        return source_by_id(connection, source_id)?
            .filter(|source| source.provider == "freesound")
            .ok_or_else(|| "Freesound source not found".to_string());
    }
    find_freesound_source(connection)?
        .ok_or_else(|| "Freesound source is not registered".to_string())
}

fn find_freesound_source(connection: &Connection) -> Result<Option<SourceRecord>, String> {
    find_cloud_source(connection, "freesound")
}

fn find_cloud_source(
    connection: &Connection,
    provider: &str,
) -> Result<Option<SourceRecord>, String> {
    connection
        .query_row(
            "SELECT id, kind, provider, display_name, root_uri, status, settings_json
             FROM sources
             WHERE kind = 'cloud' AND provider = ?1
             ORDER BY created_at
             LIMIT 1",
            params![provider],
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

fn resolve_or_create_provider_source(
    connection: &Connection,
    provider: &str,
    display_name: &str,
    root_uri: &str,
) -> Result<SourceRecord, String> {
    if let Some(source) = find_cloud_source(connection, provider)? {
        return Ok(source);
    }
    ensure_cloud_source(
        connection,
        provider,
        display_name,
        root_uri,
        &provider_settings_json(true),
        "active",
    )
}

fn source_by_id(connection: &Connection, source_id: &str) -> Result<Option<SourceRecord>, String> {
    connection
        .query_row(
            "SELECT id, kind, provider, display_name, root_uri, status, settings_json
             FROM sources
             WHERE id = ?1",
            params![source_id],
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

fn create_freesound_source(
    connection: &Connection,
    display_name: &str,
    settings_json: &str,
) -> Result<SourceRecord, String> {
    let id = make_cloud_id("source");
    connection
        .execute(
            "INSERT INTO sources (id, kind, provider, display_name, root_uri, status, settings_json)
             VALUES (?1, 'cloud', 'freesound', ?2, ?3, 'active', ?4)",
            params![id, display_name, FREESOUND_SOURCE_ROOT, settings_json],
        )
        .map_err(|error| error.to_string())?;
    source_by_id(connection, &id)?.ok_or_else(|| "created Freesound source not found".to_string())
}

fn update_freesound_source(
    connection: &Connection,
    source_id: &str,
    display_name: &str,
    settings_json: &str,
) -> Result<SourceRecord, String> {
    let changed = connection
        .execute(
            "UPDATE sources
             SET kind = 'cloud',
                 provider = 'freesound',
                 display_name = ?2,
                 root_uri = ?3,
                 status = 'active',
                 settings_json = ?4,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![
                source_id,
                display_name,
                FREESOUND_SOURCE_ROOT,
                settings_json
            ],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Freesound source not found".to_string());
    }
    source_by_id(connection, source_id)?
        .ok_or_else(|| "updated Freesound source not found".to_string())
}

fn ensure_cloud_source(
    connection: &Connection,
    provider: &str,
    display_name: &str,
    root_uri: &str,
    settings_json: &str,
    status: &str,
) -> Result<SourceRecord, String> {
    if let Some(existing) = find_cloud_source(connection, provider)? {
        connection
            .execute(
                "UPDATE sources
                 SET display_name = ?2,
                     root_uri = ?3,
                     status = ?4,
                     settings_json = ?5,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = ?1",
                params![&existing.id, display_name, root_uri, status, settings_json],
            )
            .map_err(|error| error.to_string())?;
        return source_by_id(connection, &existing.id)?
            .ok_or_else(|| "updated cloud source not found".to_string());
    }
    let id = make_cloud_id("source");
    connection
        .execute(
            "INSERT INTO sources (id, kind, provider, display_name, root_uri, status, settings_json)
             VALUES (?1, 'cloud', ?2, ?3, ?4, ?5, ?6)",
            params![id, provider, display_name, root_uri, status, settings_json],
        )
        .map_err(|error| error.to_string())?;
    source_by_id(connection, &id)?.ok_or_else(|| "created cloud source not found".to_string())
}

fn normalize_provider_id(provider: &str) -> Result<String, String> {
    match provider
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "freesound" => Ok("freesound".to_string()),
        "internet_archive" | "archive" | "ia" => Ok("internet_archive".to_string()),
        "opengameart" | "open_game_art" | "oga" => Ok("opengameart".to_string()),
        "pixabay" => Ok("pixabay".to_string()),
        _ => Err("Unsupported cloud provider".to_string()),
    }
}

fn provider_display_name(provider: &str) -> &'static str {
    match provider {
        "freesound" => "Freesound",
        "internet_archive" => "Internet Archive",
        "opengameart" => "OpenGameArt",
        "pixabay" => "Pixabay",
        _ => "Cloud Provider",
    }
}

fn provider_root_uri(provider: &str) -> &'static str {
    match provider {
        "freesound" => FREESOUND_SOURCE_ROOT,
        "internet_archive" => ARCHIVE_SOURCE_ROOT,
        "opengameart" => OPENGAMEART_SOURCE_ROOT,
        "pixabay" => PIXABAY_SOURCE_ROOT,
        _ => "",
    }
}

fn provider_settings_json(enabled: bool) -> String {
    serde_json::json!({ "enabled": enabled }).to_string()
}

fn source_is_enabled(source: &SourceRecord) -> bool {
    if source.status == "disabled" {
        return false;
    }
    let settings: Value =
        serde_json::from_str(&source.settings_json).unwrap_or_else(|_| serde_json::json!({}));
    settings
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn ensure_source_enabled(source: &SourceRecord) -> Result<(), String> {
    if source_is_enabled(source) {
        Ok(())
    } else {
        Err(format!("{} provider is disabled", source.display_name))
    }
}

fn replace_cloud_tags(
    connection: &Connection,
    asset_id: &str,
    tags: &[String],
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM asset_tags WHERE asset_id = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    for tag in tags {
        let normalized = tag.trim().to_ascii_lowercase();
        if normalized.is_empty() {
            continue;
        }
        connection
            .execute(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag) VALUES (?1, ?2)",
                params![asset_id, normalized],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn index_cloud_asset(connection: &Connection, asset_id: &str) -> Result<(), String> {
    let row = connection
        .query_row(
            "SELECT a.source_id, a.name, a.path_or_url, a.description, a.originator,
                    a.license, a.format, a.availability, a.duration_seconds,
                    a.byte_size, a.modified_at, a.metadata_json, s.display_name, s.provider
             FROM assets AS a
             JOIN sources AS s ON s.id = a.source_id
             WHERE a.id = ?1",
            params![asset_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<f64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    let tags = cloud_tags(connection, asset_id)?;
    let metadata: Value = serde_json::from_str(&row.11).unwrap_or_else(|_| serde_json::json!({}));
    let rating = metadata.get("rating").and_then(|value| value.as_f64());
    let license = row.5.clone().unwrap_or_else(|| "unknown".to_string());
    let license_status = metadata
        .get("licenseStatus")
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| license_status(&license, &license));
    let rights_flags = rights_flags_for_license(&license, &license_status).join(" ");
    connection
        .execute(
            "DELETE FROM asset_search_fts WHERE asset_id = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO asset_search_fts (
                asset_id, name, path, tags, description, originator, license,
                rights_flags, format, codec, source, source_kind, source_provider,
                status, dates, stats
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '', ?10, 'cloud', ?11, ?12, ?13, ?14)",
            params![
                asset_id,
                row.1,
                row.2,
                tags.join(" "),
                row.3,
                row.4,
                row.5,
                rights_flags,
                row.6,
                row.12,
                row.13,
                row.7,
                row.10,
                rating.map(|value| value.to_string()).unwrap_or_default()
            ],
        )
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO asset_search_facets (
                asset_id, source_id, folder_id, source_kind, source_provider, source_name,
                collection_names, favorite, availability, status, license, rights_flags,
                format, codec, bit_depth, byte_size, duration_seconds, sample_rate, channels,
                modified_at, indexed_at, imported_at, rating, waveform_cached
             ) VALUES (
                ?1, ?2, NULL, 'cloud', ?3, ?4,
                '', 0, ?5, ?5, ?6, ?7,
                ?8, NULL, NULL, ?9, ?10, NULL, NULL,
                ?11, CURRENT_TIMESTAMP, NULL, ?12, 0
             )
             ON CONFLICT(asset_id) DO UPDATE SET
                source_id = excluded.source_id,
                source_provider = excluded.source_provider,
                source_name = excluded.source_name,
                availability = excluded.availability,
                status = excluded.status,
                license = excluded.license,
                rights_flags = excluded.rights_flags,
                format = excluded.format,
                byte_size = excluded.byte_size,
                duration_seconds = excluded.duration_seconds,
                modified_at = excluded.modified_at,
                rating = excluded.rating,
                updated_at = CURRENT_TIMESTAMP",
            params![
                asset_id,
                row.0,
                row.13,
                row.12,
                row.7,
                row.5,
                rights_flags,
                row.6,
                row.9,
                row.8,
                row.10,
                rating
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn cloud_tags(connection: &Connection, asset_id: &str) -> Result<Vec<String>, String> {
    let mut statement = connection
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

fn cached_cloud_preview(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<CloudPreviewCacheResult>, String> {
    let cached = connection
        .query_row(
            "SELECT path, byte_size
             FROM cache_entries
             WHERE kind = 'cloud_preview' AND asset_id = ?1
             ORDER BY last_accessed_at DESC
             LIMIT 1",
            params![asset_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((path, byte_size)) = cached else {
        return Ok(None);
    };
    if !PathBuf::from(&path).is_file() {
        return Ok(None);
    }
    connection
        .execute(
            "UPDATE cache_entries SET last_accessed_at = CURRENT_TIMESTAMP WHERE kind = 'cloud_preview' AND asset_id = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(Some(CloudPreviewCacheResult {
        asset_id: asset_id.to_string(),
        path,
        byte_size,
    }))
}

fn download_url(
    client: &Client,
    url: &str,
    authorization: Option<(&str, &str)>,
) -> Result<Vec<u8>, String> {
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    let response = execute_with_retry(|| {
        let mut request = client.get(parsed.clone()).header("User-Agent", USER_AGENT);
        if let Some((scheme, token)) = authorization {
            request = request.header(reqwest::header::AUTHORIZATION, format!("{scheme} {token}"));
        }
        request.send().map_err(|error| error.to_string())
    })?;
    response
        .bytes()
        .map(|bytes| bytes.to_vec())
        .map_err(|error| error.to_string())
}

fn cloud_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("freesound");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn write_cache_file(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn best_preview_url(previews: &FreesoundPreviews) -> Option<String> {
    previews
        .hq_mp3
        .clone()
        .or_else(|| previews.lq_mp3.clone())
        .or_else(|| previews.hq_ogg.clone())
        .or_else(|| previews.lq_ogg.clone())
}

fn is_archive_audio_file(file: &ArchiveFile) -> bool {
    let name = file.name.to_ascii_lowercase();
    let audio_extension = [
        ".wav", ".mp3", ".ogg", ".oga", ".flac", ".aac", ".m4a", ".aif", ".aiff",
    ]
    .iter()
    .any(|extension| name.ends_with(extension));
    if audio_extension {
        return true;
    }
    file.format
        .as_deref()
        .map(|format| {
            let format = format.to_ascii_lowercase();
            ["wave", "wav", "mp3", "ogg", "flac", "aac", "m4a", "aiff"]
                .iter()
                .any(|token| format.contains(token))
        })
        .unwrap_or(false)
}

fn archive_file_format(file: &ArchiveFile) -> Option<String> {
    file.format
        .as_deref()
        .map(|format| format.to_ascii_lowercase())
        .or_else(|| extension_from_name(&file.name))
}

fn archive_download_url(identifier: &str, file_name: &str) -> Result<String, String> {
    let mut url =
        Url::parse(&format!("{ARCHIVE_API_ROOT}/download/")).map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "invalid Internet Archive download URL".to_string())?
        .push(identifier)
        .push(file_name);
    Ok(url.to_string())
}

fn metadata_text(metadata: &Value, key: &str) -> Option<String> {
    match metadata.get(key)? {
        Value::String(value) => Some(value.trim().to_string()).filter(|value| !value.is_empty()),
        Value::Array(values) => values
            .iter()
            .filter_map(|value| value.as_str())
            .map(str::trim)
            .find(|value| !value.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

fn metadata_text_list(metadata: &Value, key: &str) -> Vec<String> {
    match metadata.get(key) {
        Some(Value::String(value)) => vec![value.trim().to_ascii_lowercase()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str())
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_optional_i64(value: Option<&str>) -> Option<i64> {
    value.and_then(|value| value.trim().parse::<i64>().ok())
}

fn parse_optional_f64(value: Option<&str>) -> Option<f64> {
    value.and_then(|value| value.trim().parse::<f64>().ok())
}

fn extension_from_name(value: &str) -> Option<String> {
    Path::new(value)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
}

fn freesound_license_name(value: &str) -> &'static str {
    match value.trim().to_ascii_lowercase().as_str() {
        "cc0" | "creative commons 0" => "Creative Commons 0",
        "by" | "attribution" => "Attribution",
        "by-nc" | "attribution noncommercial" | "noncommercial" => "Attribution NonCommercial",
        _ => "Creative Commons 0",
    }
}

fn normalize_license(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "" => "unknown".to_string(),
        license
            if license.contains(',')
                || license.contains(" or ")
                || license.contains(" and ")
                || license.contains("various") =>
        {
            "ambiguous".to_string()
        }
        license
            if license.contains("creativecommons.org/publicdomain/zero")
                || license.contains("creative commons 0")
                || license.contains("cc0") =>
        {
            "cc0".to_string()
        }
        license if license.contains("public domain") => "public-domain".to_string(),
        license if license.contains("noncommercial") || license.contains("by-nc") => {
            "by-nc".to_string()
        }
        license if license.contains("sharealike") || license.contains("by-sa") => {
            "by-sa".to_string()
        }
        license if license.contains("opengameart") || license.contains("oga-by") => {
            "oga-by".to_string()
        }
        license if license.contains("pixabay") => "pixabay".to_string(),
        license if license.contains("gpl") => "gpl".to_string(),
        license if license.contains("attribution") || license.contains("by/") => "by".to_string(),
        license
            if license.contains("unknown")
                || license.contains("see metadata")
                || license.contains("see description") =>
        {
            "unknown".to_string()
        }
        _ => "unknown".to_string(),
    }
}

fn license_status(license: &str, raw: &str) -> String {
    if license == "unknown" {
        return "unknown".to_string();
    }
    if license == "ambiguous"
        || raw.to_ascii_lowercase().contains("various")
        || raw.contains(',')
        || raw.to_ascii_lowercase().contains(" or ")
        || raw.to_ascii_lowercase().contains(" and ")
    {
        return "ambiguous".to_string();
    }
    "known".to_string()
}

fn rights_flags_for_license(license: &str, status: &str) -> Vec<String> {
    if status == "unknown" {
        return vec!["unknown".to_string()];
    }
    if status == "ambiguous" {
        return vec!["ambiguous".to_string(), "unknown".to_string()];
    }
    match license {
        "cc0" | "public-domain" => vec!["cc0".to_string(), "commercial".to_string()],
        "by" | "oga-by" | "pixabay" => {
            vec!["attribution".to_string(), "commercial".to_string()]
        }
        "by-sa" => vec![
            "attribution".to_string(),
            "share-alike".to_string(),
            "commercial".to_string(),
        ],
        "by-nc" => vec!["attribution".to_string(), "non-commercial".to_string()],
        _ => vec!["unknown".to_string()],
    }
}

fn is_non_commercial_license(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "by-nc" | "attribution noncommercial" | "noncommercial"
    )
}

fn attribution_text(license: &str, username: Option<&str>, source_url: &str) -> Option<String> {
    if license == "cc0" || license == "public-domain" {
        return None;
    }
    Some(format!(
        "{} by {} ({})",
        license_label(license),
        username.unwrap_or("unknown author"),
        source_url
    ))
}

fn license_label(license: &str) -> &str {
    match license {
        "cc0" => "CC0",
        "public-domain" => "Public Domain",
        "by" => "CC BY",
        "by-sa" => "CC BY-SA",
        "by-nc" => "CC BY-NC",
        "oga-by" => "OGA BY",
        "pixabay" => "Pixabay Content License",
        "gpl" => "GPL",
        "ambiguous" => "Ambiguous license",
        _ => "Unknown license",
    }
}

fn strip_token(url: &str) -> String {
    let Ok(mut parsed) = Url::parse(url) else {
        return url.to_string();
    };
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .filter(|(key, _)| key != "token")
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    parsed.set_query(None);
    for (key, value) in pairs {
        parsed.query_pairs_mut().append_pair(&key, &value);
    }
    parsed.to_string()
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                ch
            }
        })
        .take(80)
        .collect();
    sanitized.trim().trim_matches('.').to_string()
}

fn make_cloud_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let sequence = NEXT_CLOUD_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{millis}_{sequence}")
}

fn now_millis_string() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn search_request() -> FreesoundSearchRequest {
        FreesoundSearchRequest {
            source_id: None,
            query: Some("impact".to_string()),
            license: None,
            duration_min: None,
            duration_max: None,
            tags: Vec::new(),
            format: None,
            rating_min: None,
            uploader: None,
            page: None,
            page_size: None,
            allow_non_commercial: None,
        }
    }

    #[test]
    fn search_url_uses_single_fields_call_and_cc0_default_without_token_query() {
        let request = search_request();
        let url =
            build_freesound_search_url("https://freesound.org/apiv2", &request, Some("secret"))
                .expect("build url");
        let query = url.query().expect("query");
        assert!(url.as_str().contains("/search/"));
        assert!(query.contains("fields="));
        assert!(query.contains("Creative+Commons+0"));
        assert!(!query.contains("token=secret"));
    }

    #[test]
    fn filter_builder_supports_phase_11_filters() {
        let mut request = search_request();
        request.license = Some("by".to_string());
        request.duration_min = Some(0.2);
        request.duration_max = Some(2.0);
        request.tags = vec!["metal".to_string(), "impact".to_string()];
        request.format = Some("wav".to_string());
        request.rating_min = Some(4.0);
        request.uploader = Some("sounder".to_string());
        let filter = build_freesound_filter(&request).expect("filter");
        assert!(filter.contains("license:\"Attribution\""));
        assert!(filter.contains("duration:[0.2 TO 2]"));
        assert!(filter.contains("tag:\"metal\""));
        assert!(filter.contains("type:\"wav\""));
        assert!(filter.contains("avg_rating:[4 TO *]"));
        assert!(filter.contains("username:\"sounder\""));
    }

    #[test]
    fn non_commercial_requires_opt_in() {
        let mut request = search_request();
        request.license = Some("by-nc".to_string());
        assert!(build_freesound_filter(&request).is_err());
        request.allow_non_commercial = Some(true);
        assert!(build_freesound_filter(&request).is_ok());
    }

    #[test]
    fn retry_policy_handles_rate_limits_and_server_errors() {
        assert_eq!(
            retry_delay(StatusCode::TOO_MANY_REQUESTS, Some("2"), 0),
            Some(Duration::from_secs(2))
        );
        assert!(retry_delay(StatusCode::BAD_GATEWAY, None, 1).is_some());
        assert_eq!(retry_delay(StatusCode::BAD_REQUEST, None, 0), None);
    }

    #[test]
    fn generated_cloud_ids_are_unique_inside_fast_batches() {
        let first = make_cloud_id("asset");
        let second = make_cloud_id("asset");
        assert_ne!(first, second);
    }

    #[test]
    fn metadata_tracks_attribution_for_non_cc0() {
        let text = attribution_text("by", Some("alice"), "https://freesound.org/s/1/");
        assert_eq!(
            text.as_deref(),
            Some("CC BY by alice (https://freesound.org/s/1/)")
        );
        assert!(attribution_text("cc0", Some("alice"), "url").is_none());
    }
}
