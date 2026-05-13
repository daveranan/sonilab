import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationDir = fileURLToPath(
  new URL("../../../src-tauri/migrations/", import.meta.url),
);
const repositoryPath = fileURLToPath(
  new URL("../../../src-tauri/src/data_layer.rs", import.meta.url),
);
const tauriLibPath = fileURLToPath(
  new URL("../../../src-tauri/src/lib.rs", import.meta.url),
);

const upSql = readFileSync(`${migrationDir}001_core_data_layer.up.sql`, "utf8");
const downSql = readFileSync(`${migrationDir}001_core_data_layer.down.sql`, "utf8");
const searchUpSql = readFileSync(`${migrationDir}002_search_index.up.sql`, "utf8");
const searchDownSql = readFileSync(`${migrationDir}002_search_index.down.sql`, "utf8");
const analysisCacheUpSql = readFileSync(
  `${migrationDir}003_analysis_cache_columns.up.sql`,
  "utf8",
);
const analysisCacheDownSql = readFileSync(
  `${migrationDir}003_analysis_cache_columns.down.sql`,
  "utf8",
);
const repositorySource = readFileSync(repositoryPath, "utf8");
const tauriLibSource = readFileSync(tauriLibPath, "utf8");

const requiredTables = [
  "sources",
  "folders",
  "assets",
  "asset_tags",
  "analysis",
  "waveform_peaks",
  "collections",
  "collection_items",
  "activity",
  "presets",
  "export_jobs",
  "cache_entries",
] as const;

function tableDefinition(tableName: string): string {
  const match = upSql.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`),
  );
  expect(match, `${tableName} table should be created`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("core data layer migration", () => {
  it("creates every Phase 1 table", () => {
    for (const table of requiredTables) {
      expect(upSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it("keeps stable uniqueness for idempotent writes", () => {
    expect(tableDefinition("sources")).toContain("UNIQUE (kind, provider, root_uri)");
    expect(tableDefinition("folders")).toContain("UNIQUE (source_id, path)");
    expect(tableDefinition("assets")).toContain("UNIQUE (source_id, stable_key)");
    expect(tableDefinition("cache_entries")).toContain(
      "cache_key TEXT NOT NULL UNIQUE",
    );
  });

  it("defines Phase 1 state constraints", () => {
    expect(tableDefinition("sources")).toContain("kind IN ('local', 'cloud')");
    expect(tableDefinition("analysis")).toContain("scope IN ('full', 'region')");
    expect(tableDefinition("collection_items")).toContain(
      "item_kind IN ('asset', 'folder_ref', 'source_ref')",
    );
    expect(tableDefinition("export_jobs")).toContain(
      "status IN ('queued', 'analyzing', 'processing', 'exporting', 'complete', 'failed', 'cancelled')",
    );
    expect(tableDefinition("cache_entries")).toContain(
      "kind IN ('preview', 'waveform', 'analysis', 'cloud_preview', 'export_temp')",
    );
  });

  it("drops every Phase 1 table in rollback", () => {
    for (const table of requiredTables) {
      expect(downSql).toContain(`DROP TABLE IF EXISTS ${table};`);
    }
  });

  it("creates the Phase 3 SQLite FTS5 search index and facet table", () => {
    expect(searchUpSql).toContain(
      "CREATE VIRTUAL TABLE IF NOT EXISTS asset_search_fts USING fts5",
    );
    for (const column of [
      "name",
      "path",
      "tags",
      "description",
      "originator",
      "license",
      "rights_flags",
      "format",
      "codec",
      "source_provider",
      "status",
      "dates",
      "stats",
    ]) {
      expect(searchUpSql).toContain(column);
    }
    expect(searchUpSql).toContain("CREATE TABLE IF NOT EXISTS asset_search_facets");
    expect(searchUpSql).toContain("peak_dbfs REAL");
    expect(searchUpSql).toContain("rms_dbfs REAL");
    expect(searchUpSql).toContain("headroom_db REAL");
    expect(searchDownSql).toContain("DROP TABLE IF EXISTS asset_search_fts;");
  });

  it("adds Phase 7 cache columns for headroom and sample count", () => {
    expect(analysisCacheUpSql).toContain("ADD COLUMN headroom_db REAL");
    expect(analysisCacheUpSql).toContain(
      "ADD COLUMN sample_count INTEGER NOT NULL DEFAULT 0",
    );
    expect(analysisCacheDownSql).toContain("DROP COLUMN sample_count");
    expect(analysisCacheDownSql).toContain("DROP COLUMN headroom_db");
  });

  it("has repository methods for Phase 1 access patterns", () => {
    const requiredMethods = [
      "create_local_source",
      "create_cloud_source",
      "update_source_status",
      "delete_source",
      "upsert_folder",
      "list_folders",
      "upsert_asset",
      "create_collection",
      "list_collections",
      "rename_collection",
      "delete_collection",
      "add_collection_asset",
      "add_collection_folder_ref",
      "record_activity",
      "list_activity",
      "upsert_cache_entry",
      "touch_cache_entry",
      "rebuild_asset_search_index",
      "search_assets",
    ];

    for (const method of requiredMethods) {
      expect(repositorySource).toContain(`pub fn ${method}`);
    }
  });

  it("wires Phase 1 repository commands into Tauri", () => {
    const requiredCommands = [
      "create_source",
      "update_source",
      "list_sources",
      "delete_source",
      "update_source_status",
      "upsert_folder",
      "list_source_folders",
      "upsert_asset",
      "get_asset_by_stable_key",
      "asset_tags",
      "create_collection",
      "list_collections",
      "rename_collection",
      "delete_collection",
      "add_collection_asset",
      "add_collection_folder_ref",
      "add_collection_source_ref",
      "list_collection_items",
      "record_activity",
      "list_activity",
      "upsert_cache_entry",
      "touch_cache_entry",
      "rebuild_asset_search_index",
      "search_assets",
    ];

    for (const command of requiredCommands) {
      expect(tauriLibSource).toContain(`fn ${command}`);
      expect(tauriLibSource).toContain(command);
    }
  });
});
