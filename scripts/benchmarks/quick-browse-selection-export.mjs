import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const outputDir = path.resolve("benchmark-results");
const fixtureDir = path.join(outputDir, "fixtures");
const fixturePath = path.join(fixtureDir, "waveform-cache.slwf");
const outputPath = path.join(outputDir, "quick-browse-selection-export.json");
const channelCount = 2;
const peakCount = 32_000;
const rangePeakCount = 4096;
const iterations = 120;

mkdirSync(fixtureDir, { recursive: true });

function createFixture() {
  const headerBytes = 16;
  const payloadBytes = channelCount * peakCount * 4;
  const buffer = Buffer.alloc(headerBytes + payloadBytes);
  buffer.write("SLWAVE1\0", 0, "latin1");
  buffer.writeUInt32LE(channelCount, 8);
  buffer.writeUInt32LE(peakCount, 12);
  let offset = headerBytes;
  for (let peak = 0; peak < peakCount; peak += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const phase = (peak + channel * 17) / 113;
      const max = Math.round(Math.sin(phase) * 16384 + 16384);
      const min = -max;
      buffer.writeInt16LE(Math.max(-32767, min), offset);
      buffer.writeInt16LE(Math.min(32767, max), offset + 2);
      offset += 4;
    }
  }
  writeFileSync(fixturePath, buffer);
}

function readRange(buffer, startPeak, count) {
  const values = new Int16Array(channelCount * count * 2);
  let output = 0;
  let offset = 16 + startPeak * channelCount * 4;
  for (let peak = 0; peak < count; peak += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      values[output] = buffer.readInt16LE(offset);
      values[output + 1] = buffer.readInt16LE(offset + 2);
      output += 2;
      offset += 4;
    }
  }
  return values;
}

function percentile(samples, percentileValue) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.floor((percentileValue / 100) * sorted.length),
  );
  return Number(sorted[index].toFixed(4));
}

createFixture();
const buffer = readFileSync(fixturePath);
const samples = [];
for (let index = 0; index < iterations; index += 1) {
  const startPeak = (index * 197) % (peakCount - rangePeakCount);
  const startedAt = performance.now();
  readRange(buffer, startPeak, rangePeakCount);
  samples.push(performance.now() - startedAt);
}

const result = {
  benchmark: "quick-browse-selection-export",
  generatedAt: new Date().toISOString(),
  waveformCache: {
    fixtureBytes: buffer.byteLength,
    channelCount,
    peakCount,
    rangePeakCount,
    iterations,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Number(Math.max(...samples).toFixed(4)),
  },
  notes: [
    "Measures local binary waveform range-read parsing only.",
    "App-level audible playback and native drag latency still require an in-app benchmark harness.",
  ],
};

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
rmSync(fixtureDir, { recursive: true, force: true });
console.log(`Wrote ${outputPath}`);
