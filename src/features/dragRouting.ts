export const sonilabsAssetDragType = "application/x-sonilabs-assets";
export const sonilabsFolderDragType = "application/x-sonilabs-folder";
export const sonilabsCollectionDragType = "application/x-sonilabs-collection";
export const sonilabsAssemblyProjectDragType =
  "application/x-sonilabs-assembly-project";
export const sonilabsAssemblyClipDragType =
  "application/x-sonilabs-assembly-clip";
export const sonilabsAssemblyTrackDragType =
  "application/x-sonilabs-assembly-track";

type DragTypeList = {
  contains?: (type: string) => boolean;
  includes?: (type: string) => boolean;
  item?: (index: number) => string | null;
  readonly length?: number;
  [index: number]: string;
};

export function dataTransferHasType(
  types: DragTypeList | null | undefined,
  type: string,
): boolean {
  if (!types) return false;
  if (typeof types.includes === "function") return types.includes(type);
  if (typeof types.contains === "function") return types.contains(type);
  if (typeof types.length === "number") {
    for (let index = 0; index < types.length; index += 1) {
      const value =
        typeof types.item === "function" ? types.item(index) : types[index];
      if (value === type) return true;
    }
  }
  return false;
}

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
    dataTransferHasType(types, sonilabsAssetDragType) ||
      dataTransferHasType(types, sonilabsFolderDragType) ||
      dataTransferHasType(types, sonilabsCollectionDragType) ||
      dataTransferHasType(types, sonilabsAssemblyProjectDragType) ||
      dataTransferHasType(types, sonilabsAssemblyClipDragType) ||
      dataTransferHasType(types, sonilabsAssemblyTrackDragType),
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
  return dataTransferHasType(types, "Files");
}
