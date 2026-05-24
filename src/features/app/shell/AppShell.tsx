import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderHeart, HardDriveDownload, Plus, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { commandFromKeyboardEvent } from "@/features/app/commandRegistry";
import {
  checkForAppUpdate,
  checkInstallAndRelaunchUpdate,
  deleteBrowseRow,
  openLocalPath,
  openBrowseRowInExplorer,
  type AppUpdateAvailability,
} from "@/features/audio-preview/commands";
import { audioPreviewService } from "@/features/audio-preview/previewService";
import type {
  BrowseRow,
  LazyMetadataResponse,
  SearchSort,
  SourceScope,
} from "@/features/browsing/browseTypes";
import { BrowseTable, type BrowseDensity } from "@/features/browsing/BrowseTable";
import { createDbBrowseProvider } from "@/features/browsing/dbBrowseProvider";
import { parseSearchGrammar } from "@/features/browsing/searchGrammar";
import { useBrowseSelectionStore } from "@/features/browsing/selectionStore";
import { defaultFolderSort, defaultSearchSort } from "@/features/browsing/sortModel";
import {
  canonicalizeTag,
  tagCategoryPathForTag,
} from "@/features/browsing/tagCategories";
import { useDebouncedBrowse } from "@/features/browsing/useDebouncedBrowse";
import type {
  ActivityRow,
  CollectionNode,
  LibraryNode,
} from "@/features/libraries/libraryTypes";
import {
  addAssetsToCollection,
  addFolderRefToCollection,
  clearActivity,
  createCollection,
  deleteActivity,
  deleteCollection,
  loadActivity,
  loadCollections,
  recordActivity,
  renameCollection,
} from "@/features/libraries/collectionActivityApi";

import { HeaderActions, WindowControls } from "./AppTitleBar";
import { BottomDockPlaceholder } from "./BottomDockPlaceholder";
import { Breadcrumbs } from "./Breadcrumbs";
import { LeftSidebar } from "./LeftSidebar";
import { ModalManagerProvider, useModalManager } from "./modalManager";
import { RightInspector } from "./RightInspector";
import { SettingsPanel, type SettingsPanelTab } from "./SettingsPanel";
import { Toolbar } from "./Toolbar";
import { TopSearchBar } from "./TopSearchBar";
import {
  activateOrCreateSearchTab,
  isTabDirty,
  pushNavigationHistory,
  restoreTabInActiveSlot,
  restoreNavigationHistory,
  type AppViewTab,
  type NavigationHistory,
  replaceActiveViewTab,
  searchTabId,
  shouldCreateSearchTabOnSubmit,
} from "./tabLifecycle";
import { ViewTabs } from "./ViewTabs";

const libraries: LibraryNode[] = [
  {
    id: "libraries-local",
    label: "Local",
    kind: "root",
    children: [],
  },
];

const initialCollections: CollectionNode[] = [
  {
    id: "project",
    label: "Current Project",
    children: [
      { id: "project-footsteps", label: "Footsteps" },
      { id: "project-impacts", label: "Bullet Impacts" },
    ],
  },
  { id: "favorites", label: "Favorites", system: true },
  { id: "export-queue", label: "Export Queue", system: true },
];

const initialActivity: ActivityRow[] = [
  { id: "recent-search", label: "Search", detail: "tag:impact duration:<2" },
  { id: "recent-import", label: "Import", detail: "F:/Audio/SFX" },
  { id: "recent-play", label: "Played", detail: "sand_impact_bullet3" },
];

const emptyBrowseRows: BrowseRow[] = [];

type SourceRecord = {
  id: string;
  kind: string;
  provider: string;
  display_name?: string;
  displayName?: string;
  root_uri?: string;
  rootUri?: string;
  status: string;
  settings_json?: string;
  settingsJson?: string;
};

type FolderRecord = {
  id: string;
  source_id?: string;
  sourceId?: string;
  path: string;
  name: string;
  indexed_status?: string;
  indexedStatus?: string;
};

type TagSummaryRow = {
  tag: string;
  count: number;
  source?: "local" | "user";
};

type LocalFolderRegistration = {
  source: SourceRecord;
  job?: { jobId?: string; job_id?: string; status: string } | null;
};

type SourceSettings = {
  monitorForChanges?: boolean;
  analyzeForFindSimilar?: boolean;
  metadataFile?: string | null;
  metadataImportEnabled?: boolean;
};

type ImportOptions = {
  monitorForChanges: boolean;
  metadataImportEnabled: boolean;
  metadataFile: string | null;
};

type IndexingProgressPayload = {
  source_id?: string;
  sourceId?: string;
  status: string;
  phase: string;
  folders_seen?: number;
  foldersSeen?: number;
  audio_candidates?: number;
  audioCandidates?: number;
  files_indexed?: number;
  filesIndexed?: number;
  files_failed?: number;
  filesFailed?: number;
  message?: string | null;
};

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function mergeFreeTextWithFilterQuery(
  currentQueryText: string,
  filterQuery: string,
): string {
  const parsedCurrent = parseSearchGrammar(currentQueryText);
  const textTerms = parsedCurrent.query.text;
  if (!filterQuery.trim()) return textTerms.join(" ").trim();
  return [...textTerms, filterQuery.trim()].join(" ").trim();
}

function removeFilterChipFromQuery(queryText: string, chipId: string): string {
  const parsed = parseSearchGrammar(queryText);
  const chip = parsed.query.activeFilterChips.find(
    (candidate) => candidate.id === chipId,
  );
  if (!chip) return queryText;
  const tokenToRemove = `${chip.negated ? "-" : ""}${chip.label}`.toLowerCase();

  return tokenizeQuery(queryText)
    .filter((token) => token.toLowerCase() !== tokenToRemove)
    .join(" ");
}

function tokenizeQuery(queryText: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of queryText.trim()) {
    if ((char === '"' || char === "'") && quote === null) {
      quote = char;
    } else if (char === quote) {
      quote = null;
    } else if (/\s/.test(char) && quote === null) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

function appendChildCollection(
  nodes: CollectionNode[],
  parentId: string,
  child: CollectionNode,
): CollectionNode[] {
  return nodes.map((node) =>
    node.id === parentId
      ? { ...node, children: [...(node.children ?? []), child] }
      : {
          ...node,
          children: node.children
            ? appendChildCollection(node.children, parentId, child)
            : node.children,
        },
  );
}

function uniqueCollectionName(
  nodes: CollectionNode[],
  base = "New Collection",
): string {
  const labels = new Set(nodes.map((node) => node.label.trim().toLowerCase()));
  if (!labels.has(base.toLowerCase())) return base;

  let index = 2;
  while (labels.has(`${base} ${index}`.toLowerCase())) {
    index += 1;
  }
  return `${base} ${index}`;
}

type CollectionOption = {
  node: CollectionNode;
  depth: number;
  path: string;
};

type CollectionPickerTarget = {
  assetIds: string[];
  folderIds: string[];
};

function collectionOptions(
  nodes: CollectionNode[],
  depth = 0,
  parentPath = "",
): CollectionOption[] {
  return nodes.flatMap((node) => {
    const path = parentPath ? `${parentPath} / ${node.label}` : node.label;
    return [
      { node, depth, path },
      ...collectionOptions(node.children ?? [], depth + 1, path),
    ];
  });
}

function renameCollectionInTree(
  nodes: CollectionNode[],
  id: string,
  label: string,
): CollectionNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, label }
      : {
          ...node,
          children: node.children
            ? renameCollectionInTree(node.children, id, label)
            : node.children,
        },
  );
}

function deleteCollectionFromTree(
  nodes: CollectionNode[],
  id: string,
): CollectionNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({
      ...node,
      children: node.children
        ? deleteCollectionFromTree(node.children, id)
        : node.children,
    }));
}

function findCollectionNode(
  nodes: CollectionNode[],
  id: string,
): CollectionNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children ? findCollectionNode(node.children, id) : null;
    if (child) return child;
  }
  return null;
}

function collectionQueryValue(node: CollectionNode): string {
  const value = node.label.toLowerCase();
  return /\s/.test(value) ? `"${value}"` : value;
}

function sourceLabel(source: SourceRecord): string {
  return (
    source.display_name ??
    source.displayName ??
    source.root_uri ??
    source.rootUri ??
    source.id
  );
}

function sourceRoot(source: SourceRecord): string {
  return source.root_uri ?? source.rootUri ?? "";
}

function sourceSettingsJson(source: SourceRecord | LibraryNode): string {
  return (
    ("settings_json" in source ? source.settings_json : undefined) ??
    ("settingsJson" in source ? source.settingsJson : undefined) ??
    "{}"
  );
}

function parseSourceSettings(source: SourceRecord | LibraryNode): SourceSettings {
  try {
    const parsed = JSON.parse(sourceSettingsJson(source)) as SourceSettings;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function sourceUpdateInput(
  source: SourceRecord | LibraryNode,
  settings: SourceSettings,
  displayName?: string,
) {
  const sourceId = source.id;
  const existingDisplayName =
    "label" in source ? source.label : (source.display_name ?? source.displayName);
  const existingRootUri =
    "label" in source ? source.rootUri : (source.root_uri ?? source.rootUri);
  return {
    id: sourceId,
    kind: "kind" in source && source.kind === "source" ? "local" : source.kind,
    provider: "provider" in source && source.provider ? source.provider : "local",
    display_name: displayName ?? existingDisplayName ?? sourceId,
    root_uri: existingRootUri ?? "",
    status:
      "status" in source && source.status === "offline"
        ? "offline"
        : "status" in source && source.status === "indexing"
          ? "indexing"
          : "active",
    settings_json: JSON.stringify(settings),
  };
}

function splitDisplayPath(path: string | undefined): string[] {
  return (path ?? "").split(/[\\/]+/).filter(Boolean);
}

function pathBaseName(path: string | undefined): string | null {
  const parts = splitDisplayPath(path);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function parentPath(path: string): string {
  const normalized = path.replace(/\//g, "\\");
  const index = normalized.lastIndexOf("\\");
  return index > 0 ? normalized.slice(0, index) : path;
}

function sameBreadcrumbPart(left: string | null | undefined, right: string): boolean {
  return (left ?? "").trim().toLowerCase() === right.trim().toLowerCase();
}

function hiddenFolderPrefixCount(
  sourceNode: LibraryNode | null,
  folderPath?: string,
): number {
  const parts = splitDisplayPath(folderPath);
  if (!sourceNode || parts.length === 0) return 0;
  const first = parts[0];
  if (sameBreadcrumbPart(sourceNode.label, first)) return 1;
  if (sameBreadcrumbPart(pathBaseName(sourceNode.rootUri), first)) return 1;
  return 0;
}

function localBreadcrumbSegments(
  sourceNode: LibraryNode | null,
  folderPath?: string,
): string[] {
  const segments: string[] = [];
  if (sourceNode?.label && !sameBreadcrumbPart(sourceNode.label, "Local")) {
    segments.push(sourceNode.label);
  }
  const folderParts = splitDisplayPath(folderPath);
  segments.push(...folderParts.slice(hiddenFolderPrefixCount(sourceNode, folderPath)));
  return segments;
}

function localStatus(status: string): LibraryNode["status"] {
  if (status === "indexing") return "indexing";
  if (status === "paused") return "paused";
  if (status === "error" || status === "offline") return "offline";
  return "connected";
}

function folderStatus(status: string): LibraryNode["status"] {
  if (status === "indexing") return "indexing";
  if (status === "error") return "offline";
  return undefined;
}

function markRetryingFailedNode(nodes: LibraryNode[], targetId: string): LibraryNode[] {
  return markFailedNodeStatus(nodes, targetId, "indexing");
}

function markClearedFailedNode(nodes: LibraryNode[], targetId: string): LibraryNode[] {
  return markFailedNodeStatus(nodes, targetId, undefined);
}

function markFailedNodeStatus(
  nodes: LibraryNode[],
  targetId: string,
  status: LibraryNode["status"],
): LibraryNode[] {
  return nodes.map((node) => {
    if (node.id === targetId) {
      return clearLibraryNodeFailureStatus(node, status);
    }
    return {
      ...node,
      children: node.children
        ? markFailedNodeStatus(node.children, targetId, status)
        : undefined,
    };
  });
}

function clearLibraryNodeFailureStatus(
  node: LibraryNode,
  status?: LibraryNode["status"],
): LibraryNode {
  return {
    ...node,
    status,
    children: node.children?.map((child) => clearLibraryNodeFailureStatus(child)),
  };
}

function CollectionPickerModal({
  collections,
  initialFocusRef,
  onClose,
  onCreateCollection,
  onSelect,
  target,
}: {
  collections: CollectionOption[];
  initialFocusRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onCreateCollection: () => void;
  onSelect: (node: CollectionNode) => void;
  target: CollectionPickerTarget;
}) {
  const itemCount = target.assetIds.length + target.folderIds.length;
  const selectionLabel =
    itemCount === 1
      ? target.folderIds.length === 1
        ? "1 folder selected"
        : "1 sound selected"
      : `${itemCount} rows selected`;

  useEffect(() => {
    window.requestAnimationFrame(() => initialFocusRef.current?.focus());
  }, [initialFocusRef]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 px-4 pt-[18vh]"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <section
        aria-labelledby="collection-picker-title"
        aria-modal="true"
        className="w-full max-w-[360px] rounded-md border border-border bg-panel shadow-2xl"
        role="dialog"
      >
        <header className="flex items-center justify-between border-b border-border px-3 py-2">
          <div>
            <h2
              className="text-sm font-semibold text-foreground"
              id="collection-picker-title"
            >
              Add to collection
            </h2>
            <p className="text-xs text-muted-foreground">{selectionLabel}</p>
          </div>
          <Button
            aria-label="Close collection picker"
            className="size-7"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="max-h-[320px] overflow-auto p-1.5">
          <button
            className="mb-1 flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm font-medium text-foreground hover:bg-muted focus:bg-muted focus:outline-none"
            onClick={onCreateCollection}
            ref={collections.length === 0 ? initialFocusRef : undefined}
            type="button"
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">New collection</span>
          </button>
          {collections.length > 0 ? (
            collections.map((option, index) => (
              <button
                className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus:bg-muted focus:text-foreground focus:outline-none"
                key={option.node.id}
                onClick={() => onSelect(option.node)}
                ref={index === 0 ? initialFocusRef : undefined}
                style={{ paddingLeft: `${8 + option.depth * 14}px` }}
                title={option.path}
                type="button"
              >
                <FolderHeart className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate">{option.node.label}</span>
              </button>
            ))
          ) : (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              No collections available
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function buildFolderTree(sourceId: string, folders: FolderRecord[]): LibraryNode[] {
  const nodes = new Map<string, LibraryNode>();
  const roots: LibraryNode[] = [];

  for (const folder of folders) {
    if (!folder.path) continue;
    const node: LibraryNode = {
      id: folder.id,
      label: folder.name || folder.path.split("/").pop() || folder.path,
      kind: "folder",
      sourceId,
      folderId: folder.id,
      path: folder.path,
      status: folderStatus(folder.indexed_status ?? folder.indexedStatus ?? "indexed"),
      children: [],
    };
    nodes.set(folder.path, node);
  }

  for (const folder of folders) {
    if (!folder.path) continue;
    const node = nodes.get(folder.path);
    if (!node) continue;
    const parentPath = folder.path.includes("/")
      ? folder.path.slice(0, folder.path.lastIndexOf("/"))
      : "";
    const parent = parentPath ? nodes.get(parentPath) : null;
    if (parent) parent.children?.push(node);
    else roots.push(node);
  }

  return roots;
}

function findLibraryNode(
  nodes: LibraryNode[],
  predicate: (node: LibraryNode) => boolean,
): LibraryNode | null {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const child = node.children ? findLibraryNode(node.children, predicate) : null;
    if (child) return child;
  }
  return null;
}

function activeLibraryNodeIdForTab(
  nodes: LibraryNode[],
  tab: AppViewTab | undefined,
): string | null {
  if (!tab) return null;
  if (tab.id.startsWith("library-")) {
    const nodeId = tab.id.slice("library-".length);
    return findLibraryNode(nodes, (node) => node.id === nodeId)?.id ?? null;
  }
  if (tab.kind !== "folder") return null;
  if (tab.folderId) {
    return (
      findLibraryNode(
        nodes,
        (node) => node.kind === "folder" && node.folderId === tab.folderId,
      )?.id ?? null
    );
  }
  if (!tab.sourceId) return null;
  return (
    findLibraryNode(
      nodes,
      (node) => node.kind === "source" && (node.sourceId ?? node.id) === tab.sourceId,
    )?.id ?? null
  );
}

function quoteSearchFilterValue(value: string): string {
  if (/^[a-z0-9_-]+$/i.test(value)) return value;
  return `"${value.replace(/"/g, "")}"`;
}

function tagNodeId(prefix: string, value: string): string {
  return `${prefix}-${encodeURIComponent(value)}`;
}

function sortTagNodes(nodes: LibraryNode[]): LibraryNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.label === "Keywords") return 1;
      if (right.label === "Keywords") return -1;
      return left.label.localeCompare(right.label);
    })
    .map((node) => ({
      ...node,
      children: node.children ? sortTagNodes(node.children) : undefined,
    }));
}

function descendantTagLabels(node: LibraryNode): string[] {
  if (node.kind === "query" && node.queryTag) return [node.queryTag];
  if (node.kind === "query" && node.label) return [node.label];
  return (node.children ?? []).flatMap(descendantTagLabels);
}

function attachTagCategoryQueries(node: LibraryNode): LibraryNode {
  const children = node.children?.map(attachTagCategoryQueries);
  if (node.kind !== "tagCategory") return { ...node, children };

  const tags = children?.flatMap(descendantTagLabels) ?? [];
  return {
    ...node,
    children,
    queryText: tags.length > 0 ? `tagany:"${tags.join("|")}"` : node.queryText,
  };
}

function attachUserTagCategoryQueries(node: LibraryNode): LibraryNode {
  const children = node.children?.map(attachUserTagCategoryQueries);
  if (node.kind !== "tagCategory") return { ...node, children };

  const tags = children?.flatMap(descendantTagLabels) ?? [];
  return {
    ...node,
    children,
    queryText: tags.length > 0 ? `usertagany:"${tags.join("|")}"` : node.queryText,
  };
}

function buildLocalTagTree(rows: TagSummaryRow[]): LibraryNode | null {
  const tagRoot: LibraryNode = {
    id: "local-tags",
    label: "Local Tags",
    kind: "tagRoot",
    children: [],
  };
  const categoryNodes = new Map<string, LibraryNode>();

  function ensureCategory(
    id: string,
    label: string,
    parent?: LibraryNode,
  ): LibraryNode {
    const nodeId = tagNodeId("local-tags-category", id);
    const existing = categoryNodes.get(nodeId);
    if (existing) return existing;

    const node: LibraryNode = {
      id: nodeId,
      label,
      kind: "tagCategory",
      children: [],
    };
    categoryNodes.set(nodeId, node);
    (parent?.children ?? tagRoot.children)?.push(node);
    return node;
  }

  for (const row of rows) {
    const tag = canonicalizeTag(row.tag);
    if (!tag || row.count <= 0) continue;
    const path = tagCategoryPathForTag(tag);
    if (path.length === 1 && path[0]?.id === "keyword") continue;
    let parent: LibraryNode | undefined;
    for (const category of path) {
      parent = ensureCategory(category.id, category.label, parent);
    }
    const leafParent = parent ?? tagRoot;
    leafParent.children?.push({
      id: tagNodeId("local-tags-tag", tag),
      label: tag,
      kind: "query",
      queryTag: tag,
      queryText: `tag:${quoteSearchFilterValue(tag)}`,
      children: [],
    });
  }

  tagRoot.children = sortTagNodes(tagRoot.children ?? []).map(attachTagCategoryQueries);
  return tagRoot.children.length > 0 ? tagRoot : null;
}

function buildUserTagTree(rows: TagSummaryRow[]): LibraryNode | null {
  const tagRoot: LibraryNode = {
    id: "user-tags",
    label: "User Tags",
    kind: "tagRoot",
    children: [],
  };
  const categories = new Map<string, LibraryNode>();

  for (const row of rows) {
    const tag = canonicalizeUserTag(row.tag);
    if (!tag || row.count <= 0) continue;
    const [category, label] = splitUserGroupedTag(tag);
    const parent = category
      ? ensureUserCategory(tagRoot, categories, category)
      : tagRoot;
    parent.children?.push({
      id: tagNodeId("user-tags-tag", tag),
      label,
      kind: "query",
      queryTag: tag,
      queryText: `usertag:${quoteSearchFilterValue(tag)}`,
      children: [],
    });
  }

  tagRoot.children = sortTagNodes(tagRoot.children ?? []).map(
    attachUserTagCategoryQueries,
  );
  return tagRoot.children.length > 0 ? tagRoot : null;
}

function ensureUserCategory(
  root: LibraryNode,
  categories: Map<string, LibraryNode>,
  category: string,
): LibraryNode {
  const nodeId = tagNodeId("user-tags-category", category);
  const existing = categories.get(nodeId);
  if (existing) return existing;
  const node: LibraryNode = {
    id: nodeId,
    label: category,
    kind: "tagCategory",
    children: [],
  };
  categories.set(nodeId, node);
  root.children?.push(node);
  return node;
}

function splitUserGroupedTag(tag: string): [string | null, string] {
  const [category, label] = tag.split(":", 2);
  return category && label ? [category, label] : [null, tag];
}

function canonicalizeUserTag(tag: string): string {
  if (tag.includes(":")) {
    const [category, label] = tag.split(":", 2);
    const normalizedCategory = canonicalizeTag(category ?? "");
    const normalizedLabel = canonicalizeTag(label ?? "");
    return normalizedCategory && normalizedLabel
      ? `${normalizedCategory}:${normalizedLabel}`
      : "";
  }
  return canonicalizeTag(tag);
}

function buildTagTree(rows: TagSummaryRow[]): LibraryNode | null {
  const localRoot = buildLocalTagTree(rows.filter((row) => row.source !== "user"));
  const userRoot = buildUserTagTree(rows.filter((row) => row.source === "user"));
  const children = [localRoot, userRoot].filter((node): node is LibraryNode =>
    Boolean(node),
  );
  if (children.length === 0) return null;
  return {
    id: "all-tags",
    label: "Tags",
    kind: "tagRoot",
    children,
  };
}

async function loadTagSummary(): Promise<TagSummaryRow[]> {
  if (!hasTauri()) return [];
  return invoke<TagSummaryRow[]>("tag_summary", {
    request: {
      sourceScope: { kind: "local" },
      limit: 5000,
    },
  });
}

async function loadTagTree(): Promise<LibraryNode | null> {
  return loadTagSummary().then(buildTagTree);
}

function replaceTagRoot(
  nodes: LibraryNode[],
  tagRoot: LibraryNode | null,
): LibraryNode[] {
  const withoutTags = nodes.filter((node) => node.id !== "all-tags");
  return tagRoot ? [...withoutTags, tagRoot] : withoutTags;
}

async function loadLibraryTree(): Promise<LibraryNode[] | null> {
  if (!hasTauri()) return null;
  const sources = await invoke<SourceRecord[]>("list_sources");
  const localSources = sources.filter((source) => source.kind === "local");
  const localChildren = await Promise.all(
    localSources.map(async (source): Promise<LibraryNode> => {
      const folders = await invoke<FolderRecord[]>("list_source_folders", {
        sourceId: source.id,
      });
      const settings = parseSourceSettings(source);
      return {
        id: source.id,
        label: sourceLabel(source),
        kind: "source",
        sourceId: source.id,
        provider: source.provider,
        rootUri: sourceRoot(source),
        settingsJson: sourceSettingsJson(source),
        monitorForChanges: settings.monitorForChanges === true,
        analyzeForFindSimilar: settings.analyzeForFindSimilar === true,
        metadataFile: settings.metadataFile ?? null,
        status: localStatus(source.status),
        children: buildFolderTree(source.id, folders),
      };
    }),
  );
  const tagRoot = await loadTagTree().catch(() => null);

  return [
    {
      id: "libraries-local",
      label: "Local",
      kind: "root",
      children: localChildren,
    },
    ...(tagRoot ? [tagRoot] : []),
  ];
}

const initialTabs: AppViewTab[] = [
  {
    id: "empty-start",
    kind: "folder",
    label: "Local",
    closeable: false,
    queryText: "",
    savedQueryText: "",
    sort: defaultFolderSort,
    savedSort: defaultFolderSort,
    sourceScope: { kind: "source", sourceId: "__empty_start__" },
    savedSourceScope: { kind: "source", sourceId: "__empty_start__" },
    includeUnavailable: false,
    savedIncludeUnavailable: false,
    breadcrumbSegments: [],
  },
];
const shellSessionStorageKey = "sonilabs.appShellSession.v2";
const enabledLocalSourcesStorageKey = "sonilabs.enabledLocalSources.v1";
const defaultLibraryExpandedIds = [
  "libraries-local",
  "local-main",
  "all-tags",
  "local-tags",
  "user-tags",
];
const defaultCollectionExpandedIds = ["project"];

type StoredShellSession = {
  activeRowId?: string | null;
  activeTabId?: string;
  browseDensity?: BrowseDensity;
  collectionExpandedIds?: string[];
  libraryExpandedIds?: string[];
  sidebarWidth?: number;
  tabs?: AppViewTab[];
};

function readStoredShellSession(): StoredShellSession {
  try {
    const raw = window.localStorage.getItem(shellSessionStorageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as StoredShellSession;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function restoredTabs(session: StoredShellSession): AppViewTab[] {
  return Array.isArray(session.tabs) && session.tabs.length > 0
    ? session.tabs
    : initialTabs;
}

function restoredActiveTabId(session: StoredShellSession, tabs: AppViewTab[]): string {
  return tabs.some((tab) => tab.id === session.activeTabId)
    ? session.activeTabId!
    : (tabs[0]?.id ?? "empty-start");
}

function restoredStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : fallback;
}

function readEnabledLocalSourceIds(): string[] | null {
  try {
    const raw = window.localStorage.getItem(enabledLocalSourcesStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : null;
  } catch {
    return null;
  }
}

function applyEnabledLocalSources(
  scope: SourceScope,
  enabledSourceIds: string[] | null,
): SourceScope {
  if (enabledSourceIds === null) return scope;
  if (scope.kind === "local" || scope.kind === "all") {
    return { kind: "sources", sourceIds: enabledSourceIds };
  }
  if (scope.kind === "source") {
    return enabledSourceIds.includes(scope.sourceId) ? scope : { kind: "sources", sourceIds: [] };
  }
  if (scope.kind === "sources") {
    return {
      kind: "sources",
      sourceIds: scope.sourceIds.filter((sourceId) => enabledSourceIds.includes(sourceId)),
    };
  }
  return scope;
}

export function AppShell() {
  return (
    <ModalManagerProvider>
      <AppShellContent />
    </ModalManagerProvider>
  );
}

function AppShellContent() {
  const modalManager = useModalManager();
  const [storedShellSession] = useState(readStoredShellSession);
  const [tabs, setTabs] = useState(() => restoredTabs(storedShellSession));
  const [activeTabId, setActiveTabId] = useState(() =>
    restoredActiveTabId(storedShellSession, restoredTabs(storedShellSession)),
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const searchText = activeTab?.queryText ?? "";
  const activeSort = activeTab?.sort ?? defaultSearchSort;
  const activeIncludeUnavailable = activeTab?.includeUnavailable ?? false;
  const [browseDensity, setBrowseDensity] = useState<BrowseDensity>(
    storedShellSession.browseDensity ?? "standard",
  );
  const settingsOpen = modalManager.isOpen("settings");
  const [settingsTab, setSettingsTab] = useState<SettingsPanelTab>("main");
  const [refreshStatus, setRefreshStatus] = useState<string | null>(null);
  const [startupUpdate, setStartupUpdate] = useState<AppUpdateAvailability | null>(
    null,
  );
  const [startupUpdateStatus, setStartupUpdateStatus] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<LazyMetadataResponse["metadataByRowId"]>({});
  const [sidebarWidth, setSidebarWidth] = useState(
    Math.max(240, Math.min(360, storedShellSession.sidebarWidth ?? 280)),
  );
  const [libraryExpandedIds, setLibraryExpandedIds] = useState(() =>
    restoredStringArray(
      storedShellSession.libraryExpandedIds,
      defaultLibraryExpandedIds,
    ),
  );
  const [collectionExpandedIds, setCollectionExpandedIds] = useState(() =>
    restoredStringArray(
      storedShellSession.collectionExpandedIds,
      defaultCollectionExpandedIds,
    ),
  );
  const [restoredActiveRowId] = useState(storedShellSession.activeRowId ?? null);
  const restoredActiveRowConsumedRef = useRef(false);
  const summaryOpen = modalManager.isOpen("file-summary");
  const [previewedRowIds, setPreviewedRowIds] = useState(() => new Set<string>());
  const [previewedActivity, setPreviewedActivity] = useState<ActivityRow[]>([]);
  const [libraryNodes, setLibraryNodes] = useState(libraries);
  const [enabledLocalSourceIds, setEnabledLocalSourceIds] = useState<string[] | null>(
    readEnabledLocalSourceIds,
  );
  const [sourceDropStatus, setSourceDropStatus] = useState<string | null>(null);
  const [dropOverlayVisible, setDropOverlayVisible] = useState(false);
  const [pendingImportPaths, setPendingImportPaths] = useState<string[] | null>(null);
  const [importOptions, setImportOptions] = useState<ImportOptions>({
    monitorForChanges: true,
    metadataImportEnabled: false,
    metadataFile: null,
  });
  const [indexingStatus, setIndexingStatus] = useState<string | null>(null);
  const [collections, setCollections] = useState(initialCollections);
  const [renamingCollectionId, setRenamingCollectionId] = useState<string | null>(null);
  const [collectionPickerTarget, setCollectionPickerTarget] =
    useState<CollectionPickerTarget | null>(null);
  const [activity, setActivity] = useState(initialActivity);
  const [onboardingDismissed, setOnboardingDismissed] = useState(
    () => window.localStorage.getItem("sonilabs.localOnboardingDismissed") === "1",
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const collectionPickerFocusRef = useRef<HTMLButtonElement>(null);
  const exportDragActiveRef = useRef(false);
  const metadataRequestRef = useRef(0);
  const metadataRef = useRef<LazyMetadataResponse["metadataByRowId"]>({});
  const pendingMetadataRowIdsRef = useRef(new Set<string>());
  const navigationHistoryRef = useRef<NavigationHistory>({ back: [], forward: [] });
  const provider = useMemo(() => createDbBrowseProvider(), []);
  const localSourceNodes = useMemo(
    () =>
      libraryNodes
        .flatMap((node) => node.children ?? [])
        .filter((node) => node.kind === "source"),
    [libraryNodes],
  );
  const localSourceIds = useMemo(
    () => localSourceNodes.map((source) => source.sourceId ?? source.id),
    [localSourceNodes],
  );
  const prunedEnabledLocalSourceIds = useMemo(
    () =>
      enabledLocalSourceIds === null
        ? null
        : enabledLocalSourceIds.filter((sourceId) => localSourceIds.includes(sourceId)),
    [enabledLocalSourceIds, localSourceIds],
  );
  const effectiveEnabledLocalSourceIds = useMemo(
    () => prunedEnabledLocalSourceIds ?? localSourceIds,
    [prunedEnabledLocalSourceIds, localSourceIds],
  );
  const filteredSourceScope = useMemo(
    () =>
      applyEnabledLocalSources(
        activeTab?.sourceScope ?? { kind: "all" },
        prunedEnabledLocalSourceIds,
      ),
    [activeTab?.sourceScope, prunedEnabledLocalSourceIds],
  );
  const localSourcesForSettings = useMemo(
    () =>
      localSourceNodes.map((source) => ({
        id: source.sourceId ?? source.id,
        displayName: source.label,
        rootUri: source.rootUri ?? source.path ?? "",
        status: source.status ?? "connected",
      })),
    [localSourceNodes],
  );
  const showLocalOnboarding =
    !onboardingDismissed && localSourceNodes.length === 0 && !settingsOpen;
  const activeLibraryNodeId = useMemo(
    () => activeLibraryNodeIdForTab(libraryNodes, activeTab),
    [activeTab, libraryNodes],
  );
  const activeCollectionNodeId =
    activeTab?.kind === "collection" || activeTab?.kind === "export"
      ? (activeTab.collectionId ?? null)
      : null;

  const refreshLibraries = useCallback(() => {
    void loadLibraryTree()
      .then((next) => {
        if (next) setLibraryNodes(next);
      })
      .catch(() => undefined);
  }, []);

  const refreshTagTree = useCallback(() => {
    void loadTagTree()
      .then((tagRoot) => setLibraryNodes((current) => replaceTagRoot(current, tagRoot)))
      .catch(() => undefined);
  }, []);

  const refreshCollections = useCallback(() => {
    void loadCollections()
      .then((next) => {
        if (next) setCollections(next);
      })
      .catch(() => undefined);
  }, []);

  const refreshActivity = useCallback(() => {
    void loadActivity(40)
      .then((next) => {
        if (next) setActivity(next);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshLibraries();
    refreshCollections();
    refreshActivity();
  }, [refreshActivity, refreshCollections, refreshLibraries]);

  useEffect(() => {
    if (prunedEnabledLocalSourceIds === null) {
      window.localStorage.removeItem(enabledLocalSourcesStorageKey);
      return;
    }
    window.localStorage.setItem(
      enabledLocalSourcesStorageKey,
      JSON.stringify(prunedEnabledLocalSourceIds),
    );
  }, [prunedEnabledLocalSourceIds]);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void checkForAppUpdate()
        .then((update) => {
          if (!cancelled && update.available) setStartupUpdate(update);
        })
        .catch(() => undefined);
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      exportDragActiveRef.current = Boolean(
        (event as CustomEvent<{ active: boolean }>).detail?.active,
      );
      if (exportDragActiveRef.current) setDropOverlayVisible(false);
    };
    window.addEventListener("sonilabs:export-drag-active", handler);
    return () => window.removeEventListener("sonilabs:export-drag-active", handler);
  }, []);

  const parsed = useMemo(() => {
    const next = parseSearchGrammar(
      searchText,
      filteredSourceScope,
    );
    return {
      ...next,
      query: {
        ...next.query,
        sort: activeSort,
        includeUnavailable: activeIncludeUnavailable || next.query.includeUnavailable,
      },
    };
  }, [activeIncludeUnavailable, activeSort, filteredSourceScope, searchText]);
  const { dispatch, activeRowId, selectedRowIds } = useBrowseSelectionStore();
  const { response, loading, executeNow, removeRowsById } = useDebouncedBrowse({
    provider,
    viewId: activeTab?.id ?? "browse",
    folderId: activeTab?.folderId,
    collectionId: activeTab?.collectionId,
    query: parsed.query,
    limit: 50_000,
    enabled: Boolean(activeTab),
  });
  const activeResponse = activeTab ? response : null;
  const browseLoading = activeTab ? loading : false;
  const rows = activeResponse?.rows ?? emptyBrowseRows;
  const activeAsset = useMemo(() => {
    const row = rows.find((candidate) => candidate.id === activeRowId);
    return row?.kind === "asset" ? row : null;
  }, [activeRowId, rows]);
  const collectionPickerCollections = useMemo(
    () => collectionOptions(collections),
    [collections],
  );
  const selectedBrowseRows = useMemo(
    () => rows.filter((row) => selectedRowIds.has(row.id)),
    [rows, selectedRowIds],
  );
  const orderedRowIds = useMemo(() => rows.map((row) => row.id), [rows]);

  useEffect(() => {
    const rowIdToRestore = restoredActiveRowId;
    if (!rowIdToRestore || activeRowId || restoredActiveRowConsumedRef.current) {
      return;
    }
    const index = orderedRowIds.indexOf(rowIdToRestore);
    if (index === -1) return;
    restoredActiveRowConsumedRef.current = true;
    dispatch({ type: "single", rowId: rowIdToRestore, intent: "programmatic" });
    window.requestAnimationFrame(() => {
      window.dispatchEvent(
        new CustomEvent("sonilabs:browse-scroll-to-index", {
          detail: { index },
        }),
      );
    });
  }, [activeRowId, dispatch, orderedRowIds, restoredActiveRowId]);

  useEffect(() => {
    window.localStorage.setItem(
      shellSessionStorageKey,
      JSON.stringify({
        activeRowId:
          activeRowId ??
          (restoredActiveRowConsumedRef.current ? null : restoredActiveRowId),
        activeTabId,
        browseDensity,
        collectionExpandedIds,
        libraryExpandedIds,
        sidebarWidth,
        tabs,
      } satisfies StoredShellSession),
    );
  }, [
    activeRowId,
    activeTabId,
    browseDensity,
    collectionExpandedIds,
    libraryExpandedIds,
    restoredActiveRowId,
    sidebarWidth,
    tabs,
  ]);

  const recordPreviewedRow = useCallback(
    (row: Extract<BrowseRow, { kind: "asset" }>) => {
      setPreviewedRowIds((current) => new Set(current).add(row.id));
      setPreviewedActivity((current) => {
        const nextRow: ActivityRow = {
          id: row.id,
          label: row.sourceName,
          detail: row.name,
          activityType: "previewed",
          assetId: row.id,
          query: row.name,
          payload: { viewKind: "asset", queryText: row.name },
        };
        return [nextRow, ...current.filter((item) => item.id !== row.id)];
      });
    },
    [],
  );

  const previewRowByIndex = useCallback(
    (index: number) => {
      const row = rows[index];
      if (row?.kind !== "asset") return;
      recordPreviewedRow(row);
      window.dispatchEvent(
        new CustomEvent("sonilabs:preview-intent", {
          detail: { kind: "start-preview", rowId: row.id },
        }),
      );
    },
    [recordPreviewedRow, rows],
  );
  const markPreviewedRow = useCallback(
    (rowId: string) => {
      const row = rows.find((candidate) => candidate.id === rowId);
      if (row?.kind === "asset") {
        recordPreviewedRow(row);
        return;
      }
      setPreviewedRowIds((current) => new Set(current).add(rowId));
    },
    [recordPreviewedRow, rows],
  );

  const registerLocalFolders = useCallback(
    (paths: string[], options: ImportOptions) => {
      const uniquePaths = [...new Set(paths.filter(Boolean))];
      if (uniquePaths.length === 0) return;
      setDropOverlayVisible(false);
      setPendingImportPaths(null);
      setSourceDropStatus(
        `Registering ${uniquePaths.length} item${uniquePaths.length === 1 ? "" : "s"}...`,
      );
      void Promise.allSettled(
        uniquePaths.map(async (path) => {
          const registration = await invoke<LocalFolderRegistration>(
            "register_local_folder",
            {
              path,
              indexNow: true,
            },
          );
          const source = registration.source;
          const settings = {
            ...parseSourceSettings(source),
            monitorForChanges: options.monitorForChanges,
            metadataImportEnabled: options.metadataImportEnabled,
            metadataFile: options.metadataImportEnabled ? options.metadataFile : null,
          };
          await invoke("update_source", {
            input: sourceUpdateInput(source, settings),
          });
          await invoke(
            options.monitorForChanges ? "start_folder_watch" : "stop_folder_watch",
            { sourceId: source.id },
          );
          return registration;
        }),
      ).then((results) => {
        const failures = results.filter((result) => result.status === "rejected");
        const successes = results.length - failures.length;
        setSourceDropStatus(
          failures.length > 0
            ? `Registered ${successes}; ${failures.length} failed.`
            : `Registered ${successes} local item${successes === 1 ? "" : "s"}; indexing started.`,
        );
        refreshLibraries();
        refreshActivity();
        executeNow({ skipCache: true });
      });
    },
    [executeNow, refreshActivity, refreshLibraries],
  );

  const beginImportLocalFolders = useCallback((paths: string[]) => {
    const uniquePaths = [...new Set(paths.filter(Boolean))];
    if (uniquePaths.length === 0) return;
    setDropOverlayVisible(false);
    setPendingImportPaths(uniquePaths);
    setImportOptions({
      monitorForChanges: true,
      metadataImportEnabled: false,
      metadataFile: null,
    });
  }, []);

  const pickImportMetadataFile = useCallback(() => {
    if (!hasTauri()) {
      setSourceDropStatus("Metadata file picker requires the desktop runtime.");
      return;
    }
    void openDialog({
      directory: false,
      multiple: false,
      filters: [
        {
          name: "Metadata files",
          extensions: ["pdf", "xls", "xlsx", "csv", "tab", "txt"],
        },
      ],
    })
      .then((selected) => {
        if (typeof selected === "string") {
          setImportOptions((current) => ({
            ...current,
            metadataImportEnabled: true,
            metadataFile: selected,
          }));
        }
      })
      .catch((error: unknown) =>
        setSourceDropStatus(
          error instanceof Error ? error.message : "Metadata file picker failed.",
        ),
      );
  }, []);

  const confirmPendingImport = useCallback(() => {
    if (!pendingImportPaths) return;
    registerLocalFolders(pendingImportPaths, importOptions);
  }, [importOptions, pendingImportPaths, registerLocalFolders]);

  const handlePickLocalFolder = useCallback(() => {
    if (!hasTauri()) {
      setSourceDropStatus("Folder picker requires the desktop runtime.");
      return;
    }
    void openDialog({ directory: true, multiple: false })
      .then((selected) => {
        if (typeof selected === "string") beginImportLocalFolders([selected]);
      })
      .catch((error: unknown) =>
        setSourceDropStatus(
          error instanceof Error ? error.message : "Folder picker failed.",
        ),
      );
  }, [beginImportLocalFolders]);

  const dismissLocalOnboarding = useCallback(() => {
    window.localStorage.setItem("sonilabs.localOnboardingDismissed", "1");
    setOnboardingDismissed(true);
  }, []);

  useEffect(() => {
    if (!hasTauri()) return;
    let unlisten: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "over") {
          if (exportDragActiveRef.current) return;
          setDropOverlayVisible(true);
          setSourceDropStatus("Drop file or folder to add to a local library.");
        }
        if (payload.type === "drop") {
          setDropOverlayVisible(false);
          if (exportDragActiveRef.current) return;
          beginImportLocalFolders(payload.paths);
        }
        if (payload.type === "leave") {
          setDropOverlayVisible(false);
          setSourceDropStatus(null);
        }
      })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [beginImportLocalFolders]);

  useEffect(() => {
    if (hasTauri()) return;
    const showOverlay = (event: DragEvent) => {
      if (exportDragActiveRef.current) return;
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDropOverlayVisible(true);
    };
    const hideOverlay = () => setDropOverlayVisible(false);
    window.addEventListener("dragenter", showOverlay);
    window.addEventListener("dragover", showOverlay);
    window.addEventListener("dragleave", hideOverlay);
    window.addEventListener("drop", hideOverlay);
    return () => {
      window.removeEventListener("dragenter", showOverlay);
      window.removeEventListener("dragover", showOverlay);
      window.removeEventListener("dragleave", hideOverlay);
      window.removeEventListener("drop", hideOverlay);
    };
  }, []);

  useEffect(() => {
    if (!hasTauri()) return;
    let unlisten: (() => void) | null = null;
    void listen<IndexingProgressPayload>("indexing://progress", (event) => {
      const payload = event.payload;
      const indexed = payload.files_indexed ?? payload.filesIndexed ?? 0;
      const candidates = payload.audio_candidates ?? payload.audioCandidates ?? 0;
      const failed = payload.files_failed ?? payload.filesFailed ?? 0;
      const folders = payload.folders_seen ?? payload.foldersSeen ?? 0;
      const base =
        payload.message ??
        `${payload.phase}: ${indexed}/${candidates} indexed, ${failed} failed, ${folders} folders`;
      setIndexingStatus(base);
      setSourceDropStatus(base);
      if (
        payload.status === "completed" ||
        payload.status === "completed_with_errors" ||
        payload.status === "canceled"
      ) {
        window.setTimeout(() => setIndexingStatus(null), 2500);
        refreshLibraries();
        executeNow({ skipCache: true });
      }
    })
      .then((nextUnlisten) => {
        unlisten = nextUnlisten;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, [executeNow, refreshLibraries]);

  const handlePlayedAsset = useCallback(
    (row: Extract<BrowseRow, { kind: "asset" }>) => {
      void recordActivity({
        activityType: "played",
        assetId: row.id,
        query: row.name,
        message: row.name,
        status: "success",
        payload: { viewKind: "asset", queryText: row.name },
      }).then(refreshActivity);
    },
    [refreshActivity],
  );

  const rememberNavigationTarget = useCallback(
    (currentTabs: AppViewTab[], nextTab: AppViewTab | undefined) => {
      const currentTab = currentTabs.find((tab) => tab.id === activeTabId);
      navigationHistoryRef.current = pushNavigationHistory(
        navigationHistoryRef.current,
        currentTab,
        nextTab,
      );
    },
    [activeTabId],
  );

  const restoreNavigationTab = useCallback(
    (tab: AppViewTab) => {
      setTabs((current) => restoreTabInActiveSlot(current, activeTabId, tab).tabs);
    },
    [activeTabId],
  );

  const navigateViewHistory = useCallback(
    (direction: "back" | "forward") => {
      const restored = restoreNavigationHistory(
        navigationHistoryRef.current,
        activeTab,
        direction,
      );
      if (!restored.tab) return;
      audioPreviewService.cancelPreview();
      navigationHistoryRef.current = restored.history;
      restoreNavigationTab(restored.tab);
    },
    [activeTab, restoreNavigationTab],
  );

  const activateViewTab = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) return;
      const nextTab = tabs.find((tab) => tab.id === tabId);
      rememberNavigationTarget(tabs, nextTab);
      setActiveTabId(tabId);
    },
    [activeTabId, rememberNavigationTarget, tabs],
  );

  useEffect(() => {
    const isHistoryButton = (event: MouseEvent) =>
      event.button === 3 || event.button === 4;
    const preventBrowserHistory = (event: MouseEvent) => {
      if (!isHistoryButton(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (!isHistoryButton(event)) return;
      event.preventDefault();
      event.stopPropagation();
      navigateViewHistory(event.button === 3 ? "back" : "forward");
    };

    window.addEventListener("mousedown", preventBrowserHistory, true);
    window.addEventListener("mouseup", handleMouseUp, true);
    window.addEventListener("auxclick", preventBrowserHistory, true);
    return () => {
      window.removeEventListener("mousedown", preventBrowserHistory, true);
      window.removeEventListener("mouseup", handleMouseUp, true);
      window.removeEventListener("auxclick", preventBrowserHistory, true);
    };
  }, [navigateViewHistory]);

  const updateActiveTab = useCallback(
    (update: Partial<AppViewTab>) => {
      setTabs((current) =>
        current.map((tab) => (tab.id === activeTabId ? { ...tab, ...update } : tab)),
      );
    },
    [activeTabId],
  );

  const setSearchText = useCallback(
    (queryText: string) => updateActiveTab({ queryText }),
    [updateActiveTab],
  );

  const handleRemoveFilterChip = useCallback(
    (chipId: string) => {
      updateActiveTab({
        queryText: removeFilterChipFromQuery(activeTab?.queryText ?? "", chipId),
      });
    },
    [activeTab?.queryText, updateActiveTab],
  );

  const replaceActiveTab = useCallback(
    (tab: AppViewTab) => {
      setTabs((current) => {
        rememberNavigationTarget(current, tab);
        const next = replaceActiveViewTab(current, activeTabId, tab);
        setActiveTabId(next.activeTabId);
        return next.tabs;
      });
    },
    [activeTabId, rememberNavigationTarget],
  );

  const handleStartNewSearch = useCallback(() => {
    const queryText = searchText.trim();
    const id = searchTabId(queryText);
    const nextTab: AppViewTab = {
      id,
      kind: "search",
      label: queryText ? `Search: ${queryText.slice(0, 24)}` : "Search",
      closeable: true,
      queryText,
      savedQueryText: queryText,
      sort: defaultSearchSort,
      savedSort: defaultSearchSort,
      sourceScope: activeTab?.sourceScope ?? { kind: "all" },
      savedSourceScope: activeTab?.sourceScope ?? { kind: "all" },
      includeUnavailable: activeIncludeUnavailable,
      savedIncludeUnavailable: activeIncludeUnavailable,
      breadcrumbSegments: ["Search", queryText || "All"],
    };
    setTabs((current) => {
      rememberNavigationTarget(current, nextTab);
      const next = activateOrCreateSearchTab(current, nextTab);
      setActiveTabId(next.activeTabId);
      return next.tabs;
    });
  }, [
    activeIncludeUnavailable,
    activeTab?.sourceScope,
    rememberNavigationTarget,
    searchText,
  ]);

  const handleSubmitSearch = useCallback(() => {
    const queryText = searchText.trim();
    if (queryText) {
      void recordActivity({
        activityType: "search",
        query: queryText,
        message: queryText,
        status: "success",
        payload: { viewKind: "search", queryText },
      }).then(refreshActivity);
    }
    if (shouldCreateSearchTabOnSubmit(activeTab)) {
      handleStartNewSearch();
      return;
    }
    executeNow();
  }, [activeTab, executeNow, handleStartNewSearch, refreshActivity, searchText]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      const closing = tabs[closingIndex];
      if (!closing?.closeable) return;
      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      setTabs(nextTabs);
      if (activeTabId === tabId) {
        setActiveTabId(
          nextTabs[Math.max(0, closingIndex - 1)]?.id ??
            nextTabs[0]?.id ??
            "empty-start",
        );
      }
    },
    [activeTabId, tabs],
  );

  const handleOpenLibraryNode = useCallback(
    (node: LibraryNode) => {
      audioPreviewService.cancelPreview();
      if (node.kind === "tagRoot") return;
      if (
        (node.provider && node.provider !== "local") ||
        node.id.startsWith("cloud") ||
        node.label === "Cloud"
      ) {
        setRefreshStatus("Cloud sources are deferred in this build.");
        return;
      }
      const queryText =
        node.kind === "folder" || node.kind === "source"
          ? ""
          : node.kind === "query" || node.kind === "tagCategory"
            ? (node.queryText ??
              (node.label.toLowerCase() === "cc0"
                ? "license:cc0"
                : `tag:${node.label.toLowerCase()}`))
            : "";
      const sourceScope: SourceScope = node.sourceId
        ? { kind: "source", sourceId: node.sourceId }
        : { kind: "local" };
      const sourceId = node.sourceId ?? (node.kind === "source" ? node.id : undefined);
      const sourceNode =
        node.kind === "source"
          ? node
          : findLibraryNode(
              libraryNodes,
              (candidate) =>
                candidate.kind === "source" &&
                (candidate.sourceId ?? candidate.id) === sourceId,
            );
      const sort =
        node.kind === "query" || node.kind === "tagCategory"
          ? defaultSearchSort
          : defaultFolderSort;
      replaceActiveTab({
        id: `library-${node.id}`,
        kind:
          node.kind === "query" || node.kind === "tagCategory" ? "search" : "folder",
        label: node.label,
        closeable: true,
        queryText,
        savedQueryText: queryText,
        sort,
        savedSort: sort,
        sourceScope,
        savedSourceScope: sourceScope,
        includeUnavailable: activeIncludeUnavailable,
        savedIncludeUnavailable: activeIncludeUnavailable,
        breadcrumbSegments:
          node.kind === "query"
            ? ["Local", "Tags", node.label]
            : node.kind === "tagCategory"
              ? ["Local", "Tags", node.label]
              : localBreadcrumbSegments(sourceNode, node.path),
        sourceId,
        folderId: node.folderId,
        folderPath: node.path,
      });
    },
    [activeIncludeUnavailable, libraryNodes, replaceActiveTab],
  );

  const handleOpenLibraryPath = useCallback((_node: LibraryNode, path: string) => {
    if (!path) return;
    if (!hasTauri()) {
      setSourceDropStatus(`Open in Explorer is available in the desktop app: ${path}`);
      return;
    }
    void openLocalPath(path).catch((error) => {
      setSourceDropStatus(`Open in Explorer failed: ${String(error)}`);
    });
  }, []);

  const handleCopyLibraryPath = useCallback((_node: LibraryNode, path: string) => {
    if (!path) return;
    void navigator.clipboard
      .writeText(path)
      .then(() => setSourceDropStatus("Path copied."))
      .catch((error) => setSourceDropStatus(`Copy path failed: ${String(error)}`));
  }, []);

  const handleReindexLibraryNode = useCallback(
    (node: LibraryNode) => {
      const sourceId = node.sourceId ?? (node.kind === "source" ? node.id : undefined);
      if (!sourceId) return;
      setSourceDropStatus(`Reindexing ${node.label}...`);
      const reindex =
        node.kind === "folder" && node.path
          ? invoke("reindex_local_folder", {
              sourceId,
              relativePath: node.path,
              mode: "metadata",
            })
          : invoke("reindex_local_source", { sourceId, mode: "metadata" });
      void reindex
        .then(() => {
          setSourceDropStatus(`Reindex requested for ${node.label}.`);
          refreshLibraries();
          executeNow({ skipCache: true });
        })
        .catch((error) => {
          setSourceDropStatus(`Reindex failed: ${String(error)}`);
        });
    },
    [executeNow, refreshLibraries],
  );

  const failedScopeForNode = useCallback((node: LibraryNode) => {
    const sourceId = node.sourceId ?? (node.kind === "source" ? node.id : undefined);
    if (!sourceId || (node.kind !== "source" && node.kind !== "folder")) return null;
    return {
      sourceId,
      relativePath: node.kind === "folder" ? (node.path ?? null) : null,
    };
  }, []);

  const handleRemoveFailedLibraryNode = useCallback(
    (node: LibraryNode) => {
      const scope = failedScopeForNode(node);
      if (!scope) return;
      const confirmed = window.confirm(
        `Remove failed file entries under ${node.label}? Files on disk will not be deleted.`,
      );
      if (!confirmed) return;
      setSourceDropStatus(`Removing failed entries from ${node.label}...`);
      setLibraryNodes((current) => markClearedFailedNode(current, node.id));
      void invoke<number>("remove_failed_assets", scope)
        .then((count) => {
          setSourceDropStatus(`Removed ${count.toLocaleString()} failed entries.`);
          refreshLibraries();
          executeNow({ skipCache: true });
        })
        .catch((error) => {
          setSourceDropStatus(`Remove failed entries failed: ${String(error)}`);
        });
    },
    [executeNow, failedScopeForNode, refreshLibraries],
  );

  const handleRetryFailedLibraryNode = useCallback(
    (node: LibraryNode) => {
      const scope = failedScopeForNode(node);
      if (!scope) return;
      setSourceDropStatus(`Retrying failed files in ${node.label}...`);
      setLibraryNodes((current) => markRetryingFailedNode(current, node.id));
      void invoke("retry_failed_assets", scope)
        .then(() => {
          setSourceDropStatus(`Retry requested for failed files in ${node.label}.`);
          refreshLibraries();
          executeNow({ skipCache: true });
        })
        .catch((error) => {
          setSourceDropStatus(`Retry failed files failed: ${String(error)}`);
        });
    },
    [executeNow, failedScopeForNode, refreshLibraries],
  );

  const handleSearchLibraryNode = useCallback(
    (node: LibraryNode) => {
      handleOpenLibraryNode(node);
      inputRef.current?.focus();
    },
    [handleOpenLibraryNode],
  );

  const handleLocalSourceEnabledChange = useCallback(
    (sourceId: string, checked: boolean) => {
      setEnabledLocalSourceIds((current) => {
        const next = new Set(current ?? localSourceIds);
        if (checked) next.add(sourceId);
        else next.delete(sourceId);
        return [...next].filter((id) => localSourceIds.includes(id));
      });
    },
    [localSourceIds],
  );

  const clearLocalSourceFilter = useCallback(() => {
    setEnabledLocalSourceIds(null);
  }, []);

  const handleCheckOnlyLibraryNode = useCallback(
    (node: LibraryNode) => {
      const sourceId = node.sourceId ?? (node.kind === "source" ? node.id : undefined);
      if (!sourceId) return;
      setEnabledLocalSourceIds([sourceId]);
      updateActiveTab({ sourceScope: { kind: "source", sourceId } });
      handleOpenLibraryNode(node);
    },
    [handleOpenLibraryNode, updateActiveTab],
  );

  const handleRenameLibraryNode = useCallback(
    (node: LibraryNode) => {
      if (node.kind !== "source") return;
      const nextName = window.prompt("Rename library", node.label)?.trim();
      if (!nextName || nextName === node.label) return;
      void invoke("update_source", {
        input: sourceUpdateInput(node, parseSourceSettings(node), nextName),
      })
        .then(() => {
          setSourceDropStatus(`Renamed library to ${nextName}.`);
          refreshLibraries();
        })
        .catch((error) => setSourceDropStatus(`Rename failed: ${String(error)}`));
    },
    [refreshLibraries],
  );

  const handleToggleMonitorLibraryNode = useCallback(
    (node: LibraryNode) => {
      if (node.kind !== "source") return;
      const nextMonitor = !node.monitorForChanges;
      const settings = {
        ...parseSourceSettings(node),
        monitorForChanges: nextMonitor,
      };
      const monitor = nextMonitor
        ? invoke("start_folder_watch", { sourceId: node.sourceId ?? node.id })
        : invoke("stop_folder_watch", { sourceId: node.sourceId ?? node.id });
      void monitor
        .then(() =>
          invoke("update_source", {
            input: sourceUpdateInput(node, settings),
          }),
        )
        .then(() => {
          setSourceDropStatus(
            nextMonitor
              ? `Monitoring ${node.label} for changes.`
              : `Stopped monitoring ${node.label}.`,
          );
          refreshLibraries();
        })
        .catch((error) =>
          setSourceDropStatus(`Monitor setting failed: ${String(error)}`),
        );
    },
    [refreshLibraries],
  );

  const handleAddLibraryFolderToCollection = useCallback(
    (node: LibraryNode) => {
      if (!node.folderId) return;
      const target = collections.find((collection) => !collection.system);
      if (!target) {
        setSourceDropStatus("Create a collection before adding folders.");
        return;
      }
      void addFolderRefToCollection(target.id, node.folderId)
        .then(() => {
          setSourceDropStatus(`Added ${node.label} to ${target.label}.`);
          refreshCollections();
        })
        .catch((error) => {
          setSourceDropStatus(`Add to collection failed: ${String(error)}`);
        });
    },
    [collections, refreshCollections],
  );

  const handleOpenLibraryNodeInExplorer = useCallback((node: LibraryNode) => {
    if (node.kind === "folder" && node.folderId) {
      void openBrowseRowInExplorer({ rowId: node.folderId, rowKind: "folder" });
      return;
    }
    if (node.kind === "source" && node.rootUri) {
      void openLocalPath(node.rootUri);
    }
  }, []);

  const handleDeleteLibraryNode = useCallback(
    (node: LibraryNode) => {
      if (node.kind === "source" && node.sourceId) {
        const confirmed = window.confirm(
          `Remove ${node.label} from the local library? Files on disk will not be deleted.`,
        );
        if (!confirmed) return;
        void invoke<boolean>("delete_source", { id: node.sourceId }).then(() => {
          refreshLibraries();
          executeNow({ skipCache: true });
        });
        return;
      }
      if (node.kind !== "folder" || !node.folderId) return;
      const folderId = node.folderId;
      const confirmed = window.confirm(
        `Remove ${node.label} from the local library index? Files on disk will not be deleted.`,
      );
      if (!confirmed) return;
      void deleteBrowseRow({ rowId: folderId, rowKind: "folder" }).then(() => {
        removeRowsById([folderId]);
        refreshLibraries();
        executeNow({ skipCache: true });
      });
    },
    [executeNow, refreshLibraries, removeRowsById],
  );

  const handleReindexSourceById = useCallback(
    (sourceId: string) => {
      const node = localSourceNodes.find(
        (candidate) => (candidate.sourceId ?? candidate.id) === sourceId,
      );
      if (node) handleReindexLibraryNode(node);
    },
    [handleReindexLibraryNode, localSourceNodes],
  );

  const handleDeleteSourceById = useCallback(
    (sourceId: string) => {
      const node = localSourceNodes.find(
        (candidate) => (candidate.sourceId ?? candidate.id) === sourceId,
      );
      if (node) handleDeleteLibraryNode(node);
    },
    [handleDeleteLibraryNode, localSourceNodes],
  );

  const handleOpenCollection = useCallback(
    (node: CollectionNode) => {
      audioPreviewService.cancelPreview();
      const isExportQueue = node.system === true && node.label === "Export Queue";
      const queryText = `collection:${collectionQueryValue(node)}`;
      replaceActiveTab({
        id: `collection-${node.id}`,
        kind: isExportQueue ? "export" : "collection",
        label: node.label,
        closeable: true,
        queryText,
        savedQueryText: queryText,
        sort: defaultFolderSort,
        savedSort: defaultFolderSort,
        sourceScope: { kind: "all" },
        savedSourceScope: { kind: "all" },
        includeUnavailable: activeIncludeUnavailable,
        savedIncludeUnavailable: activeIncludeUnavailable,
        breadcrumbSegments: ["Collections", node.label],
        collectionId: node.id,
      });
    },
    [activeIncludeUnavailable, replaceActiveTab],
  );

  const handleOpenFolderRow = useCallback(
    (row: Extract<BrowseRow, { kind: "folder" }>) => {
      audioPreviewService.cancelPreview();
      const sourceNode = findLibraryNode(
        libraryNodes,
        (node) => node.kind === "source" && (node.sourceId ?? node.id) === row.sourceId,
      );
      replaceActiveTab({
        id: `folder-${row.id}`,
        kind: "folder",
        label: row.name,
        closeable: true,
        queryText: "",
        savedQueryText: "",
        sort: defaultFolderSort,
        savedSort: defaultFolderSort,
        sourceScope: { kind: "source", sourceId: row.sourceId },
        savedSourceScope: { kind: "source", sourceId: row.sourceId },
        includeUnavailable: activeIncludeUnavailable,
        savedIncludeUnavailable: activeIncludeUnavailable,
        breadcrumbSegments: localBreadcrumbSegments(sourceNode, row.path),
        sourceId: row.sourceId,
        folderId: row.id,
        folderPath: row.path,
      });
    },
    [activeIncludeUnavailable, libraryNodes, replaceActiveTab],
  );

  const handleGoToRowFolder = useCallback(
    (row: BrowseRow) => {
      if (row.kind === "folder") {
        handleOpenFolderRow(row);
        return;
      }
      if (row.folderId && row.folderPath) {
        const sourceId = row.sourceId;
        if (!sourceId) return;
        handleOpenFolderRow({
          kind: "folder",
          id: row.folderId,
          name: pathBaseName(row.folderPath) ?? row.sourceName,
          childCount: null,
          sourceId,
          sourceName: row.sourceName,
          sourceRootUri: row.sourceRootUri,
          path: row.folderPath,
          fullPath: row.fullPath ? parentPath(row.fullPath) : row.folderPath,
          status: "indexed",
        });
        return;
      }
      if (!row.sourceId) return;
      const sourceNode = findLibraryNode(
        libraryNodes,
        (node) => node.kind === "source" && (node.sourceId ?? node.id) === row.sourceId,
      );
      if (sourceNode) handleOpenLibraryNode(sourceNode);
    },
    [handleOpenFolderRow, handleOpenLibraryNode, libraryNodes],
  );

  const handleBreadcrumbNavigate = useCallback(
    (index: number) => {
      if (!activeTab) return;
      if (activeTab.kind === "search") {
        inputRef.current?.focus();
        return;
      }
      if (activeTab.kind === "collection" || activeTab.kind === "export") {
        const collectionId = activeTab.collectionId;
        const node = collectionId
          ? findCollectionNode(collections, collectionId)
          : null;
        if (node) handleOpenCollection(node);
        return;
      }
      if (activeTab.kind === "cloud") return;

      const sourceId = activeTab.sourceId;
      if (!sourceId) return;
      const sourceNode = findLibraryNode(
        libraryNodes,
        (node) => node.kind === "source" && (node.sourceId ?? node.id) === sourceId,
      );
      const folderParts = splitDisplayPath(activeTab.folderPath);
      const hiddenPrefixCount = hiddenFolderPrefixCount(
        sourceNode,
        activeTab.folderPath,
      );
      const visibleFolderCount = folderParts.length - hiddenPrefixCount;
      const folderStartIndex = activeTab.breadcrumbSegments.length - visibleFolderCount;
      if (index < folderStartIndex || folderParts.length === 0) {
        if (sourceNode) handleOpenLibraryNode(sourceNode);
        return;
      }

      const partCount = hiddenPrefixCount + index - folderStartIndex + 1;
      const targetPath = folderParts.slice(0, partCount).join("/");
      const folderNode = findLibraryNode(
        sourceNode?.children ?? libraryNodes,
        (node) =>
          node.kind === "folder" &&
          node.sourceId === sourceId &&
          node.path === targetPath,
      );
      if (folderNode) handleOpenLibraryNode(folderNode);
    },
    [activeTab, collections, handleOpenCollection, handleOpenLibraryNode, libraryNodes],
  );

  const handleCreateCollection = useCallback(() => {
    const name = uniqueCollectionName(collections);
    void createCollection({ name }).then((created) => {
      if (created) {
        setRenamingCollectionId(created.id);
        refreshCollections();
        return;
      }
      const fallbackCollection = {
        id: `collection-${Date.now()}`,
        label: name,
      };
      setCollections((current) => [...current, fallbackCollection]);
      setRenamingCollectionId(fallbackCollection.id);
    });
  }, [collections, refreshCollections]);

  const handleCreateChildCollection = useCallback(
    (node: CollectionNode) => {
      const name = uniqueCollectionName(node.children ?? []);
      void createCollection({ parentId: node.id, name }).then((created) => {
        if (created) {
          setRenamingCollectionId(created.id);
          refreshCollections();
          return;
        }
        const fallbackCollection = {
          id: `collection-${Date.now()}`,
          label: name,
          parentId: node.id,
        };
        setCollections((current) =>
          appendChildCollection(current, node.id, fallbackCollection),
        );
        setRenamingCollectionId(fallbackCollection.id);
      });
    },
    [refreshCollections],
  );

  const handleRenameCollection = useCallback(
    (node: CollectionNode, nextName: string) => {
      const name = nextName.trim();
      if (!name || name === node.label) return;
      void renameCollection(node.id, name).then((renamed) => {
        if (renamed) {
          refreshCollections();
          return;
        }
        setCollections((current) => renameCollectionInTree(current, node.id, name));
      });
    },
    [refreshCollections],
  );

  const handleDeleteCollection = useCallback(
    (node: CollectionNode) => {
      if (node.system) return;
      void deleteCollection(node.id).then((deleted) => {
        if (deleted) {
          refreshCollections();
          return;
        }
        setCollections((current) => deleteCollectionFromTree(current, node.id));
      });
    },
    [refreshCollections],
  );

  const handleDropAssetsIntoCollection = useCallback(
    (node: CollectionNode, assetIds: string[]) => {
      const ids = assetIds.filter(Boolean);
      if (ids.length === 0) return;
      void addAssetsToCollection(node.id, ids)
        .then(() => refreshCollections())
        .catch(() => undefined);
    },
    [refreshCollections],
  );

  const collectionTargetFromRows = useCallback(
    (targetRows: BrowseRow[]): CollectionPickerTarget => ({
      assetIds: targetRows.filter((row) => row.kind === "asset").map((row) => row.id),
      folderIds: targetRows
        .filter(
          (row): row is Extract<BrowseRow, { kind: "folder" }> => row.kind === "folder",
        )
        .map((row) => row.id),
    }),
    [],
  );

  const openCollectionPickerForRows = useCallback(
    (targetRows: BrowseRow[]) => {
      const target = collectionTargetFromRows(targetRows);
      if (target.assetIds.length === 0 && target.folderIds.length === 0) return;
      setCollectionPickerTarget(target);
      modalManager.open("collection-picker");
    },
    [collectionTargetFromRows, modalManager],
  );

  const handleOpenCollectionPickerForRow = useCallback(
    (row: BrowseRow) => {
      const targetRows =
        selectedRowIds.has(row.id) && selectedBrowseRows.length > 0
          ? selectedBrowseRows
          : [row];
      openCollectionPickerForRows(targetRows);
    },
    [openCollectionPickerForRows, selectedBrowseRows, selectedRowIds],
  );

  const openCollectionPickerForCurrentSelection = useCallback(() => {
    const activeRow = rows.find((candidate) => candidate.id === activeRowId);
    const targetRows =
      selectedBrowseRows.length > 0 ? selectedBrowseRows : activeRow ? [activeRow] : [];
    openCollectionPickerForRows(targetRows);
  }, [activeRowId, openCollectionPickerForRows, rows, selectedBrowseRows]);

  const handleAddSelectionToCollection = useCallback(
    (node: CollectionNode) => {
      if (!collectionPickerTarget) return;
      const assetIds = [...new Set(collectionPickerTarget.assetIds.filter(Boolean))];
      const folderIds = [...new Set(collectionPickerTarget.folderIds.filter(Boolean))];
      if (assetIds.length === 0 && folderIds.length === 0) return;
      setCollectionPickerTarget(null);
      modalManager.close("collection-picker");
      void Promise.all([
        assetIds.length > 0
          ? addAssetsToCollection(node.id, assetIds)
          : Promise.resolve(),
        ...folderIds.map((folderId) => addFolderRefToCollection(node.id, folderId)),
      ])
        .then(() => refreshCollections())
        .catch(() => undefined);
    },
    [collectionPickerTarget, modalManager, refreshCollections],
  );

  const handleCreateCollectionFromPicker = useCallback(() => {
    if (!collectionPickerTarget) return;
    const name = uniqueCollectionName(collections);
    void createCollection({ name }).then((created) => {
      const target = created ?? {
        id: `collection-${Date.now()}`,
        label: name,
      };
      if (!created) setCollections((current) => [...current, target]);
      handleAddSelectionToCollection(target);
    });
  }, [collectionPickerTarget, collections, handleAddSelectionToCollection]);

  const handleDropFolderIntoCollection = useCallback(
    (node: CollectionNode, folderId: string) => {
      if (!folderId) return;
      void addFolderRefToCollection(node.id, folderId)
        .then(() => refreshCollections())
        .catch(() => undefined);
    },
    [refreshCollections],
  );

  const handleRestoreActivity = useCallback(
    (row: ActivityRow) => {
      if (
        row.collectionId ||
        row.activityType === "export" ||
        row.activityType === "export_failed"
      ) {
        const isExport =
          row.activityType === "export" ||
          row.activityType === "export_failed" ||
          Boolean(row.exportJobId);
        const label = isExport ? "Export Queue" : row.detail;
        const queryText = isExport
          ? 'collection:"export queue"'
          : row.query || `collection:${row.collectionId}`;
        replaceActiveTab({
          id: isExport ? "export-queue-tab" : `collection-${row.collectionId}`,
          kind: isExport ? "export" : "collection",
          label,
          closeable: true,
          queryText,
          savedQueryText: queryText,
          sort: defaultFolderSort,
          savedSort: defaultFolderSort,
          sourceScope: { kind: "all" },
          savedSourceScope: { kind: "all" },
          includeUnavailable: activeIncludeUnavailable,
          savedIncludeUnavailable: activeIncludeUnavailable,
          breadcrumbSegments: ["Activity", label],
          collectionId: row.collectionId ?? undefined,
        });
        return;
      }
      if (row.sourceId || row.folderId) {
        const queryText = row.query ?? "";
        replaceActiveTab({
          id: `activity-${row.sourceId ?? row.folderId}`,
          kind: "folder",
          label: row.detail,
          closeable: true,
          queryText,
          savedQueryText: queryText,
          sort: defaultFolderSort,
          savedSort: defaultFolderSort,
          sourceScope: row.sourceId
            ? { kind: "source", sourceId: row.sourceId }
            : { kind: "all" },
          savedSourceScope: row.sourceId
            ? { kind: "source", sourceId: row.sourceId }
            : { kind: "all" },
          includeUnavailable: activeIncludeUnavailable,
          savedIncludeUnavailable: activeIncludeUnavailable,
          breadcrumbSegments: ["Activity", row.detail],
          sourceId: row.sourceId ?? undefined,
        });
        return;
      }
      const payloadQuery =
        typeof row.payload?.queryText === "string" ? row.payload.queryText : null;
      const queryText = row.query ?? payloadQuery ?? row.detail;
      replaceActiveTab({
        id:
          row.activityType === "search" ? searchTabId(queryText) : `activity-${row.id}`,
        kind: "search",
        label:
          row.activityType === "played"
            ? `Played: ${row.detail.slice(0, 24)}`
            : `Search: ${queryText.slice(0, 24)}`,
        closeable: true,
        queryText,
        savedQueryText: queryText,
        sort: defaultSearchSort,
        savedSort: defaultSearchSort,
        sourceScope: { kind: "all" },
        savedSourceScope: { kind: "all" },
        includeUnavailable: activeIncludeUnavailable,
        savedIncludeUnavailable: activeIncludeUnavailable,
        breadcrumbSegments: ["Activity", row.label],
      });
    },
    [activeIncludeUnavailable, replaceActiveTab],
  );

  const handleRemoveActivity = useCallback(
    (row: ActivityRow) => {
      setActivity((current) => current.filter((item) => item.id !== row.id));
      void deleteActivity(row.id).then(refreshActivity);
    },
    [refreshActivity],
  );

  const handleClearActivity = useCallback(() => {
    setActivity([]);
    void clearActivity("search").then(refreshActivity);
  }, [refreshActivity]);

  const handleRemovePreviewedActivity = useCallback((row: ActivityRow) => {
    setPreviewedActivity((current) => current.filter((item) => item.id !== row.id));
    setPreviewedRowIds((current) => {
      const next = new Set(current);
      next.delete(row.id);
      return next;
    });
  }, []);

  const handleClearPreviewedActivity = useCallback(() => {
    setPreviewedActivity([]);
    setPreviewedRowIds(new Set<string>());
  }, []);

  const handleVisibleRows = useCallback(
    (hint: { startIndex: number; endIndex: number; rowIds: string[] }) => {
      const rowIds = hint.rowIds.filter(
        (rowId) =>
          metadataRef.current[rowId] === undefined &&
          !pendingMetadataRowIdsRef.current.has(rowId),
      );
      if (rowIds.length === 0) return;
      rowIds.forEach((rowId) => pendingMetadataRowIdsRef.current.add(rowId));
      metadataRequestRef.current += 1;
      const requestId = `metadata-${metadataRequestRef.current}`;
      void provider
        .loadVisibleMetadata({ requestId, rowIds, visibleWindowHint: hint })
        .then((next) => {
          rowIds.forEach((rowId) => pendingMetadataRowIdsRef.current.delete(rowId));
          setMetadata((current) => {
            let changed = false;
            const merged = { ...current };
            for (const [rowId, rowMetadata] of Object.entries(next.metadataByRowId)) {
              if (merged[rowId] !== undefined) continue;
              merged[rowId] = rowMetadata;
              changed = true;
            }
            metadataRef.current = changed ? merged : current;
            return changed ? merged : current;
          });
        })
        .catch(() => {
          rowIds.forEach((rowId) => pendingMetadataRowIdsRef.current.delete(rowId));
        });
    },
    [provider],
  );

  const handleAssetFileDragRequest = useCallback(
    (
      row: Extract<BrowseRow, { kind: "asset" }>,
      pointer: { clientX: number; clientY: number },
    ) => {
      const selectedAssets =
        selectedRowIds.has(row.id) && selectedRowIds.size > 1
          ? rows.filter(
              (candidate): candidate is Extract<BrowseRow, { kind: "asset" }> =>
                candidate.kind === "asset" && selectedRowIds.has(candidate.id),
            )
          : [row];
      exportDragActiveRef.current = true;
      setDropOverlayVisible(false);
      window.dispatchEvent(
        new CustomEvent("sonilabs:export-drag-active", {
          detail: { active: true },
        }),
      );
      window.dispatchEvent(
        new CustomEvent("sonilabs:asset-file-drag-request", {
          detail: {
            assets: selectedAssets.map((asset) => ({
              assetId: asset.id,
              displayName: asset.name,
              format: asset.format,
              provider: asset.provider,
              availability: asset.availability,
            })),
            pointer,
          },
        }),
      );
    },
    [rows, selectedRowIds],
  );

  const handleOpenRowInExplorer = useCallback((row: BrowseRow) => {
    void openBrowseRowInExplorer({
      rowId: row.id,
      rowKind: row.kind,
    }).catch((error: unknown) => {
      setRefreshStatus(
        error instanceof Error ? error.message : "Explorer open failed.",
      );
    });
  }, []);

  const handleDeleteBrowseRow = useCallback(
    (row: BrowseRow) => {
      const targetRows =
        selectedRowIds.has(row.id) && selectedRowIds.size > 1
          ? rows.filter((item) => selectedRowIds.has(item.id))
          : [row];
      const targetIds = targetRows.map((item) => item.id);
      const label =
        targetRows.length === 1
          ? row.name
          : `${targetRows.length.toLocaleString()} selected rows`;
      const confirmed = window.confirm(
        `Remove ${label} from the local library index? Files on disk will not be deleted.`,
      );
      if (!confirmed) return;
      void Promise.allSettled(
        targetRows.map((target) =>
          deleteBrowseRow({
            rowId: target.id,
            rowKind: target.kind,
          }),
        ),
      )
        .then((results) => {
          const failed = results.filter(
            (result) => result.status === "rejected",
          ).length;
          const deleted = results.filter(
            (result) => result.status === "fulfilled" && result.value,
          ).length;
          setRefreshStatus(
            failed > 0
              ? `Removed ${deleted}; ${failed} failed.`
              : deleted > 0
                ? `Removed ${deleted.toLocaleString()} from library index.`
                : "Nothing removed.",
          );
          if (deleted > 0) removeRowsById(targetIds);
          dispatch({
            type: "retain",
            orderedRowIds: rows
              .filter((item) => !targetIds.includes(item.id))
              .map((item) => item.id),
          });
          refreshLibraries();
          executeNow({ skipCache: true });
        })
        .catch((error: unknown) => {
          setRefreshStatus(error instanceof Error ? error.message : "Delete failed.");
        });
    },
    [dispatch, executeNow, refreshLibraries, removeRowsById, rows, selectedRowIds],
  );

  const handleInternalRowDragStart = useCallback(
    (event: React.DragEvent, row: BrowseRow) => {
      if (row.kind === "asset") {
        const assetIds =
          selectedRowIds.has(row.id) && selectedRowIds.size > 1
            ? rows
                .filter(
                  (candidate): candidate is Extract<BrowseRow, { kind: "asset" }> =>
                    candidate.kind === "asset" && selectedRowIds.has(candidate.id),
                )
                .map((asset) => asset.id)
            : [row.id];
        event.dataTransfer.setData(
          "application/x-sonilabs-assets",
          JSON.stringify(assetIds),
        );
      } else {
        event.dataTransfer.setData("application/x-sonilabs-folder", row.id);
        event.dataTransfer.setData("text/plain", row.path);
      }
      event.dataTransfer.effectAllowed = "copy";
    },
    [rows, selectedRowIds],
  );

  const handleSortChange = useCallback(
    (sort: SearchSort) => updateActiveTab({ sort }),
    [updateActiveTab],
  );

  const handleApplyFilter = useCallback(
    (filterQuery: string) => {
      const merged = mergeFreeTextWithFilterQuery(
        activeTab?.queryText ?? "",
        filterQuery,
      );
      updateActiveTab({ queryText: merged });
    },
    [activeTab?.queryText, updateActiveTab],
  );

  const handleRefresh = useCallback(() => {
    setRefreshStatus("Refreshing indexed browse data...");
    const refresh =
      activeTab?.sourceId && activeTab.sourceScope.kind === "local"
        ? invoke("reindex_local_source", {
            sourceId: activeTab.sourceId,
            mode: "metadata",
          })
        : invoke<number>("rebuild_asset_search_index");
    void refresh
      .then(() => {
        setRefreshStatus("Refresh requested.");
        executeNow({ skipCache: true });
      })
      .catch((error) => {
        setRefreshStatus(`Refresh unavailable: ${String(error)}`);
        window.dispatchEvent(
          new CustomEvent("sonilabs:refresh-index-intent", {
            detail: {
              sourceId: activeTab?.sourceId ?? null,
              sourceScope: activeTab?.sourceScope ?? { kind: "all" },
            },
          }),
        );
        executeNow({ skipCache: true });
      });
  }, [activeTab, executeNow]);

  const tabModels = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        closeable: tab.closeable,
        dirty: isTabDirty(tab),
      })),
    [tabs],
  );

  const moveBrowseSelection = useCallback(
    (delta: number, extend: boolean) => {
      const currentIndex = orderedRowIds.indexOf(activeRowId ?? "");
      const nextIndex =
        delta < 0
          ? Math.max(0, currentIndex === -1 ? 0 : currentIndex + delta)
          : Math.min(
              orderedRowIds.length - 1,
              currentIndex === -1 ? 0 : currentIndex + delta,
            );
      dispatch({
        type: "move",
        delta,
        orderedRowIds,
        extend,
        keepSelection: false,
      });
      window.dispatchEvent(
        new CustomEvent("sonilabs:browse-scroll-to-index", {
          detail: { index: nextIndex },
        }),
      );
      if (!extend) previewRowByIndex(nextIndex);
    },
    [activeRowId, dispatch, orderedRowIds, previewRowByIndex],
  );

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }

      const command = commandFromKeyboardEvent(event);
      if (
        command !== "move-up" &&
        command !== "move-down" &&
        command !== "extend-up" &&
        command !== "extend-down" &&
        command !== "add-to-collection"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (command === "move-up") moveBrowseSelection(-1, false);
      if (command === "move-down") moveBrowseSelection(1, false);
      if (command === "extend-up") moveBrowseSelection(-1, true);
      if (command === "extend-down") moveBrowseSelection(1, true);
      if (command === "add-to-collection") openCollectionPickerForCurrentSelection();
    };
    window.addEventListener("keydown", handleWindowKeyDown, true);
    return () => window.removeEventListener("keydown", handleWindowKeyDown, true);
  }, [moveBrowseSelection, openCollectionPickerForCurrentSelection]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const command = commandFromKeyboardEvent(event.nativeEvent);
      if (!command) return;
      event.preventDefault();
      if (command === "focus-search") inputRef.current?.focus();
      if (command === "toggle-filter") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:toolbar-intent", {
            detail: { kind: "toggle-filter" },
          }),
        );
      }
      if (command === "new-tab") handleStartNewSearch();
      if (command === "close-tab") handleCloseTab(activeTabId);
      if (command === "next-tab" || command === "previous-tab") {
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
        const delta = command === "next-tab" ? 1 : -1;
        const nextIndex = (currentIndex + delta + tabs.length) % tabs.length;
        const nextTab = tabs[nextIndex];
        if (nextTab) activateViewTab(nextTab.id);
      }
      if (command === "toggle-metadata") modalManager.toggle("file-summary");
      if (command === "move-up") {
        moveBrowseSelection(-1, false);
      }
      if (command === "move-down") {
        moveBrowseSelection(1, false);
      }
      if (command === "extend-up") {
        moveBrowseSelection(-1, true);
      }
      if (command === "extend-down") {
        moveBrowseSelection(1, true);
      }
      if (command === "page-up") {
        dispatch({
          type: "move",
          delta: -18,
          orderedRowIds,
          extend: false,
          keepSelection: false,
        });
      }
      if (command === "page-down") {
        dispatch({
          type: "move",
          delta: 18,
          orderedRowIds,
          extend: false,
          keepSelection: false,
        });
      }
      if (command === "first-row") {
        dispatch({
          type: "jump",
          target: "first",
          orderedRowIds,
          extend: event.shiftKey,
        });
      }
      if (command === "last-row") {
        dispatch({
          type: "jump",
          target: "last",
          orderedRowIds,
          extend: event.shiftKey,
        });
      }
      if (command === "select-all") {
        dispatch({ type: "select-all", orderedRowIds });
      }
      if (command === "add-to-collection") {
        openCollectionPickerForCurrentSelection();
      }
      if (command === "toggle-preview") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:preview-intent", {
            detail: { kind: "toggle-preview", rowId: activeRowId },
          }),
        );
      }
      if (command === "toggle-loop") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:waveform-intent", {
            detail: { kind: "toggle-loop" },
          }),
        );
      }
      if (command === "nudge-playhead-back" || command === "nudge-playhead-forward") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:transport-intent", {
            detail: {
              kind: "nudge-playhead",
              deltaSeconds: command === "nudge-playhead-back" ? -0.05 : 0.05,
            },
          }),
        );
      }
      if (command === "volume-up" || command === "volume-down") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:transport-intent", {
            detail: {
              kind: "volume",
              delta: command === "volume-up" ? 0.05 : -0.05,
            },
          }),
        );
      }
      if (
        command === "channel-all" ||
        command === "channel-left" ||
        command === "channel-right"
      ) {
        window.dispatchEvent(
          new CustomEvent("sonilabs:transport-intent", {
            detail: {
              kind: "channel",
              channelMode:
                command === "channel-all"
                  ? "all"
                  : command === "channel-left"
                    ? "channel:0"
                    : "channel:1",
            },
          }),
        );
      }
      if (command === "export-selection") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:export-intent", {
            detail: { kind: "export-selection" },
          }),
        );
      }
      if (command.startsWith("waveform-zoom-")) {
        window.dispatchEvent(
          new CustomEvent("sonilabs:waveform-intent", {
            detail: { kind: command.replace("waveform-", "") },
          }),
        );
      }
      if (command === "open-row") {
        const row = rows.find((candidate) => candidate.id === activeRowId);
        if (row?.kind === "folder") {
          handleOpenFolderRow(row);
          return;
        }
        window.dispatchEvent(
          new CustomEvent("sonilabs:row-intent", {
            detail: { kind: "open-row", rowId: activeRowId },
          }),
        );
      }
      if (command === "clear-transient") {
        dispatch({ type: "clear" });
        window.dispatchEvent(
          new CustomEvent("sonilabs:waveform-intent", {
            detail: { kind: "clear-region" },
          }),
        );
      }
    },
    [
      activeRowId,
      activeTabId,
      activateViewTab,
      dispatch,
      handleCloseTab,
      handleStartNewSearch,
      handleOpenFolderRow,
      modalManager,
      moveBrowseSelection,
      openCollectionPickerForCurrentSelection,
      orderedRowIds,
      rows,
      tabs,
    ],
  );

  const openSettingsTab = (tab: SettingsPanelTab) => {
    setSettingsTab(tab);
    modalManager.open("settings");
  };

  const startHeaderDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!hasTauri()) return;
    if ((event.target as HTMLElement).closest("[data-titlebar-interactive]")) return;
    void getCurrentWindow().startDragging();
  };

  return (
    <main
      className="relative grid h-screen grid-rows-[minmax(0,1fr)_196px] overflow-hidden bg-background text-foreground"
      onKeyDown={handleKeyDown}
      style={{
        gridTemplateColumns: `${sidebarWidth}px minmax(0,1fr) ${
          summaryOpen ? "308px" : "0px"
        }`,
      }}
    >
      <LeftSidebar
        activity={activity}
        activeCollectionNodeId={activeCollectionNodeId}
        activeLibraryNodeId={activeLibraryNodeId}
        collectionExpandedIds={collectionExpandedIds}
        collections={collections}
        enabledLocalSourceIds={effectiveEnabledLocalSourceIds}
        libraryExpandedIds={libraryExpandedIds}
        libraries={libraryNodes}
        onCollectionExpandedIdsChange={setCollectionExpandedIds}
        onHeaderPointerDown={startHeaderDrag}
        onAddLibraryFolderToCollection={handleAddLibraryFolderToCollection}
        onCopyLibraryPath={handleCopyLibraryPath}
        onCreateChildCollection={handleCreateChildCollection}
        onCreateCollection={handleCreateCollection}
        onDeleteCollection={handleDeleteCollection}
        onDropAssetsIntoCollection={handleDropAssetsIntoCollection}
        onDropFolderIntoCollection={handleDropFolderIntoCollection}
        onDeleteLibraryNode={handleDeleteLibraryNode}
        onCheckOnlyLibraryNode={handleCheckOnlyLibraryNode}
        onOpenCollection={handleOpenCollection}
        onOpenRecentCollection={handleOpenCollection}
        onFinishRenamingCollection={() => setRenamingCollectionId(null)}
        onOpenLibraryNode={handleOpenLibraryNode}
        onOpenLibraryNodeInExplorer={handleOpenLibraryNodeInExplorer}
        onOpenLibraryPath={handleOpenLibraryPath}
        onOpenLibrarySourceSettings={(node) => {
          handleOpenLibraryNode(node);
          openSettingsTab("main");
        }}
        onLibraryExpandedIdsChange={setLibraryExpandedIds}
        onRenameLibraryNode={handleRenameLibraryNode}
        onRemoveFailedLibraryNode={handleRemoveFailedLibraryNode}
        onSearchLibraryNode={handleSearchLibraryNode}
        onToggleMonitorLibraryNode={handleToggleMonitorLibraryNode}
        onRenameCollection={handleRenameCollection}
        onReindexLibraryNode={handleReindexLibraryNode}
        onRetryFailedLibraryNode={handleRetryFailedLibraryNode}
        onResize={setSidebarWidth}
        onSourceEnabledChange={handleLocalSourceEnabledChange}
        onClearActivity={handleClearActivity}
        onClearPreviewed={handleClearPreviewedActivity}
        onRemoveActivity={handleRemoveActivity}
        onRemovePreviewed={handleRemovePreviewedActivity}
        onRestoreActivity={handleRestoreActivity}
        onRestorePreviewed={handleRestoreActivity}
        previewedActivity={previewedActivity}
        renamingCollectionId={renamingCollectionId}
        sourceDropStatus={sourceDropStatus}
        width={sidebarWidth}
      />
      {collectionPickerTarget && modalManager.isOpen("collection-picker") ? (
        <CollectionPickerModal
          collections={collectionPickerCollections}
          initialFocusRef={collectionPickerFocusRef}
          onClose={() => {
            setCollectionPickerTarget(null);
            modalManager.close("collection-picker");
          }}
          onCreateCollection={handleCreateCollectionFromPicker}
          onSelect={handleAddSelectionToCollection}
          target={collectionPickerTarget}
        />
      ) : null}
      <section className="col-start-2 row-start-1 flex min-w-0 flex-col overflow-hidden">
        <div
          className="flex min-h-[52px] items-start gap-3 border-b border-border bg-panel px-3 py-2"
          onPointerDown={startHeaderDrag}
        >
          <TopSearchBar
            activeFilterChips={parsed.query.activeFilterChips}
            inputRef={inputRef}
            onChange={setSearchText}
            onRemoveFilterChip={handleRemoveFilterChip}
            onStartNewSearch={handleStartNewSearch}
            onSubmit={handleSubmitSearch}
            value={searchText}
            warnings={[...parsed.warnings, ...(activeResponse?.warnings ?? [])]}
          />
          <div className="flex h-9 shrink-0 items-center rounded-md border border-border bg-background/40">
            <Toolbar
              density={browseDensity}
              loading={browseLoading}
              onApplyFilter={handleApplyFilter}
              onDensityChange={setBrowseDensity}
              onRefresh={handleRefresh}
              onSortChange={handleSortChange}
              refreshStatus={refreshStatus}
              resultCount={activeResponse?.totalCount ?? rows.length}
              sort={activeSort}
            />
            <div className="h-5 w-px bg-border" />
            <HeaderActions
              onOpenDiagnostics={() => openSettingsTab("diagnostics")}
              onOpenSettings={() => openSettingsTab("main")}
              onOpenShortcuts={() => openSettingsTab("shortcuts")}
            />
            <div className="h-5 w-px bg-border" />
            <WindowControls />
          </div>
        </div>
        <ViewTabs
          activeTabId={activeTabId}
          onActivate={activateViewTab}
          onClose={handleCloseTab}
          tabs={tabModels}
        />
        {activeTab?.breadcrumbSegments.length ? (
          <Breadcrumbs
            onNavigate={handleBreadcrumbNavigate}
            segments={activeTab.breadcrumbSegments}
          />
        ) : null}
        {indexingStatus ? (
          <div className="border-b border-border bg-panel px-3 py-1 text-[11px] text-muted-foreground">
            Indexing: {indexingStatus}
          </div>
        ) : null}
        {enabledLocalSourceIds !== null ? (
          <div className="flex h-7 items-center justify-between border-b border-border bg-panel px-3 text-[11px] text-muted-foreground">
            <span>
              Library filter: {effectiveEnabledLocalSourceIds.length}/
              {localSourceIds.length} enabled
            </span>
            <button
              className="text-foreground hover:underline"
              onClick={clearLocalSourceFilter}
              type="button"
            >
              All libraries
            </button>
          </div>
        ) : null}
        <BrowseTable
          density={browseDensity}
          loading={browseLoading}
          metadataByRowId={metadata}
          onAddToCollection={handleOpenCollectionPickerForRow}
          onAssetFileDragRequest={handleAssetFileDragRequest}
          onDeleteRow={handleDeleteBrowseRow}
          onGoToFolder={handleGoToRowFolder}
          onInternalDragStart={handleInternalRowDragStart}
          onOpenInExplorer={handleOpenRowInExplorer}
          onOpenFolder={handleOpenFolderRow}
          onSortChange={handleSortChange}
          onVisibleRowsChange={handleVisibleRows}
          previewedRowIds={previewedRowIds}
          queryText={searchText}
          rows={rows}
          sort={activeSort}
          totalCount={activeResponse?.totalCount ?? rows.length}
        />
        <span aria-live="polite" className="sr-only">
          {activeRowId ? `Active row ${activeRowId}` : "No active row"}
        </span>
      </section>
      {summaryOpen ? (
        <RightInspector
          activeAsset={activeAsset}
          onMetadataChanged={refreshTagTree}
          onClose={() => modalManager.close("file-summary")}
        />
      ) : null}
      <BottomDockPlaceholder
        isSummaryOpen={summaryOpen}
        onExportsChanged={refreshActivity}
        onPlayedAsset={handlePlayedAsset}
        onPreviewedRow={markPreviewedRow}
        onToggleSummary={() => modalManager.toggle("file-summary")}
        rows={rows}
      />
      {pendingImportPaths ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <section className="w-[min(520px,calc(100vw-32px))] rounded-md border border-border bg-panel p-4 shadow-2xl">
            <h2 className="mb-5 text-[16px] font-semibold text-foreground">
              Import Audio
            </h2>
            <label className="mb-4 flex items-center justify-between gap-4 text-[14px] text-foreground">
              <span>Monitor and automatically update folder</span>
              <input
                checked={importOptions.monitorForChanges}
                className="h-5 w-9 accent-primary"
                onChange={(event) =>
                  setImportOptions((current) => ({
                    ...current,
                    monitorForChanges: event.target.checked,
                  }))
                }
                type="checkbox"
              />
            </label>
            <label className="mb-3 flex items-center justify-between gap-4 text-[14px] text-foreground">
              <span>Add metadata file</span>
              <input
                checked={importOptions.metadataImportEnabled}
                className="h-5 w-9 accent-primary"
                onChange={(event) =>
                  setImportOptions((current) => ({
                    ...current,
                    metadataImportEnabled: event.target.checked,
                  }))
                }
                type="checkbox"
              />
            </label>
            {importOptions.metadataImportEnabled ? (
              <button
                className="mb-6 flex h-9 w-full items-center justify-between rounded-md bg-muted px-3 text-left text-[12px] text-foreground"
                onClick={pickImportMetadataFile}
                type="button"
              >
                <span className="min-w-0 truncate">
                  {importOptions.metadataFile ?? "Choose PDF, XLS, CSV, TAB, or TXT"}
                </span>
                <span className="shrink-0 text-muted-foreground">Browse</span>
              </button>
            ) : (
              <div className="mb-6" />
            )}
            <div className="flex justify-end gap-2">
              <Button className="h-9 px-7" onClick={confirmPendingImport}>
                Import
              </Button>
              <Button
                className="h-9 px-7"
                onClick={() => setPendingImportPaths(null)}
                variant="secondary"
              >
                Cancel
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      {dropOverlayVisible ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="flex w-[min(560px,calc(100vw-48px))] items-center gap-8 border border-dashed border-white/50 bg-primary px-10 py-8 text-primary-foreground shadow-2xl">
            <HardDriveDownload className="size-12 shrink-0" />
            <span className="text-[15px] font-medium">
              Drop file or folder to add to a local library
            </span>
          </div>
        </div>
      ) : null}
      {showLocalOnboarding ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70">
          <section className="w-[min(520px,calc(100vw-32px))] border border-border bg-panel p-4 shadow-2xl">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-foreground">
              <HardDriveDownload className="size-4" />
              Add a local sound folder
            </div>
            <p className="mb-4 text-[12px] text-muted-foreground">
              Sonilabs is local-only in this build. Add a folder to index, browse,
              preview, and export sounds.
            </p>
            <div className="flex gap-2">
              <Button className="h-8" onClick={handlePickLocalFolder} size="sm">
                Add Local Folder
              </Button>
              <Button
                className="h-8"
                onClick={dismissLocalOnboarding}
                size="sm"
                variant="ghost"
              >
                Dismiss
              </Button>
            </div>
          </section>
        </div>
      ) : null}
      {startupUpdate?.available ? (
        <section className="fixed bottom-5 right-5 z-50 w-[min(360px,calc(100vw-32px))] rounded-md border border-border bg-panel p-3 shadow-2xl">
          <div className="mb-1 text-[13px] font-semibold text-foreground">
            Update {startupUpdate.version} available
          </div>
          <div className="mb-3 text-[11px] text-muted-foreground">
            {startupUpdateStatus ??
              `Current version ${startupUpdate.currentVersion ?? "installed"}.`}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              className="h-8"
              disabled={Boolean(startupUpdateStatus?.includes("Downloading"))}
              onClick={() => {
                setStartupUpdateStatus("Downloading update...");
                void checkInstallAndRelaunchUpdate(setStartupUpdateStatus).catch(
                  (error: unknown) =>
                    setStartupUpdateStatus(
                      error instanceof Error ? error.message : "Update failed.",
                    ),
                );
              }}
              size="sm"
            >
              Install
            </Button>
            <Button
              className="h-8"
              onClick={() => setStartupUpdate(null)}
              size="sm"
              variant="ghost"
            >
              Later
            </Button>
          </div>
        </section>
      ) : null}
      <SettingsPanel
        activeTab={settingsTab}
        localSources={localSourcesForSettings}
        onAddLocalFolder={handlePickLocalFolder}
        onClose={() => modalManager.close("settings")}
        onDeleteSource={handleDeleteSourceById}
        onRefreshSources={refreshLibraries}
        onReindexSource={handleReindexSourceById}
        onTabChange={setSettingsTab}
        open={settingsOpen}
      />
    </main>
  );
}
