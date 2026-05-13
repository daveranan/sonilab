# Phase 1 - Core Data Layer

## Scope

Design the SQLite data layer for local and cloud sound browsing, processing analysis, collections, activity history, presets, and export jobs.

This phase should not modify frontend UI. Rust integration can stay minimal until the local Rust toolchain is available.

## Database Direction

Use SQLite as the app source of truth for indexed metadata and user state.

Use the filesystem cache for heavy binary artifacts:

- decoded preview files
- downloaded cloud previews
- waveform peak payloads if they become too large for SQLite
- temporary export outputs

SQLite stores paths, cache keys, job state, searchable metadata, and compact waveform summaries.

## Migration Strategy

Migration files live in `src-tauri/migrations`.

The initial schema is:

- `001_core_data_layer.up.sql`
- `001_core_data_layer.down.sql`

Future Rust wiring should use a real migration runner instead of ad hoc SQL execution. Preferred crates: `sqlx` with SQLite migrations, or `rusqlite` plus `refinery`.

## Core Tables

### sources

Represents a root local folder or cloud provider account/query source.

Key decisions:

- `kind` is constrained to `local` or `cloud`.
- `provider` allows `local`, `freesound`, `internet_archive`, `opengameart`, etc.
- `root_uri` stores a local path or provider root URL/identifier.
- `settings_json` stores provider-specific config that does not deserve columns yet.

### folders

Represents folder hierarchy under a source.

Key decisions:

- Local folders use normalized absolute paths.
- Cloud folders can represent provider categories, virtual searches, packs, or curated groupings.
- `source_id + path` is unique for stable upsert.

### assets

Represents a single local file or cloud sound.

Key decisions:

- `stable_key` is the main idempotent upsert key per source.
- Local stable keys should derive from normalized path plus file size and modified time until content hashing is available.
- Cloud stable keys should use provider asset IDs.
- Heavy metadata remains in `metadata_json`; commonly filtered fields get columns.

### asset_tags

Stores searchable tags without repeatedly parsing JSON.

### analysis

Stores measured levels for original and processed audio.

Key decisions:

- `scope` is `full` or `region`.
- `processing_hash` separates original analysis from gain/EQ/limiter variants.
- Region rows include `region_start_seconds` and `region_end_seconds`.

### waveform_peaks

Stores waveform cache metadata and optional compact peak JSON.

Key decisions:

- Use `cache_key` for filesystem-backed peak data.
- Keep `peaks_json` nullable so large peak payloads can live outside SQLite.
- Include resolution and channel count so renderers can select compatible cached data.

### collections and collection_items

Collections are user-owned folders that reference assets without duplicating source files.

Key decisions:

- Collections support nested folders through `parent_id`.
- Collection items can point to an asset or to a source/folder reference.
- This supports dragging folders into collections as references.

### activity

Records recent actions and recoverable navigation state.

Key decisions:

- Activity rows are compact and queryable by `created_at`.
- `payload_json` stores view restoration data for searches, exports, imports, and cloud actions.

### presets

Stores processing presets.

Key decisions:

- Presets are JSON-heavy because EQ/limiter/normalization settings will evolve.
- Common gain/normalization/limiter fields stay queryable.

### export_jobs

Stores export queue and history.

Key decisions:

- Jobs can target one asset, a collection, or a saved query.
- `processing_json` and `format_settings_json` keep the export pipeline flexible.
- Failed jobs remain recoverable with error fields and retry state.

### cache_entries

Tracks generated files and eviction metadata.

Key decisions:

- Cache records are generic: preview, waveform, analysis, cloud_preview, export_temp.
- Eviction can use `last_accessed_at`, `byte_size`, and `pinned`.

## Indexing Requirements

The schema must support:

- source tree rendering
- stable asset upserts
- folder-level browsing
- fast search setup in Phase 3
- deferred waveform and analysis jobs
- missing-file state without destructive deletes
- cloud metadata and license tracking
- export queue recovery after restart

## Open Implementation Notes

Add FTS5 in Phase 3 after search grammar is finalized.

Add a Rust migration runner only when Rust dependencies can be compiled locally or in CI.

Do not store cloud credentials directly in SQLite unless encrypted storage is added. Store credential references in settings, and use OS credential storage later.
