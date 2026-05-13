import { GripVertical, Plus } from "lucide-react";
import type React from "react";

import { ActivityHistory } from "@/features/libraries/ActivityHistory";
import { CollectionTree } from "@/features/libraries/CollectionTree";
import { LibraryTree } from "@/features/libraries/LibraryTree";
import type {
  ActivityRow,
  CollectionNode,
  LibraryNode,
} from "@/features/libraries/libraryTypes";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-border/80 py-2">
      <div className="px-3 pb-1 text-[11px] font-semibold uppercase text-muted-foreground">
        {title}
      </div>
      {children}
    </section>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 pb-1 text-[11px] font-semibold uppercase text-muted-foreground">
      <span>{title}</span>
      {action}
    </div>
  );
}

export function LeftSidebar({
  libraries,
  collections,
  activity,
  collectionExpandedIds,
  libraryExpandedIds,
  width = 280,
  onResize,
  onHeaderPointerDown,
  onCollectionExpandedIdsChange,
  onLibraryExpandedIdsChange,
  onOpenLibraryNode,
  onOpenLibraryNodeInExplorer,
  onDeleteLibraryNode,
  onOpenLibraryPath,
  onReindexLibraryNode,
  onRemoveFailedLibraryNode,
  onRetryFailedLibraryNode,
  onSearchLibraryNode,
  onCheckOnlyLibraryNode,
  onRenameLibraryNode,
  onToggleMonitorLibraryNode,
  onAddLibraryFolderToCollection,
  onOpenLibrarySourceSettings,
  onCopyLibraryPath,
  onOpenCollection,
  onOpenRecentCollection,
  onCreateCollection,
  onCreateChildCollection,
  onRenameCollection,
  onDeleteCollection,
  onDropAssetsIntoCollection,
  onDropFolderIntoCollection,
  renamingCollectionId,
  onFinishRenamingCollection,
  onRestoreActivity,
  onRemoveActivity,
  onClearActivity,
  previewedActivity,
  onRestorePreviewed,
  onRemovePreviewed,
  onClearPreviewed,
  sourceDropStatus,
}: {
  libraries: LibraryNode[];
  collections: CollectionNode[];
  activity: ActivityRow[];
  collectionExpandedIds?: string[];
  libraryExpandedIds?: string[];
  width?: number;
  onResize?: (width: number) => void;
  onHeaderPointerDown?: (event: React.PointerEvent<HTMLElement>) => void;
  onCollectionExpandedIdsChange?: (ids: string[]) => void;
  onLibraryExpandedIdsChange?: (ids: string[]) => void;
  onOpenLibraryNode?: (node: LibraryNode) => void;
  onOpenLibraryNodeInExplorer?: (node: LibraryNode) => void;
  onDeleteLibraryNode?: (node: LibraryNode) => void;
  onOpenLibraryPath?: (node: LibraryNode, path: string) => void;
  onReindexLibraryNode?: (node: LibraryNode) => void;
  onRemoveFailedLibraryNode?: (node: LibraryNode) => void;
  onRetryFailedLibraryNode?: (node: LibraryNode) => void;
  onSearchLibraryNode?: (node: LibraryNode) => void;
  onCheckOnlyLibraryNode?: (node: LibraryNode) => void;
  onRenameLibraryNode?: (node: LibraryNode) => void;
  onToggleMonitorLibraryNode?: (node: LibraryNode) => void;
  onAddLibraryFolderToCollection?: (node: LibraryNode) => void;
  onOpenLibrarySourceSettings?: (node: LibraryNode) => void;
  onCopyLibraryPath?: (node: LibraryNode, path: string) => void;
  onOpenCollection?: (node: CollectionNode) => void;
  onOpenRecentCollection?: (node: CollectionNode) => void;
  onCreateCollection?: () => void;
  onCreateChildCollection?: (node: CollectionNode) => void;
  onRenameCollection?: (node: CollectionNode, name: string) => void;
  onDeleteCollection?: (node: CollectionNode) => void;
  onDropAssetsIntoCollection?: (node: CollectionNode, assetIds: string[]) => void;
  onDropFolderIntoCollection?: (node: CollectionNode, folderId: string) => void;
  renamingCollectionId?: string | null;
  onFinishRenamingCollection?: () => void;
  onRestoreActivity?: (row: ActivityRow) => void;
  onRemoveActivity?: (row: ActivityRow) => void;
  onClearActivity?: () => void;
  previewedActivity?: ActivityRow[];
  onRestorePreviewed?: (row: ActivityRow) => void;
  onRemovePreviewed?: (row: ActivityRow) => void;
  onClearPreviewed?: () => void;
  sourceDropStatus?: string | null;
}) {
  function startResize(event: React.PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const resize = onResize;
    if (!resize) return;
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    function handleMove(moveEvent: PointerEvent) {
      resize?.(Math.min(360, Math.max(240, startWidth + moveEvent.clientX - startX)));
    }

    function handleUp(upEvent: PointerEvent) {
      target.releasePointerCapture(upEvent.pointerId);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }

  return (
    <aside className="relative col-start-1 row-span-2 row-start-1 flex min-w-[240px] max-w-[360px] flex-col overflow-hidden border-r border-border bg-sidebar">
      <div
        className="flex min-h-[53px] items-center justify-between border-b border-border px-3 py-2 text-[12px] font-semibold uppercase tracking-normal text-foreground"
        onPointerDown={onHeaderPointerDown}
      >
        Sonilabs
        <button
          aria-label="Resize sidebar"
          className="-mr-2 flex h-8 w-4 cursor-col-resize items-center justify-center text-muted-foreground hover:text-foreground"
          data-titlebar-interactive
          onPointerDown={startResize}
          type="button"
        >
          <GripVertical className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <section className="border-b border-border/80 py-2">
          {sourceDropStatus ? (
            <div className="mx-3 mb-2 rounded-md border border-border bg-muted/25 px-2 py-1.5 text-[11px] text-muted-foreground">
              {sourceDropStatus}
            </div>
          ) : null}
          <LibraryTree
            expandedIds={libraryExpandedIds}
            nodes={libraries}
            onExpandedIdsChange={onLibraryExpandedIdsChange}
            onAddFolderToCollection={onAddLibraryFolderToCollection}
            onCopyPath={onCopyLibraryPath}
            onDeleteNode={onDeleteLibraryNode}
            onOpenInExplorer={onOpenLibraryNodeInExplorer}
            onOpenNode={onOpenLibraryNode}
            onOpenPath={onOpenLibraryPath}
            onOpenSourceSettings={onOpenLibrarySourceSettings}
            onCheckOnlyNode={onCheckOnlyLibraryNode}
            onRemoveFailedNode={onRemoveFailedLibraryNode}
            onReindexNode={onReindexLibraryNode}
            onRenameNode={onRenameLibraryNode}
            onRetryFailedNode={onRetryFailedLibraryNode}
            onSearchNode={onSearchLibraryNode}
            onToggleMonitorNode={onToggleMonitorLibraryNode}
          />
        </section>
        <section className="border-b border-border/80 py-2">
          <SectionHeader
            action={
              <button
                aria-label="New collection"
                className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
                onClick={onCreateCollection}
                title="New collection"
                type="button"
              >
                <Plus className="size-3.5" />
              </button>
            }
            title="Collections"
          />
          <CollectionTree
            expandedIds={collectionExpandedIds}
            nodes={collections}
            onExpandedIdsChange={onCollectionExpandedIdsChange}
            onCreateChildCollection={onCreateChildCollection}
            onDeleteCollection={onDeleteCollection}
            onDropAssets={onDropAssetsIntoCollection}
            onDropFolderRef={onDropFolderIntoCollection}
            onOpenCollection={onOpenCollection}
            onFinishRenamingCollection={onFinishRenamingCollection}
            onRenameCollection={onRenameCollection}
            renamingCollectionId={renamingCollectionId}
          />
        </section>
        <Section title="Activity History">
          <ActivityHistory
            onClearSearchHistory={onClearActivity}
            onClearPreviewed={onClearPreviewed}
            onOpenCollection={onOpenRecentCollection ?? onOpenCollection}
            onRemovePreviewed={onRemovePreviewed}
            onRemoveSearchHistory={onRemoveActivity}
            onRestorePreviewed={onRestorePreviewed}
            onRestoreSearch={onRestoreActivity}
            previewedRows={previewedActivity ?? []}
            recentCollections={collections}
            searchRows={activity}
          />
        </Section>
      </div>
    </aside>
  );
}
