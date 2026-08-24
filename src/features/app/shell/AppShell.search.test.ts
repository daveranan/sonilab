import { describe, expect, it } from "vitest";

import type { BrowseRow } from "@/features/browsing/browseTypes";

import { relatedTagOptionsForRows, relatedTagQuery } from "./AppShell";

describe("related search", () => {
  it("creates an any-tag query from distinct selected-asset tags", () => {
    expect(relatedTagQuery(["cloth", "rubbing", "cloth", "foley"])).toBe(
      'tagany:"cloth|rubbing|foley"',
    );
  });

  it("does not create a query without useful tags", () => {
    expect(relatedTagQuery(["", "   "])).toBe("");
  });

  it("ranks tags co-occurring in the current results and excludes searched tags", () => {
    const rows = [
      { kind: "asset", tags: ["rubbing", "cloth", "foley"] },
      { kind: "asset", tags: ["rubbing", "cloth", "scrape"] },
      { kind: "asset", tags: ["rubbing", "cotton", "foley"] },
    ] as unknown as BrowseRow[];

    expect(relatedTagOptionsForRows(rows, ["rubbing"]).slice(0, 4)).toEqual([
      { tag: "cloth", count: 2 },
      { tag: "foley", count: 2 },
      { tag: "cotton", count: 1 },
      { tag: "scrape", count: 1 },
    ]);
  });
});
