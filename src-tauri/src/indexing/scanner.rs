use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::formats::is_supported_audio_extension;
use crate::reliability::{CancellationToken, JobDeadline};

use super::jobs::JobCounters;
use super::progress::{now_stamp, IndexingProgressPayload, ProgressSink, ThrottledProgress};
use super::IndexedFolder;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanCandidate {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub normalized_relative_path: String,
}

pub fn scan_folder<P: ProgressSink>(
    job_id: &str,
    source_id: &str,
    root_path: &Path,
    relative_path: Option<&str>,
    candidates: SyncSender<ScanCandidate>,
    folder_sender: SyncSender<IndexedFolder>,
    counters: Arc<JobCounters>,
    cancellation: CancellationToken,
    progress: Arc<ThrottledProgress<P>>,
    started_at: String,
    deadline: JobDeadline,
) -> Result<(), String> {
    let scan_root = relative_path
        .filter(|path| !path.is_empty())
        .map(|path| root_path.join(path))
        .unwrap_or_else(|| root_path.to_path_buf());
    let mut pending = VecDeque::from([scan_root]);

    while let Some(directory) = pending.pop_front() {
        deadline.check(&cancellation, "indexing scan")?;
        if cancellation.is_canceled() {
            return Ok(());
        }
        if should_skip_directory(&directory) {
            continue;
        }

        counters
            .folders_seen
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let relative_directory = normalize_relative_path(root_path, &directory);
        let display_name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("")
            .to_string();
        let _ = folder_sender.send(IndexedFolder {
            source_id: source_id.to_string(),
            relative_path: relative_directory.clone(),
            display_name,
            indexed_status: "indexed".to_string(),
        });

        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                counters
                    .files_failed
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                emit_progress(
                    job_id,
                    source_id,
                    root_path,
                    "running",
                    "scanning",
                    Some(directory.to_string_lossy().to_string()),
                    Some(error.to_string()),
                    &counters,
                    &progress,
                    &started_at,
                    false,
                );
                continue;
            }
        };

        for entry in entries {
            deadline.check(&cancellation, "indexing scan")?;
            if cancellation.is_canceled() {
                return Ok(());
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    counters
                        .files_failed
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    emit_progress(
                        job_id,
                        source_id,
                        root_path,
                        "running",
                        "scanning",
                        None,
                        Some(error.to_string()),
                        &counters,
                        &progress,
                        &started_at,
                        false,
                    );
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if !should_skip_directory(&path) {
                    pending.push_back(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            counters
                .files_seen
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if !is_supported_audio_extension(&path) {
                counters
                    .files_skipped
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                continue;
            }

            counters
                .audio_candidates
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let relative_path = normalize_relative_path(root_path, &path);
            let candidate = ScanCandidate {
                absolute_path: path,
                normalized_relative_path: normalize_for_compare(&relative_path),
                relative_path,
            };
            if candidates.send(candidate).is_err() {
                return Ok(());
            }
            emit_progress(
                job_id,
                source_id,
                root_path,
                "running",
                "scanning",
                None,
                None,
                &counters,
                &progress,
                &started_at,
                false,
            );
        }
    }

    Ok(())
}

pub fn normalize_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn normalize_for_compare(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

pub fn is_probably_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
}

fn should_skip_directory(path: &Path) -> bool {
    if is_probably_hidden(path) {
        return true;
    }
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name.to_ascii_lowercase().as_str(),
        "node_modules" | "target" | ".git" | ".sonilabs-cache" | "waveform-cache" | "__pycache__"
    )
}

pub fn emit_progress<P: ProgressSink>(
    job_id: &str,
    source_id: &str,
    root_path: &Path,
    status: &str,
    phase: &str,
    current_path: Option<String>,
    message: Option<String>,
    counters: &JobCounters,
    progress: &ThrottledProgress<P>,
    started_at: &str,
    force: bool,
) {
    let payload = IndexingProgressPayload {
        job_id: job_id.to_string(),
        source_id: source_id.to_string(),
        root_path: root_path.to_string_lossy().to_string(),
        status: status.to_string(),
        phase: phase.to_string(),
        folders_seen: counters.load_folders_seen(),
        files_seen: counters.load_files_seen(),
        audio_candidates: counters.load_audio_candidates(),
        files_indexed: counters.load_files_indexed(),
        files_skipped: counters.load_files_skipped(),
        files_failed: counters.load_files_failed(),
        missing_marked: counters.load_missing_marked(),
        current_path,
        message,
        started_at: started_at.to_string(),
        updated_at: now_stamp(),
    };
    if force {
        progress.emit_final(payload);
    } else {
        progress.emit(payload);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_windows_style_paths_for_compare() {
        assert_eq!(
            normalize_for_compare("Impacts\\Metal\\Hit.WAV"),
            "impacts/metal/hit.wav"
        );
    }
}
