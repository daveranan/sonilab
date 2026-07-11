import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  GripVertical,
  Layers3,
  Plus,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { createAssemblyProject } from "@/features/assembler/assemblyModel";
import {
  assemblyProjectOpenEvent,
  assemblyProjectsChangedEvent,
  readAssemblyProjects,
  setActiveAssemblyProject,
  writeAssemblyProjects,
} from "@/features/assembler/projectStore";
import { ActivityHistory } from "@/features/libraries/ActivityHistory";
import {
  dataTransferHasType,
  sonilabsAssemblyProjectDragType,
} from "@/features/dragRouting";
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

function AssemblyProjects() {
  const [state, setState] = useState(readAssemblyProjects);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [projectDropTarget, setProjectDropTarget] = useState<{
    id: string;
    position: "before" | "after";
  } | null>(null);
  const [projectFolderDropTarget, setProjectFolderDropTarget] = useState<string | null>(
    null,
  );
  const folderNameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const refresh = () => setState(readAssemblyProjects());
    window.addEventListener(assemblyProjectsChangedEvent, refresh);
    return () => window.removeEventListener(assemblyProjectsChangedEvent, refresh);
  }, []);

  useEffect(() => {
    if (!editingFolderId) return;
    window.requestAnimationFrame(() => {
      folderNameInputRef.current?.focus();
      folderNameInputRef.current?.select();
    });
  }, [editingFolderId]);

  const openProject = (projectId: string) => {
    setActiveAssemblyProject(projectId);
    window.dispatchEvent(
      new CustomEvent(assemblyProjectOpenEvent, { detail: { projectId } }),
    );
  };

  const createProject = () => {
    const project = createAssemblyProject();
    project.name = `Assembly ${state.projects.length + 1}`;
    writeAssemblyProjects({
      ...state,
      activeProjectId: project.id,
      projectFolderIds: { ...state.projectFolderIds, [project.id]: null },
      projects: [...state.projects, project],
    });
    window.dispatchEvent(
      new CustomEvent(assemblyProjectOpenEvent, {
        detail: { projectId: project.id },
      }),
    );
  };

  const createFolder = () => {
    const existingNames = new Set(
      state.folders.map((folder) => folder.name.trim().toLowerCase()),
    );
    let name = "New Folder";
    let suffix = 2;
    while (existingNames.has(name.toLowerCase())) {
      name = `New Folder ${suffix}`;
      suffix += 1;
    }
    const id = `assembly-folder-${crypto.randomUUID()}`;
    writeAssemblyProjects({
      ...state,
      folders: [...state.folders, { id, name }],
    });
    setExpandedFolderIds((current) => new Set(current).add(id));
    setEditingFolderId(id);
  };

  const renameProject = (projectId: string, currentName: string) => {
    const name = window.prompt("Rename assembly project", currentName)?.trim();
    if (!name || name === currentName) return;
    writeAssemblyProjects({
      ...state,
      projects: state.projects.map((project) =>
        project.id === projectId ? { ...project, name } : project,
      ),
    });
    if (projectId === state.activeProjectId) openProject(projectId);
  };

  const deleteProject = (projectId: string) => {
    const remaining = state.projects.filter((project) => project.id !== projectId);
    const projects = remaining.length ? remaining : [createAssemblyProject()];
    const activeProjectId =
      state.activeProjectId === projectId ? projects[0].id : state.activeProjectId;
    writeAssemblyProjects({
      ...state,
      activeProjectId,
      projectFolderIds: Object.fromEntries(
        projects.map((project) => [
          project.id,
          state.projectFolderIds[project.id] ?? null,
        ]),
      ),
      projects,
    });
    openProject(activeProjectId);
  };

  const moveProject = (
    projectId: string,
    folderId: string | null,
    targetProjectId?: string,
    position: "before" | "after" = "after",
  ) => {
    const source = state.projects.find((project) => project.id === projectId);
    if (!source) return;
    const projects = state.projects.filter((project) => project.id !== projectId);
    if (targetProjectId) {
      const targetIndex = projects.findIndex((project) => project.id === targetProjectId);
      if (targetIndex >= 0) {
        projects.splice(targetIndex + (position === "after" ? 1 : 0), 0, source);
      } else {
        projects.push(source);
      }
    } else {
      projects.push(source);
    }
    writeAssemblyProjects({
      ...state,
      projectFolderIds: { ...state.projectFolderIds, [projectId]: folderId },
      projects,
    });
  };

  const moveProjectToFolder = (projectId: string, folderId: string | null) =>
    moveProject(projectId, folderId);

  const renameFolder = (folderId: string, currentName: string, nextName?: string) => {
    const name = nextName?.trim();
    if (!name || name === currentName) return;
    writeAssemblyProjects({
      ...state,
      folders: state.folders.map((folder) =>
        folder.id === folderId ? { ...folder, name } : folder,
      ),
    });
  };

  const deleteFolder = (folderId: string) => {
    writeAssemblyProjects({
      ...state,
      folders: state.folders.filter((folder) => folder.id !== folderId),
      projectFolderIds: Object.fromEntries(
        Object.entries(state.projectFolderIds).map(([projectId, assignedId]) => [
          projectId,
          assignedId === folderId ? null : assignedId,
        ]),
      ),
    });
  };

  const projectRow = (project: (typeof state.projects)[number], depth = 0) => (
    <ContextMenu key={project.id}>
      <ContextMenuTrigger asChild>
        <button
          className={
            "flex h-8 w-full items-center gap-2 truncate rounded-sm text-left text-[13px] outline-none focus-visible:bg-muted " +
            (project.id === state.activeProjectId
              ? "bg-zinc-200 text-zinc-950 hover:bg-zinc-200 [&_*]:text-zinc-950"
              : "text-muted-foreground hover:bg-muted hover:text-foreground") +
            (projectDropTarget?.id === project.id
              ? projectDropTarget.position === "before"
                ? " border-t border-cyan-300"
                : " border-b border-cyan-300"
              : "")
          }
          draggable
          onClick={() => openProject(project.id)}
          onDragStart={(event) => {
            event.dataTransfer.setData(sonilabsAssemblyProjectDragType, project.id);
            event.dataTransfer.setData("text/plain", project.id);
            event.dataTransfer.effectAllowed = "move";
            window.dispatchEvent(
              new CustomEvent("sonilabs:assembly-internal-drag-active", {
                detail: { active: true },
              }),
            );
          }}
          onDragOver={(event) => {
            if (
              !dataTransferHasType(
                event.dataTransfer.types,
                sonilabsAssemblyProjectDragType,
              )
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            const bounds = event.currentTarget.getBoundingClientRect();
            setProjectDropTarget({
              id: project.id,
              position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
            });
          }}
          onDrop={(event) => {
            const projectId = event.dataTransfer.getData(
              sonilabsAssemblyProjectDragType,
            );
            if (!projectId || projectId === project.id) return;
            event.preventDefault();
            event.stopPropagation();
            const position = projectDropTarget?.id === project.id
              ? projectDropTarget.position
              : "after";
            moveProject(
              projectId,
              state.projectFolderIds[project.id] ?? null,
              project.id,
              position,
            );
            setProjectDropTarget(null);
          }}
          onDragEnd={() => {
            setProjectDropTarget(null);
            setProjectFolderDropTarget(null);
            window.dispatchEvent(
              new CustomEvent("sonilabs:assembly-internal-drag-active", {
                detail: { active: false },
              }),
            );
          }}
          style={{ paddingLeft: 20 + depth * 16 }}
          title={project.name}
          type="button"
        >
          <Layers3 className="size-3.5 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openProject(project.id)}>
          Open project
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => renameProject(project.id, project.name)}>
          Rename project
        </ContextMenuItem>
        {state.projectFolderIds[project.id] ? (
          <ContextMenuItem onSelect={() => moveProjectToFolder(project.id, null)}>
            Move out of folder
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => deleteProject(project.id)}>
          Delete project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );

  return (
    <section
      className="border-b border-border/80 py-2"
      onDragOver={(event) => {
        if (
          dataTransferHasType(
            event.dataTransfer.types,
            sonilabsAssemblyProjectDragType,
          )
        ) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        const projectId = event.dataTransfer.getData(sonilabsAssemblyProjectDragType);
        if (!projectId) return;
        event.preventDefault();
        moveProject(projectId, null);
      }}
    >
      <SectionHeader
        action={
          <span className="flex items-center gap-0.5">
            <button
              aria-label="New project folder"
              className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
              onClick={createFolder}
              title="New project folder"
              type="button"
            >
              <FolderPlus className="size-3.5" />
            </button>
            <button
              aria-label="New assembly project"
              className="flex size-5 items-center justify-center rounded-sm hover:bg-muted hover:text-foreground"
              onClick={createProject}
              title="New assembly project"
              type="button"
            >
              <Plus className="size-3.5" />
            </button>
          </span>
        }
        title="Projects"
      />
      {state.folders.map((folder) => {
        const expanded = expandedFolderIds.has(folder.id);
        const projects = state.projects.filter(
          (project) => state.projectFolderIds[project.id] === folder.id,
        );
        return (
          <div key={folder.id}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  className={
                    "flex h-8 w-full items-center gap-1.5 px-3 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground " +
                    (projectFolderDropTarget === folder.id
                      ? "bg-cyan-400/15 ring-1 ring-inset ring-cyan-300/60"
                      : "")
                  }
                  onClick={() => {
                    if (editingFolderId === folder.id) return;
                    setExpandedFolderIds((current) => {
                      const next = new Set(current);
                      if (next.has(folder.id)) next.delete(folder.id);
                      else next.add(folder.id);
                      return next;
                    });
                  }}
                  onKeyDown={(event) => {
                    if (
                      editingFolderId === folder.id ||
                      (event.key !== "Enter" && event.key !== " ")
                    )
                      return;
                    event.preventDefault();
                    event.currentTarget.click();
                  }}
                  onDragOver={(event) => {
                    if (
                      dataTransferHasType(
                        event.dataTransfer.types,
                        sonilabsAssemblyProjectDragType,
                      )
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = "move";
                      setProjectFolderDropTarget(folder.id);
                    }
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setProjectFolderDropTarget(null);
                    }
                  }}
                  onDrop={(event) => {
                    const projectId = event.dataTransfer.getData(
                      sonilabsAssemblyProjectDragType,
                    );
                    if (!projectId) return;
                    event.preventDefault();
                    event.stopPropagation();
                    moveProject(projectId, folder.id);
                    setProjectFolderDropTarget(null);
                    setExpandedFolderIds((current) => new Set(current).add(folder.id));
                  }}
                  role="treeitem"
                  tabIndex={0}
                >
                  {expanded ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  <Folder className="size-3.5 shrink-0" />
                  {editingFolderId === folder.id ? (
                    <input
                      aria-label={`Rename ${folder.name}`}
                      className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 py-0 text-[13px] text-foreground outline-none"
                      defaultValue={folder.name}
                      onBlur={() => {
                        renameFolder(
                          folder.id,
                          folder.name,
                          folderNameInputRef.current?.value,
                        );
                        setEditingFolderId(null);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          event.preventDefault();
                          renameFolder(folder.id, folder.name, event.currentTarget.value);
                          setEditingFolderId(null);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          setEditingFolderId(null);
                        }
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      ref={folderNameInputRef}
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                  )}
                  <span className="text-[10px] opacity-60">{projects.length}</span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => window.setTimeout(() => setEditingFolderId(folder.id), 0)}
                >
                  Rename folder
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => deleteFolder(folder.id)}>
                  Delete folder
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {expanded ? projects.map((project) => projectRow(project, 1)) : null}
          </div>
        );
      })}
      {state.projects
        .filter((project) => !state.projectFolderIds[project.id])
        .map((project) => projectRow(project))}
    </section>
  );
}

export function LeftSidebar({
  libraries,
  collections,
  activity,
  activeCollectionNodeId,
  activeLibraryNodeId,
  enabledLocalSourceIds,
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
  onSourceEnabledChange,
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
  onMoveCollection,
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
  activeCollectionNodeId?: string | null;
  activeLibraryNodeId?: string | null;
  enabledLocalSourceIds?: string[];
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
  onSourceEnabledChange?: (sourceId: string, checked: boolean) => void;
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
  onMoveCollection?: (
    collectionId: string,
    parentId: string | null,
    targetId?: string,
    position?: "before" | "after",
  ) => void;
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
            activeNodeId={activeLibraryNodeId}
            expandedIds={libraryExpandedIds}
            nodes={libraries}
            checkedSourceIds={enabledLocalSourceIds}
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
            onSourceCheckedChange={onSourceEnabledChange}
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
            activeNodeId={activeCollectionNodeId}
            expandedIds={collectionExpandedIds}
            nodes={collections}
            onExpandedIdsChange={onCollectionExpandedIdsChange}
            onCreateChildCollection={onCreateChildCollection}
            onDeleteCollection={onDeleteCollection}
            onDropAssets={onDropAssetsIntoCollection}
            onDropFolderRef={onDropFolderIntoCollection}
            onMoveCollection={onMoveCollection}
            onOpenCollection={onOpenCollection}
            onFinishRenamingCollection={onFinishRenamingCollection}
            onRenameCollection={onRenameCollection}
            renamingCollectionId={renamingCollectionId}
          />
        </section>
        <AssemblyProjects />
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
