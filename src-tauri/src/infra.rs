use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct AppPaths {
    config_dir: String,
    data_dir: String,
    cache_dir: String,
    log_dir: String,
}

#[derive(Deserialize)]
pub struct StructuredLogInput {
    level: String,
    scope: String,
    message: String,
    context: Option<Value>,
    timestamp: String,
}

#[derive(Serialize)]
pub struct LogExport {
    path: String,
    bytes: u64,
}

#[derive(Serialize)]
pub struct FfmpegValidation {
    path: String,
    version: String,
    minimum_version: String,
}

pub fn app_paths(app: &AppHandle) -> Result<AppPaths, String> {
    let path = app.path();
    let config_dir = path.app_config_dir().map_err(|error| error.to_string())?;
    let data_dir = path.app_data_dir().map_err(|error| error.to_string())?;
    let cache_dir = path.app_cache_dir().map_err(|error| error.to_string())?;
    let log_dir = data_dir.join("logs");

    for dir in [&config_dir, &data_dir, &cache_dir, &log_dir] {
        fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }

    Ok(AppPaths {
        config_dir: config_dir.display().to_string(),
        data_dir: data_dir.display().to_string(),
        cache_dir: cache_dir.display().to_string(),
        log_dir: log_dir.display().to_string(),
    })
}

pub fn write_structured_log(app: &AppHandle, input: StructuredLogInput) -> Result<(), String> {
    let log_path = log_file_path(app)?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| error.to_string())?;
    let line = serde_json::to_string(&serde_json::json!({
        "level": input.level,
        "scope": input.scope,
        "message": input.message,
        "context": input.context,
        "timestamp": input.timestamp,
    }))
    .map_err(|error| error.to_string())?;

    writeln!(file, "{line}").map_err(|error| error.to_string())
}

pub fn export_local_logs(app: &AppHandle) -> Result<LogExport, String> {
    let log_path = log_file_path(app)?;

    if !log_path.exists() {
        fs::write(&log_path, "").map_err(|error| error.to_string())?;
    }

    let bytes = fs::metadata(&log_path)
        .map_err(|error| error.to_string())?
        .len();

    Ok(LogExport {
        path: log_path.display().to_string(),
        bytes,
    })
}

pub fn validate_ffmpeg_sidecar(
    app: &AppHandle,
    configured_path: Option<String>,
    minimum_version: Option<String>,
) -> Result<FfmpegValidation, String> {
    let minimum_version = minimum_version.unwrap_or_else(|| "6.0".to_string());
    let mut candidates = Vec::new();

    if let Some(path) = configured_path {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(path) = std::env::var("FFMPEG_PATH") {
        candidates.push(PathBuf::from(path));
    }

    candidates.push(
        app.path()
            .resource_dir()
            .unwrap_or_default()
            .join("bin/ffmpeg.exe"),
    );
    candidates.push(PathBuf::from("src-tauri/bin/ffmpeg.exe"));
    candidates.push(PathBuf::from("ffmpeg"));

    for candidate in candidates {
        if candidate != PathBuf::from("ffmpeg") && !candidate.exists() {
            continue;
        }

        if let Some(version) = read_ffmpeg_version(&candidate) {
            if version_at_least(&version, &minimum_version) {
                return Ok(FfmpegValidation {
                    path: candidate.display().to_string(),
                    version,
                    minimum_version,
                });
            }
        }
    }

    Err(format!("FFmpeg {minimum_version}+ was not found."))
}

fn log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let log_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("logs");
    fs::create_dir_all(&log_dir).map_err(|error| error.to_string())?;
    Ok(log_dir.join("sonilabs.ndjson"))
}

fn read_ffmpeg_version(path: &PathBuf) -> Option<String> {
    let output = Command::new(path)
        .arg("-version")
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let prefix = "ffmpeg version ";
    let start = text.find(prefix)? + prefix.len();
    let rest = &text[start..];

    rest.split_whitespace().next().map(str::to_string)
}

fn version_at_least(version: &str, minimum: &str) -> bool {
    let current = version_parts(version);
    let required = version_parts(minimum);

    if current.is_empty() || required.is_empty() {
        return true;
    }

    for index in 0..required.len() {
        let left = *current.get(index).unwrap_or(&0);
        let right = required[index];

        if left > right {
            return true;
        }

        if left < right {
            return false;
        }
    }

    true
}

fn version_parts(value: &str) -> Vec<u32> {
    value
        .split(['.', '-'])
        .filter_map(|part| part.parse::<u32>().ok())
        .collect()
}
