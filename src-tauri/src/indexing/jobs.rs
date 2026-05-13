use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;

use crate::reliability::{CancellationToken, JobDeadline};

use super::metadata::extract_basic_metadata;
use super::metadata_import::{
    load_imported_metadata, merge_imported_metadata_json, metadata_file_from_settings,
    ImportedMetadata,
};
use super::progress::{now_stamp, ProgressSink, ThrottledProgress};
use super::scanner::{emit_progress, normalize_for_compare, scan_folder, ScanCandidate};
use super::tagging::{enrich_asset_tags, merge_tag_enrichment_metadata_json};
use super::{
    mark_missing_assets, IndexedAssetMetadata, IndexedFolder, IndexingErrorRecord,
    IndexingJobRequest, IndexingRepository, ReindexMode,
};

const DISCOVERY_BUFFER: usize = 8_192;
const PERSISTENCE_BUFFER: usize = 4_096;
const FOLDER_BUFFER: usize = 2_048;
const PERSISTENCE_BATCH_SIZE: usize = 500;
const FOLDER_BATCH_SIZE: usize = 200;
const PERSISTENCE_FLUSH_INTERVAL_MS: u64 = 1_000;
const PROBE_RECV_TIMEOUT_MS: u64 = 500;
const PROBE_INACTIVITY_TIMEOUT_SECONDS: u64 = 30;
const INDEXING_TIMEOUT_SECONDS: u64 = 60 * 60;

#[derive(Default)]
pub struct JobCounters {
    pub folders_seen: AtomicU64,
    pub files_seen: AtomicU64,
    pub audio_candidates: AtomicU64,
    pub files_indexed: AtomicU64,
    pub files_skipped: AtomicU64,
    pub files_failed: AtomicU64,
    pub missing_marked: AtomicU64,
}

impl JobCounters {
    pub fn load_folders_seen(&self) -> u64 {
        self.folders_seen.load(Ordering::Relaxed)
    }
    pub fn load_files_seen(&self) -> u64 {
        self.files_seen.load(Ordering::Relaxed)
    }
    pub fn load_audio_candidates(&self) -> u64 {
        self.audio_candidates.load(Ordering::Relaxed)
    }
    pub fn load_files_indexed(&self) -> u64 {
        self.files_indexed.load(Ordering::Relaxed)
    }
    pub fn load_files_skipped(&self) -> u64 {
        self.files_skipped.load(Ordering::Relaxed)
    }
    pub fn load_files_failed(&self) -> u64 {
        self.files_failed.load(Ordering::Relaxed)
    }
    pub fn load_missing_marked(&self) -> u64 {
        self.missing_marked.load(Ordering::Relaxed)
    }
}

enum ProbeOutcome {
    Asset(IndexedAssetMetadata),
    ProbeFailed {
        normalized_relative_path: String,
        absolute_path: String,
        error: String,
    },
}

pub fn run_indexing_job<R, P>(
    job_id: String,
    request: IndexingJobRequest,
    repository: R,
    progress_sink: P,
    cancellation: CancellationToken,
) -> Result<String, String>
where
    R: IndexingRepository,
    P: ProgressSink,
{
    let root_path = PathBuf::from(&request.root_path);
    let started_at = now_stamp();
    let counters = Arc::new(JobCounters::default());
    let progress = Arc::new(ThrottledProgress::new(progress_sink));
    let repository = Arc::new(repository);
    let mark_missing_on_complete = matches!(request.reindex_mode.as_ref(), Some(ReindexMode::Full));
    if !root_path.is_dir() {
        repository.upsert_source_scan_state(&request.source_id, "offline")?;
        repository.record_activity(
            &request.source_id,
            "Indexing root is unavailable",
            "warning",
        )?;
        return Ok("offline".to_string());
    }
    repository.upsert_source_scan_state(&request.source_id, "indexing")?;
    repository.record_activity(&request.source_id, "Indexing started", "info")?;
    let imported_metadata = load_source_metadata(repository.as_ref(), &request.source_id)?;
    if imported_metadata.row_count() > 0 {
        repository.record_activity(
            &request.source_id,
            &format!(
                "Loaded {} metadata row(s) from {}",
                imported_metadata.row_count(),
                imported_metadata.source_file()
            ),
            "info",
        )?;
    }
    let imported_metadata = Arc::new(imported_metadata);
    let deadline = JobDeadline::new(std::time::Duration::from_secs(INDEXING_TIMEOUT_SECONDS));

    emit_progress(
        &job_id,
        &request.source_id,
        &root_path,
        "running",
        "scanning",
        None,
        None,
        &counters,
        &progress,
        &started_at,
        true,
    );

    let (candidate_tx, candidate_rx) = sync_channel::<ScanCandidate>(DISCOVERY_BUFFER);
    let (probe_tx, probe_rx) = sync_channel::<ProbeOutcome>(PERSISTENCE_BUFFER);
    let (folder_tx, folder_rx) = sync_channel::<IndexedFolder>(FOLDER_BUFFER);
    let discovered_paths = Arc::new(Mutex::new(HashSet::new()));

    let scanner_counters = Arc::clone(&counters);
    let scanner_progress = Arc::clone(&progress);
    let scanner_cancel = cancellation.clone();
    let scanner_root = root_path.clone();
    let scanner_job_id = job_id.clone();
    let scanner_source_id = request.source_id.clone();
    let scanner_relative = request.relative_path.clone();
    let scanner_started_at = started_at.clone();
    let scanner_deadline =
        JobDeadline::new(std::time::Duration::from_secs(INDEXING_TIMEOUT_SECONDS));
    let scanner = thread::spawn(move || {
        scan_folder(
            &scanner_job_id,
            &scanner_source_id,
            &scanner_root,
            scanner_relative.as_deref(),
            candidate_tx,
            folder_tx,
            scanner_counters,
            scanner_cancel,
            scanner_progress,
            scanner_started_at,
            scanner_deadline,
        )
    });

    let candidate_rx = Arc::new(Mutex::new(candidate_rx));
    let worker_count = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
        .clamp(4, 16);
    let mut workers = Vec::new();
    for _ in 0..worker_count {
        let rx = Arc::clone(&candidate_rx);
        let tx: SyncSender<ProbeOutcome> = probe_tx.clone();
        let counters = Arc::clone(&counters);
        let cancellation = cancellation.clone();
        let discovered_paths = Arc::clone(&discovered_paths);
        let imported_metadata = Arc::clone(&imported_metadata);
        let source_id = request.source_id.clone();
        workers.push(thread::spawn(move || loop {
            let candidate = {
                let rx = match rx.lock() {
                    Ok(rx) => rx,
                    Err(_) => break,
                };
                match rx.recv() {
                    Ok(candidate) => candidate,
                    Err(_) => break,
                }
            };
            if cancellation.is_canceled() {
                continue;
            }
            if let Ok(mut discovered) = discovered_paths.lock() {
                discovered.insert(candidate.normalized_relative_path.clone());
            }
            let outcome = match extract_basic_metadata(&candidate.absolute_path) {
                Ok(metadata) => {
                    let format = metadata.probe.format.unwrap_or_default();
                    let container = metadata.probe.container;
                    let codec = metadata.probe.codec;
                    let mut metadata_json = json!({
                        "relativePath": candidate.relative_path.clone(),
                        "normalizedRelativePath": candidate.normalized_relative_path.clone(),
                        "container": container.clone(),
                        "codec": codec.clone()
                    })
                    .to_string();
                    let name = candidate
                        .absolute_path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or_default()
                        .to_string();
                    let imported = imported_metadata.match_asset(&candidate.relative_path, &name);
                    if let Some(imported) = imported {
                        metadata_json = merge_imported_metadata_json(
                            &metadata_json,
                            imported_metadata.source_file(),
                            imported,
                        );
                    }
                    let imported_tags = imported.map(|row| row.tags.as_slice()).unwrap_or_default();
                    let description = imported.and_then(|row| row.description.clone());
                    let tag_enrichment = enrich_asset_tags(
                        imported_tags,
                        &name,
                        &candidate.relative_path,
                        description.as_deref(),
                    );
                    metadata_json =
                        merge_tag_enrichment_metadata_json(&metadata_json, &tag_enrichment);
                    ProbeOutcome::Asset(IndexedAssetMetadata {
                        source_id: source_id.clone(),
                        absolute_path: candidate.absolute_path.to_string_lossy().to_string(),
                        relative_path: candidate.relative_path,
                        normalized_relative_path: candidate.normalized_relative_path,
                        name,
                        extension: metadata.probe.extension,
                        format,
                        container,
                        codec,
                        duration_seconds: metadata.duration_seconds,
                        sample_rate: metadata.sample_rate,
                        bit_depth: metadata.bit_depth,
                        channels: metadata.channels,
                        byte_size: metadata.byte_size,
                        modified_at: metadata.modified_at,
                        metadata_json,
                        license: imported.and_then(|row| row.license.clone()),
                        attribution: imported.and_then(|row| row.attribution.clone()),
                        originator: imported.and_then(|row| row.originator.clone()),
                        description,
                        tags: tag_enrichment.tags,
                    })
                }
                Err(error) => {
                    counters.files_failed.fetch_add(1, Ordering::Relaxed);
                    ProbeOutcome::ProbeFailed {
                        normalized_relative_path: candidate.normalized_relative_path,
                        absolute_path: candidate.absolute_path.to_string_lossy().to_string(),
                        error,
                    }
                }
            };
            if tx.send(outcome).is_err() {
                break;
            }
        }));
    }
    drop(probe_tx);

    let mut completed_with_errors = false;
    let mut batch = Vec::with_capacity(PERSISTENCE_BATCH_SIZE);
    let mut folder_batch = Vec::with_capacity(FOLDER_BATCH_SIZE);
    let mut last_persist = Instant::now();
    let mut should_join_workers = true;
    let mut should_join_scanner = true;
    let mut stalled = false;
    let mut last_probe_activity = Instant::now();
    loop {
        drain_folder_rx(repository.as_ref(), &folder_rx, &mut folder_batch)?;
        let outcome = match probe_rx.recv_timeout(Duration::from_millis(PROBE_RECV_TIMEOUT_MS)) {
            Ok(outcome) => outcome,
            Err(RecvTimeoutError::Timeout) => {
                if !cancellation.is_canceled() {
                    persist_asset_batch(repository.as_ref(), &mut batch, &counters)?;
                    drain_folder_rx(repository.as_ref(), &folder_rx, &mut folder_batch)?;
                    last_persist = Instant::now();
                    emit_progress(
                        &job_id,
                        &request.source_id,
                        &root_path,
                        "running",
                        "persisting",
                        None,
                        None,
                        &counters,
                        &progress,
                        &started_at,
                        false,
                    );
                }
                if last_probe_activity.elapsed()
                    >= Duration::from_secs(PROBE_INACTIVITY_TIMEOUT_SECONDS)
                {
                    cancellation.cancel();
                    completed_with_errors = true;
                    should_join_workers = false;
                    should_join_scanner = false;
                    stalled = true;
                    repository.record_activity(
                        &request.source_id,
                        "Indexing stopped after probe workers stopped reporting progress",
                        "warning",
                    )?;
                    break;
                }
                if let Err(error) = deadline.check(&cancellation, "indexing job") {
                    cancellation.cancel();
                    completed_with_errors = true;
                    should_join_workers = false;
                    should_join_scanner = false;
                    repository.record_activity(&request.source_id, &error, "warning")?;
                    break;
                }
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        };
        last_probe_activity = Instant::now();
        if cancellation.is_canceled() {
            continue;
        }
        if let Err(error) = deadline.check(&cancellation, "indexing job") {
            cancellation.cancel();
            completed_with_errors = true;
            should_join_workers = false;
            should_join_scanner = false;
            repository.record_activity(&request.source_id, &error, "warning")?;
            break;
        }
        match outcome {
            ProbeOutcome::Asset(asset) => {
                batch.push(asset);
                if batch.len() >= PERSISTENCE_BATCH_SIZE
                    || last_persist.elapsed()
                        >= Duration::from_millis(PERSISTENCE_FLUSH_INTERVAL_MS)
                {
                    persist_asset_batch(repository.as_ref(), &mut batch, &counters)?;
                    drain_folder_rx(repository.as_ref(), &folder_rx, &mut folder_batch)?;
                    last_persist = Instant::now();
                }
            }
            ProbeOutcome::ProbeFailed {
                normalized_relative_path,
                absolute_path,
                error,
            } => {
                completed_with_errors = true;
                repository.mark_asset_probe_failed(
                    &request.source_id,
                    &normalized_relative_path,
                    &absolute_path,
                    &error,
                )?;
                repository.record_indexing_error(IndexingErrorRecord {
                    source_id: request.source_id.clone(),
                    scope: "asset".to_string(),
                    path: Some(absolute_path),
                    message: error,
                })?;
            }
        }
        emit_progress(
            &job_id,
            &request.source_id,
            &root_path,
            "running",
            "persisting",
            None,
            None,
            &counters,
            &progress,
            &started_at,
            false,
        );
    }
    if !cancellation.is_canceled() {
        persist_asset_batch(repository.as_ref(), &mut batch, &counters)?;
        drain_folder_rx(repository.as_ref(), &folder_rx, &mut folder_batch)?;
    }

    if should_join_scanner {
        match scanner
            .join()
            .map_err(|_| "scanner thread panicked".to_string())?
        {
            Ok(()) => {}
            Err(error) if error.contains("timed out") => {
                cancellation.cancel();
                repository.upsert_source_scan_state(&request.source_id, "paused")?;
                repository.record_activity(&request.source_id, &error, "warning")?;
            }
            Err(error) => return Err(error),
        }
    }
    if should_join_workers {
        for worker in workers {
            let _ = worker.join();
        }
    }
    if !cancellation.is_canceled() {
        drain_folder_rx(repository.as_ref(), &folder_rx, &mut folder_batch)?;
        persist_folder_batch(repository.as_ref(), &mut folder_batch)?;
    }

    if !cancellation.is_canceled() && mark_missing_on_complete {
        let discovered = discovered_paths
            .lock()
            .map_err(|_| "discovered path lock poisoned".to_string())?;
        let missing_marked = mark_missing_assets(
            repository.as_ref(),
            &request.source_id,
            &discovered,
            request.relative_path.as_deref(),
        )?;
        counters
            .missing_marked
            .fetch_add(missing_marked, Ordering::Relaxed);
    }

    let final_status = if stalled {
        repository.upsert_source_scan_state(&request.source_id, "error")?;
        "completed_with_errors"
    } else if cancellation.is_canceled() {
        repository.upsert_source_scan_state(&request.source_id, "paused")?;
        "canceled"
    } else if completed_with_errors || counters.load_files_failed() > 0 {
        repository.upsert_source_scan_state(&request.source_id, "error")?;
        "completed_with_errors"
    } else {
        repository.upsert_source_scan_state(&request.source_id, "active")?;
        "completed"
    };

    emit_progress(
        &job_id,
        &request.source_id,
        &root_path,
        final_status,
        if final_status == "canceled" {
            "canceling"
        } else {
            "completed"
        },
        None,
        Some(final_status.to_string()),
        &counters,
        &progress,
        &started_at,
        true,
    );

    repository.record_activity(&request.source_id, "Indexing finished", "success")?;
    Ok(final_status.to_string())
}

fn load_source_metadata<R: IndexingRepository>(
    repository: &R,
    source_id: &str,
) -> Result<ImportedMetadata, String> {
    let settings_json = repository.source_settings_json(source_id)?;
    let Some(metadata_file) = metadata_file_from_settings(&settings_json) else {
        return Ok(ImportedMetadata::empty());
    };
    match load_imported_metadata(&metadata_file) {
        Ok(metadata) => Ok(metadata),
        Err(error) => {
            repository.record_activity(
                source_id,
                &format!("Metadata import skipped: {error}"),
                "warning",
            )?;
            Ok(ImportedMetadata::empty())
        }
    }
}

fn persist_asset_batch<R: IndexingRepository>(
    repository: &R,
    batch: &mut Vec<IndexedAssetMetadata>,
    counters: &JobCounters,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let assets = std::mem::take(batch);
    let indexed = repository.upsert_asset_metadata_batch(assets)?;
    counters
        .files_indexed
        .fetch_add(indexed as u64, Ordering::Relaxed);
    Ok(())
}

fn persist_folder_batch<R: IndexingRepository>(
    repository: &R,
    batch: &mut Vec<IndexedFolder>,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }
    let folders = std::mem::take(batch);
    repository.upsert_folders_batch(folders)?;
    Ok(())
}

fn drain_folder_rx<R: IndexingRepository>(
    repository: &R,
    folder_rx: &std::sync::mpsc::Receiver<IndexedFolder>,
    batch: &mut Vec<IndexedFolder>,
) -> Result<(), String> {
    loop {
        match folder_rx.try_recv() {
            Ok(folder) => {
                batch.push(folder);
                if batch.len() >= FOLDER_BATCH_SIZE {
                    persist_folder_batch(repository, batch)?;
                }
            }
            Err(TryRecvError::Empty) => return Ok(()),
            Err(TryRecvError::Disconnected) => {
                persist_folder_batch(repository, batch)?;
                return Ok(());
            }
        }
    }
}

#[allow(dead_code)]
fn _normalize_for_tests(path: &str) -> String {
    normalize_for_compare(path)
}
