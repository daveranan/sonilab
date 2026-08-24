import { describe, expect, it } from "vitest";

import type { SearchFilterChip } from "@/features/browsing/browseTypes";

import { queryValueFromChipsAndInput } from "./TopSearchBar";

describe("top search bar input", () => {
  it("preserves a trailing space while entering multiple search words", () => {
    expect(queryValueFromChipsAndInput([], "metal ")).toBe("metal ");
  });

  it("preserves editable input after a filter chip", () => {
    const chips: SearchFilterChip[] = [
      {
        id: "tag-0",
        label: "tag:rubbing",
        field: "tag",
        negated: false,
      },
    ];
    expect(queryValueFromChipsAndInput(chips, "cloth ")).toBe(
      "tag:rubbing cloth ",
    );
  });
});
