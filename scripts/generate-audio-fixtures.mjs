import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const fixtureDir = path.resolve("test-fixtures", "audio");
const wavPath = path.join(fixtureDir, "short-tone.wav");

mkdirSync(fixtureDir, { recursive: true });

function writeShortToneWav(filePath) {
  const sampleRate = 44_100;
  const durationSeconds = 0.35;
  const samples = Math.floor(sampleRate * durationSeconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples; index += 1) {
    const envelope = 1 - index / samples;
    const value = Math.sin((2 * Math.PI * 880 * index) / sampleRate);
    const sample = Math.round(value * envelope * 0.65 * 32767);
    buffer.writeInt16LE(sample, 44 + index * 2);
  }

  writeFileSync(filePath, buffer);
}

function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    path.resolve("src-tauri", "bin", "ffmpeg.exe"),
    "ffmpeg",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate !== "ffmpeg" && !existsSync(candidate)) {
      continue;
    }

    const result = spawnSync(candidate, ["-version"], {
      encoding: "utf8",
      windowsHide: true,
    });

    if (!result.error && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function transcode(ffmpeg, outputName, args) {
  const outputPath = path.join(fixtureDir, outputName);
  const result = spawnSync(
    ffmpeg,
    ["-y", "-hide_banner", "-loglevel", "error", "-i", wavPath, ...args, outputPath],
    { encoding: "utf8", windowsHide: true },
  );

  return {
    file: outputName,
    generated: result.status === 0,
    error: result.status === 0 ? null : result.stderr.trim(),
  };
}

writeShortToneWav(wavPath);

const ffmpeg = findFfmpeg();
const conversions = ffmpeg
  ? [
      transcode(ffmpeg, "short-tone.mp3", ["-c:a", "libmp3lame", "-b:a", "128k"]),
      transcode(ffmpeg, "short-tone.ogg", ["-c:a", "libvorbis", "-q:a", "4"]),
      transcode(ffmpeg, "short-tone.flac", ["-c:a", "flac"]),
    ]
  : [];

const manifest = {
  generatedAt: new Date().toISOString(),
  source: "Synthetic 880 Hz decaying sine tone for tests only.",
  ffmpeg: ffmpeg ?? null,
  files: [{ file: "short-tone.wav", generated: true, error: null }, ...conversions],
  skipped: ffmpeg ? [] : ["short-tone.mp3", "short-tone.ogg", "short-tone.flac"],
};

writeFileSync(
  path.join(fixtureDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Audio fixtures updated in ${fixtureDir}.`);
if (!ffmpeg) {
  console.log("FFmpeg not found; compressed fixtures were skipped.");
}
