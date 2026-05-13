pub mod formats;
pub mod jobs;
pub mod metadata;
pub mod metadata_import;
pub mod progress;
pub mod scanner;
pub mod tagging;
pub mod watcher;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::reliability::{BoundedJobGate, CancellationToken};

use self::jobs::run_indexing_job;
use self::progress::{IndexingProgressPayload, ProgressSink};
use self::watcher::{start_debounced_watcher, FolderWatcher};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IndexingJobMode {
    IndexSource,
    IndexFolder,
    ReindexSource,
    ReindexFolder,
    WatchEventRescan,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReindexMode {
    Quick,
    Metadata,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexingJobRequest {
    pub source_id: String,
    pub root_path: String,
    pub relative_path: Option<String>,
    pub mode: IndexingJobMode,
    pub reindex_mode: Option<ReindexMode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexingJobHandle {
    pub job_id: String,
    pub source_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CancellationResult {
    pub job_id: String,
    pub accepted: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedFolder {
    pub source_id: String,
    pub relative_path: String,
    pub display_name: String,
    pub indexed_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedAssetMetadata {
    pub source_id: String,
    pub absolute_path: String,
    pub relative_path: String,
    pub normalized_relative_path: String,
    pub name: String,
    pub extension: String,
    pub format: String,
    pub container: Option<String>,
    pub codec: Option<String>,
    pub duration_seconds: Option<f64>,
    pub sample_rate: Option<i64>,
    pub bit_depth: Option<i64>,
    pub channels: Option<i64>,
    pub byte_size: i64,
    pub modified_at: String,
    pub metadata_json: String,
    pub license: Option<String>,
    pub attribution: Option<String>,
    pub originator: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexingErrorRecord {
    pub source_id: String,
    pub scope: String,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownAssetPath {
    pub normalized_relative_path: String,
}

pub trait IndexingRepository: Send + Sync + 'static {
    fn upsert_source_scan_state(&self, source_id: &str, status: &str) -> Result<(), String>;
    fn upsert_folder(&self, folder: IndexedFolder) -> Result<(), String>;
    fn upsert_folders_batch(&self, folders: Vec<IndexedFolder>) -> Result<usize, String> {
        let mut count = 0;
        for folder in folders {
            self.upsert_folder(folder)?;
            count += 1;
        }
        Ok(count)
    }
    fn upsert_asset_metadata(&self, asset: IndexedAssetMetadata) -> Result<(), String>;
    fn upsert_asset_metadata_batch(
        &self,
        assets: Vec<IndexedAssetMetadata>,
    ) -> Result<usize, String> {
        let mut count = 0;
        for asset in assets {
            self.upsert_asset_metadata(asset)?;
            count += 1;
        }
        Ok(count)
    }
    fn mark_asset_missing(
        &self,
        source_id: &str,
        normalized_relative_path: &str,
    ) -> Result<(), String>;
    fn mark_asset_probe_failed(
        &self,
        source_id: &str,
        normalized_relative_path: &str,
        absolute_path: &str,
        error: &str,
    ) -> Result<(), String>;
    fn record_indexing_error(&self, error: IndexingErrorRecord) -> Result<(), String>;
    fn record_activity(&self, source_id: &str, message: &str, status: &str) -> Result<(), String>;
    fn source_settings_json(&self, source_id: &str) -> Result<String, String>;
    fn list_known_asset_paths(&self, source_id: &str) -> Result<Vec<KnownAssetPath>, String>;
}

#[derive(Clone)]
pub struct IndexingRuntime {
    inner: Arc<RuntimeState>,
}

struct RuntimeState {
    jobs: Mutex<HashMap<String, JobState>>,
    active_by_source: Mutex<HashMap<String, String>>,
    watchers: Mutex<HashMap<String, FolderWatcher>>,
    queue: BoundedJobGate,
}

struct JobState {
    source_id: String,
    status: String,
    cancellation: CancellationToken,
    started_at: Instant,
}

impl IndexingRuntime {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RuntimeState {
                jobs: Mutex::new(HashMap::new()),
                active_by_source: Mutex::new(HashMap::new()),
                watchers: Mutex::new(HashMap::new()),
                queue: BoundedJobGate::new("indexing", 2),
            }),
        }
    }

    pub fn start_job<R, P>(
        &self,
        request: IndexingJobRequest,
        repository: R,
        progress_sink: P,
    ) -> Result<IndexingJobHandle, String>
    where
        R: IndexingRepository,
        P: ProgressSink,
    {
        let job_id = make_job_id();
        let source_id = request.source_id.clone();
        {
            let mut active = self
                .inner
                .active_by_source
                .lock()
                .map_err(|_| "indexing active-source lock poisoned".to_string())?;
            if let Some(existing) = active.get(&request.source_id) {
                return Ok(IndexingJobHandle {
                    job_id: existing.clone(),
                    source_id: request.source_id,
                    status: "running".to_string(),
                });
            }
            active.insert(request.source_id.clone(), job_id.clone());
        }

        let cancellation = CancellationToken::default();
        let permit = match self.inner.queue.try_enter() {
            Ok(permit) => permit,
            Err(error) => {
                if let Ok(mut active) = self.inner.active_by_source.lock() {
                    active.remove(&source_id);
                }
                return Err(error);
            }
        };
        {
            let mut jobs = match self.inner.jobs.lock() {
                Ok(jobs) => jobs,
                Err(_) => {
                    if let Ok(mut active) = self.inner.active_by_source.lock() {
                        active.remove(&source_id);
                    }
                    return Err("indexing jobs lock poisoned".to_string());
                }
            };
            jobs.insert(
                job_id.clone(),
                JobState {
                    source_id: request.source_id.clone(),
                    status: "queued".to_string(),
                    cancellation: cancellation.clone(),
                    started_at: Instant::now(),
                },
            );
        }

        let runtime = self.clone();
        let thread_job_id = job_id.clone();
        thread::spawn(move || {
            let _permit = permit;
            let status = run_indexing_job(
                thread_job_id.clone(),
                request,
                repository,
                progress_sink,
                cancellation,
            )
            .unwrap_or_else(|_| "failed".to_string());
            runtime.finish_job(&thread_job_id, &status);
        });

        Ok(IndexingJobHandle {
            job_id,
            source_id,
            status: "queued".to_string(),
        })
    }

    pub fn cancel_job(&self, job_id: &str) -> CancellationResult {
        let mut jobs = match self.inner.jobs.lock() {
            Ok(jobs) => jobs,
            Err(_) => {
                return CancellationResult {
                    job_id: job_id.to_string(),
                    accepted: false,
                    status: "failed".to_string(),
                };
            }
        };

        match jobs.get_mut(job_id) {
            Some(state) => {
                state.status = "canceling".to_string();
                state.cancellation.cancel();
                CancellationResult {
                    job_id: job_id.to_string(),
                    accepted: true,
                    status: "canceling".to_string(),
                }
            }
            None => CancellationResult {
                job_id: job_id.to_string(),
                accepted: false,
                status: "not_found".to_string(),
            },
        }
    }

    pub fn start_watcher<R, P>(
        &self,
        source_id: String,
        root_path: String,
        repository_factory: Arc<dyn Fn() -> R + Send + Sync>,
        progress_sink_factory: Arc<dyn Fn() -> P + Send + Sync>,
    ) -> Result<(), String>
    where
        R: IndexingRepository,
        P: ProgressSink,
    {
        let runtime = self.clone();
        let source_for_key = source_id.clone();
        let root_for_callback = root_path.clone();
        let watcher = start_debounced_watcher(PathBuf::from(&root_path), move |relative_path| {
            let request = IndexingJobRequest {
                source_id: source_id.clone(),
                root_path: root_for_callback.clone(),
                relative_path,
                mode: IndexingJobMode::WatchEventRescan,
                reindex_mode: Some(ReindexMode::Metadata),
            };
            let _ = runtime.start_job(request, repository_factory(), progress_sink_factory());
        })?;

        self.inner
            .watchers
            .lock()
            .map_err(|_| "indexing watcher lock poisoned".to_string())?
            .insert(source_for_key, watcher);
        Ok(())
    }

    pub fn stop_watcher(&self, source_id: &str) -> bool {
        self.inner
            .watchers
            .lock()
            .map(|mut watchers| watchers.remove(source_id).is_some())
            .unwrap_or(false)
    }

    fn finish_job(&self, job_id: &str, status: &str) {
        let mut source_id = None;
        if let Ok(mut jobs) = self.inner.jobs.lock() {
            if let Some(state) = jobs.get_mut(job_id) {
                state.status = status.to_string();
                source_id = Some(state.source_id.clone());
                let _elapsed = state.started_at.elapsed();
            }
        }
        if let Some(source_id) = source_id {
            if let Ok(mut active) = self.inner.active_by_source.lock() {
                active.remove(&source_id);
            }
        }
    }
}

impl Default for IndexingRuntime {
    fn default() -> Self {
        Self::new()
    }
}

pub fn mark_missing_assets<R: IndexingRepository>(
    repository: &R,
    source_id: &str,
    discovered: &HashSet<String>,
    relative_scope: Option<&str>,
) -> Result<u64, String> {
    let mut missing = 0;
    let normalized_scope = relative_scope
        .filter(|scope| !scope.is_empty())
        .map(scanner::normalize_for_compare)
        .map(|scope| scope.trim_end_matches('/').to_string())
        .filter(|scope| !scope.is_empty());
    for known in repository.list_known_asset_paths(source_id)? {
        if let Some(scope) = normalized_scope.as_deref() {
            let in_scope = known.normalized_relative_path == scope
                || known
                    .normalized_relative_path
                    .strip_prefix(scope)
                    .map(|rest| rest.starts_with('/'))
                    .unwrap_or(false);
            if !in_scope {
                continue;
            }
        }
        if !discovered.contains(&known.normalized_relative_path) {
            repository.mark_asset_missing(source_id, &known.normalized_relative_path)?;
            missing += 1;
        }
    }
    Ok(missing)
}

fn make_job_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("index_job_{nanos}")
}

#[allow(dead_code)]
pub type ProgressStreamItem = IndexingProgressPayload;

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct MemoryIndexingRepository {
        known: Vec<KnownAssetPath>,
        missing: Mutex<Vec<String>>,
    }

    impl IndexingRepository for MemoryIndexingRepository {
        fn upsert_source_scan_state(&self, _source_id: &str, _status: &str) -> Result<(), String> {
            Ok(())
        }

        fn upsert_folder(&self, _folder: IndexedFolder) -> Result<(), String> {
            Ok(())
        }

        fn upsert_asset_metadata(&self, _asset: IndexedAssetMetadata) -> Result<(), String> {
            Ok(())
        }

        fn mark_asset_missing(
            &self,
            _source_id: &str,
            normalized_relative_path: &str,
        ) -> Result<(), String> {
            self.missing
                .lock()
                .map_err(|_| "missing lock poisoned".to_string())?
                .push(normalized_relative_path.to_string());
            Ok(())
        }

        fn mark_asset_probe_failed(
            &self,
            _source_id: &str,
            _normalized_relative_path: &str,
            _absolute_path: &str,
            _error: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        fn record_indexing_error(&self, _error: IndexingErrorRecord) -> Result<(), String> {
            Ok(())
        }

        fn record_activity(
            &self,
            _source_id: &str,
            _message: &str,
            _status: &str,
        ) -> Result<(), String> {
            Ok(())
        }

        fn source_settings_json(&self, _source_id: &str) -> Result<String, String> {
            Ok("{}".to_string())
        }

        fn list_known_asset_paths(&self, _source_id: &str) -> Result<Vec<KnownAssetPath>, String> {
            Ok(self.known.clone())
        }
    }

    #[test]
    fn missing_marking_can_be_scoped_to_reindexed_folder() {
        let repository = MemoryIndexingRepository {
            known: vec![
                KnownAssetPath {
                    normalized_relative_path: "impacts/hit.wav".to_string(),
                },
                KnownAssetPath {
                    normalized_relative_path: "ui/click.wav".to_string(),
                },
            ],
            missing: Mutex::new(Vec::new()),
        };
        let discovered = HashSet::from(["ui/click.wav".to_string()]);

        let count = mark_missing_assets(&repository, "source_1", &discovered, Some("ui")).unwrap();

        assert_eq!(count, 0);
        assert!(repository.missing.lock().unwrap().is_empty());
    }
}
