use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};

use super::scanner::normalize_relative_path;

pub struct FolderWatcher {
    _watcher: RecommendedWatcher,
    stop: Sender<()>,
}

impl Drop for FolderWatcher {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

pub fn start_debounced_watcher<F>(root_path: PathBuf, on_rescan: F) -> Result<FolderWatcher, String>
where
    F: Fn(Option<String>) + Send + 'static,
{
    let (event_tx, event_rx) = channel::<notify::Result<notify::Event>>();
    let (stop_tx, stop_rx) = channel();
    let mut watcher = RecommendedWatcher::new(
        move |event| {
            let _ = event_tx.send(event);
        },
        Config::default(),
    )
    .map_err(|error| error.to_string())?;

    watcher
        .watch(&root_path, RecursiveMode::Recursive)
        .map_err(|error| error.to_string())?;

    thread::spawn(move || {
        let debounce = Duration::from_millis(500);
        let large_drop_debounce = Duration::from_secs(2);
        let mut pending = Vec::<PathBuf>::new();
        let mut last_event = Instant::now();

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match event_rx.recv_timeout(debounce) {
                Ok(Ok(event)) => {
                    pending.extend(event.paths);
                    last_event = Instant::now();
                }
                Ok(Err(_)) => {
                    pending.push(root_path.clone());
                    last_event = Instant::now();
                }
                Err(RecvTimeoutError::Timeout) => {
                    if pending.is_empty() {
                        continue;
                    }
                    let wait = if pending.len() > 100 {
                        large_drop_debounce
                    } else {
                        debounce
                    };
                    if last_event.elapsed() >= wait {
                        let relative = coalesced_relative_path(&root_path, &pending);
                        pending.clear();
                        on_rescan(relative);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    Ok(FolderWatcher {
        _watcher: watcher,
        stop: stop_tx,
    })
}

fn coalesced_relative_path(root_path: &Path, paths: &[PathBuf]) -> Option<String> {
    if paths.len() != 1 {
        return None;
    }
    let path = paths.first()?;
    let scan_path = if path.is_file() {
        path.parent().unwrap_or(root_path)
    } else {
        path.as_path()
    };
    Some(normalize_relative_path(root_path, scan_path))
}
