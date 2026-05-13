export type SourceScope =
  | { kind: "all" }
  | { kind: "local" }
  | { kind: "cloud"; provider?: string }
  | { kind: "source"; sourceId: string };

export type SearchFilterField =
  | "tag"
  | "tagany"
  | "license"
  | "rights"
  | "duration"
  | "format"
  | "codec"
  | "rate"
  | "bitdepth"
  | "channels"
  | "size"
  | "source"
  | "provider"
  | "path"
  | "collection"
  | "originator"
  | "uploader"
  | "rating"
  | "modified"
  | "indexed"
  | "imported"
  | "played"
  | "exported"
  | "available"
  | "missing"
  | "favorite"
  | "availability"
  | "status"
  | "waveform"
  | "analyzed"
  | "peak"
  | "rms"
  | "clipping"
  | "headroom";

export type NumericOperator = "<" | "<=" | ">" | ">=" | "=" | "range";
export type DateOperator = "<" | "<=" | ">" | ">=" | "=" | "range";

export type SearchFilterChip = {
  id: string;
  label: string;
  field: SearchFilterField;
  negated: boolean;
};

type NumericFilterField =
  | "duration"
  | "rate"
  | "bitdepth"
  | "channels"
  | "size"
  | "rating"
  | "peak"
  | "rms"
  | "headroom";

type BooleanFilterField =
  | "available"
  | "missing"
  | "favorite"
  | "imported"
  | "analyzed"
  | "clipping";

type DateFilterField = "modified" | "indexed" | "played" | "exported";

export type SearchFilter =
  | {
      field: Exclude<
        SearchFilterField,
        NumericFilterField | BooleanFilterField | DateFilterField
      >;
      value: string;
      negated: boolean;
    }
  | {
      field: NumericFilterField;
      operator: NumericOperator;
      value: number;
      valueEnd?: number;
      raw: string;
      negated: boolean;
    }
  | {
      field: BooleanFilterField;
      value: boolean;
      negated: boolean;
    }
  | {
      field: DateFilterField;
      operator: DateOperator;
      value: string;
      valueEnd?: string;
      raw: string;
      negated: boolean;
    };

export type SearchWarning = {
  code: "unknown-filter" | "invalid-filter" | "invalid-number" | "unterminated-quote";
  message: string;
  token: string;
};

export type SearchSortKey =
  | "bestMatch"
  | "name"
  | "duration"
  | "modifiedTime"
  | "format"
  | "sampleRate"
  | "bitDepth"
  | "channels"
  | "peak"
  | "rms"
  | "headroom"
  | "source"
  | "fileSize"
  | "rating"
  | "importedDate"
  | "indexedDate"
  | "recentlyPlayed"
  | "recentlyExported";

export type SortDirection = "asc" | "desc";

export type SearchSort = {
  key: SearchSortKey;
  direction: SortDirection;
  stableTieBreaker: "assetId";
};

export type SearchQuery = {
  text: string[];
  filters: SearchFilter[];
  sort: SearchSort;
  sourceScope: SourceScope;
  includeUnavailable: boolean;
  activeFilterChips: SearchFilterChip[];
};

export type BrowseRow =
  | {
      kind: "folder";
      id: string;
      name: string;
      childCount: number | null;
      sourceId: string;
      path: string;
      status: "indexed" | "indexing" | "partial" | "error";
    }
  | {
      kind: "asset";
      id: string;
      name: string;
      durationSeconds: number | null;
      sampleRate: number | null;
      bitDepth: number | null;
      channels: number | null;
      format: string | null;
      codec: string | null;
      fileSizeBytes: number | null;
      peakDbfs: number | null;
      rmsDbfs: number | null;
      clipping: boolean | null;
      headroomDb: number | null;
      sourceName: string;
      provider: string | null;
      relativePath: string;
      license: string | null;
      metadataFile: string | null;
      originator: string | null;
      attribution: string | null;
      description: string | null;
      tags: string[];
      rightsSummary: string | null;
      rating: number | null;
      imported: boolean;
      favorite: boolean;
      availability: "available" | "missing" | "cloud-preview" | "download-required";
    };

export type VisibleWindowHint = {
  startIndex: number;
  endIndex: number;
  rowIds: string[];
};

export type BrowseRequest = {
  requestId: string;
  viewId: string;
  sourceScope: SourceScope;
  folderId?: string;
  collectionId?: string;
  query?: SearchQuery;
  sort: SearchSort;
  cursor?: string;
  limit: number;
  visibleWindowHint?: VisibleWindowHint;
};

export type BrowseResponse = {
  requestId: string;
  rows: BrowseRow[];
  totalCount: number;
  nextCursor: string | null;
  warnings: SearchWarning[];
};

export type LazyMetadataRequest = {
  requestId: string;
  rowIds: string[];
  visibleWindowHint: VisibleWindowHint;
};

export type LazyMetadataResponse = {
  requestId: string;
  metadataByRowId: Record<
    string,
    Partial<
      Extract<
        BrowseRow,
        {
          kind: "asset";
        }
      >
    >
  >;
};
