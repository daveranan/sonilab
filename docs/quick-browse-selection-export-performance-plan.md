# Quick Browse, Selection, and Export Performance Plan

## Goal

Make Sonilabs feel like a sample browser first: add a folder, see thousands of files immediately, arrow/click through sounds with near-instant playback, see waveforms without UI stalls, select files or waveform regions, then drag real exported files out of the app.

The hard constraint is that a cold 70 MB file cannot produce an accurate waveform in ~3 ms. The target is ~3 ms UI waveform display on cache hit, immediate placeholder/overview on cache miss, and background generation that never blocks browsing or playback.

## Current State Observed

The repo already has useful pieces:

- `src-tauri/src/indexing/*` separates scanning, format probing, metadata, jobs, progress, and watcher behavior.
- `src-tauri/src/audio.rs` resolves previews, generates WAV waveform peaks, caches peak JSON in SQLite, and now tries a sparse large-WAV path.
- `src/features/audio-preview/previewService.ts` can stream local originals through `HTMLAudioElement` and falls back to decoded Web Audio buffers for non-streaming cases.
- `src/features/audio-preview/WaveformCanvas.tsx` renders one selected waveform, handles region selection, and defers waveform loading for very large files.
- `src-tauri/src/export.rs` supports queued exports plus temp region/asset drag-file preparation.
- `src/features/audio-preview/commands.ts` already wraps `prepareRegionDragFile`, `prepareAssetDragFile`, multi-file drag preparation, and native/plugin drag start.

The main performance problem is architectural: import/indexing, waveform generation, preview decode, and export preparation are still too easy to couple to user-visible selection. Anything expensive must move behind prioritized queues and persistent cache files.

## Non-Negotiable Targets

- Import view: first rows visible within 1 second for a local SSD folder, even if full metadata is still running.
- Browse selection: row selection must never wait on waveform generation, decoding, or export work.
- Playback: local original playback should start through media streaming, not full-file `decodeAudioData`, with p95 audible start under 50 ms after warm path resolution.
- Waveform cache hit: visible waveform data returned to renderer in ~3 ms for common viewport-sized overview data.
- Waveform cold miss: show placeholder immediately, enqueue work, render the first available overview without blocking the UI.
- CPU: background waveform/export work defaults to low priority and no more than one heavy decode/generation task at a time.
- Drag export: whole-file drag should be instant when no conversion/processing is needed; region/format conversion can prepare temp files but must expose pending state and cache the result.

## Architecture

### 1. Split Import Into Tiers

Tier 0 is folder discovery only. It walks filenames, sizes, modified times, extensions, and relative paths. It commits rows in small batches so the UI can browse immediately.

Tier 1 is cheap metadata. It reads headers for duration, sample rate, channels, bit depth, and format. It must not decode audio or generate waveforms.

Tier 2 is demand-driven analysis. It generates waveform peaks, loudness, clipping, thumbnails, or processed previews only when visible, selected, played, dragged, or when the app is idle.

This means adding a folder with 6,000 files should not feel like indexing 6,000 decoded audio files. It should feel like listing files first, then progressively enriching them.

### 2. Replace JSON Peaks With Binary Multi-Resolution Peak Files

SQLite should store descriptors, not large peak arrays. Peak data should live in compact binary files under the app cache.

Recommended formats:

- `overview`: enough points for the full waveform at current UI width, usually 512-4096 min/max pairs.
- `mid`: 1024 or 2048 samples per peak for normal zoom.
- `detail`: 256 samples per peak or generated on demand for close zoom.

Use normalized `i16` min/max pairs per channel, little-endian. This is much smaller and faster to read than JSON floats.

Cache key:

```text
content_key + peak_version + channel_mode + resolution
```

Content key should include at least path, size, modified time, and format metadata. A stronger hash can be optional and lazy; hashing every file on import is too expensive.

### 3. Generate Peaks Lazily With Priority

Waveform jobs need a priority queue:

1. Selected asset overview.
2. Visible rows if row waveforms are shown.
3. Neighbor assets around current selection.
4. Idle background fill for recently browsed folders.

Jobs must be cancellable before heavy work starts. Once a decode starts, stale results can be ignored, but the queue must avoid piling up obsolete work while the user arrows through files.

Do not keep the current sparse large-WAV algorithm as the final solution. It is fast but approximate and can miss transients. Use it only as a temporary preview tier if clearly labeled as a coarse overview.

### 4. Keep Playback Independent From Waveforms

Playback should not wait for waveform availability.

Use `HTMLAudioElement` / media streaming for original local files. It avoids decoding 70 MB into JS memory before playback. Keep Web Audio decode buffers only for short hot assets, processed preview, channel-isolated playback, or features that truly require sample access.

Playback cache should store:

- resolved local URL/path
- metadata
- currently playing media element state
- small decoded buffers for adjacent short files only

Avoid calling `readPreviewFileBytes` for large local files during normal preview, because it pulls whole files across the Tauri boundary.

### 5. Renderer Must Read Only Viewport-Sized Peak Data

The renderer should request a descriptor and a small binary range, not all peak levels for all resolutions.

Command shape:

```ts
get_waveform_descriptor(assetId, contentKey)
read_waveform_peaks(cacheKey, resolution, startPeak, peakCount)
enqueue_waveform_generation(assetId, contentKey, priority)
```

For full-file display at 1920 px, the backend should return roughly 1920-4096 min/max columns, not millions of samples. The canvas should draw from a typed array outside React state.

### 6. Add A Real Work Scheduler

Create one backend scheduler for expensive local work:

- preview path resolution: high priority, tiny work
- selected waveform overview: high priority, cancellable
- export temp render: high priority after drag gesture
- metadata/background peaks: low priority
- idle warmup: lowest priority

Default concurrency:

- metadata probes: 2-4 workers
- waveform decode/generation: 1 worker
- export render: 1-2 workers, but never enough to starve playback

The scheduler should expose queue depth and active job info for diagnostics.

## Export And Drag Behavior

### Whole-File Drag

If the requested format matches the source and no processing/region is applied, drag the original file path directly. This should be effectively instant and should not create a temp copy.

If conversion, processing, or renaming is required, prepare a temp file and cache it by:

```text
asset content key + region + format settings + processing hash
```

### Multi-Row Drag

Selection should pass an ordered list of asset IDs to a drag preparation command.

Fast path:

- all selected files are local
- export format is "source/original"
- no gain/processing
- no region scope

Return original paths directly and start native file drag.

Slow path:

- queue temp renders
- stream progress to UI
- start drag only when files exist
- cache prepared files for repeated drags

### Waveform Region Drag

Region drag always represents an exported file, not text or a DOM drag payload.

Flow:

1. User selects region.
2. User chooses target format.
3. Pointer drag starts from selected waveform region.
4. Frontend calls `prepare_region_drag_file`.
5. Backend renders or reuses cached temp file.
6. Frontend starts native file drag with real file path.

For WAV source to WAV region with gain 0 dB, use native slicing instead of FFmpeg where possible. For encoded formats or conversion, use FFmpeg sidecar.

## Database And Cache Changes

Add or migrate toward these fields/tables:

```sql
waveform_peak_files(
  cache_key TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  content_key TEXT NOT NULL,
  peak_version INTEGER NOT NULL,
  channel_mode TEXT NOT NULL,
  resolution INTEGER NOT NULL,
  peak_count INTEGER NOT NULL,
  channel_count INTEGER NOT NULL,
  duration_seconds REAL,
  sample_rate INTEGER,
  path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL,
  generated_at TEXT,
  last_accessed_at TEXT NOT NULL
)
```

`cache_entries` can continue to track eviction, but waveform rows need enough metadata to serve descriptors without reading peak files.

## Implementation Plan

### Phase A: Stop Blocking Browse And Playback

- Ensure local original preview always uses streaming URL for normal playback.
- Remove large-file `readPreviewFileBytes` paths from normal preview.
- Add selection cancellation so stale waveform requests cannot update the active view.
- Add benchmarks for cold selection, warm selection, and rapid arrow browsing.

### Phase B: Binary Waveform Cache

- Add binary peak file writer/reader in Rust.
- Store descriptors in SQLite and peak payloads on disk.
- Keep the existing JSON peak command only as a compatibility path during migration.
- Add cache hit benchmark for reading and drawing a 70 MB file's existing overview peaks.

### Phase C: Demand-Driven Peak Queue

- Add priority queue with selected, visible, neighbor, and idle priorities.
- Make selected overview generation preempt lower-priority background work.
- Add cancellation/coalescing by `content_key + resolution`.
- Add idle generation only after the UI has been quiet for a short window.

### Phase D: Fast Drag Export

- Add original-file passthrough for whole-file drag.
- Add batch drag command that returns original paths when possible.
- Add temp render cache for converted files and regions.
- Keep region drag exact and format-aware.

### Phase E: Instrumentation

- Track time to first row, time to playback start, waveform descriptor read time, peak generation time, export temp preparation time, queue depth, and CPU-active windows.
- Write benchmark results into `benchmark-results/quick-browse-selection-export.json`.
- Add regression tests that fail if browse selection waits on waveform/export work.

## Acceptance Criteria

- Adding 6,000 local files shows browseable rows before waveform generation completes.
- Selecting a file can start playback before waveform generation completes.
- Warm waveform overview for a 70 MB file is loaded from cache and handed to the renderer in ~3 ms backend time.
- Cold waveform generation never blocks the UI thread and never starts more than one heavy generation task by default.
- Re-selecting a previously viewed file reuses cached peak files without decoding the original again.
- Dragging one or multiple unprocessed local rows out of the app uses original paths directly.
- Dragging a selected waveform region creates a real temp file in the selected export format and starts native OS file drag.
- Rapid browsing through hundreds of files does not grow memory unbounded and does not queue stale waveform jobs.
