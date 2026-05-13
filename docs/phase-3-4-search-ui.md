# Phase 3-4 Plan - Search, List Browsing, and App Shell UI

## Scope

This document defines implementation contracts for Phase 3 and Phase 4 without implementing the product UI yet.

Phase 3 owns search, results, list virtualization, selection, and keyboard browsing behavior. Phase 4 owns app-shell layout boundaries, sidebar/search/table integration points, shadcn usage rules, and acceptance tests for the shell once real data exists.

Do not use this phase to polish the temporary `src/App.tsx` shell. The temporary shell may remain useful for wiring tests, but production UI should be built behind focused components and connected only when the contracts below are ready.

## Goals

- Browse 50k+ indexed local or cloud audio assets without React frame stalls.
- Search with predictable grammar, stable sort, and cancellable backend requests.
- Keep table, tree, and search state decoupled from preview/audio processing.
- Support rapid keyboard auditioning once Phase 5 connects preview.
- Establish app-shell component boundaries before the visual build starts.
- Use shadcn/ui for standard controls and custom components for performance-critical surfaces.

## Non-Goals

- No waveform implementation.
- No audio preview implementation.
- No gain/EQ/export product UI.
- No final sidebar visual polish inside `src/App.tsx`.
- No full cloud connector behavior beyond source/search contracts.

## Phase 3 - Search and List Browsing

### Search Grammar

Search input accepts free text plus scoped filters. Free text matches name, filename stem, path segments, tags, description, originator, license, format, and source display name.

Supported filters:

| Filter        | Examples                              | Meaning                                  |
| ------------- | ------------------------------------- | ---------------------------------------- |
| `tag:`        | `tag:metal`, `tag:"bullet impact"`    | Match one tag.                           |
| `license:`    | `license:cc0`, `license:by`           | Match normalized license id.             |
| `rights:`     | `rights:commercial`, `rights:unknown` | Match normalized use-rights flags.       |
| `duration:`   | `duration:<2`, `duration:0.2..1.5`    | Duration in seconds.                     |
| `format:`     | `format:wav`, `format:ogg`            | File/container format.                   |
| `codec:`      | `codec:pcm`, `codec:vorbis`           | Audio codec when known.                  |
| `rate:`       | `rate:44100`, `rate:>=48000`          | Sample rate in Hz.                       |
| `bitdepth:`   | `bitdepth:16`, `bitdepth:>=24`        | Bit depth when known.                    |
| `channels:`   | `channels:1`, `channels:stereo`       | Channel count or alias.                  |
| `size:`       | `size:<5mb`, `size:1mb..20mb`         | File size.                               |
| `source:`     | `source:local`, `source:freesound`    | Source type/provider/name.               |
| `provider:`   | `provider:freesound`                  | Cloud provider or local provider id.     |
| `path:`       | `path:physics/surfaces`               | Path substring or folder prefix.         |
| `collection:` | `collection:favorites`                | Collection membership.                   |
| `originator:` | `originator:valve`                    | Author/uploader/originator text.         |
| `rating:`     | `rating:>=4`                          | Provider rating when available.          |
| `modified:`   | `modified:2026-01-01..2026-02-01`     | Local modified date.                     |
| `indexed:`    | `indexed:<7d`                         | Indexed date or relative age.            |
| `imported:`   | `imported:true`                       | Cloud asset imported/downloaded locally. |
| `available:`  | `available:false`                     | Availability state.                      |
| `missing:`    | `missing:true`                        | Include unavailable local files.         |
| `favorite:`   | `favorite:true`                       | Favorite state.                          |
| `waveform:`   | `waveform:cached`                     | Waveform cache state.                    |
| `analyzed:`   | `analyzed:false`                      | Filter assets without level analysis.    |
| `peak:`       | `peak:>-3`                            | Full-file peak dBFS when analyzed.       |
| `rms:`        | `rms:-24..-12`                        | Full-file RMS dBFS when analyzed.        |
| `clipping:`   | `clipping:false`                      | Full-file clipping state.                |
| `headroom:`   | `headroom:>=3`                        | Full-file headroom in dB.                |

Operators:

- Text terms are ANDed by default.
- Quoted strings preserve spaces.
- Multiple values for the same field are ORed: `format:wav format:ogg`.
- Prefix `-` negates a term or filter: `-tag:music`, `-ambience`.
- Numeric filters support `<`, `<=`, `>`, `>=`, exact, and ranges with `..`.
- Unknown filters should not be silently ignored. Return a parse warning and keep the previous valid result set visible.

Parser output should be a typed query object:

```ts
type SearchQuery = {
  text: string[];
  filters: SearchFilter[];
  sort: SearchSort;
  sourceScope: SourceScope;
  includeUnavailable: boolean;
  activeFilterChips: SearchFilterChip[];
};
```

Backend search requests must include `query`, `sort`, `limit`, `cursor`, and `visibleWindowHint`. Search requests are cancellable; late responses must be discarded by request id.

### Search UX

- Debounce text input by 120-180 ms for local searches.
- Execute immediately on Enter.
- Do not trigger cloud API search unless the active source is cloud or cloud search is explicitly enabled.
- Show parse warnings inline below the search input or in the filter popover.
- Preserve search history as activity rows, not as ad hoc local component state.
- Keep the selected row stable when a search refresh returns the same asset id.

### Filter Builder UX

The filter builder should be a structured query surface for the full app. It must not be a hard-coded form with only tags, duration, and format.

Required groups:

- Location: source scope, provider, source, folder/path, collection, favorites, export queue.
- Text: tags, name/path text, description, originator/author/uploader.
- Rights: license ids and normalized use-rights flags with hover explanations.
- Audio: duration, format, codec, sample rate, bit depth, channels, file size.
- Status: available, missing, moved candidate, probe failed, unsupported, imported/downloaded, waveform cached, analysis state.
- Cloud: provider-specific uploader, rating, pack/item URL, preview/original availability.
- Dates: modified, indexed, imported, recently played, recently exported.
- Levels: full-file peak, RMS, clipping, and headroom when analysis is available.

Control requirements:

- Use searchable multi-select controls for tags, licenses, sources, providers, collections, formats, codecs, and status values.
- Use min/max range controls for duration, sample rate, bit depth, file size, peak, RMS, and headroom.
- Use date range controls for modified, indexed, imported, played, and exported dates.
- Use tri-state toggles for availability, favorite, imported/downloaded, analyzed, waveform cached, clipping, attribution required, commercial use allowed, and unknown license.
- Display active filters as removable chips next to the search bar.
- Support Apply, Clear all, Reset group, and Save search.
- Disable filters whose backing metadata is unavailable for the active source, and explain why in a tooltip.
- Build a typed `SearchQuery`; do not trigger rescans, database writes, or mock-row regeneration from filter UI changes.

### Sorting

Default sort:

1. Folder mode: folder rows first, then name ascending.
2. Search mode: best match, then name ascending.

Supported sort keys:

- Name
- Duration
- Modified time
- Format
- Sample rate
- Peak
- RMS
- Source
- File size
- Rating
- Imported date
- Indexed date
- Recently played
- Recently exported

Sort must be stable by `asset_id` as the final tie breaker.

### Virtualized List Contract

Use TanStack Virtual for the central list. The table must use fixed row height first; variable height can be introduced only if measured and benchmarked.

Default dimensions:

- File row height: 32 px.
- Folder row height: 32 px.
- Header height: 28-32 px.
- Overscan: 8-16 rows depending on scroll velocity.

Rendering rules:

- Render visible rows only.
- Row components receive plain row view models, not full asset records.
- No audio objects, decoded buffers, waveform arrays, or analysis jobs are created inside row render.
- Lazy metadata fetch may be scheduled for visible ids only.
- A row must render acceptably with partial metadata.
- Context menus and tooltips must mount lazily.

Data contract:

```ts
type BrowseRow =
  | {
      kind: "folder";
      id: string;
      name: string;
      childCount: number | null;
      sourceId: string;
      path: string;
      status: "indexed" | "indexing" | "partial" | "error";
    }
  | {
      kind: "asset";
      id: string;
      name: string;
      durationSeconds: number | null;
      sampleRate: number | null;
      bitDepth: number | null;
      channels: number | null;
      format: string | null;
      codec: string | null;
      fileSizeBytes: number | null;
      peakDbfs: number | null;
      rmsDbfs: number | null;
      clipping: boolean | null;
      headroomDb: number | null;
      sourceName: string;
      provider: string | null;
      relativePath: string;
      license: string | null;
      rightsSummary: string | null;
      originator: string | null;
      rating: number | null;
      imported: boolean;
      favorite: boolean;
      availability: "available" | "missing" | "cloud-preview" | "download-required";
    };
```

Column layout must be deterministic and user-resizable later. Initial columns should match the spec: name, duration, sample rate, bit depth, channels, format, peak, RMS, library/source, description/originator/license as optional columns. Optional columns can expose codec, file size, rating, provider, import state, favorite state, clipping, and headroom.

### Selection Model

Selection belongs to a dedicated browse state store, not row components.

Required state:

```ts
type BrowseSelectionState = {
  activeRowId: string | null;
  selectedRowIds: Set<string>;
  anchorRowId: string | null;
  lastUserIntent: "mouse" | "keyboard" | "programmatic";
};
```

Rules:

- Single click selects one row and sets active row.
- Ctrl-click toggles a row.
- Shift-click selects a range from anchor to clicked row.
- Up/down changes active row and selection to one row unless Ctrl is held.
- Shift+up/down extends range.
- PageUp/PageDown moves by visible page.
- Home/End moves to first/last result.
- Enter opens or focuses the detail/inspector target later.
- Space toggles play/pause later; before Phase 5 it should only emit a preview intent event.
- Selection must survive resort/search refresh by id when possible.

### Keyboard Model

Global shortcuts should be routed by a command layer that respects focused inputs.

Commands:

| Shortcut          | Command                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `F` or `Ctrl+F`   | Focus search                                                       |
| `Up/Down`         | Move active row                                                    |
| `Shift+Up/Down`   | Extend selection                                                   |
| `PageUp/PageDown` | Move by page                                                       |
| `Home/End`        | First/last row                                                     |
| `Space`           | Toggle preview playback intent                                     |
| `Enter`           | Open selected row action                                           |
| `L`               | Toggle loop intent, Phase 5+                                       |
| `G`               | Focus gain intent, Phase 8+                                        |
| `E`               | Focus export intent, Phase 9+                                      |
| `Ctrl+B`          | Add selected ids to export queue intent                            |
| `Esc`             | Clear transient UI, then clear selection if no transient UI exists |

Shortcut handling must ignore letter shortcuts while an input, textarea, select, slider, or editable field has focus.

### Backend/Search Index Contract

Phase 3 may use SQLite FTS5 or Tantivy. Pick one implementation behind a repository interface so the UI does not care.

Minimum API:

```ts
type BrowseRequest = {
  viewId: string;
  sourceScope: SourceScope;
  folderId?: string;
  collectionId?: string;
  query?: SearchQuery;
  sort: SearchSort;
  cursor?: string;
  limit: number;
};

type BrowseResponse = {
  requestId: string;
  rows: BrowseRow[];
  totalCount: number;
  nextCursor: string | null;
  warnings: SearchWarning[];
};
```

The backend owns filtering, sorting, and paging. The frontend owns active visible range, selection, and row rendering.

Production browsing must be database-backed through this request/response contract. Mock rows are development fixtures only and must be created once at provider setup, not regenerated during normal React render.

## Phase 4 - App Shell UI

### Shell Layout

Use a four-region shell inspired by the screenshot:

- Left sidebar: Libraries, Collections, Activity History only.
- Top bar: search, tabs, breadcrumbs, result count, filter/sort/view actions.
- Center: virtualized folder/file table.
- Bottom placeholder region: reserved for waveform/player in Phase 5/6.

Do not add the right processing inspector in Phase 4. Reserve layout capability for it, but implement it in Phase 8.

### Component Boundaries

Suggested frontend structure:

```text
src/
  app/
    AppProviders.tsx
    commandRegistry.ts
  features/
    browsing/
      browseTypes.ts
      browseStore.ts
      BrowseTable.tsx
      BrowseRow.tsx
      columns.ts
      searchGrammar.ts
      useBrowseQuery.ts
    shell/
      AppShell.tsx
      LeftSidebar.tsx
      TopSearchBar.tsx
      ViewTabs.tsx
      Breadcrumbs.tsx
      Toolbar.tsx
      BottomDockPlaceholder.tsx
    libraries/
      LibraryTree.tsx
      CollectionTree.tsx
      ActivityHistory.tsx
      sourceStatus.ts
    ui/
      existing shadcn components
```

Boundary rules:

- `shell` composes regions but does not know search parser internals.
- `browsing` owns query/view state and table rendering.
- `libraries` owns sidebar trees and source/collection/activity row models.
- `ui` contains shadcn generated primitives only.
- Tauri command wrappers live outside React components.
- No component should import from `src/App.tsx`.

### shadcn Usage

Use shadcn/ui for standard controls:

- `Button`
- `Input`
- `Tabs`
- `DropdownMenu`
- `ContextMenu`
- `Tooltip`
- `ScrollArea`
- `Resizable`
- `Command`
- `Badge`
- `Separator`
- `Toggle`
- `Switch`

Use custom components for:

- Virtualized file table
- Virtualized folder/source tree
- Waveform/player placeholder surface
- Audio meters later
- EQ curve later

Design rules:

- Dense dark UI.
- No marketing layout.
- No nested cards.
- Use thin separators and fixed row metrics.
- Selected state uses strong blue.
- Text truncates with tooltip for long names/paths.
- Icons should use `lucide-react`.

### Left Sidebar Contract

Sidebar sections:

- Libraries
- Collections
- Activity History

Libraries root:

```text
Libraries
  Cloud
  Local
```

Cloud and Local expand into sources, folders, or saved cloud queries. Collections supports nested folders and asset references. Activity History supports recent searches, plays, imports, exports, errors, and cloud downloads.

Tree requirements:

- Virtualized when row count exceeds 500.
- Disclosure state stored by stable id.
- Source status shown as connected, indexing, paused, offline, or error.
- Context menus are defined but may be disabled until backend actions exist.
- Drag-drop hooks are declared but can be no-op until Phase 10.

### Top Bar Contract

Top bar composition:

- Search input on left.
- View tabs next to or below search depending on available width.
- Breadcrumb row for active folder/source.
- Right actions: result count, filters, sort, view toggle, refresh/reindex, source settings.

Responsive behavior:

- Desktop width keeps search, tabs, toolbar visible.
- Narrow width moves secondary actions into a menu.
- Search remains reachable with `F` and `Ctrl+F`.

### Acceptance Tests

Automated tests should be added before marking Phase 3/4 done.

Unit tests:

- Search grammar parses free text.
- Search grammar parses quoted filters.
- Search grammar handles numeric comparisons and ranges.
- Filter builder state serializes to prefix grammar and typed `SearchQuery`.
- Filter builder round-trips grouped location, rights, audio, status, cloud, date, and level filters.
- Invalid filters return warnings.
- Selection reducer handles click, ctrl-click, shift-click, keyboard move, and range extension.
- Sort model serializes to backend request.

Component tests:

- Browse table renders only visible rows plus overscan.
- Row selection state updates without remounting all rows.
- Search input emits debounced query and immediate Enter query.
- Filter builder shows grouped filters, active chips, license explanations, and disabled metadata-unavailable filters.
- Sidebar renders only Libraries, Collections, Activity History sections.
- Long paths truncate and expose tooltip text.
- Keyboard shortcuts do not fire while typing in inputs.

Integration tests:

- 50k mock rows scroll without rendering all rows.
- Active row remains stable after a refreshed result set containing the same id.
- Late search response is ignored when a newer request completes first.
- Folder mode sorts folders before assets.
- Source status changes update sidebar row without resetting disclosure state.

Manual acceptance:

- User can browse a 50k-row mock dataset smoothly.
- User can use only keyboard to search, move selection, select ranges, and open row actions.
- UI shell matches the screenshot structure without adding non-library primary nav.
- The app still builds on Windows.

### Performance Checks

Required checks for Phase 3/4 completion:

- Mock 50k rows in development fixture.
- Scroll central list from top to bottom with no visible hitching.
- Verify React Profiler does not show full table rerenders on selection.
- Confirm row render does not trigger metadata, audio, waveform, or analysis work.
- Confirm memory does not grow unbounded while scrolling repeatedly.

### Implementation Order

1. Add typed search grammar and tests.
2. Add browse request/response types and mock provider.
3. Add selection reducer/store and tests.
4. Add virtualized table against mock provider.
5. Add keyboard command layer.
6. Add shell component boundaries using placeholder data.
7. Add sidebar tree contracts and placeholder rows.
8. Add integration/performance fixtures.
9. Wire real backend search only after contracts pass.

## Phase Exit Criteria

Phase 3 is complete when search grammar, backend request contracts, virtualization, selection, keyboard navigation, and mock large-list tests pass.

Phase 4 is complete when the production app shell components exist behind clear boundaries, the sidebar contains only the approved sections, the top search/navigation structure is in place, and no product processing UI has been implemented early.
