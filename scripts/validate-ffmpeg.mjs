import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const minimumVersion = process.env.FFMPEG_MIN_VERSION ?? "6.0";
const sidecarName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const candidates = [
  process.env.FFMPEG_PATH,
  path.resolve("src-tauri", "bin", sidecarName),
  "ffmpeg",
].filter(Boolean);

function runFfmpeg(candidate) {
  if (candidate !== "ffmpeg" && !existsSync(candidate)) {
    return null;
  }

  const result = spawnSync(candidate, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const version = output.match(/ffmpeg version\s+([^\s]+)/)?.[1] ?? "unknown";

  return { candidate, version, output };
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

for (const candidate of candidates) {
  const ffmpeg = runFfmpeg(candidate);

  if (!ffmpeg) {
    continue;
  }

  if (!isAtLeast(ffmpeg.version, minimumVersion)) {
    console.error(
      `FFmpeg ${ffmpeg.version} found at ${ffmpeg.candidate}, but ${minimumVersion}+ is required.`,
    );
    process.exit(1);
  }

  console.log(`FFmpeg ${ffmpeg.version} found at ${ffmpeg.candidate}.`);
  process.exit(0);
}

console.error(
  `FFmpeg not found. Set FFMPEG_PATH, add ffmpeg to PATH, or place ${sidecarName} in src-tauri/bin.`,
);
process.exit(1);
