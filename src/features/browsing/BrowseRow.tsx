import { FileAudio, Folder, HardDriveDownload } from "lucide-react";
import { memo, useRef } from "react";
import type React from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatAudioTimeParts } from "@/lib/timeFormat";
import { shouldStartAssetFileExportDrag } from "@/features/dragRouting";
import { audioPreviewService } from "@/features/audio-preview/previewService";

import type { BrowseRow as BrowseRowModel, LazyMetadataResponse } from "./browseTypes";
import type { BrowseColumn } from "./columns";
import { categorySummaryForTags } from "./tagCategories";

type BrowseRowProps = {
  row: BrowseRowModel;
  metadata?: LazyMetadataResponse["metadataByRowId"][string];
  selected: boolean;
  selectedCount: number;
  active: boolean;
  previewed: boolean;
  top: number;
  height: number;
  textClassName: string;
  columns: BrowseColumn[];
  gridTemplateColumns: string;
  onClick: (event: React.MouseEvent, row: BrowseRowModel) => void;
  onAssetFileDragRequest?: (
    row: Extract<BrowseRowModel, { kind: "asset" }>,
    pointer: { clientX: number; clientY: number },
  ) => void;
  preferInternalAssetDrag?: boolean;
  onInternalDragStart?: (event: React.DragEvent, row: BrowseRowModel) => void;
  onAddToCollection?: (row: BrowseRowModel) => void;
  onFindRelated?: (row: Extract<BrowseRowModel, { kind: "asset" }>) => void;
  onOpenInExplorer?: (row: BrowseRowModel) => void;
  onGoToFolder?: (row: BrowseRowModel) => void;
  onDeleteRow?: (row: BrowseRowModel) => void;
};

function DurationValue({ value }: { value: number | null }) {
  const parts = formatAudioTimeParts(value);
  if (!parts.milliseconds) return <span>{parts.main}</span>;
  return (
    <span className="inline-flex items-baseline font-mono tabular-nums">
      <span>{parts.main}</span>
      <span className="text-[0.82em] opacity-80">.{parts.milliseconds}</span>
    </span>
  );
}

function db(value: number | null): string {
  return value === null ? "..." : `${value.toFixed(1)}`;
}

function pointerIsOutsideApp(clientX: number, clientY: number): boolean {
  return (
    clientX <= 0 ||
    clientY <= 0 ||
    clientX >= window.innerWidth - 1 ||
    clientY >= window.innerHeight - 1
  );
}

const licenseDescriptions: Record<string, string> = {
  cc0: "CC0: public domain dedication. Generally usable without attribution.",
  by: "Creative Commons Attribution: reuse allowed with required author credit.",
  "by-sa":
    "Creative Commons Attribution-ShareAlike: credit required; derivatives share alike.",
  "by-nc": "Creative Commons Attribution-NonCommercial: non-commercial use only.",
  ambiguous: "Ambiguous license: inspect the source page before reuse or export.",
  unknown: "Unknown license: inspect the source page before reuse or export.",
};

function LicenseValue({ value }: { value: string | null }) {
  const label = value ?? "--";
  const normalized = value?.toLowerCase() ?? "";
  const description =
    licenseDescriptions[normalized] ??
    "License details unavailable. Check the source before reuse or export.";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex h-full min-w-0 w-full items-center justify-start truncate pr-3 text-left uppercase decoration-dotted underline-offset-2 hover:underline">
          {normalized === "unknown" || normalized === "ambiguous" ? (
            <span className="mr-1 text-amber-300">!</span>
          ) : null}
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent>{description}</TooltipContent>
    </Tooltip>
  );
}

function Cell({
  children,
  className,
  priority = "secondary",
}: {
  children: React.ReactNode;
  className?: string;
  priority?: "primary" | "secondary" | "metric";
}) {
  return (
    <span
      className={cn(
        "flex h-full min-w-0 max-w-full items-center justify-start overflow-hidden truncate pl-2 pr-3 text-left",
        priority === "secondary" && "text-muted-foreground",
        priority === "metric" && "font-mono text-foreground/90",
        className,
      )}
    >
      {children}
    </span>
  );
}

function BrowseRowComponent({
  row,
  metadata,
  selected,
  selectedCount,
  active,
  previewed,
  top,
  height,
  textClassName,
  columns,
  gridTemplateColumns,
  onClick,
  onAddToCollection,
  onAssetFileDragRequest,
  onDeleteRow,
  onFindRelated,
  onGoToFolder,
  preferInternalAssetDrag = false,
  onInternalDragStart,
  onOpenInExplorer,
}: BrowseRowProps) {
  const fileDragRef = useRef<{
    x: number;
    y: number;
    started: boolean;
    exportStarted: boolean;
    suppressClick: boolean;
  } | null>(null);
  const isFolder = row.kind === "folder";
  const peakDbfs = row.kind === "asset" ? (metadata?.peakDbfs ?? row.peakDbfs) : null;
  const rmsDbfs = row.kind === "asset" ? (metadata?.rmsDbfs ?? row.rmsDbfs) : null;
  const headroomDb =
    row.kind === "asset" ? (metadata?.headroomDb ?? row.headroomDb) : null;
  const libraryLabel =
    row.kind === "folder"
      ? sourcePathLabel(row.sourceName, row.path)
      : sourcePathLabel(row.sourceName, row.folderPath ?? containingFolderPath(row.relativePath));
  const rowTitle =
    row.kind === "folder"
      ? (row.fullPath ?? row.path)
      : `${row.fullPath ?? row.relativePath}\nDrag to a collection. Alt-drag to export the file.`;

  const deleteLabel =
    selected && selectedCount > 1
      ? "Delete selected from library"
      : "Delete from library";

  const renderCell = (columnId: string) => {
    if (columnId === "name") {
      return (
        <span className="flex h-full min-w-0 w-full items-center gap-2 overflow-hidden pl-2 pr-3">
          {isFolder ? (
            <Folder className="size-3.5 shrink-0" />
          ) : (
            <FileAudio className="size-3.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">{row.name}</span>
          {!isFolder && row.availability !== "available" ? (
            <HardDriveDownload className="size-3 shrink-0 text-amber-300" />
          ) : null}
        </span>
      );
    }

    if (isFolder) {
      const folderValues: Record<string, React.ReactNode> = {
        duration: `${row.childCount ?? "--"} items`,
        rate: "--",
        bitDepth: "--",
        channels: "--",
        format: row.status,
        peak: "...",
        rms: "...",
        headroom: "...",
        source: libraryLabel,
        license: "--",
        originator: "--",
        categories: "--",
        tags: "--",
        attribution: "--",
        description: "--",
        metadataFile: "--",
      };
      return <Cell>{folderValues[columnId] ?? "--"}</Cell>;
    }

    switch (columnId) {
      case "duration":
        return (
          <Cell className="font-mono tabular-nums">
            <DurationValue value={row.durationSeconds} />
          </Cell>
        );
      case "rate":
        return <Cell>{row.sampleRate ? `${row.sampleRate / 1000}k` : "--"}</Cell>;
      case "bitDepth":
        return <Cell>{row.bitDepth ?? "--"}</Cell>;
      case "channels":
        return <Cell>{row.channels ?? "--"}</Cell>;
      case "format":
        return <Cell className="pr-5">{row.format ?? "--"}</Cell>;
      case "peak":
        return <Cell priority="metric">{db(peakDbfs)}</Cell>;
      case "rms":
        return <Cell priority="metric">{db(rmsDbfs)}</Cell>;
      case "headroom":
        return <Cell priority="metric">{db(headroomDb)}</Cell>;
      case "source":
        return (
          <Cell priority="primary">
            <button
              className="min-w-0 truncate text-left text-foreground underline-offset-2 hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                onGoToFolder?.(row);
              }}
              title={rowTitle}
              type="button"
            >
              {libraryLabel}
            </button>
          </Cell>
        );
      case "license":
        return <LicenseValue value={row.license} />;
      case "originator":
        return <Cell>{row.originator ?? "--"}</Cell>;
      case "categories": {
        const categories = categorySummaryForTags(row.tags);
        return <Cell>{categories || "--"}</Cell>;
      }
      case "tags":
        return <Cell>{row.tags.length ? row.tags.join(", ") : "--"}</Cell>;
      case "attribution":
        return <Cell>{row.attribution ?? "--"}</Cell>;
      case "description":
        return <Cell>{row.description ?? "--"}</Cell>;
      case "metadataFile":
        return <Cell>{row.metadataFile ?? "--"}</Cell>;
      default:
        return <Cell>--</Cell>;
    }
  };

  const rowElement = (
    <div
      aria-selected={selected}
      className={cn(
        "absolute left-0 right-0 grid min-w-0 cursor-pointer select-none items-center justify-items-start overflow-hidden border-b border-border/60",
        textClassName,
        "hover:bg-muted/70",
        previewed && !selected && !active && "bg-muted/25 text-muted-foreground",
        selected && "bg-zinc-200 text-zinc-950 hover:bg-zinc-200 [&_*]:text-zinc-950",
        active && !selected && "bg-muted text-foreground",
      )}
      data-row-id={row.id}
      draggable={!preferInternalAssetDrag}
      onDragStart={(event) => {
        if (
          event.altKey &&
          shouldStartAssetFileExportDrag({
            rowKind: row.kind,
            hasFileDragHandler:
              Boolean(onAssetFileDragRequest) && !preferInternalAssetDrag,
          }) &&
          row.kind === "asset" &&
          onAssetFileDragRequest
        ) {
          event.preventDefault();
          fileDragRef.current = {
            x: event.clientX,
            y: event.clientY,
            started: true,
            exportStarted: true,
            suppressClick: true,
          };
          onAssetFileDragRequest(row, {
            clientX: event.clientX,
            clientY: event.clientY,
          });
          return;
        }
        onInternalDragStart?.(event, row);
      }}
      onClick={(event) => {
        if (fileDragRef.current?.suppressClick) {
          fileDragRef.current = null;
          return;
        }
        onClick(event, row);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || row.kind !== "asset") return;
        if (preferInternalAssetDrag) {
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        fileDragRef.current = {
          x: event.clientX,
          y: event.clientY,
          started: false,
          exportStarted: false,
          suppressClick: false,
        };
      }}
      onPointerMove={(event) => {
        if (!fileDragRef.current || row.kind !== "asset") return;
        const distance =
          Math.hypot(
            event.clientX - fileDragRef.current.x,
            event.clientY - fileDragRef.current.y,
          );
        if (distance >= 6) {
          fileDragRef.current.suppressClick = true;
          if (preferInternalAssetDrag && !fileDragRef.current.started) {
            fileDragRef.current.started = true;
            const processing =
              audioPreviewService.getState().assetId === row.id
                ? audioPreviewService.getProcessing()
                : undefined;
            window.dispatchEvent(
              new CustomEvent("sonilabs:assembly-row-drag-start", {
                detail: {
                  asset: row,
                  processing,
                  x: event.clientX,
                  y: event.clientY,
                },
              }),
            );
          }
        }
        if (preferInternalAssetDrag && fileDragRef.current.started) {
          if (
            !fileDragRef.current.exportStarted &&
            pointerIsOutsideApp(event.clientX, event.clientY) &&
            onAssetFileDragRequest
          ) {
            fileDragRef.current.exportStarted = true;
            window.dispatchEvent(
              new CustomEvent("sonilabs:assembly-row-drag-cancel"),
            );
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            onAssetFileDragRequest(row, {
              clientX: event.clientX,
              clientY: event.clientY,
            });
            return;
          }
          if (fileDragRef.current.exportStarted) return;
          window.dispatchEvent(
            new CustomEvent("sonilabs:assembly-row-drag-move", {
              detail: { x: event.clientX, y: event.clientY },
            }),
          );
        }
      }}
      onPointerUp={(event) => {
        if (
          preferInternalAssetDrag &&
          fileDragRef.current?.started &&
          !fileDragRef.current.exportStarted
        ) {
          window.dispatchEvent(
            new CustomEvent("sonilabs:assembly-row-drag-end", {
              detail: { x: event.clientX, y: event.clientY },
            }),
          );
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }
        if (!fileDragRef.current?.suppressClick) fileDragRef.current = null;
      }}
      role="row"
      style={{
        gridTemplateColumns,
        height: `${height}px`,
        transform: `translateY(${top}px)`,
      }}
      title={rowTitle}
    >
      {columns.map((column) => (
        <span className="flex min-w-0 max-w-full overflow-hidden" key={column.id}>
          {renderCell(column.id)}
        </span>
      ))}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowElement}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpenInExplorer?.(row)}>
          {isFolder ? "Open folder in Explorer" : "Show in Explorer"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onGoToFolder?.(row)}>
          Go to folder
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onAddToCollection?.(row)}>
          Add to collection
        </ContextMenuItem>
        {!isFolder ? (
          <ContextMenuItem onSelect={() => onFindRelated?.(row)}>
            Find related sounds
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator className="my-1 h-px bg-border" />
        <ContextMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => onDeleteRow?.(row)}
        >
          {deleteLabel}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export const BrowseRow = memo(BrowseRowComponent);
function containingFolderPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
}

function sourcePathLabel(sourceName: string | undefined, folderPath: string): string {
  const path = folderPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!sourceName) return path;
  return path ? `${sourceName} / ${path}` : sourceName;
}
