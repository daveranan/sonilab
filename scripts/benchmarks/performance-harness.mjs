import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const outputDir = path.resolve("benchmark-results");
const outputPath = path.join(outputDir, "phase0-baseline.json");

const cases = [
  "indexing",
  "scrolling",
  "search",
  "preview-switching",
  "waveform-generation",
  "export",
];

function measurePlaceholder(name) {
  const startedAt = performance.now();
  const finishedAt = performance.now();

  return {
    name,
    status: "skipped",
    reason: "Feature implementation belongs to later phases.",
    durationMs: Number((finishedAt - startedAt).toFixed(3)),
  };
}

mkdirSync(outputDir, { recursive: true });

const report = {
  generatedAt: new Date().toISOString(),
  phase: "0",
  machine: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
  },
  cases: cases.map(measurePlaceholder),
};

writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Performance harness wrote ${outputPath}.`);
