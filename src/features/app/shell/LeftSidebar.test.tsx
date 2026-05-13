import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LeftSidebar } from "./LeftSidebar";

describe("left sidebar", () => {
  it("renders only approved primary sections", () => {
    const html = renderToString(
      <LeftSidebar
        activity={[{ id: "a", label: "Search", detail: "tag:metal" }]}
        collections={[{ id: "c", label: "Favorites" }]}
        libraries={[{ id: "local", label: "Local", kind: "root" }]}
      />,
    );

    expect(html).toContain("Sonilabs");
    expect(html).not.toContain("Drop a file or folder");
    expect(html).toContain("Collections");
    expect(html).toContain("Activity History");
    expect(html).not.toContain("Cloud");
    expect(html).not.toContain("Processing");
    expect(html).not.toContain("Inspector");
  });
});
