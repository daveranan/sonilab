import { describe, expect, it } from "vitest";

import { collectExpandableIds, toggleExpandedNodeIds } from "./treeExpansion";

const tree = {
  id: "root",
  children: [
    {
      id: "folders",
      children: [
        { id: "folder-a", children: [{ id: "leaf-a" }] },
        { id: "folder-b" },
      ],
    },
    {
      id: "tags",
      children: [{ id: "tag-category", children: [{ id: "leaf-b" }] }],
    },
  ],
};

describe("tree expansion", () => {
  it("collects only nodes that can expand", () => {
    expect(collectExpandableIds([tree])).toEqual([
      "root",
      "folders",
      "folder-a",
      "tags",
      "tag-category",
    ]);
  });

  it("toggles a single node without touching descendants", () => {
    expect(toggleExpandedNodeIds(["folders", "folder-a"], tree, false)).toEqual([
      "folders",
      "folder-a",
      "root",
    ]);
  });

  it("alt toggles a subtree open or closed", () => {
    expect(toggleExpandedNodeIds([], tree, true)).toEqual([
      "root",
      "folders",
      "folder-a",
      "tags",
      "tag-category",
    ]);

    expect(toggleExpandedNodeIds(["root", "folders", "folder-a"], tree, true)).toEqual(
      [],
    );
  });
});
