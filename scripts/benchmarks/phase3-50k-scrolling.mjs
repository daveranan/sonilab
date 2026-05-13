import { mkdirSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const rowCount = 50_000;
const rowHeight = 32;
const viewportHeight = 640;
const overscan = 12;
const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
const rows = Array.from({ length: rowCount }, (_, index) => `asset-${index}`);
const selected = new Set(["asset-0"]);

let activeRowId = "asset-0";
let worstWindowMs = 0;
const start = performance.now();

for (let scrollTop = 0; scrollTop < rowCount * rowHeight; scrollTop += rowHeight * 17) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rowCount - 1, first + visibleCount - 1);
  const windowStart = performance.now();
  const visible = rows.slice(first, last + 1).map((id) => ({
    id,
    active: id === activeRowId,
    selected: selected.has(id),
  }));
  activeRowId = visible[Math.floor(visible.length / 2)]?.id ?? activeRowId;
  selected.clear();
  selected.add(activeRowId);
  worstWindowMs = Math.max(worstWindowMs, performance.now() - windowStart);
}

const elapsedMs = performance.now() - start;
const report = {
  benchmark: "phase3-50k-scrolling-active-selection",
  rowCount,
  rowHeight,
  viewportHeight,
  overscan,
  visibleCount,
  elapsedMs: Number(elapsedMs.toFixed(3)),
  worstWindowMs: Number(worstWindowMs.toFixed(3)),
  activeRowId,
  selectedCount: selected.size,
  passed: worstWindowMs < 16,
};

mkdirSync("benchmark-results", { recursive: true });
writeFileSync(
  "benchmark-results/phase3-50k-scrolling.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report, null, 2));
