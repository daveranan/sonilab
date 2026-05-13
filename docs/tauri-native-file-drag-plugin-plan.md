# Tauri Native File Drag Plugin Plan

## Goal

Support dragging a rendered waveform region out of the Tauri app as a real OS file, equivalent to Electron `webContents.startDrag`.

Primary target: Windows.

## User Workflow

1. User selects a waveform region.
2. User chooses export format in the bottom player.
3. User drags the selected region out of the waveform.
4. App renders a temp file using the selected region, export format, and gain.
5. Native drag starts with that temp file as a shell file payload.
6. User drops into Explorer, DAW, game editor, or another app.

## Why HTML Drag Is Not Enough

Browser drag-and-drop can set `File`, `text/plain`, or `text/uri-list` during `dragstart`, but native Windows apps usually expect shell file-drop data. Electron solves this with `webContents.startDrag`; Tauri does not expose an equivalent high-level API.

## Architecture

Frontend:

- Detect drag start on an existing waveform selection.
- Ask backend to prepare/render temp file before native drag starts.
- Call plugin command with temp file path and optional drag icon path.
- Show pending, ready, failed, and dragging states.

Rust/Tauri plugin:

- Validate temp file path exists.
- Start a native Windows file drag source.
- Expose the file as shell file-drop data.
- Return success/failure diagnostics.

Export backend:

- Render selected region to temp file.
- Use current export format and gain.
- Reuse Phase 9 export pipeline.
- Register temp file for cleanup.

## Windows Implementation Direction

Implement a Windows-only Tauri plugin using Win32/COM drag-and-drop:

- `DoDragDrop`
- `IDataObject`
- `IDropSource`
- `DROPFILES` / `CF_HDROP`
- optional `IStream`/virtual file support later

MVP should use real temp files on disk, not virtual streams.

Data formats:

- `CF_HDROP` for shell-compatible file paths.
- Optional `FileNameW` / `FileName` compatibility formats if needed.

Drag effect:

- Default to copy.
- Do not move/delete the temp file after drop.

## Plugin API

Tauri command:

```ts
type StartNativeFileDragRequest = {
  filePath: string;
  iconPath?: string;
  displayName?: string;
  allowedEffect: "copy";
};
```

Response:

```ts
type StartNativeFileDragResponse = {
  ok: boolean;
  effect: "copy" | "none";
  error?: string;
  diagnostics?: string[];
};
```

Frontend helper:

```ts
async function dragRenderedRegionAsFile(request: {
  assetId: string;
  regionStartSeconds: number;
  regionEndSeconds: number;
  format: ExportFormat;
  gainDb: number;
}): Promise<void>;
```

## UX Requirements

- Drag handle is the selected waveform region.
- No text selection.
- While preparing temp file, show a compact overlay: `Preparing file...`.
- When native drag starts, de-emphasize app UI.
- If preparation fails, keep region and playback state intact.
- If native drag fails, offer `Reveal temp file` and explicit export.

## Temp File Policy

- Store under app cache/temp export directory.
- Include safe filename from asset name, region, and format.
- Keep files after successful drag for a short TTL.
- Clean stale temp drag files on app startup and periodically.
- Never delete user source files.

## Testing Plan

Rust tests:

- Path validation rejects missing files.
- Command rejects directories.
- Temp cleanup preserves fresh files and removes stale generated files.

Manual Windows tests:

- Drag WAV region to Explorer.
- Drag WAV region to Ableton/Reaper/DAW.
- Drag MP3/OGG region after Phase 9 encoders exist.
- Cancel drag before drop.
- Drop into an unsupported target.
- Repeat rapid drags without temp cleanup races.

Diagnostics:

- Log native drag start result.
- Log selected effect.
- Log target-independent failures.
- Include OS/version and WebView2/Tauri version in diagnostics.

## Risks

- COM drag source implementation complexity.
- Blocking UI thread if drag is started incorrectly.
- DAWs may vary in accepted formats.
- Cross-platform behavior requires separate macOS/Linux implementations.
- Tauri window/webview may not expose enough native handle context; plugin may need app/window integration.

## Fallbacks

- Reveal temp file in Explorer.
- Copy temp file path to clipboard.
- Explicit export button.
- Optional Electron shell migration if native Tauri drag proves too costly.

## Acceptance Criteria

- User can drag selected waveform region to Windows Explorer as a real file.
- User can drag selected waveform region into at least one target DAW/editor as a real file.
- Drag uses current export format and gain.
- Drag uses exact selected region boundaries.
- Failure is recoverable and does not clear selection or playback state.
- Implementation is isolated as a Tauri plugin/bridge, not scattered across UI code.
