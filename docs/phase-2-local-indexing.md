# Phase 2 - Local Library Indexing

## Goal

Build a production indexing subsystem for local audio folders that can scan very large libraries incrementally, keep the app responsive, and preserve user state when files move, disappear, or fail metadata probing.

This phase should not implement frontend UI or final database schema directly. It defines backend behavior, event contracts, and acceptance criteria so the data-layer and UI phases can integrate without guessing.

## Scope

In scope:

- Recursive local folder scanning.
- Audio format detection.
- Basic metadata extraction.
- Cancellable indexing jobs.
- Bounded indexing queue.
- Folder watch behavior.
- Missing-file state handling.
- Reindex behavior.
- Progress event contract.
- Benchmark plan for 10k, 50k, and 100k short files.

Out of scope:

- Drag-drop UI.
- Final SQLite migrations.
- Search indexing.
- Waveform generation.
- Loudness analysis.
- Export pipeline.
- Cloud libraries.

## Supported Input Formats

Phase 2 must detect these formats by extension and verify with file signatures or decoder probing before committing metadata:

- WAV
- MP3
- OGG
- FLAC
- AAC
- M4A
- AIFF
- AIF

Extension detection is only a fast prefilter. Final format should come from a probe result whenever possible, because sample libraries often contain mislabeled files.

## Scanner

The scanner walks a registered local root folder recursively and emits candidate file paths to a bounded metadata queue.

Scanner requirements:

- Use an iterative directory walk to avoid stack pressure on deep folder trees.
- Skip hidden/system folders by default, with a future setting to include them.
- Skip known non-audio folders such as app caches and generated waveform caches.
- Follow no symlinks by default to avoid cycles.
- Produce stable relative paths from the source root.
- Normalize Windows paths for comparison while preserving display paths.
- Continue scanning when individual folders fail due to permissions.
- Record folder-level errors without failing the whole source.

The scanner should separate discovery from probing. Discovery should be fast and cheap; probing should run through a bounded worker pool.

## Format Detection

Detection stages:

1. Extension prefilter.
2. Lightweight header sniff.
3. Decoder or metadata probe.

Expected result fields:

- `format`
- `extension`
- `container`
- `codec`
- `is_supported`
- `probe_error`

Unsupported audio-like files should be recorded as skipped candidates only if debug logging is enabled. They should not appear in the main asset list.

## Metadata Extraction

Extract basic metadata during indexing:

- Display name.
- Absolute path.
- Source-relative path.
- File size.
- Modified time.
- Format.
- Duration.
- Sample rate.
- Bit depth where available.
- Channel count.

Do not compute waveform peaks, RMS, LUFS, true peak, or clipping counts in this phase. Those belong to later analysis phases.

Metadata failures should create a recoverable failed-probe state with error details. A corrupt file must not stop the source job.

## Job Model

Indexing runs as backend jobs.

Job types:

- `index_source`
- `index_folder`
- `reindex_source`
- `reindex_folder`
- `watch_event_rescan`

Job fields:

- `job_id`
- `source_id`
- `root_path`
- `relative_path`
- `mode`
- `created_at`
- `started_at`
- `finished_at`
- `status`
- `cancellation_token`

Job statuses:

- `queued`
- `running`
- `canceling`
- `canceled`
- `completed`
- `completed_with_errors`
- `failed`

The app should allow only one active indexing job per source. Reindex requests for the same source should coalesce unless the user explicitly starts a full rebuild after the current job completes.

## Cancellation

Cancellation must be cooperative and checked at these points:

- Before entering a directory.
- Before enqueueing a file probe.
- Before starting metadata extraction.
- Before committing a batch.
- Before emitting completion events.

Canceled jobs should preserve already committed metadata and mark the source as partially indexed.

## Bounded Queue

Use separate bounded queues for:

- Directory discovery.
- Metadata probing.
- Persistence batches.
- Progress events.

Backpressure matters more than raw throughput. The scanner must not enqueue millions of paths into memory.

Recommended defaults:

- Discovery buffer: 1,000 paths.
- Probe workers: CPU count clamped to 2-8.
- Persistence batch size: 100-500 assets.
- Progress event interval: at most 10 per second per job.

## Persistence Contract

Phase 2 does not own final database files, but it should integrate with a repository interface shaped around these operations:

- `upsert_source_scan_state`
- `upsert_folder`
- `upsert_asset_metadata`
- `mark_asset_missing`
- `mark_asset_probe_failed`
- `record_indexing_error`
- `record_activity`

Asset identity should be stable across reindexes using:

- Source ID.
- Normalized relative path.
- File size.
- Modified time.

Content hashes are optional later. Do not hash every file during Phase 2 because it will hurt first-index performance.

## Missing File States

Missing files must not be deleted immediately.

Asset availability states:

- `available`
- `missing`
- `moved_candidate`
- `probe_failed`
- `unsupported`

When a previously indexed file is no longer found:

1. Mark it `missing`.
2. Keep metadata, collections, activity, and analysis references.
3. Show the last known path to future UI.
4. Restore to `available` if the same relative path returns.

Move detection can be shallow in Phase 2. If a file with the same name, size, and modified time appears elsewhere under the same source, mark the old row as `moved_candidate` and let later UI/database work decide whether to merge.

## Folder Watch

Use native file watching through the Rust backend.

Watch events to support:

- Create.
- Modify.
- Delete.
- Rename/move.
- Folder create/delete.

Watcher requirements:

- Debounce noisy event bursts.
- Coalesce multiple events for the same path.
- Fall back to folder rescan when event detail is unreliable.
- Mark watcher offline if the source drive disappears.
- Resume watching when the source becomes available again.

Recommended debounce:

- 500 ms for file edits.
- 2 seconds for large folder drops.
- 5 seconds for unstable removable/network drives.

## Reindex

Reindex modes:

- `quick`: scan paths and modified times only.
- `metadata`: reprobe changed files.
- `full`: treat every supported file as needing metadata reprobe.

A user-triggered reindex should be cancellable. A watch-triggered rescan should be low priority and should not interrupt active preview/export work.

## Progress Events

Backend should emit progress events through Tauri.

Event name:

```text
indexing://progress
```

Payload:

```json
{
  "job_id": "string",
  "source_id": "string",
  "root_path": "string",
  "status": "running",
  "phase": "scanning",
  "folders_seen": 0,
  "files_seen": 0,
  "audio_candidates": 0,
  "files_indexed": 0,
  "files_skipped": 0,
  "files_failed": 0,
  "missing_marked": 0,
  "current_path": "string",
  "message": "string",
  "started_at": "ISO-8601",
  "updated_at": "ISO-8601"
}
```

Phases:

- `queued`
- `scanning`
- `probing`
- `persisting`
- `watching`
- `canceling`
- `completed`
- `failed`

Progress events should be throttled. The final event must always be emitted unless the process crashes.

## Error Handling

Expected recoverable errors:

- Permission denied.
- Path too long.
- File disappeared during scan.
- Decode/probe failed.
- Source drive unavailable.
- Watcher dropped events.
- Unsupported or corrupt audio.

Every recoverable error should be attached to either a source, folder, or asset path. Only unrecoverable runtime setup failures should fail the whole job.

## Benchmarks

Create benchmark fixtures or synthetic folder generators for:

- 10k short files.
- 50k short files.
- 100k short files.

Measure:

- Total scan time.
- Time to first visible indexed result.
- Peak memory.
- Files probed per second.
- Persistence batch latency.
- Progress event frequency.
- Cancellation latency.
- Reindex unchanged-source time.
- Watch event recovery time after a large folder drop.

Targets:

- First indexed results visible within 2 seconds for a warm local SSD scan.
- Cancellation acknowledged within 500 ms under normal load.
- No unbounded memory growth during 100k-file discovery.
- UI event stream stays below 10 progress events per second per job.

## Rust Skeleton Boundary

Recommended future module split under `src-tauri/src/indexing/`:

```text
indexing/
  mod.rs
  scanner.rs
  formats.rs
  metadata.rs
  jobs.rs
  progress.rs
  watcher.rs
  benchmarks.rs
```

Do not add database-specific code here. The indexing module should depend on repository traits, not concrete migrations or table details.

Recommended public API shape:

```rust
pub struct IndexingRuntime;

impl IndexingRuntime {
    pub fn start_job(&self, request: IndexingJobRequest) -> IndexingJobId;
    pub fn cancel_job(&self, job_id: IndexingJobId) -> CancellationResult;
    pub fn subscribe_progress(&self) -> ProgressStream;
}
```

## Acceptance Criteria

Phase 2 is complete when:

- Local folders can be scanned recursively without blocking the app.
- Supported audio files are detected and probed.
- Basic metadata is extracted for valid files.
- Corrupt, missing, unsupported, and permission-blocked files are handled without crashing.
- Indexing jobs are cancellable.
- Reindex modes are defined and wired to backend jobs.
- Folder watch events trigger debounced rescans.
- Progress events are emitted and throttled.
- Benchmarks exist for 10k, 50k, and 100k short files.
- No frontend UI or final database schema assumptions are required by the indexing implementation.
