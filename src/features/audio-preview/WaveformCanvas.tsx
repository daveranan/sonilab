import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";

import {
  cancelAudioJob,
  getCachedWaveformPeakRange,
  getCachedWaveformPeaks,
  getWaveformPeaks,
} from "./commands";
import { processedGain } from "./audioMath";
import { audioPreviewService, type OutputMeterSnapshot } from "./previewService";
import { formatAudioTimeParts } from "@/lib/timeFormat";
import type {
  WaveformPeakChannel,
  WaveformPeakData,
  WaveformRegion,
  WaveformViewport,
} from "./types";
import {
  fitViewport,
  normalizeRegion,
  panViewport,
  secondsToX,
  xToSeconds,
  zoomViewport,
} from "./waveformMath";

type WaveformCanvasProps = {
  assetId: string | null;
  contentKey: string | null;
  durationSeconds?: number | null;
  loopCrossfadeDesiredSeconds?: number;
  loopCrossfadeEnabled?: boolean;
  loopCrossfadeSlope?: number;
  loopCrossfadeSeconds?: number;
  regionFadeGapSeconds?: number;
  regionFadeInSeconds?: number;
  regionFadeInSlope?: number;
  regionFadeOutSeconds?: number;
  regionFadeOutSlope?: number;
  onRegionFadeGapChange?: (seconds: number) => void;
  onLoopCrossfadeSlopeChange?: (slope: number) => void;
  onLoopCrossfadeSlopeCommit?: (slope: number) => void;
  onLoopCrossfadeSecondsChange?: (seconds: number) => void;
  onLoopCrossfadeSecondsCommit?: (seconds: number) => void;
  onRegionFadeChange?: (fade: RegionFadeSettings) => void;
  onRegionFadeCommit?: (fade: RegionFadeSettings) => void;
  region: WaveformRegion | null;
  sampleRate?: number | null;
  onRegionCommit: (region: WaveformRegion) => void;
  onRegionChange: (region: WaveformRegion | null) => void;
  onRegionFileDragRequest: (region: WaveformRegion) => void;
  onMeterChange?: (meter: OutputMeterSnapshot) => void;
};

type RegionFadeSettings = {
  fadeInSeconds: number;
  fadeOutSeconds: number;
  fadeInSlope?: number;
  fadeOutSlope?: number;
};

type DragState = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startSeconds: number;
  startedAt: number;
  regionAtStart: WaveformRegion | null;
  crossfadeSideAtStart?: "left" | "right";
  fileDragStarted?: boolean;
  mode:
    | "select"
    | "pan"
    | "resize-start"
    | "resize-end"
    | "crossfade-left"
    | "crossfade-right"
    | "crossfade-slope"
    | "fade-in"
    | "fade-in-slope"
    | "fade-out"
    | "fade-out-slope"
    | "seek"
    | "file-drag";
};

const resizeHandleHitPixels = 12;
const crossfadeHandleHitPixels = 8;
const crossfadeSlopeHandleHitPixels = 11;
const edgeFadeHitHeightPixels = 34;
const minLoopCrossfadeSlope = 0.25;
const maxLoopCrossfadeSlope = 4;
const minLoopCrossfadeSeconds = 0.005;
const fadeHandleHitPixels = 16;
const fadeCreationZonePixels = 46;
const minRegionFadeGapSeconds = 0;
const maxRegionFadeGapSeconds = 0.05;
const defaultRegionFadeGapSeconds = 0.005;
const fileDragHorizontalGuardPixels = 72;
const fileDragVerticalGuardPixels = 20;
const fileDragThresholdPixels = 24;
const fileDragMinimumAgeMs = 120;
const minVerticalZoom = 0.5;
const maxVerticalZoom = 8;
const coldWaveformDelayMs = 120;
const waveformRetryDelaysMs = [250, 800, 1800];
const zoomWaveformDelayMs = 90;
const minimumWaveformPeakTarget = 4096;
const waveformPeaksPerPixel = 4;
const maximumWaveformPeakTarget = 32_000;
const waveformRangePaddingSeconds = 0.05;

function samplesPerPeakForDisplay(
  durationSeconds: number,
  sampleRate: number,
  width: number,
  horizontalZoom = 1,
) {
  const estimatedSamples =
    durationSeconds > 0 && sampleRate > 0 ? durationSeconds * sampleRate : 48_000 * 4;
  const peakTarget = Math.min(
    maximumWaveformPeakTarget,
    Math.max(
      minimumWaveformPeakTarget,
      Math.ceil(width * waveformPeaksPerPixel * horizontalZoom),
    ),
  );
  return Math.max(1, Math.floor(estimatedSamples / peakTarget));
}

function waveformPeaksCoverRange(
  peaks: WaveformPeakData,
  startSeconds: number,
  endSeconds: number,
) {
  const peakStartSeconds = peaks.peakStartSeconds;
  const peakEndSeconds = peaks.peakEndSeconds;
  if (peakStartSeconds === undefined || peakEndSeconds === undefined) return true;
  return (
    startSeconds >= peakStartSeconds - waveformRangePaddingSeconds &&
    endSeconds <= peakEndSeconds + waveformRangePaddingSeconds
  );
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

export function WaveformCanvas({
  assetId,
  contentKey,
  durationSeconds,
  loopCrossfadeDesiredSeconds = 0,
  loopCrossfadeEnabled = false,
  loopCrossfadeSlope = 1,
  loopCrossfadeSeconds = 0,
  regionFadeGapSeconds = defaultRegionFadeGapSeconds,
  regionFadeInSeconds = 0,
  regionFadeInSlope = 1,
  regionFadeOutSeconds = 0,
  regionFadeOutSlope = 1,
  onLoopCrossfadeSlopeChange,
  onRegionFadeGapChange,
  onLoopCrossfadeSlopeCommit,
  onRegionCommit,
  onMeterChange,
  onRegionFadeChange,
  onRegionFadeCommit,
  onLoopCrossfadeSecondsChange,
  onLoopCrossfadeSecondsCommit,
  onRegionFileDragRequest,
  region,
  sampleRate,
  onRegionChange,
}: WaveformCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const peakDataRef = useRef<WaveformPeakData | null>(null);
  const regionRef = useRef<WaveformRegion | null>(region);
  const viewportRef = useRef<WaveformViewport>(fitViewport(1, 1));
  const loadedAssetIdRef = useRef<string | null>(null);
  const verticalZoomRef = useRef(1);
  const activeChannelIndexesRef = useRef<number[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const committedRegionKeyRef = useRef<string | null>(null);
  const waveformResolutionTimerRef = useRef<number | null>(null);
  const waveformResolutionKeyRef = useRef<string | null>(null);
  const waveformResolutionInFlightRef = useRef(false);
  const activeWaveformJobRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastMeterKeyRef = useRef("");
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [clippingMarkerCount, setClippingMarkerCount] = useState(0);
  const [cursor, setCursor] = useState("crosshair");
  const [channelCount, setChannelCount] = useState(0);
  const [peakDurationSeconds, setPeakDurationSeconds] = useState<number | null>(null);
  const [activeChannelIndexes, setActiveChannelIndexes] = useState<number[]>([]);
  const [horizontalZoomValue, setHorizontalZoomValue] = useState(1);
  const [verticalZoomValue, setVerticalZoomValue] = useState(1);
  const [playheadAnimating, setPlayheadAnimating] = useState(
    () => audioPreviewService.getState().status === "playing",
  );
  const [zoomLabels, setZoomLabels] = useState({
    horizontal: "1.0x",
    vertical: "1.0x",
  });

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const peakData = peakDataRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#050505";
    context.fillRect(0, 0, width, height);

    if (!peakData) {
      const duration = Math.max(1, audioPreviewService.getState().durationSeconds);
      const playheadX =
        (audioPreviewService.currentPlayheadSeconds() / duration) * width;
      context.fillStyle = "rgba(255,255,255,0.9)";
      context.fillRect(playheadX, 0, 1, height);
      onMeterChange?.({
        available: false,
        peakDb: null,
        rmsDb: null,
        level: 0,
      });
      return;
    }

    const viewport = viewportRef.current;
    const verticalZoom = verticalZoomRef.current;
    const activeIndexes =
      activeChannelIndexesRef.current.length > 0
        ? activeChannelIndexesRef.current
        : peakData.channels.map((_, index) => index);
    const visibleChannels = activeIndexes
      .map((index) => ({ channel: peakData.channels[index], index }))
      .filter((entry): entry is { channel: WaveformPeakChannel; index: number } =>
        Boolean(entry.channel),
      );
    const channelHeight = height / Math.max(1, visibleChannels.length);

    visibleChannels.forEach(({ channel }, channelIndex) => {
      const top = channelIndex * channelHeight;
      const centerY = top + channelHeight / 2;
      drawFilledWaveformChannel(
        context,
        channel,
        peakData,
        viewport,
        width,
        centerY,
        channelHeight,
        verticalZoom,
      );
      context.strokeStyle = "rgba(255,255,255,0.08)";
      context.beginPath();
      context.moveTo(0, centerY);
      context.lineTo(width, centerY);
      context.stroke();
    });

    const currentRegion = regionRef.current;
    if (currentRegion) {
      const startX = secondsToX(currentRegion.startSeconds, viewport, width);
      const endX = secondsToX(currentRegion.endSeconds, viewport, width);
      context.fillStyle = "rgba(255, 255, 255, 0.12)";
      context.fillRect(startX, 0, endX - startX, height);
      if (!loopCrossfadeEnabled) {
        drawRegionFadeOverlay(
          context,
          currentRegion,
          viewport,
          width,
          height,
          regionFadeInSeconds,
          regionFadeInSlope,
          regionFadeOutSeconds,
          regionFadeOutSlope,
          regionFadeGapSeconds,
        );
      }
      if (loopCrossfadeEnabled && loopCrossfadeSeconds > 0) {
        drawLoopCrossfadeOverlay(
          context,
          currentRegion,
          viewport,
          width,
          height,
          loopCrossfadeSeconds,
          loopCrossfadeDesiredSeconds,
          loopCrossfadeSlope,
        );
      }
      context.strokeStyle = "rgba(255, 255, 255, 0.95)";
      context.lineWidth = 2;
      context.strokeRect(startX + 1, 1, Math.max(0, endX - startX - 2), height - 2);
      context.fillStyle = "rgba(230, 242, 255, 0.95)";
      context.fillRect(startX - 2, 0, 4, height);
      context.fillRect(endX - 2, 0, 4, height);
      context.lineWidth = 1;
    }

    context.fillStyle = "rgba(239, 68, 68, 0.82)";
    for (const marker of peakData.clippingMarkers) {
      const x = secondsToX(marker.seconds, viewport, width);
      context.fillRect(x, 0, 1, 8);
      context.fillRect(x, height - 8, 1, 8);
    }

    const playheadSeconds = audioPreviewService.currentPlayheadSeconds();
    const meter = waveformMeterSnapshot(peakData, playheadSeconds);
    const meterKey = `${meter.available}:${meter.level.toFixed(3)}:${meter.peakDb?.toFixed(1) ?? "null"}`;
    if (meterKey !== lastMeterKeyRef.current) {
      lastMeterKeyRef.current = meterKey;
      onMeterChange?.(meter);
    }
    const playheadX = secondsToX(playheadSeconds, viewport, width);
    if (currentRegion && loopCrossfadeEnabled && loopCrossfadeSeconds > 0) {
      drawCrossfadeGhostPlayhead(
        context,
        currentRegion,
        viewport,
        width,
        height,
        loopCrossfadeSeconds,
        playheadSeconds,
      );
    }
    context.fillStyle = "rgba(255,255,255,0.9)";
    context.fillRect(playheadX, 0, 1, height);
  }, [
    loopCrossfadeDesiredSeconds,
    loopCrossfadeEnabled,
    loopCrossfadeSlope,
    loopCrossfadeSeconds,
    onMeterChange,
    regionFadeInSeconds,
    regionFadeInSlope,
    regionFadeOutSeconds,
    regionFadeOutSlope,
    regionFadeGapSeconds,
  ]);

  useEffect(() => {
    activeChannelIndexesRef.current = activeChannelIndexes;
    redraw();
  }, [activeChannelIndexes, redraw]);

  const pointerSeconds = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return xToSeconds(event.clientX - rect.left, viewportRef.current, rect.width);
  }, []);

  const syncZoomLabels = useCallback(() => {
    const peaks = peakDataRef.current;
    const viewport = viewportRef.current;
    const visibleSpan = viewport.visibleEndSeconds - viewport.visibleStartSeconds;
    const horizontal = peaks
      ? Math.max(1, peaks.durationSeconds / Math.max(0.001, visibleSpan))
      : 1;
    setHorizontalZoomValue(Number(horizontal.toFixed(2)));
    setVerticalZoomValue(Number(verticalZoomRef.current.toFixed(2)));
    setZoomLabels({
      horizontal: `${horizontal.toFixed(1)}x`,
      vertical: `${verticalZoomRef.current.toFixed(1)}x`,
    });
  }, []);

  const zoomHorizontal = useCallback(
    (factor: number) => {
      const peaks = peakDataRef.current;
      const canvas = canvasRef.current;
      if (!peaks || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const playheadX = secondsToX(
        audioPreviewService.currentPlayheadSeconds(),
        viewportRef.current,
        rect.width,
      );
      viewportRef.current = zoomViewport(
        viewportRef.current,
        peaks.durationSeconds,
        rect.width,
        playheadX >= 0 && playheadX <= rect.width ? playheadX : rect.width / 2,
        factor,
      );
      syncZoomLabels();
      redraw();
    },
    [redraw, syncZoomLabels],
  );

  const zoomVertical = useCallback(
    (factor: number) => {
      verticalZoomRef.current = Math.max(
        minVerticalZoom,
        Math.min(maxVerticalZoom, verticalZoomRef.current * factor),
      );
      syncZoomLabels();
      redraw();
    },
    [redraw, syncZoomLabels],
  );

  const setHorizontalZoomLevel = useCallback(
    (zoom: number) => {
      const peaks = peakDataRef.current;
      const canvas = canvasRef.current;
      if (!peaks || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const viewport = viewportRef.current;
      const currentZoom =
        peaks.durationSeconds /
        Math.max(0.001, viewport.visibleEndSeconds - viewport.visibleStartSeconds);
      const nextZoom = Math.max(1, Math.min(20, zoom));
      viewportRef.current = zoomViewport(
        viewport,
        peaks.durationSeconds,
        rect.width,
        rect.width / 2,
        nextZoom / Math.max(0.001, currentZoom),
      );
      setHorizontalZoomValue(nextZoom);
      syncZoomLabels();
      redraw();
    },
    [redraw, syncZoomLabels],
  );

  const setVerticalZoomLevel = useCallback(
    (zoom: number) => {
      verticalZoomRef.current = Math.max(
        minVerticalZoom,
        Math.min(maxVerticalZoom, zoom),
      );
      setVerticalZoomValue(verticalZoomRef.current);
      syncZoomLabels();
      redraw();
    },
    [redraw, syncZoomLabels],
  );

  const applyPeakData = useCallback(
    (peaks: WaveformPeakData, options?: { preserveViewport?: boolean }) => {
      peakDataRef.current = peaks;
      loadedAssetIdRef.current = peaks.assetId;
      const channels = peaks.channels.map((_, index) => index);
      activeChannelIndexesRef.current = channels;
      setActiveChannelIndexes(channels);
      setChannelCount(peaks.channels.length);
      setClippingMarkerCount(peaks.clippingMarkers.length);
      setPeakDurationSeconds(peaks.durationSeconds);
      const width = canvasRef.current?.getBoundingClientRect().width ?? 1;
      if (!options?.preserveViewport) {
        viewportRef.current = fitViewport(peaks.durationSeconds, width);
      }
      setStatus("ready");
      syncZoomLabels();
      redraw();
    },
    [redraw, syncZoomLabels],
  );

  const scheduleWaveformResolution = useCallback(() => {
    const canvas = canvasRef.current;
    const peaks = peakDataRef.current;
    if (!assetId || !contentKey || !canvas || !peaks) return;
    const rect = canvas.getBoundingClientRect();
    const visibleSpan = Math.max(
      0.001,
      viewportRef.current.visibleEndSeconds - viewportRef.current.visibleStartSeconds,
    );
    const visibleStartSeconds = viewportRef.current.visibleStartSeconds;
    const visibleEndSeconds = viewportRef.current.visibleEndSeconds;
    const currentCoversVisibleRange = waveformPeaksCoverRange(
      peaks,
      visibleStartSeconds,
      visibleEndSeconds,
    );
    const horizontalZoom = Math.max(1, peaks.durationSeconds / visibleSpan);
    const targetSamplesPerPeak = samplesPerPeakForDisplay(
      peaks.durationSeconds,
      peaks.sampleRate || sampleRate || 0,
      rect.width,
      horizontalZoom,
    );
    if (
      currentCoversVisibleRange &&
      peaks.samplesPerPeak <= targetSamplesPerPeak * 1.25
    ) {
      return;
    }
    const requestKey = [
      assetId,
      contentKey,
      "source",
      targetSamplesPerPeak,
      visibleStartSeconds.toFixed(3),
      visibleEndSeconds.toFixed(3),
    ].join(":");
    if (waveformResolutionKeyRef.current === requestKey) return;
    if (waveformResolutionTimerRef.current !== null) {
      window.clearTimeout(waveformResolutionTimerRef.current);
    }
    waveformResolutionTimerRef.current = window.setTimeout(() => {
      waveformResolutionTimerRef.current = null;
      if (waveformResolutionInFlightRef.current && activeWaveformJobRef.current) {
        void cancelAudioJob(activeWaveformJobRef.current);
      }
      waveformResolutionKeyRef.current = requestKey;
      waveformResolutionInFlightRef.current = true;
      activeWaveformJobRef.current = `waveform:${assetId}`;
      void (async () => {
        const cachedRangePeaks = await getCachedWaveformPeakRange(
          assetId,
          contentKey,
          "source",
          targetSamplesPerPeak,
          visibleStartSeconds,
          visibleEndSeconds,
        );
        if (cachedRangePeaks) return cachedRangePeaks;
        const refinedPeaks = await getWaveformPeaks(
          assetId,
          contentKey,
          "source",
          targetSamplesPerPeak,
        );
        return (
          (await getCachedWaveformPeakRange(
            assetId,
            contentKey,
            "source",
            targetSamplesPerPeak,
            visibleStartSeconds,
            visibleEndSeconds,
          )) ?? refinedPeaks
        );
      })()
        .then((refinedPeaks) => {
          if (
            waveformResolutionKeyRef.current !== requestKey ||
            refinedPeaks.assetId !== assetId ||
            refinedPeaks.contentKey !== contentKey
          ) {
            return;
          }
          const currentPeaks = peakDataRef.current;
          const refinedCoversVisibleRange = waveformPeaksCoverRange(
            refinedPeaks,
            visibleStartSeconds,
            visibleEndSeconds,
          );
          const currentStillCoversVisibleRange =
            currentPeaks &&
            waveformPeaksCoverRange(
              currentPeaks,
              visibleStartSeconds,
              visibleEndSeconds,
            );
          if (
            refinedCoversVisibleRange &&
            (!currentPeaks ||
              !currentStillCoversVisibleRange ||
              refinedPeaks.samplesPerPeak < currentPeaks.samplesPerPeak)
          ) {
            applyPeakData(refinedPeaks, { preserveViewport: true });
          }
        })
        .catch(() => {
          if (waveformResolutionKeyRef.current === requestKey) {
            waveformResolutionKeyRef.current = null;
          }
        })
        .finally(() => {
          if (waveformResolutionKeyRef.current === requestKey) {
            waveformResolutionInFlightRef.current = false;
            activeWaveformJobRef.current = null;
          }
        });
    }, zoomWaveformDelayMs);
  }, [applyPeakData, assetId, contentKey, sampleRate]);

  useEffect(() => {
    scheduleWaveformResolution();
  }, [horizontalZoomValue, scheduleWaveformResolution]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const handleWheel = (event: WheelEvent) => {
      const peaks = peakDataRef.current;
      if (!peaks) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        viewportRef.current = panViewport(
          viewportRef.current,
          peaks.durationSeconds,
          rect.width,
          event.deltaX || event.deltaY,
        );
      } else {
        viewportRef.current = zoomViewport(
          viewportRef.current,
          peaks.durationSeconds,
          rect.width,
          event.clientX - rect.left,
          event.deltaY < 0 ? 1.25 : 0.8,
        );
      }
      syncZoomLabels();
      redraw();
      scheduleWaveformResolution();
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [redraw, scheduleWaveformResolution, syncZoomLabels]);

  useEffect(() => {
    regionRef.current = region;
    if (!region) committedRegionKeyRef.current = null;
    redraw();
  }, [redraw, region]);

  useEffect(() => {
    let cancelled = false;
    const sameAsset = Boolean(assetId && loadedAssetIdRef.current === assetId);
    if (activeWaveformJobRef.current) {
      void cancelAudioJob(activeWaveformJobRef.current);
      activeWaveformJobRef.current = null;
    }
    waveformResolutionKeyRef.current = null;
    waveformResolutionInFlightRef.current = false;
    if (waveformResolutionTimerRef.current !== null) {
      window.clearTimeout(waveformResolutionTimerRef.current);
      waveformResolutionTimerRef.current = null;
    }
    const width = canvasRef.current?.getBoundingClientRect().width ?? 1200;
    const knownDuration = Math.max(
      0.001,
      durationSeconds ?? audioPreviewService.getState().durationSeconds ?? 0,
    );
    if (!sameAsset) {
      viewportRef.current = fitViewport(knownDuration, width);
    }
    if (!assetId || !contentKey) {
      if (!sameAsset) {
        peakDataRef.current = null;
        loadedAssetIdRef.current = null;
        activeChannelIndexesRef.current = [];
      }
      queueMicrotask(() => {
        if (!cancelled) {
          if (!sameAsset) {
            setActiveChannelIndexes([]);
            setChannelCount(0);
            setClippingMarkerCount(0);
            setPeakDurationSeconds(null);
          }
          setStatus(assetId && contentKey ? "ready" : "idle");
        }
      });
      return () => {
        cancelled = true;
      };
    }
    if (!sameAsset) {
      peakDataRef.current = null;
      loadedAssetIdRef.current = null;
    }
    queueMicrotask(() => {
      if (!cancelled) {
        if (!sameAsset) {
          activeChannelIndexesRef.current = [];
          setActiveChannelIndexes([]);
          setChannelCount(0);
          setClippingMarkerCount(0);
          setPeakDurationSeconds(null);
        }
        setStatus("ready");
        redraw();
      }
    });
    const knownSampleRate = sampleRate ?? 0;
    const samplesPerPeak = samplesPerPeakForDisplay(
      knownDuration,
      knownSampleRate,
      width,
    );
    const coldTimer: number | null = null;
    const loadWaveform = async () => {
      try {
        const peaks = await getCachedWaveformPeaks(
          assetId,
          contentKey,
          "source",
          samplesPerPeak,
        );
        if (cancelled) return;
        if (peaks) {
          applyPeakData(peaks, { preserveViewport: sameAsset });
          return;
        }
      } catch (error) {
        console.warn("Waveform cache lookup failed", error);
      }

      await wait(coldWaveformDelayMs);
      if (cancelled) return;
      setStatus("loading");

      for (let attempt = 0; attempt <= waveformRetryDelaysMs.length; attempt += 1) {
        activeWaveformJobRef.current = `waveform:${assetId}`;
        try {
          const generatedPeaks = await getWaveformPeaks(
            assetId,
            contentKey,
            "source",
            samplesPerPeak,
          );
          if (cancelled) return;
          applyPeakData(generatedPeaks, { preserveViewport: sameAsset });
          return;
        } catch (error) {
          if (cancelled) return;
          console.warn(`Waveform generation attempt ${attempt + 1} failed`, error);
          try {
            const cached = await getCachedWaveformPeaks(
              assetId,
              contentKey,
              "source",
              samplesPerPeak,
            );
            if (cancelled) return;
            if (cached) {
              applyPeakData(cached, { preserveViewport: sameAsset });
              return;
            }
          } catch {
            // Keep retrying the primary generator.
          }
          const delay = waveformRetryDelaysMs[attempt];
          if (delay === undefined) break;
          await wait(delay);
          if (cancelled) return;
        } finally {
          if (activeWaveformJobRef.current === `waveform:${assetId}`) {
            activeWaveformJobRef.current = null;
          }
        }
      }

      if (!cancelled) setStatus("failed");
    };
    void loadWaveform();
    return () => {
      cancelled = true;
      if (coldTimer !== null) window.clearTimeout(coldTimer);
      if (waveformResolutionTimerRef.current !== null) {
        window.clearTimeout(waveformResolutionTimerRef.current);
        waveformResolutionTimerRef.current = null;
      }
      if (activeWaveformJobRef.current) {
        void cancelAudioJob(activeWaveformJobRef.current);
        activeWaveformJobRef.current = null;
      }
    };
  }, [
    assetId,
    applyPeakData,
    contentKey,
    durationSeconds,
    redraw,
    sampleRate,
  ]);

  useEffect(
    () =>
      audioPreviewService.subscribe((state) => {
        setPlayheadAnimating(state.status === "playing");
        if (state.status !== "playing") requestAnimationFrame(redraw);
      }),
    [redraw],
  );

  useEffect(() => {
    if (!playheadAnimating) {
      redraw();
      return undefined;
    }
    const tick = () => {
      redraw();
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playheadAnimating, redraw]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: string }>).detail;
      if (detail?.kind === "zoom-horizontal-in") zoomHorizontal(1.25);
      if (detail?.kind === "zoom-horizontal-out") zoomHorizontal(0.8);
      if (detail?.kind === "zoom-vertical-in") zoomVertical(1.25);
      if (detail?.kind === "zoom-vertical-out") zoomVertical(0.8);
    };
    window.addEventListener("sonilabs:waveform-intent", handler);
    return () => window.removeEventListener("sonilabs:waveform-intent", handler);
  }, [zoomHorizontal, zoomVertical]);

  const dragModeForX = useCallback(
    (x: number, y: number, width: number, height: number): DragState["mode"] => {
      if (!region) return "select";
      const viewport = viewportRef.current;
      const startX = secondsToX(region.startSeconds, viewport, width);
      const endX = secondsToX(region.endSeconds, viewport, width);
      const regionWidth = Math.max(0, endX - startX);
      const isTopEdgeControl = y <= edgeFadeHitHeightPixels;
      if (loopCrossfadeEnabled && loopCrossfadeSeconds > 0) {
        const fadeSeconds = clampedLoopCrossfadeSeconds(region, loopCrossfadeSeconds);
        const leftHandleX = secondsToX(
          region.startSeconds + fadeSeconds,
          viewport,
          width,
        );
        const rightHandleX = secondsToX(
          region.endSeconds - fadeSeconds,
          viewport,
          width,
        );
        const slopeY = loopCrossfadeSlopeHandleY(height, loopCrossfadeSlope);
        const leftSlopeX = (startX + leftHandleX) / 2;
        const rightSlopeX = (rightHandleX + endX) / 2;
        if (
          Math.hypot(x - leftSlopeX, y - slopeY) <= crossfadeSlopeHandleHitPixels ||
          Math.hypot(x - rightSlopeX, y - (height - slopeY)) <=
            crossfadeSlopeHandleHitPixels
        )
          return "crossfade-slope";
        if (
          isTopEdgeControl &&
          Math.abs(x - leftHandleX) <=
            Math.max(crossfadeHandleHitPixels, resizeHandleHitPixels)
        )
          return "crossfade-left";
        if (
          isTopEdgeControl &&
          Math.abs(x - rightHandleX) <=
            Math.max(crossfadeHandleHitPixels, resizeHandleHitPixels)
        )
          return "crossfade-right";
      } else if (!loopCrossfadeEnabled) {
        const { fadeInSeconds, fadeOutSeconds } = clampedRegionFadePair(
          region,
          regionFadeInSeconds,
          regionFadeOutSeconds,
          regionFadeGapSeconds,
        );
        const fadeInX = secondsToX(
          region.startSeconds + fadeInSeconds,
          viewport,
          width,
        );
        const fadeOutX = secondsToX(
          region.endSeconds - fadeOutSeconds,
          viewport,
          width,
        );
        const fadeInSlopeX = (startX + fadeInX) / 2;
        const fadeOutSlopeX = (fadeOutX + endX) / 2;
        const fadeInSlopeY = regionFadeSlopeHandleY(height, regionFadeInSlope, "in");
        const fadeOutSlopeY = regionFadeSlopeHandleY(height, regionFadeOutSlope, "out");
        if (
          fadeInSeconds > 0 &&
          Math.hypot(x - fadeInSlopeX, y - fadeInSlopeY) <=
            crossfadeSlopeHandleHitPixels
        )
          return "fade-in-slope";
        if (
          fadeOutSeconds > 0 &&
          Math.hypot(x - fadeOutSlopeX, y - fadeOutSlopeY) <=
            crossfadeSlopeHandleHitPixels
        )
          return "fade-out-slope";
        if (
          isTopEdgeControl &&
          fadeInSeconds > 0 &&
          Math.abs(x - fadeInX) <= Math.max(fadeHandleHitPixels, resizeHandleHitPixels)
        )
          return "fade-in";
        if (
          isTopEdgeControl &&
          fadeOutSeconds > 0 &&
          Math.abs(x - fadeOutX) <= Math.max(fadeHandleHitPixels, resizeHandleHitPixels)
        )
          return "fade-out";
        if (
          isTopEdgeControl &&
          x >= startX &&
          x <=
            Math.min(
              endX,
              Math.max(fadeInX + fadeHandleHitPixels, startX + fadeCreationZonePixels),
            )
        )
          return "fade-in";
        if (
          isTopEdgeControl &&
          x <= endX &&
          x >=
            Math.max(
              startX,
              Math.min(fadeOutX - fadeHandleHitPixels, endX - fadeCreationZonePixels),
            )
        )
          return "fade-out";
      }
      const nearStartEdge = Math.abs(x - startX) <= resizeHandleHitPixels;
      const nearEndEdge = Math.abs(x - endX) <= resizeHandleHitPixels;
      if (nearStartEdge && nearEndEdge)
        return x <= (startX + endX) / 2 ? "resize-start" : "resize-end";
      if (nearStartEdge) return "resize-start";
      if (nearEndEdge) return "resize-end";
      if (loopCrossfadeEnabled && loopCrossfadeSeconds > 0) {
        const fadeSeconds = clampedLoopCrossfadeSeconds(region, loopCrossfadeSeconds);
        const leftHandleX = secondsToX(
          region.startSeconds + fadeSeconds,
          viewport,
          width,
        );
        const rightHandleX = secondsToX(
          region.endSeconds - fadeSeconds,
          viewport,
          width,
        );
        const slopeY = loopCrossfadeSlopeHandleY(height, loopCrossfadeSlope);
        const leftSlopeX = (startX + leftHandleX) / 2;
        const rightSlopeX = (rightHandleX + endX) / 2;
        if (
          Math.hypot(x - leftSlopeX, y - slopeY) <= crossfadeSlopeHandleHitPixels ||
          Math.hypot(x - rightSlopeX, y - (height - slopeY)) <=
            crossfadeSlopeHandleHitPixels
        )
          return "crossfade-slope";
        if (Math.abs(x - leftHandleX) <= crossfadeHandleHitPixels)
          return "crossfade-left";
        if (Math.abs(x - rightHandleX) <= crossfadeHandleHitPixels)
          return "crossfade-right";
        if ((x >= startX && x <= leftHandleX) || (x >= rightHandleX && x <= endX))
          return "seek";
        if (
          isFileDragZone(x, y, startX, endX, height) &&
          regionWidth >= fileDragHorizontalGuardPixels * 2 &&
          committedRegionKeyRef.current === regionKey(region)
        ) {
          return "file-drag";
        }
      } else {
        const { fadeInSeconds, fadeOutSeconds } = clampedRegionFadePair(
          region,
          regionFadeInSeconds,
          regionFadeOutSeconds,
          regionFadeGapSeconds,
        );
        const fadeInX = secondsToX(
          region.startSeconds + fadeInSeconds,
          viewport,
          width,
        );
        const fadeOutX = secondsToX(
          region.endSeconds - fadeOutSeconds,
          viewport,
          width,
        );
        const fadeInSlopeX = (startX + fadeInX) / 2;
        const fadeOutSlopeX = (fadeOutX + endX) / 2;
        const fadeInSlopeY = regionFadeSlopeHandleY(height, regionFadeInSlope, "in");
        const fadeOutSlopeY = regionFadeSlopeHandleY(height, regionFadeOutSlope, "out");
        if (
          fadeInSeconds > 0 &&
          Math.hypot(x - fadeInSlopeX, y - fadeInSlopeY) <=
            crossfadeSlopeHandleHitPixels
        )
          return "fade-in-slope";
        if (
          fadeOutSeconds > 0 &&
          Math.hypot(x - fadeOutSlopeX, y - fadeOutSlopeY) <=
            crossfadeSlopeHandleHitPixels
        )
          return "fade-out-slope";
        if (
          isTopEdgeControl &&
          fadeInSeconds > 0 &&
          Math.abs(x - fadeInX) <= fadeHandleHitPixels
        )
          return "fade-in";
        if (
          isTopEdgeControl &&
          fadeOutSeconds > 0 &&
          Math.abs(x - fadeOutX) <= fadeHandleHitPixels
        )
          return "fade-out";
        if (
          isTopEdgeControl &&
          x >= startX &&
          x <=
            Math.min(
              endX,
              Math.max(fadeInX + fadeHandleHitPixels, startX + fadeCreationZonePixels),
            )
        )
          return "fade-in";
        if (
          isTopEdgeControl &&
          x <= endX &&
          x >=
            Math.max(
              startX,
              Math.min(fadeOutX - fadeHandleHitPixels, endX - fadeCreationZonePixels),
            )
        )
          return "fade-out";
      }
      if (loopCrossfadeEnabled && x > startX && x < endX) return "seek";
      if (
        isFileDragZone(x, y, startX, endX, height) &&
        regionWidth >= fileDragHorizontalGuardPixels * 2 &&
        committedRegionKeyRef.current === regionKey(region)
      ) {
        return "file-drag";
      }
      if (x > startX && x < endX) return "seek";
      return "select";
    },
    [
      loopCrossfadeEnabled,
      loopCrossfadeSlope,
      loopCrossfadeSeconds,
      region,
      regionFadeGapSeconds,
      regionFadeInSeconds,
      regionFadeInSlope,
      regionFadeOutSeconds,
      regionFadeOutSlope,
    ],
  );

  const playheadSeconds = audioPreviewService.currentPlayheadSeconds();
  const waveformDurationSeconds =
    peakDurationSeconds ??
    durationSeconds ??
    audioPreviewService.getState().durationSeconds;
  const displayedLengthSeconds = region
    ? Math.max(0, region.endSeconds - region.startSeconds)
    : waveformDurationSeconds;
  const channelIndexes = Array.from({ length: channelCount }, (_, index) => index);
  const activeChannelSet = new Set(activeChannelIndexes);

  const updateActiveChannels = useCallback((index: number, additive: boolean) => {
    setActiveChannelIndexes((current) => {
      if (!additive) return [index];
      const next = current.includes(index)
        ? current.filter((item) => item !== index)
        : [...current, index].sort((left, right) => left - right);
      return next.length > 0 ? next : current;
    });
  }, []);

  return (
    <div className="relative h-full bg-black">
      <canvas
        className="h-full w-full touch-none"
        onDoubleClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const currentRegion = regionRef.current;
          if (
            currentRegion &&
            secondsInsideRegion(
              xToSeconds(x, viewportRef.current, rect.width),
              currentRegion,
            )
          ) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          const peaks = peakDataRef.current;
          if (peaks) {
            const fullRegion = { startSeconds: 0, endSeconds: peaks.durationSeconds };
            committedRegionKeyRef.current = regionKey(fullRegion);
            onRegionFadeChange?.({
              fadeInSeconds: 0,
              fadeOutSeconds: 0,
              fadeInSlope: 1,
              fadeOutSlope: 1,
            });
            onRegionChange(fullRegion);
            onRegionCommit(fullRegion);
          }
        }}
        onPointerDown={(event) => {
          const isMiddlePan = event.button === 1;
          if (event.button !== 0 && !isMiddlePan) return;
          if (isMiddlePan) event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const mode =
            isMiddlePan || event.shiftKey
              ? "pan"
              : dragModeForX(x, y, rect.width, rect.height);
          if (
            mode === "select" ||
            mode === "resize-start" ||
            mode === "resize-end" ||
            mode === "crossfade-left" ||
            mode === "crossfade-right" ||
            mode === "crossfade-slope" ||
            mode === "fade-in" ||
            mode === "fade-in-slope" ||
            mode === "fade-out-slope" ||
            mode === "fade-out"
          ) {
            audioPreviewService.pause();
          }
          if (mode === "pan") setCursor("grabbing");
          if (mode === "crossfade-left" || mode === "crossfade-right")
            setCursor("ew-resize");
          if (mode === "crossfade-slope") setCursor("ns-resize");
          if (mode === "fade-in-slope" || mode === "fade-out-slope")
            setCursor("ns-resize");
          if (mode === "fade-in" || mode === "fade-out") setCursor("ew-resize");
          if (
            mode === "select" ||
            mode === "resize-start" ||
            mode === "resize-end" ||
            mode === "crossfade-left" ||
            mode === "crossfade-right" ||
            mode === "crossfade-slope" ||
            mode === "fade-in" ||
            mode === "fade-in-slope" ||
            mode === "fade-out-slope" ||
            mode === "fade-out"
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
          if (mode === "select") {
            onRegionFadeChange?.({
              fadeInSeconds: 0,
              fadeOutSeconds: 0,
              fadeInSlope: 1,
              fadeOutSlope: 1,
            });
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            startX: x,
            startY: y,
            currentX: x,
            currentY: y,
            startSeconds: xToSeconds(x, viewportRef.current, rect.width),
            startedAt: performance.now(),
            regionAtStart: region,
            crossfadeSideAtStart:
              mode === "crossfade-slope" && region
                ? x <
                  secondsToX(
                    (region.startSeconds + region.endSeconds) / 2,
                    viewportRef.current,
                    rect.width,
                  )
                  ? "left"
                  : "right"
                : undefined,
            mode,
          };
          if (mode === "seek") {
            audioPreviewService.seek(xToSeconds(x, viewportRef.current, rect.width));
          }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const rect = event.currentTarget.getBoundingClientRect();
          const nextX = event.clientX - rect.left;
          const nextY = event.clientY - rect.top;
          if (!drag) {
            const mode = dragModeForX(nextX, nextY, rect.width, rect.height);
            setCursor(
              mode === "resize-start" || mode === "resize-end"
                ? "ew-resize"
                : mode === "crossfade-left" || mode === "crossfade-right"
                  ? "ew-resize"
                  : mode === "crossfade-slope"
                    ? "ns-resize"
                    : mode === "fade-in-slope" || mode === "fade-out-slope"
                      ? "ns-resize"
                      : mode === "fade-in" || mode === "fade-out"
                        ? "ew-resize"
                        : mode === "seek"
                          ? "default"
                          : mode === "file-drag"
                            ? "copy"
                            : "crosshair",
            );
            return;
          }
          if (drag.mode === "pan") {
            const peaks = peakDataRef.current;
            setCursor("grabbing");
            if (peaks) {
              viewportRef.current = panViewport(
                viewportRef.current,
                peaks.durationSeconds,
                rect.width,
                drag.currentX - nextX,
              );
              scheduleWaveformResolution();
            }
          } else if (drag.mode === "resize-start" && drag.regionAtStart) {
            onRegionChange(
              normalizeRegion(
                pointerSeconds(event),
                drag.regionAtStart.endSeconds,
                peakDataRef.current?.durationSeconds ?? 0,
              ),
            );
          } else if (drag.mode === "resize-end" && drag.regionAtStart) {
            onRegionChange(
              normalizeRegion(
                drag.regionAtStart.startSeconds,
                pointerSeconds(event),
                peakDataRef.current?.durationSeconds ?? 0,
              ),
            );
          } else if (
            (drag.mode === "crossfade-left" || drag.mode === "crossfade-right") &&
            drag.regionAtStart
          ) {
            const seconds = pointerSeconds(event);
            const nextFade =
              drag.mode === "crossfade-left"
                ? seconds - drag.regionAtStart.startSeconds
                : drag.regionAtStart.endSeconds - seconds;
            onLoopCrossfadeSecondsChange?.(
              clampedLoopCrossfadeSeconds(drag.regionAtStart, nextFade),
            );
          } else if (drag.mode === "crossfade-slope") {
            onLoopCrossfadeSlopeChange?.(
              slopeFromCrossfadePointer(nextY, rect.height, drag.crossfadeSideAtStart),
            );
          } else if (drag.mode === "fade-in-slope" || drag.mode === "fade-out-slope") {
            const nextSlope = slopeFromRegionFadePointer(
              nextY,
              rect.height,
              drag.mode === "fade-in-slope" ? "in" : "out",
            );
            onRegionFadeChange?.({
              fadeInSeconds: regionFadeInSeconds,
              fadeOutSeconds: regionFadeOutSeconds,
              fadeInSlope:
                drag.mode === "fade-in-slope" ? nextSlope : regionFadeInSlope,
              fadeOutSlope:
                drag.mode === "fade-out-slope" ? nextSlope : regionFadeOutSlope,
            });
          } else if (
            (drag.mode === "fade-in" || drag.mode === "fade-out") &&
            drag.regionAtStart
          ) {
            const seconds = pointerSeconds(event);
            const nextFadeIn =
              drag.mode === "fade-in"
                ? seconds - drag.regionAtStart.startSeconds
                : regionFadeInSeconds;
            const nextFadeOut =
              drag.mode === "fade-out"
                ? drag.regionAtStart.endSeconds - seconds
                : regionFadeOutSeconds;
            const nextFade = clampedRegionFadePair(
              drag.regionAtStart,
              nextFadeIn,
              nextFadeOut,
              regionFadeGapSeconds,
              drag.mode === "fade-in" ? "in" : "out",
            );
            onRegionFadeChange?.({
              ...nextFade,
              fadeInSlope: regionFadeInSlope,
              fadeOutSlope: regionFadeOutSlope,
            });
          } else if (drag.mode === "file-drag") {
            const deltaX = nextX - drag.startX;
            const deltaY = nextY - drag.startY;
            const distance = Math.hypot(deltaX, deltaY);
            const age = performance.now() - drag.startedAt;
            const isDeliberateFileDrag =
              distance >= fileDragThresholdPixels && age >= fileDragMinimumAgeMs;
            if (!drag.fileDragStarted && isDeliberateFileDrag && drag.regionAtStart) {
              drag.fileDragStarted = true;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              onRegionFileDragRequest(drag.regionAtStart);
            }
          } else if (drag.mode === "seek") {
            audioPreviewService.seek(
              xToSeconds(nextX, viewportRef.current, rect.width),
            );
          } else {
            const startSeconds = xToSeconds(
              drag.startX,
              viewportRef.current,
              rect.width,
            );
            const endSeconds = pointerSeconds(event);
            onRegionChange(
              normalizeRegion(
                startSeconds,
                endSeconds,
                peakDataRef.current?.durationSeconds ?? 0,
              ),
            );
          }
          drag.currentX = nextX;
          drag.currentY = nextY;
          redraw();
        }}
        onPointerLeave={() => {
          if (!dragRef.current) setCursor("crosshair");
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          if (
            (drag?.mode === "select" || drag?.mode === "file-drag") &&
            !drag.fileDragStarted &&
            Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY) <
              fileDragThresholdPixels
          ) {
            if (
              drag.regionAtStart &&
              !secondsInsideRegion(
                xToSeconds(drag.startX, viewportRef.current, rect.width),
                drag.regionAtStart,
              )
            ) {
              committedRegionKeyRef.current = null;
              onRegionChange(null);
            }
            audioPreviewService.seek(
              xToSeconds(drag.startX, viewportRef.current, rect.width),
            );
            audioPreviewService.play();
          }
          const peaks = peakDataRef.current;
          if (
            drag &&
            peaks &&
            drag.mode !== "pan" &&
            drag.mode !== "file-drag" &&
            drag.mode !== "crossfade-left" &&
            drag.mode !== "crossfade-right" &&
            drag.mode !== "crossfade-slope" &&
            drag.mode !== "fade-in" &&
            drag.mode !== "fade-in-slope" &&
            drag.mode !== "fade-out-slope" &&
            drag.mode !== "fade-out" &&
            drag.mode !== "seek" &&
            !drag.fileDragStarted
          ) {
            const committedRegion = committedRegionFromDrag(
              drag,
              rect.width,
              peaks,
              viewportRef.current,
            );
            if (committedRegion) {
              committedRegionKeyRef.current = regionKey(committedRegion);
              onRegionCommit(committedRegion);
            }
          }
          if (drag?.mode === "seek" && !drag.fileDragStarted) {
            audioPreviewService.seek(
              xToSeconds(drag.currentX, viewportRef.current, rect.width),
            );
          }
          if (
            drag?.regionAtStart &&
            (drag.mode === "crossfade-left" || drag.mode === "crossfade-right")
          ) {
            const seconds = xToSeconds(drag.currentX, viewportRef.current, rect.width);
            const nextFade =
              drag.mode === "crossfade-left"
                ? seconds - drag.regionAtStart.startSeconds
                : drag.regionAtStart.endSeconds - seconds;
            onLoopCrossfadeSecondsCommit?.(
              clampedLoopCrossfadeSeconds(drag.regionAtStart, nextFade),
            );
          }
          if (drag?.mode === "crossfade-slope") {
            onLoopCrossfadeSlopeCommit?.(
              slopeFromCrossfadePointer(
                drag.currentY,
                rect.height,
                drag.crossfadeSideAtStart,
              ),
            );
          }
          if (drag?.mode === "fade-in-slope" || drag?.mode === "fade-out-slope") {
            const nextSlope = slopeFromRegionFadePointer(
              drag.currentY,
              rect.height,
              drag.mode === "fade-in-slope" ? "in" : "out",
            );
            onRegionFadeCommit?.({
              fadeInSeconds: regionFadeInSeconds,
              fadeOutSeconds: regionFadeOutSeconds,
              fadeInSlope:
                drag.mode === "fade-in-slope" ? nextSlope : regionFadeInSlope,
              fadeOutSlope:
                drag.mode === "fade-out-slope" ? nextSlope : regionFadeOutSlope,
            });
          }
          if (
            drag?.regionAtStart &&
            (drag.mode === "fade-in" || drag.mode === "fade-out")
          ) {
            const seconds = xToSeconds(drag.currentX, viewportRef.current, rect.width);
            const nextFade = clampedRegionFadePair(
              drag.regionAtStart,
              drag.mode === "fade-in"
                ? seconds - drag.regionAtStart.startSeconds
                : regionFadeInSeconds,
              drag.mode === "fade-out"
                ? drag.regionAtStart.endSeconds - seconds
                : regionFadeOutSeconds,
              regionFadeGapSeconds,
              drag.mode === "fade-in" ? "in" : "out",
            );
            onRegionFadeCommit?.({
              ...nextFade,
              fadeInSlope: regionFadeInSlope,
              fadeOutSlope: regionFadeOutSlope,
            });
          }
          dragRef.current = null;
          setCursor("crosshair");
        }}
        onAuxClick={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        ref={canvasRef}
        style={{ cursor }}
        title={
          clippingMarkerCount > 0
            ? "Red ticks mark clipped samples at or above full scale."
            : "Waveform"
        }
      />
      <div className="absolute right-4 top-2 rounded-[2px] bg-black/35 px-1.5 py-0.5">
        <input
          aria-label="Horizontal waveform zoom"
          className="h-1 w-24 accent-primary"
          max={20}
          min={1}
          onChange={(event) => setHorizontalZoomLevel(Number(event.target.value))}
          step={0.1}
          title={`Horizontal zoom ${zoomLabels.horizontal}`}
          type="range"
          value={horizontalZoomValue}
        />
      </div>
      <div className="absolute right-1.5 top-7 flex h-20 w-3 items-center justify-center rounded-[2px] bg-black/35 py-1">
        <input
          aria-label="Vertical waveform zoom"
          className="h-1 w-20 rotate-90 accent-primary"
          max={maxVerticalZoom}
          min={minVerticalZoom}
          onChange={(event) => setVerticalZoomLevel(Number(event.target.value))}
          step={0.1}
          title={`Vertical zoom ${zoomLabels.vertical}`}
          type="range"
          value={verticalZoomValue}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 grid grid-cols-3 items-center gap-x-3 bg-black/80 px-3 py-1.5 font-mono text-[10px] text-zinc-200">
        <div className="flex min-w-0 items-center gap-2">
          <WaveformTimecode seconds={playheadSeconds} />
          <span className={region ? "text-blue-300" : "text-zinc-300"}>
            <WaveformTimecode seconds={displayedLengthSeconds} />
          </span>
          {loopCrossfadeEnabled && loopCrossfadeSeconds > 0 ? (
            <span className="text-cyan-200">
              Crossfade {formatMilliseconds(loopCrossfadeSeconds)}
            </span>
          ) : null}
        </div>
        <div className="flex justify-center gap-1.5">
          {channelIndexes.map((index) => {
            const active = activeChannelSet.has(index);
            return (
              <button
                className={
                  active
                    ? "h-4 min-w-12 rounded-full bg-primary px-2 text-[9px] font-medium leading-4 text-primary-foreground"
                    : "h-4 min-w-12 rounded-full bg-zinc-800 px-2 text-[9px] leading-4 text-zinc-400"
                }
                key={index}
                onClick={(event) => updateActiveChannels(index, event.shiftKey)}
                title={`Show ${channelLabel(index, channelCount)}`}
                type="button"
              >
                {channelLabel(index, channelCount)}
              </button>
            );
          })}
        </div>
        <div className="flex min-w-0 items-center justify-end gap-1.5">
          {region && !loopCrossfadeEnabled ? (
            <>
              <span className="text-zinc-400">Gap</span>
              <input
                aria-label="Region fade gap"
                className="h-1 w-20 accent-blue-300"
                max={maxRegionFadeGapSeconds}
                min={minRegionFadeGapSeconds}
                onChange={(event) =>
                  onRegionFadeGapChange?.(Number(event.target.value))
                }
                step={0.001}
                title={`Fade gap ${formatMilliseconds(regionFadeGapSeconds)}`}
                type="range"
                value={Math.max(
                  minRegionFadeGapSeconds,
                  Math.min(maxRegionFadeGapSeconds, regionFadeGapSeconds),
                )}
              />
              <span className="w-8 text-right text-blue-200">
                {formatMilliseconds(regionFadeGapSeconds)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {status === "loading" || status === "failed" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-foreground">
          {status === "failed" ? "Waveform unavailable" : "Loading waveform"}
        </div>
      ) : null}
    </div>
  );
}

function drawFilledWaveformChannel(
  context: CanvasRenderingContext2D,
  channel: WaveformPeakChannel,
  peakData: WaveformPeakData,
  viewport: WaveformViewport,
  width: number,
  centerY: number,
  channelHeight: number,
  verticalZoom: number,
): void {
  const peakCount = Math.min(channel.minimums.length, channel.maximums.length);
  if (peakCount === 0) return;
  const dataStartSeconds = peakData.peakStartSeconds ?? 0;
  const dataEndSeconds = peakData.peakEndSeconds ?? peakData.durationSeconds;
  const dataDurationSeconds = Math.max(0.001, dataEndSeconds - dataStartSeconds);

  const visibleSpan = Math.max(
    0.001,
    viewport.visibleEndSeconds - viewport.visibleStartSeconds,
  );
  const upperYs: number[] = [];
  const lowerYs: number[] = [];

  for (let x = 0; x <= width; x += 1) {
    const startSeconds = viewport.visibleStartSeconds + (x / width) * visibleSpan;
    const endSeconds = viewport.visibleStartSeconds + ((x + 1) / width) * visibleSpan;
    if (endSeconds < dataStartSeconds || startSeconds > dataEndSeconds) {
      upperYs.push(centerY);
      lowerYs.push(centerY);
      continue;
    }
    const startPeak = Math.max(
      0,
      Math.floor(((startSeconds - dataStartSeconds) / dataDurationSeconds) * peakCount),
    );
    const endPeak = Math.min(
      peakCount - 1,
      Math.ceil(((endSeconds - dataStartSeconds) / dataDurationSeconds) * peakCount),
    );
    let minimum = 0;
    let maximum = 0;

    for (let peakIndex = startPeak; peakIndex <= endPeak; peakIndex += 1) {
      minimum = Math.min(minimum, channel.minimums[peakIndex] ?? 0);
      maximum = Math.max(maximum, channel.maximums[peakIndex] ?? 0);
    }

    const upperAmplitude = Math.max(0, maximum);
    const lowerAmplitude = Math.max(0, -minimum);
    const visibleUpperAmplitude =
      upperAmplitude > 0.001 ? Math.max(upperAmplitude, 2 / channelHeight) : 0;
    const visibleLowerAmplitude =
      lowerAmplitude > 0.001 ? Math.max(lowerAmplitude, 2 / channelHeight) : 0;
    upperYs.push(
      centerY -
        Math.min(
          channelHeight * 0.48,
          visibleUpperAmplitude * channelHeight * 0.42 * verticalZoom,
        ),
    );
    lowerYs.push(
      centerY +
        Math.min(
          channelHeight * 0.48,
          visibleLowerAmplitude * channelHeight * 0.42 * verticalZoom,
        ),
    );
  }

  context.fillStyle = "rgba(244, 244, 245, 0.9)";
  context.beginPath();
  context.moveTo(0, upperYs[0] ?? centerY);
  for (let x = 1; x <= width; x += 1) {
    context.lineTo(x, upperYs[x] ?? centerY);
  }
  for (let x = width; x >= 0; x -= 1) {
    context.lineTo(x, lowerYs[x] ?? centerY);
  }
  context.closePath();
  context.fill();
}

function drawLoopCrossfadeOverlay(
  context: CanvasRenderingContext2D,
  region: WaveformRegion,
  viewport: WaveformViewport,
  width: number,
  height: number,
  crossfadeSeconds: number,
  desiredSeconds: number,
  slope: number,
): void {
  const fadeSeconds = clampedLoopCrossfadeSeconds(region, crossfadeSeconds);
  if (fadeSeconds <= 0) return;
  const limited = desiredSeconds > 0 && fadeSeconds < desiredSeconds * 0.98;
  const startX = secondsToX(region.startSeconds, viewport, width);
  const leftEndX = secondsToX(region.startSeconds + fadeSeconds, viewport, width);
  const rightStartX = secondsToX(region.endSeconds - fadeSeconds, viewport, width);
  const endX = secondsToX(region.endSeconds, viewport, width);
  const color = limited ? "251, 191, 36" : "34, 211, 238";

  const leftGradient = context.createLinearGradient(startX, 0, leftEndX, 0);
  leftGradient.addColorStop(0, `rgba(${color}, 0.36)`);
  leftGradient.addColorStop(1, `rgba(${color}, 0.04)`);
  context.fillStyle = leftGradient;
  context.fillRect(startX, 0, leftEndX - startX, height);

  const rightGradient = context.createLinearGradient(rightStartX, 0, endX, 0);
  rightGradient.addColorStop(0, `rgba(${color}, 0.04)`);
  rightGradient.addColorStop(1, `rgba(${color}, 0.36)`);
  context.fillStyle = rightGradient;
  context.fillRect(rightStartX, 0, endX - rightStartX, height);

  context.strokeStyle = `rgba(${color}, 0.9)`;
  context.setLineDash([4, 4]);
  context.beginPath();
  context.moveTo(leftEndX, 0);
  context.lineTo(leftEndX, height);
  context.moveTo(rightStartX, 0);
  context.lineTo(rightStartX, height);
  context.stroke();
  context.setLineDash([]);

  context.fillStyle = `rgba(${color}, 0.95)`;
  context.fillRect(leftEndX - 2, 0, 4, height);
  context.fillRect(rightStartX - 2, 0, 4, height);
  drawTopCornerTriangle(context, leftEndX, `rgba(${color}, 0.98)`, "left");
  drawTopCornerTriangle(context, rightStartX, `rgba(${color}, 0.98)`, "right");

  context.strokeStyle = `rgba(${color}, 0.85)`;
  context.beginPath();
  const leftCurveWidth = Math.max(1, leftEndX - startX);
  const rightCurveWidth = Math.max(1, endX - rightStartX);
  for (let step = 0; step <= 24; step += 1) {
    const t = step / 24;
    const x = startX + t * leftCurveWidth;
    const y = height * 0.72 - Math.pow(t, slope) * height * 0.42;
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  for (let step = 0; step <= 24; step += 1) {
    const t = step / 24;
    const x = rightStartX + t * rightCurveWidth;
    const y = height * 0.3 + Math.pow(t, slope) * height * 0.42;
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  drawSlopeDiamond(
    context,
    (startX + leftEndX) / 2,
    loopCrossfadeSlopeHandleY(height, slope),
    `rgba(${color}, 0.98)`,
  );
  drawSlopeDiamond(
    context,
    (rightStartX + endX) / 2,
    height - loopCrossfadeSlopeHandleY(height, slope),
    `rgba(${color}, 0.98)`,
  );

  const label = `${formatMilliseconds(fadeSeconds)} S${slope.toFixed(1)}`;
  context.font = "10px monospace";
  context.textBaseline = "top";
  context.fillStyle = "rgba(0, 0, 0, 0.75)";
  context.fillRect(leftEndX + 5, 6, context.measureText(label).width + 8, 15);
  context.fillRect(
    rightStartX - context.measureText(label).width - 13,
    6,
    context.measureText(label).width + 8,
    15,
  );
  context.fillStyle = `rgba(${color}, 0.98)`;
  context.fillText(label, leftEndX + 9, 8);
  context.fillText(label, rightStartX - context.measureText(label).width - 9, 8);
}

function drawCrossfadeGhostPlayhead(
  context: CanvasRenderingContext2D,
  region: WaveformRegion,
  viewport: WaveformViewport,
  width: number,
  height: number,
  crossfadeSeconds: number,
  playheadSeconds: number,
): void {
  const fadeSeconds = clampedLoopCrossfadeSeconds(region, crossfadeSeconds);
  if (fadeSeconds <= 0) return;
  const headProgress = (playheadSeconds - region.startSeconds) / fadeSeconds;
  const tailProgress =
    (playheadSeconds - (region.endSeconds - fadeSeconds)) / fadeSeconds;
  const inHead = headProgress >= 0 && headProgress <= 1;
  const inTail = tailProgress >= 0 && tailProgress <= 1;
  if (!inHead && !inTail) return;
  const mirroredSeconds = inHead
    ? region.endSeconds - fadeSeconds + headProgress * fadeSeconds
    : region.startSeconds + tailProgress * fadeSeconds;
  const ghostX = secondsToX(mirroredSeconds, viewport, width);
  const progress = inHead ? headProgress : tailProgress;
  const alpha = Math.max(0.18, Math.min(0.85, 1 - progress * 0.65));
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = "rgba(34, 211, 238, 0.9)";
  context.fillStyle = "rgba(34, 211, 238, 0.18)";
  context.fillRect(ghostX - 2, 0, 4, height);
  context.setLineDash([3, 4]);
  context.beginPath();
  context.moveTo(ghostX + 0.5, 0);
  context.lineTo(ghostX + 0.5, height);
  context.stroke();
  context.setLineDash([]);
  context.restore();
}

function drawRegionFadeOverlay(
  context: CanvasRenderingContext2D,
  region: WaveformRegion,
  viewport: WaveformViewport,
  width: number,
  height: number,
  fadeInSeconds: number,
  fadeInSlope: number,
  fadeOutSeconds: number,
  fadeOutSlope: number,
  fadeGapSeconds: number,
): void {
  const { fadeInSeconds: inSeconds, fadeOutSeconds: outSeconds } =
    clampedRegionFadePair(region, fadeInSeconds, fadeOutSeconds, fadeGapSeconds);
  const startX = secondsToX(region.startSeconds, viewport, width);
  const endX = secondsToX(region.endSeconds, viewport, width);
  const fadeInX = secondsToX(region.startSeconds + inSeconds, viewport, width);
  const fadeOutX = secondsToX(region.endSeconds - outSeconds, viewport, width);
  const inSlope = clampedLoopCrossfadeSlope(fadeInSlope);
  const outSlope = clampedLoopCrossfadeSlope(fadeOutSlope);

  context.fillStyle = "rgba(59, 130, 246, 0.28)";
  if (inSeconds > 0) {
    context.beginPath();
    context.moveTo(startX, height);
    context.lineTo(fadeInX, 0);
    context.lineTo(fadeInX, height);
    context.closePath();
    context.fill();
    context.fillStyle = "rgba(96, 165, 250, 0.95)";
    context.fillRect(fadeInX - 2, 0, 4, height);
    drawRegionFadeCurve(context, startX, fadeInX, height, inSlope, "in");
    drawSlopeDiamond(
      context,
      (startX + fadeInX) / 2,
      regionFadeSlopeHandleY(height, inSlope, "in"),
      "rgba(96, 165, 250, 0.98)",
    );
  }
  context.fillStyle = "rgba(59, 130, 246, 0.28)";
  if (outSeconds > 0) {
    context.beginPath();
    context.moveTo(fadeOutX, 0);
    context.lineTo(endX, height);
    context.lineTo(fadeOutX, height);
    context.closePath();
    context.fill();
    context.fillStyle = "rgba(96, 165, 250, 0.95)";
    context.fillRect(fadeOutX - 2, 0, 4, height);
    drawRegionFadeCurve(context, fadeOutX, endX, height, outSlope, "out");
    drawSlopeDiamond(
      context,
      (fadeOutX + endX) / 2,
      regionFadeSlopeHandleY(height, outSlope, "out"),
      "rgba(96, 165, 250, 0.98)",
    );
  }
  drawTopCornerTriangle(context, fadeInX, "rgba(96, 165, 250, 0.98)", "left");
  drawTopCornerTriangle(context, fadeOutX, "rgba(96, 165, 250, 0.98)", "right");

  context.font = "10px monospace";
  context.textBaseline = "top";
  context.fillStyle = "rgba(0, 0, 0, 0.75)";
  if (inSeconds > 0) {
    const label = `${formatMilliseconds(inSeconds)} S${inSlope.toFixed(1)} in`;
    context.fillRect(fadeInX + 5, 6, context.measureText(label).width + 8, 15);
    context.fillStyle = "rgba(147, 197, 253, 0.98)";
    context.fillText(label, fadeInX + 9, 8);
    context.fillStyle = "rgba(0, 0, 0, 0.75)";
  }
  if (outSeconds > 0) {
    const label = `${formatMilliseconds(outSeconds)} S${outSlope.toFixed(1)} out`;
    const labelX = fadeOutX - context.measureText(label).width - 13;
    context.fillRect(labelX, 6, context.measureText(label).width + 8, 15);
    context.fillStyle = "rgba(147, 197, 253, 0.98)";
    context.fillText(label, labelX + 4, 8);
  }
}

function drawTopCornerTriangle(
  context: CanvasRenderingContext2D,
  x: number,
  fill: string,
  side: "left" | "right",
): void {
  const size = 13;
  const direction = side === "left" ? 1 : -1;
  context.beginPath();
  context.moveTo(x, 0);
  context.lineTo(x + direction * size, 0);
  context.lineTo(x, size);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, 0.95)";
  context.stroke();
}

function drawRegionFadeCurve(
  context: CanvasRenderingContext2D,
  startX: number,
  endX: number,
  height: number,
  slope: number,
  side: "in" | "out",
): void {
  const curveWidth = Math.max(1, endX - startX);
  context.strokeStyle = "rgba(147, 197, 253, 0.9)";
  context.beginPath();
  for (let step = 0; step <= 24; step += 1) {
    const t = step / 24;
    const x = startX + t * curveWidth;
    const fadeOutGain = Math.pow(1 - t, slope);
    const y =
      side === "in"
        ? height * 0.72 - Math.pow(t, slope) * height * 0.42
        : height * 0.3 + (1 - fadeOutGain) * height * 0.42;
    if (step === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
}

function drawSlopeDiamond(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  fill: string,
): void {
  const size = 6;
  context.beginPath();
  context.moveTo(x, y - size);
  context.lineTo(x + size, y);
  context.lineTo(x, y + size);
  context.lineTo(x - size, y);
  context.closePath();
  context.fillStyle = "rgba(0, 0, 0, 0.8)";
  context.fill();
  context.strokeStyle = "rgba(255, 255, 255, 0.95)";
  context.stroke();
  context.beginPath();
  context.moveTo(x, y - size + 2);
  context.lineTo(x + size - 2, y);
  context.lineTo(x, y + size - 2);
  context.lineTo(x - size + 2, y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
}

function loopCrossfadeSlopeHandleY(height: number, slope: number): number {
  return height * 0.72 - Math.pow(0.5, slope) * height * 0.42;
}

function regionFadeSlopeHandleY(
  height: number,
  slope: number,
  side: "in" | "out",
): number {
  const clampedSlope = clampedLoopCrossfadeSlope(slope);
  return side === "in"
    ? height * 0.72 - Math.pow(0.5, clampedSlope) * height * 0.42
    : height * 0.3 + (1 - Math.pow(0.5, clampedSlope)) * height * 0.42;
}

function slopeFromCrossfadePointer(
  y: number,
  height: number,
  side: "left" | "right" | undefined,
): number {
  const normalizedY = side === "right" ? height - y : y;
  const t = Math.max(
    0.001,
    Math.min(0.999, (height * 0.72 - normalizedY) / (height * 0.42)),
  );
  return clampedLoopCrossfadeSlope(Math.log(t) / Math.log(0.5));
}

function slopeFromRegionFadePointer(
  y: number,
  height: number,
  side: "in" | "out",
): number {
  const t =
    side === "in"
      ? (height * 0.72 - y) / (height * 0.42)
      : 1 - (y - height * 0.3) / (height * 0.42);
  const clampedT = Math.max(0.001, Math.min(0.999, t));
  return clampedLoopCrossfadeSlope(Math.log(clampedT) / Math.log(0.5));
}

function clampedLoopCrossfadeSeconds(region: WaveformRegion, seconds: number): number {
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  if (duration <= minLoopCrossfadeSeconds * 2) return 0;
  return Math.max(
    minLoopCrossfadeSeconds,
    Math.min(Math.max(minLoopCrossfadeSeconds, seconds), duration * 0.45),
  );
}

function clampedLoopCrossfadeSlope(slope: number): number {
  return Math.max(minLoopCrossfadeSlope, Math.min(maxLoopCrossfadeSlope, slope));
}

function clampedRegionFadeSeconds(region: WaveformRegion, seconds: number): number {
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  return Math.max(0, Math.min(seconds, duration));
}

function clampedRegionFadePair(
  region: WaveformRegion,
  fadeInSeconds: number,
  fadeOutSeconds: number,
  gapSeconds = defaultRegionFadeGapSeconds,
  activeSide?: "in" | "out",
): { fadeInSeconds: number; fadeOutSeconds: number } {
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  if (duration <= 0) return { fadeInSeconds: 0, fadeOutSeconds: 0 };
  const gap = Math.max(
    minRegionFadeGapSeconds,
    Math.min(gapSeconds, maxRegionFadeGapSeconds, duration),
  );
  let fadeIn = clampedRegionFadeSeconds(region, fadeInSeconds);
  let fadeOut = clampedRegionFadeSeconds(region, fadeOutSeconds);
  const maxTotal = Math.max(0, duration - (fadeIn > 0 && fadeOut > 0 ? gap : 0));
  const total = fadeIn + fadeOut;
  if (total > maxTotal && total > 0) {
    const overflow = total - maxTotal;
    if (activeSide === "in") {
      fadeOut = Math.max(0, fadeOut - overflow);
    } else if (activeSide === "out") {
      fadeIn = Math.max(0, fadeIn - overflow);
    } else if (fadeIn >= fadeOut) {
      fadeIn = Math.max(0, fadeIn - overflow);
    } else {
      fadeOut = Math.max(0, fadeOut - overflow);
    }
  }
  return { fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut };
}

function isFileDragZone(
  x: number,
  y: number,
  startX: number,
  endX: number,
  height: number,
): boolean {
  const width = Math.max(0, endX - startX);
  const edgeGuard = Math.max(fileDragHorizontalGuardPixels, width * 0.25);
  return (
    x >= startX + edgeGuard &&
    x <= endX - edgeGuard &&
    y >= fileDragVerticalGuardPixels &&
    y <= height - fileDragVerticalGuardPixels
  );
}

function channelLabel(index: number, channelCount: number): string {
  if (channelCount === 6)
    return ["L", "C", "R", "Ls", "Rs", "LFE"][index] ?? `Ch ${index + 1}`;
  if (channelCount <= 2) return `Channel ${index + 1}`;
  return `Ch ${index + 1}`;
}

function WaveformTimecode({ seconds }: { seconds: number }) {
  const parts = formatAudioTimeParts(seconds);
  if (!parts.milliseconds) return <span>{parts.main}</span>;
  return (
    <span className="inline-flex items-baseline font-mono tabular-nums">
      <span>{parts.main}</span>
      <span className="text-[0.82em] opacity-85">.{parts.milliseconds}</span>
    </span>
  );
}

function formatMilliseconds(seconds: number): string {
  return `${Math.round(seconds * 1000)}ms`;
}

function committedRegionFromDrag(
  drag: DragState,
  width: number,
  peaks: WaveformPeakData,
  viewport: WaveformViewport,
): WaveformRegion | null {
  if (drag.mode === "file-drag") return drag.regionAtStart;
  if (drag.mode === "resize-start" && drag.regionAtStart) {
    return normalizeRegion(
      xToSeconds(drag.currentX, viewport, width),
      drag.regionAtStart.endSeconds,
      peaks.durationSeconds,
    );
  }
  if (drag.mode === "resize-end" && drag.regionAtStart) {
    return normalizeRegion(
      drag.regionAtStart.startSeconds,
      xToSeconds(drag.currentX, viewport, width),
      peaks.durationSeconds,
    );
  }
  if (drag.mode === "select") {
    if (Math.abs(drag.currentX - drag.startX) < 3) return null;
    return normalizeRegion(
      xToSeconds(drag.startX, viewport, width),
      xToSeconds(drag.currentX, viewport, width),
      peaks.durationSeconds,
    );
  }
  return null;
}

function regionKey(region: WaveformRegion): string {
  return `${region.startSeconds.toFixed(3)}:${region.endSeconds.toFixed(3)}`;
}

function secondsInsideRegion(seconds: number, region: WaveformRegion): boolean {
  return seconds >= region.startSeconds && seconds <= region.endSeconds;
}

function waveformMeterSnapshot(
  peaks: WaveformPeakData,
  seconds: number,
): OutputMeterSnapshot {
  const peakCount = Math.max(
    0,
    ...peaks.channels.map((channel) =>
      Math.min(channel.minimums.length, channel.maximums.length),
    ),
  );
  if (peakCount === 0 || peaks.durationSeconds <= 0) {
    return { available: false, peakDb: null, rmsDb: null, level: 0 };
  }
  const dataStartSeconds = peaks.peakStartSeconds ?? 0;
  const dataEndSeconds = peaks.peakEndSeconds ?? peaks.durationSeconds;
  if (seconds < dataStartSeconds || seconds > dataEndSeconds) {
    return { available: false, peakDb: null, rmsDb: null, level: 0 };
  }
  const dataDurationSeconds = Math.max(0.001, dataEndSeconds - dataStartSeconds);

  const centerIndex = Math.max(
    0,
    Math.min(
      peakCount - 1,
      Math.floor(((seconds - dataStartSeconds) / dataDurationSeconds) * peakCount),
    ),
  );
  const startIndex = Math.max(0, centerIndex - 1);
  const endIndex = Math.min(peakCount - 1, centerIndex + 1);
  let peak = 0;
  let sumSquares = 0;
  let count = 0;

  for (const channel of peaks.channels) {
    for (let index = startIndex; index <= endIndex; index += 1) {
      const minimum = channel.minimums[index] ?? 0;
      const maximum = channel.maximums[index] ?? 0;
      peak = Math.max(peak, Math.abs(minimum), Math.abs(maximum));
      sumSquares += minimum * minimum + maximum * maximum;
      count += 2;
    }
  }

  const processing = audioPreviewService.getProcessing();
  const gain = processing.muted
    ? 0
    : processing.outputVolume * processedGain(processing.mode, processing.gainDb);
  const adjustedPeak = peak * gain;
  const adjustedRms = count > 0 ? Math.sqrt(sumSquares / count) * gain : 0;
  return {
    available: true,
    peakDb: linearToDb(adjustedPeak),
    rmsDb: linearToDb(adjustedRms),
    level: Math.max(0, Math.min(1, adjustedPeak)),
  };
}

function linearToDb(value: number): number | null {
  return value > 0 ? 20 * Math.log10(value) : null;
}
