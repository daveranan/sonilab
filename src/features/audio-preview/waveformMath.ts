import type { WaveformRegion, WaveformViewport } from "./types";

const MIN_REGION_SECONDS = 0.02;

export function normalizeRegion(
  startSeconds: number,
  endSeconds: number,
  durationSeconds: number,
): WaveformRegion | null {
  const duration = Math.max(0, durationSeconds);
  const start = Math.max(0, Math.min(duration, Math.min(startSeconds, endSeconds)));
  const end = Math.max(0, Math.min(duration, Math.max(startSeconds, endSeconds)));
  if (end - start < MIN_REGION_SECONDS) return null;
  return { startSeconds: start, endSeconds: end };
}

export function secondsToX(
  seconds: number,
  viewport: WaveformViewport,
  width: number,
): number {
  const span = Math.max(
    0.001,
    viewport.visibleEndSeconds - viewport.visibleStartSeconds,
  );
  return ((seconds - viewport.visibleStartSeconds) / span) * width;
}

export function xToSeconds(
  x: number,
  viewport: WaveformViewport,
  width: number,
): number {
  const span = Math.max(
    0.001,
    viewport.visibleEndSeconds - viewport.visibleStartSeconds,
  );
  return (
    viewport.visibleStartSeconds + (Math.max(0, Math.min(width, x)) / width) * span
  );
}

export function fitViewport(durationSeconds: number, width: number): WaveformViewport {
  const duration = Math.max(0.001, durationSeconds);
  return {
    visibleStartSeconds: 0,
    visibleEndSeconds: duration,
    pixelsPerSecond: width / duration,
    fitToView: true,
  };
}

export function zoomViewport(
  viewport: WaveformViewport,
  durationSeconds: number,
  width: number,
  anchorX: number,
  factor: number,
): WaveformViewport {
  const anchorSeconds = xToSeconds(anchorX, viewport, width);
  const currentSpan = viewport.visibleEndSeconds - viewport.visibleStartSeconds;
  const nextSpan = Math.max(0.05, Math.min(durationSeconds, currentSpan / factor));
  const anchorRatio = Math.max(0, Math.min(1, anchorX / width));
  let start = anchorSeconds - nextSpan * anchorRatio;
  let end = start + nextSpan;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > durationSeconds) {
    start = Math.max(0, start - (end - durationSeconds));
    end = durationSeconds;
  }
  return {
    visibleStartSeconds: start,
    visibleEndSeconds: Math.max(start + 0.001, end),
    pixelsPerSecond: width / Math.max(0.001, end - start),
    fitToView: end - start >= durationSeconds,
  };
}

export function panViewport(
  viewport: WaveformViewport,
  durationSeconds: number,
  width: number,
  deltaPixels: number,
): WaveformViewport {
  const span = viewport.visibleEndSeconds - viewport.visibleStartSeconds;
  const deltaSeconds = (deltaPixels / Math.max(1, width)) * span;
  let start = viewport.visibleStartSeconds + deltaSeconds;
  let end = viewport.visibleEndSeconds + deltaSeconds;
  if (start < 0) {
    end -= start;
    start = 0;
  }
  if (end > durationSeconds) {
    start = Math.max(0, start - (end - durationSeconds));
    end = durationSeconds;
  }
  return {
    visibleStartSeconds: start,
    visibleEndSeconds: Math.max(start + 0.001, end),
    pixelsPerSecond: width / Math.max(0.001, end - start),
    fitToView: end - start >= durationSeconds,
  };
}
