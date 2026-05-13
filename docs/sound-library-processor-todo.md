# Sound Library Processor - Feature Todo

## Phase 0 - Production Setup

- [x] Create Tauri 2 + React + TypeScript app.
- [ ] Ensure the app builds and runs on Windows from the first commit.
- [x] Add a Windows build smoke test command.
- [x] Document required Windows build prerequisites: Rust toolchain, Node package manager, WebView2 runtime, Visual Studio Build Tools, and FFmpeg sidecar location.
- [x] Add shadcn/ui, Tailwind, theme tokens, dark mode defaults.
- [x] Add linting, formatting, typecheck, unit test, and CI scripts.
- [x] Add Rust workspace structure for app core, audio, indexing, cloud, and export modules.
- [x] Add SQLite migration system.
- [x] Add app config system for library paths, cache limits, audio device settings, and cloud credentials.
- [x] Add structured logging for frontend, backend, job queues, and export failures.
- [x] Add crash/error reporting hooks with local log export.
- [x] Add release packaging config for Windows first.
- [x] Add FFmpeg sidecar packaging and version validation.
- [x] Add test fixture folder with small WAV/MP3/OGG/FLAC files.
- [x] Add performance benchmark harness for indexing, scrolling, search, preview switching, waveform generation, and export.

## Phase 1 - Core Data Layer

- [x] Design SQLite schema for sources, assets, folders, analysis, waveform peaks, collections, activity, presets, and export jobs.
- [x] Add migrations and rollback tests.
- [x] Implement source CRUD for Local and Cloud sources.
- [x] Implement asset upsert by stable source/path/content key.
- [x] Implement collection folders and collection items.
- [x] Implement activity history writes.
- [x] Implement cache metadata table.
- [x] Add repository/service layer tests.

## Phase 2 - Local Library Indexing

- [x] Add drag-drop local folder registration.
- [x] Implement recursive folder scanner.
- [x] Detect supported audio formats: WAV, MP3, OGG, FLAC, AAC, M4A, AIFF, AIF.
- [x] Extract basic metadata: name, path, duration, sample rate, bit depth, channels, size, modified time, format.
- [x] Run indexing as cancellable backend jobs.
- [x] Add bounded indexing queue.
- [x] Add folder watch support for creates, deletes, moves, and edits.
- [x] Add missing-file state without deleting user data.
- [x] Add reindex source/folder action.
- [x] Add indexing progress events to frontend.
- [x] Benchmark indexing 10k, 50k, and 100k short files.

## Phase 3 - Search and List Browsing

- [x] Add SQLite FTS5 or Tantivy search index.
- [x] Index name, path, tags, description, originator, license, rights flags, format, codec, source, status, dates, and full-file level stats.
- [x] Implement filter grammar: `tag:`, `license:`, `duration:`, `format:`, `rate:`, `channels:`.
- [x] Expand filter grammar for full-app filters: rights, codec, bit depth, file size, provider, collection, favorite, availability, status, dates, rating, peak, RMS, clipping, and headroom.
- [x] Build grouped full-app filter builder with active chips, license explanations, disabled unavailable filters, Apply, Clear all, Reset group, and Save search.
- [x] Add debounced local search.
- [x] Add result sorting by name, duration, modified time, format, peak/RMS level, and source.
- [x] Build virtualized file table.
- [x] Build virtualized folder rows.
- [x] Add keyboard navigation for up/down, space, enter, range select, and multi-select.
- [x] Add result count and visible-row lazy metadata loading.
- [x] Benchmark 50k-row scrolling with active selection.
- [x] Dim rows already previewed or selected during the current session.

## Phase 4 - App Shell UI

- [x] Build resizable left sidebar.
- [x] Add Libraries section focused on Local sources.
- [x] Add nested local folder tree.
- [ ] Defer cloud source tree until cloud connectors return to scope.
- [x] Add Collections tree with nested folders.
- [x] Add Activity History section.
- [x] Add source status icons: connected, indexing, paused, offline, error.
- [x] Add context menus for sources, folders, collections, and activity rows.
- [x] Build top search bar.
- [x] Build tabs for folder, search, collection, and export queue views.
- [x] Build breadcrumbs.
- [x] Build top-right toolbar with result count, filters, sort, view toggle, refresh, and source settings.
- [x] Apply screenshot-inspired dense dark visual design.

## Phase 5 - Audio Preview Engine

- [x] Implement Web Audio preview graph.
- [x] Add backend preview file resolver.
- [x] Add decoded-buffer cache for current and nearby selections.
- [x] Add aggressive buffer eviction.
- [x] Add click-to-preview table behavior.
- [x] Add arrow-key rapid preview behavior.
- [x] Add play, pause, stop, previous, next.
- [x] Add playback speed control.
- [x] Add output volume and mute.
- [x] Add original/processed A/B switch.
- [x] Ensure preview switching cancels stale decode/play requests.
- [ ] Benchmark cached preview switching under 100 ms.

## Phase 6 - Waveform and Region Selection

- [x] Generate waveform peak data in backend jobs.
- [x] Cache waveform peaks by asset/content key.
- [x] Render waveform with canvas or WebGL.
- [x] Add stereo/mono display support.
- [x] Add playhead.
- [ ] Add waveform readout for full length, cursor time, playhead time, selection bounds, selection duration, sample rate, bit depth, and channels.
- [x] Keep waveform and region visible when row selection is cleared until another file is selected.
- [x] Let left-click set the waveform playhead instead of showing cursor readout.
- [x] Hide segment marker indicator from the waveform UX.
- [x] Add zoom and pan.
- [x] Add drag-to-select export region.
- [x] Add export-region overlay.
- [x] Add drag selected waveform region as a temporary rendered OS file using current export format and gain.
- [x] Add full-file loop mode.
- [x] Add selected-region loop mode.
- [x] Add segment markers.
- [ ] Add clipping markers for processed preview.
- [x] Keep waveform rendering independent of React row state.

## Phase 7 - Level Analysis

- [x] Add full-file peak dBFS analysis.
- [x] Add full-file RMS dBFS analysis.
- [x] Add processed full-file peak/RMS analysis after gain.
- [x] Add clipping sample detection.
- [x] Add headroom display.
- [x] Cache analysis results by asset and processing settings.
- [x] Display pending analysis states without blocking playback.

## Phase 8 - Processing Controls

- [x] Move gain controls into the bottom waveform/player strip.
- [x] Make file summary metadata a toggleable side panel opened from bottom/source settings controls.
- [x] Add bottom channel monitor selector for all channels or any individual decoded channel.
- [x] Add gain slider from `-24 dB` to `+36 dB`.
- [x] Add numeric gain input.
- [x] Add gain reset.
- [x] Ensure gain slider/input does not trap spacebar; spacebar always toggles playback unless typing text.
- [x] Apply gain to preview graph.
- [x] Apply gain to export pipeline.
- [x] Defer normalize, limiter, EQ, and processing presets until after basic gain export is stable.
- [x] Display processing chain order.

## Phase 9 - Export Pipeline

- [x] Implement export job model.
- [x] Add output folder picker.
- [x] Add filename pattern builder.
- [x] Add full-file vs selected-region export.
- [x] Add overwrite behavior.
- [x] Add preserve folder structure toggle.
- [x] Add WAV export.
- [x] Add MP3 export.
- [x] Add OGG Vorbis export.
- [x] Add FLAC export.
- [x] Add AAC/M4A export.
- [x] Add MP4 audio export.
- [x] Add format-specific settings.
- [x] Add batch export selected rows.
- [x] Add export queue view.
- [x] Add failed-job retry.
- [x] Add attribution/license sidecar export.
- [x] Verify full-file WAV output levels when Phase 7 full-file analysis exists.

## Phase 10 - Collections and Activity

- [x] Create collection.
- [x] Rename collection.
- [x] Delete collection.
- [x] Create nested collection folders.
- [x] Drag assets into collections.
- [x] Drag folders into collections as references.
- [x] Add favorites collection behavior.
- [x] Add export queue collection behavior.
- [x] Record recently played sounds.
- [x] Record recent searches.
- [x] Record imports.
- [x] Record exports.
- [x] Record failed jobs.
- [x] Restore view from activity row click.

## Phase 11 - Freesound Connector - Deferred

- [ ] Deferred out of current scope; Freesound requires user API credentials and is not an active browse workflow.
- [ ] Keep any harmless implementation code unexposed until the connector is deliberately resumed.
- [ ] Revisit credential setup, source registration, search, preview caching, original import/export, attribution, and rate-limit handling when cloud sources return to scope.

## Phase 12 - Additional Cloud Sources - Deferred

- [ ] Deferred out of current scope.
- [ ] Internet Archive connector is not an active workflow.
- [ ] OpenGameArt remains manual/web-first and is not an active browse/import workflow.
- [ ] Pixabay remains deferred unless a stable audio API and licensing path are confirmed.
- [ ] Do not expose provider enable/disable settings or cloud source rows until this phase is resumed.

## Phase 13 - Reliability and Performance Hardening

- [x] Add bounded queues for indexing, metadata, waveform, level analysis, and export.
- [x] Add cancellation for every long-running job.
- [x] Add memory ceiling tests for rapid preview browsing.
- [x] Add cache limit enforcement.
- [x] Add corrupt-file handling.
- [x] Add unavailable-drive handling.
- [x] Add timeout handling for active local/index/export jobs.
- [x] Add app restart recovery for interrupted jobs.
- [x] Add database integrity checks.
- [x] Add performance regression tests.
- [x] Add soak test for rapidly browsing thousands of short files.

Cloud queue and timeout handling remains deferred with Phases 11/12; this phase only hardens local indexing, preview, waveform, level analysis, cache, database, and export paths.

## Phase 14 - Production Polish

- [x] Add first-run onboarding for local folder setup.
- [x] Add keyboard shortcut reference.
- [x] Add settings screen.
- [x] Add audio device settings.
- [x] Add cache management UI.
- [x] Add source management UI.
- [x] Add export defaults UI.
- [x] Add license/attribution report view.
- [x] Add update flow.
- [ ] Add signed Windows installer. Signing-ready config/checks are present; an actual signed installer is blocked until a certificate and update signing secrets are supplied.
- [x] Add release smoke tests.

## Definition of Done

- [ ] App can index and browse 50k+ local short sounds smoothly.
- [ ] Rapid row selection previews cached sounds in under 100 ms.
- [ ] UI remains responsive while indexing, analyzing, and exporting.
- [ ] Gain affects preview and export consistently.
- [ ] Original and processed peak/RMS stats are visible for the full file.
- [ ] Full-file looping works reliably.
- [ ] Batch export supports at least WAV, MP3, and OGG.
- [ ] Sidebar contains only Libraries, Collections, and Activity History.
- [ ] Local workflows are production-ready; cloud workflows remain deferred.
- [ ] Crashes, failed decodes, missing files, and failed exports are handled without data loss.
