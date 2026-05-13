import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = process.env.FFMPEG_PATH;
const minimumVersion = process.env.FFMPEG_MIN_VERSION ?? "6.0";
const sidecarDir = path.resolve("src-tauri", "bin");
const sidecarPath = path.join(sidecarDir, "ffmpeg.exe");

if (!source) {
  console.error("Set FFMPEG_PATH to the ffmpeg.exe to stage.");
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`FFmpeg source not found: ${source}`);
  process.exit(1);
}

function versionParts(version) {
  return version
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function isAtLeast(version, minimum) {
  const current = versionParts(version);
  const required = versionParts(minimum);

  if (current.length === 0 || required.length === 0) {
    return true;
  }

  for (let index = 0; index < required.length; index += 1) {
    const left = current[index] ?? 0;
    const right = required[index] ?? 0;

    if (left > right) return true;
    if (left < right) return false;
  }

  return true;
}

const validation = spawnSync(source, ["-version"], {
  encoding: "utf8",
  windowsHide: true,
});

if (validation.error || validation.status !== 0) {
  console.error(`FFmpeg validation failed for ${source}.`);
  process.exit(1);
}

const output = `${validation.stdout}\n${validation.stderr}`;
const version = output.match(/ffmpeg version\s+([^\s]+)/)?.[1] ?? "unknown";

if (!isAtLeast(version, minimumVersion)) {
  console.error(
    `FFmpeg ${version} found at ${source}, but ${minimumVersion}+ is required.`,
  );
  process.exit(1);
}

mkdirSync(sidecarDir, { recursive: true });
copyFileSync(source, sidecarPath);

console.log(`Staged FFmpeg ${version} sidecar at ${sidecarPath}.`);
