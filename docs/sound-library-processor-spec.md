# Sound Library Processor - Product and Technical Spec

## Goal

Build a desktop sound browser and batch processor inspired by the provided screenshot. The current scope is local libraries, collections, activity history, preview, processing, and export. Cloud libraries are deferred and must not be exposed as active browse/connect/import workflows.

The design should use `shadcn/ui` as the component foundation, with a dark, dense, professional audio-tool UI.

## Core Product Requirements

### Primary Workflows

1. Add a local folder.
2. Browse folders, collections, and search results quickly.
3. Click or keyboard-step through sound files with instant preview.
4. Select a full file or a waveform region.
5. Apply gain.
6. Compare original vs processed audio.
7. Inspect basic peak/RMS dB stats for the full file.
8. Export one file, selected rows, or a batch queue.

### Performance Targets

- Browse 50,000+ short audio files without UI stalls.
- Switch preview between cached short files in under 100 ms.
- Keep renderer frame stalls below 16 ms during scrolling and preview.
- Index large folders incrementally without blocking playback.
- Decode and analyze audio off the UI thread.
- Never load all waveform data or decoded audio into React state.
- Support cancellable analysis, previews, imports, and exports.

## Recommended Tech Stack

### Desktop Shell

Use `Tauri 2 + React + TypeScript` as the preferred stack.

Reason: Tauri keeps the UI web-based for shadcn while moving heavy filesystem, indexing, audio analysis, and export work into a Rust backend with better memory control than a pure Electron renderer/main-process setup.

Electron is acceptable only if all heavy work is isolated into worker threads/native modules and the renderer is kept thin. If the main goal is crash-free browsing of thousands of short files, Tauri is the safer default.

### Frontend

- React
- TypeScript
- shadcn/ui
- Tailwind CSS
- TanStack Virtual for large lists and trees
- TanStack Query for async metadata/cache state
- Zustand or Jotai for lightweight UI state
- Web Audio API for low-latency preview graph
- Canvas or WebGL canvas for waveform rendering

### Backend

- Rust Tauri commands for filesystem access, indexing, export jobs, and cache management
- SQLite for local library index
- Tantivy or SQLite FTS5 for text search
- Symphonia for metadata probing/decoding where practical
- FFmpeg sidecar for reliable conversion/export
- Basic peak/RMS analysis, with EBUR128/BS.1770 loudness deferred to post-MVP
- Rayon/Tokio for bounded background job pools

### Storage

- SQLite database for indexed local files, folders, metadata, waveform summaries, user collections, export history, and activity history
- App cache directory for preview proxies, waveform peak files, and temporary export files
- Content-addressed cache keys using source ID, path/URL, modified time, file size, and processing settings

## App Layout

The UI follows the screenshot's visual structure:

- Left: library navigation sidebar
- Top: search, tabs, breadcrumbs, filters, result count
- Center: virtualized file/folder table
- Bottom: waveform, transport, gain, export format, meters, loop controls
- Right: optional file summary/details panel opened from the bottom/source settings controls

The app should feel like a fast database browser for sounds, not a marketing page or media player.

## Left Sidebar

Only show Libraries and related library-management sections.

### Sidebar Sections

1. Libraries
2. Collections
3. Activity History

### Libraries Tree

The Libraries tree focuses on Local sources. Cloud roots and provider rows are deferred and should not appear as active browse targets.

Example:

```text
Libraries
  Local
    D:/Audio/SFX
      impacts
      metal
      wood
      cloth
    F:/Projects/Game/Audio
      player
      weapons
      environment
```

### Collections

Collections are user-created folders/subfolders that can contain references to local sounds without duplicating files.

Example:

```text
Collections
  Current Project
    Footsteps
    Bullet Impacts
    UI Clicks
  Favorites
  Export Queue
```

Collection behavior:

- Drag sounds into collections.
- Drag folders into collections as references.
- Create nested collection folders.
- Collection items preserve source metadata and license info.
- Missing local files display as unavailable, not deleted.

### Activity History

Activity History shows recent actions:

- Recently played sounds
- Recently exported files
- Recently imported folders
- Recent searches
- Failed imports or exports
- Local imports, plays, searches, exports, and errors

Activity rows should be compact and clickable. Clicking an activity restores the relevant file, folder, search, or export job.

### Sidebar UX Details

- Width: 260-320 px, resizable.
- Dense rows, 24-28 px height.
- Folder disclosure arrows.
- Source status icons: connected, indexing, paused, offline, error.
- Context menu for source/folder/collection actions.
- Drag-drop local folders onto `Local`.
- Drag-drop files/folders into collections.
- Active item uses a strong blue highlight matching the screenshot.
- Text truncates with tooltip for long paths.

## Top Search and Navigation

### Search Bar

The search bar sits at the top-left of the main content area.

Features:

- Search by name, tag, folder, description, originator, license, format, duration, and sample rate.
- Prefix filters, such as `tag:metal`, `license:cc0`, `duration:<2`, `format:wav`.
- Debounced local search.
- Cloud search is deferred and disabled in the current product scope.
- Search history available from the input.

### Filter Builder

The filter builder is a full-library query tool, not a small fixed form. It should expose every indexed field that helps users narrow large sound libraries while keeping the main search grammar in sync.

Filter groups:

- Location: all local sources, source, folder/path prefix, collection, favorites, export queue.
- Text and tags: name, filename stem, path text, description, tags, originator, author, uploader.
- Rights: license, commercial-use allowed, attribution required, share-alike, non-commercial, public domain/CC0, unknown or ambiguous license.
- Audio properties: duration range, format/container, codec, sample rate, bit depth, channels, file size, modified date, indexed date, imported date.
- Cloud metadata filters are deferred.
- Local status: available, missing, moved candidate, probe failed, unsupported, source offline, waveform cached, analysis pending/complete/failed.
- Level stats: full-file peak dBFS, RMS dBFS, clipping, and headroom when analysis exists. LUFS and true peak filters may appear later only if those metrics are implemented.
- Project state: in collection, not in collection, recently played, recently exported, recently imported, failed jobs.

UX requirements:

- Use grouped sections with compact controls: multi-select lists, searchable pickers, range sliders/inputs, date ranges, tri-state toggles, and active filter chips.
- Keep filter builder state round-trippable with the typed search query and prefix grammar.
- Show license explanations on hover before the user applies a license filter.
- Support Apply, Reset group, Clear all, and Save as search/collection where applicable.
- Disable unavailable filters instead of hiding them when the active source lacks that metadata.
- Do not regenerate or rescan assets from the filter UI. Filtering runs against the database/search index.

### Tabs

Tabs represent active views:

- Folder view
- Search result
- Collection
- Export queue

Each tab has a title, close button, and unsaved/filter state indicator.

### Breadcrumbs

Breadcrumbs show the active source and folder path.

Example:

```text
Home / Local / hl2-master / sound / physics / surfaces
```

Clicking a breadcrumb segment navigates to that folder.

### Toolbar Actions

Top-right toolbar:

- Result count
- Filter menu
- Sort menu
- Shuffle/random audition
- List/grid toggle, with list as default
- Refresh/reindex
- Source settings

## File and Folder List

The center pane is a virtualized table optimized for tens of thousands of rows.

### Columns

Default columns:

- Name
- Duration
- Sample rate
- Bit depth
- Channels
- Format
- Peak
- RMS
- Library
- Description
- Originator
- License

Optional columns:

- Tags
- File size
- Date modified
- BPM
- Key
- Source/provider
- Availability status
- Favorite

### Row Behavior

- Single click selects and previews.
- Double click toggles play/pause or opens detail, based on user preference.
- Arrow keys move selection and auto-preview.
- Space toggles play/pause.
- Enter opens inspector focus.
- Shift-click selects a range.
- Ctrl-click toggles multi-select.
- Drag selected rows into collections or export queue.

### Folder Rows

Folders appear in the same table where useful, especially in folder-browse mode.

Folder rows show:

- Folder icon
- Name
- Child count
- Indexed status
- Last indexed time

### Virtualization Requirements

- Use fixed row heights by default.
- Do not render hidden rows.
- Keep row components pure and cheap.
- Never attach one audio object per row.
- Do not compute audio stats during render.
- Lazy-load heavy metadata after initial visible rows are drawn.

## Bottom Waveform and Player

The waveform/player is always visible when a sound is selected.

### Waveform

Features:

- Full-file waveform overview.
- Selected region overlay.
- Playhead.
- Zoom and pan.
- Segment markers.
- Clipping markers after processing.
- Original vs processed overlay option.
- Mono/stereo channel display.
- Time/status readout matching professional sample-browser behavior:
  - full file length at the waveform edge,
  - current cursor/hover time,
  - playhead time,
  - selected region start/end,
  - selected region duration,
  - sample rate and bit depth,
  - channel count or channel label.

Waveform rendering:

- Use precomputed peak data.
- Store peaks in cache.
- Render with canvas or WebGL.
- For very short sounds, stretch to readable width.

### Selection

Users can drag on the waveform to select an export region.

The selected region is only an export and loop range. It does not require separate selected-region level analysis; Phase 7 level stats are full-file only.

Dragging an existing selected region out of the waveform should behave like dragging a real exported file:

- The app prepares a temporary rendered file for the selected range, using the currently selected bottom-right export format and current gain settings.
- Once the temporary file is ready, the drag operation exposes the OS file path so the user can drop it into Explorer, a DAW, a game editor, or another app.
- During this export-drag gesture, the app can show an overlay or otherwise visually de-emphasize the normal UI so the user understands they are dragging an actual file, not selecting text or moving an internal UI object.
- If the file cannot be rendered quickly, show a pending export-drag state and fail recoverably without clearing the region or selection.
- Export-drag uses the same trim boundaries as selected-region loop and the same format/gain settings as explicit export.

### Looping

Loop controls:

- Loop off
- Loop full file
- Loop selected region

Looping must be gapless or near-gapless for short sounds. Use Web Audio scheduling rather than restarting an HTML audio element where possible. Selected-region looping reuses the export region and does not imply separate selected-region level analysis.

### Transport Controls

Controls:

- Previous selected result
- Play/pause
- Next selected result
- Stop
- Loop mode
- Playback speed
- Output volume
- A/B original vs processed
- Mute

Meters:

- Live left/right peak meter
- Processed output meter
- Clipping indicator
- Peak hold

## File Summary Panel

The file summary is not permanently visible. It is a collapsible side panel opened from the bottom player/source settings area and closed when the user wants the browser/waveform to use the space.

### File Summary

Show:

- Name
- Source
- Path
- Format
- Duration
- Sample rate
- Bit depth
- Channels
- License
- Originator/author
- Tags

### Gain

Primary gain controls live in the bottom waveform/player strip, not in the file summary panel:

- Gain slider, range `-24 dB` to `+36 dB`
- Numeric dB input
- Reset button
- Basic clipping/headroom readout

Gain applies to preview and export. It does not destructively modify the source file.

Keyboard behavior:

- Spacebar always toggles playback from the current playhead, unless the user is typing into a text field that must consume literal text.
- After adjusting gain with a slider or numeric stepper, focus must not trap spacebar. The control should blur or route spacebar to playback so pause/play remains immediate.
- Gain changes update preview/export processing state without changing selection, playhead, or waveform focus.

### Level Analysis

Show separate level rows/cards for:

- Original full file
- Processed full file

Each row/card shows:

- Peak dBFS
- RMS dBFS
- Clipping samples
- Headroom

If analysis is pending, show a compact loading state and keep playback usable.

### EQ

EQ is post-MVP. Do not build EQ controls until basic gain preview/export is stable.

### Processing Chain

Processing order:

1. Input trim for selected-region export when applicable
2. Gain
3. Export encoding

The UI should display this chain in the bottom player as compact inline controls, not as a node graph.

## Export Panel

Export controls live in the bottom player near the waveform and transport. The selected export format is always visible near the bottom-right controls.

### Formats

Supported export formats:

- WAV
- MP3
- OGG Vorbis
- FLAC
- AAC/M4A
- MP4 audio

### Export Settings

Common settings:

- Export full file or selected region
- Output folder
- Filename pattern
- Overwrite behavior
- Preserve folder structure toggle
- Include license/attribution sidecar toggle

Format-specific settings:

- WAV: bit depth, sample rate
- MP3: bitrate, VBR/CBR
- OGG Vorbis: quality
- FLAC: compression level
- AAC/M4A: bitrate
- MP4 audio: codec and bitrate

### Batch Export

Batch export supports:

- Selected rows
- Current collection
- Current search results
- Export queue

Batch rows show status:

- Pending
- Analyzing
- Processing
- Exporting
- Complete
- Failed

Failures must not stop the whole batch unless the user chooses that behavior.

## Cloud Library Connectors

Deferred out of the current scope. Freesound and Pixabay require credentials/API certainty, OpenGameArt is web/manual-first, and Internet Archive license/file quality needs a separate design pass.

Do not expose active Freesound, Internet Archive, OpenGameArt, or Pixabay browse tabs, provider rows, credential prompts, source toggles, cloud preview fetches, or cloud original import/export flows until this section is resumed.

## Local Library Import

### Drag and Drop

Users can drag local folders into the app.

Drop targets:

- `Local` in the sidebar
- Current folder view
- Collections

### Indexing

Indexing should:

- Run in the backend.
- Walk folders incrementally.
- Detect supported audio files.
- Read basic metadata first.
- Defer waveform and basic level analysis until needed or idle.
- Watch folders for changes.
- Handle moved/deleted files gracefully.

### Supported Input Formats

At minimum:

- WAV
- MP3
- OGG
- FLAC
- AAC
- M4A
- AIFF
- AIF

## Data Model

### Source

Represents a local folder connection. Cloud provider connections are deferred.

Fields:

- id
- type: local
- provider
- display_name
- root_path_or_url
- status
- last_indexed_at
- settings_json

### Asset

Represents a local sound file. Cloud sounds are deferred.

Fields:

- id
- source_id
- source_asset_id
- path_or_url
- name
- extension
- duration
- sample_rate
- bit_depth
- channels
- file_size
- modified_at
- license
- originator
- description
- tags
- metadata_json

### Analysis

Represents basic measured audio stats.

Fields:

- asset_id
- scope: full
- peak_dbfs
- rms_dbfs
- clipping_samples
- analyzed_at

### Processing Preset

Fields:

- id
- name
- gain_db

### Collection

Fields:

- id
- parent_id
- name
- sort_order

### Collection Item

Fields:

- collection_id
- asset_id
- added_at
- note

### Activity

Fields:

- id
- type
- asset_id
- source_id
- collection_id
- query
- message
- status
- created_at

## UX States

### Empty State

When no libraries are connected:

- Show a compact drop zone in the main pane.
- Primary action: `Add Local Folder`
- No cloud connection action in the current scope.

### Loading State

Show loading without blocking interaction:

- Sidebar source spinner for indexing.
- Table skeleton only for initial load.
- Per-row lazy metadata placeholders.
- Waveform loading strip for selected file.

### Error State

Errors should be scoped:

- Source unavailable
- File missing
- Decode failed
- Analysis failed
- Export failed
- License unknown

Errors should never crash the whole app.

## Keyboard Shortcuts

- Up/down: select previous/next sound
- Space: play/pause
- L: toggle loop mode
- R: select region tool
- G: focus gain input
- E: focus export panel
- F: focus search
- Ctrl+F: global search
- Ctrl+E: export selected
- Ctrl+B: add selected to export queue

## Visual Design Direction

### General

- Dark theme by default.
- Dense rows.
- High contrast selected state.
- Minimal borders.
- Use subtle separators instead of cards.
- Avoid decorative gradients.
- Keep controls compact and tool-like.

### Colors

Suggested palette:

- App background: near-black neutral
- Panels: dark zinc/neutral
- Separators: muted gray
- Active selection: saturated blue
- Waveform: bright blue with light filled waveform
- Warning: amber
- Error/clipping: red
- Success/export complete: green

### Typography

- Use system font or Inter.
- Small UI text: 12-13 px.
- Table rows: 13 px.
- Section labels: 11-12 px uppercase or muted text.
- Avoid oversized headings.

### Component Guidance

Use shadcn components for:

- Button
- Input
- Select
- Slider
- Tabs
- DropdownMenu
- ContextMenu
- Tooltip
- ScrollArea
- Resizable panels
- Dialog
- Sheet
- Progress
- Badge
- Toggle
- Switch

Use custom components for:

- Virtualized library tree
- Virtualized file table
- Waveform canvas
- Live audio meters
- EQ curve later

## Architecture

### Process Boundaries

Frontend renderer:

- Displays UI.
- Handles interaction.
- Starts/stops preview.
- Requests backend jobs.
- Renders waveform and meters.

Backend:

- Filesystem scan.
- Metadata extraction.
- SQLite writes.
- Search index updates.
- Audio analysis.
- Export processing.
- Cache cleanup.

Audio preview:

- Use Web Audio graph in renderer for low latency.
- Use cached preview/proxy files when available.
- Use decoded buffers only for current/nearby selections.
- Evict buffers aggressively.

### Job System

Use bounded queues:

- Import/index queue
- Metadata probe queue
- Waveform queue
- Level analysis queue
- Export queue

Jobs must be cancellable and report progress.

### Cache Strategy

Cache:

- Preview audio
- Waveform peaks
- Level analysis

Eviction:

- LRU by size
- User-configurable cache limit
- Never delete original local files

## MVP Scope

### MVP Must Include

- Tauri desktop shell
- React/shadcn dark UI
- Left sidebar with Libraries, Collections, Activity History
- Local folder drag-drop import
- SQLite index
- Virtualized folder/file list
- Search
- Instant preview
- Bottom waveform
- Full-file loop
- Gain slider/input
- Before/after peak/RMS levels
- Export WAV, MP3, OGG
- Batch export selected rows
- Cloud connectors are deferred and not active in MVP.

### Post-MVP

- Selected-region analysis
- Full LUFS/true peak analysis
- Parametric EQ
- Freesound connector
- Internet Archive connector
- OpenGameArt connector
- FLAC/AAC/MP4 export
- Cloud download manager
- License/attribution report
- Similar-sound search
- Spectrogram view
- Project-specific collections

## Non-Goals

- Multitrack editing
- DAW timeline
- Destructive source-file editing
- Full sample-pack marketplace
- AI generation
- Complex node-based processing

## Acceptance Criteria

- User can add a folder with thousands of sounds and keep scrolling smoothly while indexing continues.
- User can click rapidly through short sounds without app freezes.
- User can select a sound, boost gain, and hear the processed preview.
- User can see original and processed level stats.
- User can select a waveform region for export.
- User can export the processed full file or selected region.
- User can browse Local sources from the simplified Libraries sidebar.
- User can organize sounds into nested collections.
- User can reopen recent sounds/searches/exports from Activity History.
