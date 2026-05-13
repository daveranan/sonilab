# Phase 7/8 - Level Analysis and Processing Controls

## Scope

Implement the basic level analysis, bottom-player gain controls, collapsible file summary, and contracts that make gain, preview, and export job snapshots behave consistently.

## Goals

- Measure original and processed peak/RMS levels for the full file.
- Cache analysis by source audio identity, processing chain, analysis algorithm, and precision.
- Use one processing contract for preview and export so audible preview matches rendered files.
- Keep analysis and processing cancellable, resumable, and off the renderer thread.
- Treat selected regions as export trim ranges only; do not add selected-region analysis.

## Non-Goals

- No destructive editing of source files.
- No DAW-style timeline or multitrack processing.
- No mastering-grade metering UI in this phase.
- No selected-region level analysis.
- No LUFS or true-peak implementation in MVP.
- No EQ, normalize, limiter, preset, or export encoding implementation in this phase.
- No permanently visible right inspector; file summary is user-toggleable.

## Level Metrics

### Peak dBFS

Peak dBFS is the highest absolute sample value after decoding and channel conversion for the measured scope.

Requirements:

- Report per-channel peak and combined max peak.
- Use decoded PCM before export encoding.
- Detect clipping when samples are at or above full scale after processing.
- Treat silent audio as `-Infinity dBFS`, not `0`.

### RMS dBFS

RMS dBFS is the root mean square level over the measured scope.

Requirements:

- Report combined RMS and optional per-channel RMS.
- Treat silent audio as `-Infinity dBFS`.
- Store sample count used for the calculation.

### Deferred Metrics

LUFS, short-term loudness, true peak dBTP, and selected-region level stats are post-MVP. Do not implement them unless the scope changes.

## Analysis Scopes

### Full File

Full-file analysis covers the entire decoded asset.

Identity inputs:

- asset id
- source id
- content key
- duration
- sample rate
- channel layout
- file size
- modified time or provider revision

### Selected Region

Selected regions are export trim ranges only. Export may render `[startSeconds, endSeconds)` with the same processing chain, but Phase 7 does not compute separate stats for that range.

### Original vs Processed

Original analysis uses the decoded source audio with no app processing.

Processed analysis applies the same chain used by preview and export:

1. input gain
2. output format preflight, excluding encoder artifacts unless explicitly verifying an exported file in Phase 9

Processed stats must be labeled as pre-encode unless they were measured from the exported artifact.

## Cache Keys

Analysis cache keys must prevent stale stats when the file, processing settings, or algorithms change.

Recommended key shape:

```text
analysis:v1:{assetContentKey}:{scopeKey}:{processingHash}:{analysisProfileHash}
```

### Asset Content Key

Local files:

```text
local:{sourceId}:{normalizedPathHash}:{fileSize}:{modifiedTimeUtc}:{optionalContentHash}
```

Cloud assets:

```text
cloud:{provider}:{sourceId}:{providerAssetId}:{providerRevisionOrUpdatedAt}:{previewOrOriginal}
```

### Scope Key

Full file:

```text
full
```

Selected region stats are not cached in MVP.

### Processing Hash

Original audio:

```text
processing:none
```

Processed audio:

Hash a canonical JSON payload with sorted keys:

```json
{
  "version": 1,
  "inputGainDb": 6,
  "chainOrder": ["gain"]
}
```

### Analysis Profile Hash

Hash algorithm choices:

- peak algorithm version
- RMS algorithm version
- channel mix policy
- decoder name/version
- app analysis schema version

## Processing Chain Contract

The processing chain is immutable per preview/export request. The UI may edit a draft preset, but playback and export receive a frozen chain object.

### Chain Order

MVP order:

1. Gain

Region trim happens before gain for selected-region export. Encoding happens after gain for export only.

### Gain

Fields:

- `enabled`
- `gainDb`
- `minDb`
- `maxDb`

Rules:

- MVP range is `-24 dB` to `+36 dB`.
- Convert using `linear = 10 ^ (gainDb / 20)`.
- Gain must be sample-accurate and deterministic.
- Gain never rewrites the source asset.
- Gain controls live in the bottom waveform/player strip.
- Slider/stepper interactions must not trap spacebar focus; spacebar remains play/pause unless the user is typing literal text.
- Changing gain updates preview and export processing state without changing waveform selection or playhead.

### Deferred Processing

EQ, normalization, and limiter controls are post-MVP unless explicitly reintroduced. MVP processing is gain only.

EQ, normalization, limiter, and preset schemas are intentionally absent from the MVP processing contract. Adding them later requires a new chain version and processing hash.

## Preview and Export Consistency

Preview and export must consume the same frozen processing chain.

Requirements:

- Use a canonical serialized chain for cache keys, presets, preview requests, and export jobs.
- Preview stats and export preflight stats must use the same processed PCM target.
- Export verification may optionally re-analyze the encoded output and store `postEncodeStats`.
- A/B preview must compare original decoded audio against processed decoded audio for the full file.
- Region preview and region export must use the same frame boundaries.
- Any approximation in preview processing must be visible in diagnostics and avoided for final export stats.

Consistency checks:

- Same input + same scope + same chain produces the same processing hash.
- Processed preview peak/RMS matches export preflight within defined tolerance.
- Exported WAV re-analysis matches preflight within tight tolerance.
- Lossy MP3/OGG/AAC re-analysis may differ and must be labeled post-encode.

Suggested tolerances:

- Peak dBFS: `0.05 dB`
- RMS dBFS: `0.1 dB`

## Data Model Additions

### analysis

Required columns or equivalent fields:

- `asset_id`
- `asset_content_key`
- `scope`
- `processing_hash`
- analysis profile equivalent through `analyzer_version` until the migration is expanded
- `peak_dbfs`
- `rms_dbfs`
- `clipping_samples`
- `headroom_db`
- `duration_seconds`
- `sample_rate`
- `channel_count`
- `status`
- `error_code`
- `analyzed_at`

### processing_presets

Processing presets remain deferred until gain export is stable.

### export_jobs

Export jobs must snapshot:

- source asset id
- scope
- region boundaries when exporting a selected region
- processing chain JSON
- processing hash
- format settings
- expected preflight stats id

## Job Behavior

Analysis jobs:

- run in bounded backend queues
- are cancellable by asset/scope/chain
- dedupe identical cache keys
- prioritize selected asset and visible rows
- persist failure status without crashing the app

Processing jobs:

- render preview proxies only when Web Audio cannot match the chain
- stream export work where possible
- avoid loading large files fully into frontend memory
- report progress and recoverable errors

## Test Plan

Unit tests:

- dB to linear conversion
- RMS on known fixtures
- peak and clipping detection
- canonical processing hash stability
- gain-only processing contract validation

Integration tests:

- original full-file analysis on fixture WAV
- processed full-file analysis with gain only
- cache hit for identical asset/scope/chain/profile
- cache miss when gain, decoder profile, or file modified time changes
- export preflight stats match preview processed stats

Performance checks:

- selecting a new file does not wait for analysis
- analysis jobs do not block preview switching
- cache lookup stays fast with large libraries

## Phase 7 Deliverables

- Analysis metric contract for peak and RMS.
- Scope contract for full-file stats only.
- Original and processed stats model.
- Cache key design for full-file original/processed stats.
- Analysis job lifecycle and failure states.
- Fixture-based tests for core math and cache behavior.

## Phase 8 Deliverables

- Frozen processing chain contract.
- Gain schema.
- Preview/export consistency rules.
- Processing hash contract.
- Export job snapshot requirements.
- Tests proving preview and export use the same chain.

## Acceptance Criteria

- The app can represent original and processed full-file peak/RMS stats.
- Cache keys invalidate correctly when file identity, chain, or analysis algorithm changes.
- Gain is described by one shared preview/export contract.
- Preview and export cannot silently diverge in processing order or settings.
- The plan is implementable without touching app UI.
