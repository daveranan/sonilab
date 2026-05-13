import { describe, expect, it } from "vitest";

import { expandSearchTerm, expandSearchTerms } from "./searchExpansion";

describe("search expansion", () => {
  it("expands whoosh-like terms without mutating tags", () => {
    expect(expandSearchTerm("whoosh")).toEqual([
      "whoosh",
      "woosh",
      "swoosh",
      "swish",
      "sweep",
      "sweeper",
      "riser",
      "passby",
      "air",
    ]);
  });

  it("keeps clanking as search expansion rather than hard hihat tagging", () => {
    const expanded = expandSearchTerm("clanking");

    expect(expanded).toContain("metal");
    expect(expanded).not.toContain("hihat");
  });

  it("does not expand negated terms", () => {
    expect(expandSearchTerms(["whoosh", "-metal"])).toContain("-metal");
  });
});
