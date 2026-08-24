import { invoke } from "@tauri-apps/api/core";

import type {
  BrowseRequest,
  BrowseResponse,
  BrowseRow,
  LazyMetadataRequest,
  LazyMetadataResponse,
  SearchFilter,
  SearchWarning,
} from "./browseTypes";
import { expandSearchTerm } from "./searchExpansion";
import { compareBrowseRows } from "./sortModel";
import { isIgnoredTag } from "./tagCategories";

export type BrowseProvider = {
  browse: (request: BrowseRequest) => Promise<BrowseResponse>;
  loadVisibleMetadata: (request: LazyMetadataRequest) => Promise<LazyMetadataResponse>;
};

type DatabaseBrowseRow =
  | {
      kind: "folder";
      id: string;
      name: string;
      childCount?: number | null;
      child_count?: number | null;
      sourceId?: string;
      source_id?: string;
      sourceName?: string;
      source_name?: string;
      sourceRootUri?: string;
      source_root_uri?: string;
      path: string;
      fullPath?: string;
      full_path?: string;
      status: string;
    }
  | {
      kind: "asset";
      id: string;
      name: string;
      durationSeconds?: number | null;
      duration_seconds?: number | null;
      sampleRate?: number | null;
      sample_rate?: number | null;
      bitDepth?: number | null;
      bit_depth?: number | null;
      channels?: number | null;
      format?: string | null;
      codec?: string | null;
      fileSizeBytes?: number | null;
      file_size_bytes?: number | null;
      peakDbfs?: number | null;
      peak_dbfs?: number | null;
      rmsDbfs?: number | null;
      rms_dbfs?: number | null;
      clipping?: boolean | null;
      headroomDb?: number | null;
      headroom_db?: number | null;
      sourceName?: string;
      source_name?: string;
      sourceId?: string;
      source_id?: string;
      sourceRootUri?: string;
      source_root_uri?: string;
      provider?: string | null;
      folderId?: string | null;
      folder_id?: string | null;
      folderPath?: string | null;
      folder_path?: string | null;
      fullPath?: string;
      full_path?: string;
      relativePath?: string;
      relative_path?: string;
      license?: string | null;
      metadataFile?: string | null;
      metadata_file?: string | null;
      originator?: string | null;
      attribution?: string | null;
      description?: string | null;
      tags?: string[] | string | null;
      imported?: boolean;
      favorite?: boolean;
      availability?: string;
    };

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function createDbBrowseProvider(): BrowseProvider {
  return {
    browse: async (request) => {
      if (!hasTauri()) return emptyBrowseResponse(request);
      try {
        const warnings: SearchWarning[] = [];
        const backendQuery = buildBackendQuery(request);
        const tagFilters = buildBackendTagFilters(request);
        const sourceScope =
          request.sourceScope.kind === "cloud" || request.sourceScope.kind === "all"
            ? { kind: "local" as const }
            : request.sourceScope;
        const dbRows = await invoke<DatabaseBrowseRow[]>("browse_database", {
          request: {
            sourceScope,
            folderId: request.folderId ?? null,
            collectionId: request.collectionId ?? null,
            collectionName: collectionNameFromRequest(request),
            favoriteFilter: favoriteFilterFromRequest(request),
            query: backendQuery ?? null,
            tagFilters,
            limit: request.limit,
          },
        });
        if (dbRows.length === 0) {
          return { ...emptyBrowseResponse(request), warnings };
        }

        const rows = dbRows.map(databaseRowToBrowseRow);
        const sortedRows =
          request.sort.key === "bestMatch"
            ? rows
            : rows.sort((a, b) => compareBrowseRows(a, b, request.sort));
        return {
          requestId: request.requestId,
          rows: sortedRows,
          totalCount: sortedRows.length,
          nextCursor: null,
          warnings,
        };
      } catch (error) {
        return {
          requestId: request.requestId,
          rows: [],
          totalCount: 0,
          nextCursor: null,
          warnings: [
            {
              code: "invalid-filter",
              message: `Browse unavailable: ${String(error)}`,
              token: "browse",
            },
          ],
        };
      }
    },
    loadVisibleMetadata: (request: LazyMetadataRequest) =>
      Promise.resolve({ requestId: request.requestId, metadataByRowId: {} }),
  };
}

function emptyBrowseResponse(request: BrowseRequest): BrowseResponse {
  return {
    requestId: request.requestId,
    rows: [],
    totalCount: 0,
    nextCursor: null,
    warnings: [],
  };
}

export function buildBackendQuery(request: BrowseRequest): string | undefined {
  const query = request.query;
  if (!query) return undefined;
  const userTagAny = query.filters.find(
    (filter) => filter.field === "usertagany" && !filter.negated,
  );
  const userTag = query.filters.find(
    (filter) => filter.field === "usertag" && !filter.negated,
  );
  if (
    userTagAny &&
    typeof userTagAny.value === "string" &&
    query.text.length === 0 &&
    query.filters.length === 1
  ) {
    return `__user_tag_any__:${userTagAny.value}`;
  }
  if (
    userTag &&
    typeof userTag.value === "string" &&
    query.text.length === 0 &&
    query.filters.length === 1
  ) {
    return `__user_tag__:${userTag.value}`;
  }
  const terms = [
    ...query.text
      .filter((term) => !term.startsWith("-"))
      .map(textTermToBackendExpression),
    ...query.filters.flatMap(filterToBackendTerms),
  ];
  return terms.length > 0 ? terms.join(" ") : undefined;
}

export function buildBackendTagFilters(request: BrowseRequest): {
  all: string[];
  any: string[];
} {
  const all: string[] = [];
  const any: string[] = [];
  for (const filter of request.query?.filters ?? []) {
    if (filter.negated || typeof filter.value !== "string") continue;
    if (filter.field === "tag") all.push(filter.value);
    if (filter.field === "tagany") {
      any.push(
        ...filter.value
          .split("|")
          .map((tag) => tag.trim())
          .filter(Boolean),
      );
    }
  }
  return { all, any };
}

function textTermToBackendExpression(term: string): string {
  const expanded = expandSearchTerm(term);
  const quoted = expanded.map(quoteFtsTerm);
  return quoted.length > 1 ? `(${quoted.join(" OR ")})` : quoted[0];
}

function filterToBackendTerms(filter: SearchFilter): string[] {
  if (filter.negated || typeof filter.value !== "string") return [];
  if (filter.field === "collection") return [];
  if (
    filter.field === "usertag" ||
    filter.field === "usertagany" ||
    filter.field === "license" ||
    filter.field === "rights" ||
    filter.field === "format" ||
    filter.field === "codec" ||
    filter.field === "source" ||
    filter.field === "provider" ||
    filter.field === "path" ||
    filter.field === "originator" ||
    filter.field === "uploader" ||
    filter.field === "availability" ||
    filter.field === "status"
  ) {
    return [quoteFtsTerm(filter.value)];
  }
  return [];
}

function collectionNameFromRequest(request: BrowseRequest): string | null {
  const filter = request.query?.filters.find(
    (candidate) =>
      candidate.field === "collection" &&
      !candidate.negated &&
      typeof candidate.value === "string",
  );
  return typeof filter?.value === "string" ? filter.value : null;
}

function favoriteFilterFromRequest(request: BrowseRequest): boolean | null {
  const filter = request.query?.filters.find(
    (candidate) => candidate.field === "favorite" && !candidate.negated,
  );
  return filter?.field === "favorite" && typeof filter.value === "boolean"
    ? filter.value
    : null;
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function databaseRowToBrowseRow(row: DatabaseBrowseRow): BrowseRow {
  if (row.kind === "folder") {
    return {
      kind: "folder",
      id: row.id,
      name: row.name,
      childCount: row.childCount ?? row.child_count ?? null,
      sourceId: row.sourceId ?? row.source_id ?? "",
      sourceName: row.sourceName ?? row.source_name ?? undefined,
      sourceRootUri: row.sourceRootUri ?? row.source_root_uri ?? undefined,
      path: row.path,
      fullPath: row.fullPath ?? row.full_path ?? undefined,
      status: folderStatus(row.status),
    };
  }

  const sourceName = row.sourceName ?? row.source_name ?? "Indexed source";
  const sourceId = row.sourceId ?? row.source_id ?? "";
  const sourceRootUri = row.sourceRootUri ?? row.source_root_uri ?? "";
  const folderPath = row.folderPath ?? row.folder_path ?? null;
  const relativePath = row.relativePath ?? row.relative_path ?? row.name;
  return {
    kind: "asset",
    id: row.id,
    name: row.name,
    durationSeconds: row.durationSeconds ?? row.duration_seconds ?? null,
    sampleRate: row.sampleRate ?? row.sample_rate ?? null,
    bitDepth: row.bitDepth ?? row.bit_depth ?? null,
    channels: row.channels ?? null,
    format: row.format ?? extensionFromPath(relativePath),
    codec: row.codec ?? null,
    fileSizeBytes: row.fileSizeBytes ?? row.file_size_bytes ?? null,
    peakDbfs: row.peakDbfs ?? row.peak_dbfs ?? null,
    rmsDbfs: row.rmsDbfs ?? row.rms_dbfs ?? null,
    clipping: row.clipping ?? null,
    headroomDb: row.headroomDb ?? row.headroom_db ?? null,
    sourceName,
    sourceId,
    sourceRootUri,
    provider: row.provider ?? null,
    folderId: row.folderId ?? row.folder_id ?? null,
    folderPath,
    fullPath: row.fullPath ?? row.full_path ?? relativePath,
    relativePath,
    license: row.license ?? null,
    metadataFile: row.metadataFile ?? row.metadata_file ?? null,
    originator: row.originator ?? null,
    attribution: row.attribution ?? null,
    description: row.description ?? null,
    tags: normalizeTags(row.tags),
    rightsSummary: row.license ?? null,
    rating: null,
    imported: row.imported ?? true,
    favorite: row.favorite ?? false,
    availability: assetAvailability(row.availability),
  };
}

function normalizeTags(tags: string[] | string | null | undefined): string[] {
  if (Array.isArray(tags)) return tags.filter((tag) => !isIgnoredTag(tag));
  if (typeof tags === "string") {
    return tags
      .split(",")
      .map((tag) => tag.trim())
      .filter((tag) => tag && !isIgnoredTag(tag));
  }
  return [];
}

function folderStatus(
  status: string,
): Extract<BrowseRow, { kind: "folder" }>["status"] {
  if (status === "indexing" || status === "partial" || status === "error")
    return status;
  return "indexed";
}

function assetAvailability(
  availability: string | undefined,
): Extract<BrowseRow, { kind: "asset" }>["availability"] {
  if (availability === "download-required") return "download-required";
  if (availability === "cloud-preview") return "cloud-preview";
  if (availability === "missing") return "missing";
  return "available";
}

function extensionFromPath(path: string): string | null {
  const match = path.match(/\.([a-z0-9]+)$/i);
  return match?.[1]?.toLowerCase() ?? null;
}
