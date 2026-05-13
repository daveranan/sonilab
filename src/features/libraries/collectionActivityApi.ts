import { invoke } from "@tauri-apps/api/core";

import type { ActivityRow, CollectionNode } from "./libraryTypes";

type CollectionRecord = {
  id: string;
  parent_id?: string | null;
  parentId?: string | null;
  name: string;
  sort_order?: number;
  sortOrder?: number;
  updated_at?: string;
  updatedAt?: string;
};

type ActivityRecord = {
  id: string;
  activity_type?: string;
  activityType?: string;
  asset_id?: string | null;
  assetId?: string | null;
  source_id?: string | null;
  sourceId?: string | null;
  folder_id?: string | null;
  folderId?: string | null;
  collection_id?: string | null;
  collectionId?: string | null;
  export_job_id?: string | null;
  exportJobId?: string | null;
  query?: string | null;
  message: string;
  status: string;
  payload_json?: string;
  payloadJson?: string;
  created_at?: string;
  createdAt?: string;
};

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadCollections(): Promise<CollectionNode[] | null> {
  if (!hasTauri()) return null;
  const records = await invoke<CollectionRecord[]>("list_collections");
  return collectionRecordsToTree(records);
}

export async function createCollection(input: {
  parentId?: string | null;
  name: string;
  sortOrder?: number;
}): Promise<CollectionNode | null> {
  if (!hasTauri()) return null;
  try {
    const record = await invoke<CollectionRecord>("create_collection", {
      parentId: input.parentId ?? null,
      name: input.name,
      sortOrder: input.sortOrder ?? 0,
    });
    return collectionRecordToNode(record);
  } catch {
    return null;
  }
}

export async function renameCollection(
  id: string,
  name: string,
): Promise<CollectionNode | null> {
  if (!hasTauri()) return null;
  try {
    const record = await invoke<CollectionRecord | null>("rename_collection", {
      id,
      name,
    });
    return record ? collectionRecordToNode(record) : null;
  } catch {
    return null;
  }
}

export async function deleteCollection(id: string): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    return await invoke<boolean>("delete_collection", { id });
  } catch {
    return false;
  }
}

export async function addAssetsToCollection(
  collectionId: string,
  assetIds: string[],
): Promise<void> {
  if (!hasTauri()) return;
  await Promise.all(
    assetIds.map((assetId) =>
      invoke("add_collection_asset", {
        collectionId,
        assetId,
        note: null,
      }),
    ),
  );
}

export async function addFolderRefToCollection(
  collectionId: string,
  folderId: string,
): Promise<void> {
  if (!hasTauri()) return;
  await invoke("add_collection_folder_ref", {
    collectionId,
    folderId,
    note: null,
  });
}

export async function recordActivity(input: {
  activityType: string;
  assetId?: string | null;
  sourceId?: string | null;
  folderId?: string | null;
  collectionId?: string | null;
  exportJobId?: string | null;
  query?: string | null;
  message: string;
  status?: "info" | "success" | "warning" | "error";
  payload?: Record<string, unknown>;
}): Promise<void> {
  if (!hasTauri()) return;
  await invoke("record_activity", {
    input: {
      id: null,
      activity_type: input.activityType,
      asset_id: input.assetId ?? null,
      source_id: input.sourceId ?? null,
      folder_id: input.folderId ?? null,
      collection_id: input.collectionId ?? null,
      export_job_id: input.exportJobId ?? null,
      query: input.query ?? null,
      message: input.message,
      status: input.status ?? "info",
      payload_json: JSON.stringify(input.payload ?? {}),
    },
  });
}

export async function loadActivity(limit = 50): Promise<ActivityRow[] | null> {
  if (!hasTauri()) return null;
  const records = await invoke<ActivityRecord[]>("list_activity", { limit });
  return records
    .map(activityRecordToRow)
    .filter((row) => row.activityType === "search");
}

export async function deleteActivity(id: string): Promise<boolean> {
  if (!hasTauri()) return false;
  try {
    return await invoke<boolean>("delete_activity", { id });
  } catch {
    return false;
  }
}

export async function clearActivity(activityType?: string): Promise<number> {
  if (!hasTauri()) return 0;
  try {
    return await invoke<number>("clear_activity", { activityType: activityType ?? null });
  } catch {
    return 0;
  }
}

function collectionRecordsToTree(records: CollectionRecord[]): CollectionNode[] {
  const nodes = new Map<string, CollectionNode>();
  const roots: CollectionNode[] = [];
  for (const record of records) {
    nodes.set(record.id, collectionRecordToNode(record));
  }
  for (const record of records) {
    const node = nodes.get(record.id);
    if (!node) continue;
    const parentId = record.parent_id ?? record.parentId ?? null;
    if (parentId && nodes.has(parentId)) {
      const parent = nodes.get(parentId);
      parent?.children?.push(node);
      if (parent && !parent.children) parent.children = [node];
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function collectionRecordToNode(record: CollectionRecord): CollectionNode {
  const parentId = record.parent_id ?? record.parentId ?? null;
  return {
    id: record.id,
    label: record.name,
    parentId,
    updatedAt: record.updated_at ?? record.updatedAt,
    system:
      parentId === null &&
      (record.name === "Favorites" || record.name === "Export Queue"),
    children: [],
  };
}

function activityRecordToRow(record: ActivityRecord): ActivityRow {
  const activityType = record.activity_type ?? record.activityType ?? "activity";
  const payloadJson = record.payload_json ?? record.payloadJson ?? "{}";
  const payload = parsePayload(payloadJson);
  return {
    id: record.id,
    label: labelForActivity(activityType),
    detail: record.message,
    status: record.status === "error" ? "error" : "ok",
    activityType,
    assetId: record.asset_id ?? record.assetId ?? null,
    sourceId: record.source_id ?? record.sourceId ?? null,
    folderId: record.folder_id ?? record.folderId ?? null,
    collectionId: record.collection_id ?? record.collectionId ?? null,
    exportJobId: record.export_job_id ?? record.exportJobId ?? null,
    query: record.query ?? null,
    payload,
  };
}

function labelForActivity(activityType: string): string {
  if (activityType === "played") return "Played";
  if (activityType === "search") return "Search";
  if (activityType === "import") return "Import";
  if (activityType === "export") return "Export";
  if (activityType === "export_failed" || activityType.endsWith("_error"))
    return "Failed";
  return "Activity";
}

function parsePayload(payloadJson: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(payloadJson) as unknown;
    return payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
