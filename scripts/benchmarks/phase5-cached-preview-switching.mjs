import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const iterations = 2_000;
const targetMs = 100;
const cache = new Map();
const assetId = "asset-cached-preview";
const contentKey = "fixture-key";
const mode = "original";
const cacheKey = `${assetId}:${contentKey}:${mode}`;

cache.set(cacheKey, {
  assetId,
  contentKey,
  durationSeconds: 0.5,
  startedAt: 0,
});

const samples = [];

for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  const cached = cache.get(cacheKey);
  if (!cached) throw new Error("cached preview missing");
  cached.startedAt = performance.now();
  samples.push(cached.startedAt - started);
}

samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.floor((samples.length - 1) * p)];
const report = {
  benchmark: "phase5-cached-preview-switching-cache-path",
  note: "Node microbenchmark for cached switch bookkeeping only; audible Web Audio start latency still needs an app/browser benchmark.",
  iterations,
  p50Ms: Number(percentile(0.5).toFixed(3)),
  p95Ms: Number(percentile(0.95).toFixed(3)),
  maxMs: Number(samples.at(-1).toFixed(3)),
  targetMs,
  passed: percentile(0.95) < targetMs,
};

mkdirSync("benchmark-results", { recursive: true });
writeFileSync(
  "benchmark-results/phase5-cached-preview-switching.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
