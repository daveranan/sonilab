import { describe, expect, it } from "vitest";

import { parseSearchGrammar } from "./searchGrammar";

describe("search grammar", () => {
  it("parses free text terms", () => {
    const { query, warnings } = parseSearchGrammar("metal impact -music");

    expect(warnings).toEqual([]);
    expect(query.text).toEqual(["metal", "impact", "-music"]);
  });

  it("parses quoted filter values", () => {
    const { query } = parseSearchGrammar('tag:"bullet impact" license:cc0');

    expect(query.filters).toContainEqual({
      field: "tag",
      value: "bullet impact",
      negated: false,
    });
    expect(query.filters).toContainEqual({
      field: "license",
      value: "cc0",
      negated: false,
    });
  });

  it("parses numeric comparisons and ranges", () => {
    const { query } = parseSearchGrammar(
      "duration:<2 rate:>=48000 channels:stereo bitdepth:24 size:<5mb rating:>=4 peak:>-3 rms:-24..-12 headroom:>=3",
    );

    expect(query.filters).toContainEqual({
      field: "duration",
      operator: "<",
      value: 2,
      raw: "<2",
      negated: false,
    });
    expect(query.filters).toContainEqual({
      field: "rate",
      operator: ">=",
      value: 48000,
      raw: ">=48000",
      negated: false,
    });
    expect(query.filters).toContainEqual({
      field: "channels",
      operator: "=",
      value: 2,
      raw: "stereo",
      negated: false,
    });

    expect(parseSearchGrammar("duration:0.2..1.5").query.filters[0]).toMatchObject({
      field: "duration",
      operator: "range",
      value: 0.2,
      valueEnd: 1.5,
    });
    expect(query.filters).toContainEqual({
      field: "size",
      operator: "<",
      value: 5 * 1024 * 1024,
      raw: "<5mb",
      negated: false,
    });
    expect(query.filters).toContainEqual({
      field: "peak",
      operator: ">",
      value: -3,
      raw: ">-3",
      negated: false,
    });
  });

  it("parses full app filter fields and chips", () => {
    const { query, warnings } = parseSearchGrammar(
      "rights:commercial codec:pcm provider:freesound collection:favorites favorite:true available:false status:probe_failed modified:2026-01-01..2026-02-01 clipping:false waveform:cached",
    );

    expect(warnings).toEqual([]);
    expect(query.filters).toContainEqual({
      field: "rights",
      value: "commercial",
      negated: false,
    });
    expect(query.filters).toContainEqual({
      field: "favorite",
      value: true,
      negated: false,
    });
    expect(query.filters).toContainEqual({
      field: "modified",
      operator: "range",
      value: "2026-01-01",
      valueEnd: "2026-02-01",
      raw: "2026-01-01..2026-02-01",
      negated: false,
    });
    expect(query.activeFilterChips.map((chip) => chip.field)).toContain("codec");
  });

  it("parses Freesound uploader filter", () => {
    const { query, warnings } = parseSearchGrammar("uploader:fieldrecordist");

    expect(warnings).toEqual([]);
    expect(query.filters).toContainEqual({
      field: "uploader",
      value: "fieldrecordist",
      negated: false,
    });
  });

  it("parses tag-any rollup filters", () => {
    const { query, warnings } = parseSearchGrammar('tagany:"mp5|smg|submachine gun"');

    expect(warnings).toEqual([]);
    expect(query.filters).toContainEqual({
      field: "tagany",
      value: "mp5|smg|submachine gun",
      negated: false,
    });
  });

  it("returns warnings for unknown or invalid filters", () => {
    const { query, warnings } = parseSearchGrammar("color:red rate:fast");

    expect(query.filters).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual([
      "unknown-filter",
      "invalid-number",
    ]);
  });
});
