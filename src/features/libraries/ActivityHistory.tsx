import { ChevronDown, ChevronRight, FileAudio, FolderHeart, History, X } from "lucide-react";
import type React from "react";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import type { ActivityRow, CollectionNode } from "./libraryTypes";

type SectionKey = "search" | "previewed" | "collections";

function flattenCollections(nodes: CollectionNode[]): CollectionNode[] {
  return nodes.flatMap((node) => [node, ...flattenCollections(node.children ?? [])]);
}

function sortRecentCollections(nodes: CollectionNode[]): CollectionNode[] {
  return flattenCollections(nodes)
    .filter((node) => !node.system)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

function ActivitySection({
  id,
  title,
  count,
  open,
  onToggle,
  onClear,
  children,
}: {
  id: SectionKey;
  title: string;
  count: number;
  open: boolean;
  onToggle: (id: SectionKey) => void;
  onClear?: () => void;
  children: React.ReactNode;
}) {
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <div className="flex h-7 items-center gap-1 px-2 text-[12px] text-foreground">
        <button
          className="flex min-w-0 flex-1 items-center gap-1 truncate text-left"
          onClick={() => onToggle(id)}
          type="button"
        >
          <Icon className="size-3 shrink-0" />
          <span className="truncate">{title}</span>
          <span className="text-[10px] text-muted-foreground">{count}</span>
        </button>
        {onClear && count > 0 ? (
          <button
            aria-label={`Clear ${title}`}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onClear}
            title={`Clear ${title}`}
            type="button"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {open ? children : null}
    </div>
  );
}

function ActivityButton({
  row,
  icon,
  onOpen,
  onRemove,
}: {
  row: ActivityRow;
  icon: React.ReactNode;
  onOpen?: (row: ActivityRow) => void;
  onRemove?: (row: ActivityRow) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className="flex h-8 w-full items-center gap-2 truncate rounded-sm px-5 text-left text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => onOpen?.(row)}
          title={row.detail}
          type="button"
        >
          {icon}
          <span className="min-w-0 flex-1 truncate">
            <span className="block truncate">{row.detail}</span>
            {row.label ? (
              <span className="block truncate text-[10px] text-muted-foreground">
                {row.label}
              </span>
            ) : null}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen?.(row)}>Open</ContextMenuItem>
        <ContextMenuSeparator className="my-1 h-px bg-border" />
        <ContextMenuItem onSelect={() => onRemove?.(row)}>Remove</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function ActivityHistory({
  searchRows,
  previewedRows,
  recentCollections,
  onRestoreSearch,
  onRemoveSearchHistory,
  onClearSearchHistory,
  onRestorePreviewed,
  onRemovePreviewed,
  onClearPreviewed,
  onOpenCollection,
}: {
  searchRows: ActivityRow[];
  previewedRows: ActivityRow[];
  recentCollections: CollectionNode[];
  onRestoreSearch?: (row: ActivityRow) => void;
  onRemoveSearchHistory?: (row: ActivityRow) => void;
  onClearSearchHistory?: () => void;
  onRestorePreviewed?: (row: ActivityRow) => void;
  onRemovePreviewed?: (row: ActivityRow) => void;
  onClearPreviewed?: () => void;
  onOpenCollection?: (node: CollectionNode) => void;
}) {
  const [openSections, setOpenSections] = useState(
    () => new Set<SectionKey>(["search", "previewed", "collections"]),
  );
  const collections = sortRecentCollections(recentCollections);

  function toggle(id: SectionKey) {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-0.5">
      <ActivitySection
        count={searchRows.length}
        id="search"
        onClear={onClearSearchHistory}
        onToggle={toggle}
        open={openSections.has("search")}
        title="Search history"
      >
        {searchRows.map((row) => (
          <ActivityButton
            icon={<History className="size-3.5 shrink-0" />}
            key={row.id}
            onOpen={onRestoreSearch}
            onRemove={onRemoveSearchHistory}
            row={row}
          />
        ))}
      </ActivitySection>
      <ActivitySection
        count={previewedRows.length}
        id="previewed"
        onClear={onClearPreviewed}
        onToggle={toggle}
        open={openSections.has("previewed")}
        title="Previewed"
      >
        {previewedRows.map((row) => (
          <ActivityButton
            icon={<FileAudio className="size-3.5 shrink-0" />}
            key={row.id}
            onOpen={onRestorePreviewed}
            onRemove={onRemovePreviewed}
            row={row}
          />
        ))}
      </ActivitySection>
      <ActivitySection
        count={collections.length}
        id="collections"
        onToggle={toggle}
        open={openSections.has("collections")}
        title="Recently collected"
      >
        {collections.map((collection) => (
          <button
            className="flex h-8 w-full items-center gap-2 truncate rounded-sm px-5 text-left text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
            key={collection.id}
            onClick={() => onOpenCollection?.(collection)}
            title={collection.label}
            type="button"
          >
            <FolderHeart className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{collection.label}</span>
          </button>
        ))}
      </ActivitySection>
    </div>
  );
}
