export const sonilabsAssetDragType = "application/x-sonilabs-assets";
export const sonilabsFolderDragType = "application/x-sonilabs-folder";

type DragTypeList = {
  includes(type: string): boolean;
};

export function shouldStartAssetFileExportDrag(input: {
  rowKind: "asset" | "folder";
  hasFileDragHandler: boolean;
}): boolean {
  return input.rowKind === "asset" && input.hasFileDragHandler;
}

export function hasSonilabsInternalDragType(
  types: DragTypeList | null | undefined,
): boolean {
  return Boolean(
    types?.includes(sonilabsAssetDragType) || types?.includes(sonilabsFolderDragType),
  );
}

export function shouldShowImportDropOverlay(input: {
  exportDragActive: boolean;
  internalDragActive: boolean;
  dataTransferTypes?: DragTypeList | null;
}): boolean {
  if (input.exportDragActive || input.internalDragActive) return false;
  const types = input.dataTransferTypes;
  if (!types) return true;
  if (hasSonilabsInternalDragType(types)) return false;
  return types.includes("Files");
}
