import type { SourceStatus } from "./sourceStatus";

export type LibraryNode = {
  id: string;
  label: string;
  kind: "root" | "source" | "folder" | "query" | "tagRoot" | "tagCategory";
  status?: SourceStatus;
  sourceId?: string;
  provider?: string;
  folderId?: string;
  path?: string;
  rootUri?: string;
  settingsJson?: string;
  monitorForChanges?: boolean;
  analyzeForFindSimilar?: boolean;
  metadataFile?: string | null;
  queryText?: string;
  children?: LibraryNode[];
};

export type CollectionNode = {
  id: string;
  label: string;
  parentId?: string | null;
  system?: boolean;
  updatedAt?: string;
  children?: CollectionNode[];
};

export type ActivityRow = {
  id: string;
  label: string;
  detail: string;
  status?: "ok" | "warning" | "error";
  activityType?: string;
  assetId?: string | null;
  sourceId?: string | null;
  folderId?: string | null;
  collectionId?: string | null;
  exportJobId?: string | null;
  query?: string | null;
  payload?: Record<string, unknown>;
};
