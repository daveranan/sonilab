# Windows Build Requirements

The app must build and run on Windows from Phase 0 onward.

## Required Tools

- Node.js 24 LTS or newer
- npm 11 or newer
- Rust stable toolchain with Cargo
- Microsoft Visual Studio Build Tools with Desktop development with C++
- Microsoft Edge WebView2 Runtime
- FFmpeg sidecar available to the Tauri backend

## Commands

```powershell
npm install
npm run format:check
npm run typecheck
npm run lint
npm run test
npm run build
npm run validate:ffmpeg
npm run smoke:release
npm run release:check-signing
npm run tauri:dev
npm run build:windows
```

## FFmpeg Sidecar

FFmpeg validation checks `FFMPEG_PATH`, then `src-tauri/bin/ffmpeg.exe`, then `ffmpeg` from `PATH`. Set `FFMPEG_PATH` and run `npm run package:ffmpeg` to stage `src-tauri/bin/ffmpeg.exe` before release packaging.

## Windows Signing Readiness

`src-tauri/tauri.conf.json` is configured for NSIS and MSI bundles, SHA-256 signing, timestamping, and downgrade blocking. Actual signing still requires a Windows code-signing certificate via either `bundle.windows.certificateThumbprint` or `bundle.windows.signCommand`.

Run `npm run release:check-signing` before release. It passes for signing-ready local builds and warns when certificate/updater secrets are absent.

## Update Readiness

The app uses Tauri's updater with GitHub Releases metadata at `https://github.com/daveranan/sonilab/releases/latest/download/latest.json`.

Release packaging requires `TAURI_SIGNING_PRIVATE_KEY`. The matching public key is stored in `src-tauri/tauri.conf.json`; the private key must stay out of Git and should be stored as a GitHub Actions secret. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional when the key was generated without a password.

## Current Machine Status

Node and npm are installed. Rust/Cargo are not currently available in PATH, so `npm run build:windows` cannot complete on this machine until Rust is installed.
