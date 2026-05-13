import { describe, expect, it } from "vitest";

import { browseColumns, browseGridTemplate } from "./columns";

describe("browse columns", () => {
  it("uses the resized name width in the grid template", () => {
    const columns = browseColumns.filter((column) =>
      ["name", "duration", "tags"].includes(column.id),
    );

    expect(
      browseGridTemplate(columns, {
        name: 1200,
        duration: 78,
        tags: 260,
      }),
    ).toBe("1200px 78px 260px");
  });
});
