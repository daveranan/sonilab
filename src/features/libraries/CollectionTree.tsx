import { ChevronDown, ChevronRight, FolderHeart } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

import type { CollectionNode } from "./libraryTypes";
import { toggleExpandedNodeIds } from "./treeExpansion";

function findCollectionPath(
  nodes: CollectionNode[],
  id: string,
  path: string[] = [],
): string[] | null {
  for (const node of nodes) {
    const nextPath = [...path, node.id];
    if (node.id === id) return nextPath;
    const childPath = node.children
      ? findCollectionPath(node.children, id, nextPath)
      : null;
    if (childPath) return childPath;
  }
  return null;
}

function CollectionTreeNode({
  node,
  depth,
  expanded,
  toggle,
  onOpenCollection,
  onCreateChildCollection,
  onRenameCollection,
  onDeleteCollection,
  onDropAssets,
  onDropFolderRef,
  editingId,
  startRenaming,
  finishRenaming,
  activeNodeId,
}: {
  node: CollectionNode;
  depth: number;
  expanded: Set<string>;
  toggle: (node: CollectionNode, recursive: boolean) => void;
  onOpenCollection?: (node: CollectionNode) => void;
  onCreateChildCollection?: (node: CollectionNode) => void;
  onRenameCollection?: (node: CollectionNode, name: string) => void;
  onDeleteCollection?: (node: CollectionNode) => void;
  onDropAssets?: (node: CollectionNode, assetIds: string[]) => void;
  onDropFolderRef?: (node: CollectionNode, folderId: string) => void;
  editingId: string | null;
  startRenaming: (node: CollectionNode) => void;
  finishRenaming: () => void;
  activeNodeId?: string | null;
}) {
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = expanded.has(node.id);
  const isActive = activeNodeId === node.id;
  const canDelete = !node.system;
  const isEditing = editingId === node.id;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) return;
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [isEditing, node.label]);

  function commitRename() {
    const nextName = (inputRef.current?.value ?? node.label).trim();
    if (nextName && nextName !== node.label) {
      onRenameCollection?.(node, nextName);
    }
    finishRenaming();
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            aria-selected={isActive}
            className={cn(
              "flex h-8 w-full cursor-default items-center gap-1.5 truncate rounded-sm px-2 text-left text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground",
              isActive &&
                "bg-zinc-200 text-zinc-950 hover:bg-zinc-200 [&_*]:text-zinc-950",
            )}
            data-collection-id={node.id}
            onClick={() => {
              if (!isEditing) onOpenCollection?.(node);
            }}
            onKeyDown={(event) => {
              if (isEditing || (event.key !== "Enter" && event.key !== " ")) return;
              event.preventDefault();
              onOpenCollection?.(node);
            }}
            onDragOver={(event) => {
              if (
                event.dataTransfer.types.includes("application/x-sonilabs-assets") ||
                event.dataTransfer.types.includes("application/x-sonilabs-folder")
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(event) => {
              const assetPayload = event.dataTransfer.getData(
                "application/x-sonilabs-assets",
              );
              const folderPayload = event.dataTransfer.getData(
                "application/x-sonilabs-folder",
              );
              if (assetPayload) {
                event.preventDefault();
                try {
                  const parsed = JSON.parse(assetPayload) as unknown;
                  onDropAssets?.(
                    node,
                    Array.isArray(parsed)
                      ? parsed.filter(
                          (item): item is string => typeof item === "string",
                        )
                      : [],
                  );
                } catch {
                  onDropAssets?.(node, []);
                }
              } else if (folderPayload) {
                event.preventDefault();
                onDropFolderRef?.(node, folderPayload);
              }
            }}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            role="treeitem"
            tabIndex={0}
            title={node.label}
          >
            {hasChildren ? (
              <button
                aria-label={
                  isExpanded ? `Collapse ${node.label}` : `Expand ${node.label}`
                }
                className="-mx-1 flex h-8 w-7 shrink-0 items-center justify-center"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(node, event.altKey);
                }}
                type="button"
              >
                {isExpanded ? (
                  <ChevronDown className="size-3" />
                ) : (
                  <ChevronRight className="size-3" />
                )}
              </button>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <FolderHeart className="size-3.5 shrink-0" />
            {isEditing ? (
              <input
                aria-label={`Rename ${node.label}`}
                className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 py-0 text-[13px] text-foreground outline-none"
                defaultValue={node.label}
                onBlur={commitRename}
                onClick={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    finishRenaming();
                  }
                }}
                onPointerDown={(event) => event.stopPropagation()}
                ref={inputRef}
              />
            ) : (
              <span className="min-w-0 flex-1 truncate text-left">{node.label}</span>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={node.system}
            onSelect={() => {
              window.setTimeout(() => startRenaming(node), 0);
            }}
          >
            Rename collection
          </ContextMenuItem>
          <ContextMenuItem
            disabled={node.system}
            onSelect={() => {
              window.setTimeout(() => onCreateChildCollection?.(node), 0);
            }}
          >
            New nested collection
          </ContextMenuItem>
          <ContextMenuItem disabled>Save current search here</ContextMenuItem>
          <ContextMenuSeparator className="my-1 h-px bg-border" />
          <ContextMenuItem
            disabled={!canDelete}
            onSelect={() => onDeleteCollection?.(node)}
          >
            Delete collection
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {hasChildren && isExpanded
        ? node.children?.map((child) => (
            <CollectionTreeNode
              depth={depth + 1}
              expanded={expanded}
              key={child.id}
              node={child}
              activeNodeId={activeNodeId}
              onCreateChildCollection={onCreateChildCollection}
              onDeleteCollection={onDeleteCollection}
              onDropAssets={onDropAssets}
              onDropFolderRef={onDropFolderRef}
              onOpenCollection={onOpenCollection}
              onRenameCollection={onRenameCollection}
              editingId={editingId}
              finishRenaming={finishRenaming}
              startRenaming={startRenaming}
              toggle={toggle}
            />
          ))
        : null}
    </>
  );
}

export function CollectionTree({
  activeNodeId,
  expandedIds,
  nodes,
  onExpandedIdsChange,
  onOpenCollection,
  onCreateChildCollection,
  onRenameCollection,
  onDeleteCollection,
  onDropAssets,
  onDropFolderRef,
  renamingCollectionId,
  onFinishRenamingCollection,
}: {
  expandedIds?: string[];
  nodes: CollectionNode[];
  onExpandedIdsChange?: (ids: string[]) => void;
  onOpenCollection?: (node: CollectionNode) => void;
  onCreateChildCollection?: (node: CollectionNode) => void;
  onRenameCollection?: (node: CollectionNode, name: string) => void;
  onDeleteCollection?: (node: CollectionNode) => void;
  onDropAssets?: (node: CollectionNode, assetIds: string[]) => void;
  onDropFolderRef?: (node: CollectionNode, folderId: string) => void;
  renamingCollectionId?: string | null;
  onFinishRenamingCollection?: () => void;
  activeNodeId?: string | null;
}) {
  const [internalExpanded, setInternalExpanded] = useState(() => new Set(["project"]));
  const expanded = new Set(expandedIds ?? [...internalExpanded]);
  const [manualEditingId, setManualEditingId] = useState<string | null>(null);
  const editingId = manualEditingId ?? renamingCollectionId ?? null;
  const visibleExpanded = new Set(expanded);
  if (renamingCollectionId) {
    const path = findCollectionPath(nodes, renamingCollectionId);
    for (const id of path?.slice(0, -1) ?? []) visibleExpanded.add(id);
  }

  function finishRenaming() {
    setManualEditingId(null);
    onFinishRenamingCollection?.();
  }

  function setExpandedIds(ids: Set<string>) {
    if (expandedIds === undefined) setInternalExpanded(ids);
    onExpandedIdsChange?.([...ids]);
  }

  return (
    <div role="tree">
      {nodes.map((node) => (
        <CollectionTreeNode
          depth={0}
          expanded={visibleExpanded}
          activeNodeId={activeNodeId}
          key={node.id}
          node={node}
          onCreateChildCollection={onCreateChildCollection}
          onDeleteCollection={onDeleteCollection}
          onDropAssets={onDropAssets}
          onDropFolderRef={onDropFolderRef}
          onOpenCollection={onOpenCollection}
          onRenameCollection={onRenameCollection}
          editingId={editingId}
          finishRenaming={finishRenaming}
          startRenaming={(node) => setManualEditingId(node.id)}
          toggle={(node, recursive) =>
            setExpandedIds(new Set(toggleExpandedNodeIds(expanded, node, recursive)))
          }
        />
      ))}
    </div>
  );
}
