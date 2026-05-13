import { invoke } from "@tauri-apps/api/core";

import type {
  SearchFilter,
  SearchQuery,
  SourceScope,
} from "@/features/browsing/browseTypes";

type FreesoundCredentialResult = {
  source: {
    id: string;
    display_name?: string;
    displayName?: string;
  };
  credentialRef: string;
  warning?: string | null;
};

type FreesoundSearchResult = {
  sourceId: string;
  imported: number;
  total?: number | null;
  queryUrl: string;
  warnings: string[];
};

type InternetArchiveSearchResult = FreesoundSearchResult;

type CloudProviderEnabledResult = {
  source: {
    id: string;
    provider: string;
    status: string;
  };
  enabled: boolean;
};

export type ManualCloudImportInput = {
  provider: "opengameart" | "pixabay";
  filePath: string;
  assetPage: string;
  title?: string;
  author?: string;
  license?: string;
  attributionText?: string;
  description?: string;
  tags?: string[];
};

type ManualCloudImportResult = {
  sourceId: string;
  assetId: string;
  license: string;
  licenseStatus: string;
};

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function setupFreesoundCredentials(input: {
  sourceId?: string | null;
  displayName?: string;
  token?: string;
  tokenRef?: string;
}): Promise<FreesoundCredentialResult | null> {
  if (!hasTauri()) return null;
  return invoke<FreesoundCredentialResult>("setup_freesound_credentials", {
    input: {
      sourceId: input.sourceId ?? null,
      displayName: input.displayName ?? "Freesound",
      token: input.token?.trim() || null,
      tokenRef: input.tokenRef?.trim() || "env:FREESOUND_API_TOKEN",
    },
  });
}

export async function searchFreesound(input: {
  sourceScope: SourceScope;
  query: SearchQuery;
}): Promise<FreesoundSearchResult | null> {
  if (!hasTauri()) return null;
  const request = freesoundSearchRequest(input.sourceScope, input.query);
  return invoke<FreesoundSearchResult>("freesound_search", { request });
}

export async function searchInternetArchive(input: {
  sourceScope: SourceScope;
  query: SearchQuery;
}): Promise<InternetArchiveSearchResult | null> {
  if (!hasTauri()) return null;
  const request = internetArchiveSearchRequest(input.sourceScope, input.query);
  return invoke<InternetArchiveSearchResult>("internet_archive_search", { request });
}

export async function setCloudProviderEnabled(input: {
  provider: string;
  enabled: boolean;
}): Promise<CloudProviderEnabledResult | null> {
  if (!hasTauri()) return null;
  return invoke<CloudProviderEnabledResult>("set_cloud_provider_enabled", {
    request: input,
  });
}

export async function importManualCloudAsset(
  input: ManualCloudImportInput,
): Promise<ManualCloudImportResult | null> {
  if (!hasTauri()) return null;
  return invoke<ManualCloudImportResult>("import_manual_cloud_asset", {
    request: {
      provider: input.provider,
      filePath: input.filePath,
      assetPage: input.assetPage,
      title: input.title?.trim() || null,
      author: input.author?.trim() || null,
      license: input.license?.trim() || "unknown",
      attributionText: input.attributionText?.trim() || null,
      description: input.description?.trim() || null,
      tags: input.tags ?? [],
    },
  });
}

export function freesoundSearchRequest(
  sourceScope: SourceScope,
  query: SearchQuery,
): {
  sourceId: string | null;
  query: string | null;
  license: string | null;
  durationMin: number | null;
  durationMax: number | null;
  tags: string[];
  format: string | null;
  ratingMin: number | null;
  uploader: string | null;
  page: number;
  pageSize: number;
  allowNonCommercial: boolean;
} {
  const filters = query.filters;
  const license = textFilter(filters, "license") ?? "cc0";
  const duration = numericRange(filters, "duration");
  const rating = numericRange(filters, "rating");
  return {
    sourceId: sourceScope.kind === "source" ? sourceScope.sourceId : null,
    query: query.text.filter((term) => !term.startsWith("-")).join(" ") || null,
    license,
    durationMin: duration.min,
    durationMax: duration.max,
    tags: filters
      .filter((filter) => filter.field === "tag" && !filter.negated)
      .map((filter) => String(filter.value)),
    format: textFilter(filters, "format"),
    ratingMin: rating.min,
    uploader: textFilter(filters, "uploader") ?? textFilter(filters, "originator"),
    page: 1,
    pageSize: 50,
    allowNonCommercial: license === "by-nc",
  };
}

export function internetArchiveSearchRequest(
  sourceScope: SourceScope,
  query: SearchQuery,
): {
  sourceId: string | null;
  query: string | null;
  page: number;
  pageSize: number;
} {
  return {
    sourceId: sourceScope.kind === "source" ? sourceScope.sourceId : null,
    query: query.text.filter((term) => !term.startsWith("-")).join(" ") || null,
    page: 1,
    pageSize: 25,
  };
}

function textFilter(
  filters: SearchFilter[],
  field: SearchFilter["field"],
): string | null {
  const filter = filters.find(
    (candidate) =>
      candidate.field === field &&
      !candidate.negated &&
      typeof candidate.value === "string",
  );
  return typeof filter?.value === "string" ? filter.value : null;
}

function numericRange(
  filters: SearchFilter[],
  field: SearchFilter["field"],
): { min: number | null; max: number | null } {
  const filter = filters.find(
    (candidate) =>
      candidate.field === field && !candidate.negated && "operator" in candidate,
  );
  if (!filter || !("operator" in filter) || typeof filter.value !== "number") {
    return { min: null, max: null };
  }
  if (filter.operator === "range") {
    return { min: filter.value, max: filter.valueEnd ?? null };
  }
  if (filter.operator === ">" || filter.operator === ">=") {
    return { min: filter.value, max: null };
  }
  if (filter.operator === "<" || filter.operator === "<=") {
    return { min: null, max: filter.value };
  }
  return { min: filter.value, max: filter.value };
}
