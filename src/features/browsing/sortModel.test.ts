import { describe, expect, it } from "vitest";

import type { BrowseRow } from "./browseTypes";
import { compareBrowseRows, defaultFolderSort, serializeSort } from "./sortModel";

describe("sort model", () => {
  it("serializes sort keys for backend requests", () => {
    expect(serializeSort(defaultFolderSort)).toBe("name:asc:asset_id");
    expect(
      serializeSort({
        key: "modifiedTime",
        direction: "desc",
        stableTieBreaker: "assetId",
      }),
    ).toBe("modified_at:desc:asset_id");
  });

  it("sorts folder mode with folders first then stable asset ids", () => {
    const folder: BrowseRow = {
      kind: "folder",
      id: "folder-b",
      name: "b",
      childCount: 1,
      sourceId: "local",
      path: "/b",
      status: "indexed",
    };
    const asset: BrowseRow = {
      kind: "asset",
      id: "asset-a",
      name: "a",
      durationSeconds: 1,
      sampleRate: 44100,
      bitDepth: 16,
      channels: 2,
      format: "wav",
      codec: "pcm",
      fileSizeBytes: 1024,
      peakDbfs: null,
      rmsDbfs: null,
      clipping: null,
      headroomDb: null,
      sourceName: "Local",
      provider: "local",
      relativePath: "a",
      license: "cc0",
      metadataFile: null,
      originator: null,
      attribution: null,
      description: null,
      tags: [],
      rightsSummary: "commercial-ok cc0",
      rating: null,
      imported: true,
      favorite: false,
      availability: "available",
    };

    expect(
      [asset, folder].sort((a, b) => compareBrowseRows(a, b, defaultFolderSort)),
    ).toEqual([folder, asset]);
  });
});
