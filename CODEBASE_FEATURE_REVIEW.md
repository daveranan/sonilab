# Codebase Feature Review

Review date: 2026-07-02

Scope: app feature inventory, waveform manipulation/extraction/export/drag/looping behavior, UX stability risks, and rebuild direction.

Status: in progress.

## Running Notes

- Repository shape: Tauri + Vite app with `src/` frontend, `src-tauri/` native layer, `public/`, `scripts/`, `docs/`, `test-fixtures/`, and benchmark artifacts.
- Existing uncommitted user edits were present before this review: `docs/phase-2-local-indexing.md` and `docs/phase-5-6-audio-preview-waveform.md`.
- App stack: React + TypeScript + Vite frontend, Tauri v2 native shell, Rust backend, SQLite/data-layer migrations, Web Audio playback, native file drag support, local sidecars for FFmpeg/audiowaveform.
- Largest frontend modules: `src/features/app/shell/AppShell.tsx` (3,398 lines), `src/features/audio-preview/WaveformCanvas.tsx` (2,482 lines), `src/features/app/shell/BottomDockPlaceholder.tsx` (2,272 lines), and `src/features/audio-preview/previewService.ts` (1,371 lines).
- Largest native modules: `src-tauri/src/export.rs` (4,133 lines), `src-tauri/src/lib.rs` (3,276 lines), `src-tauri/src/audio.rs` (2,860 lines), `src-tauri/src/data_layer.rs` (2,119 lines), and `src-tauri/src/os_drag.rs` (600 lines).

## Current Feature Inventory

### App Shell and Library Workflow

- Multi-pane desktop shell with title bar, left library/sidebar, central browse table, right inspector/settings, and bottom dock.
- Tab lifecycle and browse sessions are persisted/restored through shell session state.
- Search and browsing support sort models, search grammar, suggestions, row selection, density controls, and local database browse provider.
- Library sources include local folders, collection trees, activity history, source status, Freesound search, Internet Archive search, indexing status, and retry/clear failed asset handling.
- Browse rows can be previewed, opened in Explorer, deleted, selected in batches, dragged internally, or prepared for OS-level drag.

### Audio Preview and Waveform Feature Surface

- Preview state supports `idle`, `resolving`, `decoding`, `ready`, `playing`, `paused`, `switching`, `cancelled`, and `failed`.
- Loop modes are `off`, `file`, and `region`.
- Processing settings include original/processed mode, gain dB, output volume, mute, playback rate, and channel monitor mode.
- Preview service owns Web Audio context, media element playback fallback/path, decoded buffer cache, output device routing, analyser/meter snapshot, processing listeners, active preview resolution, active buffer, loop region, region fade envelope, and temporary loop preview state.
- Waveform model includes region start/end seconds, viewport visible start/end seconds, pixels-per-second, fit-to-view, peak descriptors, peak channels, segment markers, clipping markers, and cached peak metadata.
- Isolated pure math already exists for region normalization, seconds-to-pixel mapping, pixel-to-seconds mapping, fit viewport, zoom viewport, pan viewport, dB/gain conversion, gain clamp, playback-rate clamp, and decoded-memory estimate.

### Waveform Manipulation

- `WaveformCanvas.tsx` owns canvas rendering, peak loading, waveform resolution request tracking, channel visibility, playhead animation, clipping marker count, cursor mode, zoom labels, note layout, note editing/menu state, pointer drag state, keyboard handling, mouse wheel zoom/pan, middle-button pan, selection create/resize/move, region note selection, region fade handles, loop crossfade handles, vertical zoom, horizontal zoom, playhead display, fade overlays, loop overlays, and drag-out request detection.
- The waveform component has at least 16 `useState`, 16 `useRef`, 11 `useEffect`, and 18 `useCallback` usages.
- It registers document/window-level listeners for wheel, keyboard, pointer, and animation-frame behavior, and uses pointer capture.
- Region manipulation includes drag to create region, edge resize, body move, keyboard operations, fade-in/fade-out settings, fade slope handles, loop crossfade width/slope settings, and file-drag threshold/guard constants.

### Exporting and Dragging

- Frontend command wrappers cover preview resolution/bytes, cached preview imports, waveform peak generation/cache/ranges, level analysis, audio/export cancellation, cache management, license attribution, user metadata, region notes, update flow, queued gain export, output-folder picking, prepared region drag file, prepared asset drag file, native file drag, prepared drag cleanup, Explorer reveal/open, browse-row path resolution, and row delete.
- Explicit export supports batch export of selected/displayed local assets, region-only export, format settings, gain, attribution sidecar, loop crossfade seconds/slope, output folder, overwrite mode, preserve folder structure, region fades, and filename pattern.
- Cloud asset export is intentionally blocked/deferred in the current build.
- Region drag-as-file prepares a temporary exported file, starts a native file drag, deletes the temp file on cancel/non-copy, keeps a failure path when native drag fails, and reports status to the bottom dock.
- Asset drag-as-file prepares one or more files and starts native drag from browse/table interactions.
- Browser-only fallback cannot expose OS files; the code reports that Tauri is required for region drag.
- Frontend drag has two stacks: CrabNebula `@crabnebula/tauri-plugin-drag` and a custom native fallback command. Native is preferred for multiple files and rendered region exports; plugin failure falls back to native.

### Native Audio, Waveform, and Analysis

- `AudioRuntime` exposes preview file resolution, preview byte reading, waveform generation, sidecar-aware waveform generation, cached waveform loading, cached waveform range loading, level analysis, job cancellation, and runtime status.
- Waveform extraction supports cache lookups by asset/content/settings, waveform queueing, generated peak files, binary cache reads/writes, ranged peak reads, clipping markers, segment markers, sample-rate/channel metadata, duration, and peak resolution.
- Native waveform generation uses FFmpeg and audiowaveform paths, including sidecar processing and fallback logic for larger/non-WAV inputs.
- Level analysis computes peak/rms/clipping/headroom and caches analysis by processed hash/gain.
- Cancellation tokens/deadlines exist in the native audio path, which is good; the weak point is that UI cancellation and request identity are still spread across React refs/effects/service state.

### Native Export

- `ExportRuntime` supports queueing single and batch jobs, running jobs, cancellation, listing job snapshots, retrying jobs, preparing region drag files, preparing asset drag files, and deleting prepared drag files.
- Export input supports asset id(s), output folder, filename pattern, export format, format settings JSON, processing settings JSON, overwrite mode, preserve folder structure, attribution sidecar, full-file vs region scope, region start/end, loop crossfade seconds/slope, region fade gap/in/out seconds, and region fade slopes.
- Drag export input supports temp folder, display name, asset id, format, format settings, processing settings, region scope, loop crossfade, region fades, and rendered temp file output.
- Export render paths include native WAV rendering, native WAV intermediate rendering, FFmpeg rendering, source-format passthrough for no-op drag cases, gain clamping, region extraction, crossfade handling, sidecar writing, and attribution sidecars.
- The native implementation has real tests for queueing, invalid region bounds, processing contract validation, batch snapshots, FFmpeg args, crossfade loop layout, prepared region drag payloads, attribution sidecars, and native checks.

### Native Drag

- `os_drag.rs` validates file paths, rejects directories/missing paths, supports multiple existing files, normalizes Windows shell paths, builds HDROP payloads, and starts Win32/COM `DoDragDrop`.
- The only real native drag implementation is Windows. Non-Windows returns unsupported.
- Custom drag icons are explicitly not implemented for native file drag.
- The docs already call out the core risk: cross-platform behavior requires separate macOS/Linux implementations, and native drag should be isolated as a plugin/bridge rather than scattered across UI code.

### Data and Persistence

- SQLite schema includes sources, folders, assets, asset tags, analysis, waveform peaks, waveform peak files, collections, collection items, activity, presets, export jobs, cache entries, user metadata, user tags, and region notes.
- Search/browse supports local/cloud/source scopes, folder and collection browsing, cursor pagination, visible-window hints, warnings, stable sort, and rich asset rows with duration, sample rate, bit depth, channels, format, codec, size, peak/rms/headroom, provider, license, attribution, user tags, favorite/imported flags, and availability state.
- Indexing supports local folder registration, scan jobs, cancellation, reindexing, folder watchers, progress records, failed/missing asset handling, metadata import, tagging, source scan state, and activity records.
- Cloud features include Freesound credentials/search/preview cache/original import, Internet Archive search, manual cloud import, provider enablement, cloud tags, license/attribution handling, and indexing cloud assets.
- Current build defers several cloud interactions: cloud sources, cloud preview playback, cloud asset export, and cloud asset drag/export.

### App-Wide Interaction Features

- Keyboard commands cover search focus, filters, row selection/navigation, range selection, paging, open row, clear transient state, tabs, metadata panel, preview play/stop, loop, add to collection, send/export, playhead nudging, volume, channel monitor selection, and waveform horizontal/vertical zoom.
- Browse selection is the one interaction domain already using Zustand; it has a focused store and tests for click/ctrl/shift selection, keyboard movement, range extension, and stable id retention.
- React Query is installed but not used. Most async state is still component-local, service-local, or custom event based.

## Early Architecture Findings

- The implementation is feature-rich but concentrated in a few very large modules, especially `AppShell.tsx`, `BottomDockPlaceholder.tsx`, `WaveformCanvas.tsx`, `previewService.ts`, `audio.rs`, and `export.rs`.
- The key stability risk is not the basic data model; the shared types and pure math helpers are reasonable. The risk is that pointer interaction, rendering, playback, loop preview, export defaults, drag export, notes, fades, and app-level selection are coupled through large React components and mutable service state.
- The intended invariant from the phase plan is correct: one normalized region should feed loop, analysis, export, and UI. The implementation does not yet make that invariant the central owner; it passes region/fade/crossfade state through multiple UI callbacks and service calls.

## Stability Risks Found So Far

- `WaveformCanvas.tsx` mixes rendering, pointer math, drag state, keyboard handling, note editing, peak request lifecycle, zoom/pan, playhead animation, fades, crossfades, and file-drag initiation in one component.
- `BottomDockPlaceholder.tsx` mixes transport state, preview service subscription, region state, loop/crossfade state, export defaults, export job UI, drag overlay/failure state, meters, gain, region playback, and drag-export side effects.
- `AppShell.tsx` mixes app shell layout, tabs, browsing, local source state, import/drop overlay, library state, collection state, preview activity, keyboard dispatch, drag active state, and row actions.
- Critical coordination uses `window.dispatchEvent`/`window.addEventListener` custom events for preview intent, waveform intent, export intent, toolbar intent, browse-scroll-to-index, save-search-intent, and export-drag-active.
- Persistence is mixed through `window.localStorage` in multiple components instead of a typed settings/session layer.
- Exporting and drag-exporting share some inputs, but they are not expressed as one durable backend workflow with a single lifecycle. The UI prepares temp files, starts drag, decides cleanup, handles failure paths, and updates export status inline.
- Native drag is Windows-only, while the desired future state asks for cross-platform capability. Keeping file drag as a first-class UX requirement makes Tauri custom native code a long-term maintenance cost unless macOS/Linux implementations are funded.

## Test/Verification Snapshot

- `npm test` passes: 26 test files, 93 tests.
- `cargo test` passes: 91 Rust tests.
- Existing tests cover pure audio math, waveform math, decoded buffer cache, frontend command drag/export behavior, search grammar/suggestions, browse selection, migrations, data layer, indexing, waveform cache, export queueing, invalid region bounds, crossfade export behavior, rendered drag exports, native drag validation, cache enforcement, and reliability recovery.
- The largest remaining test gap is integrated UI interaction behavior: pointer capture/release, drag-to-export vs selection vs seek, loop/crossfade preview timing, keyboard interactions while dragging, cleanup after failed drag, stale region after asset switch, and cross-component event ordering.

## Rebuild Premise Check

The premise is mostly correct. The app already has substantial working functionality and passing tests, so "everything is broken" would be inaccurate. The more precise statement is: the current implementation has outgrown its architecture. It can work on happy paths, but waveform/preview/export/drag stability depends on timing-sensitive callback chains, mutable refs, service state, custom events, and large components, so edge cases will keep appearing.

## Soundly/Python Clarification

The Soundly attribution screenshots are a real signal, but they do not prove Soundly is "pure Python." Soundly publicly attributes Qt, FFmpeg, audio/codec libraries, Python ecosystem libraries, and Lua, and an old public hiring post asked for a C++ / Python developer. The most likely lesson is not "use Python for everything"; it is "use a native desktop stack with mature native audio, file drag, filesystem, metadata, and DAW integration."

For this feature set, a Python/Qt rebuild is credible:

- UI shell: PySide6/PyQt or C++/Qt.
- Audio/device layer: PortAudio/PyAudio or sounddevice, FFmpeg, soxr, libsndfile/libsndfile wrappers.
- Metadata/indexing: tinytag/mutagen-style metadata, SQLite, watchdog/FSEvents.
- Cloud/API: requests/websockets/autobahn-style libraries.
- DAW integration: WAAPI, native file drag, app-specific spot/send workflows.

The tradeoff is packaging and runtime discipline. Python is excellent for glue, indexing, metadata, cloud calls, and tool orchestration, but waveform rendering, low-latency playback, native drag, and DAW transfer still need native/compiled boundaries and a strict state model.

Revised stack conclusion: if the goal is Soundly-like behavior rather than a web-style app, the strongest candidates are C++/Qt + Python service layer, or PySide6/PyQt + native audio/export helpers. Tauri/React/Rust can work, but only after a major interaction-architecture rebuild; it is not the best fit if the app's core value is native waveform editing plus reliable cross-app drag/spot/send.

## Best-Fit Rebuild Direction

### What I Would Keep

- Keep the Rust data/index/audio/export core. It already handles the expensive, local-first work: filesystem indexing, SQLite persistence, metadata, waveform peak generation, binary peak cache, level analysis, FFmpeg/audiowaveform integration, export rendering, cache enforcement, reliability recovery, and native drag validation.
- Keep the SQLite schema direction, especially asset identity, waveform peak files, export jobs, cache entries, user metadata/tags, and region notes.
- Keep the pure TypeScript math helpers and expand that pattern: `normalizeRegion`, viewport math, dB/gain math, playback-rate clamping, processing-chain normalization.
- Keep the test fixtures and existing test suite. They are a useful safety net for a rebuild.

### What I Would Rebuild

- Rebuild the app shell and interaction layer, not the whole product.
- Replace large component-local orchestration with explicit domain controllers:
  - `BrowseController`: query, selection, virtualized rows, visible-window hints.
  - `PreviewController`: asset resolution, decoding/loading, transport, loop mode, output device, channel monitor, gain, playback rate, meter.
  - `WaveformEditorController`: peak loading, viewport, region create/resize/move, note edit, fade edit, crossfade edit, seek, keyboard commands.
  - `ExportController`: export defaults, selected assets, selected region, queue/list/retry/cancel status.
  - `DragExportController`: prepare temp file, start native drag, observe result, cleanup, reveal fallback.
- Stop using `window.dispatchEvent` as the app event bus. Replace it with typed commands/actions and controller-owned state.
- Stop storing settings ad hoc in `localStorage`. Use a typed settings/session repository with schema versioning.
- Make region/fade/crossfade one canonical document:
  - `assetId`
  - `startSeconds`
  - `endSeconds`
  - `fadeInSeconds`
  - `fadeInSlope`
  - `fadeOutSeconds`
  - `fadeOutSlope`
  - `loopCrossfadeSeconds`
  - `loopCrossfadeSlope`
  - `notes`
  - `updatedBy`
  - `updatedAt`
- Every consumer should read that canonical document: preview, waveform overlay, analysis, explicit export, drag export, inspector, and notes.

### Shell/Platform Choice

If cross-platform drag-to-DAW/export UX is a primary requirement, I would seriously consider moving the shell to Electron while keeping the Rust core as a sidecar/library. Electron has official native file drag-out via `webContents.startDrag`, and it runs one Chromium stack across Windows/macOS/Linux. That reduces WebView variability for canvas, pointer events, keyboard behavior, and Web Audio.

That said, Tauri is not automatically the wrong answer in 2026. CrabNebula `drag-rs`/`tauri-plugin-drag` now advertises drag-out support for macOS, Windows, and Linux via GTK, and the current app already depends on that plugin. So the decision should be made by a short spike:

- Build the same drag-out prototype in current Tauri using only `tauri-plugin-drag`/`drag-rs`.
- Build the same prototype in Electron using `webContents.startDrag`.
- Test real target drops: Windows Explorer, macOS Finder, GNOME/KDE file manager, Reaper, Ableton, Audacity, and at least one unsupported target.
- Test single file, multiple files, rendered temp region, source passthrough, cancel-before-drop, rapid repeated drags, and stale temp cleanup.
- If Tauri passes those tests, stay on Tauri and delete the custom Windows COM drag path. If it fails, move the shell to Electron and preserve the Rust core.

My default rebuild recommendation: Electron shell + React/TypeScript + Rust backend core if cross-platform DAW drag is non-negotiable. Tauri v2 + CrabNebula drag plugin is the lighter fallback if the spike proves it works on the actual targets.

### Waveform Engine Choice

Do not rebuild the waveform as another 2,000-line React component.

Preferred approach:

- Use precomputed backend peaks as the source of truth.
- Use a dedicated waveform package/component with a tiny public API:
  - `load(assetId, contentKey, duration, peakDescriptor)`
  - `setViewport(viewport)`
  - `setRegion(regionDocument)`
  - `setPlayhead(seconds)`
  - `dispatchGesture(action)`
  - `onAction(action)`
- Keep rendering separate from rules. The renderer draws peaks/overlays; the controller decides state transitions.

Library option:

- Prototype WaveSurfer v7 with Regions, Timeline, Minimap, Hover, Zoom, and Envelope-style behavior.
- WaveSurfer docs describe it as an interactive waveform player with Canvas rendering, plugins, TypeScript API, MediaElement/WebAudio playback, and pre-decoded peaks for large files.
- WaveSurfer may reduce region/zoom/seek bugs, but it will not replace the backend export/cut/process pipeline. It should be treated as a waveform/player UI layer, not the audio processing engine.
- If WaveSurfer fights the app's custom needs, keep a custom Canvas/WebGL renderer, but keep all pointer/region/fade/crossfade logic in a pure reducer with exhaustive tests.

### State Machines to Add

Waveform editor states:

- `empty`
- `loadingPeaks`
- `ready`
- `selecting`
- `selected`
- `resizingStart`
- `resizingEnd`
- `movingRegion`
- `panning`
- `seeking`
- `editingFadeIn`
- `editingFadeOut`
- `editingFadeInSlope`
- `editingFadeOutSlope`
- `editingLoopCrossfadeLeft`
- `editingLoopCrossfadeRight`
- `editingLoopCrossfadeSlope`
- `preparingDragExport`
- `draggingExport`
- `failed`

Preview states:

- `idle`
- `resolving`
- `loading`
- `ready`
- `playingFile`
- `playingRegion`
- `playingLoop`
- `playingTempCrossfade`
- `paused`
- `switchingAsset`
- `recoveringOutputDevice`
- `failed`

Export/drag states:

- `idle`
- `validating`
- `queued`
- `rendering`
- `ready`
- `preparingDragFile`
- `dragReady`
- `dragging`
- `dropCopied`
- `dropCancelled`
- `dropUnsupported`
- `cleanupQueued`
- `failed`

### Edge Cases That Need Explicit Tests

- Click inside selected region seeks/plays without clearing region.
- Click outside selected region clears or seeks according to one documented rule.
- Tiny drag below threshold does not create a region.
- Tiny drag inside existing region does not accidentally start file drag.
- Drag out starts only after distance and age thresholds.
- Pointer capture release before native drag does not leave stuck cursor/drag state.
- Pointer cancel clears transient state.
- Escape during select/resize/move/fade/crossfade/drag returns to a deterministic state.
- Asset switch during peak load ignores stale peak response.
- Asset switch during preview decode aborts stale decode.
- Asset switch during export drag preparation either cancels or completes against the original asset; never mixes assets.
- Region is clamped after duration metadata changes.
- Region survives zoom/pan without changing seconds.
- Region resize cannot invert start/end or create below-minimum duration.
- Move region clamps at file boundaries and preserves duration.
- Fade handles clamp to region duration and respect minimum fade gap.
- Fade slope edits commit only on pointer up or explicit keyboard commit.
- Loop crossfade cannot exceed allowed region ratio.
- Loop crossfade preview cancellation does not leave temp playback active.
- Region loop uses exact selected start/end seconds after gain/playback-rate changes.
- Playhead nudge clamps within active file or active region according to loop mode.
- Export region uses the same region document as preview and waveform.
- Drag export uses the same render settings as explicit export.
- Cancelled native drag deletes temp files.
- Failed native drag preserves revealable fallback file only when useful.
- Successful drag does not delete the file before the OS/target has consumed it.
- Rapid repeated drags produce unique temp paths and deterministic cleanup.
- Multi-file drag and single-file drag use the same result contract.
- Plugin drag failure and native fallback failure produce actionable diagnostics.
- Non-Windows drag behavior is covered by CI/manual smoke tests, not assumed.
- Browser/dev fallback communicates unavailable native drag without mutating export state.
- Output device loss/recovery does not reset region/fade/export settings.
- Meter updates do not re-render the full waveform editor unnecessarily.
- Keyboard shortcuts are ignored in inputs/sliders/contenteditable areas.
- `localStorage`/settings corruption falls back safely.

### Migration Path

1. Freeze current behavior into executable specs.
   Add Playwright/E2E tests for the waveform dock and drag/export workflows before rewriting them.

2. Extract contracts.
   Move `WaveformRegion`, viewport math, processing settings, export settings, drag-result types, and preview states into a shared `core-contracts` package with Zod validation.

3. Extract controllers.
   Implement reducers/state machines for waveform, preview, export, and drag. Unit-test transitions independently of React, Canvas, Tauri, or Electron.

4. Build a waveform sandbox.
   One route/screen only: load fixture peaks, draw waveform, select/resize/move/zoom/pan/seek/fade/crossfade, export/drag a region. No app shell.

5. Run the shell spike.
   Compare Tauri + CrabNebula drag against Electron `startDrag` on real target apps. Make the shell choice from observed behavior.

6. Reconnect the existing Rust core.
   Keep current SQLite migrations and Rust services, but expose narrower typed APIs. Export/drag should be backend workflows with job ids and lifecycle states.

7. Replace the bottom dock.
   Ship the new preview/waveform/export dock behind a feature flag while the browse/library shell remains intact.

8. Replace app-wide event bus.
   Convert `sonilabs:*` custom events into typed commands/actions. Remove global listeners as each domain moves.

9. Add OS matrix verification.
   CI for unit/integration; manual or automated smoke for Windows/macOS/Linux file drag, temp cleanup, export playback correctness, and waveform interaction.

## External References Checked

- Electron native file drag/drop docs: <https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop>
- Electron `webContents` API docs: <https://www.electronjs.org/docs/latest/api/web-contents>
- CrabNebula `drag-rs` / Tauri drag plugin README: <https://github.com/crabnebula-dev/drag-rs>
- `tauri-plugin-drag` docs.rs metadata: <https://docs.rs/crate/tauri-plugin-drag/latest>
- Tauri event docs: <https://v2.tauri.app/reference/javascript/api/namespaceevent/>
- WaveSurfer docs: <https://wavesurfer.xyz/docs/>
- WaveSurfer core concepts: <https://wavesurfer.xyz/docs/core-concepts/>
- WaveSurfer events: <https://wavesurfer.xyz/docs/events/>
