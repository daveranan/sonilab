import type { BrowseRow, SearchSort, SearchSortKey } from "./browseTypes";

export const defaultFolderSort: SearchSort = {
  key: "name",
  direction: "asc",
  stableTieBreaker: "assetId",
};

export const defaultSearchSort: SearchSort = {
  key: "bestMatch",
  direction: "desc",
  stableTieBreaker: "assetId",
};

const sortKeyToBackend: Record<SearchSortKey, string> = {
  bestMatch: "best_match",
  name: "name",
  duration: "duration_seconds",
  modifiedTime: "modified_at",
  format: "format",
  sampleRate: "sample_rate",
  bitDepth: "bit_depth",
  channels: "channels",
  peak: "peak_dbfs",
  rms: "rms_dbfs",
  headroom: "headroom_db",
  source: "source",
  fileSize: "byte_size",
  rating: "rating",
  importedDate: "imported_at",
  indexedDate: "indexed_at",
  recentlyPlayed: "recently_played_at",
  recentlyExported: "recently_exported_at",
};

export function serializeSort(sort: SearchSort): string {
  return `${sortKeyToBackend[sort.key]}:${sort.direction}:asset_id`;
}

function rowValue(row: BrowseRow, key: SearchSortKey): number | string {
  if (row.kind === "folder") {
    if (key === "source") return row.sourceId;
    return key === "name" || key === "bestMatch" ? row.name : "";
  }

  switch (key) {
    case "duration":
      return row.durationSeconds ?? Number.NEGATIVE_INFINITY;
    case "format":
      return row.format ?? "";
    case "sampleRate":
      return row.sampleRate ?? Number.NEGATIVE_INFINITY;
    case "bitDepth":
      return row.bitDepth ?? Number.NEGATIVE_INFINITY;
    case "channels":
      return row.channels ?? Number.NEGATIVE_INFINITY;
    case "peak":
      return row.peakDbfs ?? Number.NEGATIVE_INFINITY;
    case "rms":
      return row.rmsDbfs ?? Number.NEGATIVE_INFINITY;
    case "headroom":
      return row.headroomDb ?? Number.NEGATIVE_INFINITY;
    case "source":
      return row.sourceName;
    case "fileSize":
      return row.fileSizeBytes ?? Number.NEGATIVE_INFINITY;
    case "rating":
      return row.rating ?? Number.NEGATIVE_INFINITY;
    case "name":
    case "bestMatch":
      return row.name;
    case "modifiedTime":
    case "importedDate":
    case "indexedDate":
    case "recentlyPlayed":
    case "recentlyExported":
      return "";
  }
}

export function compareBrowseRows(
  a: BrowseRow,
  b: BrowseRow,
  sort: SearchSort,
): number {
  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1;
  }

  const aValue = rowValue(a, sort.key);
  const bValue = rowValue(b, sort.key);
  const direction = sort.direction === "asc" ? 1 : -1;
  const compared =
    typeof aValue === "number" && typeof bValue === "number"
      ? aValue - bValue
      : String(aValue).localeCompare(String(bValue), undefined, {
          numeric: true,
          sensitivity: "base",
        });

  if (compared !== 0) return compared * direction;
  return a.id.localeCompare(b.id);
}
