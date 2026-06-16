import type { SearchSort, SourceScope } from "@/features/browsing/browseTypes";
import { defaultSearchSort } from "@/features/browsing/sortModel";

import type { ViewTabModel } from "./ViewTabs";

export type ViewTabKind = "folder" | "search" | "collection" | "cloud" | "export";

export type AppViewTab = ViewTabModel & {
  kind: ViewTabKind;
  queryText: string;
  savedQueryText: string;
  sort: SearchSort;
  savedSort: SearchSort;
  sourceScope: SourceScope;
  savedSourceScope: SourceScope;
  includeUnavailable: boolean;
  savedIncludeUnavailable: boolean;
  breadcrumbSegments: string[];
  collectionId?: string;
  sourceId?: string;
  folderId?: string;
  folderPath?: string;
};

export type NavigationHistory = {
  back: AppViewTab[];
  forward: AppViewTab[];
};

export function searchTabId(queryText: string): string {
  const normalized = queryText.trim().toLowerCase().replace(/\s+/g, " ");
  return `search-${encodeURIComponent(normalized || "all").slice(0, 96)}`;
}

export function createSearchViewTab(
  queryText: string,
  includeUnavailable = false,
): AppViewTab {
  const labelText = queryText.trim();
  return {
    id: searchTabId(queryText),
    kind: "search",
    label: labelText ? `Search: ${labelText.slice(0, 24)}` : "Search",
    closeable: true,
    queryText,
    savedQueryText: queryText,
    sort: defaultSearchSort,
    savedSort: defaultSearchSort,
    sourceScope: { kind: "local" },
    savedSourceScope: { kind: "local" },
    includeUnavailable,
    savedIncludeUnavailable: includeUnavailable,
    breadcrumbSegments: ["Search", labelText || "All"],
  };
}

export function sameNavigationTarget(
  left: AppViewTab | undefined,
  right: AppViewTab | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.queryText === right.queryText &&
    left.sort.key === right.sort.key &&
    left.sort.direction === right.sort.direction &&
    left.includeUnavailable === right.includeUnavailable &&
    left.collectionId === right.collectionId &&
    left.sourceId === right.sourceId &&
    left.folderId === right.folderId &&
    left.folderPath === right.folderPath &&
    JSON.stringify(left.sourceScope) === JSON.stringify(right.sourceScope)
  );
}

export function pushNavigationHistory(
  history: NavigationHistory,
  currentTab: AppViewTab | undefined,
  nextTab: AppViewTab | undefined,
  limit = 100,
): NavigationHistory {
  if (!currentTab || !nextTab || sameNavigationTarget(currentTab, nextTab)) {
    return history;
  }
  return {
    back: [...history.back, currentTab].slice(-limit),
    forward: [],
  };
}

export function restoreNavigationHistory(
  history: NavigationHistory,
  currentTab: AppViewTab | undefined,
  direction: "back" | "forward",
): { history: NavigationHistory; tab: AppViewTab | null } {
  const source = direction === "back" ? history.back : history.forward;
  const target = source[source.length - 1];
  if (!target) return { history, tab: null };

  const nextBack = direction === "back" ? source.slice(0, -1) : history.back;
  const nextForward =
    direction === "forward" ? source.slice(0, -1) : history.forward;
  const nextHistory =
    direction === "back"
      ? {
          back: nextBack,
          forward: currentTab ? [...nextForward, currentTab] : nextForward,
        }
      : {
          back: currentTab ? [...nextBack, currentTab] : nextBack,
          forward: nextForward,
        };

  return { history: nextHistory, tab: target };
}

export function restoreTabInActiveSlot(
  tabs: AppViewTab[],
  activeTabId: string,
  restoredTab: AppViewTab,
): { tabs: AppViewTab[]; activeTabId: string } {
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  if (!activeTab) return { tabs, activeTabId };
  const nextTab = {
    ...restoredTab,
    id: activeTabId,
    closeable: activeTab.closeable,
  };
  return {
    activeTabId,
    tabs: tabs.map((tab) => (tab.id === activeTabId ? nextTab : tab)),
  };
}

export function isTabDirty(tab: AppViewTab): boolean {
  return (
    tab.queryText !== tab.savedQueryText ||
    tab.includeUnavailable !== tab.savedIncludeUnavailable ||
    tab.sort.key !== tab.savedSort.key ||
    tab.sort.direction !== tab.savedSort.direction ||
    tab.sourceScope.kind !== tab.savedSourceScope.kind ||
    JSON.stringify(tab.sourceScope) !== JSON.stringify(tab.savedSourceScope)
  );
}

export function replaceActiveViewTab(
  tabs: AppViewTab[],
  activeTabId: string,
  nextTab: AppViewTab,
): { tabs: AppViewTab[]; activeTabId: string } {
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  const existingIndex = tabs.findIndex((tab) => tab.id === nextTab.id);

  if (existingIndex >= 0 && activeIndex < 0) {
    return { tabs, activeTabId: nextTab.id };
  }

  if (existingIndex >= 0 && existingIndex !== activeIndex) {
    return {
      activeTabId: nextTab.id,
      tabs: tabs.filter((tab) => tab.id !== activeTabId),
    };
  }

  if (activeIndex < 0) {
    return { activeTabId: nextTab.id, tabs: [...tabs, nextTab] };
  }

  return {
    activeTabId: nextTab.id,
    tabs: tabs.map((tab) => (tab.id === activeTabId ? nextTab : tab)),
  };
}

export function activateOrCreateSearchTab(
  tabs: AppViewTab[],
  nextTab: AppViewTab,
): { tabs: AppViewTab[]; activeTabId: string } {
  if (tabs.some((tab) => tab.id === nextTab.id)) {
    return {
      tabs: tabs.map((tab) => (tab.id === nextTab.id ? nextTab : tab)),
      activeTabId: nextTab.id,
    };
  }
  return { tabs: [...tabs, nextTab], activeTabId: nextTab.id };
}

export function shouldCreateSearchTabOnSubmit(
  activeTab: Pick<AppViewTab, "kind"> | undefined,
): boolean {
  return activeTab?.kind !== "search";
}
