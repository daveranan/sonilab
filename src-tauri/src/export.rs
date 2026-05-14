use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::reliability::{BoundedJobGate, CancellationRegistry, CancellationToken, JobDeadline};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct ExportRuntime {
    lock: Mutex<()>,
    queue: BoundedJobGate,
    cancellations: CancellationRegistry,
}

impl ExportRuntime {
    pub fn new() -> Self {
        Self {
            lock: Mutex::new(()),
            queue: BoundedJobGate::new("export", 2),
            cancellations: CancellationRegistry::new(),
        }
    }

    pub fn run_jobs(
        &self,
        connection: &Connection,
        resource_dir: Option<PathBuf>,
        job_ids: Option<Vec<String>>,
    ) -> Vec<ExportJobSnapshot> {
        let _guard = self.lock.lock().expect("export runtime lock poisoned");
        run_export_jobs(self, connection, resource_dir.as_deref(), job_ids)
    }

    pub fn cancel_job(&self, connection: &Connection, job_id: &str) -> Result<bool, String> {
        let accepted = self.cancellations.cancel(job_id);
        let changed = connection
            .execute(
                "UPDATE export_jobs
                 SET status = 'cancelled',
                     error_message = 'Export cancelled',
                     finished_at = CURRENT_TIMESTAMP
                 WHERE id = ?1 AND status IN ('queued', 'analyzing', 'processing', 'exporting')",
                params![job_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(accepted || changed > 0)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJobSnapshot {
    pub id: String,
    pub asset_id: Option<String>,
    pub status: String,
    pub export_scope: String,
    pub format: String,
    pub processing_hash: String,
    pub output_folder: String,
    pub filename_pattern: String,
    pub output_path: Option<String>,
    pub error_message: Option<String>,
    pub progress: f64,
}

pub struct ExportJobInput {
    pub asset_id: String,
    pub format: String,
    pub output_folder: String,
    pub filename_pattern: String,
    pub export_scope: String,
    pub region_start_seconds: Option<f64>,
    pub region_end_seconds: Option<f64>,
    pub format_settings_json: String,
    pub processing_json: String,
    pub processing_hash: String,
    pub preserve_folder_structure: bool,
    pub include_attribution_sidecar: bool,
    pub overwrite_mode: String,
}

pub struct ExportBatchInput {
    pub asset_ids: Vec<String>,
    pub format: String,
    pub output_folder: String,
    pub filename_pattern: String,
    pub export_scope: String,
    pub region_start_seconds: Option<f64>,
    pub region_end_seconds: Option<f64>,
    pub format_settings_json: String,
    pub processing_json: String,
    pub processing_hash: String,
    pub preserve_folder_structure: bool,
    pub include_attribution_sidecar: bool,
    pub overwrite_mode: String,
}

pub struct TempRegionExportInput {
    pub asset_id: String,
    pub display_name: Option<String>,
    pub format: String,
    pub region_start_seconds: f64,
    pub region_end_seconds: f64,
    pub loop_crossfade_seconds: Option<f64>,
    pub loop_crossfade_slope: Option<f64>,
    pub region_fade_gap_seconds: Option<f64>,
    pub region_fade_in_seconds: Option<f64>,
    pub region_fade_in_slope: Option<f64>,
    pub region_fade_out_seconds: Option<f64>,
    pub region_fade_out_slope: Option<f64>,
    pub format_settings_json: String,
    pub processing_json: String,
    pub processing_hash: String,
}

pub struct TempAssetDragExportInput {
    pub asset_id: String,
    pub display_name: Option<String>,
    pub format: String,
    pub export_scope: String,
    pub region_start_seconds: Option<f64>,
    pub region_end_seconds: Option<f64>,
    pub loop_crossfade_seconds: Option<f64>,
    pub loop_crossfade_slope: Option<f64>,
    pub region_fade_gap_seconds: Option<f64>,
    pub region_fade_in_seconds: Option<f64>,
    pub region_fade_in_slope: Option<f64>,
    pub region_fade_out_seconds: Option<f64>,
    pub region_fade_out_slope: Option<f64>,
    pub format_settings_json: String,
    pub processing_json: String,
    pub processing_hash: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRegionDragFile {
    asset_id: String,
    pub path: String,
    format: String,
    region_start_seconds: f64,
    region_end_seconds: f64,
    processing_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GainStage {
    enabled: bool,
    gain_db: f64,
    min_db: f64,
    max_db: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GainProcessingChain {
    version: i64,
    gain: GainStage,
    chain_order: Vec<String>,
}

struct ExportAssetRecord {
    source_root_uri: String,
    path_or_url: String,
    name: String,
    format: Option<String>,
    relative_path: Option<String>,
    license: Option<String>,
    attribution: Option<String>,
    originator: Option<String>,
    source_url: Option<String>,
}

struct ExportJobRecord {
    id: String,
    asset_id: String,
    output_folder: String,
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
    format: String,
    format_settings_json: String,
    processing_json: String,
    preserve_folder_structure: bool,
    include_attribution_sidecar: bool,
    overwrite_mode: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FormatSettings {
    wav_bit_depth: Option<u16>,
    wav_sample_rate: Option<u32>,
    loop_crossfade_seconds: Option<f64>,
    loop_crossfade_slope: Option<f64>,
    region_fade_gap_seconds: Option<f64>,
    region_fade_in_seconds: Option<f64>,
    region_fade_in_slope: Option<f64>,
    region_fade_out_seconds: Option<f64>,
    region_fade_out_slope: Option<f64>,
    mp3_bitrate_kbps: Option<u16>,
    mp3_mode: Option<String>,
    ogg_quality: Option<f32>,
    flac_compression_level: Option<u8>,
    aac_bitrate_kbps: Option<u16>,
    mp4_codec: Option<String>,
    mp4_bitrate_kbps: Option<u16>,
}

struct PlannedOutput {
    path: PathBuf,
    skipped: bool,
}

struct WavInfo {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    block_align: u16,
    data_offset: usize,
    data_size: usize,
    samples_per_block: Option<u16>,
    adpcm_coefficients: Vec<(i16, i16)>,
}

struct DecodedPcm {
    channels: u16,
    sample_rate: u32,
    samples: Vec<f32>,
}

impl DecodedPcm {
    fn frame_count(&self) -> usize {
        self.samples.len() / usize::from(self.channels)
    }

    fn sample(&self, frame: usize, channel: usize) -> f32 {
        self.samples[frame * usize::from(self.channels) + channel]
    }
}

pub fn queue_export_job(
    connection: &Connection,
    input: ExportJobInput,
) -> Result<ExportJobSnapshot, String> {
    let mut jobs = queue_export_jobs(
        connection,
        ExportBatchInput {
            asset_ids: vec![input.asset_id],
            format: input.format,
            output_folder: input.output_folder,
            filename_pattern: input.filename_pattern,
            export_scope: input.export_scope,
            region_start_seconds: input.region_start_seconds,
            region_end_seconds: input.region_end_seconds,
            format_settings_json: input.format_settings_json,
            processing_json: input.processing_json,
            processing_hash: input.processing_hash,
            preserve_folder_structure: input.preserve_folder_structure,
            include_attribution_sidecar: input.include_attribution_sidecar,
            overwrite_mode: input.overwrite_mode,
        },
    )?;
    jobs.pop()
        .ok_or_else(|| "no export job was queued".to_string())
}

pub fn queue_export_jobs(
    connection: &Connection,
    input: ExportBatchInput,
) -> Result<Vec<ExportJobSnapshot>, String> {
    if input.asset_ids.is_empty() {
        return Err("at least one asset is required".to_string());
    }
    if !matches!(
        input.format.as_str(),
        "wav" | "mp3" | "ogg" | "flac" | "aac" | "m4a" | "mp4"
    ) {
        return Err("unsupported export format".to_string());
    }
    if !matches!(input.export_scope.as_str(), "full" | "region") {
        return Err("export_scope must be full or region".to_string());
    }
    if input.export_scope == "region" {
        let start = input
            .region_start_seconds
            .ok_or_else(|| "region export requires start seconds".to_string())?;
        let end = input
            .region_end_seconds
            .ok_or_else(|| "region export requires end seconds".to_string())?;
        if end <= start {
            return Err("region export end must be after start".to_string());
        }
    }
    if !matches!(input.overwrite_mode.as_str(), "skip" | "replace" | "rename") {
        return Err("overwrite_mode must be skip, replace, or rename".to_string());
    }
    if input.output_folder.trim().is_empty() {
        return Err("output folder is required".to_string());
    }
    validate_filename_pattern(&input.filename_pattern)?;
    validate_format_settings(&input.format, &input.format_settings_json)?;
    validate_gain_processing_chain(&input.processing_json, &input.processing_hash)?;

    let mut snapshots = Vec::with_capacity(input.asset_ids.len());
    for (index, asset_id) in input.asset_ids.iter().enumerate() {
        let id = make_id("export");
        let mut settings: serde_json::Value = serde_json::from_str(&input.format_settings_json)
            .unwrap_or_else(|_| serde_json::json!({}));
        settings["processingHash"] = serde_json::json!(input.processing_hash);
        settings["batchIndex"] = serde_json::json!(index + 1);

        connection
            .execute(
                "INSERT INTO export_jobs (
                    id, asset_id, status, output_folder, filename_pattern, export_scope,
                    region_start_seconds, region_end_seconds, format, format_settings_json,
                    processing_json, preserve_folder_structure, include_attribution_sidecar,
                    overwrite_mode
                 ) VALUES (
                    ?1, ?2, 'queued', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
                 )",
                params![
                    id,
                    asset_id,
                    input.output_folder,
                    input.filename_pattern,
                    input.export_scope,
                    input.region_start_seconds,
                    input.region_end_seconds,
                    input.format,
                    settings.to_string(),
                    input.processing_json,
                    input.preserve_folder_structure as i64,
                    input.include_attribution_sidecar as i64,
                    input.overwrite_mode
                ],
            )
            .map_err(|error| error.to_string())?;

        snapshots.push(ExportJobSnapshot {
            id,
            asset_id: Some(asset_id.clone()),
            status: "queued".to_string(),
            export_scope: input.export_scope.clone(),
            format: input.format.clone(),
            processing_hash: input.processing_hash.clone(),
            output_folder: input.output_folder.clone(),
            filename_pattern: input.filename_pattern.clone(),
            output_path: None,
            error_message: None,
            progress: 0.0,
        });
    }

    Ok(snapshots)
}

pub fn list_export_jobs(
    connection: &Connection,
    limit: Option<i64>,
) -> Result<Vec<ExportJobSnapshot>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let mut statement = connection
        .prepare(
            "SELECT id, asset_id, status, export_scope, format, output_folder,
                    filename_pattern, format_settings_json, output_path,
                    error_message, progress
             FROM export_jobs
             ORDER BY queued_at DESC
             LIMIT ?1",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![limit], |row| {
            let settings_json: String = row.get(7)?;
            Ok(ExportJobSnapshot {
                id: row.get(0)?,
                asset_id: row.get(1)?,
                status: row.get(2)?,
                export_scope: row.get(3)?,
                format: row.get(4)?,
                output_folder: row.get(5)?,
                filename_pattern: row.get(6)?,
                processing_hash: processing_hash_from_settings(&settings_json),
                output_path: row.get(8)?,
                error_message: row.get(9)?,
                progress: row.get(10)?,
            })
        })
        .map_err(|error| error.to_string())?;
    let mut jobs = Vec::new();
    for row in rows {
        jobs.push(row.map_err(|error| error.to_string())?);
    }
    Ok(jobs)
}

pub fn retry_export_job(
    connection: &Connection,
    job_id: &str,
) -> Result<ExportJobSnapshot, String> {
    let changed = connection
        .execute(
            "UPDATE export_jobs
             SET status = 'queued',
                 error_message = NULL,
                 output_path = NULL,
                 progress = 0,
                 started_at = NULL,
                 finished_at = NULL
             WHERE id = ?1 AND status = 'failed'",
            params![job_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        let existing = export_job_snapshot(connection, job_id)
            .map_err(|_| "export job not found".to_string())?;
        return Err(format!(
            "only failed export jobs can be retried; current status is {}",
            existing.status
        ));
    }
    export_job_snapshot(connection, job_id)
}

fn run_export_jobs(
    runtime: &ExportRuntime,
    connection: &Connection,
    resource_dir: Option<&Path>,
    job_ids: Option<Vec<String>>,
) -> Vec<ExportJobSnapshot> {
    let ids = match queued_job_ids(connection, job_ids) {
        Ok(ids) => ids,
        Err(_) => return Vec::new(),
    };
    for job_id in &ids {
        let permit = match runtime.queue.try_enter() {
            Ok(permit) => permit,
            Err(error) => {
                let _ = mark_job_failed(connection, job_id, &error);
                continue;
            }
        };
        let token = CancellationToken::default();
        let _ = runtime
            .cancellations
            .register(job_id.clone(), token.clone());
        let deadline = JobDeadline::new(Duration::from_secs(20 * 60));
        let result = process_export_job(connection, resource_dir, job_id, &token, &deadline);
        runtime.cancellations.remove(job_id);
        drop(permit);
        if let Err(error) = result {
            if error.contains("cancelled") {
                let _ = mark_job_cancelled(connection, job_id, &error);
            } else {
                let _ = mark_job_failed(connection, job_id, &error);
            }
        }
    }
    ids.into_iter()
        .filter_map(|id| export_job_snapshot(connection, &id).ok())
        .collect()
}

fn run_ffmpeg_with_deadline(
    ffmpeg: &Path,
    args: Vec<String>,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(ffmpeg);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start FFmpeg: {error}"))?;
    loop {
        deadline.check(token, "export job")?;
        if token.is_canceled() {
            let _ = child.kill();
            return Err("export cancelled".to_string());
        }
        if child
            .try_wait()
            .map_err(|error| format!("failed to wait for FFmpeg: {error}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|error| format!("failed to read FFmpeg output: {error}"));
        }
        sleep(Duration::from_millis(50));
    }
}

fn mark_job_cancelled(connection: &Connection, job_id: &str, message: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE export_jobs
             SET status = 'cancelled',
                 error_message = ?2,
                 progress = 0,
                 finished_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![job_id, message],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn queued_job_ids(
    connection: &Connection,
    job_ids: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    if let Some(job_ids) = job_ids {
        let mut queued = Vec::new();
        for job_id in job_ids {
            let id = connection
                .query_row(
                    "SELECT id FROM export_jobs WHERE id = ?1 AND status = 'queued'",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            if let Some(id) = id {
                queued.push(id);
            }
        }
        return Ok(queued);
    }
    let mut statement = connection
        .prepare(
            "SELECT id
             FROM export_jobs
             WHERE status = 'queued'
             ORDER BY queued_at ASC
             LIMIT 100",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut ids = Vec::new();
    for row in rows {
        ids.push(row.map_err(|error| error.to_string())?);
    }
    Ok(ids)
}

fn process_export_job(
    connection: &Connection,
    resource_dir: Option<&Path>,
    job_id: &str,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<(), String> {
    deadline.check(token, "export job")?;
    let job = export_job_record(connection, job_id)?;
    connection
        .execute(
            "UPDATE export_jobs
             SET status = 'processing', started_at = CURRENT_TIMESTAMP, progress = 0.1
             WHERE id = ?1",
            params![job_id],
        )
        .map_err(|error| error.to_string())?;

    let asset = export_asset(connection, &job.asset_id)?;
    if !Path::new(&asset.path_or_url).is_file() {
        return Err("export source file is unavailable".to_string());
    }
    let chain: GainProcessingChain = serde_json::from_str(&job.processing_json)
        .map_err(|_| "invalid processing_json".to_string())?;
    let settings = parse_format_settings(&job.format, &job.format_settings_json)?;
    let output = plan_output_path(&job, &asset, &chain, &settings)?;
    if output.skipped {
        connection
            .execute(
                "UPDATE export_jobs
                 SET status = 'complete', output_path = ?2, progress = 1,
                     finished_at = CURRENT_TIMESTAMP, error_message = NULL
                 WHERE id = ?1",
                params![job_id, output.path.to_string_lossy()],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    fs::create_dir_all(
        output
            .path
            .parent()
            .ok_or_else(|| "output path has no parent folder".to_string())?,
    )
    .map_err(|error| error.to_string())?;

    connection
        .execute(
            "UPDATE export_jobs SET status = 'exporting', progress = 0.55 WHERE id = ?1",
            params![job_id],
        )
        .map_err(|error| error.to_string())?;

    if should_use_native_wav(&job, &asset, &settings) {
        render_native_wav_export(&job, &asset, &chain, &output.path, token, deadline)?;
    } else {
        let ffmpeg = resolve_ffmpeg(resource_dir)?;
        let args = build_ffmpeg_args(&ffmpeg, &job, &asset, &chain, &settings, &output.path)?;
        let output = run_ffmpeg_with_deadline(&ffmpeg, args, token, deadline)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.is_empty() {
                return Err(format!(
                    "FFmpeg export failed with status {}",
                    output.status
                ));
            }
            return Err(format!(
                "FFmpeg export failed with status {}: {}",
                output.status, detail
            ));
        }
    }

    if job.include_attribution_sidecar {
        write_attribution_sidecar(&output.path, &asset)?;
    }
    if job.export_scope == "full" && job.format == "wav" {
        verify_full_file_levels(connection, &job, &output.path)?;
    }

    connection
        .execute(
            "UPDATE export_jobs
             SET status = 'complete', output_path = ?2, progress = 1,
                 finished_at = CURRENT_TIMESTAMP, error_message = NULL
             WHERE id = ?1",
            params![job_id, output.path.to_string_lossy()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn prepare_region_drag_file(
    connection: &Connection,
    temp_root: &Path,
    resource_dir: Option<&Path>,
    input: TempRegionExportInput,
) -> Result<PreparedRegionDragFile, String> {
    prepare_asset_drag_file(
        connection,
        temp_root,
        resource_dir,
        TempAssetDragExportInput {
            asset_id: input.asset_id,
            display_name: input.display_name,
            format: input.format,
            export_scope: "region".to_string(),
            region_start_seconds: Some(input.region_start_seconds),
            region_end_seconds: Some(input.region_end_seconds),
            loop_crossfade_seconds: input.loop_crossfade_seconds,
            loop_crossfade_slope: input.loop_crossfade_slope,
            region_fade_gap_seconds: input.region_fade_gap_seconds,
            region_fade_in_seconds: input.region_fade_in_seconds,
            region_fade_in_slope: input.region_fade_in_slope,
            region_fade_out_seconds: input.region_fade_out_seconds,
            region_fade_out_slope: input.region_fade_out_slope,
            format_settings_json: input.format_settings_json,
            processing_json: input.processing_json,
            processing_hash: input.processing_hash,
        },
    )
}

pub fn prepare_asset_drag_file(
    connection: &Connection,
    temp_root: &Path,
    resource_dir: Option<&Path>,
    input: TempAssetDragExportInput,
) -> Result<PreparedRegionDragFile, String> {
    validate_drag_export_input(&input)?;
    validate_format_settings(&input.format, &input.format_settings_json)?;
    validate_gain_processing_chain(&input.processing_json, &input.processing_hash)?;
    let chain: GainProcessingChain = serde_json::from_str(&input.processing_json)
        .map_err(|_| "invalid processing_json".to_string())?;
    let asset = match export_asset(connection, &input.asset_id) {
        Ok(asset) => asset,
        Err(_) => {
            return prepare_mock_drag_file(temp_root, resource_dir, input, chain.gain.gain_db);
        }
    };
    let file_display_name = input
        .display_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(&asset.name);
    let settings = parse_format_settings(&input.format, &input.format_settings_json)?;
    if can_passthrough_original_drag(&input, &asset, &chain, &settings) {
        return Ok(PreparedRegionDragFile {
            asset_id: input.asset_id,
            path: asset.path_or_url,
            format: input.format,
            region_start_seconds: 0.0,
            region_end_seconds: 0.0,
            processing_hash: input.processing_hash,
        });
    }

    let export_dir = temp_root.join("sonilabs-export-drag");
    fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let extension = output_extension(&input.format);
    let file_name = format!("{}.{}", sanitize_file_stem(file_display_name), extension);
    let output_path = export_dir.join(&file_name);
    if output_path.is_file() {
        fs::remove_file(&output_path).map_err(|error| error.to_string())?;
    }
    let job = ExportJobRecord {
        id: make_id("drag_job"),
        asset_id: input.asset_id.clone(),
        output_folder: export_dir.to_string_lossy().to_string(),
        export_scope: input.export_scope.clone(),
        region_start_seconds: input.region_start_seconds,
        region_end_seconds: input.region_end_seconds,
        loop_crossfade_seconds: input.loop_crossfade_seconds,
        loop_crossfade_slope: input.loop_crossfade_slope,
        region_fade_gap_seconds: input.region_fade_gap_seconds,
        region_fade_in_seconds: input.region_fade_in_seconds,
        region_fade_in_slope: input.region_fade_in_slope,
        region_fade_out_seconds: input.region_fade_out_seconds,
        region_fade_out_slope: input.region_fade_out_slope,
        format: input.format.clone(),
        format_settings_json: input.format_settings_json.clone(),
        processing_json: input.processing_json.clone(),
        preserve_folder_structure: false,
        include_attribution_sidecar: false,
        overwrite_mode: "replace".to_string(),
    };

    let token = CancellationToken::default();
    let deadline = JobDeadline::new(Duration::from_secs(5 * 60));
    if should_use_native_wav(&job, &asset, &settings) {
        render_native_wav_export(&job, &asset, &chain, &output_path, &token, &deadline)?;
    } else {
        let ffmpeg = resolve_ffmpeg(resource_dir)?;
        let args = build_ffmpeg_args(&ffmpeg, &job, &asset, &chain, &settings, &output_path)?;
        let output = run_ffmpeg_with_deadline(&ffmpeg, args, &token, &deadline)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.is_empty() {
                return Err(format!(
                    "FFmpeg region export failed with status {}",
                    output.status
                ));
            }
            return Err(format!(
                "FFmpeg region export failed with status {}: {}",
                output.status, detail
            ));
        }
    }

    Ok(PreparedRegionDragFile {
        asset_id: input.asset_id,
        path: output_path.to_string_lossy().to_string(),
        format: input.format,
        region_start_seconds: input.region_start_seconds.unwrap_or(0.0),
        region_end_seconds: input.region_end_seconds.unwrap_or(0.0),
        processing_hash: input.processing_hash,
    })
}

pub fn delete_prepared_drag_files(paths: Vec<String>) -> Result<usize, String> {
    let mut removed = 0_usize;
    for path in paths {
        let file_path = PathBuf::from(path);
        let Some(parent) = file_path.parent() else {
            continue;
        };
        let is_drag_temp = parent
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == "sonilabs-export-drag");
        if !is_drag_temp || !file_path.is_file() {
            continue;
        }
        fs::remove_file(&file_path).map_err(|error| error.to_string())?;
        removed += 1;
    }
    Ok(removed)
}

fn validate_drag_export_input(input: &TempAssetDragExportInput) -> Result<(), String> {
    if !matches!(
        input.format.as_str(),
        "wav" | "mp3" | "ogg" | "flac" | "aac" | "m4a" | "mp4"
    ) {
        return Err("unsupported export format".to_string());
    }
    if !matches!(input.export_scope.as_str(), "full" | "region") {
        return Err("export_scope must be full or region".to_string());
    }
    if input.export_scope == "region" {
        let start = input
            .region_start_seconds
            .ok_or_else(|| "region export requires start seconds".to_string())?;
        let end = input
            .region_end_seconds
            .ok_or_else(|| "region export requires end seconds".to_string())?;
        if end <= start {
            return Err("region export end must be after start".to_string());
        }
        if input.loop_crossfade_seconds.unwrap_or(0.0) < 0.0 {
            return Err("loop crossfade cannot be negative".to_string());
        }
        if input.region_fade_in_seconds.unwrap_or(0.0) < 0.0
            || input.region_fade_out_seconds.unwrap_or(0.0) < 0.0
        {
            return Err("region fades cannot be negative".to_string());
        }
    } else if input.loop_crossfade_seconds.unwrap_or(0.0) > 0.0 {
        return Err("loop crossfade requires a region export".to_string());
    } else if input.region_fade_in_seconds.unwrap_or(0.0) > 0.0
        || input.region_fade_out_seconds.unwrap_or(0.0) > 0.0
    {
        return Err("region fades require a region export".to_string());
    }
    Ok(())
}

fn can_passthrough_original_drag(
    input: &TempAssetDragExportInput,
    asset: &ExportAssetRecord,
    chain: &GainProcessingChain,
    _settings: &FormatSettings,
) -> bool {
    input.export_scope == "full"
        && input.loop_crossfade_seconds.unwrap_or(0.0) <= 0.0
        && Path::new(&asset.path_or_url).is_file()
        && is_noop_gain_chain(chain)
        && has_no_explicit_format_settings(&input.format_settings_json)
        && source_format_matches_export(input, asset)
}

fn is_noop_gain_chain(chain: &GainProcessingChain) -> bool {
    chain.version == 1
        && chain.chain_order.iter().all(|stage| stage == "gain")
        && (!chain.gain.enabled || chain.gain.gain_db.abs() < 0.000_001)
}

fn has_no_explicit_format_settings(settings_json: &str) -> bool {
    if settings_json.trim().is_empty() {
        return true;
    }
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|value| value.as_object().map(|object| object.is_empty()))
        .unwrap_or(false)
}

fn source_format_matches_export(
    input: &TempAssetDragExportInput,
    asset: &ExportAssetRecord,
) -> bool {
    let requested = normalized_export_format(&input.format);
    let source_format = asset
        .format
        .as_deref()
        .map(normalized_export_format)
        .unwrap_or_default();
    if source_format == requested {
        return true;
    }

    Path::new(&asset.path_or_url)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(normalized_export_format)
        .is_some_and(|extension| extension == requested)
}

fn normalized_export_format(format: &str) -> String {
    match format.to_ascii_lowercase().as_str() {
        "wave" => "wav".to_string(),
        "mp4" => "m4a".to_string(),
        value => value.to_string(),
    }
}

fn prepare_mock_drag_file(
    temp_root: &Path,
    resource_dir: Option<&Path>,
    input: TempAssetDragExportInput,
    gain_db: f64,
) -> Result<PreparedRegionDragFile, String> {
    let export_dir = temp_root.join("sonilabs-export-drag");
    fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;
    let file_stem = input
        .display_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .map(sanitize_file_stem)
        .unwrap_or_else(|| "region".to_string());
    let duration_seconds = if input.export_scope == "region" {
        input.region_end_seconds.unwrap_or(1.0) - input.region_start_seconds.unwrap_or(0.0)
    } else {
        1.0
    };
    let mock_wav_path = export_dir.join(format!("{}.wav", file_stem));
    let rendered = render_mock_wav_region_16_bit(duration_seconds, gain_db);
    fs::write(&mock_wav_path, rendered).map_err(|error| error.to_string())?;
    let output_path = if input.format == "wav" {
        mock_wav_path
    } else {
        let output_path =
            export_dir.join(format!("{}.{}", file_stem, output_extension(&input.format)));
        let settings = parse_format_settings(&input.format, &input.format_settings_json)?;
        let ffmpeg = resolve_ffmpeg(resource_dir)?;
        let asset = ExportAssetRecord {
            source_root_uri: export_dir.to_string_lossy().to_string(),
            path_or_url: mock_wav_path.to_string_lossy().to_string(),
            name: format!("{file_stem}.wav"),
            format: Some("wav".to_string()),
            relative_path: None,
            license: None,
            attribution: None,
            originator: None,
            source_url: None,
        };
        let job = ExportJobRecord {
            id: make_id("drag_job"),
            asset_id: input.asset_id.clone(),
            output_folder: export_dir.to_string_lossy().to_string(),
            export_scope: "full".to_string(),
            region_start_seconds: None,
            region_end_seconds: None,
            loop_crossfade_seconds: None,
            loop_crossfade_slope: None,
            region_fade_gap_seconds: None,
            region_fade_in_seconds: None,
            region_fade_in_slope: None,
            region_fade_out_seconds: None,
            region_fade_out_slope: None,
            format: input.format.clone(),
            format_settings_json: input.format_settings_json.clone(),
            processing_json: input.processing_json.clone(),
            preserve_folder_structure: false,
            include_attribution_sidecar: false,
            overwrite_mode: "replace".to_string(),
        };
        let chain: GainProcessingChain = serde_json::from_str(&input.processing_json)
            .map_err(|_| "invalid processing_json".to_string())?;
        let args = build_ffmpeg_args(&ffmpeg, &job, &asset, &chain, &settings, &output_path)?;
        let token = CancellationToken::default();
        let deadline = JobDeadline::new(Duration::from_secs(5 * 60));
        let output = run_ffmpeg_with_deadline(&ffmpeg, args, &token, &deadline)?;
        if !output.status.success() {
            return Err(format!(
                "FFmpeg mock drag export failed with status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        output_path
    };
    Ok(PreparedRegionDragFile {
        asset_id: input.asset_id,
        path: output_path.to_string_lossy().to_string(),
        format: input.format,
        region_start_seconds: input.region_start_seconds.unwrap_or(0.0),
        region_end_seconds: input.region_end_seconds.unwrap_or(0.0),
        processing_hash: input.processing_hash,
    })
}

fn validate_gain_processing_chain(
    processing_json: &str,
    processing_hash: &str,
) -> Result<(), String> {
    let chain: GainProcessingChain =
        serde_json::from_str(processing_json).map_err(|_| "invalid processing_json".to_string())?;
    if chain.version != 1 || chain.chain_order != ["gain"] {
        return Err("export processing is gain-only in this phase".to_string());
    }
    if !chain.gain.enabled || chain.gain.min_db != -24.0 || chain.gain.max_db != 36.0 {
        return Err("invalid gain stage".to_string());
    }
    let gain_db = chain.gain.gain_db.clamp(-24.0, 36.0);
    let expected_hash = if gain_db.abs() < 0.005 {
        "processing:none".to_string()
    } else {
        format!("processing:gain:{gain_db:.2}")
    };
    if processing_hash != expected_hash {
        return Err("processing_hash does not match gain settings".to_string());
    }
    Ok(())
}

fn export_asset(connection: &Connection, asset_id: &str) -> Result<ExportAssetRecord, String> {
    connection
        .query_row(
            "SELECT s.root_uri, a.path_or_url, a.name, a.format, a.metadata_json,
                    a.license, a.attribution, a.originator, a.source_url
             FROM assets a
             JOIN sources s ON s.id = a.source_id
             WHERE a.id = ?1
             LIMIT 1",
            params![asset_id],
            |row| {
                let metadata_json: String = row.get(4)?;
                Ok(ExportAssetRecord {
                    source_root_uri: row.get(0)?,
                    path_or_url: row.get(1)?,
                    name: row.get(2)?,
                    format: row.get(3)?,
                    relative_path: metadata_relative_path(&metadata_json),
                    license: row.get(5)?,
                    attribution: row.get(6)?,
                    originator: row.get(7)?,
                    source_url: row.get(8)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn export_job_record(connection: &Connection, job_id: &str) -> Result<ExportJobRecord, String> {
    connection
        .query_row(
            "SELECT id, asset_id, status, output_folder, export_scope,
                    region_start_seconds, region_end_seconds, format,
                    format_settings_json, processing_json, preserve_folder_structure,
                    include_attribution_sidecar, overwrite_mode
             FROM export_jobs
             WHERE id = ?1",
            params![job_id],
            |row| {
                let format: String = row.get(7)?;
                let format_settings_json: String = row.get(8)?;
                let settings = parse_format_settings(&format, &format_settings_json)
                    .unwrap_or_else(|_| default_format_settings(&format));
                Ok(ExportJobRecord {
                    id: row.get(0)?,
                    asset_id: row
                        .get::<_, Option<String>>(1)?
                        .ok_or_else(|| rusqlite::Error::InvalidQuery)?,
                    output_folder: row.get(3)?,
                    export_scope: row.get(4)?,
                    region_start_seconds: row.get(5)?,
                    region_end_seconds: row.get(6)?,
                    loop_crossfade_seconds: settings.loop_crossfade_seconds,
                    loop_crossfade_slope: settings.loop_crossfade_slope,
                    region_fade_gap_seconds: settings.region_fade_gap_seconds,
                    region_fade_in_seconds: settings.region_fade_in_seconds,
                    region_fade_in_slope: settings.region_fade_in_slope,
                    region_fade_out_seconds: settings.region_fade_out_seconds,
                    region_fade_out_slope: settings.region_fade_out_slope,
                    format,
                    format_settings_json,
                    processing_json: row.get(9)?,
                    preserve_folder_structure: row.get::<_, i64>(10)? == 1,
                    include_attribution_sidecar: row.get::<_, i64>(11)? == 1,
                    overwrite_mode: row.get(12)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn export_job_snapshot(connection: &Connection, job_id: &str) -> Result<ExportJobSnapshot, String> {
    connection
        .query_row(
            "SELECT id, asset_id, status, export_scope, format, output_folder,
                    filename_pattern, format_settings_json, output_path,
                    error_message, progress
             FROM export_jobs
             WHERE id = ?1",
            params![job_id],
            |row| {
                let settings_json: String = row.get(7)?;
                Ok(ExportJobSnapshot {
                    id: row.get(0)?,
                    asset_id: row.get(1)?,
                    status: row.get(2)?,
                    export_scope: row.get(3)?,
                    format: row.get(4)?,
                    output_folder: row.get(5)?,
                    filename_pattern: row.get(6)?,
                    processing_hash: processing_hash_from_settings(&settings_json),
                    output_path: row.get(8)?,
                    error_message: row.get(9)?,
                    progress: row.get(10)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

fn mark_job_failed(connection: &Connection, job_id: &str, error: &str) -> Result<(), String> {
    connection
        .execute(
            "UPDATE export_jobs
             SET status = 'failed', error_message = ?2, progress = 1,
                 finished_at = CURRENT_TIMESTAMP
             WHERE id = ?1",
            params![job_id, error],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn validate_filename_pattern(pattern: &str) -> Result<(), String> {
    if pattern.trim().is_empty() {
        return Err("filename pattern is required".to_string());
    }
    if pattern.contains('/') || pattern.contains('\\') || pattern.contains(':') {
        return Err("filename pattern cannot contain path separators".to_string());
    }
    Ok(())
}

fn validate_format_settings(format: &str, settings_json: &str) -> Result<(), String> {
    let settings = parse_format_settings(format, settings_json)?;
    if let Some(bit_depth) = settings.wav_bit_depth {
        if !matches!(bit_depth, 16 | 24 | 32) {
            return Err("WAV bit depth must be 16, 24, or 32".to_string());
        }
    }
    if let Some(sample_rate) = settings.wav_sample_rate {
        if !(8_000..=192_000).contains(&sample_rate) {
            return Err("WAV sample rate must be between 8000 and 192000".to_string());
        }
    }
    if settings.loop_crossfade_seconds.unwrap_or(0.0) < 0.0 {
        return Err("loop crossfade cannot be negative".to_string());
    }
    if settings.region_fade_in_seconds.unwrap_or(0.0) < 0.0
        || settings.region_fade_out_seconds.unwrap_or(0.0) < 0.0
    {
        return Err("region fades cannot be negative".to_string());
    }
    if let Some(mode) = settings.mp3_mode.as_deref() {
        if !matches!(mode, "cbr" | "vbr") {
            return Err("MP3 mode must be cbr or vbr".to_string());
        }
    }
    if let Some(bitrate) = settings.mp3_bitrate_kbps {
        if !(32..=320).contains(&bitrate) {
            return Err("MP3 bitrate must be between 32 and 320 kbps".to_string());
        }
    }
    if let Some(quality) = settings.ogg_quality {
        if !(0.0..=10.0).contains(&quality) {
            return Err("OGG quality must be between 0 and 10".to_string());
        }
    }
    if let Some(level) = settings.flac_compression_level {
        if level > 12 {
            return Err("FLAC compression level must be 0 through 12".to_string());
        }
    }
    if let Some(bitrate) = settings.aac_bitrate_kbps {
        if !(32..=512).contains(&bitrate) {
            return Err("AAC/M4A bitrate must be between 32 and 512 kbps".to_string());
        }
    }
    if format == "mp4" {
        let codec = settings.mp4_codec.as_deref().unwrap_or("aac");
        if !matches!(codec, "aac" | "alac") {
            return Err("MP4 codec must be aac or alac".to_string());
        }
        if codec == "aac" {
            let bitrate = settings.mp4_bitrate_kbps.unwrap_or(192);
            if !(32..=512).contains(&bitrate) {
                return Err("MP4 AAC bitrate must be between 32 and 512 kbps".to_string());
            }
        }
    }
    Ok(())
}

fn parse_format_settings(format: &str, settings_json: &str) -> Result<FormatSettings, String> {
    if settings_json.trim().is_empty() {
        return Ok(default_format_settings(format));
    }
    let mut settings: FormatSettings =
        serde_json::from_str(settings_json).map_err(|error| error.to_string())?;
    let defaults = default_format_settings(format);
    settings.wav_bit_depth = settings.wav_bit_depth.or(defaults.wav_bit_depth);
    settings.wav_sample_rate = settings.wav_sample_rate.or(defaults.wav_sample_rate);
    settings.loop_crossfade_seconds = settings
        .loop_crossfade_seconds
        .or(defaults.loop_crossfade_seconds);
    settings.loop_crossfade_slope = settings
        .loop_crossfade_slope
        .or(defaults.loop_crossfade_slope);
    settings.region_fade_in_seconds = settings
        .region_fade_in_seconds
        .or(defaults.region_fade_in_seconds);
    settings.region_fade_in_slope = settings
        .region_fade_in_slope
        .or(defaults.region_fade_in_slope);
    settings.region_fade_out_seconds = settings
        .region_fade_out_seconds
        .or(defaults.region_fade_out_seconds);
    settings.region_fade_out_slope = settings
        .region_fade_out_slope
        .or(defaults.region_fade_out_slope);
    settings.mp3_bitrate_kbps = settings.mp3_bitrate_kbps.or(defaults.mp3_bitrate_kbps);
    settings.mp3_mode = settings.mp3_mode.or(defaults.mp3_mode);
    settings.ogg_quality = settings.ogg_quality.or(defaults.ogg_quality);
    settings.flac_compression_level = settings
        .flac_compression_level
        .or(defaults.flac_compression_level);
    settings.aac_bitrate_kbps = settings.aac_bitrate_kbps.or(defaults.aac_bitrate_kbps);
    settings.mp4_codec = settings.mp4_codec.or(defaults.mp4_codec);
    settings.mp4_bitrate_kbps = settings.mp4_bitrate_kbps.or(defaults.mp4_bitrate_kbps);
    Ok(settings)
}

fn default_format_settings(format: &str) -> FormatSettings {
    FormatSettings {
        wav_bit_depth: (format == "wav").then_some(16),
        wav_sample_rate: None,
        loop_crossfade_seconds: None,
        loop_crossfade_slope: None,
        region_fade_gap_seconds: None,
        region_fade_in_seconds: None,
        region_fade_in_slope: None,
        region_fade_out_seconds: None,
        region_fade_out_slope: None,
        mp3_bitrate_kbps: (format == "mp3").then_some(192),
        mp3_mode: (format == "mp3").then(|| "cbr".to_string()),
        ogg_quality: (format == "ogg").then_some(5.0),
        flac_compression_level: (format == "flac").then_some(5),
        aac_bitrate_kbps: matches!(format, "aac" | "m4a").then_some(192),
        mp4_codec: (format == "mp4").then(|| "aac".to_string()),
        mp4_bitrate_kbps: (format == "mp4").then_some(192),
    }
}

fn plan_output_path(
    job: &ExportJobRecord,
    asset: &ExportAssetRecord,
    _chain: &GainProcessingChain,
    _settings: &FormatSettings,
) -> Result<PlannedOutput, String> {
    let mut folder = PathBuf::from(&job.output_folder);
    if job.preserve_folder_structure {
        if let Some(relative_path) = asset.relative_path.as_deref() {
            if let Some(parent) = Path::new(relative_path).parent() {
                push_safe_relative_components(&mut folder, parent)?;
            }
        } else if let Ok(relative) =
            Path::new(&asset.path_or_url).strip_prefix(&asset.source_root_uri)
        {
            if let Some(parent) = relative.parent() {
                push_safe_relative_components(&mut folder, parent)?;
            }
        }
    }

    let extension = output_extension(&job.format);
    let file_stem = sanitize_file_stem(&asset.name);
    let path = folder.join(format!("{file_stem}.{extension}"));
    if !path.exists() || job.overwrite_mode == "replace" {
        return Ok(PlannedOutput {
            path,
            skipped: false,
        });
    }
    if job.overwrite_mode == "skip" {
        return Ok(PlannedOutput {
            path,
            skipped: true,
        });
    }
    Ok(PlannedOutput {
        path,
        skipped: true,
    })
}

fn push_safe_relative_components(folder: &mut PathBuf, relative: &Path) -> Result<(), String> {
    for component in relative.components() {
        match component {
            Component::Normal(part) => folder.push(part),
            Component::CurDir => {}
            _ => return Err("preserved folder path must stay relative".to_string()),
        }
    }
    Ok(())
}

fn output_extension(format: &str) -> &'static str {
    match format {
        "aac" | "m4a" => "m4a",
        "ogg" => "ogg",
        "flac" => "flac",
        "mp3" => "mp3",
        "mp4" => "mp4",
        _ => "wav",
    }
}

fn format_optional_seconds(value: Option<f64>) -> String {
    value
        .map(|seconds| format!("{seconds:.3}"))
        .unwrap_or_else(|| "full".to_string())
}

fn should_use_native_wav(
    job: &ExportJobRecord,
    asset: &ExportAssetRecord,
    settings: &FormatSettings,
) -> bool {
    let source_format = asset
        .format
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    job.format == "wav"
        && settings.wav_bit_depth.unwrap_or(16) == 16
        && settings.wav_sample_rate.is_none()
        && matches!(source_format.as_str(), "wav" | "wave")
}

fn render_native_wav_export(
    job: &ExportJobRecord,
    asset: &ExportAssetRecord,
    chain: &GainProcessingChain,
    output_path: &Path,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<(), String> {
    deadline.check(token, "export job")?;
    if job.loop_crossfade_seconds.unwrap_or(0.0) > 0.0 {
        let bytes = fs::read(&asset.path_or_url).map_err(|error| error.to_string())?;
        let wav = parse_wav_info(&bytes)?;
        if wav.audio_format == 2 {
            let pcm = decode_ms_adpcm_wav(&bytes, &wav)?;
            let start_frame = seconds_to_frame(
                job.region_start_seconds.unwrap_or(0.0),
                pcm.sample_rate,
                pcm.frame_count(),
            );
            let end_frame = seconds_to_frame(
                job.region_end_seconds
                    .unwrap_or(pcm.frame_count() as f64 / pcm.sample_rate as f64),
                pcm.sample_rate,
                pcm.frame_count(),
            );
            let crossfade_frames = seconds_to_frame(
                job.loop_crossfade_seconds.unwrap_or(0.0),
                pcm.sample_rate,
                pcm.frame_count(),
            );
            let rendered = render_crossfaded_pcm_loop_16_bit(
                &pcm,
                start_frame,
                end_frame,
                crossfade_frames,
                job.loop_crossfade_slope.unwrap_or(1.0).clamp(0.25, 4.0),
                chain.gain.gain_db,
                token,
                deadline,
            )?;
            return fs::write(output_path, rendered).map_err(|error| error.to_string());
        }
        let frame_count = wav.data_size / usize::from(wav.block_align);
        let start_frame = seconds_to_frame(
            job.region_start_seconds.unwrap_or(0.0),
            wav.sample_rate,
            frame_count,
        );
        let end_frame = seconds_to_frame(
            job.region_end_seconds
                .unwrap_or(frame_count as f64 / wav.sample_rate as f64),
            wav.sample_rate,
            frame_count,
        );
        let crossfade_frames = seconds_to_frame(
            job.loop_crossfade_seconds.unwrap_or(0.0),
            wav.sample_rate,
            frame_count,
        );
        let crossfade_slope = job.loop_crossfade_slope.unwrap_or(1.0).clamp(0.25, 4.0);
        let rendered = render_crossfaded_wav_loop_16_bit(
            &bytes,
            &wav,
            start_frame,
            end_frame,
            crossfade_frames,
            crossfade_slope,
            chain.gain.gain_db,
            token,
            deadline,
        )?;
        return fs::write(output_path, rendered).map_err(|error| error.to_string());
    }
    if is_noop_gain_chain(chain)
        && job.export_scope == "region"
        && normalized_region_fade_seconds(job) == (0.0, 0.0)
    {
        return copy_wav_region_export(job, asset, output_path, token, deadline);
    }

    let bytes = fs::read(&asset.path_or_url).map_err(|error| error.to_string())?;
    let wav = parse_wav_info(&bytes)?;
    if wav.audio_format == 2 {
        let pcm = decode_ms_adpcm_wav(&bytes, &wav)?;
        let frame_count = pcm.frame_count();
        let start_frame = seconds_to_frame(
            job.region_start_seconds.unwrap_or(0.0),
            pcm.sample_rate,
            frame_count,
        );
        let end_frame = seconds_to_frame(
            job.region_end_seconds
                .unwrap_or(frame_count as f64 / pcm.sample_rate as f64),
            pcm.sample_rate,
            frame_count,
        );
        if end_frame <= start_frame {
            return Err("export range has no audio frames".to_string());
        }
        let (fade_in_seconds, fade_out_seconds) = normalized_region_fade_seconds(job);
        let rendered = render_pcm_region_16_bit(
            &pcm,
            start_frame,
            end_frame,
            chain.gain.gain_db,
            fade_in_seconds,
            job.region_fade_in_slope.unwrap_or(1.0),
            fade_out_seconds,
            job.region_fade_out_slope.unwrap_or(1.0),
            token,
            deadline,
        )?;
        return fs::write(output_path, rendered).map_err(|error| error.to_string());
    }
    let frame_count = wav.data_size / usize::from(wav.block_align);
    let start_frame = seconds_to_frame(
        job.region_start_seconds.unwrap_or(0.0),
        wav.sample_rate,
        frame_count,
    );
    let end_frame = seconds_to_frame(
        job.region_end_seconds
            .unwrap_or(frame_count as f64 / wav.sample_rate as f64),
        wav.sample_rate,
        frame_count,
    );
    if end_frame <= start_frame {
        return Err("export range has no audio frames".to_string());
    }
    let (fade_in_seconds, fade_out_seconds) = normalized_region_fade_seconds(job);
    let rendered = render_wav_region_16_bit(
        &bytes,
        &wav,
        start_frame,
        end_frame,
        chain.gain.gain_db,
        fade_in_seconds,
        job.region_fade_in_slope.unwrap_or(1.0),
        fade_out_seconds,
        job.region_fade_out_slope.unwrap_or(1.0),
        token,
        deadline,
    )?;
    fs::write(output_path, rendered).map_err(|error| error.to_string())
}

fn copy_wav_region_export(
    job: &ExportJobRecord,
    asset: &ExportAssetRecord,
    output_path: &Path,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<(), String> {
    let mut input = fs::File::open(&asset.path_or_url).map_err(|error| error.to_string())?;
    let wav = parse_wav_info_file(&mut input)?;
    if wav.audio_format == 2 {
        input
            .seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        let mut bytes = Vec::new();
        input
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        let pcm = decode_ms_adpcm_wav(&bytes, &wav)?;
        let frame_count = pcm.frame_count();
        let start_frame = seconds_to_frame(
            job.region_start_seconds.unwrap_or(0.0),
            pcm.sample_rate,
            frame_count,
        );
        let end_frame = seconds_to_frame(
            job.region_end_seconds
                .unwrap_or(frame_count as f64 / pcm.sample_rate as f64),
            pcm.sample_rate,
            frame_count,
        );
        let rendered = render_pcm_region_16_bit(
            &pcm,
            start_frame,
            end_frame,
            0.0,
            0.0,
            1.0,
            0.0,
            1.0,
            token,
            deadline,
        )?;
        return fs::write(output_path, rendered).map_err(|error| error.to_string());
    }
    let frame_count = wav.data_size / usize::from(wav.block_align);
    let start_frame = seconds_to_frame(
        job.region_start_seconds.unwrap_or(0.0),
        wav.sample_rate,
        frame_count,
    );
    let end_frame = seconds_to_frame(
        job.region_end_seconds
            .unwrap_or(frame_count as f64 / wav.sample_rate as f64),
        wav.sample_rate,
        frame_count,
    );
    if end_frame <= start_frame {
        return Err("export range has no audio frames".to_string());
    }

    let byte_start = wav.data_offset as u64 + (start_frame * usize::from(wav.block_align)) as u64;
    let byte_count = (end_frame - start_frame) * usize::from(wav.block_align);
    let data_size = u32::try_from(byte_count).map_err(|_| "WAV region is too large".to_string())?;
    let mut output = fs::File::create(output_path).map_err(|error| error.to_string())?;
    write_wav_header_with_format(
        &mut output,
        wav.audio_format,
        wav.channels,
        wav.sample_rate,
        wav.bits_per_sample,
        data_size,
    )?;

    input
        .seek(SeekFrom::Start(byte_start))
        .map_err(|error| error.to_string())?;
    let mut remaining = byte_count;
    let mut buffer = vec![0_u8; 64 * 1024];
    while remaining > 0 {
        deadline.check(token, "export job")?;
        let read_len = remaining.min(buffer.len());
        input
            .read_exact(&mut buffer[..read_len])
            .map_err(|error| error.to_string())?;
        output
            .write_all(&buffer[..read_len])
            .map_err(|error| error.to_string())?;
        remaining -= read_len;
    }
    Ok(())
}

fn resolve_ffmpeg(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    let executable = ffmpeg_executable_name();
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("FFMPEG_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("bin").join(executable));
    }
    candidates.push(PathBuf::from("src-tauri/bin").join(executable));
    candidates.push(PathBuf::from("ffmpeg"));
    candidates
        .into_iter()
        .find(|candidate| candidate == Path::new("ffmpeg") || candidate.is_file())
        .ok_or_else(|| "FFmpeg sidecar was not found for this export format".to_string())
}

fn ffmpeg_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    }
}

fn build_ffmpeg_args(
    _ffmpeg: &Path,
    job: &ExportJobRecord,
    asset: &ExportAssetRecord,
    chain: &GainProcessingChain,
    settings: &FormatSettings,
    output_path: &Path,
) -> Result<Vec<String>, String> {
    if !Path::new(&asset.path_or_url).is_file() {
        return Err("export source file does not exist".to_string());
    }
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    args.push("-y".to_string());
    args.push("-i".to_string());
    args.push(asset.path_or_url.clone());
    if let Some(crossfade_seconds) = normalized_loop_crossfade_seconds(job) {
        let start = job.region_start_seconds.unwrap_or(0.0);
        let end = job
            .region_end_seconds
            .ok_or_else(|| "region export requires end seconds".to_string())?;
        let duration = end - start;
        let body_end = duration - crossfade_seconds;
        let slope = job.loop_crossfade_slope.unwrap_or(1.0);
        let (tail_curve, head_curve) = if slope < 0.85 {
            ("exp", "log")
        } else if slope > 1.15 {
            ("log", "exp")
        } else {
            ("tri", "tri")
        };
        let volume = if chain.gain.gain_db.abs() >= 0.005 {
            format!(",volume={:.2}dB", chain.gain.gain_db)
        } else {
            String::new()
        };
        args.push("-filter_complex".to_string());
        args.push(format!(
            "[0:a]atrim=start={start:.6}:end={end:.6},asetpts=PTS-STARTPTS,asplit=3[base][headsrc][tailsrc];\
             [headsrc]atrim=start=0:end={crossfade_seconds:.6},asetpts=PTS-STARTPTS[head];\
             [tailsrc]atrim=start={body_end:.6}:end={duration:.6},asetpts=PTS-STARTPTS[tail];\
             [tail][head]acrossfade=d={crossfade_seconds:.6}:c1={tail_curve}:c2={head_curve}[xf];\
             [base]atrim=start={crossfade_seconds:.6}:end={body_end:.6},asetpts=PTS-STARTPTS[body];\
             [body][xf]concat=n=2:v=0:a=1{volume}[out]"
        ));
        args.push("-map".to_string());
        args.push("[out]".to_string());
        args.extend(codec_args(&job.format, settings));
        args.push(output_path.to_string_lossy().to_string());
        return Ok(args);
    }
    if job.export_scope == "region" {
        let start = job.region_start_seconds.unwrap_or(0.0);
        let end = job
            .region_end_seconds
            .ok_or_else(|| "region export requires end seconds".to_string())?;
        let duration = end - start;
        args.push("-ss".to_string());
        args.push(format_optional_seconds(job.region_start_seconds));
        args.push("-t".to_string());
        args.push(format!("{duration:.6}"));
    }
    let mut audio_filters = Vec::new();
    let (fade_in, fade_out) = normalized_region_fade_seconds(job);
    if fade_in > 0.0 {
        audio_filters.push(format!(
            "afade=t=in:st=0:d={fade_in:.6}:curve={}",
            ffmpeg_fade_curve(job.region_fade_in_slope.unwrap_or(1.0), "in")
        ));
    }
    if fade_out > 0.0 {
        let duration =
            job.region_end_seconds.unwrap_or(0.0) - job.region_start_seconds.unwrap_or(0.0);
        audio_filters.push(format!(
            "afade=t=out:st={:.6}:d={fade_out:.6}:curve={}",
            (duration - fade_out).max(0.0),
            ffmpeg_fade_curve(job.region_fade_out_slope.unwrap_or(1.0), "out")
        ));
    }
    if chain.gain.gain_db.abs() >= 0.005 {
        audio_filters.push(format!("volume={:.2}dB", chain.gain.gain_db));
    }
    if !audio_filters.is_empty() {
        args.push("-af".to_string());
        args.push(audio_filters.join(","));
    }
    args.extend(codec_args(&job.format, settings));
    args.push(output_path.to_string_lossy().to_string());
    Ok(args)
}

fn normalized_loop_crossfade_seconds(job: &ExportJobRecord) -> Option<f64> {
    let crossfade = job.loop_crossfade_seconds?;
    if crossfade <= 0.0 || job.export_scope != "region" {
        return None;
    }
    let duration = job.region_end_seconds? - job.region_start_seconds.unwrap_or(0.0);
    if duration <= 0.0 {
        return None;
    }
    Some(crossfade.min(duration * 0.45))
}

fn ffmpeg_fade_curve(slope: f64, side: &str) -> &'static str {
    let slope = clamped_fade_slope(slope);
    if slope < 0.85 {
        if side == "in" {
            "log"
        } else {
            "exp"
        }
    } else if slope > 1.15 {
        if side == "in" {
            "exp"
        } else {
            "log"
        }
    } else {
        "tri"
    }
}

fn normalized_region_fade_seconds(job: &ExportJobRecord) -> (f64, f64) {
    if job.export_scope != "region" || job.loop_crossfade_seconds.unwrap_or(0.0) > 0.0 {
        return (0.0, 0.0);
    }
    let duration = job.region_end_seconds.unwrap_or(0.0) - job.region_start_seconds.unwrap_or(0.0);
    if duration <= 0.0 {
        return (0.0, 0.0);
    }
    let gap = if job.region_fade_in_seconds.unwrap_or(0.0) > 0.0
        && job.region_fade_out_seconds.unwrap_or(0.0) > 0.0
    {
        job.region_fade_gap_seconds
            .unwrap_or(0.005)
            .clamp(0.0, 0.05)
            .min(duration)
    } else {
        0.0
    };
    let mut fade_in = job
        .region_fade_in_seconds
        .unwrap_or(0.0)
        .clamp(0.0, duration);
    let mut fade_out = job
        .region_fade_out_seconds
        .unwrap_or(0.0)
        .clamp(0.0, duration);
    let max_total = (duration - gap).max(0.0);
    let total = fade_in + fade_out;
    if total > max_total && total > 0.0 {
        let scale = max_total / total;
        fade_in *= scale;
        fade_out *= scale;
    }
    (fade_in, fade_out)
}

fn codec_args(format: &str, settings: &FormatSettings) -> Vec<String> {
    match format {
        "wav" => {
            let mut args = vec![
                "-c:a".to_string(),
                match settings.wav_bit_depth.unwrap_or(16) {
                    24 => "pcm_s24le".to_string(),
                    32 => "pcm_s32le".to_string(),
                    _ => "pcm_s16le".to_string(),
                },
            ];
            if let Some(sample_rate) = settings.wav_sample_rate {
                args.push("-ar".to_string());
                args.push(sample_rate.to_string());
            }
            args
        }
        "mp3" if settings.mp3_mode.as_deref() == Some("vbr") => vec![
            "-c:a".to_string(),
            "libmp3lame".to_string(),
            "-q:a".to_string(),
            "2".to_string(),
        ],
        "mp3" => vec![
            "-c:a".to_string(),
            "libmp3lame".to_string(),
            "-b:a".to_string(),
            format!("{}k", settings.mp3_bitrate_kbps.unwrap_or(192)),
        ],
        "ogg" => vec![
            "-c:a".to_string(),
            "libvorbis".to_string(),
            "-q:a".to_string(),
            format!("{:.1}", settings.ogg_quality.unwrap_or(5.0)),
        ],
        "flac" => vec![
            "-c:a".to_string(),
            "flac".to_string(),
            "-compression_level".to_string(),
            settings.flac_compression_level.unwrap_or(5).to_string(),
        ],
        "mp4" if settings.mp4_codec.as_deref() == Some("alac") => {
            vec!["-vn".to_string(), "-c:a".to_string(), "alac".to_string()]
        }
        "mp4" => vec![
            "-vn".to_string(),
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            format!("{}k", settings.mp4_bitrate_kbps.unwrap_or(192)),
        ],
        _ => vec![
            "-c:a".to_string(),
            "aac".to_string(),
            "-b:a".to_string(),
            format!("{}k", settings.aac_bitrate_kbps.unwrap_or(192)),
        ],
    }
}

fn write_attribution_sidecar(output_path: &Path, asset: &ExportAssetRecord) -> Result<(), String> {
    let sidecar_path = output_path.with_extension(format!(
        "{}.license.txt",
        output_path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("audio")
    ));
    let text = format!(
        "Name: {}\nLicense: {}\nAttribution: {}\nOriginator: {}\nSource: {}\n",
        asset.name,
        asset.license.as_deref().unwrap_or("unknown"),
        asset
            .attribution
            .as_deref()
            .or(asset.originator.as_deref())
            .unwrap_or("unknown"),
        asset.originator.as_deref().unwrap_or("unknown"),
        asset.source_url.as_deref().unwrap_or(&asset.path_or_url)
    );
    fs::write(sidecar_path, text).map_err(|error| error.to_string())
}

fn verify_full_file_levels(
    connection: &Connection,
    job: &ExportJobRecord,
    output_path: &Path,
) -> Result<(), String> {
    let expected = connection
        .query_row(
            "SELECT peak_dbfs, rms_dbfs
             FROM analysis
             WHERE asset_id = ?1
               AND scope = 'full'
               AND processing_hash = ?2
             ORDER BY analyzed_at DESC
             LIMIT 1",
            params![
                job.asset_id,
                processing_hash_from_processing_json(&job.processing_json)?
            ],
            |row| Ok((row.get::<_, Option<f64>>(0)?, row.get::<_, Option<f64>>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((Some(expected_peak), Some(expected_rms))) = expected else {
        return Ok(());
    };
    let bytes = fs::read(output_path).map_err(|error| error.to_string())?;
    let measured = analyze_rendered_wav_levels(&bytes)?;
    let matched =
        (measured.0 - expected_peak).abs() <= 0.35 && (measured.1 - expected_rms).abs() <= 0.35;
    let verification = if matched { "matched" } else { "mismatch" };
    let mut settings: serde_json::Value =
        serde_json::from_str(&job.format_settings_json).unwrap_or_else(|_| serde_json::json!({}));
    settings["levelVerification"] = serde_json::json!(verification);
    settings["measuredPeakDbfs"] = serde_json::json!(measured.0);
    settings["measuredRmsDbfs"] = serde_json::json!(measured.1);
    connection
        .execute(
            "UPDATE export_jobs SET format_settings_json = ?2 WHERE id = ?1",
            params![job.id, settings.to_string()],
        )
        .map_err(|error| error.to_string())?;
    if matched {
        Ok(())
    } else {
        Err("exported levels did not match processed analysis".to_string())
    }
}

fn analyze_rendered_wav_levels(bytes: &[u8]) -> Result<(f64, f64), String> {
    let wav = parse_wav_info(bytes)?;
    let frame_count = wav.data_size / usize::from(wav.block_align);
    let mut peak = 0.0_f64;
    let mut sum_squares = 0.0_f64;
    let mut sample_count = 0_i64;
    for frame_index in 0..frame_count {
        for channel in 0..wav.channels as usize {
            let sample = read_wav_sample(bytes, &wav, frame_index, channel)? as f64;
            peak = peak.max(sample.abs());
            sum_squares += sample * sample;
            sample_count += 1;
        }
    }
    let rms = if sample_count > 0 {
        (sum_squares / sample_count as f64).sqrt()
    } else {
        0.0
    };
    Ok((dbfs_value(peak), dbfs_value(rms)))
}

fn dbfs_value(value: f64) -> f64 {
    if value > 0.0 {
        20.0 * value.log10()
    } else {
        -120.0
    }
}

fn processing_hash_from_processing_json(processing_json: &str) -> Result<String, String> {
    let chain: GainProcessingChain =
        serde_json::from_str(processing_json).map_err(|_| "invalid processing_json".to_string())?;
    let gain_db = chain.gain.gain_db.clamp(-24.0, 36.0);
    Ok(if gain_db.abs() < 0.005 {
        "processing:none".to_string()
    } else {
        format!("processing:gain:{gain_db:.2}")
    })
}

fn processing_hash_from_settings(settings_json: &str) -> String {
    serde_json::from_str::<serde_json::Value>(settings_json)
        .ok()
        .and_then(|value| {
            value
                .get("processingHash")
                .and_then(|hash| hash.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "processing:none".to_string())
}

fn metadata_relative_path(metadata_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(metadata_json)
        .ok()
        .and_then(|value| {
            value
                .get("normalizedRelativePath")
                .or_else(|| value.get("relativePath"))
                .and_then(|path| path.as_str())
                .map(str::to_string)
        })
}

fn render_wav_region_16_bit(
    bytes: &[u8],
    wav: &WavInfo,
    start_frame: usize,
    end_frame: usize,
    gain_db: f64,
    fade_in_seconds: f64,
    fade_in_slope: f64,
    fade_out_seconds: f64,
    fade_out_slope: f64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<Vec<u8>, String> {
    let frame_count = end_frame - start_frame;
    let output_channels = wav.channels;
    let output_bits = 16_u16;
    let output_block_align = output_channels * (output_bits / 8);
    let data_size = frame_count * usize::from(output_block_align);
    let mut output = Vec::with_capacity(44 + data_size);
    write_wav_header(
        &mut output,
        output_channels,
        wav.sample_rate,
        output_bits,
        data_size as u32,
    );
    let linear_gain = 10_f32.powf((gain_db as f32) / 20.0);
    let fade_in_frames = seconds_to_frame(fade_in_seconds, wav.sample_rate, frame_count);
    let fade_out_frames = seconds_to_frame(fade_out_seconds, wav.sample_rate, frame_count);
    for frame_index in start_frame..end_frame {
        if frame_index % 4096 == 0 {
            deadline.check(token, "export job")?;
        }
        let region_frame = frame_index - start_frame;
        let fade_gain = region_fade_gain(
            region_frame,
            frame_count,
            fade_in_frames,
            fade_in_slope,
            fade_out_frames,
            fade_out_slope,
        );
        for channel in 0..wav.channels as usize {
            let sample =
                read_wav_sample(bytes, wav, frame_index, channel)? * linear_gain * fade_gain;
            let quantized = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            output.extend_from_slice(&quantized.to_le_bytes());
        }
    }
    Ok(output)
}

fn render_pcm_region_16_bit(
    pcm: &DecodedPcm,
    start_frame: usize,
    end_frame: usize,
    gain_db: f64,
    fade_in_seconds: f64,
    fade_in_slope: f64,
    fade_out_seconds: f64,
    fade_out_slope: f64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<Vec<u8>, String> {
    let frame_count = end_frame.saturating_sub(start_frame);
    if frame_count == 0 {
        return Err("export range has no audio frames".to_string());
    }
    let data_size = frame_count * usize::from(pcm.channels) * 2;
    let mut output = Vec::with_capacity(44 + data_size);
    write_wav_header(
        &mut output,
        pcm.channels,
        pcm.sample_rate,
        16,
        data_size as u32,
    );
    let linear_gain = 10_f32.powf((gain_db as f32) / 20.0);
    let fade_in_frames = seconds_to_frame(fade_in_seconds, pcm.sample_rate, frame_count);
    let fade_out_frames = seconds_to_frame(fade_out_seconds, pcm.sample_rate, frame_count);
    for frame_index in start_frame..end_frame {
        if frame_index % 4096 == 0 {
            deadline.check(token, "export job")?;
        }
        let region_frame = frame_index - start_frame;
        let fade_gain = region_fade_gain(
            region_frame,
            frame_count,
            fade_in_frames,
            fade_in_slope,
            fade_out_frames,
            fade_out_slope,
        );
        for channel in 0..pcm.channels as usize {
            let sample = pcm.sample(frame_index, channel) * linear_gain * fade_gain;
            let quantized = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            output.extend_from_slice(&quantized.to_le_bytes());
        }
    }
    Ok(output)
}

fn region_fade_gain(
    frame: usize,
    frame_count: usize,
    fade_in_frames: usize,
    fade_in_slope: f64,
    fade_out_frames: usize,
    fade_out_slope: f64,
) -> f32 {
    let mut gain = 1.0_f32;
    if fade_in_frames > 0 && frame < fade_in_frames {
        gain *=
            (frame as f32 / fade_in_frames as f32).powf(clamped_fade_slope(fade_in_slope) as f32);
    }
    if fade_out_frames > 0 {
        let fade_start = frame_count.saturating_sub(fade_out_frames);
        if frame >= fade_start {
            let fade_span = fade_out_frames.saturating_sub(1).max(1) as f32;
            gain *= (1.0 - ((frame - fade_start) as f32 / fade_span))
                .powf(clamped_fade_slope(fade_out_slope) as f32);
        }
    }
    gain.clamp(0.0, 1.0)
}

fn clamped_fade_slope(slope: f64) -> f64 {
    slope.clamp(0.25, 4.0)
}

fn render_crossfaded_wav_loop_16_bit(
    bytes: &[u8],
    wav: &WavInfo,
    start_frame: usize,
    end_frame: usize,
    crossfade_frames: usize,
    crossfade_slope: f64,
    gain_db: f64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<Vec<u8>, String> {
    let region_frames = end_frame.saturating_sub(start_frame);
    if region_frames < 2 {
        return Err("export range has no audio frames".to_string());
    }
    let fade_frames = crossfade_frames.clamp(1, (region_frames - 1) / 2);
    let output_frames = region_frames - fade_frames;
    let output_channels = wav.channels;
    let output_bits = 16_u16;
    let output_block_align = output_channels * (output_bits / 8);
    let data_size = output_frames * usize::from(output_block_align);
    let mut output = Vec::with_capacity(44 + data_size);
    write_wav_header(
        &mut output,
        output_channels,
        wav.sample_rate,
        output_bits,
        data_size as u32,
    );
    let linear_gain = 10_f32.powf((gain_db as f32) / 20.0);
    let crossfade_start_frame = output_frames - fade_frames;
    for output_frame in 0..output_frames {
        if output_frame % 4096 == 0 {
            deadline.check(token, "export job")?;
        }
        for channel in 0..wav.channels as usize {
            let sample = if output_frame >= crossfade_start_frame {
                let fade_frame = output_frame - crossfade_start_frame;
                let denominator = fade_frames.saturating_sub(1).max(1) as f32;
                let progress = fade_frame as f32 / denominator;
                let head_weight = progress.powf(crossfade_slope as f32);
                let tail_weight = 1.0 - head_weight;
                let head = read_wav_sample(bytes, wav, start_frame + fade_frame, channel)?;
                let tail =
                    read_wav_sample(bytes, wav, end_frame - fade_frames + fade_frame, channel)?;
                tail * tail_weight + head * head_weight
            } else {
                read_wav_sample(
                    bytes,
                    wav,
                    start_frame + fade_frames + output_frame,
                    channel,
                )?
            } * linear_gain;
            let quantized = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            output.extend_from_slice(&quantized.to_le_bytes());
        }
    }
    Ok(output)
}

fn render_crossfaded_pcm_loop_16_bit(
    pcm: &DecodedPcm,
    start_frame: usize,
    end_frame: usize,
    crossfade_frames: usize,
    crossfade_slope: f64,
    gain_db: f64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<Vec<u8>, String> {
    let region_frames = end_frame.saturating_sub(start_frame);
    if region_frames < 2 {
        return Err("export range has no audio frames".to_string());
    }
    let fade_frames = crossfade_frames.clamp(1, (region_frames - 1) / 2);
    let output_frames = region_frames - fade_frames;
    let data_size = output_frames * usize::from(pcm.channels) * 2;
    let mut output = Vec::with_capacity(44 + data_size);
    write_wav_header(
        &mut output,
        pcm.channels,
        pcm.sample_rate,
        16,
        data_size as u32,
    );
    let linear_gain = 10_f32.powf((gain_db as f32) / 20.0);
    let crossfade_start_frame = output_frames - fade_frames;
    for output_frame in 0..output_frames {
        if output_frame % 4096 == 0 {
            deadline.check(token, "export job")?;
        }
        for channel in 0..pcm.channels as usize {
            let sample = if output_frame >= crossfade_start_frame {
                let fade_frame = output_frame - crossfade_start_frame;
                let progress = fade_frame as f32 / fade_frames.saturating_sub(1).max(1) as f32;
                let head_weight = progress.powf(crossfade_slope as f32);
                let tail_weight = 1.0 - head_weight;
                let head = pcm.sample(start_frame + fade_frame, channel);
                let tail = pcm.sample(end_frame - fade_frames + fade_frame, channel);
                tail * tail_weight + head * head_weight
            } else {
                pcm.sample(start_frame + fade_frames + output_frame, channel)
            } * linear_gain;
            let quantized = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            output.extend_from_slice(&quantized.to_le_bytes());
        }
    }
    Ok(output)
}

fn render_mock_wav_region_16_bit(duration_seconds: f64, gain_db: f64) -> Vec<u8> {
    let sample_rate = 44_100_u32;
    let channels = 2_u16;
    let bits_per_sample = 16_u16;
    let frame_count = (duration_seconds.max(0.02) * sample_rate as f64).round() as usize;
    let data_size = frame_count * usize::from(channels) * 2;
    let mut output = Vec::with_capacity(44 + data_size);
    write_wav_header(
        &mut output,
        channels,
        sample_rate,
        bits_per_sample,
        data_size as u32,
    );
    let linear_gain = 10_f32.powf((gain_db as f32) / 20.0);
    for frame_index in 0..frame_count {
        let t = frame_index as f32 / sample_rate as f32;
        let envelope = (1.0 - (frame_index as f32 / frame_count as f32)).max(0.0);
        for channel in 0..channels {
            let frequency = if channel == 0 { 220.0 } else { 330.0 };
            let sample = (t * frequency * std::f32::consts::TAU).sin() * envelope * 0.25;
            let quantized = (sample * linear_gain).clamp(-1.0, 1.0) * i16::MAX as f32;
            output.extend_from_slice(&(quantized.round() as i16).to_le_bytes());
        }
    }
    output
}

fn write_wav_header(
    output: &mut Vec<u8>,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    data_size: u32,
) {
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&(36 + data_size).to_le_bytes());
    output.extend_from_slice(b"WAVEfmt ");
    output.extend_from_slice(&16_u32.to_le_bytes());
    output.extend_from_slice(&1_u16.to_le_bytes());
    output.extend_from_slice(&channels.to_le_bytes());
    output.extend_from_slice(&sample_rate.to_le_bytes());
    output.extend_from_slice(&byte_rate.to_le_bytes());
    output.extend_from_slice(&block_align.to_le_bytes());
    output.extend_from_slice(&bits_per_sample.to_le_bytes());
    output.extend_from_slice(b"data");
    output.extend_from_slice(&data_size.to_le_bytes());
}

fn write_wav_header_with_format(
    output: &mut fs::File,
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    data_size: u32,
) -> Result<(), String> {
    let block_align = channels * (bits_per_sample / 8);
    let byte_rate = sample_rate * u32::from(block_align);
    let mut header = Vec::with_capacity(44);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + data_size).to_le_bytes());
    header.extend_from_slice(b"WAVEfmt ");
    header.extend_from_slice(&16_u32.to_le_bytes());
    header.extend_from_slice(&audio_format.to_le_bytes());
    header.extend_from_slice(&channels.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    header.extend_from_slice(&byte_rate.to_le_bytes());
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&bits_per_sample.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_size.to_le_bytes());
    output.write_all(&header).map_err(|error| error.to_string())
}

fn parse_wav_info(bytes: &[u8]) -> Result<WavInfo, String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("invalid WAV header".to_string());
    }
    let mut offset = 12;
    let mut audio_format = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut block_align = None;
    let mut samples_per_block = None;
    let mut adpcm_coefficients = Vec::new();
    let mut data_offset = None;
    let mut data_size = None;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset + 4];
        let chunk_size = read_u32(bytes, offset + 4)? as usize;
        let chunk_data = offset + 8;
        if chunk_data + chunk_size > bytes.len() {
            return Err("WAV chunk extends past file end".to_string());
        }
        if chunk_id == b"fmt " {
            audio_format = Some(normalized_wav_audio_format(
                read_u16(bytes, chunk_data)?,
                &bytes[chunk_data..chunk_data + chunk_size],
            ));
            channels = Some(read_u16(bytes, chunk_data + 2)?);
            sample_rate = Some(read_u32(bytes, chunk_data + 4)?);
            block_align = Some(read_u16(bytes, chunk_data + 12)?);
            bits_per_sample = Some(read_u16(bytes, chunk_data + 14)?);
            if read_u16(bytes, chunk_data)? == 2 && chunk_size >= 32 {
                samples_per_block = Some(read_u16(bytes, chunk_data + 18)?);
                let coefficient_count = read_u16(bytes, chunk_data + 20)? as usize;
                for index in 0..coefficient_count {
                    let coefficient_offset = chunk_data + 22 + index * 4;
                    if coefficient_offset + 4 <= chunk_data + chunk_size {
                        adpcm_coefficients.push((
                            i16::from_le_bytes(slice_array(bytes, coefficient_offset)?),
                            i16::from_le_bytes(slice_array(bytes, coefficient_offset + 2)?),
                        ));
                    }
                }
            }
        }
        if chunk_id == b"data" {
            data_offset = Some(chunk_data);
            data_size = Some(chunk_size);
        }
        offset = chunk_data + chunk_size + (chunk_size % 2);
    }
    Ok(WavInfo {
        audio_format: audio_format.ok_or_else(|| "WAV fmt chunk missing".to_string())?,
        channels: channels.ok_or_else(|| "WAV channel count missing".to_string())?,
        sample_rate: sample_rate.ok_or_else(|| "WAV sample rate missing".to_string())?,
        bits_per_sample: bits_per_sample.ok_or_else(|| "WAV bit depth missing".to_string())?,
        block_align: block_align.ok_or_else(|| "WAV block alignment missing".to_string())?,
        data_offset: data_offset.ok_or_else(|| "WAV data chunk missing".to_string())?,
        data_size: data_size.ok_or_else(|| "WAV data chunk missing".to_string())?,
        samples_per_block,
        adpcm_coefficients,
    })
}

fn parse_wav_info_file(file: &mut fs::File) -> Result<WavInfo, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let file_len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("invalid WAV header".to_string());
    }

    let mut offset = 12_u64;
    let mut audio_format = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut block_align = None;
    let mut samples_per_block = None;
    let mut adpcm_coefficients = Vec::new();
    let mut data_offset = None;
    let mut data_size = None;

    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut chunk_header = [0_u8; 8];
        file.read_exact(&mut chunk_header)
            .map_err(|error| error.to_string())?;
        let chunk_size = u32::from_le_bytes([
            chunk_header[4],
            chunk_header[5],
            chunk_header[6],
            chunk_header[7],
        ]) as u64;
        let chunk_data = offset + 8;
        if chunk_data + chunk_size > file_len {
            return Err("WAV chunk extends past file end".to_string());
        }
        if &chunk_header[0..4] == b"fmt " {
            let read_len = 64_u64.min(chunk_size) as usize;
            let mut fmt = vec![0_u8; read_len];
            file.seek(SeekFrom::Start(chunk_data))
                .map_err(|error| error.to_string())?;
            file.read_exact(&mut fmt)
                .map_err(|error| error.to_string())?;
            if fmt.len() < 16 {
                return Err("WAV fmt chunk is too small".to_string());
            }
            audio_format = Some(normalized_wav_audio_format(
                u16::from_le_bytes([fmt[0], fmt[1]]),
                &fmt,
            ));
            channels = Some(u16::from_le_bytes([fmt[2], fmt[3]]));
            sample_rate = Some(u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]));
            block_align = Some(u16::from_le_bytes([fmt[12], fmt[13]]));
            bits_per_sample = Some(u16::from_le_bytes([fmt[14], fmt[15]]));
            if u16::from_le_bytes([fmt[0], fmt[1]]) == 2 && fmt.len() >= 32 {
                samples_per_block = Some(u16::from_le_bytes([fmt[18], fmt[19]]));
                let coefficient_count = u16::from_le_bytes([fmt[20], fmt[21]]) as usize;
                for index in 0..coefficient_count {
                    let coefficient_offset = 22 + index * 4;
                    if coefficient_offset + 4 <= fmt.len() {
                        adpcm_coefficients.push((
                            i16::from_le_bytes([
                                fmt[coefficient_offset],
                                fmt[coefficient_offset + 1],
                            ]),
                            i16::from_le_bytes([
                                fmt[coefficient_offset + 2],
                                fmt[coefficient_offset + 3],
                            ]),
                        ));
                    }
                }
            }
        }
        if &chunk_header[0..4] == b"data" {
            data_offset = Some(chunk_data as usize);
            data_size = Some(chunk_size as usize);
        }
        offset = chunk_data + chunk_size + (chunk_size % 2);
    }

    Ok(WavInfo {
        audio_format: audio_format.ok_or_else(|| "WAV fmt chunk missing".to_string())?,
        channels: channels.ok_or_else(|| "WAV channel count missing".to_string())?,
        sample_rate: sample_rate.ok_or_else(|| "WAV sample rate missing".to_string())?,
        bits_per_sample: bits_per_sample.ok_or_else(|| "WAV bit depth missing".to_string())?,
        block_align: block_align.ok_or_else(|| "WAV block alignment missing".to_string())?,
        data_offset: data_offset.ok_or_else(|| "WAV data chunk missing".to_string())?,
        data_size: data_size.ok_or_else(|| "WAV data chunk missing".to_string())?,
        samples_per_block,
        adpcm_coefficients,
    })
}

fn read_wav_sample(
    bytes: &[u8],
    wav: &WavInfo,
    frame_index: usize,
    channel: usize,
) -> Result<f32, String> {
    let bytes_per_sample = usize::from(wav.bits_per_sample / 8);
    let offset =
        wav.data_offset + frame_index * usize::from(wav.block_align) + channel * bytes_per_sample;
    match (wav.audio_format, wav.bits_per_sample) {
        (1, 8) => Ok(((bytes
            .get(offset)
            .copied()
            .ok_or_else(|| "unexpected end of WAV data".to_string())?
            as f32
            - 128.0)
            / 128.0)
            .clamp(-1.0, 1.0)),
        (1, 16) => Ok(
            (i16::from_le_bytes(slice_array(bytes, offset)?) as f32 / i16::MAX as f32)
                .clamp(-1.0, 1.0),
        ),
        (1, 24) => {
            let sample_bytes = bytes
                .get(offset..offset + 3)
                .ok_or_else(|| "unexpected end of WAV data".to_string())?;
            let raw = i32::from_le_bytes([
                sample_bytes[0],
                sample_bytes[1],
                sample_bytes[2],
                if sample_bytes[2] & 0x80 == 0 { 0 } else { 0xff },
            ]);
            Ok((raw as f32 / 8_388_607.0).clamp(-1.0, 1.0))
        }
        (1, 32) => Ok(
            (i32::from_le_bytes(slice_array(bytes, offset)?) as f32 / i32::MAX as f32)
                .clamp(-1.0, 1.0),
        ),
        (3, 32) => Ok(f32::from_le_bytes(slice_array(bytes, offset)?).clamp(-1.0, 1.0)),
        (3, 64) => Ok((f64::from_le_bytes(slice_array(bytes, offset)?) as f32).clamp(-1.0, 1.0)),
        _ => Err("unsupported WAV sample format".to_string()),
    }
}

fn decode_ms_adpcm_wav(bytes: &[u8], wav: &WavInfo) -> Result<DecodedPcm, String> {
    if wav.audio_format != 2 {
        return Err("WAV is not Microsoft ADPCM".to_string());
    }
    let channels = usize::from(wav.channels);
    if channels == 0 || channels > 2 {
        return Err("Microsoft ADPCM supports one or two channels".to_string());
    }
    let block_align = usize::from(wav.block_align);
    let samples_per_block = usize::from(
        wav.samples_per_block
            .ok_or_else(|| "ADPCM samples per block missing".to_string())?,
    );
    if block_align < channels * 7 || samples_per_block < 2 {
        return Err("invalid ADPCM block layout".to_string());
    }
    let coefficients = if wav.adpcm_coefficients.is_empty() {
        default_ms_adpcm_coefficients().to_vec()
    } else {
        wav.adpcm_coefficients.clone()
    };
    let data_end = wav.data_offset + wav.data_size;
    let mut decoded = Vec::new();
    let mut offset = wav.data_offset;
    while offset + block_align <= data_end && offset + block_align <= bytes.len() {
        decode_ms_adpcm_block(
            &bytes[offset..offset + block_align],
            channels,
            samples_per_block,
            &coefficients,
            &mut decoded,
        )?;
        offset += block_align;
    }
    if decoded.is_empty() {
        return Err("ADPCM WAV contained no decodable audio".to_string());
    }
    Ok(DecodedPcm {
        channels: wav.channels,
        sample_rate: wav.sample_rate,
        samples: decoded,
    })
}

fn decode_ms_adpcm_block(
    block: &[u8],
    channels: usize,
    samples_per_block: usize,
    coefficients: &[(i16, i16)],
    output: &mut Vec<f32>,
) -> Result<(), String> {
    const ADAPTATION_TABLE: [i32; 16] = [
        230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230,
    ];
    let mut cursor = 0;
    let predictors = block
        .get(cursor..cursor + channels)
        .ok_or_else(|| "truncated ADPCM predictor header".to_string())?;
    cursor += channels;
    let mut delta = Vec::with_capacity(channels);
    for _ in 0..channels {
        delta.push(i16::from_le_bytes(
            block
                .get(cursor..cursor + 2)
                .ok_or_else(|| "truncated ADPCM delta header".to_string())?
                .try_into()
                .map_err(|_| "invalid ADPCM delta".to_string())?,
        ) as i32);
        cursor += 2;
    }
    let mut sample1 = Vec::with_capacity(channels);
    for _ in 0..channels {
        sample1.push(i16::from_le_bytes(
            block
                .get(cursor..cursor + 2)
                .ok_or_else(|| "truncated ADPCM sample header".to_string())?
                .try_into()
                .map_err(|_| "invalid ADPCM sample".to_string())?,
        ) as i32);
        cursor += 2;
    }
    let mut sample2 = Vec::with_capacity(channels);
    for _ in 0..channels {
        sample2.push(i16::from_le_bytes(
            block
                .get(cursor..cursor + 2)
                .ok_or_else(|| "truncated ADPCM sample header".to_string())?
                .try_into()
                .map_err(|_| "invalid ADPCM sample".to_string())?,
        ) as i32);
        cursor += 2;
    }

    let mut per_channel = vec![Vec::with_capacity(samples_per_block); channels];
    for channel in 0..channels {
        per_channel[channel].push(sample2[channel]);
        per_channel[channel].push(sample1[channel]);
    }
    while cursor < block.len()
        && per_channel
            .iter()
            .any(|samples| samples.len() < samples_per_block)
    {
        let byte = block[cursor];
        cursor += 1;
        if channels == 1 {
            decode_ms_adpcm_nibble(
                byte >> 4,
                predictors[0],
                coefficients,
                &mut delta[0],
                &mut sample1[0],
                &mut sample2[0],
                &mut per_channel[0],
                samples_per_block,
                &ADAPTATION_TABLE,
            )?;
            decode_ms_adpcm_nibble(
                byte & 0x0f,
                predictors[0],
                coefficients,
                &mut delta[0],
                &mut sample1[0],
                &mut sample2[0],
                &mut per_channel[0],
                samples_per_block,
                &ADAPTATION_TABLE,
            )?;
        } else {
            for (channel, nibble) in [byte >> 4, byte & 0x0f].into_iter().enumerate() {
                decode_ms_adpcm_nibble(
                    nibble,
                    predictors[channel],
                    coefficients,
                    &mut delta[channel],
                    &mut sample1[channel],
                    &mut sample2[channel],
                    &mut per_channel[channel],
                    samples_per_block,
                    &ADAPTATION_TABLE,
                )?;
            }
        }
    }
    let frames = per_channel
        .iter()
        .map(Vec::len)
        .min()
        .unwrap_or(0)
        .min(samples_per_block);
    for frame in 0..frames {
        for channel_samples in &per_channel {
            output.push((channel_samples[frame] as f32 / i16::MAX as f32).clamp(-1.0, 1.0));
        }
    }
    Ok(())
}

fn decode_ms_adpcm_nibble(
    nibble: u8,
    predictor: u8,
    coefficients: &[(i16, i16)],
    delta: &mut i32,
    sample1: &mut i32,
    sample2: &mut i32,
    samples: &mut Vec<i32>,
    samples_per_block: usize,
    adaptation_table: &[i32; 16],
) -> Result<(), String> {
    if samples.len() >= samples_per_block {
        return Ok(());
    }
    let (coef1, coef2) = coefficients
        .get(usize::from(predictor))
        .ok_or_else(|| "ADPCM predictor references missing coefficient".to_string())?;
    let signed_nibble = if nibble & 0x08 != 0 {
        i32::from(nibble) - 16
    } else {
        i32::from(nibble)
    };
    let predicted = ((*sample1 * i32::from(*coef1) + *sample2 * i32::from(*coef2)) / 256)
        + signed_nibble * *delta;
    let next = predicted.clamp(i32::from(i16::MIN), i32::from(i16::MAX));
    *sample2 = *sample1;
    *sample1 = next;
    *delta = ((*delta * adaptation_table[usize::from(nibble)]) / 256).max(16);
    samples.push(next);
    Ok(())
}

fn default_ms_adpcm_coefficients() -> &'static [(i16, i16); 7] {
    &[
        (256, 0),
        (512, -256),
        (0, 0),
        (192, 64),
        (240, 0),
        (460, -208),
        (392, -232),
    ]
}

fn normalized_wav_audio_format(format: u16, fmt: &[u8]) -> u16 {
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xfffe;
    const PCM_SUBFORMAT: [u8; 16] = [
        0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
        0x71,
    ];
    const FLOAT_SUBFORMAT: [u8; 16] = [
        0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b,
        0x71,
    ];

    if format != WAVE_FORMAT_EXTENSIBLE || fmt.len() < 40 {
        return format;
    }
    match fmt.get(24..40) {
        Some(subformat) if subformat == PCM_SUBFORMAT => 1,
        Some(subformat) if subformat == FLOAT_SUBFORMAT => 3,
        _ => format,
    }
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16, String> {
    Ok(u16::from_le_bytes(slice_array(bytes, offset)?))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(slice_array(bytes, offset)?))
}

fn slice_array<const N: usize>(bytes: &[u8], offset: usize) -> Result<[u8; N], String> {
    let slice = bytes
        .get(offset..offset + N)
        .ok_or_else(|| "unexpected end of WAV data".to_string())?;
    slice
        .try_into()
        .map_err(|_| "invalid WAV slice".to_string())
}

fn seconds_to_frame(seconds: f64, sample_rate: u32, frame_count: usize) -> usize {
    (seconds.max(0.0) * sample_rate as f64)
        .round()
        .clamp(0.0, frame_count as f64) as usize
}

fn sanitize_file_stem(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("region");
    let sanitized = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "region".to_string()
    } else {
        sanitized
    }
}

fn make_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{prefix}_{nanos}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open sqlite memory database");
        connection
            .execute_batch(include_str!("../migrations/001_core_data_layer.up.sql"))
            .expect("apply core data migration");
        connection
            .execute(
                "INSERT INTO sources (id, kind, provider, display_name, root_uri)
                 VALUES ('source_test', 'local', 'local', 'Fixtures', 'fixtures')",
                [],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO assets (id, source_id, stable_key, path_or_url, name, availability)
                 VALUES ('asset_test', 'source_test', 'fixture-key', 'fixture.wav', 'fixture.wav', 'available')",
                [],
            )
            .expect("insert asset");
        connection
    }

    fn test_processing_json(gain_db: f64) -> String {
        format!(
            r#"{{"chainOrder":["gain"],"gain":{{"enabled":true,"gainDb":{gain_db},"minDb":-24,"maxDb":36}},"version":1}}"#
        )
    }

    fn test_export_input(asset_id: &str) -> ExportJobInput {
        ExportJobInput {
            asset_id: asset_id.to_string(),
            format: "wav".to_string(),
            output_folder: "F:/Exports".to_string(),
            filename_pattern: "{name}".to_string(),
            export_scope: "full".to_string(),
            region_start_seconds: None,
            region_end_seconds: None,
            format_settings_json: "{}".to_string(),
            processing_json: test_processing_json(0.0),
            processing_hash: "processing:none".to_string(),
            preserve_folder_structure: false,
            include_attribution_sidecar: false,
            overwrite_mode: "rename".to_string(),
        }
    }

    fn extensible_pcm16_wav_bytes() -> Vec<u8> {
        let sample_rate = 48_000_u32;
        let channels = 1_u16;
        let bits_per_sample = 16_u16;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * u32::from(block_align);
        let samples: Vec<i16> = (0..256)
            .map(|index| {
                let phase = index as f32 / 16.0;
                (phase.sin() * i16::MAX as f32 * 0.4) as i16
            })
            .collect();
        let data_size = (samples.len() * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(4 + 8 + 40 + 8 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&40_u32.to_le_bytes());
        bytes.extend_from_slice(&0xfffe_u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(&22_u16.to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&[
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38,
            0x9b, 0x71,
        ]);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        bytes
    }

    fn pcm8_wav_bytes() -> Vec<u8> {
        let sample_rate = 22_050_u32;
        let channels = 1_u16;
        let bits_per_sample = 8_u16;
        let block_align = 1_u16;
        let byte_rate = sample_rate;
        let samples: Vec<u8> = (0..256)
            .map(|index| {
                let phase = index as f32 / 16.0;
                (128.0 + phase.sin() * 48.0).round().clamp(0.0, 255.0) as u8
            })
            .collect();
        let data_size = samples.len() as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        bytes.extend_from_slice(&samples);
        bytes
    }

    fn ms_adpcm_wav_bytes() -> Vec<u8> {
        let sample_rate = 44_100_u32;
        let channels = 1_u16;
        let block_align = 11_u16;
        let samples_per_block = 10_u16;
        let byte_rate = sample_rate * u32::from(block_align) / u32::from(samples_per_block);
        let coefficients = default_ms_adpcm_coefficients();
        let mut block = Vec::new();
        block.push(0);
        block.extend_from_slice(&16_i16.to_le_bytes());
        block.extend_from_slice(&1000_i16.to_le_bytes());
        block.extend_from_slice(&0_i16.to_le_bytes());
        block.extend_from_slice(&[0, 0, 0, 0]);
        let data_size = block.len() as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(4 + 8 + 50 + 8 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&50_u32.to_le_bytes());
        bytes.extend_from_slice(&2_u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&4_u16.to_le_bytes());
        bytes.extend_from_slice(&32_u16.to_le_bytes());
        bytes.extend_from_slice(&samples_per_block.to_le_bytes());
        bytes.extend_from_slice(&(coefficients.len() as u16).to_le_bytes());
        for (coef1, coef2) in coefficients {
            bytes.extend_from_slice(&coef1.to_le_bytes());
            bytes.extend_from_slice(&coef2.to_le_bytes());
        }
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        bytes.extend_from_slice(&block);
        bytes
    }

    #[test]
    fn queues_export_with_gain_processing_snapshot() {
        let connection = test_connection();
        let mut input = test_export_input("asset_test");
        input.export_scope = "region".to_string();
        input.region_start_seconds = Some(0.1);
        input.region_end_seconds = Some(0.3);
        input.processing_json = test_processing_json(6.0);
        input.processing_hash = "processing:gain:6.00".to_string();
        let job = queue_export_job(&connection, input).expect("queue export");

        assert_eq!(job.status, "queued");
        assert_eq!(job.processing_hash, "processing:gain:6.00");
    }

    #[test]
    fn rejects_region_export_without_valid_region_bounds() {
        let connection = test_connection();
        let mut input = test_export_input("asset_test");
        input.export_scope = "region".to_string();
        input.region_start_seconds = Some(0.3);
        input.region_end_seconds = Some(0.1);
        let error = queue_export_job(&connection, input).expect_err("reject invalid region");

        assert!(error.contains("region export end"));
    }

    #[test]
    fn rejects_non_gain_processing_contracts() {
        let connection = test_connection();
        let mut input = test_export_input("asset_test");
        input.processing_json = r#"{"chainOrder":["gain","eq"],"gain":{"enabled":true,"gainDb":0,"minDb":-24,"maxDb":36},"version":1}"#.to_string();
        let error = queue_export_job(&connection, input).expect_err("reject eq chain");

        assert!(error.contains("gain-only"));
    }

    #[test]
    fn queues_batch_with_settings_and_lists_snapshots() {
        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO assets (id, source_id, stable_key, path_or_url, name, availability)
                 VALUES ('asset_second', 'source_test', 'fixture-key-2', 'two.wav', 'two.wav', 'available')",
                [],
            )
            .expect("insert second asset");

        let jobs = queue_export_jobs(
            &connection,
            ExportBatchInput {
                asset_ids: vec!["asset_test".to_string(), "asset_second".to_string()],
                format: "mp3".to_string(),
                output_folder: "F:/Exports".to_string(),
                filename_pattern: "{name}_{gain}".to_string(),
                export_scope: "full".to_string(),
                region_start_seconds: None,
                region_end_seconds: None,
                format_settings_json: r#"{"mp3BitrateKbps":256,"mp3Mode":"cbr"}"#.to_string(),
                processing_json: test_processing_json(0.0),
                processing_hash: "processing:none".to_string(),
                preserve_folder_structure: true,
                include_attribution_sidecar: true,
                overwrite_mode: "rename".to_string(),
            },
        )
        .expect("queue batch");
        let listed = list_export_jobs(&connection, Some(10)).expect("list jobs");

        assert_eq!(jobs.len(), 2);
        assert!(listed
            .iter()
            .any(|job| job.filename_pattern == "{name}_{gain}"));
    }

    #[test]
    fn export_output_uses_original_name_and_ffmpeg_args() {
        let connection = test_connection();
        let source_path =
            std::env::temp_dir().join(format!("sonilabs_ffmpeg_args_{}.wav", std::process::id()));
        fs::write(&source_path, b"not-used-by-command-builder").expect("write temp source");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1 WHERE id = 'asset_test'",
                params![source_path.to_string_lossy()],
            )
            .expect("update source path");
        let mut input = test_export_input("asset_test");
        input.format = "ogg".to_string();
        input.filename_pattern = "{name}_{scope}_{region_start}_{region_end}".to_string();
        input.export_scope = "region".to_string();
        input.region_start_seconds = Some(0.25);
        input.region_end_seconds = Some(0.75);
        input.format_settings_json = r#"{"oggQuality":7}"#.to_string();
        input.processing_json = test_processing_json(3.0);
        input.processing_hash = "processing:gain:3.00".to_string();
        let snapshot = queue_export_job(&connection, input).expect("queue job");
        let job = export_job_record(&connection, &snapshot.id).expect("read job");
        let asset = export_asset(&connection, "asset_test").expect("asset");
        let chain: GainProcessingChain = serde_json::from_str(&job.processing_json).expect("chain");
        let settings =
            parse_format_settings(&job.format, &job.format_settings_json).expect("settings");
        let planned = plan_output_path(&job, &asset, &chain, &settings).expect("plan");
        let args = build_ffmpeg_args(
            Path::new("ffmpeg"),
            &job,
            &asset,
            &chain,
            &settings,
            &planned.path,
        )
        .expect("ffmpeg args");

        assert!(planned
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .starts_with("fixture.ogg"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-c:a" && pair[1] == "libvorbis"));
        assert!(args
            .windows(2)
            .any(|pair| pair[0] == "-af" && pair[1] == "volume=3.00dB"));
        let _ = fs::remove_file(source_path);
    }

    #[test]
    fn ffmpeg_crossfade_loop_matches_native_shortened_layout() {
        let connection = test_connection();
        let source_path = std::env::temp_dir().join(format!(
            "sonilabs_ffmpeg_crossfade_args_{}.wav",
            std::process::id()
        ));
        fs::write(&source_path, b"not-used-by-command-builder").expect("write temp source");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1 WHERE id = 'asset_test'",
                params![source_path.to_string_lossy()],
            )
            .expect("update source path");
        let mut input = test_export_input("asset_test");
        input.format = "ogg".to_string();
        input.export_scope = "region".to_string();
        input.region_start_seconds = Some(0.25);
        input.region_end_seconds = Some(0.75);
        input.format_settings_json =
            r#"{"oggQuality":7,"loopCrossfadeSeconds":0.05,"loopCrossfadeSlope":1.0}"#.to_string();
        let snapshot = queue_export_job(&connection, input).expect("queue job");
        let job = export_job_record(&connection, &snapshot.id).expect("read job");
        let asset = export_asset(&connection, "asset_test").expect("asset");
        let chain: GainProcessingChain = serde_json::from_str(&job.processing_json).expect("chain");
        let settings =
            parse_format_settings(&job.format, &job.format_settings_json).expect("settings");
        let planned = plan_output_path(&job, &asset, &chain, &settings).expect("plan");
        let args = build_ffmpeg_args(
            Path::new("ffmpeg"),
            &job,
            &asset,
            &chain,
            &settings,
            &planned.path,
        )
        .expect("ffmpeg args");
        let filter = args
            .windows(2)
            .find_map(|pair| (pair[0] == "-filter_complex").then_some(pair[1].as_str()))
            .expect("filter complex");

        assert!(filter.contains("[base]atrim=start=0.050000:end=0.450000"));
        assert!(!filter.contains("[base]atrim=start=0:end=0.450000"));
        let _ = fs::remove_file(source_path);
    }

    #[test]
    fn export_ignores_filename_pattern_and_does_not_rename_collisions() {
        let connection = test_connection();
        let output_dir =
            std::env::temp_dir().join(format!("sonilabs_name_invariant_{}", std::process::id()));
        fs::create_dir_all(&output_dir).expect("create output dir");
        let existing = output_dir.join("fixture.mp3");
        fs::write(&existing, b"existing").expect("write existing export");
        let source_path = output_dir.join("fixture.wav");
        fs::write(&source_path, b"not-used-by-planner").expect("write source");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'fixture.wav' WHERE id = 'asset_test'",
                params![source_path.to_string_lossy()],
            )
            .expect("update source path");
        let mut input = test_export_input("asset_test");
        input.format = "mp3".to_string();
        input.output_folder = output_dir.to_string_lossy().to_string();
        input.filename_pattern = "{name}_{scope}_{gain}".to_string();
        input.overwrite_mode = "rename".to_string();
        let snapshot = queue_export_job(&connection, input).expect("queue job");
        let job = export_job_record(&connection, &snapshot.id).expect("read job");
        let asset = export_asset(&connection, "asset_test").expect("asset");
        let chain: GainProcessingChain = serde_json::from_str(&job.processing_json).expect("chain");
        let settings =
            parse_format_settings(&job.format, &job.format_settings_json).expect("settings");
        let planned = plan_output_path(&job, &asset, &chain, &settings).expect("plan");

        assert_eq!(planned.path, existing);
        assert!(planned.skipped);
        let _ = fs::remove_dir_all(output_dir);
    }

    #[test]
    fn rendered_drag_export_reuses_clean_original_name() {
        let connection = test_connection();
        let temp_root = std::env::temp_dir().join(format!(
            "sonilabs_drag_name_invariant_{}",
            std::process::id()
        ));
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");
        let export_dir = temp_root.join("sonilabs-export-drag");
        fs::create_dir_all(&export_dir).expect("create drag dir");
        fs::write(export_dir.join("short-tone.wav"), b"stale").expect("write stale file");

        let prepared = prepare_asset_drag_file(
            &connection,
            &temp_root,
            None,
            TempAssetDragExportInput {
                asset_id: "asset_test".to_string(),
                display_name: Some("short-tone.wav".to_string()),
                format: "wav".to_string(),
                export_scope: "full".to_string(),
                region_start_seconds: None,
                region_end_seconds: None,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: test_processing_json(3.0),
                processing_hash: "processing:gain:3.00".to_string(),
            },
        )
        .expect("prepare rendered drag");

        assert_eq!(
            Path::new(&prepared.path)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("short-tone.wav")
        );
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn retry_failed_job_resets_failure_state() {
        let connection = test_connection();
        let job = queue_export_job(&connection, test_export_input("asset_test")).expect("queue");
        mark_job_failed(&connection, &job.id, "boom").expect("mark failed");

        let retried = retry_export_job(&connection, &job.id).expect("retry");

        assert_eq!(retried.status, "queued");
        assert!(retried.error_message.is_none());
    }

    #[test]
    fn writes_attribution_sidecar() {
        let connection = test_connection();
        let output =
            std::env::temp_dir().join(format!("sonilabs_sidecar_{}.wav", std::process::id()));
        connection
            .execute(
                "UPDATE assets
                 SET license = 'CC-BY', attribution = 'Test Author', source_url = 'https://example.test'
                 WHERE id = 'asset_test'",
                [],
            )
            .expect("update asset attribution");
        let asset = export_asset(&connection, "asset_test").expect("asset");

        write_attribution_sidecar(&output, &asset).expect("sidecar");

        let sidecar = output.with_extension("wav.license.txt");
        let text = fs::read_to_string(&sidecar).expect("read sidecar");
        assert!(text.contains("CC-BY"));
        assert!(text.contains("Test Author"));
        let _ = fs::remove_file(sidecar);
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn prepares_region_drag_file_with_native_payload_readback() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let prepared = prepare_region_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempRegionExportInput {
                asset_id: "asset_test".to_string(),
                display_name: Some("region_payload_test".to_string()),
                format: "wav".to_string(),
                region_start_seconds: 0.05,
                region_end_seconds: 0.2,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: r#"{"chainOrder":["gain"],"gain":{"enabled":true,"gainDb":0,"minDb":-24,"maxDb":36},"version":1}"#.to_string(),
                processing_hash: "processing:none".to_string(),
            },
        )
        .expect("prepare region drag file");

        let response = crate::os_drag::diagnose_native_file_drag_payload(
            crate::os_drag::StartNativeFileDragRequest {
                file_path: prepared.path.clone(),
                file_paths: None,
                icon_path: None,
                display_name: None,
                allowed_effect: "copy".to_string(),
            },
        );

        assert!(response.ok, "{response:?}");
        assert!(Path::new(&prepared.path).is_file());
        let _ = fs::remove_file(prepared.path);
    }

    #[test]
    fn region_drag_crossfade_loop_shortens_rendered_wav() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let prepared = prepare_region_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempRegionExportInput {
                asset_id: "asset_test".to_string(),
                display_name: Some("region_crossfade_loop_test".to_string()),
                format: "wav".to_string(),
                region_start_seconds: 0.0,
                region_end_seconds: 0.2,
                loop_crossfade_seconds: Some(0.05),
                loop_crossfade_slope: Some(1.8),
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: test_processing_json(0.0),
                processing_hash: "processing:none".to_string(),
            },
        )
        .expect("prepare crossfaded region drag file");

        let bytes = fs::read(&prepared.path).expect("read rendered loop");
        let wav = parse_wav_info(&bytes).expect("parse rendered wav");
        let frame_count = wav.data_size / usize::from(wav.block_align);
        let duration = frame_count as f64 / wav.sample_rate as f64;
        assert!(duration > 0.145 && duration < 0.155, "duration {duration}");
        let _ = fs::remove_file(prepared.path);
    }

    #[test]
    fn crossfade_accepts_wave_format_extensible_pcm() {
        let bytes = extensible_pcm16_wav_bytes();
        let wav = parse_wav_info(&bytes).expect("parse extensible wav");
        let frame_count = wav.data_size / usize::from(wav.block_align);

        let rendered = render_crossfaded_wav_loop_16_bit(
            &bytes,
            &wav,
            0,
            frame_count,
            24,
            1.0,
            0.0,
            &CancellationToken::default(),
            &JobDeadline::new(Duration::from_secs(5)),
        )
        .expect("render extensible crossfade");

        let rendered_wav = parse_wav_info(&rendered).expect("parse rendered wav");
        assert_eq!(wav.audio_format, 1);
        assert_eq!(rendered_wav.audio_format, 1);
        assert!(read_wav_sample(&rendered, &rendered_wav, 0, 0)
            .expect("sample")
            .is_finite());
    }

    #[test]
    fn crossfade_accepts_8_bit_pcm_wav() {
        let bytes = pcm8_wav_bytes();
        let wav = parse_wav_info(&bytes).expect("parse 8-bit wav");
        let frame_count = wav.data_size / usize::from(wav.block_align);

        let rendered = render_crossfaded_wav_loop_16_bit(
            &bytes,
            &wav,
            0,
            frame_count,
            24,
            1.0,
            0.0,
            &CancellationToken::default(),
            &JobDeadline::new(Duration::from_secs(5)),
        )
        .expect("render 8-bit crossfade");

        let rendered_wav = parse_wav_info(&rendered).expect("parse rendered wav");
        assert_eq!(wav.bits_per_sample, 8);
        assert_eq!(rendered_wav.bits_per_sample, 16);
        assert!(read_wav_sample(&rendered, &rendered_wav, 0, 0)
            .expect("sample")
            .is_finite());
    }

    #[test]
    fn crossfade_accepts_ms_adpcm_wav() {
        let bytes = ms_adpcm_wav_bytes();
        let wav = parse_wav_info(&bytes).expect("parse adpcm wav");
        let pcm = decode_ms_adpcm_wav(&bytes, &wav).expect("decode adpcm wav");

        let rendered = render_crossfaded_pcm_loop_16_bit(
            &pcm,
            0,
            pcm.frame_count(),
            2,
            1.0,
            0.0,
            &CancellationToken::default(),
            &JobDeadline::new(Duration::from_secs(5)),
        )
        .expect("render adpcm crossfade");

        let rendered_wav = parse_wav_info(&rendered).expect("parse rendered wav");
        assert_eq!(wav.audio_format, 2);
        assert_eq!(rendered_wav.audio_format, 1);
        assert!(read_wav_sample(&rendered, &rendered_wav, 0, 0)
            .expect("sample")
            .is_finite());
    }

    #[test]
    fn queued_crossfade_export_uses_settings_from_frontend_payload() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        let output_dir =
            std::env::temp_dir().join(format!("sonilabs_crossfade_queue_{}", std::process::id()));
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let mut input = test_export_input("asset_test");
        input.output_folder = output_dir.to_string_lossy().to_string();
        input.filename_pattern = "queued_crossfade".to_string();
        input.export_scope = "region".to_string();
        input.region_start_seconds = Some(0.0);
        input.region_end_seconds = Some(0.2);
        input.format_settings_json =
            r#"{"wavBitDepth":16,"loopCrossfadeSeconds":0.05,"loopCrossfadeSlope":1.8}"#
                .to_string();
        let queued = queue_export_job(&connection, input).expect("queue crossfade export");

        let completed =
            ExportRuntime::new().run_jobs(&connection, None, Some(vec![queued.id.clone()]));

        let job = completed
            .iter()
            .find(|job| job.id == queued.id)
            .expect("completed job");
        assert_eq!(job.status, "complete", "{:?}", job.error_message);
        let output_path = job.output_path.as_deref().expect("output path");
        let bytes = fs::read(output_path).expect("read queued export");
        let wav = parse_wav_info(&bytes).expect("parse queued export");
        let frame_count = wav.data_size / usize::from(wav.block_align);
        let duration = frame_count as f64 / wav.sample_rate as f64;
        assert!(duration > 0.145 && duration < 0.155, "duration {duration}");
        let _ = fs::remove_dir_all(output_dir);
    }

    #[test]
    fn crossfade_region_export_stress_matrix_handles_tiny_and_oversized_cases() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        let temp_root =
            std::env::temp_dir().join(format!("sonilabs_crossfade_matrix_{}", std::process::id()));
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let cases = [
            ("tiny_1ms", 0.0, 0.001, 0.0004, 0.25),
            ("small_10ms_oversized", 0.0, 0.010, 0.200, 1.0),
            ("normal_200ms", 0.0, 0.200, 0.050, 1.8),
            ("offset_125ms", 0.050, 0.175, 0.030, 4.0),
        ];

        for (name, start, end, crossfade, slope) in cases {
            let prepared = prepare_region_drag_file(
                &connection,
                &temp_root,
                None,
                TempRegionExportInput {
                    asset_id: "asset_test".to_string(),
                    display_name: Some(format!("region_crossfade_{name}.wav")),
                    format: "wav".to_string(),
                    region_start_seconds: start,
                    region_end_seconds: end,
                    loop_crossfade_seconds: Some(crossfade),
                    loop_crossfade_slope: Some(slope),
                    region_fade_gap_seconds: None,
                    region_fade_in_seconds: None,
                    region_fade_in_slope: None,
                    region_fade_out_seconds: None,
                    region_fade_out_slope: None,
                    format_settings_json: r#"{"wavBitDepth":16}"#.to_string(),
                    processing_json: test_processing_json(0.0),
                    processing_hash: "processing:none".to_string(),
                },
            )
            .unwrap_or_else(|error| panic!("{name} failed: {error}"));

            let bytes = fs::read(&prepared.path).expect("read rendered wav");
            let wav = parse_wav_info(&bytes).expect("parse rendered wav");
            let frame_count = wav.data_size / usize::from(wav.block_align);
            let duration = frame_count as f64 / wav.sample_rate as f64;
            assert!(frame_count > 0, "{name} produced no frames");
            assert!(
                duration > 0.0 && duration <= end - start,
                "{name} duration {duration}"
            );
            assert!(
                read_wav_sample(&bytes, &wav, 0, 0)
                    .expect("sample")
                    .is_finite(),
                "{name} first sample was not finite"
            );
            let _ = fs::remove_file(prepared.path);
        }
        let _ = fs::remove_dir_all(temp_root);
    }

    #[test]
    fn region_drag_fades_render_into_temp_wav() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let prepared = prepare_region_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempRegionExportInput {
                asset_id: "asset_test".to_string(),
                display_name: Some("region_fade_test".to_string()),
                format: "wav".to_string(),
                region_start_seconds: 0.0,
                region_end_seconds: 0.2,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: Some(0.08),
                region_fade_in_slope: Some(1.0),
                region_fade_out_seconds: Some(0.08),
                region_fade_out_slope: Some(1.0),
                format_settings_json: "{}".to_string(),
                processing_json: test_processing_json(0.0),
                processing_hash: "processing:none".to_string(),
            },
        )
        .expect("prepare faded region drag file");
        let plain = prepare_region_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempRegionExportInput {
                asset_id: "asset_test".to_string(),
                display_name: Some("region_plain_test".to_string()),
                format: "wav".to_string(),
                region_start_seconds: 0.0,
                region_end_seconds: 0.2,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: test_processing_json(0.0),
                processing_hash: "processing:none".to_string(),
            },
        )
        .expect("prepare plain region drag file");

        let bytes = fs::read(&prepared.path).expect("read rendered wav");
        let plain_bytes = fs::read(&plain.path).expect("read plain wav");
        let wav = parse_wav_info(&bytes).expect("parse rendered wav");
        let plain_wav = parse_wav_info(&plain_bytes).expect("parse plain wav");
        let frame_count = wav.data_size / usize::from(wav.block_align);
        let window = 1024;
        let rms_window = |sample_bytes: &[u8], sample_wav: &WavInfo, start: usize| -> f64 {
            let end = (start + window).min(frame_count);
            let mut sum = 0.0;
            let mut count = 0.0;
            for frame in start..end {
                let sample =
                    read_wav_sample(sample_bytes, sample_wav, frame, 0).expect("sample") as f64;
                sum += sample * sample;
                count += 1.0;
            }
            (sum / count).sqrt()
        };
        assert!(rms_window(&bytes, &wav, 0) < rms_window(&plain_bytes, &plain_wav, 0) * 0.5);
        assert!(
            rms_window(&bytes, &wav, frame_count - window)
                < rms_window(&plain_bytes, &plain_wav, frame_count - window) * 0.5
        );
        assert_eq!(
            read_wav_sample(&bytes, &wav, 0, 0).expect("first sample"),
            0.0
        );
        assert_eq!(
            read_wav_sample(&bytes, &wav, frame_count - 1, 0).expect("last sample"),
            0.0
        );
        let _ = fs::remove_file(prepared.path);
        let _ = fs::remove_file(plain.path);
    }

    #[test]
    fn mock_region_drag_file_uses_display_name() {
        let connection = test_connection();
        let prepared = prepare_region_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempRegionExportInput {
                asset_id: "missing_asset_uses_mock".to_string(),
                display_name: Some("Original Kick 01.wav".to_string()),
                format: "wav".to_string(),
                region_start_seconds: 0.05,
                region_end_seconds: 0.2,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: r#"{"chainOrder":["gain"],"gain":{"enabled":true,"gainDb":0,"minDb":-24,"maxDb":36},"version":1}"#.to_string(),
                processing_hash: "processing:none".to_string(),
            },
        )
        .expect("prepare mock region drag file");

        let file_name = Path::new(&prepared.path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        assert_eq!(file_name, "Original_Kick_01.wav");
        let _ = fs::remove_file(prepared.path);
    }

    #[test]
    fn full_asset_drag_passthrough_uses_original_when_format_and_processing_match() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let prepared = prepare_asset_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempAssetDragExportInput {
                asset_id: "asset_test".to_string(),
                display_name: None,
                format: "wav".to_string(),
                export_scope: "full".to_string(),
                region_start_seconds: None,
                region_end_seconds: None,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: test_processing_json(0.0),
                processing_hash: "processing:none".to_string(),
            },
        )
        .expect("prepare passthrough drag file");

        assert_eq!(prepared.path, fixture_path.to_string_lossy());
    }

    #[test]
    fn full_asset_drag_with_gain_renders_temp_file() {
        let connection = test_connection();
        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav");
        connection
            .execute(
                "UPDATE assets SET path_or_url = ?1, name = 'short-tone.wav', format = 'wav'
                 WHERE id = 'asset_test'",
                params![fixture_path.to_string_lossy()],
            )
            .expect("point asset at fixture");

        let prepared = prepare_asset_drag_file(
            &connection,
            &std::env::temp_dir(),
            None,
            TempAssetDragExportInput {
                asset_id: "asset_test".to_string(),
                display_name: None,
                format: "wav".to_string(),
                export_scope: "full".to_string(),
                region_start_seconds: None,
                region_end_seconds: None,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: test_processing_json(3.0),
                processing_hash: "processing:gain:3.00".to_string(),
            },
        )
        .expect("prepare rendered drag file");

        assert_ne!(prepared.path, fixture_path.to_string_lossy());
        assert!(Path::new(&prepared.path).is_file());
        let _ = fs::remove_file(prepared.path);
    }

    #[test]
    fn mock_non_wav_drag_file_uses_clean_selected_extension() {
        let connection = test_connection();
        let prepared = prepare_asset_drag_file(
            &connection,
            &std::env::temp_dir(),
            Some(Path::new("ffmpeg")),
            TempAssetDragExportInput {
                asset_id: "missing_asset_uses_mock".to_string(),
                display_name: Some("Original Kick 01.wav".to_string()),
                format: "ogg".to_string(),
                export_scope: "full".to_string(),
                region_start_seconds: None,
                region_end_seconds: None,
                loop_crossfade_seconds: None,
                loop_crossfade_slope: None,
                region_fade_gap_seconds: None,
                region_fade_in_seconds: None,
                region_fade_in_slope: None,
                region_fade_out_seconds: None,
                region_fade_out_slope: None,
                format_settings_json: "{}".to_string(),
                processing_json: r#"{"chainOrder":["gain"],"gain":{"enabled":true,"gainDb":0,"minDb":-24,"maxDb":36},"version":1}"#.to_string(),
                processing_hash: "processing:none".to_string(),
            },
        );

        match prepared {
            Ok(file) => {
                let file_name = Path::new(&file.path)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                assert_eq!(file_name, "Original_Kick_01.ogg");
                let _ = fs::remove_file(file.path);
            }
            Err(error) => assert!(error.contains("FFmpeg")),
        }
    }
}
