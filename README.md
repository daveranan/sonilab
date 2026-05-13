# Sonilabs Sound Library Processor

Desktop sound library browser, previewer, processor, and exporter for large local audio collections.

## GitHub Description

Local-first desktop app for browsing, previewing, analyzing, processing, and exporting large sound libraries.

## Overview

Sonilabs Sound Library Processor is a Windows desktop app built with Tauri, React, TypeScript, Rust, and SQLite. It is designed for fast local sound library workflows: indexing folders, searching audio assets, previewing sounds, inspecting waveforms, adjusting gain, and exporting full files or selected regions.

The app is local-first. Audio files, cache data, analysis, and export jobs stay on the user's machine unless a future cloud source integration is explicitly added.

## Features

- Browse and index large local sound libraries
- Search by name, metadata, folder, format, tags, and library source
- Preview audio with waveform display and region selection
- Adjust preview/export gain with shared processing settings
- Queue full-file and selected-region exports
- Drag prepared exports out of the app
- Store local app data in SQLite
- Package as Windows NSIS and MSI installers

## Status

This project is in active development. Windows packaging is configured, but production distribution still needs release signing and updater setup before broad installation.

## Development

```powershell
npm install
npm run tauri:dev
```

## Verification

```powershell
npm run typecheck
npm run lint
npm run test
npm run build
```

## Windows Packaging

```powershell
npm run build:windows
```

Windows packaging requires Node.js, npm, Rust/Cargo, Visual Studio Build Tools with C++ support, Microsoft Edge WebView2 Runtime, and the FFmpeg sidecar. See `docs/windows-build.md` for the full checklist.

## Updates

Automatic updates use Tauri updater artifacts published through GitHub Releases. Tag builds upload the Windows installers, signatures, and `latest.json`; installed apps check the latest release metadata and install signed updates.

Release signing requires the private updater key in `TAURI_SIGNING_PRIVATE_KEY`.
