# Phase 5-6 Plan - Audio Preview and Waveform Selection

## Scope

This document covers Phase 5 Audio Preview Engine and Phase 6 Waveform and Region Selection. It intentionally does not define app shell UI changes. Implementation should plug into the existing table, player, inspector, and backend job layers when those phases are ready.

Primary goals:

- Click or keyboard-step through thousands of short sounds without UI stalls.
- Start cached previews in under 100 ms.
- Cancel stale decode/play/waveform work when selection changes.
- Support whole-file and selected-region looping.
- Render cached waveform peaks without putting audio data in React state.
- Keep selection state precise enough for analysis and export phases.

## Architecture Boundaries

Renderer responsibilities:

- Own `AudioContext` lifecycle after user gesture.
- Build and control the preview graph.
- Decode small preview buffers in cancellable jobs where Web Audio is needed.
- Schedule play, stop, seek, speed, gain, A/B, and loop behavior.
- Render waveform peaks to canvas or WebGL.
- Own transient waveform selection interaction state.

Backend responsibilities:

- Resolve playable local paths and cloud preview cache paths.
- Generate waveform peak files from local originals or cached previews.
- Store and return peak cache metadata by content key.
- Provide stable asset/content keys, file metadata, and cache paths.
- Enforce cache size limits and cleanup.

React responsibilities:

- Store only lightweight state: selected asset id, playback state, loop mode, region, zoom, and visible peak cache references.
- Never store `AudioBuffer`, peak arrays for large files, per-sample data, or per-row audio objects in component state.
- Subscribe to preview/waveform services through thin hooks.

## Phase 5 - Audio Preview Engine

### Web Audio Graph

Use one renderer-level `AudioContext` and one active source chain.

Graph:

```text
AudioBufferSourceNode
  -> playbackGain
  -> eqInput
  -> lowShelf
  -> midPeaking
  -> highShelf
  -> limiter or dynamics compressor
  -> meterTap
  -> masterGain
  -> destination
```

MVP graph can ship with gain, playback speed, volume, mute, A/B bypass, and meter tap. EQ and limiter nodes should be present behind disabled settings or injected later without changing the scheduling API.

Rules:

- Create a new `AudioBufferSourceNode` for each play because source nodes are one-shot.
- Keep graph nodes stable where possible: gain, EQ, meter, master output.
- Use `source.playbackRate.value` for playback speed.
- Use `GainNode.gain.setTargetAtTime` for click-free gain/volume changes.
- Do not use `HTMLAudioElement` for the primary preview path.

### Preview State Machine

States:

```text
idle -> resolving -> decoding -> ready -> playing -> paused
idle -> resolving -> failed
decoding -> cancelled
playing -> switching -> resolving
```

Every preview request gets a monotonically increasing `requestId` and an `AbortController`. Results are ignored unless their `requestId` still matches the active request.

Selection change behavior:

- Stop current source immediately with a short fade-out of 5-15 ms.
- Abort stale file resolve and decode work.
- Start cached buffer playback as soon as possible.
- If buffer is not cached, show pending playback state and play when decoded if the request is still current.

### Buffer Cache

Cache decoded buffers only for current and nearby selections.

Suggested policy:

- Key: `assetContentKey + previewProfile + channelMode`.
- Keep current asset, previous 2, next 4 by visible sort order.
- Hard cap by decoded PCM memory, default 256 MB.
- Prefer eviction of oldest non-playing buffer.
- Never cache failed decode results permanently; use short failure TTL to avoid retry storms.

Decoded PCM size estimate:

```text
durationSeconds * sampleRate * channelCount * 4 bytes
```

Cache entries:

- `assetId`
- `contentKey`
- `duration`
- `sampleRate`
- `channelCount`
- `byteEstimate`
- `lastAccessedAt`
- `buffer`

### Cancellation

Cancellable steps:

- Backend playable path resolution.
- Cloud preview download/cache lookup.
- `fetch` of local file URL or Tauri asset stream.
- Decode job wrapper.
- Neighbor prefetch.
- Waveform peak request.

`decodeAudioData` itself is not reliably abortable once started, so cancellation means:

- Abort before decode whenever possible.
- Ignore decode result if request is stale.
- Limit concurrent decodes to 1 foreground and 1 prefetch.
- Never queue unbounded decodes during arrow-key browsing.

### Loop Scheduling

Loop modes:

- `off`
- `file`
- `region`

For full-file loop, use `AudioBufferSourceNode.loop = true`, `loopStart = 0`, `loopEnd = duration`.

For selected-region loop:

- Clamp region to valid buffer duration.
- Require minimum region length of 20 ms.
- Set `source.loop = true`, `loopStart = region.startSeconds`, `loopEnd = region.endSeconds`.
- Start at `region.startSeconds` unless user is seeking inside the region.

For rapid loop edits while playing:

- If only loop points changed and current source supports the new range, update loop points.
- If playhead is outside the new region, reschedule source with a short crossfade.

### Meters

Use an `AudioWorkletNode` for production meters once the preview graph is stable. MVP can use `AnalyserNode` for peak visualization, but tests should treat it as a temporary implementation.

Meter outputs:

- Current left/right peak dBFS.
- Peak hold.
- Clip flag if processed samples reach or exceed 0 dBFS.

Meters are live preview indicators only. They do not replace offline analysis from Phase 7.

### A/B Processing

Use one processing settings object:

- `mode: original | processed`
- `gainDb`
- `eqEnabled`
- `eqBands`
- `limiterEnabled`
- `normalizePreviewEnabled`

A/B switch should bypass processing nodes without changing selected asset, region, playhead, waveform zoom, or export settings.

### Failure Handling

Failures should be scoped to the selected asset:

- file missing
- decode failed
- unsupported format
- cloud preview unavailable
- audio context suspended

On failure, stop playback, clear active source, keep selection, show a recoverable status, and allow next/previous preview.

## Phase 6 - Waveform and Region Selection

### Peak Cache

Waveform peaks are generated by backend jobs and cached by content key.

Cache key:

```text
assetContentKey + peakVersion + channelMode + samplesPerPeak
```

Recommended peak formats:

- Overview peaks: min/max pairs per channel, enough for full-width display.
- Multi-resolution peaks: 256, 1024, 4096, and 16384 samples per peak for zoom.
- Store as binary little-endian `float32` or compact `int16` normalized peaks.

Database row:

- `asset_id`
- `content_key`
- `peak_version`
- `channel_mode`
- `samples_per_peak`
- `peak_file_path`
- `duration_seconds`
- `sample_rate`
- `channel_count`
- `created_at`

### Peak Generation

Backend job behavior:

- Start with a quick overview peak after metadata probe.
- Generate higher resolution peaks on demand or during idle time.
- Support cancellation when selected asset changes.
- Reuse decode/probe infrastructure from indexing where possible.
- Mark corrupt or unsupported files without retry loops.
- Backend waveform generation uses native WAV parsing plus decoder sidecars for MP3, OGG/OGV/OPUS, FLAC, AAC/M4A/MP4, AIFF, and other FFmpeg-backed media containers.

Generation order:

1. Check cache by content key.
2. If missing, enqueue high-priority peak job for selected asset.
3. Return pending state to renderer.
4. Stream or load peak file when complete.

### Rendering

Use canvas first; WebGL is optional if canvas cannot hit performance targets.

Renderer rules:

- Use one waveform renderer instance per bottom player, not per row.
- Draw from typed arrays or transferable peak buffers.
- Keep peak data outside React state.
- Use `requestAnimationFrame` for playhead and drag updates.
- Redraw only dirty regions where practical.
- Use device pixel ratio scaling.

Visual layers:

1. Background.
2. Waveform peaks.
3. Processed/clipping overlay if available.
4. Selected region fill.
5. Segment markers.
6. Playhead.
7. Hover/drag cursor.
8. Time/channel/status readout.

### Waveform Readout

The waveform readout should match a professional sample-browser layout and stay visible without opening the file summary panel.

Required readout values:

- full file length at the waveform edge or just below it
- current cursor/hover time while moving over the waveform
- current playhead time
- selected region start and end
- selected region duration
- sample rate and bit depth
- channel count or active channel label

The readout updates from pointer/playhead/region state without storing waveform sample data in React state.

### Selection Model

Store selection as seconds, not pixels.

Model:

```text
assetId
startSeconds
endSeconds
anchorSeconds
activeEdge: start | end | move | none
source: pointer | keyboard | restored
updatedAt
```

Rules:

- `startSeconds` is always less than `endSeconds`.
- Clamp to `[0, duration]`.
- Minimum meaningful region: 20 ms.
- Click without drag clears region unless a region tool mode says otherwise.
- Drag creates region.
- Drag edges resize region.
- Drag body moves region.
- Double-click waveform selects full file.

Selection is transient UI state until used by analysis, loop, export, or collection activity. Persist last selected region per asset only if the user explicitly creates a segment marker or export job.

### Drag Region as File

Dragging an existing selected region out of the waveform is an export gesture, not an internal UI move.

Behavior:

- Use the currently selected export format from the bottom-right export control.
- Use the current gain/processing chain.
- Render a temporary file for the exact selected region boundaries.
- Start an OS file drag with that temporary file path so it can be dropped into Explorer, DAWs, editors, and other apps.
- Visually indicate that the app is preparing or holding a real exported file; the normal app UI may be de-emphasized during this gesture.
- If rendering fails or FFmpeg is unavailable, show a scoped export-drag failure and keep selection/playback state intact.
- Do not use text selection or arbitrary DOM drag payloads for waveform region export.

### Zoom and Pan

State:

- `visibleStartSeconds`
- `visibleEndSeconds`
- `pixelsPerSecond`
- `fitToView`

Controls:

- Mouse wheel or trackpad zoom around cursor.
- Shift+wheel or horizontal wheel pans.
- Drag scrollbar/overview for long sounds.
- Reset zoom fits full file.

For short files under 1 second, enforce a minimum rendered width so selection is usable.

### Playhead

Playhead source of truth:

- While playing: derive from `audioContext.currentTime`, scheduled start time, playback rate, and source offset.
- While paused/stopped: use stored `playheadSeconds`.

The playhead should update with `requestAnimationFrame`, not React interval state.

### Region Looping

Waveform region and audio loop use the same normalized region model.

When loop mode is `region`:

- Creating a region immediately updates loop points.
- Clearing the region falls back to full-file loop or loop off based on user setting.
- Export panel receives the same selected region.

### Segment Markers

Segment markers are named saved regions.

MVP fields:

- `id`
- `assetId`
- `name`
- `startSeconds`
- `endSeconds`
- `createdAt`

Markers render as compact handles over the waveform and can be used later by export and activity history.

## Shared Type Contracts

Use shared TypeScript types for frontend services even before UI work starts. Keep backend command payloads JSON-safe.

Recommended contracts:

- `PreviewRequest`
- `PreviewState`
- `LoopMode`
- `ProcessingSettings`
- `WaveformPeakDescriptor`
- `WaveformSelection`
- `WaveformViewport`
- `AudioPreviewBenchmarkResult`

Backend command payloads should use numbers, strings, booleans, arrays, and plain objects only. Do not expose browser objects, `AudioBuffer`, typed arrays, or class instances across the Tauri command boundary.

## Tests

Unit tests:

- dB to gain conversion and gain to dB conversion.
- Region clamp and normalization.
- Loop point validation.
- Cache eviction by byte cap and LRU order.
- Stale preview request ignored after cancellation.
- Playhead time calculation with offset and playback rate.
- Zoom math around cursor.

Integration tests:

- Select asset A, immediately select asset B, verify A never starts after B.
- Rapid next/previous requests do not leave multiple active sources.
- Cached preview starts without backend decode request.
- Region loop uses exact selected start/end seconds.
- Waveform peak cache hit avoids new generation job.
- Missing/corrupt file failure does not break next preview.

Renderer tests:

- Waveform selection creates expected seconds from pixel drag.
- Edge resize preserves min region length.
- Zoom and pan keep viewport clamped.
- Playhead updates outside React render loop.

## Benchmarks

Preview benchmarks:

- Cached preview switch: target under 100 ms from selection event to audible start.
- Uncached local WAV preview: record p50/p95 decode and start latency.
- Rapid browsing soak: 5,000 selection changes over 10 minutes with no unbounded memory growth.
- Decode queue pressure: verify max concurrent foreground/prefetch decodes.

Waveform benchmarks:

- Peak cache hit render: target under 16 ms for full redraw at 1920 px.
- Peak generation for 1,000 short WAV files.
- Zoom/pan interaction: no frame over 16 ms on common viewport sizes.
- Large file waveform: verify multi-resolution peaks avoid loading full-resolution data.

Memory benchmarks:

- Decoded buffer cache respects configured byte cap.
- Waveform typed array cache respects configured byte cap.
- Rapid selection returns near baseline memory after eviction.

## Acceptance Criteria

Phase 5 is done when:

- One active Web Audio preview graph exists.
- Clicking or keyboard-selecting assets starts preview through the graph.
- Stale preview work is cancelled or ignored.
- Cached preview switching hits the 100 ms target in benchmark.
- Full-file and selected-region loop scheduling are implemented.
- Output volume, mute, speed, gain, and A/B bypass are represented in the graph API.

Phase 6 is done when:

- Backend peak generation and cache lookup are defined and callable.
- Waveform renderer consumes cached peaks without storing sample data in React state.
- Region selection, edge resize, move, clear, zoom, pan, and playhead are implemented.
- Region state is shared by loop, analysis, and export APIs.
- Tests cover selection math, cache behavior, cancellation, and stale work.
- Benchmarks cover preview switching, waveform rendering, and memory ceilings.
