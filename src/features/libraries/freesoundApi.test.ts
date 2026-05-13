import { describe, expect, it } from "vitest";

import { parseSearchGrammar } from "@/features/browsing/searchGrammar";

import { freesoundSearchRequest } from "./freesoundApi";

describe("freesound api request mapping", () => {
  it("defaults license to cc0", () => {
    const { query } = parseSearchGrammar("impact");

    expect(
      freesoundSearchRequest({ kind: "cloud", provider: "freesound" }, query).license,
    ).toBe("cc0");
  });

  it("maps duration tag format rating and uploader filters", () => {
    const { query } = parseSearchGrammar(
      "impact duration:<2 tag:metal format:wav rating:>=4 uploader:alice",
    );
    const request = freesoundSearchRequest(
      { kind: "cloud", provider: "freesound" },
      query,
    );

    expect(request.query).toBe("impact");
    expect(request.durationMax).toBe(2);
    expect(request.tags).toEqual(["metal"]);
    expect(request.format).toBe("wav");
    expect(request.ratingMin).toBe(4);
    expect(request.uploader).toBe("alice");
  });
});
