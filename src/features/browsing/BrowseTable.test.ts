import { describe, expect, it } from "vitest";

import { createMockBrowseRows } from "./mockBrowseProvider";
import { createVisibleWindowHint } from "./BrowseTable";

describe("browse table virtualization", () => {
  it("reports only the bounded rendered window", () => {
    const rows = createMockBrowseRows(50_000);
    const virtualRows = Array.from({ length: 42 }, (_, offset) => ({
      index: 1_000 + offset,
    }));

    const hint = createVisibleWindowHint(rows, virtualRows);

    expect(hint?.startIndex).toBe(1_000);
    expect(hint?.endIndex).toBe(1_041);
    expect(hint?.rowIds).toHaveLength(42);
    expect(hint?.rowIds.length).toBeLessThan(rows.length);
  });
});
