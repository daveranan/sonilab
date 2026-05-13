use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    canceled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn cancel(&self) {
        self.canceled.store(true, Ordering::Relaxed);
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::Relaxed)
    }
}

pub struct JobDeadline {
    started_at: Instant,
    timeout: Duration,
}

impl JobDeadline {
    pub fn new(timeout: Duration) -> Self {
        Self {
            started_at: Instant::now(),
            timeout,
        }
    }

    pub fn check(&self, token: &CancellationToken, label: &str) -> Result<(), String> {
        if token.is_canceled() {
            return Err(format!("{label} cancelled"));
        }
        if self.started_at.elapsed() > self.timeout {
            return Err(format!("{label} timed out"));
        }
        Ok(())
    }
}

#[derive(Clone)]
pub struct BoundedJobGate {
    name: &'static str,
    max_active: usize,
    active: Arc<Mutex<usize>>,
}

impl BoundedJobGate {
    pub fn new(name: &'static str, max_active: usize) -> Self {
        Self {
            name,
            max_active: max_active.max(1),
            active: Arc::new(Mutex::new(0)),
        }
    }

    pub fn try_enter(&self) -> Result<JobPermit, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| format!("{} queue lock poisoned", self.name))?;
        if *active >= self.max_active {
            return Err(format!("{} queue is full", self.name));
        }
        *active += 1;
        Ok(JobPermit { gate: self.clone() })
    }

    pub fn active_count(&self) -> usize {
        self.active.lock().map(|active| *active).unwrap_or_default()
    }

    pub fn max_active(&self) -> usize {
        self.max_active
    }

    fn leave(&self) {
        if let Ok(mut active) = self.active.lock() {
            *active = active.saturating_sub(1);
        }
    }
}

pub struct JobPermit {
    gate: BoundedJobGate,
}

impl Drop for JobPermit {
    fn drop(&mut self) {
        self.gate.leave();
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheEnforcementReport {
    pub limit_bytes: i64,
    pub before_bytes: i64,
    pub after_bytes: i64,
    pub removed_entries: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseIntegrityReport {
    pub ok: bool,
    pub integrity_messages: Vec<String>,
    pub foreign_key_violations: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartRecoveryReport {
    pub reset_export_jobs: usize,
    pub paused_sources: usize,
}

pub fn enforce_cache_limit(
    connection: &Connection,
    cache_root: &Path,
    limit_bytes: i64,
) -> Result<CacheEnforcementReport, String> {
    let limit_bytes = limit_bytes.max(0);
    let before_bytes = cache_total_bytes(connection)?;
    let mut after_bytes = before_bytes;
    let mut removed_entries = 0;

    let mut statement = connection
        .prepare(
            "SELECT id, path, byte_size
             FROM cache_entries
             WHERE pinned = 0
             ORDER BY last_accessed_at ASC, created_at ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    for (id, path, byte_size) in entries {
        if after_bytes <= limit_bytes {
            break;
        }
        delete_cache_file_if_owned(cache_root, Path::new(&path));
        connection
            .execute("DELETE FROM cache_entries WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        after_bytes = after_bytes.saturating_sub(byte_size.max(0));
        removed_entries += 1;
    }

    let mut waveform_statement = connection
        .prepare(
            "SELECT cache_key, path, byte_size
             FROM waveform_peak_files
             WHERE status = 'complete'
             ORDER BY last_accessed_at ASC, generated_at ASC",
        )
        .map_err(|error| error.to_string())?;
    {
        let rows = waveform_statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        let waveform_entries = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;

        for (cache_key, path, byte_size) in waveform_entries {
            if after_bytes <= limit_bytes {
                break;
            }
            delete_cache_file_if_owned(cache_root, Path::new(&path));
            connection
                .execute(
                    "DELETE FROM waveform_peak_files WHERE cache_key = ?1",
                    params![cache_key],
                )
                .map_err(|error| error.to_string())?;
            after_bytes = after_bytes.saturating_sub(byte_size.max(0));
            removed_entries += 1;
        }
    }

    Ok(CacheEnforcementReport {
        limit_bytes,
        before_bytes,
        after_bytes,
        removed_entries,
    })
}

pub fn recover_interrupted_jobs(connection: &Connection) -> Result<RestartRecoveryReport, String> {
    let reset_export_jobs = connection
        .execute(
            "UPDATE export_jobs
             SET status = 'queued',
                 progress = 0,
                 error_message = 'Recovered after app restart',
                 started_at = NULL,
                 finished_at = NULL
             WHERE status IN ('analyzing', 'processing', 'exporting')",
            [],
        )
        .map_err(|error| error.to_string())?;
    let paused_sources = connection
        .execute(
            "UPDATE sources
             SET status = 'paused', updated_at = CURRENT_TIMESTAMP
             WHERE kind = 'local' AND status = 'indexing'",
            [],
        )
        .map_err(|error| error.to_string())?;

    Ok(RestartRecoveryReport {
        reset_export_jobs,
        paused_sources,
    })
}

pub fn database_integrity_check(
    connection: &Connection,
) -> Result<DatabaseIntegrityReport, String> {
    let mut integrity_statement = connection
        .prepare("PRAGMA integrity_check")
        .map_err(|error| error.to_string())?;
    let integrity_rows = integrity_statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let integrity_messages = integrity_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut fk_statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| error.to_string())?;
    let fk_rows = fk_statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let foreign_key_violations = fk_rows.count();
    let ok =
        integrity_messages.iter().all(|message| message == "ok") && foreign_key_violations == 0;

    Ok(DatabaseIntegrityReport {
        ok,
        integrity_messages,
        foreign_key_violations,
    })
}

pub fn mark_unavailable_local_sources(connection: &Connection) -> Result<usize, String> {
    let mut statement = connection
        .prepare("SELECT id, root_uri FROM sources WHERE kind = 'local' AND status != 'disabled'")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    let sources = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut changed = 0;
    for (id, root_uri) in sources {
        if Path::new(&root_uri).is_dir() {
            continue;
        }
        changed += connection
            .execute(
                "UPDATE sources SET status = 'offline', updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(changed)
}

#[derive(Clone)]
pub struct CancellationRegistry {
    tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
}

impl CancellationRegistry {
    pub fn new() -> Self {
        Self {
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn register(&self, job_id: String, token: CancellationToken) -> Result<(), String> {
        self.tokens
            .lock()
            .map_err(|_| "cancellation registry lock poisoned".to_string())?
            .insert(job_id, token);
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        self.tokens
            .lock()
            .ok()
            .and_then(|tokens| tokens.get(job_id).cloned())
            .map(|token| {
                token.cancel();
                true
            })
            .unwrap_or(false)
    }

    pub fn remove(&self, job_id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(job_id);
        }
    }
}

fn cache_total_bytes(connection: &Connection) -> Result<i64, String> {
    let cache_entries = connection
        .query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM cache_entries",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    let waveform_entries = connection
        .query_row(
            "SELECT COALESCE(SUM(byte_size), 0) FROM waveform_peak_files",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or(0);
    Ok(cache_entries + waveform_entries)
}

fn delete_cache_file_if_owned(cache_root: &Path, path: &Path) {
    let Ok(root) = fs::canonicalize(cache_root) else {
        return;
    };
    let Ok(path) = fs::canonicalize(path) else {
        return;
    };
    if path.starts_with(root) && path.is_file() {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migrated_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open memory db");
        connection
            .execute_batch(include_str!("../migrations/001_core_data_layer.up.sql"))
            .expect("apply migration");
        connection
            .execute_batch(include_str!("../migrations/004_waveform_peak_files.up.sql"))
            .expect("apply waveform migration");
        connection
    }

    #[test]
    fn bounded_gate_rejects_when_full_and_reopens_after_drop() {
        let gate = BoundedJobGate::new("waveform", 1);
        let permit = gate.try_enter().expect("first permit");
        assert!(gate.try_enter().is_err());
        drop(permit);
        assert!(gate.try_enter().is_ok());
    }

    #[test]
    fn restart_recovery_requeues_interrupted_exports_and_pauses_indexing_sources() {
        let connection = migrated_connection();
        connection
            .execute(
                "INSERT INTO sources (id, kind, provider, display_name, root_uri, status)
                 VALUES ('source', 'local', 'local', 'Source', 'Z:/Missing', 'indexing')",
                [],
            )
            .expect("source");
        connection
            .execute(
                "INSERT INTO export_jobs (id, status, output_folder, filename_pattern, export_scope, format)
                 VALUES ('export', 'exporting', 'F:/Out', '{name}', 'full', 'wav')",
                [],
            )
            .expect("export");

        let report = recover_interrupted_jobs(&connection).expect("recover");

        assert_eq!(report.reset_export_jobs, 1);
        assert_eq!(report.paused_sources, 1);
    }

    #[test]
    fn cache_enforcement_removes_lru_unpinned_entries() {
        let connection = migrated_connection();
        let root = std::env::temp_dir().join(format!("sonilabs_cache_{}", std::process::id()));
        fs::create_dir_all(&root).expect("cache root");
        let old = root.join("old.cache");
        let pinned = root.join("pinned.cache");
        fs::write(&old, b"old").expect("old file");
        fs::write(&pinned, b"pinned").expect("pinned file");
        connection
            .execute(
                "INSERT INTO cache_entries (id, cache_key, kind, path, byte_size, pinned, last_accessed_at)
                 VALUES
                 ('old', 'old', 'preview', ?1, 80, 0, '2026-01-01'),
                 ('pinned', 'pinned', 'preview', ?2, 80, 1, '2026-01-02')",
                params![old.to_string_lossy(), pinned.to_string_lossy()],
            )
            .expect("cache rows");

        let report = enforce_cache_limit(&connection, &root, 80).expect("enforce");

        assert_eq!(report.removed_entries, 1);
        assert!(!old.exists());
        assert!(pinned.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cache_enforcement_removes_lru_waveform_files() {
        let connection = migrated_connection();
        let root =
            std::env::temp_dir().join(format!("sonilabs_cache_waveform_{}", std::process::id()));
        fs::create_dir_all(root.join("waveforms")).expect("create cache root");
        let waveform_file = root.join("waveforms").join("old.slwf");
        fs::write(&waveform_file, vec![1_u8; 128]).expect("write waveform file");
        connection
            .execute(
                "INSERT INTO sources (id, kind, provider, display_name, root_uri)
                 VALUES ('source', 'local', 'local', 'Source', ?1)",
                params![root.to_string_lossy().to_string()],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO assets (id, source_id, stable_key, path_or_url, name)
                 VALUES ('asset', 'source', 'asset-key', ?1, 'asset.wav')",
                params![root.join("asset.wav").to_string_lossy().to_string()],
            )
            .expect("insert asset");
        connection
            .execute(
                "INSERT INTO waveform_peak_files (
                    cache_key, asset_id, content_key, peak_version, channel_mode, resolution,
                    peak_count, channel_count, duration_seconds, sample_rate, path, byte_size,
                    status, generated_at, last_accessed_at
                 ) VALUES (
                    'waveform:test', 'asset', 'content', 1, 'source', 512,
                    2, 1, 1.0, 48000, ?1, 128, 'complete',
                    '2024-01-01', '2024-01-01'
                 )",
                params![waveform_file.to_string_lossy().to_string()],
            )
            .expect("insert waveform cache");

        let report = enforce_cache_limit(&connection, &root, 0).expect("enforce");

        assert_eq!(report.removed_entries, 1);
        assert!(!waveform_file.exists());
        let remaining: i64 = connection
            .query_row("SELECT COUNT(*) FROM waveform_peak_files", [], |row| {
                row.get(0)
            })
            .expect("count waveform rows");
        assert_eq!(remaining, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn database_integrity_reports_ok_for_migrated_schema() {
        let connection = migrated_connection();
        let report = database_integrity_check(&connection).expect("integrity");

        assert!(report.ok);
    }
}
