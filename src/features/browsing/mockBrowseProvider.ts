import type {
  BrowseRequest,
  BrowseResponse,
  BrowseRow,
  LazyMetadataRequest,
  LazyMetadataResponse,
  SearchFilter,
} from "./browseTypes";
import { compareBrowseRows } from "./sortModel";

export type BrowseProvider = {
  browse: (request: BrowseRequest) => Promise<BrowseResponse>;
  loadVisibleMetadata: (request: LazyMetadataRequest) => Promise<LazyMetadataResponse>;
};

const formats = ["wav", "mp3", "ogg", "flac", "aif"] as const;
const codecs = ["pcm", "mp3", "vorbis", "flac", "aiff"] as const;
const sources = ["Local SFX", "Project Foley", "Imported Packs"] as const;
const tags = ["metal", "wood", "impact", "ui", "ambience", "cloth"] as const;
const maxBrowseCacheEntries = 24;

function assetRow(index: number): BrowseRow {
  const format = formats[index % formats.length];
  const sourceName = sources[index % sources.length];
  const tag = tags[index % tags.length];

  return {
    kind: "asset",
    id: `asset-${index.toString().padStart(5, "0")}`,
    name: `${tag}_${format}_hit_${index.toString().padStart(5, "0")}`,
    durationSeconds:
      index % 9 === 0 ? null : Number(((index % 240) / 20 + 0.15).toFixed(2)),
    sampleRate: index % 3 === 0 ? 48000 : 44100,
    bitDepth: format === "wav" || format === "flac" ? 24 : null,
    channels: index % 4 === 0 ? 1 : 2,
    format,
    codec: codecs[index % codecs.length],
    fileSizeBytes: 24_000 + index * 97,
    peakDbfs: null,
    rmsDbfs: null,
    clipping: index % 271 === 0,
    headroomDb: null,
    sourceName,
    provider: "local",
    relativePath: `${sourceName}/folder-${index % 80}/${tag}`,
    license: index % 7 === 0 ? "by" : "cc0",
    metadataFile: index % 4 === 0 ? "library-metadata.xlsx" : null,
    originator: index % 5 === 0 ? "valve" : "library",
    attribution: index % 7 === 0 ? "Mock Library" : null,
    description: `${tag} ${format} sound`,
    tags: [tag, format],
    rightsSummary: index % 7 === 0 ? "attribution-required" : "commercial-ok cc0",
    rating: null,
    imported: true,
    favorite: index % 37 === 0,
    availability: index % 113 === 0 ? "missing" : "available",
  };
}

function folderRow(index: number): BrowseRow {
  return {
    kind: "folder",
    id: `folder-${index.toString().padStart(3, "0")}`,
    name: `folder-${index.toString().padStart(3, "0")}`,
    childCount: 400 + index,
    sourceId: index % 2 === 0 ? "local-main" : "local-imported",
    path: `/mock/folder-${index.toString().padStart(3, "0")}`,
    status: index % 11 === 0 ? "indexing" : "indexed",
  };
}

export function createMockBrowseRows(count: number): BrowseRow[] {
  const folderCount = Math.min(64, Math.max(4, Math.floor(count / 1000)));
  const folders = Array.from({ length: folderCount }, (_, index) => folderRow(index));
  const assets = Array.from({ length: Math.max(0, count - folderCount) }, (_, index) =>
    assetRow(index),
  );
  return [...folders, ...assets];
}

let defaultMockBrowseRows: BrowseRow[] | null = null;

export function getDefaultMockBrowseRows(): BrowseRow[] {
  defaultMockBrowseRows ??= createMockBrowseRows(50_000);
  return defaultMockBrowseRows;
}

function textMatches(row: BrowseRow, text: string[]): boolean {
  if (text.length === 0) return true;
  const haystack =
    row.kind === "folder"
      ? `${row.name} ${row.path}`
      : `${row.name} ${row.relativePath} ${row.sourceName} ${row.license ?? ""} ${
          row.originator ?? ""
        } ${row.format ?? ""}`;

  return text.every((term) => {
    const negated = term.startsWith("-");
    const value = negated ? term.slice(1) : term;
    const match = haystack.toLowerCase().includes(value);
    return negated ? !match : match;
  });
}

function filterMatches(row: BrowseRow, filter: SearchFilter): boolean {
  const baseResult = (() => {
    if (row.kind === "folder") {
      return (
        filter.field === "path" &&
        typeof filter.value === "string" &&
        row.path.includes(filter.value)
      );
    }

    switch (filter.field) {
      case "tag":
        return (
          row.name.includes(filter.value) || row.relativePath.includes(filter.value)
        );
      case "tagany": {
        const tags = filter.value.split("|");
        return tags.some((tag) => row.tags.includes(tag));
      }
      case "license":
        return row.license === filter.value;
      case "rights":
        return row.rightsSummary?.includes(filter.value) ?? false;
      case "format":
        return row.format === filter.value;
      case "codec":
        return row.codec === filter.value;
      case "source":
        return row.sourceName.toLowerCase().includes(filter.value);
      case "provider":
        return row.provider === filter.value;
      case "path":
        return row.relativePath.toLowerCase().includes(filter.value);
      case "collection":
        return filter.value === "favorites" ? row.favorite : false;
      case "originator":
        return row.originator?.toLowerCase().includes(filter.value) ?? false;
      case "uploader":
        return row.originator?.toLowerCase().includes(filter.value) ?? false;
      case "available":
        return (row.availability === "available") === filter.value;
      case "missing":
        return (row.availability === "missing") === filter.value;
      case "favorite":
        return row.favorite === filter.value;
      case "availability":
        return row.availability === filter.value;
      case "status":
        return row.availability === filter.value;
      case "imported":
        return row.imported === filter.value;
      case "clipping":
        return row.clipping === filter.value;
      case "waveform":
        return filter.value === "cached" ? row.id.endsWith("0") : false;
      case "analyzed":
        return (row.peakDbfs !== null && row.rmsDbfs !== null) === filter.value;
      case "duration":
        return compareNumber(row.durationSeconds, filter);
      case "rate":
        return compareNumber(row.sampleRate, filter);
      case "bitdepth":
        return compareNumber(row.bitDepth, filter);
      case "channels":
        return compareNumber(row.channels, filter);
      case "size":
        return compareNumber(row.fileSizeBytes, filter);
      case "rating":
        return compareNumber(row.rating, filter);
      case "peak":
        return compareNumber(row.peakDbfs, filter);
      case "rms":
        return compareNumber(row.rmsDbfs, filter);
      case "headroom":
        return compareNumber(row.headroomDb, filter);
      case "modified":
      case "indexed":
      case "played":
      case "exported":
        return true;
    }
  })();

  return filter.negated ? !baseResult : baseResult;
}

function compareNumber(value: number | null, filter: SearchFilter): boolean {
  if (
    filter.field !== "duration" &&
    filter.field !== "rate" &&
    filter.field !== "bitdepth" &&
    filter.field !== "channels" &&
    filter.field !== "size" &&
    filter.field !== "rating" &&
    filter.field !== "peak" &&
    filter.field !== "rms" &&
    filter.field !== "headroom"
  ) {
    return false;
  }

  if (value === null) return false;
  switch (filter.operator) {
    case "<":
      return value < filter.value;
    case "<=":
      return value <= filter.value;
    case ">":
      return value > filter.value;
    case ">=":
      return value >= filter.value;
    case "range":
      return value >= filter.value && value <= (filter.valueEnd ?? filter.value);
    case "=":
      return value === filter.value;
  }
}

export function createMockBrowseProvider(
  rows = getDefaultMockBrowseRows(),
  delayMs = 12,
): BrowseProvider {
  const browseCache = new Map<string, Omit<BrowseResponse, "requestId">>();

  return {
    browse: (request) => {
      const cacheKey = browseCacheKey(request);
      const cached = browseCache.get(cacheKey);
      if (cached) return Promise.resolve({ ...cached, requestId: request.requestId });

      return new Promise((resolve) => {
        globalThis.setTimeout(() => {
          const filtered = request.query
            ? rows.filter(
                (row) =>
                  textMatches(row, request.query?.text ?? []) &&
                  isAvailabilityIncluded(
                    row,
                    request.query?.includeUnavailable ?? false,
                  ) &&
                  (request.query?.filters.every((filter) =>
                    filterMatches(row, filter),
                  ) ??
                    true),
              )
            : rows;
          const sorted = [...filtered].sort((a, b) =>
            compareBrowseRows(a, b, request.sort),
          );
          const start = request.cursor ? Number(request.cursor) : 0;
          const end = start + request.limit;
          const response = {
            rows: sorted.slice(start, end),
            totalCount: sorted.length,
            nextCursor: end < sorted.length ? String(end) : null,
            warnings: [],
          };
          rememberBrowseResponse(browseCache, cacheKey, response);
          resolve({ ...response, requestId: request.requestId });
        }, delayMs);
      });
    },
    loadVisibleMetadata: (request) =>
      new Promise((resolve) => {
        globalThis.setTimeout(() => {
          resolve({
            requestId: request.requestId,
            metadataByRowId: Object.fromEntries(
              request.rowIds.map((rowId, index) => [
                rowId,
                {
                  peakDbfs: Number((-1 - (index % 18) * 0.7).toFixed(1)),
                  rmsDbfs: Number((-12 - (index % 12) * 0.6).toFixed(1)),
                  headroomDb: Number((1 + (index % 14) * 0.5).toFixed(1)),
                },
              ]),
            ),
          });
        }, delayMs);
      }),
  };
}

function isAvailabilityIncluded(row: BrowseRow, includeUnavailable: boolean): boolean {
  if (includeUnavailable || row.kind === "folder") return true;
  return row.availability !== "missing";
}

function browseCacheKey(request: BrowseRequest): string {
  return JSON.stringify({
    sourceScope: request.sourceScope,
    query: request.query,
    sort: request.sort,
    cursor: request.cursor ?? "",
    limit: request.limit,
  });
}

function rememberBrowseResponse(
  cache: Map<string, Omit<BrowseResponse, "requestId">>,
  key: string,
  response: Omit<BrowseResponse, "requestId">,
): void {
  if (cache.size >= maxBrowseCacheEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, response);
}

export class LatestBrowseResponseGate {
  private latestRequestId: string | null = null;

  begin(requestId: string): void {
    this.latestRequestId = requestId;
  }

  accept(response: BrowseResponse): boolean {
    return response.requestId === this.latestRequestId;
  }
}
