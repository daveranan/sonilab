import { describe, expect, it } from "vitest";

import { tagCategories } from "./tagCategories";
import { applySearchSuggestion, resolveSearchSuggestions } from "./searchSuggestions";

describe("search suggestions", () => {
  it("suggests filter fields for the active token", () => {
    const result = resolveSearchSuggestions("ta", 2);

    expect(result.title).toBe("Filters");
    expect(result.suggestions[0]?.label).toBe("tag:");
  });

  it("suggests values after a recognized filter field", () => {
    const result = resolveSearchSuggestions("tag:", 4);

    expect(result.title).toBe("tag");
    expect(result.suggestions.map((suggestion) => suggestion.label)).toContain("metal");
  });

  it("uses the full configured tag list for tag values", () => {
    const result = resolveSearchSuggestions("tag:", 4);
    const configuredTags = new Set(tagCategories.flatMap((category) => category.tags));

    expect(result.suggestions).toHaveLength(configuredTags.size);
    expect(result.suggestions.map((suggestion) => suggestion.label)).toContain("mp5");
  });

  it("applies field suggestions in place and keeps value completion open", () => {
    const fieldSuggestion = resolveSearchSuggestions("ta", 2).suggestions[0]!;
    const applied = applySearchSuggestion("ta", 2, fieldSuggestion);
    const followUp = resolveSearchSuggestions(applied.value, applied.caretIndex);

    expect(applied.value).toBe("tag:");
    expect(followUp.title).toBe("tag");
    expect(followUp.suggestions.length).toBeGreaterThan(0);
  });

  it("applies value suggestions with a trailing space for the next token", () => {
    const valueSuggestion = resolveSearchSuggestions("tag:me", 6).suggestions.find(
      (suggestion) => suggestion.label === "metal",
    )!;
    const applied = applySearchSuggestion("tag:me", 6, valueSuggestion);

    expect(applied.value).toBe("tag:metal ");
  });
});
