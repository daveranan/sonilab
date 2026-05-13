import { describe, expect, it } from "vitest";

import {
  canonicalizeTag,
  categorySummaryForTags,
  isIgnoredTag,
  tagCategoryPathForTag,
} from "./tagCategories";

describe("tag categories", () => {
  it("summarizes known tags into categories", () => {
    expect(categorySummaryForTags(["metal", "impact", "dark", "zombie", "death"])).toBe(
      "Material: metal | Content: impact | Tone: dark | Subject: zombie | Action: death",
    );
  });

  it("shows unknown tags as keywords", () => {
    expect(categorySummaryForTags(["construction kit", "xylophone"])).toBe(
      "Keywords: construction kit, xylophone",
    );
  });

  it("canonicalizes punctuation variants without splitting hyphenated words", () => {
    expect(canonicalizeTag("chain,")).toBe("chain");
    expect(canonicalizeTag("clink,,")).toBe("clink");
    expect(canonicalizeTag("sci-fi")).toBe("sci-fi");
  });

  it("ignores pack update noise", () => {
    expect(isIgnoredTag("Update")).toBe(false);
    expect(categorySummaryForTags(["techno", "trance", "update"])).toBe(
      "Music: techno, trance | Keywords: update",
    );
  });

  it("places gun model tags under weapon hierarchy", () => {
    expect(tagCategoryPathForTag("mp5").map((category) => category.label)).toEqual([
      "Weapon",
      "Gun",
      "Submachine Gun",
    ]);
  });
});
