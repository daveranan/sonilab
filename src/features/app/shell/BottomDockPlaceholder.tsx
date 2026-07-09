import {
  AlertCircle,
  ChevronRight,
  Download,
  FolderOpen,
  Gauge,
  Info,
  Music2,
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  Settings2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Square,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { Button } from "@/components/ui/button";
import {
  audioRuntimeStatus,
  defaultExportFolder,
  deletePreparedDragFiles,
  getCachedWaveformPeaks,
  getWaveformPeaks,
  listExportJobs,
  pickOutputFolder,
  prepareAssetDragFile,
  prepareRegionDragFile,
  queueGainExportJobs,
  revealPreparedRegionDragFile,
  resolvePreviewFile,
  retryExportJob,
  startPreparedFilesDrag,
} from "@/features/audio-preview/commands";
import type {
  AudioRuntimeStatus,
  ExportJobSnapshot,
} from "@/features/audio-preview/commands";
import { WaveformCanvas } from "@/features/audio-preview/WaveformCanvas";
import { audioPreviewService } from "@/features/audio-preview/previewService";
import type { OutputMeterSnapshot } from "@/features/audio-preview/previewService";
import type {
  PreviewFileResolution,
  PreviewState,
  ProcessingSettings,
  WaveformRegion,
} from "@/features/audio-preview/types";
import type { BrowseRow } from "@/features/browsing/browseTypes";
import { useBrowseSelectionStore } from "@/features/browsing/selectionStore";
import { createLogger } from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useModalManager } from "./modalManager";

const exportFormats = ["WAV", "MP3", "OGG", "FLAC", "AAC", "M4A", "MP4"];
const eqBands: {
  key: "lowDb" | "midDb" | "highDb";
  label: string;
  title: string;
}[] = [
  { key: "lowDb", label: "Low", title: "Low shelf gain" },
  { key: "midDb", label: "Mid", title: "Mid bell gain" },
  { key: "highDb", label: "High", title: "High shelf gain" },
];
const compactSelectClass =
  "h-7 rounded-md border border-input bg-black px-2 text-[11px] text-foreground outline-none focus-visible:border-primary";
const compactInputClass =
  "h-7 rounded-md border border-input bg-muted/40 px-2 text-[11px] text-foreground outline-none focus-visible:border-primary";
const tempFolderStorageKey = "sonilabs.exportDragTempFolder";
const logger = createLogger("bottom-dock");
const settingsStorageKey = "sonilabs.productionPolishSettings";
const previewUiFrameMs = 66;
const neighborPrefetchMaxBytes = 5 * 1024 * 1024;
const neighborPrefetchMaxDurationSeconds = 20;
const waveformWarmupDelayMs = 1800;
const waveformWarmupPeakTarget = 4096;
const desiredLoopCrossfadeSeconds = 0.08;
const maxLoopCrossfadeRegionRatio = 0.45;
const minLoopRegionDurationSeconds = 0.001;
const defaultRegionFadeGapSeconds = 0.005;
const minRegionFadeGapSeconds = 0;
const maxRegionFadeGapSeconds = 0.05;
const crossfadePreviewDebounceMs = 35;
const defaultLoopCrossfadeSlope = 1;
const defaultRegionFadeSlope = 1;
const minFadeSlope = 0.25;
const maxFadeSlope = 4;
const crossfadeChangeEpsilon = 0.0005;
const regionReplayEpsilonSeconds = 0.002;
const emptyMeter: OutputMeterSnapshot = {
  available: false,
  peakDb: null,
  rmsDb: null,
  level: 0,
};

type StoredExportDefaults = {
  format?: string;
  filenamePattern?: string;
  overwriteMode?: "skip" | "replace" | "rename";
  preserveFolders?: boolean;
  includeSidecar?: boolean;
};

type BottomDockPlaceholderProps = {
  isSummaryOpen: boolean;
  onPreviewedRow: (rowId: string) => void;
  onPlayedAsset?: (row: Extract<BrowseRow, { kind: "asset" }>) => void;
  onExportsChanged?: () => void;
  onToggleSummary: () => void;
  rows: BrowseRow[];
};

function ignoresTransportShortcut(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "select") return true;
  if (target instanceof HTMLInputElement) {
    return ["text", "search", "url", "email", "password", "tel"].includes(target.type);
  }
  return false;
}

function clearsFocusAfterPointer(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  if (ignoresTransportShortcut(target)) return false;
  return Boolean(
    target.closest(
      'button, [role="button"], input, select, [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function shouldPrefetchNeighbors(row: Extract<BrowseRow, { kind: "asset" }>): boolean {
  const fileSizeBytes = row.fileSizeBytes ?? 0;
  const durationSeconds = row.durationSeconds ?? 0;
  if (fileSizeBytes > neighborPrefetchMaxBytes) return false;
  if (durationSeconds > neighborPrefetchMaxDurationSeconds) return false;
  return true;
}

function waveformWarmupSamplesPerPeak(row: Extract<BrowseRow, { kind: "asset" }>) {
  const durationSeconds = row.durationSeconds ?? 0;
  const sampleRate = row.sampleRate ?? 0;
  const estimatedSamples =
    durationSeconds > 0 && sampleRate > 0 ? durationSeconds * sampleRate : 48_000 * 4;
  return Math.max(1, Math.floor(estimatedSamples / waveformWarmupPeakTarget));
}

function loopCrossfadeSeconds(region: WaveformRegion | null): number {
  if (!region) return 0;
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  return Math.max(
    0,
    Math.min(desiredLoopCrossfadeSeconds, duration * maxLoopCrossfadeRegionRatio),
  );
}

function clampLoopCrossfadeSeconds(
  region: WaveformRegion | null,
  seconds: number,
): number {
  if (!region) return desiredLoopCrossfadeSeconds;
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  const maxCrossfade = duration * maxLoopCrossfadeRegionRatio;
  if (maxCrossfade <= 0) return 0;
  return Math.max(0, Math.min(seconds, maxCrossfade));
}

function clampRegionFadeSeconds(
  region: WaveformRegion | null,
  seconds: number,
): number {
  if (!region) return 0;
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  return Math.max(0, Math.min(seconds, duration));
}

function clampRegionFadePair(
  region: WaveformRegion | null,
  fadeInSeconds: number,
  fadeOutSeconds: number,
  fadeGapSeconds = defaultRegionFadeGapSeconds,
): { fadeInSeconds: number; fadeOutSeconds: number } {
  if (!region) return { fadeInSeconds: 0, fadeOutSeconds: 0 };
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  let fadeIn = clampRegionFadeSeconds(region, fadeInSeconds);
  let fadeOut = clampRegionFadeSeconds(region, fadeOutSeconds);
  const requestedGap = Math.max(
    minRegionFadeGapSeconds,
    Math.min(maxRegionFadeGapSeconds, fadeGapSeconds),
  );
  const gap = fadeIn > 0 && fadeOut > 0 ? Math.min(requestedGap, duration) : 0;
  const total = fadeIn + fadeOut;
  const maxTotal = Math.max(0, duration - gap);
  if (total > maxTotal && total > 0) {
    const scale = maxTotal / total;
    fadeIn *= scale;
    fadeOut *= scale;
  }
  return { fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut };
}

function clampFadeSlope(slope: number): number {
  return Math.max(minFadeSlope, Math.min(maxFadeSlope, slope));
}

async function warmWaveformOverview(row: Extract<BrowseRow, { kind: "asset" }>) {
  if (row.availability !== "available") return;
  const resolution = await resolvePreviewFile(row.id, "original");
  const samplesPerPeak = waveformWarmupSamplesPerPeak(row);
  const cached = await getCachedWaveformPeaks(
    row.id,
    resolution.contentKey,
    "source",
    samplesPerPeak,
  );
  if (cached) return;
  await getWaveformPeaks(row.id, resolution.contentKey, "source", samplesPerPeak);
}

function normalizedFormat(value: string | null | undefined): string {
  const format = value?.toLowerCase() ?? "";
  if (format === "wave") return "wav";
  return format;
}

function processingIsNeutral(processing: ProcessingSettings): boolean {
  return (
    processing.channelMode === "all" &&
    Math.abs(processing.gainDb) < 0.000_001 &&
    Math.abs(processing.pitchSemitones) < 0.000_001 &&
    (!processing.eq.enabled ||
      (Math.abs(processing.eq.lowDb) < 0.000_001 &&
        Math.abs(processing.eq.midDb) < 0.000_001 &&
        Math.abs(processing.eq.highDb) < 0.000_001))
  );
}

function OutputMeter({ meter }: { meter: OutputMeterSnapshot }) {
  const peak = meter.peakDb === null ? "-inf" : meter.peakDb.toFixed(1);
  const height = `${Math.round(meter.level * 100)}%`;
  return (
    <div
      className="flex h-full w-12 shrink-0 items-end justify-end gap-1 border-l border-border/70 bg-black px-1.5 py-2"
      title={meter.available ? `Peak ${peak} dBFS` : "Peak meter waiting for waveform"}
    >
      <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
        {peak}
      </span>
      <div className="relative h-full w-2 overflow-hidden rounded-[1px] bg-zinc-900">
        <div
          className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-emerald-500 via-yellow-400 to-red-500"
          style={{ height }}
        />
      </div>
    </div>
  );
}

function readStoredExportDefaults(): StoredExportDefaults {
  try {
    const raw = window.localStorage.getItem(settingsStorageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.exportDefaults ?? {};
  } catch {
    return {};
  }
}

export function BottomDockPlaceholder({
  isSummaryOpen,
  onExportsChanged,
  onPlayedAsset,
  onPreviewedRow,
  onToggleSummary,
  rows,
}: BottomDockPlaceholderProps) {
  const modalManager = useModalManager();
  const initialExportDefaults = useMemo(() => readStoredExportDefaults(), []);
  const [format, setFormat] = useState(initialExportDefaults.format ?? "WAV");
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [outputFolder, setOutputFolder] = useState("");
  const [tempFolder, setTempFolder] = useState(
    () => window.localStorage.getItem(tempFolderStorageKey) ?? "",
  );
  const [filenamePattern, setFilenamePattern] = useState(
    initialExportDefaults.filenamePattern ?? "{name}",
  );
  const [exportScope, setExportScope] = useState<"full" | "region">("full");
  const [overwriteMode, setOverwriteMode] = useState<"skip" | "replace" | "rename">(
    initialExportDefaults.overwriteMode ?? "rename",
  );
  const [preserveFolders, setPreserveFolders] = useState(
    initialExportDefaults.preserveFolders ?? false,
  );
  const [includeSidecar, setIncludeSidecar] = useState(
    initialExportDefaults.includeSidecar ?? false,
  );
  const [formatQuality, setFormatQuality] = useState(16);
  const [crossfadeRenderProgress, setCrossfadeRenderProgress] = useState<number | null>(
    null,
  );
  const exportSettingsOpen = modalManager.isOpen("export-settings");
  const gainBoostOpen = modalManager.isOpen("gain-boost");
  const equalizerOpen = modalManager.isOpen("equalizer");
  const pitchOpen = modalManager.isOpen("pitch");
  const [exportJobs, setExportJobs] = useState<ExportJobSnapshot[]>([]);
  const [runtimeStatus, setRuntimeStatus] = useState<AudioRuntimeStatus | null>(null);
  const [dragFailurePath, setDragFailurePath] = useState<string | null>(null);
  const [dragOverlay, setDragOverlay] = useState<{
    message: string;
    x: number;
    y: number;
  } | null>(null);
  const lastPreviewUiFrameRef = useRef(0);
  const waveformWarmupTimerRef = useRef<number | null>(null);
  const crossfadePreviewTimerRef = useRef<number | null>(null);
  const crossfadeProgressTimerRef = useRef<number | null>(null);
  const crossfadePreviewPathRef = useRef<string | null>(null);
  const crossfadePreviewKeyRef = useRef<string | null>(null);
  const crossfadeRenderGenerationRef = useRef(0);
  const crossfadeRenderCancelledRef = useRef(false);
  const [lastWaveformResolution, setLastWaveformResolution] =
    useState<PreviewFileResolution | null>(null);
  const [previewState, setPreviewState] = useState<PreviewState>(
    audioPreviewService.getState(),
  );
  const [meter, setMeter] = useState<OutputMeterSnapshot>(emptyMeter);
  const [processing, setProcessing] = useState<ProcessingSettings>(
    audioPreviewService.getProcessing(),
  );
  const [loopCrossfadeEnabled, setLoopCrossfadeEnabled] = useState(false);
  const [loopCrossfadeWidthSeconds, setLoopCrossfadeWidthSeconds] = useState(
    desiredLoopCrossfadeSeconds,
  );
  const [loopCrossfadeSlope, setLoopCrossfadeSlope] = useState(
    defaultLoopCrossfadeSlope,
  );
  const [regionFadeGapSeconds, setRegionFadeGapSeconds] = useState(
    defaultRegionFadeGapSeconds,
  );
  const [regionFadeInSeconds, setRegionFadeInSeconds] = useState(0);
  const [regionFadeInSlope, setRegionFadeInSlope] = useState(defaultRegionFadeSlope);
  const [regionFadeOutSeconds, setRegionFadeOutSeconds] = useState(0);
  const [regionFadeOutSlope, setRegionFadeOutSlope] = useState(defaultRegionFadeSlope);
  const [region, setRegion] = useState<WaveformRegion | null>(null);
  const [regionAssetId, setRegionAssetId] = useState<string | null>(null);
  const eqActive =
    processing.eq.enabled &&
    (Math.abs(processing.eq.lowDb) >= 0.000_001 ||
      Math.abs(processing.eq.midDb) >= 0.000_001 ||
      Math.abs(processing.eq.highDb) >= 0.000_001);
  const pitchActive = Math.abs(processing.pitchSemitones) >= 0.000_001;
  const dispatch = useBrowseSelectionStore((state) => state.dispatch);
  const activeRowId = useBrowseSelectionStore((state) => state.activeRowId);
  const selectedRowIds = useBrowseSelectionStore((state) => state.selectedRowIds);
  const [heldAsset, setHeldAsset] = useState<Extract<
    BrowseRow,
    { kind: "asset" }
  > | null>(null);
  const activeIndex = useMemo(
    () => rows.findIndex((row) => row.id === activeRowId),
    [activeRowId, rows],
  );
  const displayAsset = heldAsset;
  const activeRegion = displayAsset?.id === regionAssetId ? region : null;
  const selectedAssets = useMemo(
    () =>
      rows.filter(
        (row): row is Extract<BrowseRow, { kind: "asset" }> =>
          row.kind === "asset" && selectedRowIds.has(row.id),
      ),
    [rows, selectedRowIds],
  );
  const loopEnabled = previewState.loopMode !== "off";
  const tempLoopPreviewActive = audioPreviewService.hasTempLoopPreview();
  const activeResolution = audioPreviewService.getActiveResolution();
  const activeWaveformResolution =
    activeResolution && activeResolution.assetId === displayAsset?.id
      ? activeResolution
      : null;
  const retainedWaveformResolution =
    lastWaveformResolution?.assetId === displayAsset?.id
      ? lastWaveformResolution
      : null;
  const contentKey =
    activeWaveformResolution?.contentKey ??
    retainedWaveformResolution?.contentKey ??
    (displayAsset && !tempLoopPreviewActive ? `mock:${displayAsset.id}` : null);
  const effectiveLoopEnabled =
    loopEnabled || loopCrossfadeEnabled || tempLoopPreviewActive;
  const activeLoopCrossfadeSeconds = loopCrossfadeEnabled
    ? clampLoopCrossfadeSeconds(activeRegion, loopCrossfadeWidthSeconds)
    : 0;
  const activeRegionFade = loopCrossfadeEnabled
    ? { fadeInSeconds: 0, fadeOutSeconds: 0 }
    : clampRegionFadePair(
        activeRegion,
        regionFadeInSeconds,
        regionFadeOutSeconds,
        regionFadeGapSeconds,
      );
  const activeRegionFadeInSeconds = activeRegionFade.fadeInSeconds;
  const activeRegionFadeOutSeconds = activeRegionFade.fadeOutSeconds;
  useEffect(
    () =>
      audioPreviewService.subscribe((state) => {
        setPreviewState(state);
        const resolution = audioPreviewService.getActiveResolution();
        if (resolution) {
          setLastWaveformResolution((current) =>
            current?.assetId === resolution.assetId &&
            current.contentKey === resolution.contentKey
              ? current
              : resolution,
          );
        }
        if (state.status === "failed") {
          setExportStatus(state.errorMessage ?? "Preview playback failed.");
        }
      }),
    [],
  );
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      void audioRuntimeStatus()
        .then((status) => {
          if (!cancelled) setRuntimeStatus(status);
        })
        .catch(() => {
          if (!cancelled) setRuntimeStatus(null);
        });
    };
    tick();
    const interval = window.setInterval(tick, 750);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);
  useEffect(
    () => () => {
      if (waveformWarmupTimerRef.current !== null) {
        window.clearTimeout(waveformWarmupTimerRef.current);
      }
      if (crossfadePreviewTimerRef.current !== null) {
        window.clearTimeout(crossfadePreviewTimerRef.current);
      }
      if (crossfadeProgressTimerRef.current !== null) {
        window.clearInterval(crossfadeProgressTimerRef.current);
      }
      if (crossfadePreviewPathRef.current) {
        void deletePreparedDragFiles([crossfadePreviewPathRef.current]);
      }
      crossfadePreviewKeyRef.current = null;
    },
    [],
  );
  useEffect(() => audioPreviewService.subscribeProcessing(setProcessing), []);
  useEffect(() => {
    audioPreviewService.setRegionFade({
      fadeInSeconds: activeRegionFadeInSeconds,
      fadeOutSeconds: activeRegionFadeOutSeconds,
      fadeInSlope: regionFadeInSlope,
      fadeOutSlope: regionFadeOutSlope,
    });
  }, [
    activeRegionFadeInSeconds,
    activeRegionFadeOutSeconds,
    regionFadeInSlope,
    regionFadeOutSlope,
  ]);
  useEffect(() => {
    void defaultExportFolder()
      .then((folder) => {
        if (folder) setOutputFolder(folder);
      })
      .catch(() => undefined);
    void listExportJobs(25)
      .then(setExportJobs)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<StoredExportDefaults>).detail;
      if (!detail) return;
      if (detail.format) setFormat(detail.format);
      if (detail.filenamePattern) setFilenamePattern(detail.filenamePattern);
      if (detail.overwriteMode) setOverwriteMode(detail.overwriteMode);
      if (detail.preserveFolders !== undefined)
        setPreserveFolders(detail.preserveFolders);
      if (detail.includeSidecar !== undefined) setIncludeSidecar(detail.includeSidecar);
    };
    window.addEventListener("sonilabs:export-defaults-changed", handler);
    return () =>
      window.removeEventListener("sonilabs:export-defaults-changed", handler);
  }, []);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const state = audioPreviewService.getState();
      const now = performance.now();
      if (
        state.status === "playing" &&
        now - lastPreviewUiFrameRef.current >= previewUiFrameMs
      ) {
        lastPreviewUiFrameRef.current = now;
        const analyzerMeter = audioPreviewService.outputMeterSnapshot();
        if (analyzerMeter.available) setMeter(analyzerMeter);
        setPreviewState({
          ...state,
          playheadSeconds: audioPreviewService.currentPlayheadSeconds(),
        });
      } else if (state.status !== "playing") {
        setMeter((current) => (current.level === 0 ? current : emptyMeter));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const previewAtIndex = useCallback(
    (
      index: number,
      options: { preserveSelection?: boolean; startSeconds?: number } = {},
    ) => {
      const row = rows[index];
      if (!row || row.kind !== "asset") return;
      const currentState = audioPreviewService.getState();
      const resumeCurrentAsset =
        currentState.assetId === row.id &&
        ["ready", "paused", "idle"].includes(currentState.status);
      setHeldAsset(row);
      onPreviewedRow(row.id);
      onPlayedAsset?.(row);
      if (!options.preserveSelection) {
        dispatch({ type: "single", rowId: row.id, intent: "programmatic" });
      }
      const rowRegion = row.id === regionAssetId ? region : null;
      const startSeconds =
        options.startSeconds ??
        rowRegion?.startSeconds ??
        (currentState.assetId === row.id ? currentState.playheadSeconds : undefined);
      if (resumeCurrentAsset && audioPreviewService.hasActivePreview()) {
        audioPreviewService.play();
        return;
      }
      void audioPreviewService.previewAsset(row.id, {
        loopMode:
          previewState.loopMode === "off" ? "off" : rowRegion ? "region" : "file",
        startSeconds,
        region: rowRegion,
      });
      if (waveformWarmupTimerRef.current !== null) {
        window.clearTimeout(waveformWarmupTimerRef.current);
        waveformWarmupTimerRef.current = null;
      }
      if (shouldPrefetchNeighbors(row)) {
        const neighbors = rows
          .slice(Math.max(0, index - 1), Math.min(rows.length, index + 2))
          .filter(
            (candidate): candidate is Extract<BrowseRow, { kind: "asset" }> =>
              candidate.kind === "asset" && shouldPrefetchNeighbors(candidate),
          )
          .filter((candidate) => candidate.id !== row.id);
        const neighborIds = neighbors.map((candidate) => candidate.id);
        void audioPreviewService.prefetchNeighbors(neighborIds);
        waveformWarmupTimerRef.current = window.setTimeout(() => {
          waveformWarmupTimerRef.current = null;
          void neighbors.reduce(
            (chain, neighbor) =>
              chain.then(() => warmWaveformOverview(neighbor).catch(() => undefined)),
            Promise.resolve(),
          );
        }, waveformWarmupDelayMs);
      }
    },
    [
      dispatch,
      onPlayedAsset,
      onPreviewedRow,
      previewState.loopMode,
      region,
      regionAssetId,
      rows,
    ],
  );
  const neighborAssetIndex = useCallback(
    (direction: -1 | 1) => {
      const start =
        activeIndex < 0
          ? direction > 0
            ? 0
            : rows.length - 1
          : activeIndex + direction;
      for (
        let index = Math.max(0, Math.min(rows.length - 1, start));
        index >= 0 && index < rows.length;
        index += direction
      ) {
        if (rows[index]?.kind === "asset") return index;
      }
      return activeIndex;
    },
    [activeIndex, rows],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          kind: string;
          rowId: string | null;
          preserveSelection?: boolean;
        }>
      ).detail;
      if (detail.kind === "cancel-preview") {
        audioPreviewService.cancelPreview();
        setHeldAsset(null);
        setRegion(null);
        setRegionAssetId(null);
        audioPreviewService.setRegion(null);
        return;
      }
      if (!detail?.rowId) return;
      const index = rows.findIndex((row) => row.id === detail.rowId);
      if (detail.kind === "toggle-preview") {
        if (audioPreviewService.getState().status === "playing") {
          audioPreviewService.pause();
        } else previewAtIndex(index);
      }
      if (detail.kind === "start-preview") {
        previewAtIndex(index, { preserveSelection: detail.preserveSelection });
      }
    };
    window.addEventListener("sonilabs:preview-intent", handler);
    return () => window.removeEventListener("sonilabs:preview-intent", handler);
  }, [previewAtIndex, previewState.status, rows]);

  const updateProcessing = useCallback((patch: Partial<ProcessingSettings>) => {
    audioPreviewService.setProcessing(patch);
    setProcessing(audioPreviewService.getProcessing());
  }, []);

  const clearCrossfadeLoopPreview = useCallback(
    (
      regionForPlayback: WaveformRegion | null,
      options: { disableMode?: boolean } = {},
    ) => {
      crossfadeRenderCancelledRef.current = true;
      crossfadeRenderGenerationRef.current += 1;
      if (crossfadePreviewTimerRef.current !== null) {
        window.clearTimeout(crossfadePreviewTimerRef.current);
        crossfadePreviewTimerRef.current = null;
      }
      if (crossfadeProgressTimerRef.current !== null) {
        window.clearInterval(crossfadeProgressTimerRef.current);
        crossfadeProgressTimerRef.current = null;
      }
      setCrossfadeRenderProgress(null);
      if (options.disableMode ?? true) setLoopCrossfadeEnabled(false);
      audioPreviewService.exitTempLoopPreview(regionForPlayback);
      if (crossfadePreviewPathRef.current) {
        void deletePreparedDragFiles([crossfadePreviewPathRef.current]);
        crossfadePreviewPathRef.current = null;
        crossfadePreviewKeyRef.current = null;
      }
    },
    [],
  );

  const startSelectedRegionLoopPreview = useCallback(
    (regionForPlayback: WaveformRegion, startSeconds: number) => {
      if (!displayAsset) return;
      const loopDurationSeconds = Math.max(
        minLoopRegionDurationSeconds,
        regionForPlayback.endSeconds - regionForPlayback.startSeconds,
      );
      void (async () => {
        const renderGeneration = crossfadeRenderGenerationRef.current + 1;
        crossfadeRenderGenerationRef.current = renderGeneration;
        crossfadeRenderCancelledRef.current = false;
        const prepared = await prepareRegionDragFile({
          assetId: displayAsset.id,
          displayName: displayAsset.name,
          format: "wav",
          formatSettings: { wavBitDepth: 16 },
          gainDb: processing.gainDb,
          channelMode: processing.channelMode,
          eq: processing.eq,
          pitchSemitones: processing.pitchSemitones,
          region: regionForPlayback,
          regionFadeGapSeconds,
          regionFadeInSeconds: activeRegionFadeInSeconds,
          regionFadeInSlope,
          regionFadeOutSeconds: activeRegionFadeOutSeconds,
          regionFadeOutSlope,
          tempFolder,
        });
        if (
          crossfadeRenderCancelledRef.current ||
          crossfadeRenderGenerationRef.current !== renderGeneration
        ) {
          if (prepared?.path) void deletePreparedDragFiles([prepared.path]);
          return;
        }
        if (!prepared) {
          await audioPreviewService.previewAsset(displayAsset.id, {
            autoplay: previewState.status === "playing",
            loopMode: "region",
            region: regionForPlayback,
            startSeconds,
          });
          setPreviewState(audioPreviewService.getState());
          return;
        }
        const previousPath = crossfadePreviewPathRef.current;
        crossfadePreviewPathRef.current = prepared.path;
        crossfadePreviewKeyRef.current = `loop:${displayAsset.id}:${regionForPlayback.startSeconds}:${regionForPlayback.endSeconds}`;
        if (previousPath && previousPath !== prepared.path) {
          void deletePreparedDragFiles([previousPath]);
        }
        if (
          crossfadeRenderCancelledRef.current ||
          crossfadeRenderGenerationRef.current !== renderGeneration
        ) {
          crossfadePreviewPathRef.current = null;
          crossfadePreviewKeyRef.current = null;
          void deletePreparedDragFiles([prepared.path]);
          return;
        }
        await audioPreviewService.previewTempLoopFile(
          displayAsset.id,
          prepared.path,
          regionForPlayback,
          loopDurationSeconds,
          startSeconds,
        );
        setPreviewState(audioPreviewService.getState());
      })().catch((error: unknown) => {
        logger.error("Selected-region loop preview failed", {
          assetId: displayAsset.id,
          regionStartSeconds: regionForPlayback.startSeconds,
          regionEndSeconds: regionForPlayback.endSeconds,
          error: error instanceof Error ? error.message : String(error),
        });
        setExportStatus(
          error instanceof Error ? error.message : "Selected-region loop failed.",
        );
      });
    },
    [
      activeRegionFadeInSeconds,
      activeRegionFadeOutSeconds,
      displayAsset,
      previewState.status,
      processing.eq,
      processing.gainDb,
      processing.channelMode,
      processing.pitchSemitones,
      regionFadeGapSeconds,
      regionFadeInSlope,
      regionFadeOutSlope,
      tempFolder,
    ],
  );

  const updateLoopEnabled = useCallback(
    (enabled: boolean) => {
      const loopMode = enabled ? (activeRegion ? "region" : "file") : "off";
      if (!enabled) {
        clearCrossfadeLoopPreview(activeRegion);
      }
      if (enabled && activeRegion && displayAsset) {
        startSelectedRegionLoopPreview(
          activeRegion,
          audioPreviewService.currentPlayheadSeconds(),
        );
        setPreviewState(audioPreviewService.getState());
        return;
      }
      audioPreviewService.setLoopMode(loopMode, activeRegion);
      setPreviewState(audioPreviewService.getState());
    },
    [
      activeRegion,
      clearCrossfadeLoopPreview,
      displayAsset,
      startSelectedRegionLoopPreview,
    ],
  );

  const currentLoopEnabled = useCallback(
    () =>
      audioPreviewService.getState().loopMode !== "off" ||
      loopCrossfadeEnabled ||
      audioPreviewService.hasTempLoopPreview(),
    [loopCrossfadeEnabled],
  );

  const selectedRegionPlaybackStart = useCallback(
    (regionForPlayback: WaveformRegion) => {
      const state = audioPreviewService.getState();
      const currentSeconds = audioPreviewService.currentPlayheadSeconds();
      if (
        state.status !== "playing" &&
        currentSeconds >= regionForPlayback.endSeconds - regionReplayEpsilonSeconds
      ) {
        return regionForPlayback.startSeconds;
      }
      if (
        currentSeconds < regionForPlayback.startSeconds ||
        currentSeconds >= regionForPlayback.endSeconds
      ) {
        return regionForPlayback.startSeconds;
      }
      return currentSeconds;
    },
    [],
  );

  const beginCrossfadeProgress = useCallback(() => {
    if (crossfadeProgressTimerRef.current !== null) {
      window.clearInterval(crossfadeProgressTimerRef.current);
    }
    setCrossfadeRenderProgress(5);
    crossfadeProgressTimerRef.current = window.setInterval(() => {
      setCrossfadeRenderProgress((current) =>
        current === null ? 5 : Math.min(88, current + 7),
      );
    }, 120);
  }, []);

  const finishCrossfadeProgress = useCallback(() => {
    if (crossfadeProgressTimerRef.current !== null) {
      window.clearInterval(crossfadeProgressTimerRef.current);
      crossfadeProgressTimerRef.current = null;
    }
    setCrossfadeRenderProgress(100);
    window.setTimeout(() => setCrossfadeRenderProgress(null), 900);
  }, []);

  const startCrossfadeLoopPreview = useCallback(
    (
      crossfadeOverride?: number,
      startSecondsOverride?: number,
      slopeOverride?: number,
    ) => {
      if (!displayAsset || !activeRegion) return;
      const crossfadeSeconds = clampLoopCrossfadeSeconds(
        activeRegion,
        crossfadeOverride ?? loopCrossfadeWidthSeconds,
      );
      const crossfadeSlope = slopeOverride ?? loopCrossfadeSlope;
      if (crossfadeSeconds <= 0) return;
      setExportStatus("Rendering crossfade loop temp preview...");
      beginCrossfadeProgress();
      void (async () => {
        const renderGeneration = crossfadeRenderGenerationRef.current + 1;
        crossfadeRenderGenerationRef.current = renderGeneration;
        crossfadeRenderCancelledRef.current = false;
        const loopDurationSeconds = Math.max(
          0.02,
          activeRegion.endSeconds - activeRegion.startSeconds,
        );
        const previewKey = [
          displayAsset.id,
          activeRegion.startSeconds.toFixed(5),
          activeRegion.endSeconds.toFixed(5),
          crossfadeSeconds.toFixed(5),
          crossfadeSlope.toFixed(3),
          processing.gainDb.toFixed(2),
          processing.eq.lowDb.toFixed(2),
          processing.eq.midDb.toFixed(2),
          processing.eq.highDb.toFixed(2),
          processing.pitchSemitones.toFixed(2),
          processing.channelMode,
          tempFolder,
        ].join(":");
        if (
          crossfadePreviewPathRef.current &&
          crossfadePreviewKeyRef.current === previewKey
        ) {
          await audioPreviewService.previewTempLoopFile(
            displayAsset.id,
            crossfadePreviewPathRef.current,
            activeRegion,
            loopDurationSeconds,
            startSecondsOverride ?? audioPreviewService.currentPlayheadSeconds(),
          );
          if (
            crossfadeRenderCancelledRef.current ||
            crossfadeRenderGenerationRef.current !== renderGeneration
          ) {
            finishCrossfadeProgress();
            return;
          }
          finishCrossfadeProgress();
          setExportStatus("Crossfade loop preview ready.");
          return;
        }
        const previousPath = crossfadePreviewPathRef.current;
        const prepared = await prepareRegionDragFile({
          assetId: displayAsset.id,
          displayName: displayAsset.name,
          format: "wav",
          formatSettings: { wavBitDepth: 16 },
          gainDb: processing.gainDb,
          channelMode: processing.channelMode,
          eq: processing.eq,
          pitchSemitones: processing.pitchSemitones,
          loopCrossfadeSeconds: crossfadeSeconds,
          loopCrossfadeSlope: crossfadeSlope,
          region: activeRegion,
          tempFolder,
        });
        if (!prepared) {
          setCrossfadeRenderProgress(null);
          setExportStatus("Crossfade loop preview requires Tauri runtime.");
          return;
        }
        crossfadePreviewPathRef.current = prepared.path;
        crossfadePreviewKeyRef.current = previewKey;
        if (previousPath && previousPath !== prepared.path) {
          void deletePreparedDragFiles([previousPath]);
        }
        if (
          crossfadeRenderCancelledRef.current ||
          crossfadeRenderGenerationRef.current !== renderGeneration
        ) {
          finishCrossfadeProgress();
          return;
        }
        await audioPreviewService.previewTempLoopFile(
          displayAsset.id,
          prepared.path,
          activeRegion,
          loopDurationSeconds,
          startSecondsOverride ?? audioPreviewService.currentPlayheadSeconds(),
        );
        finishCrossfadeProgress();
        setExportStatus("Crossfade loop preview ready.");
      })().catch((error: unknown) => {
        if (crossfadeProgressTimerRef.current !== null) {
          window.clearInterval(crossfadeProgressTimerRef.current);
          crossfadeProgressTimerRef.current = null;
        }
        setCrossfadeRenderProgress(null);
        logger.error("Crossfade loop preview failed", {
          assetId: displayAsset.id,
          assetName: displayAsset.name,
          regionStartSeconds: activeRegion.startSeconds,
          regionEndSeconds: activeRegion.endSeconds,
          crossfadeSeconds,
          loopCrossfadeSlope: crossfadeSlope,
          tempFolder,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        setExportStatus(
          error instanceof Error ? error.message : "Crossfade loop preview failed.",
        );
      });
    },
    [
      activeRegion,
      beginCrossfadeProgress,
      displayAsset,
      finishCrossfadeProgress,
      loopCrossfadeSlope,
      loopCrossfadeWidthSeconds,
      processing.eq,
      processing.gainDb,
      processing.channelMode,
      processing.pitchSemitones,
      tempFolder,
    ],
  );

  const scheduleCrossfadeLoopPreview = useCallback(
    (crossfadeSeconds: number, slopeOverride?: number) => {
      if (!loopCrossfadeEnabled || !activeRegion || !displayAsset) return;
      if (crossfadePreviewTimerRef.current !== null) {
        window.clearTimeout(crossfadePreviewTimerRef.current);
      }
      crossfadePreviewTimerRef.current = window.setTimeout(() => {
        crossfadePreviewTimerRef.current = null;
        startCrossfadeLoopPreview(crossfadeSeconds, undefined, slopeOverride);
      }, crossfadePreviewDebounceMs);
    },
    [activeRegion, displayAsset, loopCrossfadeEnabled, startCrossfadeLoopPreview],
  );

  const playSelectedRegion = useCallback(
    (regionForPlayback: WaveformRegion) => {
      const startSeconds = selectedRegionPlaybackStart(regionForPlayback);
      const state = audioPreviewService.getState();

      if (loopCrossfadeEnabled && displayAsset) {
        startCrossfadeLoopPreview(undefined, startSeconds);
        return;
      }
      if (state.loopMode === "region") {
        startSelectedRegionLoopPreview(regionForPlayback, startSeconds);
        return;
      }
      if (
        !displayAsset ||
        state.assetId !== displayAsset.id ||
        !audioPreviewService.hasActivePreview()
      ) {
        if (!displayAsset) return;
        void audioPreviewService.previewAsset(displayAsset.id, {
          loopMode: state.loopMode,
          region: regionForPlayback,
          startSeconds,
        });
        return;
      }
      audioPreviewService.seek(startSeconds);
      audioPreviewService.play();
    },
    [
      displayAsset,
      loopCrossfadeEnabled,
      selectedRegionPlaybackStart,
      startCrossfadeLoopPreview,
      startSelectedRegionLoopPreview,
    ],
  );

  const cancelCrossfadeRenderAutoplay = useCallback(() => {
    if (crossfadeRenderProgress === null) return false;
    crossfadeRenderCancelledRef.current = true;
    crossfadeRenderGenerationRef.current += 1;
    audioPreviewService.pause();
    setExportStatus("Crossfade render paused.");
    return true;
  }, [crossfadeRenderProgress]);

  const pausePreviewPlayback = useCallback(() => {
    audioPreviewService.pause();
    setPreviewState(audioPreviewService.getState());
  }, []);

  const stopPreviewPlayback = useCallback(() => {
    clearCrossfadeLoopPreview(null);
    audioPreviewService.stop();
    setPreviewState(audioPreviewService.getState());
  }, [clearCrossfadeLoopPreview]);

  const toggleLoopCrossfade = useCallback(() => {
    if (!activeRegion) {
      setExportStatus("Select a waveform region before crossfade loop mode.");
      return;
    }
    if (loopCrossfadeEnabled) {
      const playheadSeconds = audioPreviewService.currentPlayheadSeconds();
      clearCrossfadeLoopPreview(activeRegion);
      if (displayAsset) {
        void audioPreviewService.previewAsset(displayAsset.id, {
          autoplay: false,
          loopMode: previewState.loopMode,
          region: activeRegion,
          startSeconds: playheadSeconds,
        });
      }
      return;
    }
    const initialWidth = clampLoopCrossfadeSeconds(
      activeRegion,
      loopCrossfadeWidthSeconds || loopCrossfadeSeconds(activeRegion),
    );
    setLoopCrossfadeWidthSeconds(initialWidth);
    setLoopCrossfadeEnabled(true);
    window.setTimeout(() => startCrossfadeLoopPreview(initialWidth), 0);
  }, [
    activeRegion,
    clearCrossfadeLoopPreview,
    displayAsset,
    loopCrossfadeEnabled,
    loopCrossfadeWidthSeconds,
    previewState.loopMode,
    startCrossfadeLoopPreview,
  ]);

  const handleRegionChange = useCallback(
    (nextRegion: WaveformRegion | null) => {
      if (!nextRegion) {
        setLoopCrossfadeEnabled(false);
        if (crossfadePreviewPathRef.current) {
          void deletePreparedDragFiles([crossfadePreviewPathRef.current]);
          crossfadePreviewPathRef.current = null;
          crossfadePreviewKeyRef.current = null;
        }
        audioPreviewService.exitTempLoopPreview(null);
      } else if (audioPreviewService.hasTempLoopPreview()) {
        clearCrossfadeLoopPreview(nextRegion, { disableMode: false });
      }
      setRegion(nextRegion);
      setRegionAssetId(displayAsset?.id ?? null);
      if (nextRegion) {
        setLoopCrossfadeWidthSeconds((current) =>
          clampLoopCrossfadeSeconds(nextRegion, current),
        );
        const nextFade = clampRegionFadePair(
          nextRegion,
          regionFadeInSeconds,
          regionFadeOutSeconds,
          regionFadeGapSeconds,
        );
        setRegionFadeInSeconds(nextFade.fadeInSeconds);
        setRegionFadeOutSeconds(nextFade.fadeOutSeconds);
      }
      audioPreviewService.setRegion(nextRegion);
    },
    [
      clearCrossfadeLoopPreview,
      displayAsset?.id,
      regionFadeGapSeconds,
      regionFadeInSeconds,
      regionFadeOutSeconds,
    ],
  );

  const handleMeterChange = useCallback((nextMeter: OutputMeterSnapshot) => {
    setMeter(nextMeter);
  }, []);

  const handleRegionCommit = useCallback(
    (nextRegion: WaveformRegion) => {
      if (loopCrossfadeEnabled && displayAsset) {
        const crossfadeSeconds = clampLoopCrossfadeSeconds(
          nextRegion,
          loopCrossfadeWidthSeconds,
        );
        setLoopCrossfadeWidthSeconds(crossfadeSeconds);
        scheduleCrossfadeLoopPreview(crossfadeSeconds);
        return;
      }
      audioPreviewService.seek(nextRegion.startSeconds);
      audioPreviewService.setRegion(nextRegion);
    },
    [
      displayAsset,
      loopCrossfadeEnabled,
      loopCrossfadeWidthSeconds,
      scheduleCrossfadeLoopPreview,
    ],
  );

  const handleLoopCrossfadeSecondsChange = useCallback(
    (seconds: number) => {
      const nextSeconds = clampLoopCrossfadeSeconds(activeRegion, seconds);
      setLoopCrossfadeWidthSeconds(nextSeconds);
      scheduleCrossfadeLoopPreview(nextSeconds, loopCrossfadeSlope);
    },
    [activeRegion, loopCrossfadeSlope, scheduleCrossfadeLoopPreview],
  );

  const handleLoopCrossfadeSecondsCommit = useCallback(
    (seconds: number) => {
      const nextSeconds = clampLoopCrossfadeSeconds(activeRegion, seconds);
      if (Math.abs(nextSeconds - loopCrossfadeWidthSeconds) < crossfadeChangeEpsilon) {
        return;
      }
      setLoopCrossfadeWidthSeconds(nextSeconds);
      scheduleCrossfadeLoopPreview(nextSeconds, loopCrossfadeSlope);
    },
    [
      activeRegion,
      loopCrossfadeSlope,
      loopCrossfadeWidthSeconds,
      scheduleCrossfadeLoopPreview,
    ],
  );

  const handleLoopCrossfadeSlopeChange = useCallback(
    (slope: number) => {
      setLoopCrossfadeSlope(slope);
      scheduleCrossfadeLoopPreview(activeLoopCrossfadeSeconds, slope);
    },
    [activeLoopCrossfadeSeconds, scheduleCrossfadeLoopPreview],
  );

  const handleLoopCrossfadeSlopeCommit = useCallback(
    (slope: number) => {
      if (Math.abs(slope - loopCrossfadeSlope) < crossfadeChangeEpsilon) {
        return;
      }
      setLoopCrossfadeSlope(slope);
      scheduleCrossfadeLoopPreview(activeLoopCrossfadeSeconds, slope);
    },
    [activeLoopCrossfadeSeconds, loopCrossfadeSlope, scheduleCrossfadeLoopPreview],
  );

  const handleRegionFadeChange = useCallback(
    (fade: {
      fadeInSeconds: number;
      fadeOutSeconds: number;
      fadeInSlope?: number;
      fadeOutSlope?: number;
    }) => {
      const nextFade = clampRegionFadePair(
        activeRegion,
        fade.fadeInSeconds,
        fade.fadeOutSeconds,
        regionFadeGapSeconds,
      );
      setRegionFadeInSeconds(nextFade.fadeInSeconds);
      setRegionFadeOutSeconds(nextFade.fadeOutSeconds);
      if (fade.fadeInSlope !== undefined)
        setRegionFadeInSlope(clampFadeSlope(fade.fadeInSlope));
      if (fade.fadeOutSlope !== undefined)
        setRegionFadeOutSlope(clampFadeSlope(fade.fadeOutSlope));
    },
    [activeRegion, regionFadeGapSeconds],
  );

  const handleRegionFadeCommit = useCallback(
    (fade: {
      fadeInSeconds: number;
      fadeOutSeconds: number;
      fadeInSlope?: number;
      fadeOutSlope?: number;
    }) => {
      const nextFade = clampRegionFadePair(
        activeRegion,
        fade.fadeInSeconds,
        fade.fadeOutSeconds,
        regionFadeGapSeconds,
      );
      setRegionFadeInSeconds(nextFade.fadeInSeconds);
      setRegionFadeOutSeconds(nextFade.fadeOutSeconds);
      if (fade.fadeInSlope !== undefined)
        setRegionFadeInSlope(clampFadeSlope(fade.fadeInSlope));
      if (fade.fadeOutSlope !== undefined)
        setRegionFadeOutSlope(clampFadeSlope(fade.fadeOutSlope));
    },
    [activeRegion, regionFadeGapSeconds],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: string }>).detail;
      if (detail?.kind === "clear-region") handleRegionChange(null);
      if (detail?.kind === "toggle-loop") updateLoopEnabled(!currentLoopEnabled());
    };
    window.addEventListener("sonilabs:waveform-intent", handler);
    return () => window.removeEventListener("sonilabs:waveform-intent", handler);
  }, [currentLoopEnabled, handleRegionChange, updateLoopEnabled]);

  useEffect(() => {
    const handlePointerUp = (event: PointerEvent) => {
      if (clearsFocusAfterPointer(event.target)) {
        requestAnimationFrame(() => {
          if (
            document.activeElement instanceof HTMLElement &&
            !ignoresTransportShortcut(document.activeElement)
          ) {
            document.activeElement.blur();
          }
        });
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ignoresTransportShortcut(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        handleRegionChange(null);
      }
      if (event.key.toLowerCase() === "v") {
        event.preventDefault();
        toggleLoopCrossfade();
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLowerCase() === "l"
      ) {
        event.preventDefault();
        event.stopPropagation();
        updateLoopEnabled(!currentLoopEnabled());
      }
      if (event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        if (
          document.activeElement instanceof HTMLElement &&
          !ignoresTransportShortcut(document.activeElement)
        ) {
          document.activeElement.blur();
        }
        if (cancelCrossfadeRenderAutoplay()) return;
        const state = audioPreviewService.getState();
        if (state.status === "playing") {
          pausePreviewPlayback();
        } else if (activeRegion) {
          playSelectedRegion(activeRegion);
        } else if (activeIndex >= 0)
          previewAtIndex(activeIndex, {
            startSeconds: audioPreviewService.currentPlayheadSeconds(),
          });
        else audioPreviewService.play();
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== " " || ignoresTransportShortcut(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [
    activeIndex,
    activeRegion,
    cancelCrossfadeRenderAutoplay,
    currentLoopEnabled,
    handleRegionChange,
    pausePreviewPlayback,
    playSelectedRegion,
    previewAtIndex,
    previewState.status,
    toggleLoopCrossfade,
    updateLoopEnabled,
  ]);

  const formatSettings = useMemo(() => {
    const lowerFormat = format.toLowerCase();
    if (lowerFormat === "wav") return { wavBitDepth: formatQuality };
    if (lowerFormat === "ogg") return { oggQuality: formatQuality };
    if (lowerFormat === "flac") return { flacCompressionLevel: formatQuality };
    if (lowerFormat === "mp4")
      return { mp4Codec: "aac" as const, mp4BitrateKbps: formatQuality };
    if (lowerFormat === "aac" || lowerFormat === "m4a")
      return { aacBitrateKbps: formatQuality };
    return { mp3BitrateKbps: formatQuality, mp3Mode: "cbr" as const };
  }, [format, formatQuality]);

  useEffect(() => {
    if (!dragOverlay) return;
    const handlePointerMove = (event: PointerEvent) => {
      setDragOverlay((current) =>
        current ? { ...current, x: event.clientX, y: event.clientY } : null,
      );
    };
    window.addEventListener("pointermove", handlePointerMove, true);
    return () => window.removeEventListener("pointermove", handlePointerMove, true);
  }, [dragOverlay]);

  const handlePickOutputFolder = useCallback(() => {
    void pickOutputFolder()
      .then((folder) => {
        if (folder) setOutputFolder(folder);
      })
      .catch((error: unknown) =>
        setExportStatus(
          error instanceof Error ? error.message : "Output folder picker failed.",
        ),
      );
  }, []);

  const handlePickTempFolder = useCallback(() => {
    void pickOutputFolder()
      .then((folder) => {
        if (!folder) return;
        setTempFolder(folder);
        window.localStorage.setItem(tempFolderStorageKey, folder);
      })
      .catch((error: unknown) =>
        setExportStatus(
          error instanceof Error ? error.message : "Temp folder picker failed.",
        ),
      );
  }, []);

  const updateTempFolder = useCallback((folder: string) => {
    setTempFolder(folder);
    if (folder.trim()) window.localStorage.setItem(tempFolderStorageKey, folder);
    else window.localStorage.removeItem(tempFolderStorageKey);
  }, []);

  const handleExport = useCallback(() => {
    const exportRegion = exportScope === "region" ? activeRegion : null;
    if (exportScope === "region" && !exportRegion) {
      setExportStatus("Select a waveform region before region export.");
      return;
    }
    if (!outputFolder.trim()) {
      setExportStatus("Choose an output folder.");
      return;
    }
    const batch = displayAsset ? [displayAsset] : exportRegion ? [] : selectedAssets;
    if (batch.length === 0) return;
    if (batch.some((asset) => asset.provider && asset.provider !== "local")) {
      setExportStatus("Cloud asset export is deferred in this build.");
      return;
    }
    setExportStatus(
      `Exporting ${batch.length} ${batch.length === 1 ? "file" : "files"}...`,
    );
    void queueGainExportJobs({
      assetIds: batch.map((asset) => asset.id),
      filenamePattern: "{name}",
      format,
      formatSettings,
      gainDb: processing.gainDb,
      channelMode: processing.channelMode,
      eq: processing.eq,
      pitchSemitones: processing.pitchSemitones,
      includeAttributionSidecar: includeSidecar,
      loopCrossfadeSeconds: activeLoopCrossfadeSeconds || null,
      loopCrossfadeSlope,
      outputFolder,
      overwriteMode,
      preserveFolderStructure: preserveFolders,
      regionFadeGapSeconds,
      regionFadeInSeconds: activeRegionFadeInSeconds || null,
      regionFadeInSlope,
      regionFadeOutSeconds: activeRegionFadeOutSeconds || null,
      regionFadeOutSlope,
      region: exportRegion,
      scope: exportRegion ? "region" : "full",
    })
      .then((jobs) => {
        if (!jobs) {
          setExportStatus("Export requires Tauri runtime.");
          return;
        }
        setExportJobs((current) => [...jobs, ...current].slice(0, 25));
        const failed = jobs.filter((job) => job.status === "failed").length;
        setExportStatus(
          failed > 0
            ? `${failed} export failed; retry from queue.`
            : `Exported ${jobs.length}.`,
        );
        onExportsChanged?.();
      })
      .catch((error: unknown) =>
        setExportStatus(error instanceof Error ? error.message : "Export failed."),
      );
  }, [
    activeRegion,
    displayAsset,
    exportScope,
    format,
    formatSettings,
    includeSidecar,
    activeLoopCrossfadeSeconds,
    activeRegionFadeInSeconds,
    activeRegionFadeOutSeconds,
    loopCrossfadeSlope,
    onExportsChanged,
    outputFolder,
    overwriteMode,
    preserveFolders,
    processing.eq,
    processing.gainDb,
    processing.channelMode,
    processing.pitchSemitones,
    regionFadeGapSeconds,
    regionFadeInSlope,
    regionFadeOutSlope,
    selectedAssets,
  ]);

  useEffect(() => {
    const transportHandler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          kind: string;
          delta?: number;
          deltaSeconds?: number;
          channelMode?: ProcessingSettings["channelMode"];
        }>
      ).detail;
      if (detail?.kind === "nudge-playhead") {
        audioPreviewService.seek(
          audioPreviewService.currentPlayheadSeconds() + (detail.deltaSeconds ?? 0),
        );
        setPreviewState(audioPreviewService.getState());
      }
      if (detail?.kind === "volume") {
        updateProcessing({
          outputVolume: Math.max(
            0,
            Math.min(1, processing.outputVolume + (detail.delta ?? 0)),
          ),
        });
      }
      if (detail?.kind === "channel" && detail.channelMode) {
        updateProcessing({ channelMode: detail.channelMode });
      }
    };
    const exportHandler = () => handleExport();
    window.addEventListener("sonilabs:transport-intent", transportHandler);
    window.addEventListener("sonilabs:export-intent", exportHandler);
    return () => {
      window.removeEventListener("sonilabs:transport-intent", transportHandler);
      window.removeEventListener("sonilabs:export-intent", exportHandler);
    };
  }, [handleExport, processing.outputVolume, updateProcessing]);

  const handleRetryExport = useCallback(
    (jobId: string) => {
      void retryExportJob(jobId)
        .then((jobs) => {
          setExportJobs((current) => [
            ...jobs,
            ...current.filter((job) => !jobs.some((next) => next.id === job.id)),
          ]);
          setExportStatus(`Retried ${jobId}.`);
          onExportsChanged?.();
        })
        .catch((error: unknown) =>
          setExportStatus(error instanceof Error ? error.message : "Retry failed."),
        );
    },
    [onExportsChanged],
  );

  const updateGain = useCallback((gainDb: number) => {
    audioPreviewService.setProcessing({ gainDb, mode: "processed" });
  }, []);

  const updateEqBand = useCallback(
    (band: "lowDb" | "midDb" | "highDb", value: number) => {
      const current = audioPreviewService.getProcessing().eq;
      audioPreviewService.setProcessing({
        mode: "processed",
        eq: { ...current, enabled: true, [band]: value },
      });
    },
    [],
  );

  const resetEq = useCallback(() => {
    audioPreviewService.setProcessing({
      eq: { enabled: false, lowDb: 0, midDb: 0, highDb: 0 },
    });
  }, []);

  const updatePitch = useCallback((pitchSemitones: number) => {
    audioPreviewService.setProcessing({ pitchSemitones, mode: "processed" });
  }, []);

  const handleGainSpace = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === " ") event.currentTarget.blur();
    },
    [],
  );

  useEffect(() => {
    if (!displayAsset || !activeRegion) return;
    const timer = window.setTimeout(() => {
      void prepareRegionDragFile({
        assetId: displayAsset.id,
        displayName: displayAsset.name,
        format,
        formatSettings,
        gainDb: processing.gainDb,
        channelMode: processing.channelMode,
        eq: processing.eq,
        pitchSemitones: processing.pitchSemitones,
        loopCrossfadeSeconds: activeLoopCrossfadeSeconds || null,
        loopCrossfadeSlope,
        regionFadeGapSeconds,
        regionFadeInSeconds: activeRegionFadeInSeconds || null,
        regionFadeInSlope,
        regionFadeOutSeconds: activeRegionFadeOutSeconds || null,
        regionFadeOutSlope,
        region: activeRegion,
        tempFolder,
      }).catch((error: unknown) => {
        logger.warn("Crossfade/region export pre-render failed", {
          assetId: displayAsset.id,
          assetName: displayAsset.name,
          regionStartSeconds: activeRegion.startSeconds,
          regionEndSeconds: activeRegion.endSeconds,
          loopCrossfadeSeconds: activeLoopCrossfadeSeconds || null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    activeRegion,
    displayAsset,
    format,
    formatSettings,
    activeLoopCrossfadeSeconds,
    activeRegionFadeInSeconds,
    activeRegionFadeOutSeconds,
    regionFadeGapSeconds,
    regionFadeInSlope,
    regionFadeOutSlope,
    loopCrossfadeSlope,
    processing.eq,
    processing.gainDb,
    processing.channelMode,
    processing.pitchSemitones,
    tempFolder,
  ]);

  const handleRegionFileDragRequest = useCallback(
    (dragRegion: WaveformRegion) => {
      if (!displayAsset) return;
      setDragFailurePath(null);
      const fadeInSeconds = activeLoopCrossfadeSeconds
        ? 0
        : clampRegionFadeSeconds(dragRegion, regionFadeInSeconds);
      const fadeOutSeconds = activeLoopCrossfadeSeconds
        ? 0
        : clampRegionFadeSeconds(dragRegion, regionFadeOutSeconds);
      const hasRegionFades = fadeInSeconds > 0 || fadeOutSeconds > 0;
      const canNativeCut =
        normalizedFormat(displayAsset.format) === "wav" &&
        normalizedFormat(format) === "wav" &&
        processingIsNeutral(processing) &&
        !activeLoopCrossfadeSeconds &&
        !hasRegionFades;
      setExportStatus(
        canNativeCut
          ? "Preparing selected WAV cut for drag..."
          : "Rendering selected region for drag...",
      );
      setDragOverlay({
        message: canNativeCut ? "Preparing cut..." : "Rendering export...",
        x: window.innerWidth / 2,
        y: window.innerHeight - 180,
      });
      void (async () => {
        window.dispatchEvent(
          new CustomEvent("sonilabs:export-drag-active", {
            detail: { active: true },
          }),
        );
        try {
          const prepared = await prepareRegionDragFile({
            assetId: displayAsset.id,
            displayName: displayAsset.name,
            format,
            formatSettings: canNativeCut ? {} : formatSettings,
            gainDb: processing.gainDb,
            channelMode: processing.channelMode,
            eq: processing.eq,
            pitchSemitones: processing.pitchSemitones,
            loopCrossfadeSeconds: activeLoopCrossfadeSeconds || null,
            loopCrossfadeSlope,
            regionFadeGapSeconds,
            regionFadeInSeconds: fadeInSeconds || null,
            regionFadeInSlope,
            regionFadeOutSeconds: fadeOutSeconds || null,
            regionFadeOutSlope,
            region: dragRegion,
            tempFolder,
          });
          setDragOverlay(null);
          if (!prepared) {
            setExportStatus(
              "Region drag requires Tauri; browser cannot expose OS files.",
            );
            return;
          }
          const nativeDrag = await startPreparedFilesDrag([prepared.path], {
            preferNative: !canNativeCut,
          });
          if (!nativeDrag.ok) {
            if (nativeDrag.effect === "none") {
              await deletePreparedDragFiles([prepared.path]);
              setExportStatus(nativeDrag.error ?? "Native file drag cancelled.");
            } else {
              setDragFailurePath(prepared.path);
              setExportStatus(nativeDrag.error ?? "Native file drag failed.");
            }
            return;
          }
          if (nativeDrag.effect !== "copy") {
            await deletePreparedDragFiles([prepared.path]);
            setExportStatus("Native drag ended without copying.");
            return;
          }
          setExportStatus(
            `Dragged ${prepared.format.toUpperCase()} selected-region file.`,
          );
        } catch (error: unknown) {
          setExportStatus(
            error instanceof Error ? error.message : "Region drag export failed.",
          );
        } finally {
          setDragOverlay(null);
          window.dispatchEvent(
            new CustomEvent("sonilabs:export-drag-active", {
              detail: { active: false },
            }),
          );
        }
      })();
    },
    [
      activeLoopCrossfadeSeconds,
      displayAsset,
      format,
      formatSettings,
      loopCrossfadeSlope,
      processing,
      regionFadeGapSeconds,
      regionFadeInSlope,
      regionFadeInSeconds,
      regionFadeOutSlope,
      regionFadeOutSeconds,
      tempFolder,
    ],
  );

  const handleAssetFileDragRequest = useCallback(
    (detail: {
      assets: {
        assetId: string;
        displayName?: string;
        format?: string | null;
        provider?: string | null;
        availability?: string;
      }[];
      pointer?: { clientX: number; clientY: number };
    }) => {
      const assets = detail.assets.filter((asset) => asset.assetId);
      if (assets.length === 0) return;
      setDragFailurePath(null);
      const canPassthroughOriginal =
        processingIsNeutral(processing) &&
        assets.every(
          (asset) => normalizedFormat(asset.format) === normalizedFormat(format),
        );
      setExportStatus(
        canPassthroughOriginal
          ? `Starting ${assets.length} original-file drag...`
          : `Rendering ${assets.length} full-file ${
              assets.length === 1 ? "export" : "exports"
            } for drag...`,
      );
      setDragOverlay({
        message: canPassthroughOriginal ? "Starting drag..." : "Rendering export...",
        x: detail.pointer?.clientX ?? window.innerWidth / 2,
        y: detail.pointer?.clientY ?? window.innerHeight / 2,
      });
      if (assets.some((asset) => asset.provider && asset.provider !== "local")) {
        setExportStatus("Cloud asset drag/export is deferred in this build.");
        setDragOverlay(null);
        return;
      }
      void (async () => {
        window.dispatchEvent(
          new CustomEvent("sonilabs:export-drag-active", {
            detail: { active: true },
          }),
        );
        try {
          const prepared = [];
          for (const asset of assets) {
            const file = await prepareAssetDragFile({
              assetId: asset.assetId,
              displayName: asset.displayName,
              format,
              formatSettings: canPassthroughOriginal ? {} : formatSettings,
              gainDb: processing.gainDb,
              channelMode: processing.channelMode,
              eq: processing.eq,
              pitchSemitones: processing.pitchSemitones,
              region: null,
              tempFolder,
            });
            if (file) prepared.push(file);
          }
          setDragOverlay(null);
          if (prepared.length === 0) {
            setExportStatus(
              "File drag requires Tauri; browser cannot expose OS files.",
            );
            return;
          }
          const nativeDrag = await startPreparedFilesDrag(
            prepared.map((file) => file.path),
            { preferNative: !canPassthroughOriginal || prepared.length > 1 },
          );
          if (!nativeDrag.ok || nativeDrag.effect !== "copy") {
            setDragFailurePath(prepared[0]?.path ?? null);
            setExportStatus(
              nativeDrag.error ?? "Native file drag failed; temp file is ready.",
            );
            return;
          }
          setExportStatus(
            `Dragged ${prepared.length} ${format.toUpperCase()} full-file export${
              prepared.length === 1 ? "" : "s"
            }.`,
          );
        } catch (error: unknown) {
          setExportStatus(
            error instanceof Error ? error.message : "File drag export failed.",
          );
        } finally {
          setDragOverlay(null);
          window.dispatchEvent(
            new CustomEvent("sonilabs:export-drag-active", {
              detail: { active: false },
            }),
          );
        }
      })();
    },
    [format, formatSettings, processing, tempFolder],
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          assets: {
            assetId: string;
            displayName?: string;
            format?: string | null;
            provider?: string | null;
            availability?: string;
          }[];
          pointer?: { clientX: number; clientY: number };
        }>
      ).detail;
      if (!detail?.assets?.length) return;
      handleAssetFileDragRequest(detail);
    };
    window.addEventListener("sonilabs:asset-file-drag-request", handler);
    return () =>
      window.removeEventListener("sonilabs:asset-file-drag-request", handler);
  }, [handleAssetFileDragRequest]);

  return (
    <section className="col-span-2 col-start-2 row-start-2 border-t border-border bg-panel">
      {dragOverlay ? (
        <div
          className="pointer-events-none fixed z-[1000] rounded border border-border bg-black/90 px-2 py-1 text-[11px] text-foreground shadow-lg"
          style={{
            left: `${dragOverlay.x + 14}px`,
            top: `${dragOverlay.y + 14}px`,
          }}
        >
          {dragOverlay.message}
        </div>
      ) : null}
      <div className="flex h-[132px] bg-black/80">
        {displayAsset ? (
          <>
            <div className="min-w-0 flex-1">
              <WaveformCanvas
                assetId={displayAsset.id}
                channelMode={processing.channelMode}
                contentKey={contentKey}
                durationSeconds={
                  displayAsset.durationSeconds ?? activeResolution?.durationSeconds
                }
                loopCrossfadeDesiredSeconds={desiredLoopCrossfadeSeconds}
                loopCrossfadeEnabled={loopCrossfadeEnabled}
                loopCrossfadeSlope={loopCrossfadeSlope}
                loopCrossfadeSeconds={activeLoopCrossfadeSeconds}
                regionFadeGapSeconds={regionFadeGapSeconds}
                regionFadeInSeconds={activeRegionFadeInSeconds}
                regionFadeInSlope={regionFadeInSlope}
                regionFadeOutSeconds={activeRegionFadeOutSeconds}
                regionFadeOutSlope={regionFadeOutSlope}
                onLoopCrossfadeSlopeChange={handleLoopCrossfadeSlopeChange}
                onLoopCrossfadeSlopeCommit={handleLoopCrossfadeSlopeCommit}
                onLoopCrossfadeSecondsChange={handleLoopCrossfadeSecondsChange}
                onLoopCrossfadeSecondsCommit={handleLoopCrossfadeSecondsCommit}
                onRegionFadeGapChange={setRegionFadeGapSeconds}
                onRegionFadeChange={handleRegionFadeChange}
                onRegionFadeCommit={handleRegionFadeCommit}
                onRegionCommit={handleRegionCommit}
                onMeterChange={handleMeterChange}
                onChannelModeChange={(channelMode) => updateProcessing({ channelMode })}
                onRegionFileDragRequest={handleRegionFileDragRequest}
                onRegionChange={handleRegionChange}
                region={activeRegion}
                sampleRate={displayAsset.sampleRate}
              />
            </div>
            <OutputMeter meter={meter} />
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-center justify-center text-[12px] text-muted-foreground/70">
            Select a track to show waveform.
          </div>
        )}
      </div>
      <div className="flex h-16 items-center justify-between gap-3 border-t border-border bg-background px-3 text-[12px] text-muted-foreground">
        <div className="flex items-center gap-1 border-r border-border/70 pr-3">
          <Button
            className="size-8 p-0"
            onClick={() => previewAtIndex(neighborAssetIndex(-1))}
            size="icon"
            title="Previous"
            variant="ghost"
          >
            <SkipBack className="size-4" />
          </Button>
          <Button
            className="size-8 p-0"
            onClick={stopPreviewPlayback}
            size="icon"
            title="Stop"
            variant="ghost"
          >
            <Square className="size-3.5" />
          </Button>
          <Button
            className="size-9 p-0"
            onClick={() => {
              if (cancelCrossfadeRenderAutoplay()) return;
              if (audioPreviewService.getState().status === "playing") {
                pausePreviewPlayback();
                return;
              }
              if (activeRegion) {
                playSelectedRegion(activeRegion);
                return;
              }
              if (activeIndex >= 0)
                previewAtIndex(activeIndex, {
                  startSeconds: audioPreviewService.currentPlayheadSeconds(),
                });
              else audioPreviewService.play();
            }}
            size="icon"
            title={previewState.status === "playing" ? "Pause" : "Play"}
            variant="default"
          >
            {previewState.status === "playing" ? (
              <Pause className="size-4" />
            ) : (
              <Play className="size-4 fill-current" />
            )}
          </Button>
          <Button
            className="size-8 p-0"
            onClick={() => previewAtIndex(neighborAssetIndex(1))}
            size="icon"
            title="Next"
            variant="ghost"
          >
            <SkipForward className="size-4" />
          </Button>
          <Button
            aria-pressed={effectiveLoopEnabled}
            className={cn(
              "size-8 p-0",
              effectiveLoopEnabled && "bg-primary text-primary-foreground",
            )}
            onClick={() => updateLoopEnabled(!effectiveLoopEnabled)}
            size="icon"
            title={
              effectiveLoopEnabled
                ? "Disable loop"
                : activeRegion
                  ? "Loop selected region"
                  : "Loop file"
            }
            variant="ghost"
          >
            <Repeat2 className="size-4" />
          </Button>
          <Button
            aria-pressed={loopCrossfadeEnabled}
            className={cn(
              "size-8 p-0",
              loopCrossfadeEnabled && "bg-primary text-primary-foreground",
            )}
            disabled={!activeRegion}
            onClick={toggleLoopCrossfade}
            size="icon"
            title="Crossfade loop selection"
            variant="ghost"
          >
            <Repeat2 className="size-4 rotate-90" />
          </Button>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 border-r border-border/70 px-3">
          <select
            className={cn(compactSelectClass, "w-16 px-1")}
            onChange={(event) =>
              updateProcessing({ playbackRate: Number(event.target.value) })
            }
            title="Playback speed"
            value={processing.playbackRate}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <option key={rate} value={rate}>
                {rate}x
              </option>
            ))}
          </select>
          <Button
            aria-pressed={processing.mode === "processed"}
            className="h-7 px-2 text-[11px]"
            onClick={() =>
              updateProcessing({
                mode: processing.mode === "processed" ? "original" : "processed",
              })
            }
            size="sm"
            title="A/B original and processed effects"
            variant={processing.mode === "processed" ? "default" : "ghost"}
          >
            {processing.mode === "processed" ? "B" : "A"}
          </Button>
          <Button
            className="size-7 p-0"
            onClick={() => updateProcessing({ muted: !processing.muted })}
            size="icon"
            title={processing.muted ? "Unmute" : "Mute"}
            variant="ghost"
          >
            {processing.muted ? (
              <VolumeX className="size-4" />
            ) : (
              <Volume2 className="size-4" />
            )}
          </Button>
          <input
            className="h-1.5 w-24 accent-primary"
            max={1}
            min={0}
            onChange={(event) =>
              updateProcessing({ outputVolume: Number(event.target.value) })
            }
            step={0.01}
            title="Output volume"
            type="range"
            value={processing.outputVolume}
          />
          <span className="w-9 text-right font-mono text-[10px] text-foreground">
            {Math.round(processing.outputVolume * 100)}%
          </span>
          <span
            className="relative min-w-0 flex-1 overflow-hidden rounded-sm px-1 py-0.5 text-[11px]"
            title={exportStatus ?? undefined}
          >
            {crossfadeRenderProgress !== null ? (
              <span
                className="absolute inset-y-0 left-0 bg-primary/25"
                style={{ width: `${crossfadeRenderProgress}%` }}
              />
            ) : null}
            <span className="relative truncate">
              {crossfadeRenderProgress !== null
                ? `${crossfadeRenderProgress}% ${exportStatus ?? ""}`
                : exportStatus}
            </span>
          </span>
          {runtimeStatus &&
          (runtimeStatus.waveformActive > 0 || runtimeStatus.waveformQueueDepth > 0) ? (
            <span
              className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
              title="Waveform worker status"
            >
              wf {runtimeStatus.waveformActive}/{runtimeStatus.waveformMaxActive}
              {runtimeStatus.waveformQueueDepth > 0
                ? ` q${runtimeStatus.waveformQueueDepth}`
                : ""}
            </span>
          ) : null}
          {dragFailurePath ? (
            <Button
              className="h-7 gap-1 px-2 text-[11px]"
              onClick={() => void revealPreparedRegionDragFile(dragFailurePath)}
              size="sm"
              title="Reveal prepared region file"
              variant="secondary"
            >
              <FolderOpen className="size-3.5" />
              Reveal
            </Button>
          ) : null}
          <div className="hidden min-w-40 max-w-72 items-center gap-1 overflow-hidden xl:flex">
            {exportJobs.slice(0, 3).map((job) => (
              <button
                className={cn(
                  "flex h-7 min-w-0 items-center gap-1 rounded-sm border px-1.5 text-[10px]",
                  job.status === "failed"
                    ? "border-destructive/60 text-destructive"
                    : "border-border text-muted-foreground",
                )}
                key={job.id}
                onClick={() => job.status === "failed" && handleRetryExport(job.id)}
                title={job.errorMessage ?? job.outputPath ?? job.id}
                type="button"
              >
                {job.status === "failed" ? <AlertCircle className="size-3" /> : null}
                <span className="truncate">{job.format.toUpperCase()}</span>
                <span>{job.status}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2 pl-1">
          <div className="relative">
            <Button
              aria-expanded={gainBoostOpen}
              className="h-8 gap-1 px-2 text-[11px]"
              onClick={() => modalManager.toggle("gain-boost")}
              size="sm"
              title="Gain boost"
              variant={gainBoostOpen ? "default" : "ghost"}
            >
              <Gauge className="size-3.5" />
              <ChevronRight
                className={cn(
                  "size-3 transition-transform",
                  gainBoostOpen && "rotate-90",
                )}
              />
            </Button>
            {gainBoostOpen ? (
              <div className="absolute bottom-10 right-0 z-20 flex w-[320px] items-center gap-3 rounded-md border border-border bg-panel p-2 shadow-xl">
                <span className="whitespace-nowrap text-[11px] font-medium text-foreground">
                  Gain Boost
                </span>
                <input
                  className="h-1.5 min-w-0 flex-1 accent-primary"
                  max={36}
                  min={-24}
                  onChange={(event) => updateGain(Number(event.target.value))}
                  onKeyDown={handleGainSpace}
                  step={0.1}
                  title="Preview and export gain boost"
                  type="range"
                  value={processing.gainDb}
                />
                <input
                  className={cn(compactInputClass, "w-16 px-1 text-right font-mono")}
                  max={36}
                  min={-24}
                  onChange={(event) => updateGain(Number(event.target.value))}
                  onKeyDown={handleGainSpace}
                  step={0.1}
                  title="Gain boost dB"
                  type="number"
                  value={Number(processing.gainDb.toFixed(1))}
                />
                <Button
                  className="size-7 p-0"
                  onClick={() => updateGain(0)}
                  size="icon"
                  title="Reset gain boost"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
          <div className="relative">
            <Button
              aria-expanded={equalizerOpen}
              aria-pressed={eqActive}
              className="h-8 gap-1 px-2 text-[11px]"
              onClick={() => modalManager.toggle("equalizer")}
              size="sm"
              title="Equalizer"
              variant={equalizerOpen || eqActive ? "default" : "ghost"}
            >
              <SlidersHorizontal className="size-3.5" />
              EQ
            </Button>
            {equalizerOpen ? (
              <div className="absolute bottom-10 right-0 z-20 grid w-[340px] grid-cols-[44px_minmax(0,1fr)_64px_28px] items-center gap-2 rounded-md border border-border bg-panel p-2 shadow-xl">
                {eqBands.map((band) => (
                  <Fragment key={band.key}>
                    <span className="text-[11px] font-medium text-foreground">
                      {band.label}
                    </span>
                    <input
                      className="h-1.5 min-w-0 accent-primary"
                      max={12}
                      min={-12}
                      onChange={(event) =>
                        updateEqBand(band.key, Number(event.target.value))
                      }
                      onKeyDown={handleGainSpace}
                      step={0.1}
                      title={band.title}
                      type="range"
                      value={processing.eq[band.key]}
                    />
                    <input
                      className={cn(
                        compactInputClass,
                        "w-16 px-1 text-right font-mono",
                      )}
                      max={12}
                      min={-12}
                      onChange={(event) =>
                        updateEqBand(band.key, Number(event.target.value))
                      }
                      onKeyDown={handleGainSpace}
                      step={0.1}
                      title={`${band.title} dB`}
                      type="number"
                      value={Number(processing.eq[band.key].toFixed(1))}
                    />
                    {band.key === "lowDb" ? (
                      <Button
                        className="size-7 p-0"
                        onClick={resetEq}
                        size="icon"
                        title="Reset equalizer"
                        variant="ghost"
                      >
                        <RotateCcw className="size-3.5" />
                      </Button>
                    ) : (
                      <span />
                    )}
                  </Fragment>
                ))}
              </div>
            ) : null}
          </div>
          <div className="relative">
            <Button
              aria-expanded={pitchOpen}
              aria-pressed={pitchActive}
              className="h-8 gap-1 px-2 text-[11px]"
              onClick={() => modalManager.toggle("pitch")}
              size="sm"
              title="Pitch"
              variant={pitchOpen || pitchActive ? "default" : "ghost"}
            >
              <Music2 className="size-3.5" />
              Pitch
            </Button>
            {pitchOpen ? (
              <div className="absolute bottom-10 right-0 z-20 flex w-[300px] items-center gap-3 rounded-md border border-border bg-panel p-2 shadow-xl">
                <span className="whitespace-nowrap text-[11px] font-medium text-foreground">
                  Pitch
                </span>
                <input
                  className="h-1.5 min-w-0 flex-1 accent-primary"
                  max={12}
                  min={-12}
                  onChange={(event) => updatePitch(Number(event.target.value))}
                  onKeyDown={handleGainSpace}
                  step={0.1}
                  title="Preview and export pitch"
                  type="range"
                  value={processing.pitchSemitones}
                />
                <input
                  className={cn(compactInputClass, "w-16 px-1 text-right font-mono")}
                  max={12}
                  min={-12}
                  onChange={(event) => updatePitch(Number(event.target.value))}
                  onKeyDown={handleGainSpace}
                  step={0.1}
                  title="Pitch semitones"
                  type="number"
                  value={Number(processing.pitchSemitones.toFixed(1))}
                />
                <Button
                  className="size-7 p-0"
                  onClick={() => updatePitch(0)}
                  size="icon"
                  title="Reset pitch"
                  variant="ghost"
                >
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
          <div className="relative">
            <Button
              aria-expanded={exportSettingsOpen}
              className="size-8 p-0"
              onClick={() => modalManager.toggle("export-settings")}
              size="icon"
              title="Export settings"
              variant={exportSettingsOpen ? "default" : "ghost"}
            >
              <Settings2 className="size-3.5" />
            </Button>
            {exportSettingsOpen ? (
              <div className="absolute bottom-10 right-0 z-20 grid w-[520px] grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-lg border border-border bg-panel p-3 text-[11px] shadow-xl">
                <span className="self-center text-muted-foreground">Folder</span>
                <div className="flex min-w-0 gap-2">
                  <Button
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={handlePickOutputFolder}
                    size="sm"
                    title="Pick output folder"
                    variant="secondary"
                  >
                    <FolderOpen className="size-3.5" />
                    Pick
                  </Button>
                  <input
                    className={cn(compactInputClass, "min-w-0 flex-1 font-mono")}
                    onChange={(event) => setOutputFolder(event.target.value)}
                    title="Output folder"
                    value={outputFolder}
                  />
                </div>
                <span className="self-center text-muted-foreground">Temp</span>
                <div className="flex min-w-0 gap-2">
                  <Button
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={handlePickTempFolder}
                    size="sm"
                    title="Pick temporary drag export folder"
                    variant="secondary"
                  >
                    <FolderOpen className="size-3.5" />
                    Pick
                  </Button>
                  <input
                    className={cn(compactInputClass, "min-w-0 flex-1 font-mono")}
                    onChange={(event) => updateTempFolder(event.target.value)}
                    placeholder="System temp"
                    title="Temporary drag export folder"
                    value={tempFolder}
                  />
                </div>
                <span className="self-center text-muted-foreground">Pattern</span>
                <input
                  className={cn(compactInputClass, "font-mono")}
                  onChange={(event) => setFilenamePattern(event.target.value)}
                  title="Filename pattern"
                  value={filenamePattern}
                />
                <span className="self-center text-muted-foreground">Options</span>
                <div className="flex items-center gap-2">
                  <select
                    className={cn(compactSelectClass, "w-24 px-1")}
                    onChange={(event) =>
                      setExportScope(event.target.value as "full" | "region")
                    }
                    title="Export scope"
                    value={exportScope}
                  >
                    <option value="full">Full</option>
                    <option value="region" disabled={!activeRegion}>
                      Region
                    </option>
                  </select>
                  <select
                    className={cn(compactSelectClass, "w-24 px-1")}
                    onChange={(event) =>
                      setOverwriteMode(
                        event.target.value as "skip" | "replace" | "rename",
                      )
                    }
                    title="Overwrite behavior"
                    value={overwriteMode}
                  >
                    <option value="rename">Rename</option>
                    <option value="skip">Skip</option>
                    <option value="replace">Replace</option>
                  </select>
                  <label className="flex items-center gap-1 whitespace-nowrap">
                    <input
                      checked={preserveFolders}
                      onChange={(event) => setPreserveFolders(event.target.checked)}
                      type="checkbox"
                    />
                    Folders
                  </label>
                  <label className="flex items-center gap-1 whitespace-nowrap">
                    <input
                      checked={includeSidecar}
                      onChange={(event) => setIncludeSidecar(event.target.checked)}
                      type="checkbox"
                    />
                    License
                  </label>
                </div>
                <span className="self-center text-muted-foreground">Quality</span>
                <select
                  className={cn(compactSelectClass, "w-28 px-1")}
                  onChange={(event) => setFormatQuality(Number(event.target.value))}
                  title="Format setting"
                  value={formatQuality}
                >
                  {format === "WAV"
                    ? [16, 24, 32].map((value) => <option key={value}>{value}</option>)
                    : format === "OGG"
                      ? [3, 5, 7, 9].map((value) => (
                          <option key={value}>{value}</option>
                        ))
                      : format === "FLAC"
                        ? [3, 5, 8, 12].map((value) => (
                            <option key={value}>{value}</option>
                          ))
                        : [128, 192, 256, 320].map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                </select>
              </div>
            ) : null}
          </div>
          <label className="sr-only" htmlFor="bottom-export-format">
            Export format
          </label>
          <select
            className="h-8 w-24 min-w-24 rounded-md border border-input bg-black py-0 pl-2 pr-8 text-[12px] text-foreground outline-none focus-visible:border-primary"
            id="bottom-export-format"
            onChange={(event) => {
              const nextFormat = event.target.value;
              setFormat(nextFormat);
              setFormatQuality(
                nextFormat === "WAV"
                  ? 16
                  : nextFormat === "OGG"
                    ? 5
                    : nextFormat === "FLAC"
                      ? 5
                      : 192,
              );
            }}
            value={format}
          >
            {exportFormats.map((nextFormat) => (
              <option key={nextFormat} value={nextFormat}>
                {nextFormat}
              </option>
            ))}
          </select>
          <Button
            aria-pressed={isSummaryOpen}
            className="size-8 p-0"
            onClick={onToggleSummary}
            size="icon"
            title="Toggle file summary"
            variant={isSummaryOpen ? "default" : "ghost"}
          >
            <Info className="size-3.5" />
          </Button>
          <Button
            className="h-8 gap-1.5 px-2"
            onClick={handleExport}
            size="sm"
            title={
              activeRegion ? "Queue selected region export" : "Queue full file export"
            }
            variant="secondary"
          >
            <Download className="size-3.5" />
            Export
          </Button>
        </div>
      </div>
    </section>
  );
}
