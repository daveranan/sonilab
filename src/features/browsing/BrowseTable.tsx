import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/react-virtual";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";

import type {
  BrowseRow as BrowseRowModel,
  LazyMetadataResponse,
  SearchSort,
  SearchSortKey,
  VisibleWindowHint,
} from "./browseTypes";
import { BrowseRow } from "./BrowseRow";
import {
  browseColumns,
  browseGridTemplate,
  type BrowseColumn,
  type BrowseColumnState,
} from "./columns";
import { useBrowseSelectionStore } from "./selectionStore";

type BrowseTableProps = {
  rows: BrowseRowModel[];
  totalCount: number;
  density?: BrowseDensity;
  metadataByRowId?: LazyMetadataResponse["metadataByRowId"];
  loading?: boolean;
  queryText?: string;
  onVisibleRowsChange?: (hint: VisibleWindowHint) => void;
  previewedRowIds?: Set<string>;
  onAssetFileDragRequest?: (
    row: Extract<BrowseRowModel, { kind: "asset" }>,
    pointer: { clientX: number; clientY: number },
  ) => void;
  preferInternalAssetDrag?: boolean;
  onOpenFolder?: (row: Extract<BrowseRowModel, { kind: "folder" }>) => void;
  onInternalDragStart?: (event: React.DragEvent, row: BrowseRowModel) => void;
  onAddToCollection?: (row: BrowseRowModel) => void;
  onOpenInExplorer?: (row: BrowseRowModel) => void;
  onGoToFolder?: (row: BrowseRowModel) => void;
  onDeleteRow?: (row: BrowseRowModel) => void;
  sort?: SearchSort;
  onSortChange?: (sort: SearchSort) => void;
};

type VisibleVirtualItem = Pick<VirtualItem, "index">;
const loadingSkeletonRows = 18;
const columnSettingsStorageKey = "sonilabs:browse-table-columns:v1";
export type BrowseDensity = "compact" | "standard" | "expanded";

type BrowseColumnSettings = {
  widths: BrowseColumnState;
  hidden: string[];
};

const densitySettings: Record<
  BrowseDensity,
  { rowHeight: number; headerHeight: number; textClassName: string }
> = {
  compact: { rowHeight: 26, headerHeight: 28, textClassName: "text-[12px]" },
  standard: { rowHeight: 32, headerHeight: 32, textClassName: "text-[13px]" },
  expanded: { rowHeight: 40, headerHeight: 34, textClassName: "text-[14px]" },
};

function defaultColumnSettings(): BrowseColumnSettings {
  return {
    widths: Object.fromEntries(
      browseColumns.map((column) => [column.id, column.defaultWidth]),
    ),
    hidden: [],
  };
}

function loadColumnSettings(): BrowseColumnSettings {
  const defaults = defaultColumnSettings();
  if (typeof window === "undefined") return defaults;
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(columnSettingsStorageKey) ?? "{}",
    ) as Partial<BrowseColumnSettings>;
    return {
      widths: { ...defaults.widths, ...(parsed.widths ?? {}) },
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
    };
  } catch {
    return defaults;
  }
}

function clampWidth(column: BrowseColumn, width: number): number {
  return Math.min(column.maxWidth ?? 640, Math.max(column.minWidth, width));
}

export function createVisibleWindowHint(
  rows: BrowseRowModel[],
  virtualRows: VisibleVirtualItem[],
): VisibleWindowHint | null {
  const first = virtualRows[0];
  const last = virtualRows[virtualRows.length - 1];
  if (!first || !last) return null;

  return {
    startIndex: first.index,
    endIndex: last.index,
    rowIds: virtualRows
      .map((item) => rows[item.index]?.id)
      .filter((rowId): rowId is string => Boolean(rowId)),
  };
}

export function BrowseTable({
  rows,
  totalCount,
  density = "standard",
  metadataByRowId = {},
  loading = false,
  queryText = "",
  onVisibleRowsChange,
  onAssetFileDragRequest,
  onAddToCollection,
  onDeleteRow,
  onOpenInExplorer,
  onGoToFolder,
  preferInternalAssetDrag = false,
  onOpenFolder,
  onInternalDragStart,
  onSortChange,
  sort,
  previewedRowIds = new Set<string>(),
}: BrowseTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const lastVisibleWindowKeyRef = useRef<string | null>(null);
  const resizingColumnRef = useRef<{
    id: string;
    startX: number;
    startWidth: number;
  } | null>(null);
  const [columnSettings, setColumnSettings] =
    useState<BrowseColumnSettings>(loadColumnSettings);
  const [bodyScrollLeft, setBodyScrollLeft] = useState(0);
  const bodyScrollLeftRef = useRef(0);
  const activeRowId = useBrowseSelectionStore((state) => state.activeRowId);
  const selectedRowIds = useBrowseSelectionStore((state) => state.selectedRowIds);
  const dispatch = useBrowseSelectionStore((state) => state.dispatch);
  const orderedRowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const densitySetting = densitySettings[density];
  const hiddenColumnIds = useMemo(
    () => new Set(columnSettings.hidden),
    [columnSettings.hidden],
  );
  const visibleColumns = useMemo(
    () => browseColumns.filter((column) => !hiddenColumnIds.has(column.id)),
    [hiddenColumnIds],
  );
  const gridTemplateColumns = useMemo(
    () => browseGridTemplate(visibleColumns, columnSettings.widths),
    [columnSettings.widths, visibleColumns],
  );
  const handleColumnSort = useCallback(
    (sortKey: SearchSortKey) => {
      onSortChange?.({
        key: sortKey,
        direction: sort?.key === sortKey && sort.direction === "asc" ? "desc" : "asc",
        stableTieBreaker: "assetId",
      });
    },
    [onSortChange, sort],
  );
  const handleBodyScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollLeft = event.currentTarget.scrollLeft;
    if (nextScrollLeft === bodyScrollLeftRef.current) return;
    bodyScrollLeftRef.current = nextScrollLeft;
    setBodyScrollLeft(nextScrollLeft);
  }, []);
  const updateColumnSettings = useCallback(
    (updater: (settings: BrowseColumnSettings) => BrowseColumnSettings) => {
      setColumnSettings((current) => updater(current));
    },
    [],
  );
  const toggleColumn = useCallback(
    (column: BrowseColumn) => {
      if (column.required) return;
      updateColumnSettings((current) => {
        const hidden = new Set(current.hidden);
        if (hidden.has(column.id)) hidden.delete(column.id);
        else hidden.add(column.id);
        return { ...current, hidden: [...hidden] };
      });
    },
    [updateColumnSettings],
  );
  const resetColumns = useCallback(() => {
    setColumnSettings(defaultColumnSettings());
  }, []);
  const beginResizeColumn = useCallback(
    (event: React.PointerEvent, column: BrowseColumn) => {
      event.preventDefault();
      event.stopPropagation();
      resizingColumnRef.current = {
        id: column.id,
        startX: event.clientX,
        startWidth: columnSettings.widths[column.id] ?? column.defaultWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [columnSettings.widths],
  );
  const resizeColumn = useCallback(
    (event: React.PointerEvent, column: BrowseColumn) => {
      const resizing = resizingColumnRef.current;
      if (!resizing || resizing.id !== column.id) return;
      const nextWidth = clampWidth(
        column,
        resizing.startWidth + event.clientX - resizing.startX,
      );
      updateColumnSettings((current) => ({
        ...current,
        widths: { ...current.widths, [column.id]: nextWidth },
      }));
    },
    [updateColumnSettings],
  );
  const endResizeColumn = useCallback((event: React.PointerEvent) => {
    resizingColumnRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  const handleRowClick = useCallback(
    (event: React.MouseEvent, row: BrowseRowModel) => {
      if (event.shiftKey) {
        dispatch({ type: "range", rowId: row.id, orderedRowIds });
      } else if (event.ctrlKey || event.metaKey) {
        dispatch({ type: "toggle", rowId: row.id });
      } else {
        dispatch({ type: "single", rowId: row.id, intent: "mouse" });
      }
      if (row.kind === "asset") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:preview-intent", {
            detail: { kind: "start-preview", rowId: row.id, preserveSelection: true },
          }),
        );
      }
      if (row.kind === "folder") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:preview-intent", {
            detail: { kind: "cancel-preview", rowId: null },
          }),
        );
        if (event.detail >= 2) onOpenFolder?.(row);
      }
    },
    [dispatch, onOpenFolder, orderedRowIds],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    getItemKey: (index) => rows[index]?.id ?? index,
    estimateSize: () => densitySetting.rowHeight,
    overscan: 24,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const handleGridKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      event.stopPropagation();
      const currentIndex = activeRowId ? orderedRowIds.indexOf(activeRowId) : -1;
      const nextIndex =
        event.key === "ArrowUp"
          ? Math.max(0, currentIndex === -1 ? 0 : currentIndex - 1)
          : Math.min(
              orderedRowIds.length - 1,
              currentIndex === -1 ? 0 : currentIndex + 1,
            );
      const row = rows[nextIndex];
      if (!row) return;
      dispatch({
        type: "move",
        delta: event.key === "ArrowUp" ? -1 : 1,
        orderedRowIds,
        extend: event.shiftKey,
        keepSelection: false,
      });
      rowVirtualizer.scrollToIndex(nextIndex);
      if (!event.shiftKey && row.kind === "asset") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:preview-intent", {
            detail: { kind: "start-preview", rowId: row.id, preserveSelection: true },
          }),
        );
      }
      if (!event.shiftKey && row.kind === "folder") {
        window.dispatchEvent(
          new CustomEvent("sonilabs:preview-intent", {
            detail: { kind: "cancel-preview", rowId: null },
          }),
        );
      }
    },
    [activeRowId, dispatch, orderedRowIds, rowVirtualizer, rows],
  );

  useEffect(() => {
    rowVirtualizer.measure();
  }, [densitySetting.rowHeight, rowVirtualizer]);

  useEffect(() => {
    window.localStorage.setItem(
      columnSettingsStorageKey,
      JSON.stringify(columnSettings),
    );
  }, [columnSettings]);

  useEffect(() => {
    dispatch({ type: "retain", orderedRowIds });
  }, [dispatch, orderedRowIds]);

  useEffect(() => {
    if (!onVisibleRowsChange) return;
    const hint = createVisibleWindowHint(rows, virtualRows);
    if (!hint) return;
    const visibleWindowKey = `${hint.startIndex}:${hint.endIndex}:${hint.rowIds.join("|")}`;
    if (visibleWindowKey === lastVisibleWindowKeyRef.current) return;
    lastVisibleWindowKeyRef.current = visibleWindowKey;
    onVisibleRowsChange(hint);
  }, [onVisibleRowsChange, rows, virtualRows]);

  useEffect(() => {
    const handler = (event: Event) => {
      const index = (event as CustomEvent<{ index: number }>).detail?.index;
      if (typeof index !== "number") return;
      rowVirtualizer.scrollToIndex(index);
    };
    window.addEventListener("sonilabs:browse-scroll-to-index", handler);
    return () => window.removeEventListener("sonilabs:browse-scroll-to-index", handler);
  }, [rowVirtualizer]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-border bg-background">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="shrink-0 overflow-hidden border-b border-border bg-panel">
            <div
              className="grid min-w-0 select-none items-center justify-items-start overflow-visible text-[10px] font-semibold uppercase text-muted-foreground/80"
              style={{
                gridTemplateColumns,
                height: `${densitySetting.headerHeight}px`,
                transform: `translateX(${-bodyScrollLeft}px)`,
              }}
            >
              {visibleColumns.map((column) => (
                <div
                  className="relative h-full min-w-0 w-full overflow-hidden"
                  key={column.id}
                >
                  <button
                    className="flex h-full min-w-0 w-full items-center justify-start overflow-hidden truncate pl-2 pr-3 text-left hover:text-foreground disabled:hover:text-muted-foreground/80"
                    disabled={!column.sortKey}
                    onClick={() =>
                      column.sortKey &&
                      handleColumnSort(column.sortKey as SearchSortKey)
                    }
                    title={column.sortKey ? `Sort by ${column.label}` : undefined}
                    type="button"
                  >
                    {column.label}
                    {sort?.key === column.sortKey ? (
                      <span className="ml-1">
                        {sort?.direction === "asc" ? "Asc" : "Desc"}
                      </span>
                    ) : null}
                  </button>
                  <span
                    className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize border-r border-border/60 hover:border-foreground"
                    onPointerDown={(event) => beginResizeColumn(event, column)}
                    onPointerMove={(event) => resizeColumn(event, column)}
                    onPointerUp={endResizeColumn}
                    role="separator"
                  />
                </div>
              ))}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {browseColumns.map((column) => (
            <ContextMenuCheckboxItem
              checked={!hiddenColumnIds.has(column.id)}
              disabled={column.required}
              key={column.id}
              onSelect={(event) => {
                event.preventDefault();
                toggleColumn(column);
              }}
            >
              {column.label}
            </ContextMenuCheckboxItem>
          ))}
          <ContextMenuSeparator className="my-1 h-px bg-border" />
          <ContextMenuItem onSelect={resetColumns}>Reset columns</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div
        className="relative min-h-0 flex-1 overflow-auto outline-none"
        onKeyDown={handleGridKeyDown}
        onPointerDown={() => parentRef.current?.focus({ preventScroll: true })}
        onScroll={handleBodyScroll}
        ref={parentRef}
        role="grid"
        tabIndex={0}
      >
        <TooltipProvider delayDuration={250}>
          <div
            className="relative w-full"
            style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
          >
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <BrowseRow
                  active={activeRowId === row.id}
                  columns={visibleColumns}
                  gridTemplateColumns={gridTemplateColumns}
                  key={virtualRow.key}
                  height={densitySetting.rowHeight}
                  metadata={metadataByRowId[row.id]}
                  onAddToCollection={onAddToCollection}
                  onAssetFileDragRequest={onAssetFileDragRequest}
                  onClick={handleRowClick}
                  onDeleteRow={onDeleteRow}
                  onInternalDragStart={onInternalDragStart}
                  onOpenInExplorer={onOpenInExplorer}
                  onGoToFolder={onGoToFolder}
                  preferInternalAssetDrag={preferInternalAssetDrag}
                  previewed={previewedRowIds.has(row.id)}
                  row={row}
                  selected={selectedRowIds.has(row.id)}
                  selectedCount={selectedRowIds.size}
                  textClassName={densitySetting.textClassName}
                  top={virtualRow.start}
                />
              );
            })}
          </div>
        </TooltipProvider>
        {loading ? (
          <BrowseLoadingRows
            columns={visibleColumns}
            gridTemplateColumns={gridTemplateColumns}
            rowHeight={densitySetting.rowHeight}
          />
        ) : null}
        {!loading && rows.length === 0 ? <NoResults queryText={queryText} /> : null}
      </div>
      <div className="flex h-7 items-center justify-between border-t border-border bg-panel px-3 text-[11px] text-muted-foreground">
        <span>{totalCount.toLocaleString()} rows</span>
        <span>{selectedRowIds.size.toLocaleString()} selected</span>
      </div>
    </section>
  );
}

function NoResults({ queryText }: { queryText: string }) {
  const trimmed = queryText.trim();
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
      {trimmed ? `No results found for "${trimmed}"` : "No results found"}
    </div>
  );
}

function BrowseLoadingRows({
  columns,
  gridTemplateColumns,
  rowHeight,
}: {
  columns: BrowseColumn[];
  gridTemplateColumns: string;
  rowHeight: number;
}) {
  return (
    <div
      aria-label="Loading rows"
      aria-live="polite"
      className="pointer-events-none absolute inset-0 z-20 bg-background/80"
      role="status"
    >
      {Array.from({ length: loadingSkeletonRows }, (_, index) => (
        <div
          className="browse-loading-row grid min-w-0 overflow-hidden border-b border-border/70"
          key={index}
          style={{
            gridTemplateColumns,
            height: `${rowHeight}px`,
          }}
        >
          {columns.map((column) => (
            <span
              className="border-r border-border/35 last:border-r-0"
              key={column.id}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
