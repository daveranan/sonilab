import { describe, expect, it } from "vitest";

import type { BrowseRequest } from "./browseTypes";
import { buildBackendQuery } from "./dbBrowseProvider";
import { parseSearchGrammar } from "./searchGrammar";
import { defaultSearchSort } from "./sortModel";

function requestFor(queryText: string): BrowseRequest {
  return {
    requestId: "test",
    viewId: "test",
    sourceScope: { kind: "local" },
    query: parseSearchGrammar(queryText).query,
    sort: defaultSearchSort,
    limit: 100,
  };
}

describe("database browse provider", () => {
  it("expands synonyms as alternatives, not required terms", () => {
    expect(buildBackendQuery(requestFor("metal"))).toBe(
      '("metal" OR "clank" OR "clanking" OR "clang" OR "clanging" OR "metallic")',
    );
  });

  it("keeps separate free-text terms as required groups", () => {
    expect(buildBackendQuery(requestFor("metal impact"))).toBe(
      '("metal" OR "clank" OR "clanking" OR "clang" OR "clanging" OR "metallic") ("impact" OR "hit" OR "hits" OR "slam" OR "thud" OR "punch")',
    );
  });

  it("quotes filter terms for FTS", () => {
    expect(buildBackendQuery(requestFor("format:ogg source:boom"))).toBe(
      '"ogg" "boom"',
    );
  });
});
