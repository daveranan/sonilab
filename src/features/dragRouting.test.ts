import { describe, expect, it } from "vitest";

import {
  dataTransferHasType,
  shouldShowImportDropOverlay,
  shouldStartAssetFileExportDrag,
  sonilabsAssemblyClipDragType,
  sonilabsAssemblyProjectDragType,
  sonilabsAssemblyTrackDragType,
  sonilabsAssetDragType,
  sonilabsCollectionDragType,
} from "./dragRouting";

describe("shared drag routing", () => {
  it("starts asset file export from a plain row drag", () => {
    expect(
      shouldStartAssetFileExportDrag({
        rowKind: "asset",
        hasFileDragHandler: true,
      }),
    ).toBe(true);
  });

  it("does not route folders or missing handlers to file export", () => {
    expect(
      shouldStartAssetFileExportDrag({
        rowKind: "folder",
        hasFileDragHandler: true,
      }),
    ).toBe(false);
    expect(
      shouldStartAssetFileExportDrag({
        rowKind: "asset",
        hasFileDragHandler: false,
      }),
    ).toBe(false);
  });

  it("suppresses import overlay during internal and export drags", () => {
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: true,
        internalDragActive: false,
        dataTransferTypes: ["Files"],
      }),
    ).toBe(false);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: [sonilabsCollectionDragType],
      }),
    ).toBe(false);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: true,
        dataTransferTypes: ["Files"],
      }),
    ).toBe(false);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: [sonilabsAssetDragType],
      }),
    ).toBe(false);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: [sonilabsAssemblyClipDragType],
      }),
    ).toBe(false);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: [sonilabsAssemblyTrackDragType],
      }),
    ).toBe(false);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: [sonilabsAssemblyProjectDragType],
      }),
    ).toBe(false);
  });

  it("shows import overlay only for real external file drags", () => {
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: ["Files"],
      }),
    ).toBe(true);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: ["text/plain"],
      }),
    ).toBe(false);
  });

  it("recognizes WebView DOMStringList drag types", () => {
    expect(
      dataTransferHasType(
        {
          contains: (type: string) => type === sonilabsAssetDragType,
        },
        sonilabsAssetDragType,
      ),
    ).toBe(true);
    expect(
      shouldShowImportDropOverlay({
        exportDragActive: false,
        internalDragActive: false,
        dataTransferTypes: {
          contains: (type: string) => type === sonilabsAssetDragType,
        },
      }),
    ).toBe(false);
  });
});
