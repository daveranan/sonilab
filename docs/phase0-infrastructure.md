# Phase 0 Infrastructure

This document covers setup-only pieces that are safe before product features exist.

## App Config Schema

`src/config/app-config.ts` defines the validated config shape for:

- Local and cloud library sources
- Cache limits
- Audio output defaults
- Export defaults
- FFmpeg location and minimum version
- Cloud credential references

This is schema and defaults only. Persistence, encrypted credential storage, and settings UI belong to later phases.

The Tauri backend exposes `app_paths` so the renderer can resolve config, data, cache, and log locations without hard-coding Windows paths.

## SQLite Migrations

Migration files live in `src-tauri/migrations`.

The backend embeds the migration catalog and exposes `migration_status` and `run_migrations`. The runner records applied versions in `schema_migrations` and applies pending `*.up.sql` files to the app SQLite database.

## Logging and Error Hooks

`src/lib/logger.ts` provides a structured logger with injectable sinks.

`src/lib/error-hooks.ts` installs browser-level handlers for unhandled errors and promise rejections. Local log export writes newline-delimited JSON through the Tauri backend when running in the desktop shell.

## FFmpeg Validation

Run:

```powershell
npm run validate:ffmpeg
```

Lookup order:

1. `FFMPEG_PATH`
2. `src-tauri/bin/ffmpeg.exe`
3. `ffmpeg` from `PATH`

The script requires FFmpeg `6.0+` by default. Override with `FFMPEG_MIN_VERSION`.

To stage the Windows sidecar for packaging:

```powershell
$env:FFMPEG_PATH = "C:\path\to\ffmpeg.exe"
npm run package:ffmpeg
```

This copies the validated binary to `src-tauri/bin/ffmpeg.exe`. The binary itself is not committed.

## Audio Fixtures

Run:

```powershell
npm run fixtures:audio
```

The fixture generator creates `test-fixtures/audio/short-tone.wav` without external tools. If FFmpeg is available, it also creates MP3, OGG Vorbis, and FLAC versions.

## Performance Harness

Run:

```powershell
npm run benchmark:phase0
```

The Phase 0 harness writes `benchmark-results/phase0-baseline.json` with placeholder cases for indexing, scrolling, search, preview switching, waveform generation, and export. Real measurements are added as those features land.
