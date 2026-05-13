import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { createMockBrowseRows } from "./mockBrowseProvider";
import { createVisibleWindowHint } from "./BrowseTable";

describe("local browsing performance regression guards", () => {
  it("builds a visible window hint from a large local result set quickly", () => {
    const rows = createMockBrowseRows(50_000);
    const virtualRows = Array.from({ length: 64 }, (_, offset) => ({
      index: 20_000 + offset,
    }));

    const started = performance.now();
    const hint = createVisibleWindowHint(rows, virtualRows);
    const elapsedMs = performance.now() - started;

    expect(hint?.rowIds).toHaveLength(64);
    expect(elapsedMs).toBeLessThan(16);
  });
});
