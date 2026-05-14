use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::reliability::{BoundedJobGate, CancellationRegistry, CancellationToken, JobDeadline};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone)]
pub struct AudioRuntime {
    waveform_queue: BoundedJobGate,
    analysis_queue: BoundedJobGate,
    cancellations: CancellationRegistry,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRuntimeStatus {
    waveform_active: usize,
    waveform_max_active: usize,
    waveform_queue_depth: usize,
    analysis_active: usize,
    analysis_max_active: usize,
}

impl AudioRuntime {
    pub fn new() -> Self {
        Self {
            waveform_queue: BoundedJobGate::new("waveform", 1),
            analysis_queue: BoundedJobGate::new("level analysis", 2),
            cancellations: CancellationRegistry::new(),
        }
    }

    pub fn cancel_job(&self, job_id: &str) -> bool {
        self.cancellations.cancel(job_id)
    }

    pub fn status(&self) -> AudioRuntimeStatus {
        AudioRuntimeStatus {
            waveform_active: self.waveform_queue.active_count(),
            waveform_max_active: self.waveform_queue.max_active(),
            waveform_queue_depth: 0,
            analysis_active: self.analysis_queue.active_count(),
            analysis_max_active: self.analysis_queue.max_active(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFileResolution {
    asset_id: String,
    content_key: String,
    path: String,
    url: Option<String>,
    media_type: String,
    duration_seconds: Option<f64>,
    channel_count: Option<i64>,
    processed_available: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeakChannel {
    minimums: Vec<f32>,
    maximums: Vec<f32>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentMarker {
    id: String,
    asset_id: String,
    name: String,
    start_seconds: f64,
    end_seconds: f64,
    created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClippingMarker {
    seconds: f64,
    channel: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformPeakData {
    asset_id: String,
    content_key: String,
    peak_version: i64,
    channel_mode: String,
    samples_per_peak: i64,
    duration_seconds: f64,
    sample_rate: i64,
    channel_count: i64,
    peak_file_path: String,
    peak_start_seconds: Option<f64>,
    peak_end_seconds: Option<f64>,
    channels: Vec<WaveformPeakChannel>,
    segment_markers: Vec<SegmentMarker>,
    clipping_markers: Vec<ClippingMarker>,
    cached: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LevelAnalysis {
    status: String,
    peak_dbfs: Option<f64>,
    rms_dbfs: Option<f64>,
    clipping_samples: i64,
    headroom_db: Option<f64>,
    sample_count: i64,
    processing_hash: String,
    analyzed_at: Option<String>,
    error_message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelAnalysisPair {
    original: LevelAnalysis,
    processed: LevelAnalysis,
}

struct AssetAudioRecord {
    id: String,
    stable_key: String,
    path_or_url: String,
    preview_url: Option<String>,
    duration_seconds: Option<f64>,
    channels: Option<i64>,
    availability: String,
    format: Option<String>,
}

struct WaveformFileDescriptor {
    peak_version: i64,
    channel_count: i64,
    duration_seconds: f64,
    sample_rate: i64,
    peak_count: i64,
    path: String,
    clipping_json: Option<String>,
}

struct WavInfo {
    audio_format: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
    block_align: u16,
    data_offset: usize,
    data_size: usize,
}

const SPARSE_WAVEFORM_FILE_BYTES: u64 = 8 * 1024 * 1024;
const SPARSE_WINDOWS_PER_PEAK: usize = 4;
const SPARSE_FRAMES_PER_WINDOW: usize = 512;
const BINARY_WAVEFORM_MAGIC: &[u8; 8] = b"SLWAVE1\0";
const WAVEFORM_DEADLINE_SECONDS: u64 = 20 * 60;

struct AudioJobRegistration<'a> {
    registry: &'a CancellationRegistry,
    job_id: String,
}

impl Drop for AudioJobRegistration<'_> {
    fn drop(&mut self) {
        self.registry.remove(&self.job_id);
    }
}

pub fn resolve_preview_file(
    connection: &Connection,
    asset_id: &str,
    _requested_mode: &str,
) -> Result<PreviewFileResolution, String> {
    let asset = audio_asset(connection, asset_id)?;
    if asset.availability == "missing" {
        return Err("asset is marked missing".to_string());
    }
    if Path::new(&asset.path_or_url).is_file() {
        return Ok(PreviewFileResolution {
            asset_id: asset.id,
            content_key: asset.stable_key,
            path: asset.path_or_url,
            url: None,
            media_type: "local-file".to_string(),
            duration_seconds: asset.duration_seconds,
            channel_count: asset.channels,
            processed_available: false,
        });
    }
    if let Some(cached) = cached_cloud_preview_path(connection, &asset.id)? {
        return Ok(PreviewFileResolution {
            asset_id: asset.id,
            content_key: asset.stable_key,
            path: cached,
            url: None,
            media_type: "local-file".to_string(),
            duration_seconds: asset.duration_seconds,
            channel_count: asset.channels,
            processed_available: false,
        });
    }
    let Some(preview_url) = asset.preview_url else {
        return Err("preview source file does not exist".to_string());
    };
    Ok(PreviewFileResolution {
        asset_id: asset.id,
        content_key: asset.stable_key,
        path: String::new(),
        url: Some(preview_url),
        media_type: "cloud-preview".to_string(),
        duration_seconds: asset.duration_seconds,
        channel_count: asset.channels,
        processed_available: false,
    })
}

pub fn read_preview_file_bytes(connection: &Connection, asset_id: &str) -> Result<Vec<u8>, String> {
    let asset = audio_asset(connection, asset_id)?;
    if Path::new(&asset.path_or_url).is_file() {
        return fs::read(asset.path_or_url).map_err(|error| error.to_string());
    }
    let cached = cached_cloud_preview_path(connection, asset_id)?
        .ok_or_else(|| "preview source file not found".to_string())?;
    fs::read(cached).map_err(|error| error.to_string())
}

pub fn get_waveform_peaks(
    runtime: &AudioRuntime,
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<WaveformPeakData, String> {
    if !matches!(channel_mode, "mono" | "stereo" | "source") {
        return Err("channel_mode must be mono, stereo, or source".to_string());
    }
    if samples_per_peak < 1 {
        return Err("samples_per_peak must be positive".to_string());
    }
    let _permit = runtime.waveform_queue.try_enter()?;
    let token = CancellationToken::default();
    let job_id = format!("waveform:{asset_id}");
    runtime
        .cancellations
        .register(job_id.clone(), token.clone())?;
    let _registration = AudioJobRegistration {
        registry: &runtime.cancellations,
        job_id,
    };
    let deadline = JobDeadline::new(std::time::Duration::from_secs(WAVEFORM_DEADLINE_SECONDS));

    if let Some(mut cached) = cached_waveform(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )? {
        cached.cached = true;
        return Ok(cached);
    }

    let asset = audio_asset(connection, asset_id)?;
    let format = asset.format.unwrap_or_default().to_ascii_lowercase();
    if format != "wav" && format != "wave" {
        return Err("backend waveform generation currently supports WAV assets".to_string());
    }

    if !Path::new(&asset.path_or_url).is_file() {
        mark_asset_unavailable(connection, asset_id, "missing")?;
        return Err("waveform source file is unavailable".to_string());
    }
    deadline.check(&token, "waveform job")?;
    let file_size = fs::metadata(&asset.path_or_url)
        .map_err(|error| error.to_string())?
        .len();
    let peaks = if file_size > SPARSE_WAVEFORM_FILE_BYTES {
        generate_wav_peaks_sparse(
            Path::new(&asset.path_or_url),
            asset_id,
            content_key,
            channel_mode,
            samples_per_peak,
            &token,
            &deadline,
        )?
    } else {
        let bytes = fs::read(&asset.path_or_url).map_err(|error| error.to_string())?;
        generate_wav_peaks(
            &bytes,
            asset_id,
            content_key,
            channel_mode,
            samples_per_peak,
            &token,
            &deadline,
        )?
    };
    cache_waveform(connection, &peaks)?;
    Ok(peaks)
}

pub fn get_waveform_peaks_with_sidecar(
    runtime: &AudioRuntime,
    connection: &Connection,
    cache_root: &Path,
    resource_dir: Option<&Path>,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<WaveformPeakData, String> {
    if let Some(mut cached) = cached_waveform_file(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )? {
        cached.cached = true;
        return Ok(cached);
    }

    let asset = audio_asset(connection, asset_id)?;
    let format = asset.format.as_deref().unwrap_or("").to_ascii_lowercase();
    let is_local_file = Path::new(&asset.path_or_url).is_file();
    let is_large_wav = (format == "wav" || format == "wave")
        && is_local_file
        && fs::metadata(&asset.path_or_url)
            .map(|metadata| metadata.len() > SPARSE_WAVEFORM_FILE_BYTES)
            .unwrap_or(false);

    if is_large_wav {
        let sparse_result = {
            let _permit = runtime.waveform_queue.try_enter()?;
            let token = CancellationToken::default();
            let job_id = format!("waveform:{asset_id}");
            runtime
                .cancellations
                .register(job_id.clone(), token.clone())?;
            let _registration = AudioJobRegistration {
                registry: &runtime.cancellations,
                job_id,
            };
            let deadline =
                JobDeadline::new(std::time::Duration::from_secs(WAVEFORM_DEADLINE_SECONDS));
            let mut peaks = generate_wav_peaks_sparse(
                Path::new(&asset.path_or_url),
                asset_id,
                content_key,
                channel_mode,
                samples_per_peak,
                &token,
                &deadline,
            )?;
            let waveform_dir = cache_root.join("waveforms");
            cache_waveform_file(connection, &waveform_dir, &mut peaks)?;
            Ok::<WaveformPeakData, String>(peaks)
        };
        match sparse_result {
            Ok(peaks) => return Ok(peaks),
            Err(error) if error.contains("cancelled") => return Err(error),
            Err(_) => {
                return get_waveform_peaks(
                    runtime,
                    connection,
                    asset_id,
                    content_key,
                    channel_mode,
                    samples_per_peak,
                );
            }
        }
    }

    if let Some(mut cached) = cached_waveform(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )? {
        cached.cached = true;
        return Ok(cached);
    }

    if format == "wav" || format == "wave" {
        return get_waveform_peaks(
            runtime,
            connection,
            asset_id,
            content_key,
            channel_mode,
            samples_per_peak,
        );
    }

    if is_local_file {
        let sidecar_result = {
            let _permit = runtime.waveform_queue.try_enter()?;
            let token = CancellationToken::default();
            let job_id = format!("waveform:{asset_id}");
            runtime
                .cancellations
                .register(job_id.clone(), token.clone())?;
            let _registration = AudioJobRegistration {
                registry: &runtime.cancellations,
                job_id,
            };
            let deadline =
                JobDeadline::new(std::time::Duration::from_secs(WAVEFORM_DEADLINE_SECONDS));
            generate_audiowaveform_peaks(
                connection,
                cache_root,
                resource_dir,
                &asset,
                content_key,
                channel_mode,
                samples_per_peak,
                &token,
                &deadline,
            )
        };
        match sidecar_result {
            Ok(peaks) => return Ok(peaks),
            Err(error) if error.contains("cancelled") => return Err(error),
            Err(_) => {}
        }
    }

    get_waveform_peaks(
        runtime,
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )
}

pub fn get_cached_waveform_peaks(
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<Option<WaveformPeakData>, String> {
    if !matches!(channel_mode, "mono" | "stereo" | "source") {
        return Err("channel_mode must be mono, stereo, or source".to_string());
    }
    if samples_per_peak < 1 {
        return Err("samples_per_peak must be positive".to_string());
    }
    let mut cached = cached_waveform(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )?;
    if let Some(peaks) = cached.as_mut() {
        peaks.cached = true;
    }
    Ok(cached)
}

pub fn get_cached_waveform_peaks_with_files(
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<Option<WaveformPeakData>, String> {
    if !matches!(channel_mode, "mono" | "stereo" | "source") {
        return Err("channel_mode must be mono, stereo, or source".to_string());
    }
    if samples_per_peak < 1 {
        return Err("samples_per_peak must be positive".to_string());
    }
    if let Some(mut peaks) = cached_waveform_file(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )? {
        peaks.cached = true;
        return Ok(Some(peaks));
    }
    let asset = audio_asset(connection, asset_id)?;
    let format = asset.format.as_deref().unwrap_or("").to_ascii_lowercase();
    let is_large_wav = (format == "wav" || format == "wave")
        && Path::new(&asset.path_or_url).is_file()
        && fs::metadata(&asset.path_or_url)
            .map(|metadata| metadata.len() > SPARSE_WAVEFORM_FILE_BYTES)
            .unwrap_or(false);
    if is_large_wav {
        return Ok(None);
    }
    get_cached_waveform_peaks(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
    )
}

pub fn get_cached_waveform_peak_range(
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
    start_seconds: f64,
    end_seconds: f64,
) -> Result<Option<WaveformPeakData>, String> {
    if !matches!(channel_mode, "mono" | "stereo" | "source") {
        return Err("channel_mode must be mono, stereo, or source".to_string());
    }
    if samples_per_peak < 1 || start_seconds < 0.0 || end_seconds <= start_seconds {
        return Err("invalid waveform range request".to_string());
    }
    let cache_key = waveform_cache_key(content_key, channel_mode, samples_per_peak);
    let descriptor = waveform_file_descriptor(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
        &cache_key,
    )?;
    let Some(descriptor) = descriptor else {
        return Ok(None);
    };
    if !Path::new(&descriptor.path).is_file() {
        return Ok(None);
    }
    if descriptor.sample_rate <= 0 || descriptor.peak_count <= 0 || descriptor.channel_count <= 0 {
        return Ok(None);
    }
    let start_peak = ((start_seconds * descriptor.sample_rate as f64) / samples_per_peak as f64)
        .floor()
        .max(0.0) as usize;
    let end_peak = ((end_seconds * descriptor.sample_rate as f64) / samples_per_peak as f64)
        .ceil()
        .max(start_peak as f64 + 1.0) as usize;
    let peak_count = descriptor.peak_count as usize;
    let start_peak = start_peak.min(peak_count.saturating_sub(1));
    let end_peak = end_peak.min(peak_count);
    let count = end_peak.saturating_sub(start_peak).max(1);
    let channels = read_binary_waveform_file_range(
        &descriptor.path,
        descriptor.channel_count as usize,
        peak_count,
        start_peak,
        count,
    )?;
    let clipping_markers = descriptor
        .clipping_json
        .as_deref()
        .map(|json| serde_json::from_str::<Vec<ClippingMarker>>(json))
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default()
        .into_iter()
        .filter(|marker| marker.seconds >= start_seconds && marker.seconds <= end_seconds)
        .collect();
    connection
        .execute(
            "UPDATE waveform_peak_files SET last_accessed_at = CURRENT_TIMESTAMP WHERE cache_key = ?1",
            params![cache_key],
        )
        .map_err(|error| error.to_string())?;

    Ok(Some(WaveformPeakData {
        asset_id: asset_id.to_string(),
        content_key: content_key.to_string(),
        peak_version: descriptor.peak_version,
        channel_mode: channel_mode.to_string(),
        samples_per_peak,
        duration_seconds: descriptor.duration_seconds,
        sample_rate: descriptor.sample_rate,
        channel_count: descriptor.channel_count,
        peak_file_path: descriptor.path,
        peak_start_seconds: Some(
            start_peak as f64 * samples_per_peak as f64 / descriptor.sample_rate as f64,
        ),
        peak_end_seconds: Some(
            end_peak as f64 * samples_per_peak as f64 / descriptor.sample_rate as f64,
        ),
        channels,
        segment_markers: Vec::new(),
        clipping_markers,
        cached: true,
    }))
}

pub fn analyze_audio_levels(
    runtime: &AudioRuntime,
    connection: &Connection,
    asset_id: &str,
    gain_db: f64,
) -> Result<LevelAnalysisPair, String> {
    let _permit = runtime.analysis_queue.try_enter()?;
    let token = CancellationToken::default();
    let job_id = format!("analysis:{asset_id}");
    runtime
        .cancellations
        .register(job_id.clone(), token.clone())?;
    let _registration = AudioJobRegistration {
        registry: &runtime.cancellations,
        job_id,
    };
    let deadline = JobDeadline::new(std::time::Duration::from_secs(180));
    let asset = audio_asset(connection, asset_id)?;
    if !Path::new(&asset.path_or_url).is_file() {
        mark_asset_unavailable(connection, asset_id, "missing")?;
        return Err("analysis source file is unavailable".to_string());
    }
    let original_hash = processing_hash_for_gain(0.0);
    let original = cached_level_analysis(connection, asset_id, &original_hash)?.map_or_else(
        || {
            deadline.check(&token, "level analysis job")?;
            let bytes = fs::read(&asset.path_or_url).map_err(|error| error.to_string())?;
            let analysis = analyze_wav_levels(&bytes, &original_hash, 0.0, &token, &deadline)?;
            cache_level_analysis(connection, asset_id, &analysis)?;
            Ok::<LevelAnalysis, String>(analysis)
        },
        Ok,
    )?;
    let processed_hash = processing_hash_for_gain(gain_db);
    let processed = cached_level_analysis(connection, asset_id, &processed_hash)?.map_or_else(
        || {
            deadline.check(&token, "level analysis job")?;
            let bytes = fs::read(&asset.path_or_url).map_err(|error| error.to_string())?;
            let analysis = analyze_wav_levels(&bytes, &processed_hash, gain_db, &token, &deadline)?;
            cache_level_analysis(connection, asset_id, &analysis)?;
            Ok::<LevelAnalysis, String>(analysis)
        },
        Ok,
    )?;

    Ok(LevelAnalysisPair {
        original,
        processed,
    })
}

fn audio_asset(connection: &Connection, asset_id: &str) -> Result<AssetAudioRecord, String> {
    connection
        .query_row(
            "SELECT id, stable_key, path_or_url, preview_url, duration_seconds, channels,
                    availability, format
             FROM assets
             WHERE id = ?1",
            params![asset_id],
            |row| {
                Ok(AssetAudioRecord {
                    id: row.get(0)?,
                    stable_key: row.get(1)?,
                    path_or_url: row.get(2)?,
                    preview_url: row.get(3)?,
                    duration_seconds: row.get(4)?,
                    channels: row.get(5)?,
                    availability: row.get(6)?,
                    format: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "asset not found".to_string())
}

fn mark_asset_unavailable(
    connection: &Connection,
    asset_id: &str,
    availability: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE assets SET availability = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
            params![asset_id, availability],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn cached_cloud_preview_path(
    connection: &Connection,
    asset_id: &str,
) -> Result<Option<String>, String> {
    let path = connection
        .query_row(
            "SELECT path
             FROM cache_entries
             WHERE kind = 'cloud_preview' AND asset_id = ?1
             ORDER BY last_accessed_at DESC
             LIMIT 1",
            params![asset_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(path.filter(|path| Path::new(path).is_file()))
}

fn cached_waveform_file(
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<Option<WaveformPeakData>, String> {
    let cache_key = waveform_cache_key(content_key, channel_mode, samples_per_peak);
    let Some(descriptor) = waveform_file_descriptor(
        connection,
        asset_id,
        content_key,
        channel_mode,
        samples_per_peak,
        &cache_key,
    )?
    else {
        return Ok(None);
    };
    if !Path::new(&descriptor.path).is_file() {
        return Ok(None);
    }

    let channels = read_binary_waveform_file(
        &descriptor.path,
        descriptor.channel_count as usize,
        descriptor.peak_count as usize,
    )?;
    let clipping_markers = descriptor
        .clipping_json
        .as_deref()
        .map(|json| serde_json::from_str::<Vec<ClippingMarker>>(json))
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    connection
        .execute(
            "UPDATE waveform_peak_files SET last_accessed_at = CURRENT_TIMESTAMP WHERE cache_key = ?1",
            params![cache_key],
        )
        .map_err(|error| error.to_string())?;

    Ok(Some(WaveformPeakData {
        asset_id: asset_id.to_string(),
        content_key: content_key.to_string(),
        peak_version: descriptor.peak_version,
        channel_mode: channel_mode.to_string(),
        samples_per_peak,
        duration_seconds: descriptor.duration_seconds,
        sample_rate: descriptor.sample_rate,
        channel_count: descriptor.channel_count,
        peak_file_path: descriptor.path,
        peak_start_seconds: None,
        peak_end_seconds: None,
        channels,
        segment_markers: Vec::new(),
        clipping_markers,
        cached: true,
    }))
}

fn waveform_file_descriptor(
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
    cache_key: &str,
) -> Result<Option<WaveformFileDescriptor>, String> {
    connection
        .query_row(
            "SELECT peak_version, channel_count, duration_seconds, sample_rate, peak_count,
                    path, clipping_json
             FROM waveform_peak_files
             WHERE asset_id = ?1
               AND content_key = ?2
               AND channel_mode = ?3
               AND resolution = ?4
               AND cache_key = ?5
               AND status = 'complete'
             LIMIT 1",
            params![
                asset_id,
                content_key,
                channel_mode,
                samples_per_peak,
                cache_key
            ],
            |row| {
                Ok(WaveformFileDescriptor {
                    peak_version: row.get(0)?,
                    channel_count: row.get(1)?,
                    duration_seconds: row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    sample_rate: row.get(3)?,
                    peak_count: row.get(4)?,
                    path: row.get(5)?,
                    clipping_json: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn cached_waveform(
    connection: &Connection,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<Option<WaveformPeakData>, String> {
    let cache_key = waveform_cache_key(content_key, channel_mode, samples_per_peak);
    let peaks_json: Option<String> = connection
        .query_row(
            "SELECT peaks_json
             FROM waveform_peaks
             WHERE asset_id = ?1 AND content_key = ?2 AND resolution = ?3 AND cache_key = ?4",
            params![asset_id, content_key, samples_per_peak, cache_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    peaks_json
        .map(|json| {
            serde_json::from_str::<WaveformPeakData>(&json).map_err(|error| error.to_string())
        })
        .transpose()
}

fn cache_waveform(connection: &Connection, peaks: &WaveformPeakData) -> Result<(), String> {
    let id = make_id("waveform");
    let cache_key = waveform_cache_key(
        &peaks.content_key,
        &peaks.channel_mode,
        peaks.samples_per_peak,
    );
    let peaks_json = serde_json::to_string(peaks).map_err(|error| error.to_string())?;
    let peak_count = peaks
        .channels
        .first()
        .map(|channel| channel.maximums.len() as i64)
        .unwrap_or_default();

    connection
        .execute(
            "INSERT INTO waveform_peaks (
                id, asset_id, content_key, resolution, channel_count, duration_seconds,
                peak_count, cache_key, peaks_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(asset_id, content_key, resolution, channel_count) DO UPDATE SET
                duration_seconds = excluded.duration_seconds,
                peak_count = excluded.peak_count,
                cache_key = excluded.cache_key,
                peaks_json = excluded.peaks_json,
                generated_at = CURRENT_TIMESTAMP",
            params![
                id,
                peaks.asset_id,
                peaks.content_key,
                peaks.samples_per_peak,
                peaks.channel_count,
                peaks.duration_seconds,
                peak_count,
                cache_key,
                peaks_json
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn cache_waveform_file(
    connection: &Connection,
    waveform_dir: &Path,
    peaks: &mut WaveformPeakData,
) -> Result<(), String> {
    fs::create_dir_all(waveform_dir).map_err(|error| error.to_string())?;
    let cache_key = waveform_cache_key(
        &peaks.content_key,
        &peaks.channel_mode,
        peaks.samples_per_peak,
    );
    let path = waveform_dir.join(format!("{}.slwf", safe_cache_file_name(&cache_key)));
    write_binary_waveform_file(&path, &peaks.channels)?;
    let byte_size = fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len() as i64;
    let peak_count = peaks
        .channels
        .first()
        .map(|channel| channel.maximums.len() as i64)
        .unwrap_or_default();
    let clipping_json =
        serde_json::to_string(&peaks.clipping_markers).map_err(|error| error.to_string())?;
    peaks.peak_file_path = path.to_string_lossy().to_string();

    connection
        .execute(
            "INSERT INTO waveform_peak_files (
                cache_key, asset_id, content_key, peak_version, channel_mode, resolution,
                peak_count, channel_count, duration_seconds, sample_rate, path, byte_size,
                status, clipping_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'complete', ?13)
             ON CONFLICT(cache_key) DO UPDATE SET
                asset_id = excluded.asset_id,
                content_key = excluded.content_key,
                peak_version = excluded.peak_version,
                channel_mode = excluded.channel_mode,
                resolution = excluded.resolution,
                peak_count = excluded.peak_count,
                channel_count = excluded.channel_count,
                duration_seconds = excluded.duration_seconds,
                sample_rate = excluded.sample_rate,
                path = excluded.path,
                byte_size = excluded.byte_size,
                status = excluded.status,
                clipping_json = excluded.clipping_json,
                generated_at = CURRENT_TIMESTAMP,
                last_accessed_at = CURRENT_TIMESTAMP",
            params![
                cache_key,
                peaks.asset_id,
                peaks.content_key,
                peaks.peak_version,
                peaks.channel_mode,
                peaks.samples_per_peak,
                peak_count,
                peaks.channel_count,
                peaks.duration_seconds,
                peaks.sample_rate,
                peaks.peak_file_path,
                byte_size,
                clipping_json,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn generate_audiowaveform_peaks(
    connection: &Connection,
    cache_root: &Path,
    resource_dir: Option<&Path>,
    asset: &AssetAudioRecord,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<WaveformPeakData, String> {
    let audiowaveform = resolve_audiowaveform(resource_dir)?;
    let cache_key = waveform_cache_key(content_key, channel_mode, samples_per_peak);
    let waveform_dir = cache_root.join("waveforms");
    fs::create_dir_all(&waveform_dir).map_err(|error| error.to_string())?;
    let dat_path = waveform_dir.join(format!("{}.dat", safe_cache_file_name(&cache_key)));

    if !dat_path.is_file() {
        let mut args = vec![
            "-i".to_string(),
            asset.path_or_url.clone(),
            "-o".to_string(),
            dat_path.to_string_lossy().to_string(),
            "-z".to_string(),
            samples_per_peak.to_string(),
            "-b".to_string(),
            "16".to_string(),
            "--quiet".to_string(),
        ];
        if channel_mode == "source" || channel_mode == "stereo" {
            args.push("--split-channels".to_string());
        }
        let output = run_audiowaveform(&audiowaveform, args, token, deadline)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            return Err(format!("audiowaveform failed: {}", detail.trim()));
        }
    }

    let mut peaks = parse_audiowaveform_dat(
        &dat_path,
        &asset.id,
        content_key,
        channel_mode,
        samples_per_peak,
    )?;
    cache_waveform_file(connection, &waveform_dir, &mut peaks)?;
    Ok(peaks)
}

fn resolve_audiowaveform(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    let executable = audiowaveform_executable_name();
    let mut candidates = Vec::new();
    if let Ok(path) = std::env::var("AUDIOWAVEFORM_PATH") {
        candidates.push(PathBuf::from(path));
    }
    if let Some(resource_dir) = resource_dir {
        candidates.push(resource_dir.join("bin").join(executable));
    }
    candidates.push(PathBuf::from("src-tauri/bin").join(executable));
    candidates.push(PathBuf::from("audiowaveform"));
    candidates
        .into_iter()
        .find(|candidate| candidate == Path::new("audiowaveform") || candidate.is_file())
        .ok_or_else(|| "audiowaveform sidecar was not found".to_string())
}

fn audiowaveform_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "audiowaveform.exe"
    } else {
        "audiowaveform"
    }
}

fn run_audiowaveform(
    audiowaveform: &Path,
    args: Vec<String>,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(audiowaveform);
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start audiowaveform: {error}"))?;
    loop {
        if child
            .try_wait()
            .map_err(|error| format!("failed to wait for audiowaveform: {error}"))?
            .is_some()
        {
            return child
                .wait_with_output()
                .map_err(|error| format!("failed to read audiowaveform output: {error}"));
        }
        if let Err(error) = deadline.check(token, "waveform job") {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        sleep(Duration::from_millis(20));
    }
}

fn parse_audiowaveform_dat(
    path: &Path,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
) -> Result<WaveformPeakData, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() < 20 {
        return Err("audiowaveform data is too small".to_string());
    }
    let version = read_i32(&bytes, 0)?;
    if version != 1 && version != 2 {
        return Err("unsupported audiowaveform data version".to_string());
    }
    let flags = read_u32(&bytes, 4)?;
    let bits = if flags & 1 == 1 { 8 } else { 16 };
    let sample_rate = read_i32(&bytes, 8)? as i64;
    let dat_samples_per_peak = read_i32(&bytes, 12)? as i64;
    let peak_count = read_u32(&bytes, 16)? as usize;
    let (channel_count, data_offset) = if version == 2 {
        if bytes.len() < 24 {
            return Err("audiowaveform v2 header is incomplete".to_string());
        }
        (read_i32(&bytes, 20)?.max(1) as usize, 24)
    } else {
        (1, 20)
    };
    let value_bytes = if bits == 8 { 1 } else { 2 };
    let expected_values = peak_count
        .checked_mul(channel_count)
        .and_then(|value| value.checked_mul(2))
        .ok_or_else(|| "audiowaveform data is too large".to_string())?;
    let expected_bytes = data_offset + expected_values * value_bytes;
    if bytes.len() < expected_bytes {
        return Err("audiowaveform data is truncated".to_string());
    }

    let mut minimums = vec![Vec::with_capacity(peak_count); channel_count];
    let mut maximums = vec![Vec::with_capacity(peak_count); channel_count];
    let mut offset = data_offset;
    let scale = if bits == 8 { 128.0 } else { 32768.0 };
    for _ in 0..peak_count {
        for channel in 0..channel_count {
            let minimum = if bits == 8 {
                let value = bytes[offset] as i8;
                offset += 1;
                value as f32 / scale
            } else {
                let value = i16::from_le_bytes(slice_array(&bytes, offset)?);
                offset += 2;
                value as f32 / scale
            };
            let maximum = if bits == 8 {
                let value = bytes[offset] as i8;
                offset += 1;
                value as f32 / scale
            } else {
                let value = i16::from_le_bytes(slice_array(&bytes, offset)?);
                offset += 2;
                value as f32 / scale
            };
            minimums[channel].push(minimum.clamp(-1.0, 1.0));
            maximums[channel].push(maximum.clamp(-1.0, 1.0));
        }
    }

    let channels = minimums
        .into_iter()
        .zip(maximums)
        .map(|(minimums, maximums)| WaveformPeakChannel { minimums, maximums })
        .collect::<Vec<_>>();
    Ok(WaveformPeakData {
        asset_id: asset_id.to_string(),
        content_key: content_key.to_string(),
        peak_version: 2,
        channel_mode: channel_mode.to_string(),
        samples_per_peak: dat_samples_per_peak.max(samples_per_peak),
        duration_seconds: peak_count as f64 * dat_samples_per_peak as f64 / sample_rate as f64,
        sample_rate,
        channel_count: channels.len() as i64,
        peak_file_path: path.to_string_lossy().to_string(),
        peak_start_seconds: None,
        peak_end_seconds: None,
        channels,
        segment_markers: Vec::new(),
        clipping_markers: Vec::new(),
        cached: false,
    })
}

fn write_binary_waveform_file(path: &Path, channels: &[WaveformPeakChannel]) -> Result<(), String> {
    let mut file = fs::File::create(path).map_err(|error| error.to_string())?;
    file.write_all(BINARY_WAVEFORM_MAGIC)
        .map_err(|error| error.to_string())?;
    let channel_count = channels.len() as u32;
    let peak_count = channels
        .first()
        .map(|channel| channel.minimums.len().min(channel.maximums.len()))
        .unwrap_or_default() as u32;
    file.write_all(&channel_count.to_le_bytes())
        .map_err(|error| error.to_string())?;
    file.write_all(&peak_count.to_le_bytes())
        .map_err(|error| error.to_string())?;

    for peak_index in 0..peak_count as usize {
        for channel in channels {
            let minimum = channel
                .minimums
                .get(peak_index)
                .copied()
                .unwrap_or_default();
            let maximum = channel
                .maximums
                .get(peak_index)
                .copied()
                .unwrap_or_default();
            let minimum_i16 = (minimum.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            let maximum_i16 = (maximum.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            file.write_all(&minimum_i16.to_le_bytes())
                .map_err(|error| error.to_string())?;
            file.write_all(&maximum_i16.to_le_bytes())
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn read_binary_waveform_file(
    path: &str,
    expected_channel_count: usize,
    expected_peak_count: usize,
) -> Result<Vec<WaveformPeakChannel>, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() < 16 || &bytes[0..8] != BINARY_WAVEFORM_MAGIC {
        return Err("invalid binary waveform cache".to_string());
    }
    let channel_count = u32::from_le_bytes(slice_array(&bytes, 8)?) as usize;
    let peak_count = u32::from_le_bytes(slice_array(&bytes, 12)?) as usize;
    if channel_count != expected_channel_count || peak_count != expected_peak_count {
        return Err("binary waveform descriptor mismatch".to_string());
    }
    let expected_bytes = 16 + channel_count * peak_count * 4;
    if bytes.len() < expected_bytes {
        return Err("binary waveform cache is truncated".to_string());
    }

    let mut channels = (0..channel_count)
        .map(|_| WaveformPeakChannel {
            minimums: Vec::with_capacity(peak_count),
            maximums: Vec::with_capacity(peak_count),
        })
        .collect::<Vec<_>>();
    let mut offset = 16;
    for _ in 0..peak_count {
        for channel in channels.iter_mut().take(channel_count) {
            let minimum = i16::from_le_bytes(slice_array(&bytes, offset)?);
            offset += 2;
            let maximum = i16::from_le_bytes(slice_array(&bytes, offset)?);
            offset += 2;
            channel.minimums.push(minimum as f32 / i16::MAX as f32);
            channel.maximums.push(maximum as f32 / i16::MAX as f32);
        }
    }
    Ok(channels)
}

fn read_binary_waveform_file_range(
    path: &str,
    expected_channel_count: usize,
    expected_peak_count: usize,
    start_peak: usize,
    peak_count: usize,
) -> Result<Vec<WaveformPeakChannel>, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() < 16 || &bytes[0..8] != BINARY_WAVEFORM_MAGIC {
        return Err("invalid binary waveform cache".to_string());
    }
    let channel_count = u32::from_le_bytes(slice_array(&bytes, 8)?) as usize;
    let total_peak_count = u32::from_le_bytes(slice_array(&bytes, 12)?) as usize;
    if channel_count != expected_channel_count || total_peak_count != expected_peak_count {
        return Err("binary waveform descriptor mismatch".to_string());
    }
    let end_peak = start_peak
        .checked_add(peak_count)
        .ok_or_else(|| "binary waveform range is too large".to_string())?
        .min(total_peak_count);
    let expected_bytes = 16 + channel_count * total_peak_count * 4;
    if bytes.len() < expected_bytes || start_peak >= end_peak {
        return Err("binary waveform range is invalid".to_string());
    }

    let mut channels = (0..channel_count)
        .map(|_| WaveformPeakChannel {
            minimums: Vec::with_capacity(end_peak - start_peak),
            maximums: Vec::with_capacity(end_peak - start_peak),
        })
        .collect::<Vec<_>>();
    let mut offset = 16 + start_peak * channel_count * 4;
    for _ in start_peak..end_peak {
        for channel in channels.iter_mut().take(channel_count) {
            let minimum = i16::from_le_bytes(slice_array(&bytes, offset)?);
            offset += 2;
            let maximum = i16::from_le_bytes(slice_array(&bytes, offset)?);
            offset += 2;
            channel.minimums.push(minimum as f32 / i16::MAX as f32);
            channel.maximums.push(maximum as f32 / i16::MAX as f32);
        }
    }
    Ok(channels)
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32, String> {
    Ok(i32::from_le_bytes(slice_array(bytes, offset)?))
}

fn safe_cache_file_name(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn cached_level_analysis(
    connection: &Connection,
    asset_id: &str,
    processing_hash: &str,
) -> Result<Option<LevelAnalysis>, String> {
    connection
        .query_row(
            "SELECT peak_dbfs, rms_dbfs, headroom_db, clipping_samples, sample_count, analyzed_at
             FROM analysis
             WHERE asset_id = ?1
               AND scope = 'full'
               AND processing_hash = ?2
               AND analyzer_version = ?3
             ORDER BY analyzed_at DESC
             LIMIT 1",
            params![asset_id, processing_hash, analyzer_version()],
            |row| {
                let peak_dbfs: Option<f64> = row.get(0)?;
                let rms_dbfs: Option<f64> = row.get(1)?;
                Ok(LevelAnalysis {
                    status: "complete".to_string(),
                    peak_dbfs,
                    rms_dbfs,
                    headroom_db: row.get(2)?,
                    clipping_samples: row.get(3)?,
                    sample_count: row.get(4)?,
                    processing_hash: processing_hash.to_string(),
                    analyzed_at: row.get(5)?,
                    error_message: None,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn cache_level_analysis(
    connection: &Connection,
    asset_id: &str,
    analysis: &LevelAnalysis,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO analysis (
                id, asset_id, scope, processing_hash, peak_dbfs, rms_dbfs,
                headroom_db, clipping_samples, sample_count, channel_count, analyzer_version
             ) VALUES (?1, ?2, 'full', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(
                asset_id, scope, processing_hash, region_start_seconds,
                region_end_seconds, analyzer_version
             ) DO UPDATE SET
                peak_dbfs = excluded.peak_dbfs,
                rms_dbfs = excluded.rms_dbfs,
                headroom_db = excluded.headroom_db,
                clipping_samples = excluded.clipping_samples,
                sample_count = excluded.sample_count,
                channel_count = excluded.channel_count,
                analyzed_at = CURRENT_TIMESTAMP",
            params![
                make_id("analysis"),
                asset_id,
                &analysis.processing_hash,
                analysis.peak_dbfs,
                analysis.rms_dbfs,
                analysis.headroom_db,
                analysis.clipping_samples,
                analysis.sample_count,
                0_i64,
                analyzer_version()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn analyze_wav_levels(
    bytes: &[u8],
    processing_hash: &str,
    gain_db: f64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<LevelAnalysis, String> {
    let wav = parse_wav_info(bytes)?;
    let frame_count = wav.data_size / usize::from(wav.block_align);
    let linear_gain = 10_f64.powf(gain_db / 20.0);
    let mut peak = 0.0_f64;
    let mut sum_squares = 0.0_f64;
    let mut sample_count = 0_i64;
    let mut clipping_samples = 0_i64;

    for frame_index in 0..frame_count {
        if frame_index % 4096 == 0 {
            deadline.check(token, "level analysis job")?;
        }
        for channel in 0..wav.channels as usize {
            let sample = read_wav_sample(bytes, &wav, frame_index, channel)? as f64 * linear_gain;
            let absolute = sample.abs();
            peak = peak.max(absolute);
            sum_squares += sample * sample;
            sample_count += 1;
            if absolute >= 1.0 {
                clipping_samples += 1;
            }
        }
    }

    let peak_dbfs = dbfs(peak);
    let rms = if sample_count > 0 {
        (sum_squares / sample_count as f64).sqrt()
    } else {
        0.0
    };
    let rms_dbfs = dbfs(rms);

    Ok(LevelAnalysis {
        status: "complete".to_string(),
        peak_dbfs,
        rms_dbfs,
        clipping_samples,
        headroom_db: peak_dbfs.map(|peak| -peak),
        sample_count,
        processing_hash: processing_hash.to_string(),
        analyzed_at: Some(now_stamp()),
        error_message: None,
    })
}

fn generate_wav_peaks(
    bytes: &[u8],
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<WaveformPeakData, String> {
    let wav = parse_wav_info(bytes)?;
    let frame_count = wav.data_size / usize::from(wav.block_align);
    let output_channels = match channel_mode {
        "mono" => 1,
        "stereo" => 2,
        "source" => usize::from(wav.channels),
        _ => return Err("channel_mode must be mono, stereo, or source".to_string()),
    };
    let peak_count = (frame_count as f64 / samples_per_peak as f64)
        .ceil()
        .max(1.0) as usize;
    let mut minimums = vec![vec![1.0_f32; peak_count]; output_channels];
    let mut maximums = vec![vec![-1.0_f32; peak_count]; output_channels];
    let mut clipping_markers = Vec::new();

    for frame_index in 0..frame_count {
        if frame_index % 4096 == 0 {
            deadline.check(token, "waveform job")?;
        }
        let peak_index = frame_index / samples_per_peak as usize;
        let mut frame_values = Vec::with_capacity(wav.channels as usize);
        for channel in 0..wav.channels as usize {
            let sample = read_wav_sample(bytes, &wav, frame_index, channel)?;
            frame_values.push(sample);
        }

        for output_channel in 0..output_channels {
            let value = if channel_mode == "mono" {
                frame_values.iter().sum::<f32>() / frame_values.len() as f32
            } else if channel_mode == "stereo" && wav.channels == 1 {
                frame_values[0]
            } else {
                frame_values[output_channel.min(frame_values.len() - 1)]
            };
            minimums[output_channel][peak_index] = minimums[output_channel][peak_index].min(value);
            maximums[output_channel][peak_index] = maximums[output_channel][peak_index].max(value);
            if value.abs() >= 1.0 && clipping_markers.len() < 512 {
                clipping_markers.push(ClippingMarker {
                    seconds: frame_index as f64 / wav.sample_rate as f64,
                    channel: output_channel,
                });
            }
        }
    }

    let channels = minimums
        .into_iter()
        .zip(maximums)
        .map(|(minimums, maximums)| WaveformPeakChannel {
            minimums: minimums
                .into_iter()
                .map(|value| if value == 1.0 { 0.0 } else { value })
                .collect(),
            maximums: maximums
                .into_iter()
                .map(|value| if value == -1.0 { 0.0 } else { value })
                .collect(),
        })
        .collect::<Vec<_>>();

    Ok(WaveformPeakData {
        asset_id: asset_id.to_string(),
        content_key: content_key.to_string(),
        peak_version: 1,
        channel_mode: channel_mode.to_string(),
        samples_per_peak,
        duration_seconds: frame_count as f64 / wav.sample_rate as f64,
        sample_rate: wav.sample_rate as i64,
        channel_count: channels.len() as i64,
        peak_file_path: String::new(),
        peak_start_seconds: None,
        peak_end_seconds: None,
        channels,
        segment_markers: Vec::new(),
        clipping_markers,
        cached: false,
    })
}

fn generate_wav_peaks_sparse(
    path: &Path,
    asset_id: &str,
    content_key: &str,
    channel_mode: &str,
    samples_per_peak: i64,
    token: &CancellationToken,
    deadline: &JobDeadline,
) -> Result<WaveformPeakData, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let wav = parse_wav_info_file(&mut file)?;
    let frame_count = wav.data_size / usize::from(wav.block_align);
    let output_channels = match channel_mode {
        "mono" => 1,
        "stereo" => 2,
        "source" => usize::from(wav.channels),
        _ => return Err("channel_mode must be mono, stereo, or source".to_string()),
    };
    let samples_per_peak = samples_per_peak.max(1) as usize;
    let peak_count = (frame_count as f64 / samples_per_peak as f64)
        .ceil()
        .max(1.0) as usize;
    let mut minimums = vec![vec![1.0_f32; peak_count]; output_channels];
    let mut maximums = vec![vec![-1.0_f32; peak_count]; output_channels];
    let mut clipping_markers = Vec::new();
    let block_align = usize::from(wav.block_align);

    for peak_index in 0..peak_count {
        if peak_index % 128 == 0 {
            deadline.check(token, "waveform job")?;
        }
        let bucket_start = peak_index * samples_per_peak;
        let bucket_end = ((peak_index + 1) * samples_per_peak).min(frame_count);
        let bucket_frames = bucket_end.saturating_sub(bucket_start);
        if bucket_frames == 0 {
            continue;
        }
        let window_count = SPARSE_WINDOWS_PER_PEAK.min(bucket_frames);
        for window_index in 0..window_count {
            let window_start = bucket_start + (window_index * bucket_frames / window_count);
            let window_frames = SPARSE_FRAMES_PER_WINDOW
                .min(bucket_end.saturating_sub(window_start))
                .max(1);
            let byte_offset = wav.data_offset as u64 + (window_start * block_align) as u64;
            let byte_count = window_frames * block_align;
            let mut buffer = vec![0_u8; byte_count];
            file.seek(SeekFrom::Start(byte_offset))
                .map_err(|error| error.to_string())?;
            file.read_exact(&mut buffer)
                .map_err(|error| error.to_string())?;

            for local_frame in 0..window_frames {
                let frame_index = window_start + local_frame;
                let mut frame_values = Vec::with_capacity(wav.channels as usize);
                for channel in 0..wav.channels as usize {
                    let sample = read_wav_sample_from_frame(&buffer, &wav, local_frame, channel)?;
                    frame_values.push(sample);
                }
                for output_channel in 0..output_channels {
                    let value = if channel_mode == "mono" {
                        frame_values.iter().sum::<f32>() / frame_values.len() as f32
                    } else if channel_mode == "stereo" && wav.channels == 1 {
                        frame_values[0]
                    } else {
                        frame_values[output_channel.min(frame_values.len() - 1)]
                    };
                    minimums[output_channel][peak_index] =
                        minimums[output_channel][peak_index].min(value);
                    maximums[output_channel][peak_index] =
                        maximums[output_channel][peak_index].max(value);
                    if value.abs() >= 1.0 && clipping_markers.len() < 512 {
                        clipping_markers.push(ClippingMarker {
                            seconds: frame_index as f64 / wav.sample_rate as f64,
                            channel: output_channel,
                        });
                    }
                }
            }
        }
    }

    let channels = minimums
        .into_iter()
        .zip(maximums)
        .map(|(minimums, maximums)| WaveformPeakChannel {
            minimums: minimums
                .into_iter()
                .map(|value| if value == 1.0 { 0.0 } else { value })
                .collect(),
            maximums: maximums
                .into_iter()
                .map(|value| if value == -1.0 { 0.0 } else { value })
                .collect(),
        })
        .collect::<Vec<_>>();

    Ok(WaveformPeakData {
        asset_id: asset_id.to_string(),
        content_key: content_key.to_string(),
        peak_version: 1,
        channel_mode: channel_mode.to_string(),
        samples_per_peak: samples_per_peak as i64,
        duration_seconds: frame_count as f64 / wav.sample_rate as f64,
        sample_rate: wav.sample_rate as i64,
        channel_count: channels.len() as i64,
        peak_file_path: String::new(),
        peak_start_seconds: None,
        peak_end_seconds: None,
        channels,
        segment_markers: Vec::new(),
        clipping_markers,
        cached: false,
    })
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
    })
}

fn parse_wav_info_file(file: &mut fs::File) -> Result<WavInfo, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| error.to_string())?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("invalid WAV header".to_string());
    }

    let file_len = file.metadata().map_err(|error| error.to_string())?.len();
    let mut offset = 12_u64;
    let mut audio_format = None;
    let mut channels = None;
    let mut sample_rate = None;
    let mut bits_per_sample = None;
    let mut block_align = None;
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
            let read_len = 40_u64.min(chunk_size) as usize;
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
    read_wav_sample_at(bytes, wav.audio_format, wav.bits_per_sample, offset)
}

fn read_wav_sample_from_frame(
    bytes: &[u8],
    wav: &WavInfo,
    frame_index: usize,
    channel: usize,
) -> Result<f32, String> {
    let bytes_per_sample = usize::from(wav.bits_per_sample / 8);
    let offset = frame_index * usize::from(wav.block_align) + channel * bytes_per_sample;
    read_wav_sample_at(bytes, wav.audio_format, wav.bits_per_sample, offset)
}

fn read_wav_sample_at(
    bytes: &[u8],
    audio_format: u16,
    bits_per_sample: u16,
    offset: usize,
) -> Result<f32, String> {
    match (audio_format, bits_per_sample) {
        (1, 8) => {
            let sample = *bytes
                .get(offset)
                .ok_or_else(|| "unexpected end of WAV data".to_string())?;
            Ok(((sample as f32 - 128.0) / 128.0).clamp(-1.0, 1.0))
        }
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
        (1, 64) => Ok(
            (i64::from_le_bytes(slice_array(bytes, offset)?) as f64 / i64::MAX as f64)
                .clamp(-1.0, 1.0) as f32,
        ),
        (3, 32) => Ok(f32::from_le_bytes(slice_array(bytes, offset)?).clamp(-1.0, 1.0)),
        (3, 64) => Ok((f64::from_le_bytes(slice_array(bytes, offset)?).clamp(-1.0, 1.0)) as f32),
        _ => Err("unsupported WAV sample format".to_string()),
    }
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

fn waveform_cache_key(content_key: &str, channel_mode: &str, samples_per_peak: i64) -> String {
    format!("waveform:{content_key}:v1:{channel_mode}:{samples_per_peak}")
}

fn processing_hash_for_gain(gain_db: f64) -> String {
    if gain_db.abs() < 0.005 {
        "processing:none".to_string()
    } else {
        format!("processing:gain:{:.2}", gain_db.clamp(-24.0, 36.0))
    }
}

fn dbfs(value: f64) -> Option<f64> {
    if value > 0.0 {
        Some(20.0 * value.log10())
    } else {
        None
    }
}

fn analyzer_version() -> &'static str {
    "peak-rms-v1"
}

fn now_stamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    seconds.to_string()
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
            .execute_batch(include_str!(
                "../migrations/003_analysis_cache_columns.up.sql"
            ))
            .expect("apply analysis cache migration");
        connection
            .execute_batch(include_str!("../migrations/004_waveform_peak_files.up.sql"))
            .expect("apply waveform peak file migration");
        connection
    }

    fn insert_fixture_asset(connection: &Connection) -> String {
        let fixture_path = std::env::current_dir()
            .expect("read current directory")
            .join("..")
            .join("test-fixtures")
            .join("audio")
            .join("short-tone.wav")
            .canonicalize()
            .expect("canonicalize fixture path");
        connection
            .execute(
                "INSERT INTO sources (id, kind, provider, display_name, root_uri)
                 VALUES ('source_test', 'local', 'local', 'Fixtures', 'fixtures')",
                [],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO assets (
                    id, source_id, stable_key, path_or_url, name, format, duration_seconds,
                    channels, availability
                 ) VALUES (
                    'asset_test', 'source_test', 'fixture-key', ?1, 'short-tone.wav', 'wav',
                    0.5, 1, 'available'
                 )",
                params![fixture_path.to_string_lossy()],
            )
            .expect("insert asset");
        "asset_test".to_string()
    }

    fn insert_large_wav_asset(connection: &Connection, fixture_path: &Path) -> String {
        connection
            .execute(
                "INSERT INTO sources (id, kind, provider, display_name, root_uri)
                 VALUES ('source_large', 'local', 'local', 'Large Fixtures', 'fixtures')",
                [],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO assets (
                    id, source_id, stable_key, path_or_url, name, format, duration_seconds,
                    channels, availability
                 ) VALUES (
                    'asset_large', 'source_large', 'large-key', ?1, 'large.wav', 'wav',
                    120.0, 2, 'available'
                 )",
                params![fixture_path.to_string_lossy()],
            )
            .expect("insert asset");
        "asset_large".to_string()
    }

    fn wav_bytes(audio_format: u16, bits_per_sample: u16, channels: u16, data: Vec<u8>) -> Vec<u8> {
        let sample_rate = 44_100_u32;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * u32::from(block_align);
        let riff_size = 36 + data.len() as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&riff_size.to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&audio_format.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&block_align.to_le_bytes());
        bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&data);
        bytes
    }

    fn extensible_wav_bytes(bits_per_sample: u16, channels: u16, data: Vec<u8>) -> Vec<u8> {
        let sample_rate = 48_000_u32;
        let block_align = channels * (bits_per_sample / 8);
        let byte_rate = sample_rate * u32::from(block_align);
        let riff_size = 4 + 8 + 40 + 8 + data.len() as u32;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&riff_size.to_le_bytes());
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
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&data);
        bytes
    }

    fn test_runtime() -> AudioRuntime {
        AudioRuntime::new()
    }

    fn test_token() -> CancellationToken {
        CancellationToken::default()
    }

    fn test_deadline() -> JobDeadline {
        JobDeadline::new(std::time::Duration::from_secs(30))
    }

    #[test]
    fn resolves_preview_file_for_available_local_asset() {
        let connection = test_connection();
        let asset_id = insert_fixture_asset(&connection);

        let resolved =
            resolve_preview_file(&connection, &asset_id, "original").expect("resolve preview");

        assert_eq!(resolved.asset_id, asset_id);
        assert_eq!(resolved.content_key, "fixture-key");
        assert_eq!(resolved.media_type, "local-file");
    }

    #[test]
    fn generates_and_caches_wav_waveform_peaks() {
        let connection = test_connection();
        let asset_id = insert_fixture_asset(&connection);

        let runtime = test_runtime();
        let peaks = get_waveform_peaks(
            &runtime,
            &connection,
            &asset_id,
            "fixture-key",
            "stereo",
            256,
        )
        .expect("generate peaks");
        let cached = get_waveform_peaks(
            &runtime,
            &connection,
            &asset_id,
            "fixture-key",
            "stereo",
            256,
        )
        .expect("read cached peaks");

        assert!(!peaks.cached);
        assert!(cached.cached);
        assert_eq!(peaks.channels.len(), 2);
        assert!(!peaks.channels[0].maximums.is_empty());
    }

    #[test]
    fn analyzes_original_and_processed_full_file_levels() {
        let connection = test_connection();
        let asset_id = insert_fixture_asset(&connection);

        let runtime = test_runtime();
        let analysis =
            analyze_audio_levels(&runtime, &connection, &asset_id, 6.0).expect("analyze levels");
        let cached = analyze_audio_levels(&runtime, &connection, &asset_id, 6.0)
            .expect("read cached levels");

        assert_eq!(analysis.original.status, "complete");
        assert_eq!(analysis.processed.status, "complete");
        assert_eq!(analysis.original.processing_hash, "processing:none");
        assert!(analysis.original.peak_dbfs.is_some());
        assert!(analysis.processed.peak_dbfs.unwrap() > analysis.original.peak_dbfs.unwrap());
        assert_eq!(cached.processed.processing_hash, "processing:gain:6.00");
        assert_eq!(
            cached.processed.sample_count,
            analysis.processed.sample_count
        );
    }

    #[test]
    fn supports_8_bit_pcm_waveform_and_levels() {
        let bytes = wav_bytes(1, 8, 1, vec![0, 128, 255]);

        let token = test_token();
        let deadline = test_deadline();
        let peaks = generate_wav_peaks(&bytes, "asset_8", "key_8", "mono", 1, &token, &deadline)
            .expect("generate 8-bit peaks");
        let analysis = analyze_wav_levels(&bytes, "processing:none", 0.0, &token, &deadline)
            .expect("analyze 8-bit levels");

        assert_eq!(peaks.channels[0].minimums[0], -1.0);
        assert_eq!(peaks.channels[0].maximums[1], 0.0);
        assert!(peaks.channels[0].maximums[2] > 0.99);
        assert!(analysis.peak_dbfs.is_some());
    }

    #[test]
    fn supports_64_bit_float_waveform_and_levels() {
        let mut data = Vec::new();
        for sample in [-1.0_f64, 0.0, 1.0] {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let bytes = wav_bytes(3, 64, 1, data);

        let token = test_token();
        let deadline = test_deadline();
        let peaks =
            generate_wav_peaks(&bytes, "asset_f64", "key_f64", "mono", 1, &token, &deadline)
                .expect("generate 64-bit float peaks");
        let analysis = analyze_wav_levels(&bytes, "processing:none", 0.0, &token, &deadline)
            .expect("analyze 64-bit levels");

        assert_eq!(peaks.channels[0].minimums[0], -1.0);
        assert_eq!(peaks.channels[0].maximums[1], 0.0);
        assert_eq!(peaks.channels[0].maximums[2], 1.0);
        assert_eq!(analysis.clipping_samples, 2);
    }

    #[test]
    fn supports_extensible_pcm_waveform_and_levels() {
        let mut data = Vec::new();
        for sample in [-32768_i16, 0, 32767] {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let bytes = extensible_wav_bytes(16, 1, data);

        let token = test_token();
        let deadline = test_deadline();
        let peaks = generate_wav_peaks(
            &bytes,
            "asset_extensible",
            "key_extensible",
            "mono",
            1,
            &token,
            &deadline,
        )
        .expect("generate extensible peaks");
        let analysis = analyze_wav_levels(&bytes, "processing:none", 0.0, &token, &deadline)
            .expect("analyze extensible levels");

        assert_eq!(peaks.channels[0].minimums[0], -1.0);
        assert!(peaks.channels[0].maximums[2] > 0.99);
        assert!(analysis.peak_dbfs.is_some());
    }

    #[test]
    fn source_waveform_mode_preserves_file_channel_count() {
        let mut data = Vec::new();
        for sample in [-32768_i16, -1000, 1000, 32767] {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let bytes = wav_bytes(1, 16, 4, data);

        let token = test_token();
        let deadline = test_deadline();
        let peaks = generate_wav_peaks(
            &bytes,
            "asset_4ch",
            "key_4ch",
            "source",
            1,
            &token,
            &deadline,
        )
        .expect("generate source channel peaks");

        assert_eq!(peaks.channels.len(), 4);
        assert_eq!(peaks.channel_count, 4);
        assert_eq!(peaks.channels[0].minimums[0], -1.0);
        assert!(peaks.channels[3].maximums[0] > 0.99);
    }

    #[test]
    fn parses_audiowaveform_dat_v2_16_bit_stereo() {
        let path =
            std::env::temp_dir().join(format!("sonilabs_audiowaveform_{}.dat", std::process::id()));
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2_i32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&48_000_i32.to_le_bytes());
        bytes.extend_from_slice(&512_i32.to_le_bytes());
        bytes.extend_from_slice(&2_u32.to_le_bytes());
        bytes.extend_from_slice(&2_i32.to_le_bytes());
        for value in [-16_384_i16, 16_384, -8192, 8192, -4096, 4096, -2048, 2048] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        fs::write(&path, bytes).expect("write dat");

        let peaks =
            parse_audiowaveform_dat(&path, "asset", "content", "source", 512).expect("parse dat");

        assert_eq!(peaks.channel_count, 2);
        assert_eq!(peaks.channels[0].minimums.len(), 2);
        assert!((peaks.channels[0].minimums[0] + 0.5).abs() < 0.001);
        assert!((peaks.channels[1].maximums[1] - 0.0625).abs() < 0.001);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn writes_and_reads_binary_waveform_cache() {
        let path =
            std::env::temp_dir().join(format!("sonilabs_waveform_{}.slwf", std::process::id()));
        let channels = vec![
            WaveformPeakChannel {
                minimums: vec![-1.0, -0.25],
                maximums: vec![0.5, 1.0],
            },
            WaveformPeakChannel {
                minimums: vec![-0.5, 0.0],
                maximums: vec![0.25, 0.75],
            },
        ];

        write_binary_waveform_file(&path, &channels).expect("write binary cache");
        let restored =
            read_binary_waveform_file(&path.to_string_lossy(), 2, 2).expect("read binary cache");

        assert_eq!(restored.len(), 2);
        assert!((restored[0].minimums[0] + 1.0).abs() < 0.001);
        assert!((restored[1].maximums[1] - 0.75).abs() < 0.001);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_binary_waveform_cache_range() {
        let path = std::env::temp_dir().join(format!(
            "sonilabs_waveform_range_{}.slwf",
            std::process::id()
        ));
        let channels = vec![WaveformPeakChannel {
            minimums: vec![-1.0, -0.75, -0.5, -0.25],
            maximums: vec![0.25, 0.5, 0.75, 1.0],
        }];

        write_binary_waveform_file(&path, &channels).expect("write binary cache");
        let restored = read_binary_waveform_file_range(&path.to_string_lossy(), 1, 4, 1, 2)
            .expect("read binary cache range");

        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].minimums.len(), 2);
        assert!((restored[0].minimums[0] + 0.75).abs() < 0.001);
        assert!((restored[0].maximums[1] - 0.75).abs() < 0.001);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn cached_file_lookup_ignores_sparse_json_for_large_wav() {
        let connection = test_connection();
        let path = std::env::temp_dir().join(format!(
            "sonilabs_large_waveform_{}.wav",
            std::process::id()
        ));
        fs::write(&path, wav_bytes(1, 16, 2, vec![0; 4])).expect("write wav header");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open large wav")
            .set_len(SPARSE_WAVEFORM_FILE_BYTES + 1024)
            .expect("extend large wav");
        let asset_id = insert_large_wav_asset(&connection, &path);
        let sparse_cached = WaveformPeakData {
            asset_id: asset_id.clone(),
            content_key: "large-key".to_string(),
            peak_version: 1,
            channel_mode: "source".to_string(),
            samples_per_peak: 512,
            duration_seconds: 120.0,
            sample_rate: 44_100,
            channel_count: 2,
            peak_file_path: String::new(),
            peak_start_seconds: None,
            peak_end_seconds: None,
            channels: vec![WaveformPeakChannel {
                minimums: vec![-0.5],
                maximums: vec![0.5],
            }],
            segment_markers: Vec::new(),
            clipping_markers: Vec::new(),
            cached: false,
        };
        cache_waveform(&connection, &sparse_cached).expect("cache sparse waveform");

        let legacy_cached =
            get_cached_waveform_peaks(&connection, &asset_id, "large-key", "source", 512)
                .expect("read legacy cached waveform");
        let file_cached = get_cached_waveform_peaks_with_files(
            &connection,
            &asset_id,
            "large-key",
            "source",
            512,
        )
        .expect("read cached file waveform");

        assert!(legacy_cached.is_some());
        assert!(file_cached.is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn large_wav_generation_writes_binary_waveform_cache() {
        let connection = test_connection();
        let path = std::env::temp_dir().join(format!(
            "sonilabs_large_waveform_native_{}.wav",
            std::process::id()
        ));
        fs::write(&path, wav_bytes(1, 16, 2, vec![0, 0, 0, 0])).expect("write wav header");
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open large wav")
            .set_len(SPARSE_WAVEFORM_FILE_BYTES + 1024)
            .expect("extend large wav");
        let cache_root =
            std::env::temp_dir().join(format!("sonilabs_waveform_cache_{}", std::process::id()));
        let asset_id = insert_large_wav_asset(&connection, &path);
        let runtime = test_runtime();

        let peaks = get_waveform_peaks_with_sidecar(
            &runtime,
            &connection,
            &cache_root,
            None,
            &asset_id,
            "large-key",
            "source",
            512,
        )
        .expect("generate sparse large wav peaks");
        let cached = get_cached_waveform_peaks_with_files(
            &connection,
            &asset_id,
            "large-key",
            "source",
            512,
        )
        .expect("read cached large wav peaks");

        assert!(!peaks.peak_file_path.is_empty());
        assert!(cached.is_some());
        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(cache_root);
    }

    #[test]
    fn rejects_invalid_waveform_peak_request_shape() {
        let connection = test_connection();
        let asset_id = insert_fixture_asset(&connection);

        let runtime = test_runtime();
        let channel_error = get_waveform_peaks(
            &runtime,
            &connection,
            &asset_id,
            "fixture-key",
            "surround",
            256,
        )
        .expect_err("reject invalid channel mode");
        let resolution_error =
            get_waveform_peaks(&runtime, &connection, &asset_id, "fixture-key", "stereo", 0)
                .expect_err("reject invalid resolution");

        assert!(channel_error.contains("channel_mode"));
        assert!(resolution_error.contains("samples_per_peak"));
    }

    #[test]
    fn rejects_corrupt_wav_waveform_and_level_analysis() {
        let bytes = b"RIFF\0\0\0\0NOPE".to_vec();
        let token = test_token();
        let deadline = test_deadline();

        let waveform =
            generate_wav_peaks(&bytes, "asset_bad", "key_bad", "mono", 1, &token, &deadline)
                .expect_err("reject corrupt waveform");
        let analysis = analyze_wav_levels(&bytes, "processing:none", 0.0, &token, &deadline)
            .expect_err("reject corrupt analysis");

        assert!(waveform.contains("invalid WAV header"));
        assert!(analysis.contains("invalid WAV header"));
    }

    #[test]
    fn unavailable_preview_asset_is_marked_missing_for_waveform() {
        let connection = test_connection();
        connection
            .execute(
                "INSERT INTO sources (id, kind, provider, display_name, root_uri)
                 VALUES ('source_test', 'local', 'local', 'Fixtures', 'fixtures')",
                [],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO assets (
                    id, source_id, stable_key, path_or_url, name, format, availability
                 ) VALUES (
                    'asset_missing', 'source_test', 'missing-key', 'Z:/missing/asset.wav',
                    'asset.wav', 'wav', 'available'
                 )",
                [],
            )
            .expect("insert missing asset");
        let runtime = test_runtime();

        let error = get_waveform_peaks(
            &runtime,
            &connection,
            "asset_missing",
            "missing-key",
            "mono",
            128,
        )
        .expect_err("missing source");
        let availability: String = connection
            .query_row(
                "SELECT availability FROM assets WHERE id = 'asset_missing'",
                [],
                |row| row.get(0),
            )
            .expect("availability");

        assert!(error.contains("unavailable"));
        assert_eq!(availability, "missing");
    }
}
