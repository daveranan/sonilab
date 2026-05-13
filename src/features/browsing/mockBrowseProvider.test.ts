import { describe, expect, it, vi } from "vitest";

import { parseSearchGrammar } from "./searchGrammar";
import {
  createMockBrowseProvider,
  createMockBrowseRows,
  getDefaultMockBrowseRows,
  LatestBrowseResponseGate,
} from "./mockBrowseProvider";
import { defaultSearchSort } from "./sortModel";

describe("mock browse provider", () => {
  it("creates a 50k-row performance fixture", () => {
    const rows = createMockBrowseRows(50_000);

    expect(rows).toHaveLength(50_000);
    expect(rows[0]?.kind).toBe("folder");
    expect(rows[rows.length - 1]?.id).toMatch(/^asset-/);
  });

  it("reuses the default performance fixture", () => {
    expect(getDefaultMockBrowseRows()).toBe(getDefaultMockBrowseRows());
  });

  it("filters and returns result counts", async () => {
    const provider = createMockBrowseProvider(createMockBrowseRows(500), 0);
    const { query } = parseSearchGrammar("tag:impact format:wav missing:false");
    const response = await provider.browse({
      requestId: "one",
      viewId: "test",
      sourceScope: { kind: "all" },
      query,
      sort: defaultSearchSort,
      limit: 50,
    });

    expect(response.requestId).toBe("one");
    expect(response.totalCount).toBeGreaterThan(0);
    expect(response.rows.length).toBeLessThanOrEqual(50);
  });

  it("serves repeated browse requests from cache without another timer", async () => {
    vi.useFakeTimers();
    const provider = createMockBrowseProvider(createMockBrowseRows(500), 25);
    const { query } = parseSearchGrammar("tag:impact");
    const request = {
      viewId: "test",
      sourceScope: { kind: "all" as const },
      query,
      sort: defaultSearchSort,
      limit: 50,
    };

    const first = provider.browse({ ...request, requestId: "one" });
    await vi.runAllTimersAsync();
    await first;

    const second = await provider.browse({ ...request, requestId: "two" });
    vi.useRealTimers();

    expect(second.requestId).toBe("two");
    expect(second.totalCount).toBeGreaterThan(0);
  });

  it("discards late browse responses by request id", () => {
    const gate = new LatestBrowseResponseGate();
    gate.begin("older");
    gate.begin("newer");

    expect(
      gate.accept({
        requestId: "older",
        rows: [],
        totalCount: 0,
        nextCursor: null,
        warnings: [],
      }),
    ).toBe(false);
    expect(
      gate.accept({
        requestId: "newer",
        rows: [],
        totalCount: 0,
        nextCursor: null,
        warnings: [],
      }),
    ).toBe(true);
  });

  it("lazy-loads metadata only for requested visible rows", async () => {
    vi.useFakeTimers();
    const provider = createMockBrowseProvider(createMockBrowseRows(100), 12);
    const promise = provider.loadVisibleMetadata({
      requestId: "metadata",
      rowIds: ["asset-00001", "asset-00002"],
      visibleWindowHint: {
        startIndex: 1,
        endIndex: 2,
        rowIds: ["asset-00001", "asset-00002"],
      },
    });

    await vi.runAllTimersAsync();
    const response = await promise;
    vi.useRealTimers();

    expect(Object.keys(response.metadataByRowId)).toEqual([
      "asset-00001",
      "asset-00002",
    ]);
  });
});
