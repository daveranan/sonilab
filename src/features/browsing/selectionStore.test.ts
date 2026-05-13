import { describe, expect, it } from "vitest";

import { browseSelectionReducer, initialBrowseSelectionState } from "./selectionStore";

const rows = ["a", "b", "c", "d", "e"];

describe("browse selection reducer", () => {
  it("handles single click and ctrl-click toggle", () => {
    const single = browseSelectionReducer(initialBrowseSelectionState, {
      type: "single",
      rowId: "b",
      intent: "mouse",
    });
    const toggled = browseSelectionReducer(single, { type: "toggle", rowId: "d" });

    expect(single.activeRowId).toBe("b");
    expect([...single.selectedRowIds]).toEqual(["b"]);
    expect([...toggled.selectedRowIds].sort()).toEqual(["b", "d"]);
  });

  it("handles shift range selection", () => {
    const anchored = browseSelectionReducer(initialBrowseSelectionState, {
      type: "single",
      rowId: "b",
      intent: "mouse",
    });
    const ranged = browseSelectionReducer(anchored, {
      type: "range",
      rowId: "d",
      orderedRowIds: rows,
    });

    expect([...ranged.selectedRowIds]).toEqual(["b", "c", "d"]);
  });

  it("moves keyboard selection and extends ranges", () => {
    const active = browseSelectionReducer(initialBrowseSelectionState, {
      type: "single",
      rowId: "c",
      intent: "mouse",
    });
    const moved = browseSelectionReducer(active, {
      type: "move",
      delta: 1,
      orderedRowIds: rows,
      extend: false,
      keepSelection: false,
    });
    const extended = browseSelectionReducer(moved, {
      type: "move",
      delta: -2,
      orderedRowIds: rows,
      extend: true,
      keepSelection: false,
    });

    expect(moved.activeRowId).toBe("d");
    expect([...moved.selectedRowIds]).toEqual(["d"]);
    expect(extended.activeRowId).toBe("b");
    expect([...extended.selectedRowIds]).toEqual(["b", "c", "d"]);
  });

  it("retains stable ids after refresh", () => {
    const selected = browseSelectionReducer(initialBrowseSelectionState, {
      type: "single",
      rowId: "c",
      intent: "mouse",
    });
    const refreshed = browseSelectionReducer(selected, {
      type: "retain",
      orderedRowIds: ["x", "c", "z"],
    });

    expect(refreshed.activeRowId).toBe("c");
    expect([...refreshed.selectedRowIds]).toEqual(["c"]);
  });
});
