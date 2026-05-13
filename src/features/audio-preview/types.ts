export type LoopMode = "off" | "file" | "region";

export type PreviewMode = "original" | "processed";

export type ChannelMonitorMode = "all" | `channel:${number}`;

export type PreviewStatus =
  | "idle"
  | "resolving"
  | "decoding"
  | "ready"
  | "playing"
  | "paused"
  | "switching"
  | "cancelled"
  | "failed";

export interface ProcessingSettings {
  mode: PreviewMode;
  gainDb: number;
  outputVolume: number;
  muted: boolean;
  playbackRate: number;
  channelMode: ChannelMonitorMode;
}

export interface PreviewRequest {
  requestId: number;
  assetId: string;
  contentKey: string;
  startSeconds?: number;
  region?: WaveformRegion | null;
  loopMode: LoopMode;
  processing: ProcessingSettings;
}

export interface PreviewState {
  requestId: number | null;
  assetId: string | null;
  status: PreviewStatus;
  loopMode: LoopMode;
  playheadSeconds: number;
  durationSeconds: number;
  errorMessage?: string;
}

export interface WaveformRegion {
  startSeconds: number;
  endSeconds: number;
}

export interface WaveformSelection extends WaveformRegion {
  assetId: string;
  anchorSeconds: number;
  activeEdge: "start" | "end" | "move" | "none";
  source: "pointer" | "keyboard" | "restored";
  updatedAt: string;
}

export interface WaveformViewport {
  visibleStartSeconds: number;
  visibleEndSeconds: number;
  pixelsPerSecond: number;
  fitToView: boolean;
}

export interface WaveformPeakDescriptor {
  assetId: string;
  contentKey: string;
  peakVersion: number;
  channelMode: "mono" | "stereo" | "source";
  samplesPerPeak: number;
  durationSeconds: number;
  sampleRate: number;
  channelCount: number;
  peakFilePath: string;
  peakStartSeconds?: number;
  peakEndSeconds?: number;
}

export interface PreviewFileResolution {
  assetId: string;
  contentKey: string;
  path: string;
  url: string | null;
  mediaType: "local-file" | "cloud-preview" | "mock";
  durationSeconds: number | null;
  channelCount: number | null;
  processedAvailable: boolean;
}

export interface WaveformPeakChannel {
  minimums: number[];
  maximums: number[];
}

export interface SegmentMarker {
  id: string;
  assetId: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  createdAt: string;
}

export interface ClippingMarker {
  seconds: number;
  channel: number;
}

export interface WaveformPeakData extends WaveformPeakDescriptor {
  channels: WaveformPeakChannel[];
  segmentMarkers: SegmentMarker[];
  clippingMarkers: ClippingMarker[];
  cached: boolean;
}

export interface AudioPreviewBenchmarkResult {
  name: string;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  memoryDeltaBytes?: number;
  passed: boolean;
}
