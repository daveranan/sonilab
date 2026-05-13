use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexingProgressPayload {
    pub job_id: String,
    pub source_id: String,
    pub root_path: String,
    pub status: String,
    pub phase: String,
    pub folders_seen: u64,
    pub files_seen: u64,
    pub audio_candidates: u64,
    pub files_indexed: u64,
    pub files_skipped: u64,
    pub files_failed: u64,
    pub missing_marked: u64,
    pub current_path: Option<String>,
    pub message: Option<String>,
    pub started_at: String,
    pub updated_at: String,
}

pub trait ProgressSink: Send + Sync + 'static {
    fn emit_progress(&self, payload: IndexingProgressPayload);
}

pub struct ThrottledProgress<P: ProgressSink> {
    sink: P,
    last_emit: Mutex<Option<Instant>>,
    interval: Duration,
}

impl<P: ProgressSink> ThrottledProgress<P> {
    pub fn new(sink: P) -> Self {
        Self {
            sink,
            last_emit: Mutex::new(None),
            interval: Duration::from_millis(100),
        }
    }

    pub fn emit(&self, payload: IndexingProgressPayload) {
        self.emit_inner(payload, false);
    }

    pub fn emit_final(&self, payload: IndexingProgressPayload) {
        self.emit_inner(payload, true);
    }

    fn emit_inner(&self, payload: IndexingProgressPayload, force: bool) {
        let mut last_emit = match self.last_emit.lock() {
            Ok(last_emit) => last_emit,
            Err(_) => return,
        };
        let should_emit = force
            || last_emit
                .map(|last| last.elapsed() >= self.interval)
                .unwrap_or(true);
        if should_emit {
            self.sink.emit_progress(payload);
            *last_emit = Some(Instant::now());
        }
    }
}

pub fn now_stamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("unix-ms:{millis}")
}
