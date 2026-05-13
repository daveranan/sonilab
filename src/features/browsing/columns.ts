export type BrowseColumn = {
  id: string;
  label: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth?: number;
  sortKey?: string;
  required?: boolean;
};

export const browseColumns: BrowseColumn[] = [
  {
    id: "name",
    label: "Name",
    defaultWidth: 520,
    minWidth: 220,
    maxWidth: 2400,
    sortKey: "name",
    required: true,
  },
  {
    id: "duration",
    label: "Duration",
    defaultWidth: 78,
    minWidth: 64,
    sortKey: "duration",
  },
  { id: "rate", label: "Rate", defaultWidth: 78, minWidth: 56, sortKey: "sampleRate" },
  {
    id: "bitDepth",
    label: "Bits",
    defaultWidth: 54,
    minWidth: 46,
    sortKey: "bitDepth",
  },
  { id: "channels", label: "Ch", defaultWidth: 48, minWidth: 40, sortKey: "channels" },
  { id: "format", label: "Format", defaultWidth: 88, minWidth: 64, sortKey: "format" },
  {
    id: "categories",
    label: "Categories",
    defaultWidth: 220,
    minWidth: 120,
  },
  {
    id: "tags",
    label: "Tags",
    defaultWidth: 260,
    minWidth: 120,
  },
  {
    id: "source",
    label: "Library",
    defaultWidth: 260,
    minWidth: 120,
    sortKey: "source",
  },
];

export type BrowseColumnState = Record<string, number>;

export function browseGridTemplate(
  columns: BrowseColumn[],
  columnWidths: BrowseColumnState,
): string {
  return columns
    .map((column) =>
      `${columnWidths[column.id] ?? column.defaultWidth}px`,
    )
    .join(" ");
}
