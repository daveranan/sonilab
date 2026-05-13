import { create } from "zustand";

export type BrowseSelectionState = {
  activeRowId: string | null;
  selectedRowIds: Set<string>;
  anchorRowId: string | null;
  lastUserIntent: "mouse" | "keyboard" | "programmatic";
};

export type PreviewIntent =
  | { kind: "toggle-preview"; rowId: string | null }
  | { kind: "start-preview"; rowId: string }
  | { kind: "open-row"; rowId: string | null };

type SelectionAction =
  | { type: "single"; rowId: string; intent: BrowseSelectionState["lastUserIntent"] }
  | { type: "toggle"; rowId: string }
  | { type: "range"; rowId: string; orderedRowIds: string[] }
  | {
      type: "move";
      delta: number;
      orderedRowIds: string[];
      extend: boolean;
      keepSelection: boolean;
    }
  | { type: "jump"; target: "first" | "last"; orderedRowIds: string[]; extend: boolean }
  | { type: "select-all"; orderedRowIds: string[] }
  | { type: "clear" }
  | { type: "retain"; orderedRowIds: string[] };

export const initialBrowseSelectionState: BrowseSelectionState = {
  activeRowId: null,
  selectedRowIds: new Set(),
  anchorRowId: null,
  lastUserIntent: "programmatic",
};

function rangeBetween(
  anchorId: string,
  rowId: string,
  orderedRowIds: string[],
): Set<string> {
  const anchorIndex = orderedRowIds.indexOf(anchorId);
  const rowIndex = orderedRowIds.indexOf(rowId);
  if (anchorIndex === -1 || rowIndex === -1) return new Set([rowId]);
  const start = Math.min(anchorIndex, rowIndex);
  const end = Math.max(anchorIndex, rowIndex);
  return new Set(orderedRowIds.slice(start, end + 1));
}

function moveIndex(
  activeRowId: string | null,
  delta: number,
  orderedRowIds: string[],
): number {
  if (orderedRowIds.length === 0) return -1;
  const current = activeRowId ? orderedRowIds.indexOf(activeRowId) : 0;
  return Math.max(0, Math.min(orderedRowIds.length - 1, current + delta));
}

export function browseSelectionReducer(
  state: BrowseSelectionState,
  action: SelectionAction,
): BrowseSelectionState {
  switch (action.type) {
    case "single":
      return {
        activeRowId: action.rowId,
        selectedRowIds: new Set([action.rowId]),
        anchorRowId: action.rowId,
        lastUserIntent: action.intent,
      };
    case "toggle": {
      const selectedRowIds = new Set(state.selectedRowIds);
      if (selectedRowIds.has(action.rowId)) selectedRowIds.delete(action.rowId);
      else selectedRowIds.add(action.rowId);
      return {
        activeRowId: action.rowId,
        selectedRowIds,
        anchorRowId: state.anchorRowId ?? action.rowId,
        lastUserIntent: "mouse",
      };
    }
    case "range": {
      const anchorRowId = state.anchorRowId ?? action.rowId;
      return {
        activeRowId: action.rowId,
        selectedRowIds: rangeBetween(anchorRowId, action.rowId, action.orderedRowIds),
        anchorRowId,
        lastUserIntent: "mouse",
      };
    }
    case "move": {
      const index = moveIndex(state.activeRowId, action.delta, action.orderedRowIds);
      const rowId = action.orderedRowIds[index] ?? null;
      if (rowId === null) return state;
      const anchorRowId = state.anchorRowId ?? state.activeRowId ?? rowId;
      return {
        activeRowId: rowId,
        selectedRowIds: action.extend
          ? rangeBetween(anchorRowId, rowId, action.orderedRowIds)
          : action.keepSelection
            ? new Set(state.selectedRowIds)
            : new Set([rowId]),
        anchorRowId: action.extend ? anchorRowId : rowId,
        lastUserIntent: "keyboard",
      };
    }
    case "jump": {
      const rowId =
        action.target === "first"
          ? action.orderedRowIds[0]
          : action.orderedRowIds[action.orderedRowIds.length - 1];
      if (!rowId) return state;
      const anchorRowId = state.anchorRowId ?? state.activeRowId ?? rowId;
      return {
        activeRowId: rowId,
        selectedRowIds: action.extend
          ? rangeBetween(anchorRowId, rowId, action.orderedRowIds)
          : new Set([rowId]),
        anchorRowId: action.extend ? anchorRowId : rowId,
        lastUserIntent: "keyboard",
      };
    }
    case "select-all":
      return {
        activeRowId: state.activeRowId ?? action.orderedRowIds[0] ?? null,
        selectedRowIds: new Set(action.orderedRowIds),
        anchorRowId: state.anchorRowId ?? action.orderedRowIds[0] ?? null,
        lastUserIntent: "keyboard",
      };
    case "clear":
      return initialBrowseSelectionState;
    case "retain": {
      const retained = new Set(
        [...state.selectedRowIds].filter((rowId) =>
          action.orderedRowIds.includes(rowId),
        ),
      );
      const activeRowId =
        state.activeRowId && action.orderedRowIds.includes(state.activeRowId)
          ? state.activeRowId
          : (action.orderedRowIds.find((rowId) => retained.has(rowId)) ?? null);
      return {
        ...state,
        activeRowId,
        selectedRowIds: retained,
        anchorRowId:
          state.anchorRowId && action.orderedRowIds.includes(state.anchorRowId)
            ? state.anchorRowId
            : activeRowId,
      };
    }
  }
}

type BrowseSelectionStore = BrowseSelectionState & {
  dispatch: (action: SelectionAction) => void;
};

export const useBrowseSelectionStore = create<BrowseSelectionStore>((set) => ({
  ...initialBrowseSelectionState,
  dispatch: (action) => set((state) => browseSelectionReducer(state, action)),
}));

export function selectionSize(state: BrowseSelectionState): number {
  return state.selectedRowIds.size;
}
