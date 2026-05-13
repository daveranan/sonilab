import { describe, expect, it } from "vitest";

import { defaultFolderSort, defaultSearchSort } from "@/features/browsing/sortModel";

import {
  activateOrCreateSearchTab,
  pushNavigationHistory,
  replaceActiveViewTab,
  restoreTabInActiveSlot,
  restoreNavigationHistory,
  shouldCreateSearchTabOnSubmit,
  type AppViewTab,
} from "./tabLifecycle";

const folderTab: AppViewTab = {
  id: "folder-1",
  kind: "folder",
  label: "Folder",
  closeable: false,
  queryText: "path:physics",
  savedQueryText: "path:physics",
  sort: defaultFolderSort,
  savedSort: defaultFolderSort,
  sourceScope: { kind: "local" },
  savedSourceScope: { kind: "local" },
  includeUnavailable: false,
  savedIncludeUnavailable: false,
  breadcrumbSegments: ["Local", "physics"],
};

const searchTab: AppViewTab = {
  id: "search-impact",
  kind: "search",
  label: "Search: impact",
  closeable: true,
  queryText: "tag:impact",
  savedQueryText: "tag:impact",
  sort: defaultSearchSort,
  savedSort: defaultSearchSort,
  sourceScope: { kind: "all" },
  savedSourceScope: { kind: "all" },
  includeUnavailable: false,
  savedIncludeUnavailable: false,
  breadcrumbSegments: ["Search", "impact"],
};

describe("tab lifecycle", () => {
  it("creates a search tab only when submit starts a new search from a non-search view", () => {
    expect(shouldCreateSearchTabOnSubmit(folderTab)).toBe(true);
    expect(shouldCreateSearchTabOnSubmit(searchTab)).toBe(false);
    expect(shouldCreateSearchTabOnSubmit(undefined)).toBe(true);
  });

  it("reuses an existing search tab instead of duplicating it", () => {
    const next = activateOrCreateSearchTab([folderTab, searchTab], searchTab);

    expect(next.activeTabId).toBe(searchTab.id);
    expect(next.tabs).toHaveLength(2);
  });

  it("opens a replacement tab when all tabs were closed", () => {
    const next = replaceActiveViewTab([], "empty-start", folderTab);

    expect(next.activeTabId).toBe(folderTab.id);
    expect(next.tabs).toEqual([folderTab]);
  });

  it("tracks back and forward view history", () => {
    const history = pushNavigationHistory(
      { back: [], forward: [] },
      folderTab,
      searchTab,
    );

    const back = restoreNavigationHistory(history, searchTab, "back");
    expect(back.tab).toEqual(folderTab);
    expect(back.history.forward).toEqual([searchTab]);

    const forward = restoreNavigationHistory(back.history, folderTab, "forward");
    expect(forward.tab).toEqual(searchTab);
    expect(forward.history.back).toEqual([folderTab]);
  });

  it("does not duplicate identical navigation targets", () => {
    const history = pushNavigationHistory(
      { back: [], forward: [] },
      folderTab,
      folderTab,
    );

    expect(history.back).toEqual([]);
    expect(history.forward).toEqual([]);
  });

  it("restores history into the active tab slot", () => {
    const next = restoreTabInActiveSlot([folderTab, searchTab], searchTab.id, {
      ...folderTab,
      id: "older-folder-tab",
    });

    expect(next.activeTabId).toBe(searchTab.id);
    expect(next.tabs).toHaveLength(2);
    expect(next.tabs[1]).toMatchObject({
      id: searchTab.id,
      kind: "folder",
      label: "Folder",
    });
  });
});
