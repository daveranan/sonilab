import {
  Download,
  FileAudio,
  GripVertical,
  Layers3,
  LoaderCircle,
  Magnet,
  Pause,
  Play,
  Plus,
  Trash2,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  deletePreparedDragFiles,
  getCachedWaveformPeaks,
  getWaveformPeaks,
  resolvePreviewFile,
  startPreparedFilesDrag,
} from "@/features/audio-preview/commands";
import {
  dataTransferHasType,
  sonilabsAssemblyClipDragType,
  sonilabsAssemblyTrackDragType,
  sonilabsAssetDragType,
} from "@/features/dragRouting";
import type { WaveformPeakData, WaveformRegion } from "@/features/audio-preview/types";
import type { BrowseRow } from "@/features/browsing/browseTypes";
import { cn } from "@/lib/utils";

import {
  addClipToTrack,
  canPlaceClip,
  createAssemblyProject,
  createClip,
  createTrack,
  duplicateClip,
  moveClip,
  moveTrack,
  processingPlaybackRate,
  projectDuration,
  removeClips,
  removeTrack,
  snapTimelineSeconds,
  trimClip,
  updateClip,
} from "./assemblyModel";
import {
  prepareAssemblyExport,
  renderAssemblyWav,
  saveAssemblyWav,
  savePreparedAssemblyExport,
} from "./audioRender";
import {
  assemblyProjectCreateEvent,
  assemblyProjectDeleteEvent,
  assemblyProjectOpenEvent,
  assemblyProjectRenameEvent,
  readAssemblyProjects,
  writeAssemblyProjects,
} from "./projectStore";
import type {
  AssemblyClip,
  AssemblyClipProcessing,
  AssemblyProject,
  AssemblyTrack,
} from "./types";

const clipDragType = sonilabsAssemblyClipDragType;
const trackDragType = sonilabsAssemblyTrackDragType;
const trackHeight = 68;
const defaultTrackControlsWidth = 132;
const newLayerPreviewTrackId = "__new-layer-preview__";
const clipColors = [
  "border-cyan-300/45 bg-cyan-500/25 text-cyan-50",
  "border-violet-300/45 bg-violet-500/25 text-violet-50",
  "border-amber-300/45 bg-amber-500/25 text-amber-50",
  "border-emerald-300/45 bg-emerald-500/25 text-emerald-50",
  "border-rose-300/45 bg-rose-500/25 text-rose-50",
];
const defaultAssemblyClipProcessing: AssemblyClipProcessing = {
  mode: "original",
  gainDb: 0,
  eq: { enabled: false, lowDb: 0, midDb: 0, highDb: 0 },
  pitchSemitones: 0,
  playbackRate: 1,
  channelMode: "all",
  reversed: false,
};

function setAssemblyInternalDragActive(active: boolean): void {
  window.dispatchEvent(
    new CustomEvent("sonilabs:assembly-internal-drag-active", {
      detail: { active },
    }),
  );
}

type AssemblerPanelProps = {
  onClose: () => void;
  onFocusSource?: (
    assetId: string,
    region: WaveformRegion | null,
    asset?: Extract<BrowseRow, { kind: "asset" }>,
  ) => void;
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
  rows: BrowseRow[];
};

type TimelineMenuState =
  | { kind: "clip"; clipId: string; trackId: string; x: number; y: number }
  | { kind: "track"; trackId: string; x: number; y: number };

type TimelineMenuRequest =
  | { kind: "clip"; clipId: string; trackId: string }
  | { kind: "track"; trackId: string };

type ResizeState = {
  clipId: string;
  edge: "start" | "end";
  startClientX: number;
  lastDeltaSeconds: number;
  sourceDurationSeconds?: number;
};

type MoveState = {
  clipId: string;
  startClientX: number;
  startSeconds: number;
  preview: DragPreview | null;
  moved: boolean;
};

type DragPreview = {
  clipId: string;
  trackId: string;
  startSeconds: number;
  valid: boolean;
};

type RowDragPreview = {
  clip: AssemblyClip;
  trackId: string;
  startSeconds: number;
  valid: boolean;
};

type MarqueeState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  initialSelection: Set<string>;
};

type FadeState = {
  clipId: string;
  edge: "in" | "out";
  startClientX: number;
  startFadeSeconds: number;
};

type TimelinePanState = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

type AssemblyExportSettings = {
  format: string;
  formatSettings: Record<string, unknown>;
  tempFolder: string;
};

function waveformPeakBars(
  clip: AssemblyClip,
  peakData: WaveformPeakData | undefined,
  count = 56,
): number[] {
  if (!peakData?.channels.length) return [];
  const channel = peakData.channels[0];
  const peakCount = Math.min(channel.minimums.length, channel.maximums.length);
  if (peakCount === 0) return [];
  const dataStartSeconds = peakData.peakStartSeconds ?? 0;
  const dataEndSeconds = peakData.peakEndSeconds ?? peakData.durationSeconds;
  const dataDurationSeconds = Math.max(0.001, dataEndSeconds - dataStartSeconds);
  const clipStart = clip.sourceStartSeconds;
  const clipEnd =
    clip.sourceStartSeconds +
    clip.durationSeconds * processingPlaybackRate(clip.processing);
  const bars = Array.from({ length: count }, (_, index) => {
    const startSeconds =
      clipStart + (index / count) * Math.max(0.001, clipEnd - clipStart);
    const endSeconds =
      clipStart + ((index + 1) / count) * Math.max(0.001, clipEnd - clipStart);
    const startPeak = Math.max(
      0,
      Math.min(
        peakCount - 1,
        Math.floor(((startSeconds - dataStartSeconds) / dataDurationSeconds) * peakCount),
      ),
    );
    const endPeak = Math.max(
      startPeak,
      Math.min(
        peakCount - 1,
        Math.ceil(((endSeconds - dataStartSeconds) / dataDurationSeconds) * peakCount),
      ),
    );
    let amplitude = 0;
    for (let peakIndex = startPeak; peakIndex <= endPeak; peakIndex += 1) {
      amplitude = Math.max(
        amplitude,
        Math.abs(channel.minimums[peakIndex] ?? 0),
        Math.abs(channel.maximums[peakIndex] ?? 0),
      );
    }
    return Math.max(8, Math.min(96, amplitude * 92));
  });
  return clip.processing?.reversed ? bars.reverse() : bars;
}

function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
}

function snapDeltaSeconds(seconds: number, step = 0.05): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds / step) * step;
}

function snapClipToEdges(
  project: AssemblyProject,
  clipId: string,
  proposedStart: number,
  duration: number,
  thresholdSeconds: number,
): { startSeconds: number; guideSeconds: number | null } {
  const edges = project.tracks.flatMap((track) =>
    track.clips
      .filter((clip) => clip.id !== clipId)
      .flatMap((clip) => [
        clip.startSeconds,
        clip.startSeconds + clip.durationSeconds,
      ]),
  );
  let bestStart = proposedStart;
  let guideSeconds: number | null = null;
  let bestDistance = thresholdSeconds;
  for (const edge of edges) {
    for (const candidate of [edge, edge - duration]) {
      const distance = Math.abs(candidate - proposedStart);
      if (candidate >= 0 && distance <= bestDistance) {
        bestDistance = distance;
        bestStart = candidate;
        guideSeconds = edge;
      }
    }
  }
  return { startSeconds: Math.max(0, bestStart), guideSeconds };
}

function ClipWaveform({
  clip,
  peakData,
}: {
  clip: AssemblyClip;
  peakData?: WaveformPeakData;
}) {
  const bars = waveformPeakBars(clip, peakData);
  if (!bars.length) {
    return (
      <span className="absolute inset-x-1 bottom-1 top-4 flex items-center opacity-60">
        <i className="h-px w-full bg-current" />
      </span>
    );
  }
  const top = bars.map(
    (height, index) => `${index},${50 - Math.max(2, height / 2)}`,
  );
  const bottom = bars
    .map((height, index) => `${index},${50 + Math.max(2, height / 2)}`)
    .reverse();
  return (
    <svg
      aria-hidden
      className="absolute inset-x-1 bottom-1 top-4 h-[calc(100%-1.25rem)] w-[calc(100%-0.5rem)] overflow-visible text-white/90"
      preserveAspectRatio="none"
      viewBox={`0 0 ${Math.max(1, bars.length - 1)} 100`}
    >
      <line stroke="currentColor" strokeOpacity="0.35" x1="0" x2="100%" y1="50" y2="50" />
      <polygon fill="currentColor" points={[...top, ...bottom].join(" ")} />
    </svg>
  );
}

function shortcutTargetIsEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

function droppedAssets(
  dataTransfer: DataTransfer,
  assetRows: Map<string, Extract<BrowseRow, { kind: "asset" }>>,
): Extract<BrowseRow, { kind: "asset" }>[] {
  const rawIds =
    dataTransfer.getData(sonilabsAssetDragType) ||
    dataTransfer.getData("text/plain");
  if (!rawIds) return [];
  try {
    const parsed = JSON.parse(rawIds) as
      | string[]
      | { type?: string; assetIds?: string[] };
    const ids = Array.isArray(parsed)
      ? parsed
      : parsed.type === "sonilabs-assets"
        ? (parsed.assetIds ?? [])
        : [];
    return ids
      .map((id) => assetRows.get(id))
      .filter(
        (asset): asset is Extract<BrowseRow, { kind: "asset" }> => Boolean(asset),
      );
  } catch {
    return [];
  }
}

export function AssemblerPanel({
  onClose,
  onFocusSource,
  onResizeStart,
  rows,
}: AssemblerPanelProps) {
  const [projectsState, setProjectsState] = useState(readAssemblyProjects);
  const [zoom, setZoom] = useState(1);
  const [trackControlsWidth, setTrackControlsWidth] = useState(
    defaultTrackControlsWidth,
  );
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(
    () =>
      (
        projectsState.projects.find(
          (candidate) => candidate.id === projectsState.activeProjectId,
        ) ?? projectsState.projects[0]
      )?.tracks[0]?.id ?? null,
  );
  const [status, setStatus] = useState("Drag rows or waveform regions into Assembler.");
  const [rendering, setRendering] = useState(false);
  const [preparedExportDrag, setPreparedExportDrag] = useState<{
    phase: "rendering" | "ready";
    label: string;
  } | null>(null);
  const [exportSettings, setExportSettings] = useState<AssemblyExportSettings>({
    format: "WAV",
    formatSettings: { wavBitDepth: 16 },
    tempFolder: "",
  });
  const [menu, setMenu] = useState<TimelineMenuState | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreview | null>(null);
  const [emptyDropPreview, setEmptyDropPreview] = useState<AssemblyClip | null>(
    null,
  );
  const [rowDragPreview, setRowDragPreview] = useState<RowDragPreview | null>(
    null,
  );
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [trackDropIndex, setTrackDropIndex] = useState<number | null>(null);
  const [timelinePanning, setTimelinePanning] = useState(false);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [snapGuideSeconds, setSnapGuideSeconds] = useState<number | null>(null);
  const [clipInspectorOpen, setClipInspectorOpen] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const [waveformsByAssetId, setWaveformsByAssetId] = useState<
    Record<string, WaveformPeakData>
  >({});
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const previewCacheRef = useRef<{ key: string; url: string } | null>(null);
  const previewRenderRef = useRef<{
    key: string;
    promise: Promise<string>;
  } | null>(null);
  const latestProjectKeyRef = useRef("");
  const playheadFrameRef = useRef<number | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const moveRef = useRef<MoveState | null>(null);
  const fadeRef = useRef<FadeState | null>(null);
  const suppressClipClickRef = useRef(false);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const timelinePanRef = useRef<TimelinePanState | null>(null);
  const copiedClipsRef = useRef<AssemblyClip[]>([]);
  const draggedRowAssetIdsRef = useRef<string[]>([]);
  const rowDragPreviewRef = useRef<RowDragPreview | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const project = (
    projectsState.projects.find(
      (candidate) => candidate.id === projectsState.activeProjectId,
    ) ?? projectsState.projects[0]
  )!;
  const projectRef = useRef(project);
  const gestureBaseProjectRef = useRef<AssemblyProject | null>(null);
  const historyRef = useRef(
    new Map<string, { undo: AssemblyProject[]; redo: AssemblyProject[] }>(),
  );

  const getHistory = useCallback((projectId: string) => {
    let history = historyRef.current.get(projectId);
    if (!history) {
      history = { undo: [], redo: [] };
      historyRef.current.set(projectId, history);
    }
    return history;
  }, []);

  const replaceProject = useCallback((next: AssemblyProject) => {
    projectRef.current = next;
    setProjectsState((current) => ({
      ...current,
      projects: current.projects.map((candidate) =>
        candidate.id === next.id ? next : candidate,
      ),
    }));
  }, []);

  const setProject = useCallback(
    (update: React.SetStateAction<AssemblyProject>) => {
      const current = projectRef.current;
      const next = typeof update === "function" ? update(current) : update;
      if (next === current || JSON.stringify(next) === JSON.stringify(current)) return;
      const history = getHistory(current.id);
      history.undo.push(current);
      if (history.undo.length > 100) history.undo.shift();
      history.redo = [];
      replaceProject(next);
      setHistoryVersion((version) => version + 1);
    },
    [getHistory, replaceProject],
  );

  const setProjectTransient = useCallback(
    (update: React.SetStateAction<AssemblyProject>) => {
      const current = projectRef.current;
      const next = typeof update === "function" ? update(current) : update;
      if (next !== current) replaceProject(next);
    },
    [replaceProject],
  );

  const commitGestureHistory = useCallback(() => {
    const before = gestureBaseProjectRef.current;
    gestureBaseProjectRef.current = null;
    if (!before || JSON.stringify(before) === JSON.stringify(projectRef.current)) return;
    const history = getHistory(before.id);
    history.undo.push(before);
    if (history.undo.length > 100) history.undo.shift();
    history.redo = [];
    setHistoryVersion((version) => version + 1);
  }, [getHistory]);

  const undo = useCallback(() => {
    const current = projectRef.current;
    const history = getHistory(current.id);
    const previous = history.undo.pop();
    if (!previous) return;
    history.redo.push(current);
    replaceProject(previous);
    setHistoryVersion((version) => version + 1);
    setStatus("Undid assembly edit.");
  }, [getHistory, replaceProject]);

  const redo = useCallback(() => {
    const current = projectRef.current;
    const history = getHistory(current.id);
    const next = history.redo.pop();
    if (!next) return;
    history.undo.push(current);
    replaceProject(next);
    setHistoryVersion((version) => version + 1);
    setStatus("Redid assembly edit.");
  }, [getHistory, replaceProject]);
  const pixelsPerSecond = 46 * zoom;
  const durationSeconds = Math.max(8, Math.ceil(projectDuration(project) + 2));
  const contentWidth = Math.max(520, durationSeconds * pixelsPerSecond);
  const projectKey = useMemo(() => JSON.stringify(project), [project]);
  const assetRows = useMemo(
    () =>
      new Map(
        rows
          .filter(
            (row): row is Extract<BrowseRow, { kind: "asset" }> =>
              row.kind === "asset",
          )
          .map((row) => [row.id, row]),
      ),
    [rows],
  );
  const assetsForDrag = useCallback(
    (dataTransfer: DataTransfer) => {
      const direct = droppedAssets(dataTransfer, assetRows);
      if (direct.length) return direct;
      return draggedRowAssetIdsRef.current
        .map((id) => assetRows.get(id))
        .filter(
          (asset): asset is Extract<BrowseRow, { kind: "asset" }> =>
            Boolean(asset),
        );
    },
    [assetRows],
  );
  const selectedClipCount = selectedClipIds.size;
  const selectedClip = useMemo(
    () =>
      selectedClipCount === 1
        ? project.tracks
            .flatMap((track) => track.clips)
            .find((clip) => selectedClipIds.has(clip.id)) ?? null
        : null,
    [project.tracks, selectedClipCount, selectedClipIds],
  );
  const selectedClipProcessing =
    selectedClip?.processing ?? defaultAssemblyClipProcessing;
  const updateSelectedClipProcessing = useCallback(
    (patch: Partial<AssemblyClipProcessing>) => {
      if (!selectedClip) return;
      const nextProcessing = {
        ...defaultAssemblyClipProcessing,
        ...selectedClipProcessing,
        ...patch,
        eq: patch.eq ?? selectedClipProcessing.eq,
      };
      const previousRate = processingPlaybackRate(selectedClipProcessing);
      const nextRate = processingPlaybackRate(nextProcessing);
      const nextDuration = Math.max(
        0.02,
        selectedClip.durationSeconds * (previousRate / nextRate),
      );
      setProject((current) =>
        updateClip(current, selectedClip.id, {
          processing: nextProcessing,
          durationSeconds: nextDuration,
          fadeInSeconds: Math.min(selectedClip.fadeInSeconds, nextDuration),
          fadeOutSeconds: Math.min(selectedClip.fadeOutSeconds, nextDuration),
        }),
      );
    },
    [selectedClip, selectedClipProcessing, setProject],
  );
  const toggleSelectedClipReverse = useCallback(() => {
    updateSelectedClipProcessing({
      reversed: !selectedClipProcessing.reversed,
    });
  }, [selectedClipProcessing.reversed, updateSelectedClipProcessing]);
  const updateSelectedClipFields = useCallback(
    (patch: Partial<AssemblyClip>) => {
      if (!selectedClip) return;
      setProject((current) => updateClip(current, selectedClip.id, patch));
    },
    [selectedClip, setProject],
  );
  const projectAssetIds = useMemo(
    () => [...new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId)))],
    [project.tracks],
  );

  useEffect(() => {
    latestProjectKeyRef.current = projectKey;
    projectRef.current = project;
  }, [project, projectKey]);

  useEffect(() => writeAssemblyProjects(projectsState), [projectsState]);

  useEffect(() => {
    const update = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          format?: string;
          formatSettings?: Record<string, unknown>;
          tempFolder?: string;
        }>
      ).detail;
      if (!detail?.format) return;
      setExportSettings({
        format: detail.format,
        formatSettings: detail.formatSettings ?? {},
        tempFolder: detail.tempFolder ?? "",
      });
    };
    window.addEventListener("sonilabs:export-format-changed", update);
    window.dispatchEvent(new CustomEvent("sonilabs:export-format-request"));
    return () => window.removeEventListener("sonilabs:export-format-changed", update);
  }, []);

  useEffect(() => {
    const rememberDraggedAssets = (event: Event) => {
      draggedRowAssetIdsRef.current =
        (event as CustomEvent<{ assetIds?: string[] }>).detail?.assetIds ?? [];
    };
    const clearDraggedAssets = () => {
      draggedRowAssetIdsRef.current = [];
      setEmptyDropPreview(null);
    };
    window.addEventListener(
      "sonilabs:assembly-asset-drag-start",
      rememberDraggedAssets,
    );
    window.addEventListener("dragend", clearDraggedAssets, true);
    return () => {
      window.removeEventListener(
        "sonilabs:assembly-asset-drag-start",
        rememberDraggedAssets,
      );
      window.removeEventListener("dragend", clearDraggedAssets, true);
    };
  }, []);

  useEffect(() => {
    let draggedClip: AssemblyClip | null = null;
    let draggedSource: "row" | "region" = "row";
    const updatePreview = (clientX: number, clientY: number) => {
      if (!draggedClip) return;
      const trackZone = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-assembly-track-id]");
      const scroller = timelineScrollRef.current;
      const scrollerBounds = scroller?.getBoundingClientRect();
      let trackId = trackZone?.dataset.assemblyTrackId ?? null;
      let startSeconds = 0;
      if (trackZone && trackId) {
        const bounds = trackZone.getBoundingClientRect();
        startSeconds = snapTimelineSeconds(
          (clientX - bounds.left) / pixelsPerSecond,
        );
      } else if (
        scroller &&
        scrollerBounds &&
        clientX >= scrollerBounds.left &&
        clientX <= scrollerBounds.right &&
        clientY >= scrollerBounds.top &&
        clientY <= scrollerBounds.bottom
      ) {
        trackId = newLayerPreviewTrackId;
        startSeconds = snapTimelineSeconds(
          (scroller.scrollLeft + clientX - scrollerBounds.left - trackControlsWidth) /
            pixelsPerSecond,
        );
      }
      if (!trackId) {
        rowDragPreviewRef.current = null;
        setRowDragPreview(null);
        return;
      }
      if (snapEnabled) {
        startSeconds = snapClipToEdges(
          projectRef.current,
          draggedClip.id,
          startSeconds,
          draggedClip.durationSeconds,
          10 / pixelsPerSecond,
        ).startSeconds;
      }
      const preview = {
        clip: { ...draggedClip, startSeconds },
        trackId,
        startSeconds,
        valid:
          trackId === newLayerPreviewTrackId ||
          canPlaceClip(
            projectRef.current,
            draggedClip.id,
            trackId,
            startSeconds,
            draggedClip.durationSeconds,
          ),
      };
      rowDragPreviewRef.current = preview;
      setRowDragPreview(preview);
    };
    const start = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          asset?: Extract<BrowseRow, { kind: "asset" }>;
          processing?: AssemblyClipProcessing;
          x: number;
          y: number;
        }>
      ).detail;
      if (!detail?.asset) return;
      draggedSource = "row";
      draggedClip = createClip(detail.asset, null, 0, detail.processing);
      setAssemblyInternalDragActive(true);
      updatePreview(detail.x, detail.y);
    };
    const startRegion = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          asset?: Extract<BrowseRow, { kind: "asset" }>;
          region?: WaveformRegion;
          processing?: AssemblyClipProcessing;
          fadeInSeconds?: number;
          fadeOutSeconds?: number;
          x: number;
          y: number;
        }>
      ).detail;
      if (!detail?.asset || !detail.region) return;
      draggedSource = "region";
      const clip = createClip(detail.asset, detail.region, 0, detail.processing);
      draggedClip = {
        ...clip,
        fadeInSeconds: Math.min(
          clip.durationSeconds,
          Math.max(0, detail.fadeInSeconds ?? 0),
        ),
        fadeOutSeconds: Math.min(
          clip.durationSeconds,
          Math.max(0, detail.fadeOutSeconds ?? 0),
        ),
      };
      setAssemblyInternalDragActive(true);
      updatePreview(detail.x, detail.y);
    };
    const move = (event: Event) => {
      const detail = (event as CustomEvent<{ x: number; y: number }>).detail;
      updatePreview(detail.x, detail.y);
    };
    const end = () => {
      const preview = rowDragPreviewRef.current;
      if (preview?.valid) {
        let targetTrackId = preview.trackId;
        setProject((current) => {
          let base = current;
          if (targetTrackId === newLayerPreviewTrackId) {
            const track = createTrack(current.tracks.length);
            targetTrackId = track.id;
            base = { ...current, tracks: [...current.tracks, track] };
          }
          return addClipToTrack(base, targetTrackId, preview.clip);
        });
        setSelectedTrackId(targetTrackId);
        setSelectedClipIds(new Set([preview.clip.id]));
        setStatus(
          draggedSource === "region"
            ? "Waveform region added to Assembler."
            : "Sound added to Assembler.",
        );
      }
      draggedClip = null;
      rowDragPreviewRef.current = null;
      setRowDragPreview(null);
      setAssemblyInternalDragActive(false);
    };
    const cancel = () => {
      draggedClip = null;
      rowDragPreviewRef.current = null;
      setRowDragPreview(null);
      setAssemblyInternalDragActive(false);
      setStatus("Drag cancelled.");
    };
    window.addEventListener("sonilabs:assembly-row-drag-start", start);
    window.addEventListener("sonilabs:assembly-row-drag-move", move);
    window.addEventListener("sonilabs:assembly-row-drag-end", end);
    window.addEventListener("sonilabs:assembly-row-drag-cancel", cancel);
    window.addEventListener("sonilabs:assembly-region-drag-start", startRegion);
    window.addEventListener("sonilabs:assembly-region-drag-move", move);
    window.addEventListener("sonilabs:assembly-region-drag-end", end);
    window.addEventListener("sonilabs:assembly-region-drag-cancel", cancel);
    return () => {
      window.removeEventListener("sonilabs:assembly-row-drag-start", start);
      window.removeEventListener("sonilabs:assembly-row-drag-move", move);
      window.removeEventListener("sonilabs:assembly-row-drag-end", end);
      window.removeEventListener("sonilabs:assembly-row-drag-cancel", cancel);
      window.removeEventListener("sonilabs:assembly-region-drag-start", startRegion);
      window.removeEventListener("sonilabs:assembly-region-drag-move", move);
      window.removeEventListener("sonilabs:assembly-region-drag-end", end);
      window.removeEventListener("sonilabs:assembly-region-drag-cancel", cancel);
    };
  }, [pixelsPerSecond, setProject, snapEnabled, trackControlsWidth]);

  useEffect(() => {
    const openProject = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail
        ?.projectId;
      const stored = readAssemblyProjects();
      const next =
        projectId && stored.projects.some((item) => item.id === projectId)
          ? { ...stored, activeProjectId: projectId }
          : stored;
      const active =
        next.projects.find((item) => item.id === next.activeProjectId) ??
        next.projects[0];
      setProjectsState(next);
      if (active) projectRef.current = active;
      setSelectedClipIds(new Set());
      setSelectedTrackId(active?.tracks[0]?.id ?? null);
    };
    const createProject = () => {
      const created = createAssemblyProject();
      setProjectsState((current) => ({
        ...current,
        activeProjectId: created.id,
        projectFolderIds: { ...current.projectFolderIds, [created.id]: null },
        projects: [
          ...current.projects,
          { ...created, name: `Assembly ${current.projects.length + 1}` },
        ],
      }));
      setSelectedClipIds(new Set());
      setSelectedTrackId(created.tracks[0]?.id ?? null);
      setStatus("New assembly project created.");
    };
    const deleteProject = (event: Event) => {
      const projectId = (event as CustomEvent<{ projectId?: string }>).detail
        ?.projectId;
      if (!projectId) return;
      setProjectsState((current) => {
        const remaining = current.projects.filter((item) => item.id !== projectId);
        const projects = remaining.length ? remaining : [createAssemblyProject()];
        const projectFolderIds = Object.fromEntries(
          projects.map((project) => [
            project.id,
            current.projectFolderIds[project.id] ?? null,
          ]),
        );
        return {
          ...current,
          activeProjectId:
            current.activeProjectId === projectId
              ? projects[0].id
              : current.activeProjectId,
          projects,
          projectFolderIds,
        };
      });
      setStatus("Assembly project deleted.");
    };
    const renameProject = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; name?: string }>).detail;
      if (!detail?.projectId || !detail.name?.trim()) return;
      setProjectsState((current) => ({
        ...current,
        projects: current.projects.map((item) =>
          item.id === detail.projectId ? { ...item, name: detail.name!.trim() } : item,
        ),
      }));
    };
    window.addEventListener(assemblyProjectOpenEvent, openProject);
    window.addEventListener(assemblyProjectCreateEvent, createProject);
    window.addEventListener(assemblyProjectDeleteEvent, deleteProject);
    window.addEventListener(assemblyProjectRenameEvent, renameProject);
    return () => {
      window.removeEventListener(assemblyProjectOpenEvent, openProject);
      window.removeEventListener(assemblyProjectCreateEvent, createProject);
      window.removeEventListener(assemblyProjectDeleteEvent, deleteProject);
      window.removeEventListener(assemblyProjectRenameEvent, renameProject);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const missingAssetIds = projectAssetIds.filter(
      (assetId) => !waveformsByAssetId[assetId],
    );
    if (missingAssetIds.length === 0) return;

    void Promise.all(
      missingAssetIds.map(async (assetId) => {
        const asset = assetRows.get(assetId);
        const resolution = await resolvePreviewFile(assetId, "original");
        const durationSeconds =
          asset?.durationSeconds ?? resolution.durationSeconds ?? 1;
        const sampleRate = asset?.sampleRate ?? 48_000;
        const samplesPerPeak = Math.max(
          1,
          Math.floor((durationSeconds * sampleRate) / 4096),
        );
        const cached = await getCachedWaveformPeaks(
          assetId,
          resolution.contentKey,
          "source",
          samplesPerPeak,
        );
        return [
          assetId,
          cached ??
            (await getWaveformPeaks(
              assetId,
              resolution.contentKey,
              "source",
              samplesPerPeak,
            )),
        ] as const;
      }),
    )
      .then((entries) => {
        if (cancelled) return;
        setWaveformsByAssetId((current) => ({
          ...current,
          ...Object.fromEntries(entries),
        }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [assetRows, projectAssetIds, waveformsByAssetId]);

  const cancelPlayheadFrame = useCallback(() => {
    if (playheadFrameRef.current !== null) {
      window.cancelAnimationFrame(playheadFrameRef.current);
      playheadFrameRef.current = null;
    }
  }, []);

  const tickPlayhead = useCallback(() => {
    const tick = () => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;
      setPlayheadSeconds(audio.currentTime);
      playheadFrameRef.current = window.requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const stopPlayback = useCallback(
    (nextStatus = "Stopped.") => {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
      }
      cancelPlayheadFrame();
      setPlaying(false);
      setPlayheadSeconds(0);
      setStatus(nextStatus);
    },
    [cancelPlayheadFrame],
  );

  useEffect(
    () => () => {
      stopPlayback("");
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    },
    [stopPlayback],
  );

  useEffect(() => {
    if (!previewCacheRef.current || previewCacheRef.current.key === projectKey) return;
    stopPlayback("");
    URL.revokeObjectURL(previewCacheRef.current.url);
    previewCacheRef.current = null;
    audioUrlRef.current = null;
    audioRef.current = null;
  }, [projectKey, stopPlayback]);

  const preparePreviewUrl = useCallback(async () => {
    if (previewCacheRef.current?.key === projectKey) {
      return previewCacheRef.current.url;
    }
    if (previewRenderRef.current?.key === projectKey) {
      return previewRenderRef.current.promise;
    }
    const promise = renderAssemblyWav(project)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        if (latestProjectKeyRef.current !== projectKey) {
          URL.revokeObjectURL(url);
          throw new Error("Assembly changed while preparing preview.");
        }
        if (previewCacheRef.current) {
          URL.revokeObjectURL(previewCacheRef.current.url);
        }
        previewCacheRef.current = { key: projectKey, url };
        audioUrlRef.current = url;
        audioRef.current = null;
        return url;
      })
      .finally(() => {
        if (previewRenderRef.current?.key === projectKey) {
          previewRenderRef.current = null;
        }
      });
    previewRenderRef.current = { key: projectKey, promise };
    return promise;
  }, [project, projectKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void preparePreviewUrl().catch(() => undefined);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [preparePreviewUrl]);

  const ensurePreviewAudio = useCallback(async () => {
    if (!previewCacheRef.current || previewCacheRef.current.key !== projectKey) {
      setRendering(true);
      setStatus("Rendering preview...");
      await preparePreviewUrl();
    }

    if (!audioRef.current) {
      const previewUrl = previewCacheRef.current?.url;
      if (!previewUrl) throw new Error("Assembly preview is unavailable.");
      const audio = new Audio(previewUrl);
      audio.onended = () => {
        cancelPlayheadFrame();
        setPlaying(false);
        setPlayheadSeconds(0);
        setStatus("Preview finished.");
      };
      audioRef.current = audio;
    }
    return audioRef.current;
  }, [cancelPlayheadFrame, preparePreviewUrl, projectKey]);

  const togglePlayback = useCallback(async () => {
    if (rendering) return;
    const currentAudio = audioRef.current;
    if (currentAudio && !currentAudio.paused) {
      currentAudio.pause();
      cancelPlayheadFrame();
      setPlaying(false);
      setPlayheadSeconds(currentAudio.currentTime);
      setStatus("Paused.");
      return;
    }
    try {
      const audio = await ensurePreviewAudio();
      audio.currentTime = Math.min(playheadSeconds, Math.max(0, audio.duration || 0));
      await audio.play();
      setPlaying(true);
      setStatus("Playing assembly.");
      tickPlayhead();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Preview render failed.");
    } finally {
      setRendering(false);
    }
  }, [
    cancelPlayheadFrame,
    ensurePreviewAudio,
    playheadSeconds,
    rendering,
    tickPlayhead,
  ]);

  const exportProject = useCallback(async () => {
    if (rendering) return;
    setRendering(true);
    setStatus(`Rendering ${exportSettings.format.toUpperCase()}...`);
    try {
      const bytes = await renderAssemblyWav(project);
      const prepared = await prepareAssemblyExport(
        project.name,
        bytes,
        exportSettings.format,
        exportSettings.formatSettings,
        exportSettings.tempFolder,
      );
      if (!prepared) {
        if (exportSettings.format.toLowerCase() !== "wav") {
          throw new Error("Selected-format assembly export requires Tauri.");
        }
        const path = await saveAssemblyWav(project.name, bytes);
        setStatus(path ? `Exported ${path}.` : "Export cancelled.");
        return;
      }
      const path = await savePreparedAssemblyExport(
        project.name,
        prepared,
        exportSettings.format,
      );
      await deletePreparedDragFiles([prepared.path]);
      setStatus(path ? `Exported ${path}.` : "Export cancelled.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Assembly export failed.");
    } finally {
      setRendering(false);
    }
  }, [exportSettings, project, rendering]);

  const dragProjectExport = useCallback(
    (event: React.DragEvent<HTMLButtonElement>) => {
      event.preventDefault();
      if (rendering) return;
      const format = exportSettings.format.toUpperCase();
      setRendering(true);
      setPreparedExportDrag({
        phase: "rendering",
        label: `${project.name}.${format.toLowerCase()}`,
      });
      setStatus(`Rendering ${format} for drag...`);
      void (async () => {
        try {
          const bytes = await renderAssemblyWav(project);
          const prepared = await prepareAssemblyExport(
            project.name,
            bytes,
            exportSettings.format,
            exportSettings.formatSettings,
            exportSettings.tempFolder,
          );
          if (!prepared) {
            throw new Error("Assembly drag-to-export requires Tauri.");
          }
          setPreparedExportDrag({
            phase: "ready",
            label: prepared.path.split(/[\\/]/).pop() ?? `${project.name}.${format.toLowerCase()}`,
          });
          setStatus(`${format} ready. Drop it into the destination.`);
          await new Promise<void>((resolve) =>
            window.requestAnimationFrame(() => resolve()),
          );
          const nativeDrag = await startPreparedFilesDrag([prepared.path], {
            preferNative: true,
          });
          if (!nativeDrag.ok || nativeDrag.effect !== "copy") {
            if (nativeDrag.effect === "none") {
              await deletePreparedDragFiles([prepared.path]);
            }
            setStatus(nativeDrag.error ?? "Assembly export drag cancelled.");
            return;
          }
          setStatus(`Dragged ${format} assembly export.`);
        } catch (error) {
          setStatus(
            error instanceof Error ? error.message : "Assembly export drag failed.",
          );
        } finally {
          setPreparedExportDrag(null);
          setRendering(false);
        }
      })();
    },
    [exportSettings, project, rendering],
  );

  const updateTrack = useCallback(
    (trackId: string, update: Partial<AssemblyTrack>) =>
      setProject((current) => ({
        ...current,
        tracks: current.tracks.map((track) =>
          track.id === trackId ? { ...track, ...update } : track,
        ),
      })),
    [setProject],
  );

  const removeSelectedClips = useCallback(() => {
    if (selectedClipIds.size === 0) return;
    const count = selectedClipIds.size;
    setProject((current) => removeClips(current, selectedClipIds));
    setSelectedClipIds(new Set());
    setStatus(`${count} ${count === 1 ? "clip" : "clips"} deleted.`);
  }, [selectedClipIds, setProject]);

  const removeTimelineTrack = useCallback((trackId: string) => {
    setProject((current) => removeTrack(current, trackId));
    setSelectedClipIds(new Set());
    setSelectedTrackId((current) => (current === trackId ? null : current));
    setMenu(null);
    setStatus("Layer deleted.");
  }, [setProject]);

  const addLayer = useCallback(() => {
    const track = createTrack(project.tracks.length);
    setProject((current) => ({ ...current, tracks: [...current.tracks, track] }));
    setSelectedTrackId(track.id);
    setStatus("Layer added.");
  }, [project.tracks.length, setProject]);

  const selectTrackClips = useCallback(
    (trackId: string | null) => {
      const track =
        project.tracks.find((candidate) => candidate.id === trackId) ??
        project.tracks.find((candidate) =>
          candidate.clips.some((clip) => selectedClipIds.has(clip.id)),
        ) ??
        project.tracks[0];
      if (!track) return;
      setSelectedTrackId(track.id);
      setSelectedClipIds(new Set(track.clips.map((clip) => clip.id)));
      setStatus(
        track.clips.length
          ? `${track.name} selected.`
          : `${track.name} has no clips.`,
      );
    },
    [project.tracks, selectedClipIds],
  );

  const selectCurrentClipRegion = useCallback(() => {
    const selectedClip = project.tracks
      .flatMap((track) => track.clips)
      .find((clip) => selectedClipIds.has(clip.id));
    const selectedTrack =
      project.tracks.find((track) => track.id === selectedTrackId) ??
      project.tracks[0];
    const playheadClip = selectedTrack?.clips.find(
      (clip) =>
        playheadSeconds >= clip.startSeconds &&
        playheadSeconds <= clip.startSeconds + clip.durationSeconds,
    );
    const clip = selectedClip ?? playheadClip ?? selectedTrack?.clips[0];
    if (!clip) {
      setStatus("No clip region to select.");
      return;
    }
    setSelectedClipIds(new Set([clip.id]));
    setStatus("Clip region selected.");
  }, [playheadSeconds, project.tracks, selectedClipIds, selectedTrackId]);

  const copySelection = useCallback(() => {
    const selected = project.tracks
      .flatMap((track) => track.clips)
      .filter((clip) => selectedClipIds.has(clip.id));
    const track = project.tracks.find((item) => item.id === selectedTrackId);
    const clips = selected.length ? selected : (track?.clips ?? []);
    copiedClipsRef.current = clips.map((clip) => ({ ...clip }));
    setStatus(
      clips.length
        ? `${clips.length} ${clips.length === 1 ? "clip" : "clips"} copied.`
        : "Nothing to copy on the selected layer.",
    );
  }, [project.tracks, selectedClipIds, selectedTrackId]);

  const pasteSelection = useCallback(() => {
    const copied = copiedClipsRef.current;
    const targetTrack =
      project.tracks.find((track) => track.id === selectedTrackId) ??
      project.tracks[0];
    if (!copied.length || !targetTrack) {
      setStatus("Copy a clip or layer before pasting.");
      return;
    }
    const earliestStart = Math.min(...copied.map((clip) => clip.startSeconds));
    const first = copied.reduce((earliest, clip) =>
      clip.startSeconds < earliest.startSeconds ? clip : earliest,
    );
    const snapped = snapEnabled
      ? snapClipToEdges(
          project,
          "",
          playheadSeconds,
          first.durationSeconds,
          10 / pixelsPerSecond,
        ).startSeconds
      : playheadSeconds;
    const duplicates = copied.map((clip) =>
      duplicateClip(clip, snapped + clip.startSeconds - earliestStart),
    );
    const addedIds: string[] = [];
    setProject((current) => {
      let next = current;
      for (const clip of duplicates) {
        const candidate = addClipToTrack(next, targetTrack.id, clip);
        if (candidate !== next) addedIds.push(clip.id);
        next = candidate;
      }
      return next;
    });
    setSelectedClipIds(new Set(addedIds));
    setStatus(
      addedIds.length
        ? `${addedIds.length} ${addedIds.length === 1 ? "clip" : "clips"} pasted.`
        : "Paste overlaps an existing clip; paste cancelled.",
    );
  }, [pixelsPerSecond, playheadSeconds, project, selectedTrackId, setProject, snapEnabled]);

  const addClipsToTrack = useCallback(
    (
      trackId: string,
      clips: AssemblyClip[],
      message: string,
      projectOverride?: AssemblyProject,
    ) => {
      const addedClipIds: string[] = [];
      setProject((current) => {
        let nextProject = projectOverride ?? current;
        for (const clip of clips) {
          const candidate = addClipToTrack(nextProject, trackId, clip);
          if (candidate !== nextProject) addedClipIds.push(clip.id);
          nextProject = candidate;
        }
        return nextProject;
      });
      setSelectedTrackId(trackId);
      setSelectedClipIds(new Set(addedClipIds));
      setStatus(
        addedClipIds.length
          ? message
          : "Clip overlaps another clip; drop cancelled.",
      );
    },
    [setProject],
  );

  const dropOnTrack = useCallback(
    (event: React.DragEvent<HTMLDivElement>, trackId: string) => {
      event.preventDefault();
      event.stopPropagation();
      setAssemblyInternalDragActive(false);
      setMenu(null);
      const bounds = event.currentTarget.getBoundingClientRect();
      let startSeconds = snapTimelineSeconds(
        (event.clientX - bounds.left) / pixelsPerSecond,
      );
      const movingClipId = event.dataTransfer.getData(clipDragType);
      if (movingClipId) {
        setProject((current) => moveClip(current, movingClipId, trackId, startSeconds));
        setSelectedTrackId(trackId);
        setSelectedClipIds(new Set([movingClipId]));
        setStatus("Clip moved.");
        return;
      }
      const assets = assetsForDrag(event.dataTransfer);
      if (!assets.length) {
        setStatus("Drop rows or waveform regions into Assembler.");
        return;
      }
      if (snapEnabled) {
        const snapped = snapClipToEdges(
          projectRef.current,
          "",
          startSeconds,
          assets[0]?.durationSeconds ?? 1,
          10 / pixelsPerSecond,
        );
        startSeconds = snapped.startSeconds;
        setSnapGuideSeconds(null);
      }
      let cursor = startSeconds;
      const clips = assets.map((asset) => {
        const clip = createClip(asset, null, cursor);
        cursor += clip.durationSeconds;
        return clip;
      });
      addClipsToTrack(
        trackId,
        clips,
        `${clips.length} ${clips.length === 1 ? "sound" : "sounds"} added.`,
      );
    },
    [addClipsToTrack, assetsForDrag, pixelsPerSecond, setProject, snapEnabled],
  );

  const dropOnNewLayer = useCallback(
    (event: React.DragEvent<HTMLDivElement>, startSeconds = 0) => {
      event.preventDefault();
      event.stopPropagation();
      setAssemblyInternalDragActive(false);
      const track = createTrack(project.tracks.length);
      const movingClipId = event.dataTransfer.getData(clipDragType);
      if (movingClipId) {
        setProject((current) =>
          moveClip(
            { ...current, tracks: [...current.tracks, track] },
            movingClipId,
            track.id,
            startSeconds,
          ),
        );
        setSelectedTrackId(track.id);
        setSelectedClipIds(new Set([movingClipId]));
        setStatus("Clip moved to a new layer.");
        return;
      }
      const assets = assetsForDrag(event.dataTransfer);
      if (!assets.length) {
        addLayer();
        return;
      }
      let cursor = startSeconds;
      const clips = assets.map((asset) => {
        const clip = createClip(asset, null, cursor);
        cursor += clip.durationSeconds;
        return clip;
      });
      addClipsToTrack(
        track.id,
        clips,
        `${clips.length} ${clips.length === 1 ? "sound" : "sounds"} added to a new layer.`,
        { ...project, tracks: [...project.tracks, track] },
      );
    },
    [addClipsToTrack, addLayer, assetsForDrag, project, setProject],
  );

  const beginClipResize = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      clipId: string,
      edge: "start" | "end",
    ) => {
      event.preventDefault();
      event.stopPropagation();
      const clip = project.tracks
        .flatMap((track) => track.clips)
        .find((candidate) => candidate.id === clipId);
      resizeRef.current = {
        clipId,
        edge,
        startClientX: event.clientX,
        lastDeltaSeconds: 0,
        sourceDurationSeconds: clip
          ? (assetRows.get(clip.assetId)?.durationSeconds ?? undefined)
          : undefined,
      };
      gestureBaseProjectRef.current = projectRef.current;
      setAssemblyInternalDragActive(true);
      setSelectedClipIds(new Set([clipId]));
      setStatus(edge === "start" ? "Trimming clip start." : "Trimming clip end.");
    },
    [assetRows, project.tracks],
  );

  const beginClipMove = useCallback(
    (event: React.PointerEvent<HTMLElement>, clip: AssemblyClip, trackId: string) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      moveRef.current = {
        clipId: clip.id,
        startClientX: event.clientX,
        startSeconds: clip.startSeconds,
        preview: null,
        moved: false,
      };
      setDragPreview(null);
      setSelectedTrackId(trackId);
      setSelectedClipIds(new Set([clip.id]));
      setAssemblyInternalDragActive(true);
      setStatus("Move clip. Release over any layer.");
    },
    [],
  );

  const beginFadeEdit = useCallback(
    (
      event: React.PointerEvent<HTMLElement>,
      clip: AssemblyClip,
      edge: "in" | "out",
    ) => {
      event.preventDefault();
      event.stopPropagation();
      fadeRef.current = {
        clipId: clip.id,
        edge,
        startClientX: event.clientX,
        startFadeSeconds:
          edge === "in" ? clip.fadeInSeconds ?? 0 : clip.fadeOutSeconds ?? 0,
      };
      gestureBaseProjectRef.current = projectRef.current;
      setSelectedClipIds(new Set([clip.id]));
      setAssemblyInternalDragActive(true);
      setStatus(edge === "in" ? "Adjusting fade in." : "Adjusting fade out.");
    },
    [],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = resizeRef.current;
      if (resize) {
        const totalDeltaSeconds = snapDeltaSeconds(
          (event.clientX - resize.startClientX) / pixelsPerSecond,
        );
        const deltaSeconds = totalDeltaSeconds - resize.lastDeltaSeconds;
        if (Math.abs(deltaSeconds) < 0.0001) return;
        resize.lastDeltaSeconds = totalDeltaSeconds;
        setProjectTransient((current) => {
          const next = trimClip(
            current,
            resize.clipId,
            resize.edge,
            deltaSeconds,
            resize.sourceDurationSeconds,
          );
          const location = next.tracks
            .map((track) => ({
              trackId: track.id,
              clip: track.clips.find((clip) => clip.id === resize.clipId),
            }))
            .find((item) => item.clip);
          return location?.clip &&
            canPlaceClip(
              next,
              location.clip.id,
              location.trackId,
              location.clip.startSeconds,
              location.clip.durationSeconds,
            )
            ? next
            : current;
        });
        return;
      }
      const fade = fadeRef.current;
      if (fade) {
        const deltaSeconds = snapDeltaSeconds(
          (event.clientX - fade.startClientX) / pixelsPerSecond,
        );
        setProjectTransient((current) => {
          const clip = current.tracks
            .flatMap((track) => track.clips)
            .find((candidate) => candidate.id === fade.clipId);
          if (!clip) return current;
          const otherFade =
            fade.edge === "in" ? clip.fadeOutSeconds ?? 0 : clip.fadeInSeconds ?? 0;
          const direction = fade.edge === "in" ? 1 : -1;
          const value = Math.max(
            0,
            Math.min(
              clip.durationSeconds - otherFade,
              fade.startFadeSeconds + deltaSeconds * direction,
            ),
          );
          return updateClip(current, fade.clipId, {
            [fade.edge === "in" ? "fadeInSeconds" : "fadeOutSeconds"]: value,
          });
        });
        return;
      }
      const move = moveRef.current;
      if (!move) return;
      const deltaSeconds = snapDeltaSeconds(
        (event.clientX - move.startClientX) / pixelsPerSecond,
      );
      if (Math.abs(event.clientX - move.startClientX) > 3) move.moved = true;
      const targetTrackId = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-assembly-track-id]")?.dataset
        .assemblyTrackId;
      if (!targetTrackId) {
        const scroller = timelineScrollRef.current;
        const bounds = scroller?.getBoundingClientRect();
        if (
          scroller &&
          bounds &&
          event.clientX >= bounds.left &&
          event.clientX <= bounds.right &&
          event.clientY >= bounds.top &&
          event.clientY <= bounds.bottom
        ) {
          let startSeconds = snapTimelineSeconds(
            (scroller.scrollLeft + event.clientX - bounds.left - trackControlsWidth) /
              pixelsPerSecond,
          );
          if (snapEnabled) {
            const movingClip = projectRef.current.tracks
              .flatMap((track) => track.clips)
              .find((clip) => clip.id === move.clipId);
            if (movingClip) {
              const snapped = snapClipToEdges(
                projectRef.current,
                move.clipId,
                startSeconds,
                movingClip.durationSeconds,
                10 / pixelsPerSecond,
              );
              startSeconds = snapped.startSeconds;
              setSnapGuideSeconds(snapped.guideSeconds);
            }
          } else setSnapGuideSeconds(null);
          const preview = {
            clipId: move.clipId,
            trackId: newLayerPreviewTrackId,
            startSeconds,
            valid: true,
          };
          move.preview = preview;
          setDragPreview(preview);
        } else {
          move.preview = null;
          setDragPreview(null);
        }
        return;
      }
      let startSeconds = snapTimelineSeconds(move.startSeconds + deltaSeconds);
      if (snapEnabled) {
        const movingClip = projectRef.current.tracks
          .flatMap((track) => track.clips)
          .find((clip) => clip.id === move.clipId);
        if (movingClip) {
          const snapped = snapClipToEdges(
            projectRef.current,
            move.clipId,
            startSeconds,
            movingClip.durationSeconds,
            10 / pixelsPerSecond,
          );
          startSeconds = snapped.startSeconds;
          setSnapGuideSeconds(snapped.guideSeconds);
        }
      } else setSnapGuideSeconds(null);
      const preview = {
        clipId: move.clipId,
        trackId: targetTrackId,
        startSeconds,
        valid: canPlaceClip(
          projectRef.current,
          move.clipId,
          targetTrackId,
          startSeconds,
        ),
      };
      move.preview = preview;
      setDragPreview(preview);
    };
    const handlePointerUp = () => {
      if (resizeRef.current) {
        commitGestureHistory();
        setStatus("Clip resized.");
      }
      if (fadeRef.current) {
        commitGestureHistory();
        setStatus("Clip fade updated.");
      }
      if (moveRef.current) {
        const move = moveRef.current;
        if (move.preview?.valid) {
          let selectedTargetTrackId = move.preview.trackId;
          setProject((current) => {
            if (move.preview!.trackId === newLayerPreviewTrackId) {
              const track = createTrack(current.tracks.length);
              selectedTargetTrackId = track.id;
              return moveClip(
                { ...current, tracks: [...current.tracks, track] },
                move.clipId,
                track.id,
                move.preview!.startSeconds,
              );
            }
            return moveClip(
              current,
              move.clipId,
              move.preview!.trackId,
              move.preview!.startSeconds,
            );
          });
          setSelectedTrackId(selectedTargetTrackId);
        }
        suppressClipClickRef.current = move.moved;
        setStatus(
          !move.moved
            ? "Clip selected."
            : move.preview?.valid
              ? "Clip moved."
              : "Clip overlaps another clip; move cancelled.",
        );
      }
      resizeRef.current = null;
      fadeRef.current = null;
      moveRef.current = null;
      setDragPreview(null);
      setSnapGuideSeconds(null);
      setAssemblyInternalDragActive(false);
    };
    window.addEventListener("pointermove", handlePointerMove, true);
    window.addEventListener("pointerup", handlePointerUp, true);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, true);
      window.removeEventListener("pointerup", handlePointerUp, true);
      setAssemblyInternalDragActive(false);
    };
  }, [commitGestureHistory, pixelsPerSecond, setProject, setProjectTransient, snapEnabled, trackControlsWidth]);

  useEffect(() => {
    const closeMenu = (event: Event) => {
      if ((event.target as HTMLElement | null)?.closest("[data-assembly-menu]")) {
        return;
      }
      setMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shortcutTargetIsEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "c") {
        event.preventDefault();
        event.stopPropagation();
        copySelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "v") {
        event.preventDefault();
        event.stopPropagation();
        pasteSelection();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        event.stopPropagation();
        redo();
        return;
      }
      if (event.shiftKey && (event.key === " " || key === "v")) {
        event.preventDefault();
        event.stopPropagation();
        void togglePlayback();
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        event.stopPropagation();
        if (selectedClipIds.size > 0) {
          removeSelectedClips();
        } else if (selectedTrackId) {
          removeTimelineTrack(selectedTrackId);
        }
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "r") {
        if (selectedClip) {
          event.preventDefault();
          event.stopPropagation();
          toggleSelectedClipReverse();
        }
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && key === "a") {
        event.preventDefault();
        event.stopPropagation();
        selectCurrentClipRegion();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "a") {
        event.preventDefault();
        event.stopPropagation();
        selectCurrentClipRegion();
        return;
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        setPlayheadSeconds((current) =>
          snapTimelineSeconds(
            current + (event.key === "ArrowLeft" ? -0.05 : 0.05),
          ),
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [
    project.tracks,
    copySelection,
    pasteSelection,
    removeSelectedClips,
    removeTimelineTrack,
    redo,
    selectCurrentClipRegion,
    selectTrackClips,
    selectedClipIds,
    selectedClip,
    selectedTrackId,
    togglePlayback,
    toggleSelectedClipReverse,
    undo,
  ]);

  const rulerMarks = useMemo(() => {
    const interval = zoom >= 4 ? 0.1 : zoom >= 1.5 ? 0.5 : zoom < 0.75 ? 2 : 1;
    return Array.from(
      { length: Math.floor(durationSeconds / interval) + 1 },
      (_, index) => index * interval,
    );
  }, [durationSeconds, zoom]);

  const handleTimelineWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const scroller = event.currentTarget;
      const bounds = scroller.getBoundingClientRect();
      const cursorX = event.clientX - bounds.left;
      const timelineSeconds = Math.max(
        0,
        (scroller.scrollLeft + cursorX - trackControlsWidth) / pixelsPerSecond,
      );
      const direction = event.deltaY < 0 ? 1.16 : 1 / 1.16;
      setZoom((current) => {
        const next = Math.max(0.25, Math.min(8, current * direction));
        window.requestAnimationFrame(() => {
          scroller.scrollLeft = Math.max(
            0,
            timelineSeconds * (46 * next) - cursorX + trackControlsWidth,
          );
        });
        return next;
      });
    },
    [pixelsPerSecond, trackControlsWidth],
  );

  const beginTimelinePan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      const scroller = event.currentTarget;
      scroller.setPointerCapture(event.pointerId);
      timelinePanRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: scroller.scrollLeft,
        startScrollTop: scroller.scrollTop,
      };
      setTimelinePanning(true);
    },
    [],
  );

  const moveTimelinePan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pan = timelinePanRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      event.preventDefault();
      event.currentTarget.scrollLeft =
        pan.startScrollLeft - (event.clientX - pan.startClientX);
      event.currentTarget.scrollTop =
        pan.startScrollTop - (event.clientY - pan.startClientY);
    },
    [],
  );

  const endTimelinePan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const pan = timelinePanRef.current;
      if (!pan || pan.pointerId !== event.pointerId) return;
      event.preventDefault();
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      timelinePanRef.current = null;
      setTimelinePanning(false);
    },
    [],
  );

  const beginMarquee = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest(
          "[data-assembly-clip], button, input, [data-assembly-track-controls]",
        )
      ) {
        return;
      }
      const state = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        initialSelection: event.shiftKey
          ? new Set(selectedClipIds)
          : new Set<string>(),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      marqueeRef.current = state;
      setMarquee(state);
      if (!event.shiftKey) setSelectedClipIds(new Set());
    },
    [selectedClipIds],
  );

  const moveMarquee = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const current = marqueeRef.current;
      if (!current) return;
      const next = {
        ...current,
        currentX: event.clientX,
        currentY: event.clientY,
      };
      marqueeRef.current = next;
      setMarquee(next);
      const left = Math.min(next.startX, next.currentX);
      const right = Math.max(next.startX, next.currentX);
      const top = Math.min(next.startY, next.currentY);
      const bottom = Math.max(next.startY, next.currentY);
      const selected = new Set(next.initialSelection);
      document.querySelectorAll<HTMLElement>("[data-assembly-clip-id]").forEach(
        (element) => {
          const bounds = element.getBoundingClientRect();
          if (
            bounds.right >= left &&
            bounds.left <= right &&
            bounds.bottom >= top &&
            bounds.top <= bottom
          ) {
            const clipId = element.dataset.assemblyClipId;
            if (clipId) selected.add(clipId);
          }
        },
      );
      setSelectedClipIds(selected);
    },
    [],
  );

  const endMarquee = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!marqueeRef.current) return;
      marqueeRef.current = null;
      setMarquee(null);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [],
  );

  const beginTrackControlsResize = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = trackControlsWidth;
      const move = (pointerEvent: PointerEvent) => {
        setTrackControlsWidth(
          Math.max(88, Math.min(280, startWidth + pointerEvent.clientX - startX)),
        );
      };
      const up = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", up, true);
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", up, true);
    },
    [trackControlsWidth],
  );

  const openClipSource = useCallback(
    (clip: AssemblyClip) => {
      onFocusSource?.(clip.assetId, {
        startSeconds: clip.sourceStartSeconds,
        endSeconds:
          clip.sourceStartSeconds +
          clip.durationSeconds * processingPlaybackRate(clip.processing),
      }, clip.sourceAsset ?? assetRows.get(clip.assetId));
      setStatus("Focused source in library.");
    },
    [assetRows, onFocusSource],
  );

  const openMenu = useCallback(
    (event: React.MouseEvent, nextMenu: TimelineMenuRequest) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu(
        nextMenu.kind === "clip"
          ? {
              kind: "clip",
              clipId: nextMenu.clipId,
              trackId: nextMenu.trackId,
              x: event.clientX,
              y: event.clientY,
            }
          : {
              kind: "track",
              trackId: nextMenu.trackId,
              x: event.clientX,
              y: event.clientY,
            },
      );
    },
    [],
  );

  const markInternalTimelineDrag = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (
        dataTransferHasType(event.dataTransfer.types, clipDragType) ||
        dataTransferHasType(event.dataTransfer.types, trackDragType) ||
        dataTransferHasType(event.dataTransfer.types, sonilabsAssetDragType)
      ) {
        setAssemblyInternalDragActive(true);
      }
    },
    [],
  );

  return (
    <aside
      className="relative z-30 col-start-3 row-span-2 row-start-1 mt-[52px] flex h-[calc(100%-52px)] min-h-0 min-w-0 flex-col border-l border-border bg-[#0d0e10] shadow-[-14px_0_40px_rgba(0,0,0,0.28)]"
      onDragEnter={markInternalTimelineDrag}
      onDragOver={markInternalTimelineDrag}
    >
      <div
        aria-label="Resize Assembler"
        className="absolute inset-y-0 left-0 z-40 w-2 -translate-x-1 cursor-col-resize bg-transparent transition hover:bg-cyan-300/35"
        onPointerDown={onResizeStart}
        role="separator"
        title="Resize Assembler"
      />
      <div className="flex h-[42px] shrink-0 items-center border-b border-border bg-panel px-2">
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-background/80 px-2">
          <Layers3 className="size-3.5 shrink-0 text-cyan-300" />
          <input
            aria-label="Assembly project name"
            className="min-w-0 flex-1 bg-transparent text-[12px] font-medium text-foreground outline-none"
            onChange={(event) =>
              setProject((current) => ({ ...current, name: event.target.value }))
            }
            value={project.name}
          />
          <span className="shrink-0 text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Project
          </span>
        </div>
        <Button
          className="ml-1 size-8 p-0"
          onClick={onClose}
          size="icon"
          title="Close Assembler"
          variant="ghost"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="flex h-[46px] shrink-0 items-center justify-between border-b border-border bg-black/35 px-2">
        <div className="flex items-center gap-1">
          <Button
            className="size-8 p-0"
            disabled={rendering}
            onClick={() => void togglePlayback()}
            size="icon"
            title={playing ? "Pause assembly" : "Play assembly"}
            variant="secondary"
          >
            {playing ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5 fill-current" />
            )}
          </Button>
          <Button
            className="size-8 p-0"
            onClick={() => stopPlayback()}
            size="icon"
            title="Stop"
            variant="ghost"
          >
            <Pause className="size-3.5" />
          </Button>
          <Button
            className="size-8 p-0"
            onClick={undo}
            size="icon"
            title="Undo (Ctrl+Z)"
            variant="ghost"
          >
            <Undo2 className="size-3.5" />
          </Button>
          <Button
            className="size-8 p-0"
            onClick={redo}
            size="icon"
            title="Redo (Ctrl+Shift+Z)"
            variant="ghost"
          >
            <Redo2 className="size-3.5" />
          </Button>
          <Button
            aria-pressed={snapEnabled}
            className={cn(
              "size-8 p-0",
              snapEnabled && "bg-cyan-300/20 text-cyan-200",
            )}
            onClick={() => setSnapEnabled((enabled) => !enabled)}
            size="icon"
            title={snapEnabled ? "Disable clip snapping" : "Enable clip snapping"}
            variant="ghost"
          >
            <Magnet className="size-3.5" />
          </Button>
          <span className="ml-1 min-w-12 font-mono text-[10px] text-muted-foreground">
            {formatSeconds(playheadSeconds)}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] uppercase tracking-wider text-muted-foreground">
            Zoom
          </span>
          <input
            aria-label="Timeline zoom"
            className="h-1 w-16 accent-cyan-300"
            max={8}
            min={0.25}
            onChange={(event) => setZoom(Number(event.target.value))}
            step={0.05}
            type="range"
            value={zoom}
          />
          <Button
            aria-pressed={clipInspectorOpen}
            className={cn(
              "ml-1 size-8 p-0",
              clipInspectorOpen && "bg-cyan-300/20 text-cyan-200",
            )}
            disabled={!selectedClip}
            onClick={() => setClipInspectorOpen((open) => !open)}
            size="icon"
            title={clipInspectorOpen ? "Close clip inspector" : "Open clip inspector"}
            variant="ghost"
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
          <Button
            className="size-8 p-0"
            disabled={selectedClipCount === 0}
            onClick={removeSelectedClips}
            size="icon"
            title="Delete selected clips"
            variant="ghost"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
      <div
        className={cn(
          "absolute inset-0 overflow-auto pb-10",
          timelinePanning && "cursor-grabbing select-none",
        )}
        onAuxClick={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setEmptyDropPreview(null);
            setSnapGuideSeconds(null);
          }
        }}
        onDragOver={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "[data-assembly-track-drop-zone]",
            ) ||
            dataTransferHasType(event.dataTransfer.types, trackDragType)
          ) {
            return;
          }
          const assets = assetsForDrag(event.dataTransfer);
          if (!assets.length) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
          const bounds = event.currentTarget.getBoundingClientRect();
          let startSeconds = snapTimelineSeconds(
            (event.currentTarget.scrollLeft +
              event.clientX -
              bounds.left -
              trackControlsWidth) /
              pixelsPerSecond,
          );
          const asset = assets[0];
          if (snapEnabled) {
            const snapped = snapClipToEdges(
              projectRef.current,
              "",
              startSeconds,
              asset.durationSeconds ?? 1,
              10 / pixelsPerSecond,
            );
            startSeconds = snapped.startSeconds;
            setSnapGuideSeconds(snapped.guideSeconds);
          }
          setEmptyDropPreview((current) =>
            current?.assetId === asset.id &&
            current.startSeconds === startSeconds
              ? current
              : createClip(asset, null, startSeconds),
          );
        }}
        onDrop={(event) => {
          if (
            (event.target as HTMLElement).closest(
              "[data-assembly-track-drop-zone]",
            ) ||
            dataTransferHasType(event.dataTransfer.types, trackDragType)
          ) {
            return;
          }
          if (!assetsForDrag(event.dataTransfer).length) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const startSeconds = emptyDropPreview?.startSeconds ?? snapTimelineSeconds(
            (event.currentTarget.scrollLeft +
              event.clientX -
              bounds.left -
              trackControlsWidth) /
              pixelsPerSecond,
          );
          setEmptyDropPreview(null);
          setSnapGuideSeconds(null);
          dropOnNewLayer(event, startSeconds);
        }}
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onPointerCancel={(event) => {
          endTimelinePan(event);
          endMarquee(event);
        }}
        onPointerDown={(event) => {
          beginTimelinePan(event);
          beginMarquee(event);
        }}
        onPointerMove={(event) => {
          moveTimelinePan(event);
          moveMarquee(event);
        }}
        onPointerUp={(event) => {
          endTimelinePan(event);
          endMarquee(event);
        }}
        onWheel={handleTimelineWheel}
        ref={timelineScrollRef}
      >
        <div
          className="relative"
          style={{ minWidth: `${contentWidth + trackControlsWidth}px` }}
        >
          <div className="sticky top-0 z-50 flex h-7 border-b border-border bg-[#121316]">
            <div
              className="sticky left-0 z-[70] flex shrink-0 items-center overflow-hidden border-r border-border bg-[#121316] px-1"
              style={{ width: trackControlsWidth }}
            >
              <Button
                className="h-6 w-full justify-start gap-1 px-1.5 text-[10px]"
                onClick={addLayer}
                size="sm"
                title="Add layer"
                variant="ghost"
              >
                <Plus className="size-3" />
                Layer
              </Button>
              <span
                aria-label="Resize layer controls"
                className="absolute inset-y-0 right-0 w-2 translate-x-1 cursor-col-resize hover:bg-cyan-300/35"
                onPointerDown={beginTrackControlsResize}
                role="separator"
                title="Drag to resize layer controls"
              />
            </div>
            <div className="relative" style={{ width: contentWidth }}>
              {rulerMarks.map((mark) => (
                <div
                  className="absolute inset-y-0 border-l border-border/70 pl-1 pt-1 font-mono text-[8px] text-muted-foreground"
                  key={mark}
                  style={{ left: mark * pixelsPerSecond }}
                >
                  {formatSeconds(mark)}
                </div>
              ))}
            </div>
          </div>

          {project.tracks.map((track, trackIndex) => (
            <div
              className={cn(
                "relative flex border-b border-border/80",
                selectedTrackId === track.id && "bg-cyan-300/[0.025]",
              )}
              key={track.id}
              onDragOver={(event) => {
                if (!dataTransferHasType(event.dataTransfer.types, trackDragType)) {
                  return;
                }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                const bounds = event.currentTarget.getBoundingClientRect();
                setTrackDropIndex(
                  event.clientY < bounds.top + bounds.height / 2
                    ? trackIndex
                    : trackIndex + 1,
                );
              }}
              onDrop={(event) => {
                const draggedTrackId = event.dataTransfer.getData(trackDragType);
                if (!draggedTrackId) return;
                event.preventDefault();
                event.stopPropagation();
                setAssemblyInternalDragActive(false);
                const insertionIndex = trackDropIndex ?? trackIndex;
                setProject((current) => {
                  const sourceIndex = current.tracks.findIndex(
                    (candidate) => candidate.id === draggedTrackId,
                  );
                  const targetIndex =
                    insertionIndex > sourceIndex
                      ? insertionIndex - 1
                      : insertionIndex;
                  return moveTrack(current, draggedTrackId, targetIndex);
                });
                setTrackDropIndex(null);
                setSelectedTrackId(draggedTrackId);
                setStatus("Layer reordered.");
              }}
              style={{ height: trackHeight }}
            >
              {trackDropIndex === trackIndex ? (
                <div className="pointer-events-none absolute inset-x-0 top-0 z-40 h-0.5 bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)]" />
              ) : null}
              {trackIndex === project.tracks.length - 1 &&
              trackDropIndex === project.tracks.length ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-0 z-40 h-0.5 bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.9)]" />
              ) : null}
              <div
                className="sticky left-0 z-[60] flex shrink-0 flex-col justify-between overflow-hidden border-r border-border bg-[#121316] px-1.5 py-1.5"
                data-assembly-track-controls
                onClick={() => setSelectedTrackId(track.id)}
                onContextMenu={(event) =>
                  openMenu(event, { kind: "track", trackId: track.id })
                }
                style={{ width: trackControlsWidth }}
              >
                <div className="flex min-w-0 items-center gap-1">
                  <span
                    className="cursor-grab text-muted-foreground/50 active:cursor-grabbing"
                    draggable
                    onDragStart={(event) => {
                      setAssemblyInternalDragActive(true);
                      event.dataTransfer.setData(trackDragType, track.id);
                      event.dataTransfer.effectAllowed = "move";
                      const controls = event.currentTarget.closest<HTMLElement>(
                        "[data-assembly-track-controls]",
                      );
                      if (controls) event.dataTransfer.setDragImage(controls, 18, 18);
                    }}
                    onDragEnd={() => {
                      setAssemblyInternalDragActive(false);
                      setTrackDropIndex(null);
                    }}
                    title="Drag to reorder layer"
                  >
                    <GripVertical className="size-3 shrink-0" />
                  </span>
                  <input
                    aria-label={`${track.name} name`}
                    className="min-w-0 flex-1 bg-transparent text-[10px] font-medium text-foreground outline-none"
                    onChange={(event) =>
                      updateTrack(track.id, { name: event.target.value })
                    }
                    value={track.name}
                  />
                </div>
                <div className="flex items-center gap-0.5">
                  <button
                    aria-label={`Mute ${track.name}`}
                    className={cn(
                      "flex size-5 items-center justify-center rounded text-[8px] font-bold",
                      track.muted
                        ? "bg-amber-400 text-black"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => updateTrack(track.id, { muted: !track.muted })}
                    type="button"
                  >
                    {track.muted ? (
                      <VolumeX className="size-3" />
                    ) : (
                      <Volume2 className="size-3" />
                    )}
                  </button>
                  <button
                    aria-label={`Solo ${track.name}`}
                    className={cn(
                      "size-5 rounded text-[8px] font-bold",
                      track.solo
                        ? "bg-cyan-300 text-black"
                        : "bg-muted text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => updateTrack(track.id, { solo: !track.solo })}
                    type="button"
                  >
                    S
                  </button>
                  <input
                    aria-label={`${track.name} gain`}
                    className="h-1 min-w-0 flex-1 accent-cyan-300"
                    max={2}
                    min={0}
                    onChange={(event) =>
                      updateTrack(track.id, { gain: Number(event.target.value) })
                    }
                    step={0.05}
                    title="Layer gain"
                    type="range"
                    value={track.gain}
                  />
                </div>
              </div>
              <div
                className="isolate relative overflow-hidden bg-[linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)]"
                data-assembly-pixels-per-second={pixelsPerSecond}
                data-assembly-track-drop-zone
                data-assembly-track-id={track.id}
                onDragOver={(event) => {
                  if (
                    dataTransferHasType(event.dataTransfer.types, trackDragType)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = dataTransferHasType(
                    event.dataTransfer.types,
                    clipDragType,
                  )
                    ? "move"
                    : "copy";
                }}
                onDrop={(event) => {
                  if (
                    dataTransferHasType(event.dataTransfer.types, trackDragType)
                  ) {
                    return;
                  }
                  dropOnTrack(event, track.id);
                }}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).closest("[data-assembly-clip]"))
                    return;
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setPlayheadSeconds(
                    snapTimelineSeconds(
                      (event.clientX - bounds.left) / pixelsPerSecond,
                    ),
                  );
                  setSelectedTrackId(track.id);
                  setSelectedClipIds(new Set());
                }}
                style={{
                  backgroundSize: `${pixelsPerSecond}px 100%`,
                  width: contentWidth,
                }}
              >
                {track.clips.map((clip) => (
                  <button
                    className={cn(
                      "group absolute bottom-1.5 top-1.5 isolate z-10 overflow-hidden rounded border px-1 text-left shadow-sm transition",
                      clipColors[clip.colorIndex % clipColors.length],
                      selectedClipIds.has(clip.id) &&
                        "z-20 ring-1 ring-white ring-offset-1 ring-offset-black",
                    )}
                    data-assembly-clip
                    data-assembly-clip-id={clip.id}
                    key={clip.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (suppressClipClickRef.current) {
                        suppressClipClickRef.current = false;
                        return;
                      }
                      setSelectedTrackId(track.id);
                      setSelectedClipIds((current) => {
                        if (event.shiftKey) {
                          const next = new Set(current);
                          if (next.has(clip.id)) next.delete(clip.id);
                          else next.add(clip.id);
                          return next;
                        }
                        return new Set([clip.id]);
                      });
                    }}
                    onContextMenu={(event) => {
                      setSelectedTrackId(track.id);
                      setSelectedClipIds(new Set([clip.id]));
                      openMenu(event, {
                        kind: "clip",
                        clipId: clip.id,
                        trackId: track.id,
                      });
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openClipSource(clip);
                    }}
                    onPointerDown={(event) => {
                      if (event.detail >= 2) {
                        event.preventDefault();
                        event.stopPropagation();
                        openClipSource(clip);
                        return;
                      }
                      beginClipMove(event, clip, track.id);
                    }}
                    style={{
                      left: clip.startSeconds * pixelsPerSecond,
                      width: Math.max(6, clip.durationSeconds * pixelsPerSecond),
                    }}
                    title={`${clip.name} - ${formatSeconds(clip.durationSeconds)}`}
                    type="button"
                  >
                    {clip.durationSeconds * pixelsPerSecond >= 40 ? (
                      <>
                        <span
                          className={cn(
                            "absolute bottom-0 left-0 z-20 h-1/2 w-2 cursor-ew-resize border-b-2 border-l-2 border-white/70 bg-black/20 opacity-0 group-hover:opacity-70 hover:!opacity-100",
                            selectedClipIds.has(clip.id) && "opacity-100",
                          )}
                          onPointerDown={(event) =>
                            beginClipResize(event, clip.id, "start")
                          }
                          title="Trim clip start"
                        />
                        <span
                          className={cn(
                            "absolute bottom-0 right-0 z-20 h-1/2 w-2 cursor-ew-resize border-b-2 border-r-2 border-white/70 bg-black/20 opacity-0 group-hover:opacity-70 hover:!opacity-100",
                            selectedClipIds.has(clip.id) && "opacity-100",
                          )}
                          onPointerDown={(event) =>
                            beginClipResize(event, clip.id, "end")
                          }
                          title="Trim clip end"
                        />
                      </>
                    ) : null}
                    <span className="relative z-10 block truncate text-[9px] font-medium drop-shadow">
                      {clip.name}
                    </span>
                    <ClipWaveform
                      clip={clip}
                      peakData={waveformsByAssetId[clip.assetId]}
                    />
                    {(clip.fadeInSeconds ?? 0) > 0 ? (
                      <span
                        className="pointer-events-none absolute inset-y-0 left-0 z-[11] border-b border-cyan-200/70 bg-cyan-300/20"
                        style={{
                          clipPath: "polygon(0 100%, 100% 0, 100% 100%)",
                          width: (clip.fadeInSeconds ?? 0) * pixelsPerSecond,
                        }}
                      />
                    ) : null}
                    {(clip.fadeOutSeconds ?? 0) > 0 ? (
                      <span
                        className="pointer-events-none absolute inset-y-0 right-0 z-[11] border-b border-cyan-200/70 bg-cyan-300/20"
                        style={{
                          clipPath: "polygon(0 0, 100% 100%, 0 100%)",
                          width: (clip.fadeOutSeconds ?? 0) * pixelsPerSecond,
                        }}
                      />
                    ) : null}
                    {clip.durationSeconds * pixelsPerSecond >= 40 ? (
                      <>
                        <span
                          className={cn(
                            "absolute top-0 z-30 h-1/2 w-3 -translate-x-1/2 cursor-ew-resize opacity-0 group-hover:opacity-100",
                            selectedClipIds.has(clip.id) && "opacity-100",
                          )}
                          onPointerDown={(event) =>
                            beginFadeEdit(event, clip, "in")
                          }
                          style={{
                            left: (clip.fadeInSeconds ?? 0) * pixelsPerSecond,
                          }}
                          title="Adjust fade in"
                        >
                          <i className="absolute left-1/2 top-1 size-2 -translate-x-1/2 rotate-45 border border-cyan-100 bg-cyan-400 shadow" />
                        </span>
                        <span
                          className={cn(
                            "absolute top-0 z-30 h-1/2 w-3 translate-x-1/2 cursor-ew-resize opacity-0 group-hover:opacity-100",
                            selectedClipIds.has(clip.id) && "opacity-100",
                          )}
                          onPointerDown={(event) =>
                            beginFadeEdit(event, clip, "out")
                          }
                          style={{
                            right: (clip.fadeOutSeconds ?? 0) * pixelsPerSecond,
                          }}
                          title="Adjust fade out"
                        >
                          <i className="absolute left-1/2 top-1 size-2 -translate-x-1/2 rotate-45 border border-cyan-100 bg-cyan-400 shadow" />
                        </span>
                      </>
                    ) : null}
                  </button>
                ))}
                {dragPreview?.trackId === track.id
                  ? (() => {
                      const clip = project.tracks
                        .flatMap((candidate) => candidate.clips)
                        .find((candidate) => candidate.id === dragPreview.clipId);
                      return clip ? (
                        <div
                          className={cn(
                            "pointer-events-none absolute bottom-1.5 top-1.5 z-40 overflow-hidden rounded border-2 border-dashed px-1 opacity-70 shadow-lg",
                            dragPreview.valid
                              ? "border-cyan-200 bg-cyan-400/25 text-cyan-50"
                              : "border-red-300 bg-red-500/25 text-red-50",
                          )}
                          style={{
                            left: dragPreview.startSeconds * pixelsPerSecond,
                            width: Math.max(
                              6,
                              clip.durationSeconds * pixelsPerSecond,
                            ),
                          }}
                        >
                          <span className="relative z-10 block truncate text-[9px] font-medium">
                            {dragPreview.valid ? clip.name : "Overlap"}
                          </span>
                          <ClipWaveform
                            clip={clip}
                            peakData={waveformsByAssetId[clip.assetId]}
                          />
                        </div>
                      ) : null;
                    })()
                  : null}
                {rowDragPreview?.trackId === track.id ? (
                  <div
                    className={cn(
                      "pointer-events-none absolute bottom-1.5 top-1.5 z-40 overflow-hidden rounded border-2 border-dashed px-1 opacity-75 shadow-lg",
                      rowDragPreview.valid
                        ? "border-cyan-200 bg-cyan-400/25 text-cyan-50"
                        : "border-red-300 bg-red-500/25 text-red-50",
                    )}
                    style={{
                      left: rowDragPreview.startSeconds * pixelsPerSecond,
                      width: Math.max(
                        6,
                        rowDragPreview.clip.durationSeconds * pixelsPerSecond,
                      ),
                    }}
                  >
                    <span className="relative z-10 block truncate text-[9px] font-medium">
                      {rowDragPreview.valid
                        ? rowDragPreview.clip.name
                        : "Overlap"}
                    </span>
                    <ClipWaveform clip={rowDragPreview.clip} />
                  </div>
                ) : null}
                {snapGuideSeconds !== null ? (
                  <div
                    className="pointer-events-none absolute inset-y-0 z-30 w-px bg-cyan-300 shadow-[0_0_6px_rgba(103,232,249,0.9)]"
                    style={{ left: snapGuideSeconds * pixelsPerSecond }}
                  />
                ) : null}
                <div
                  className="pointer-events-none absolute inset-y-0 z-10 w-px bg-white/75"
                  style={{ left: playheadSeconds * pixelsPerSecond }}
                />
              </div>
            </div>
          ))}

          {dragPreview?.trackId === newLayerPreviewTrackId ||
          rowDragPreview?.trackId === newLayerPreviewTrackId ||
          emptyDropPreview
            ? (() => {
                const clip =
                  dragPreview?.trackId === newLayerPreviewTrackId
                    ? project.tracks
                        .flatMap((track) => track.clips)
                        .find((candidate) => candidate.id === dragPreview.clipId)
                    : rowDragPreview?.trackId === newLayerPreviewTrackId
                      ? rowDragPreview.clip
                      : emptyDropPreview;
                const startSeconds =
                  dragPreview?.trackId === newLayerPreviewTrackId
                    ? dragPreview.startSeconds
                    : rowDragPreview?.trackId === newLayerPreviewTrackId
                      ? rowDragPreview.startSeconds
                      : (emptyDropPreview?.startSeconds ?? 0);
                return clip ? (
                  <div className="flex h-[68px] border-y border-dashed border-cyan-300/70 bg-cyan-300/[0.035]">
                    <div
                      className="sticky left-0 z-[60] flex shrink-0 items-center gap-1.5 border-r border-dashed border-cyan-300/70 bg-[#121316] px-2 text-[10px] font-medium text-cyan-200"
                      style={{ width: trackControlsWidth }}
                    >
                      <Plus className="size-3" />
                      New Layer
                    </div>
                    <div
                      className="isolate relative overflow-hidden"
                      style={{ width: contentWidth }}
                    >
                      <div
                        className="pointer-events-none absolute bottom-1.5 top-1.5 z-40 overflow-hidden rounded border-2 border-dashed border-cyan-200 bg-cyan-400/25 px-1 text-cyan-50 opacity-75 shadow-lg"
                        style={{
                          left: startSeconds * pixelsPerSecond,
                          width: Math.max(
                            6,
                            clip.durationSeconds * pixelsPerSecond,
                          ),
                        }}
                      >
                        <span className="relative z-10 block truncate text-[9px] font-medium">
                          {clip.name}
                        </span>
                        <ClipWaveform
                          clip={clip}
                          peakData={waveformsByAssetId[clip.assetId]}
                        />
                      </div>
                    </div>
                  </div>
                ) : null;
              })()
            : null}
          <div className="min-h-64" data-assembly-new-layer-zone />

        </div>
      </div>

      <div
        className="absolute bottom-3 left-0 right-3 z-[80] flex h-10 overflow-hidden border-y border-border/80 bg-[#0d0e10]"
        data-assembly-new-layer-zone
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = dataTransferHasType(
            event.dataTransfer.types,
            clipDragType,
          )
            ? "move"
            : "copy";
        }}
        onDrop={dropOnNewLayer}
      >
        <button
          className="flex shrink-0 items-center gap-1.5 border-r border-border bg-[#121316] px-2 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={addLayer}
          style={{ width: trackControlsWidth }}
          type="button"
        >
          <Plus className="size-3" />
          Layer
        </button>
        <div className="flex min-w-0 flex-1 items-center px-3 text-[10px] text-muted-foreground/70">
          Drop here for a new layer
        </div>
      </div>

      {selectedClip && clipInspectorOpen ? (
        <section
          aria-label={`Clip inspector for ${selectedClip.name}`}
          className="absolute bottom-14 left-2 right-5 z-[90] overflow-hidden rounded-md border border-border bg-[#121418]/95 text-[10px] shadow-[0_14px_40px_rgba(0,0,0,0.55)] backdrop-blur"
          data-assembly-clip-inspector
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className="flex h-8 items-center gap-2 border-b border-border/80 bg-white/[0.025] px-2">
            <SlidersHorizontal className="size-3.5 shrink-0 text-cyan-300" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={selectedClip.name}>
              {selectedClip.name}
            </span>
            <span className="rounded-sm bg-background px-1.5 py-0.5 text-[9px] text-muted-foreground">
              Clip inspector
            </span>
            <Button
              className="size-6 p-0"
              onClick={() => setClipInspectorOpen(false)}
              size="icon"
              title="Close clip inspector"
              variant="ghost"
            >
              <X className="size-3" />
            </Button>
          </header>

          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 px-2 py-2">
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Gain</span>
              <input
                className="w-20 accent-cyan-300"
                max={36}
                min={-24}
                onChange={(event) =>
                  updateSelectedClipProcessing({
                    gainDb: Number(event.target.value),
                    mode: "processed",
                  })
                }
                step={0.5}
                type="range"
                value={selectedClipProcessing.gainDb}
              />
              <span className="w-9 text-right font-mono text-foreground">
                {selectedClipProcessing.gainDb.toFixed(1)}
              </span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Pitch</span>
              <input
                className="w-20 accent-cyan-300"
                max={12}
                min={-12}
                onChange={(event) =>
                  updateSelectedClipProcessing({
                    pitchSemitones: Number(event.target.value),
                    mode: "processed",
                  })
                }
                step={1}
                type="range"
                value={selectedClipProcessing.pitchSemitones}
              />
              <span className="w-5 text-right font-mono text-foreground">
                {selectedClipProcessing.pitchSemitones}
              </span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Speed</span>
              <select
                className="h-6 rounded-sm border border-border bg-background px-1.5"
                onChange={(event) =>
                  updateSelectedClipProcessing({
                    playbackRate: Number(event.target.value),
                  })
                }
                value={selectedClipProcessing.playbackRate}
              >
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                  <option key={rate} value={rate}>{rate}x</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Channel</span>
              <select
                className="h-6 rounded-sm border border-border bg-background px-1.5"
                onChange={(event) =>
                  updateSelectedClipProcessing({
                    channelMode: event.target.value as AssemblyClipProcessing["channelMode"],
                  })
                }
                value={selectedClipProcessing.channelMode}
              >
                <option value="all">All</option>
                <option value="channel:0">1</option>
                <option value="channel:1">2</option>
              </select>
            </label>
            <Button
              aria-pressed={Boolean(selectedClipProcessing.reversed)}
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={toggleSelectedClipReverse}
              size="sm"
              title="Reverse clip (R)"
              variant={selectedClipProcessing.reversed ? "default" : "ghost"}
            >
              <RotateCcw className="size-3" /> Reverse
            </Button>

            <div className="h-5 w-px bg-border/80" />

            {(["lowDb", "midDb", "highDb"] as const).map((band) => (
              <label className="flex items-center gap-1.5" key={band}>
                <span className="capitalize text-muted-foreground">
                  {band.replace("Db", "")}
                </span>
                <input
                  className="w-16 accent-cyan-300"
                  max={12}
                  min={-12}
                  onChange={(event) =>
                    updateSelectedClipProcessing({
                      eq: {
                        ...selectedClipProcessing.eq,
                        enabled: true,
                        [band]: Number(event.target.value),
                      },
                      mode: "processed",
                    })
                  }
                  step={0.5}
                  type="range"
                  value={selectedClipProcessing.eq[band]}
                />
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Fade in</span>
              <input
                className="w-16 accent-cyan-300"
                max={selectedClip.durationSeconds}
                min={0}
                onChange={(event) =>
                  updateSelectedClipFields({
                    fadeInSeconds: Number(event.target.value),
                  })
                }
                step={0.01}
                type="range"
                value={selectedClip.fadeInSeconds}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Fade out</span>
              <input
                className="w-16 accent-cyan-300"
                max={selectedClip.durationSeconds}
                min={0}
                onChange={(event) =>
                  updateSelectedClipFields({
                    fadeOutSeconds: Number(event.target.value),
                  })
                }
                step={0.01}
                type="range"
                value={selectedClip.fadeOutSeconds}
              />
            </label>
            <Button
              className="h-6 px-2 text-[10px]"
              onClick={() =>
                updateSelectedClipProcessing({
                  mode: selectedClipProcessing.mode === "processed" ? "original" : "processed",
                })
              }
              size="sm"
              variant={selectedClipProcessing.mode === "processed" ? "default" : "ghost"}
            >
              {selectedClipProcessing.mode === "processed" ? "Processed" : "Bypassed"}
            </Button>
          </div>
        </section>
      ) : null}
      </div>

      {marquee
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[1100] border border-cyan-200 bg-cyan-300/15 shadow-[0_0_10px_rgba(103,232,249,0.25)]"
              style={{
                left: Math.min(marquee.startX, marquee.currentX),
                top: Math.min(marquee.startY, marquee.currentY),
                width: Math.abs(marquee.currentX - marquee.startX),
                height: Math.abs(marquee.currentY - marquee.startY),
              }}
            />,
            document.body,
          )
        : null}

      {menu
        ? createPortal(
            <div
              className="fixed z-[1200] min-w-36 rounded-sm border border-border bg-panel p-1 text-[12px] text-foreground shadow-xl"
              data-assembly-menu
              style={{ left: menu.x, top: menu.y }}
            >
          {menu.kind === "clip" ? (
            <>
              <button
                className="block h-7 w-full px-2 text-left hover:bg-muted"
                onClick={() => {
                  const clip = project.tracks
                    .flatMap((track) => track.clips)
                    .find((candidate) => candidate.id === menu.clipId);
                  if (clip) openClipSource(clip);
                  setMenu(null);
                }}
                type="button"
              >
                Focus source
              </button>
              <button
                className="block h-7 w-full px-2 text-left hover:bg-muted"
                onClick={() => {
                  setSelectedTrackId(menu.trackId);
                  setSelectedClipIds(
                    new Set(
                      project.tracks
                        .find((track) => track.id === menu.trackId)
                        ?.clips.map((clip) => clip.id) ?? [],
                    ),
                  );
                  setMenu(null);
                }}
                type="button"
              >
                Select layer
              </button>
              <button
                className="block h-7 w-full px-2 text-left text-destructive hover:bg-muted"
                onClick={() => {
                  setProject((current) => removeClips(current, [menu.clipId]));
                  setSelectedClipIds(new Set());
                  setMenu(null);
                  setStatus("Clip deleted.");
                }}
                type="button"
              >
                Delete clip
              </button>
            </>
          ) : (
            <>
              <button
                className="block h-7 w-full px-2 text-left hover:bg-muted"
                onClick={() => {
                  selectTrackClips(menu.trackId);
                  setMenu(null);
                }}
                type="button"
              >
                Select layer
              </button>
              <button
                className="block h-7 w-full px-2 text-left text-destructive hover:bg-muted"
                onClick={() => removeTimelineTrack(menu.trackId)}
                type="button"
              >
                Delete layer
              </button>
            </>
          )}
            </div>,
            document.body,
          )
        : null}

      <div className="flex min-h-[50px] shrink-0 items-center justify-between gap-2 border-t border-border bg-panel px-2 py-1">
        <p
          className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground"
          title={status}
        >
          {status}
        </p>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            className="h-8 cursor-grab gap-1.5 px-2 text-[11px] active:cursor-grabbing"
            disabled={rendering}
            draggable={!rendering}
            onClick={() => void exportProject()}
            onDragStart={dragProjectExport}
            size="sm"
            title={`Click to save or drag a ${exportSettings.format.toUpperCase()} assembly export`}
            variant="secondary"
          >
            <Download className="size-3.5" />
            Export {exportSettings.format.toUpperCase()}
          </Button>
          {preparedExportDrag ? (
            <div
              aria-live="polite"
              className="flex max-w-48 items-center gap-1.5 rounded-sm border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground shadow-sm"
            >
              {preparedExportDrag.phase === "rendering" ? (
                <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
              ) : (
                <FileAudio className="size-3.5 shrink-0" />
              )}
              <span className="truncate">
                {preparedExportDrag.phase === "rendering"
                  ? `Rendering ${preparedExportDrag.label}`
                  : preparedExportDrag.label}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
