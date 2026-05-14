import {
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  HardDrive,
  Tags,
} from "lucide-react";
import { useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";

import type { LibraryNode } from "./libraryTypes";
import { sourceStatusIcon, sourceStatusLabels } from "./sourceStatus";
import { toggleExpandedNodeIds } from "./treeExpansion";

type LibraryTreeProps = {
  expandedIds?: string[];
  nodes: LibraryNode[];
  onExpandedIdsChange?: (ids: string[]) => void;
  onOpenNode?: (node: LibraryNode) => void;
  onOpenInExplorer?: (node: LibraryNode) => void;
  onDeleteNode?: (node: LibraryNode) => void;
  onOpenPath?: (node: LibraryNode, path: string) => void;
  onReindexNode?: (node: LibraryNode) => void;
  onRemoveFailedNode?: (node: LibraryNode) => void;
  onRetryFailedNode?: (node: LibraryNode) => void;
  onSearchNode?: (node: LibraryNode) => void;
  onCheckOnlyNode?: (node: LibraryNode) => void;
  onRenameNode?: (node: LibraryNode) => void;
  onToggleMonitorNode?: (node: LibraryNode) => void;
  onAddFolderToCollection?: (node: LibraryNode) => void;
  onOpenSourceSettings?: (node: LibraryNode) => void;
  onCopyPath?: (node: LibraryNode, path: string) => void;
};

function joinDisplayPath(root: string, path: string): string {
  if (!root) return path;
  if (!path) return root;
  return `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

function TreeNode({
  node,
  depth,
  expanded,
  toggle,
  onOpenNode,
  onOpenInExplorer,
  onDeleteNode,
  onOpenPath,
  onReindexNode,
  onRemoveFailedNode,
  onRetryFailedNode,
  onSearchNode,
  onCheckOnlyNode,
  onRenameNode,
  onToggleMonitorNode,
  onAddFolderToCollection,
  onOpenSourceSettings,
  onCopyPath,
  inheritedRootUri,
}: {
  node: LibraryNode;
  depth: number;
  expanded: Set<string>;
  toggle: (node: LibraryNode, recursive: boolean) => void;
  onOpenNode?: (node: LibraryNode) => void;
  onOpenInExplorer?: (node: LibraryNode) => void;
  onDeleteNode?: (node: LibraryNode) => void;
  onOpenPath?: (node: LibraryNode, path: string) => void;
  onReindexNode?: (node: LibraryNode) => void;
  onRemoveFailedNode?: (node: LibraryNode) => void;
  onRetryFailedNode?: (node: LibraryNode) => void;
  onSearchNode?: (node: LibraryNode) => void;
  onCheckOnlyNode?: (node: LibraryNode) => void;
  onRenameNode?: (node: LibraryNode) => void;
  onToggleMonitorNode?: (node: LibraryNode) => void;
  onAddFolderToCollection?: (node: LibraryNode) => void;
  onOpenSourceSettings?: (node: LibraryNode) => void;
  onCopyPath?: (node: LibraryNode, path: string) => void;
  inheritedRootUri?: string;
}) {
  const hasChildren = Boolean(node.children?.length);
  const isExpanded = expanded.has(node.id);
  const Icon =
    node.kind === "tagRoot" || node.kind === "tagCategory" || node.kind === "query"
      ? Tags
      : node.label === "Cloud"
        ? Cloud
        : node.label === "Local"
          ? HardDrive
          : Folder;
  const StatusIcon = node.status ? sourceStatusIcon[node.status] : null;

  const rootUri = node.rootUri ?? inheritedRootUri ?? "";
  const isCloudNode = node.id.startsWith("cloud") || node.label === "Cloud";
  const canReindex = node.kind === "folder" || (node.kind === "source" && !isCloudNode);
  const nodePath =
    node.kind === "source"
      ? rootUri
      : node.kind === "folder"
        ? joinDisplayPath(rootUri, node.path ?? "")
        : "";
  const canOpenInExplorer =
    (node.kind === "folder" && Boolean(node.folderId)) ||
    (node.kind === "source" && Boolean(node.rootUri));
  const canOpenPath = Boolean(nodePath) || canOpenInExplorer;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="flex h-7 w-full items-center gap-1.5 truncate rounded-sm px-2 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            title={node.label}
          >
            {hasChildren ? (
              <button
                aria-label={
                  isExpanded ? `Collapse ${node.label}` : `Expand ${node.label}`
                }
                className="-mx-1 flex h-7 w-6 shrink-0 items-center justify-center"
                onClick={(event) => toggle(node, event.altKey)}
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
            <Icon className="size-3.5 shrink-0" />
            <button
              className="min-w-0 flex-1 truncate text-left"
              onClick={(event) =>
                event.altKey && onCheckOnlyNode
                  ? onCheckOnlyNode(node)
                  : onOpenNode?.(node)
              }
              type="button"
            >
              {node.label}
            </button>
            {StatusIcon ? (
              <StatusIcon
                aria-label={sourceStatusLabels[node.status!]}
                className={cn(
                  "size-3 shrink-0",
                  node.status === "indexing" && "animate-spin",
                )}
              />
            ) : null}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {node.kind === "source" ||
          node.kind === "folder" ||
          node.kind === "query" ||
          node.kind === "tagCategory" ? (
            <ContextMenuItem onSelect={() => onSearchNode?.(node)}>
              Search in library
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" || node.kind === "folder" ? (
            <ContextMenuItem onSelect={() => onCheckOnlyNode?.(node)}>
              Check only this library
              <span className="ml-8 text-[10px] text-muted-foreground">Alt+Click</span>
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" || node.kind === "folder" ? (
            <ContextMenuItem
              disabled={!canReindex}
              onSelect={() => onReindexNode?.(node)}
            >
              Scan for new files
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" || node.kind === "folder" ? (
            <ContextMenuItem onSelect={() => onRetryFailedNode?.(node)}>
              Retry failed files
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" || node.kind === "folder" ? (
            <ContextMenuItem onSelect={() => onRemoveFailedNode?.(node)}>
              Remove failed files
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" || node.kind === "folder" ? (
            <ContextMenuItem
              disabled={!canOpenPath}
              onSelect={() =>
                onOpenInExplorer && canOpenInExplorer
                  ? onOpenInExplorer(node)
                  : onOpenPath?.(node, nodePath)
              }
            >
              Show in Explorer
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" ? (
            <ContextMenuSeparator className="my-1 h-px bg-border" />
          ) : null}
          {node.kind === "source" ? (
            <ContextMenuItem onSelect={() => onRenameNode?.(node)}>
              Rename
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" ? (
            <ContextMenuItem onSelect={() => onToggleMonitorNode?.(node)}>
              {node.monitorForChanges ? "✓ " : ""}Monitor for changes
            </ContextMenuItem>
          ) : null}
          {node.kind === "folder" ? (
            <ContextMenuItem
              disabled={!node.folderId}
              onSelect={() => onAddFolderToCollection?.(node)}
            >
              Add to collection
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" ? (
            <ContextMenuItem onSelect={() => onOpenSourceSettings?.(node)}>
              Source settings
            </ContextMenuItem>
          ) : null}
          {node.kind === "root" && node.id === "libraries-local" ? (
            <ContextMenuItem disabled>Add source</ContextMenuItem>
          ) : null}
          <ContextMenuSeparator className="my-1 h-px bg-border" />
          <ContextMenuItem
            disabled={!nodePath}
            onSelect={() => onCopyPath?.(node, nodePath)}
          >
            Copy path
          </ContextMenuItem>
          {node.kind === "folder" ? (
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              disabled={!node.folderId}
              onSelect={() => onDeleteNode?.(node)}
            >
              Remove
            </ContextMenuItem>
          ) : null}
          {node.kind === "source" && !isCloudNode ? (
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDeleteNode?.(node)}
            >
              Remove
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
      {hasChildren && isExpanded
        ? node.children?.map((child) => (
            <TreeNode
              depth={depth + 1}
              expanded={expanded}
              key={child.id}
              node={child}
              inheritedRootUri={rootUri}
              onAddFolderToCollection={onAddFolderToCollection}
              onCopyPath={onCopyPath}
              onDeleteNode={onDeleteNode}
              onOpenInExplorer={onOpenInExplorer}
              onOpenNode={onOpenNode}
              onOpenPath={onOpenPath}
              onOpenSourceSettings={onOpenSourceSettings}
              onCheckOnlyNode={onCheckOnlyNode}
              onRemoveFailedNode={onRemoveFailedNode}
              onReindexNode={onReindexNode}
              onRenameNode={onRenameNode}
              onRetryFailedNode={onRetryFailedNode}
              onSearchNode={onSearchNode}
              onToggleMonitorNode={onToggleMonitorNode}
              toggle={toggle}
            />
          ))
        : null}
    </>
  );
}

export function LibraryTree({
  expandedIds,
  nodes,
  onExpandedIdsChange,
  onOpenNode,
  onOpenInExplorer,
  onDeleteNode,
  onOpenPath,
  onReindexNode,
  onRemoveFailedNode,
  onRetryFailedNode,
  onSearchNode,
  onCheckOnlyNode,
  onRenameNode,
  onToggleMonitorNode,
  onAddFolderToCollection,
  onOpenSourceSettings,
  onCopyPath,
}: LibraryTreeProps) {
  const [internalExpanded, setInternalExpanded] = useState(
    () =>
      new Set(["libraries-local", "local-main", "all-tags", "local-tags", "user-tags"]),
  );
  const expanded = new Set(expandedIds ?? [...internalExpanded]);

  function setExpandedIds(ids: Set<string>) {
    if (expandedIds === undefined) setInternalExpanded(ids);
    onExpandedIdsChange?.([...ids]);
  }

  return (
    <div>
      {nodes.map((node) => (
        <TreeNode
          depth={0}
          expanded={expanded}
          key={node.id}
          node={node}
          onAddFolderToCollection={onAddFolderToCollection}
          onCopyPath={onCopyPath}
          onDeleteNode={onDeleteNode}
          onOpenInExplorer={onOpenInExplorer}
          onOpenNode={onOpenNode}
          onOpenPath={onOpenPath}
          onOpenSourceSettings={onOpenSourceSettings}
          onCheckOnlyNode={onCheckOnlyNode}
          onRemoveFailedNode={onRemoveFailedNode}
          onReindexNode={onReindexNode}
          onRenameNode={onRenameNode}
          onRetryFailedNode={onRetryFailedNode}
          onSearchNode={onSearchNode}
          onToggleMonitorNode={onToggleMonitorNode}
          toggle={(node, recursive) =>
            setExpandedIds(new Set(toggleExpandedNodeIds(expanded, node, recursive)))
          }
        />
      ))}
    </div>
  );
}
