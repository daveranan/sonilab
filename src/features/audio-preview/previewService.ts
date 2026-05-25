import { convertFileSrc } from "@tauri-apps/api/core";

import { createLogger } from "@/lib/logger";
import { clampGainDb, clampPlaybackRate, processedGain } from "./audioMath";
import { readPreviewFileBytes, resolvePreviewFile } from "./commands";
import { DecodedBufferCache } from "./decodedBufferCache";
import type {
  LoopMode,
  PreviewFileResolution,
  PreviewMode,
  PreviewState,
  ProcessingSettings,
  WaveformRegion,
} from "./types";

type Listener = (state: PreviewState) => void;
type ProcessingListener = (processing: ProcessingSettings) => void;
export type OutputMeterSnapshot = {
  available: boolean;
  peakDb: number | null;
  rmsDb: number | null;
  level: number;
};
type AudioContextWithSink = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};
type HtmlAudioElementWithSink = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};
type TempLoopPreview = {
  assetId: string;
  region: WaveformRegion;
  loopDurationSeconds: number;
  headSkipSeconds: number;
};
type RegionFade = {
  fadeInSeconds: number;
  fadeInSlope: number;
  fadeOutSeconds: number;
  fadeOutSlope: number;
};

const logger = createLogger("audio-preview");
const minLoopRegionDurationSeconds = 0.001;

const defaultProcessing: ProcessingSettings = {
  mode: "original",
  gainDb: 0,
  outputVolume: 0.8,
  muted: false,
  playbackRate: 1,
  channelMode: "all",
};
const mediaRegionEndEpsilonSeconds = 0.002;

function cacheKey(assetId: string, contentKey: string, mode: PreviewMode): string {
  return `${assetId}:${contentKey}:${mode}`;
}

export function validLoopRegion(
  region: WaveformRegion | null,
  durationSeconds: number,
): WaveformRegion | null {
  if (!region) return null;
  const duration = Math.max(0, durationSeconds);
  const startSeconds = Math.max(0, Math.min(duration, region.startSeconds));
  const endSeconds = Math.max(0, Math.min(duration, region.endSeconds));
  return endSeconds - startSeconds >= minLoopRegionDurationSeconds
    ? { startSeconds, endSeconds }
    : null;
}

export function regionPlaybackStartSeconds(
  seconds: number,
  durationSeconds: number,
  region: WaveformRegion | null,
): number {
  const duration = Math.max(0, durationSeconds);
  const playheadSeconds = Math.max(0, Math.min(duration, seconds));
  const validRegion = validLoopRegion(region, duration);
  if (!validRegion) return playheadSeconds;
  return playheadSeconds >= validRegion.startSeconds &&
    playheadSeconds < validRegion.endSeconds
    ? playheadSeconds
    : validRegion.startSeconds;
}

export class AudioPreviewService {
  private audioContext: AudioContext | null = null;
  private playbackGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private mediaElement: HtmlAudioElementWithSink | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private abortController: AbortController | null = null;
  private requestId = 0;
  private state: PreviewState = {
    requestId: null,
    assetId: null,
    status: "idle",
    loopMode: "off",
    playheadSeconds: 0,
    durationSeconds: 0,
  };
  private listeners = new Set<Listener>();
  private processingListeners = new Set<ProcessingListener>();
  private bufferCache = new DecodedBufferCache();
  private processing = defaultProcessing;
  private startedAtContextTime = 0;
  private sourceOffsetSeconds = 0;
  private activeBuffer: AudioBuffer | null = null;
  private activeResolution: PreviewFileResolution | null = null;
  private loopRegion: WaveformRegion | null = null;
  private regionFade: RegionFade = {
    fadeInSeconds: 0,
    fadeInSlope: 1,
    fadeOutSeconds: 0,
    fadeOutSlope: 1,
  };
  private tempLoopPreview: TempLoopPreview | null = null;
  private mediaRegionFrame: number | null = null;
  private outputDeviceId: string | null = null;
  private mediaElementSinkId: string | null = null;
  private mediaElementSinkPendingId: string | null = null;
  private mediaElementSinkFailedId: string | null = null;
  private deviceChangeMonitorInstalled = false;
  private deviceRecoveryTimer: number | null = null;
  private recoveringPlaybackOutput = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  subscribeProcessing(listener: ProcessingListener): () => void {
    this.processingListeners.add(listener);
    listener(this.processing);
    return () => this.processingListeners.delete(listener);
  }

  getState(): PreviewState {
    return this.state;
  }

  getProcessing(): ProcessingSettings {
    return this.processing;
  }

  getActiveResolution(): PreviewFileResolution | null {
    return this.activeResolution;
  }

  getActiveBuffer(): AudioBuffer | null {
    return this.activeBuffer;
  }

  hasActivePreview(): boolean {
    return Boolean(this.activeBuffer || this.mediaElement);
  }

  hasTempLoopPreview(): boolean {
    return Boolean(this.tempLoopPreview);
  }

  exitTempLoopPreview(region: WaveformRegion | null): void {
    if (!this.tempLoopPreview) {
      this.loopRegion = region;
      return;
    }
    const playheadSeconds = this.currentPlayheadSeconds();
    this.stopPlayback();
    this.tempLoopPreview = null;
    this.activeBuffer = null;
    this.activeResolution = null;
    this.loopRegion = region;
    this.emit({
      status: "ready",
      playheadSeconds: region
        ? regionPlaybackStartSeconds(
            playheadSeconds,
            this.state.durationSeconds,
            region,
          )
        : playheadSeconds,
    });
  }

  cancelPreview(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.requestId += 1;
    this.stopPlayback();
    this.tempLoopPreview = null;
    this.activeBuffer = null;
    this.activeResolution = null;
    this.loopRegion = null;
    this.tempLoopPreview = null;
    this.emit({
      requestId: null,
      assetId: null,
      status: "idle",
      playheadSeconds: 0,
      durationSeconds: 0,
      errorMessage: undefined,
    });
  }

  outputMeterSnapshot(): OutputMeterSnapshot {
    if (!this.analyser) {
      return { available: false, peakDb: null, rmsDb: null, level: 0 };
    }
    const samples = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(samples);
    let peak = 0;
    let sumSquares = 0;
    for (const sample of samples) {
      const value = (sample - 128) / 128;
      const absolute = Math.abs(value);
      peak = Math.max(peak, absolute);
      sumSquares += value * value;
    }
    const rms = samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;
    return {
      available: true,
      peakDb: linearToDb(peak),
      rmsDb: linearToDb(rms),
      level: Math.max(0, Math.min(1, peak)),
    };
  }

  async previewAsset(
    assetId: string,
    options: {
      autoplay?: boolean;
      startSeconds?: number;
      loopMode?: LoopMode;
      region?: WaveformRegion | null;
      processing?: Partial<ProcessingSettings>;
    } = {},
  ): Promise<void> {
    const requestId = this.nextRequest(
      assetId,
      options.loopMode ?? this.state.loopMode,
    );
    this.tempLoopPreview = null;
    this.activeBuffer = null;
    this.activeResolution = null;
    this.processing = { ...this.processing, ...options.processing };
    if ("region" in options) this.loopRegion = options.region ?? null;
    this.emit({ status: "resolving", playheadSeconds: options.startSeconds ?? 0 });
    void this.ensureContext().catch(() => undefined);

    try {
      const resolution = await resolvePreviewFile(assetId, this.processing.mode);
      if (!this.isCurrent(requestId)) return;
      this.clearMediaElement();
      this.activeResolution = resolution;
      if (this.shouldStreamResolution(resolution)) {
        await this.prepareStreamingResolution(
          requestId,
          resolution,
          options.startSeconds ?? 0,
          options.autoplay ?? true,
        );
        return;
      }
      const key = cacheKey(assetId, resolution.contentKey, this.processing.mode);
      let buffer = this.bufferCache.get(key);

      if (!buffer) {
        this.emit({ status: "decoding" });
        buffer = await this.decodeResolution(resolution, this.abortController?.signal);
        if (!this.isCurrent(requestId)) return;
        this.bufferCache.set(key, assetId, resolution.contentKey, buffer);
      }

      this.activeBuffer = buffer;
      this.emit({
        status: "ready",
        durationSeconds: buffer.duration,
        playheadSeconds: options.startSeconds ?? 0,
      });
      if (options.autoplay ?? true) this.startBuffer(buffer, options.startSeconds ?? 0);
    } catch (error) {
      if (!this.isCurrent(requestId)) return;
      this.stopSource();
      this.emit({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async previewTempLoopFile(
    assetId: string,
    path: string,
    region: WaveformRegion,
    loopDurationSeconds: number,
    startSeconds = region.startSeconds,
  ): Promise<void> {
    const requestId = this.nextRequest(assetId, "region");
    this.loopRegion = region;
    this.tempLoopPreview = { assetId, region, loopDurationSeconds, headSkipSeconds: 0 };
    let byteLength = 0;
    try {
      const baseUrl = convertFileSrc(path);
      const separator = baseUrl.includes("?") ? "&" : "?";
      const url = `${baseUrl}${separator}previewRequest=${requestId}`;
      const data = await fetchPreviewArrayBuffer(url, this.abortController?.signal);
      byteLength = data.byteLength;
      if (!this.isCurrent(requestId)) return;
      const context = await this.ensureContext();
      const buffer = await context.decodeAudioData(data);
      if (!this.isCurrent(requestId)) return;
      this.clearMediaElement();
      const regionDuration = region.endSeconds - region.startSeconds;
      const actualLoopDuration = Math.min(buffer.duration, loopDurationSeconds);
      const headSkipSeconds = Math.max(0, regionDuration - actualLoopDuration);
      this.tempLoopPreview = {
        assetId,
        region,
        loopDurationSeconds: actualLoopDuration,
        headSkipSeconds,
      };
      this.activeBuffer = buffer;
      const playheadSeconds = regionPlaybackStartSeconds(
        startSeconds,
        Math.max(this.state.durationSeconds, region.endSeconds),
        region,
      );
      this.emit({
        status: "ready",
        durationSeconds: Math.max(this.state.durationSeconds, region.endSeconds),
        playheadSeconds,
      });
      this.startBuffer(buffer, playheadSeconds);
    } catch (error) {
      if (!this.isCurrent(requestId)) return;
      this.tempLoopPreview = null;
      const message = crossfadePreviewErrorMessage(error, {
        assetId,
        path,
        byteLength,
        region,
        loopDurationSeconds,
      });
      logger.error("Crossfade loop temp preview failed", {
        assetId,
        path,
        byteLength,
        regionStartSeconds: region.startSeconds,
        regionEndSeconds: region.endSeconds,
        loopDurationSeconds,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.emit({
        status: "failed",
        errorMessage: message,
      });
      throw Object.assign(new Error(message), { cause: error });
    }
  }

  async prefetchNeighbors(assetIds: string[]): Promise<void> {
    const currentRequest = this.requestId;
    const activeKey =
      this.activeResolution && this.state.assetId
        ? cacheKey(
            this.state.assetId,
            this.activeResolution.contentKey,
            this.processing.mode,
          )
        : null;
    const neighborKeys = new Set<string>();

    for (const assetId of assetIds.slice(0, 6)) {
      if (currentRequest !== this.requestId) return;
      try {
        const resolution = await resolvePreviewFile(assetId, this.processing.mode);
        const key = cacheKey(assetId, resolution.contentKey, this.processing.mode);
        neighborKeys.add(key);
        if (!this.bufferCache.get(key)) {
          const buffer = await this.decodeResolution(resolution, undefined);
          this.bufferCache.set(key, assetId, resolution.contentKey, buffer);
        }
      } catch {
        // Neighbor prefetch is opportunistic.
      }
    }

    this.bufferCache.warmKeys(activeKey, neighborKeys);
  }

  play(): void {
    if (this.mediaElement) {
      void this.playMediaElement(this.requestId).catch((error: unknown) => {
        if (!isAbortError(error)) {
          this.emit({
            status: "failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      });
      return;
    }
    if (this.state.status === "paused" && this.activeBuffer) {
      this.startBuffer(this.activeBuffer, this.state.playheadSeconds);
      return;
    }
    if (this.activeBuffer)
      this.startBuffer(this.activeBuffer, this.state.playheadSeconds);
  }

  pause(): void {
    if (this.state.status !== "playing") return;
    const playheadSeconds = this.currentPlayheadSeconds();
    if (this.mediaElement) {
      this.mediaElement.pause();
      this.stopMediaRegionMonitor();
      this.emit({ status: "paused", playheadSeconds });
      return;
    }
    this.stopSource();
    this.emit({ status: "paused", playheadSeconds });
  }

  stop(): void {
    this.stopPlayback();
    this.emit({ status: "idle", playheadSeconds: 0 });
  }

  setLoopMode(loopMode: LoopMode, region?: WaveformRegion | null): void {
    if (region !== undefined) this.loopRegion = region;
    this.emit({ loopMode });
    if (this.state.status === "playing" && this.activeBuffer) {
      this.startBuffer(this.activeBuffer, this.currentPlayheadSeconds());
    }
    this.applyMediaLooping();
    this.enforceMediaRegionBounds();
    this.startMediaRegionMonitor();
  }

  setRegion(region: WaveformRegion | null): void {
    this.loopRegion = region;
    if (!region && this.state.loopMode === "region") {
      this.emit({ loopMode: "off" });
    }
    if (region && this.state.loopMode === "file") {
      this.emit({ loopMode: "off" });
    }
    if (
      this.state.loopMode === "region" &&
      this.state.status === "playing" &&
      this.activeBuffer
    ) {
      this.startBuffer(this.activeBuffer, region?.startSeconds ?? 0);
    }
    this.applyMediaLooping();
    this.enforceMediaRegionBounds();
    this.startMediaRegionMonitor();
  }

  setRegionFade(fade: RegionFade): void {
    this.regionFade = {
      fadeInSeconds: Math.max(0, fade.fadeInSeconds),
      fadeInSlope: clampFadeSlope(fade.fadeInSlope),
      fadeOutSeconds: Math.max(0, fade.fadeOutSeconds),
      fadeOutSlope: clampFadeSlope(fade.fadeOutSlope),
    };
    this.applyMediaSettings();
    if (this.state.status === "playing" && this.activeBuffer && !this.tempLoopPreview) {
      this.startBuffer(this.activeBuffer, this.currentPlayheadSeconds());
    }
  }

  setProcessing(processing: Partial<ProcessingSettings>): void {
    const previousChannelMode = this.processing.channelMode;
    const nextChannelMode =
      processing.channelMode === undefined
        ? this.processing.channelMode
        : this.validChannelMode(processing.channelMode);
    this.processing = {
      ...this.processing,
      ...processing,
      channelMode: nextChannelMode,
      playbackRate:
        processing.playbackRate === undefined
          ? this.processing.playbackRate
          : clampPlaybackRate(processing.playbackRate),
      gainDb:
        processing.gainDb === undefined
          ? this.processing.gainDb
          : clampGainDb(processing.gainDb),
    };
    this.applyGain();
    this.emitProcessing();
    if (
      processing.channelMode !== undefined &&
      processing.channelMode !== previousChannelMode &&
      this.state.status === "playing" &&
      this.activeBuffer
    ) {
      this.startBuffer(this.activeBuffer, this.currentPlayheadSeconds());
    }
    if (this.mediaElement) this.applyMediaSettings();
  }

  async setOutputDevice(deviceId: string | null): Promise<boolean> {
    this.outputDeviceId = deviceId?.trim() || null;
    this.resetMediaSinkTracking();
    try {
      const sinkId = this.outputDeviceId ?? "";
      await this.mediaElement?.setSinkId?.(sinkId);
      if (this.mediaElement?.setSinkId) this.mediaElementSinkId = sinkId;
      const context = await this.ensureContext();
      const contextWithSink = context as AudioContextWithSink;
      if (!contextWithSink.setSinkId) return false;
      await contextWithSink.setSinkId(sinkId);
      return true;
    } catch (error) {
      this.outputDeviceId = null;
      this.resetMediaSinkTracking();
      await this.mediaElement?.setSinkId?.("")?.catch(() => undefined);
      const contextWithSink = this.audioContext as AudioContextWithSink | null;
      await contextWithSink?.setSinkId?.("")?.catch(() => undefined);
      throw error;
    }
  }

  seek(seconds: number): void {
    const duration =
      this.activeBuffer?.duration ??
      this.mediaElement?.duration ??
      this.state.durationSeconds;
    if (this.tempLoopPreview && this.activeBuffer) {
      const playheadSeconds = regionPlaybackStartSeconds(
        seconds,
        this.state.durationSeconds,
        this.tempLoopPreview.region,
      );
      if (this.state.status === "playing")
        this.startBuffer(this.activeBuffer, playheadSeconds);
      else this.emit({ playheadSeconds });
      return;
    }
    const region =
      this.state.loopMode === "file"
        ? null
        : validLoopRegion(this.loopRegion, duration);
    const playheadSeconds = regionPlaybackStartSeconds(seconds, duration, region);
    if (this.mediaElement) {
      this.mediaElement.currentTime = playheadSeconds;
      this.emit({ playheadSeconds });
    } else if (this.state.status === "playing" && this.activeBuffer) {
      this.startBuffer(this.activeBuffer, playheadSeconds);
    } else {
      this.emit({ playheadSeconds });
    }
  }

  currentPlayheadSeconds(): number {
    if (this.mediaElement) {
      if (this.tempLoopPreview) {
        const loopSeconds =
          ((this.mediaElement.currentTime % this.tempLoopPreview.loopDurationSeconds) +
            this.tempLoopPreview.loopDurationSeconds) %
          this.tempLoopPreview.loopDurationSeconds;
        return this.tempLoopPlayheadFromOffset(loopSeconds);
      }
      const seconds = this.mediaElement.currentTime || this.state.playheadSeconds;
      const duration = this.mediaElement.duration || this.state.durationSeconds;
      const region =
        this.state.loopMode === "file"
          ? null
          : validLoopRegion(this.loopRegion, duration);
      if (!region) return seconds;
      return Math.max(region.startSeconds, Math.min(region.endSeconds, seconds));
    }
    if (!this.audioContext || this.state.status !== "playing")
      return this.state.playheadSeconds;
    const elapsed =
      (this.audioContext.currentTime - this.startedAtContextTime) *
      this.processing.playbackRate;
    const next = this.sourceOffsetSeconds + elapsed;
    if (this.tempLoopPreview && this.activeBuffer) {
      const loopSeconds =
        ((next % this.tempLoopPreview.loopDurationSeconds) +
          this.tempLoopPreview.loopDurationSeconds) %
        this.tempLoopPreview.loopDurationSeconds;
      return this.tempLoopPlayheadFromOffset(loopSeconds);
    }
    const region = validLoopRegion(this.loopRegion, this.activeBuffer?.duration ?? 0);
    if (this.state.loopMode === "region" && region) {
      const span = region.endSeconds - region.startSeconds;
      return (
        region.startSeconds + ((((next - region.startSeconds) % span) + span) % span)
      );
    }
    if (region && this.state.loopMode !== "file") {
      return Math.max(region.startSeconds, Math.min(region.endSeconds, next));
    }
    if (this.state.loopMode === "file" && this.activeBuffer) {
      return next % this.activeBuffer.duration;
    }
    return Math.min(this.state.durationSeconds, next);
  }

  async benchmarkCachedSwitch(assetId: string, iterations = 20): Promise<number> {
    await this.previewAsset(assetId, { autoplay: false });
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      await this.previewAsset(assetId, { autoplay: false });
    }
    return (performance.now() - started) / iterations;
  }

  private nextRequest(assetId: string, loopMode: LoopMode): number {
    this.abortController?.abort();
    this.stopPlayback();
    this.abortController = new AbortController();
    this.requestId += 1;
    this.emit({
      requestId: this.requestId,
      assetId,
      status: "switching",
      loopMode,
      errorMessage: undefined,
    });
    return this.requestId;
  }

  private isCurrent(requestId: number): boolean {
    return requestId === this.requestId && !this.abortController?.signal.aborted;
  }

  private shouldStreamResolution(resolution: PreviewFileResolution): boolean {
    return (
      resolution.mediaType === "local-file" &&
      this.processing.mode === "original" &&
      !this.loopRegion &&
      Boolean(resolution.url)
    );
  }

  private async prepareStreamingResolution(
    requestId: number,
    resolution: PreviewFileResolution,
    startSeconds: number,
    autoplay: boolean,
  ): Promise<void> {
    await this.ensureContext();
    const audio = this.ensureMediaElement();
    if (!this.isCurrent(requestId)) return;
    this.ensureMediaSource(audio);
    this.activeBuffer = null;
    if (audio.src !== resolution.url) {
      audio.src = resolution.url ?? "";
      audio.load();
    }
    this.applyMediaSettings();
    this.applyMediaLooping();
    audio.currentTime = Math.max(0, startSeconds);
    this.emit({
      status: "ready",
      durationSeconds: resolution.durationSeconds ?? audio.duration ?? 0,
      playheadSeconds: audio.currentTime,
    });
    if (autoplay) await this.playMediaElement(requestId);
  }

  private async decodeResolution(
    resolution: PreviewFileResolution,
    signal: AbortSignal | undefined,
  ): Promise<AudioBuffer> {
    const context = await this.ensureContext();
    if (resolution.mediaType === "mock")
      return this.createMockBuffer(context, resolution.assetId);
    if (resolution.mediaType === "local-file") {
      const data = resolution.url
        ? await fetchPreviewArrayBuffer(resolution.url, signal).catch((error) => {
            if (signal?.aborted) throw error;
            return readPreviewFileBytes(resolution.assetId);
          })
        : await readPreviewFileBytes(resolution.assetId);
      if (!data) throw new Error("preview file is unavailable");
      if (signal?.aborted)
        throw new DOMException("preview decode cancelled", "AbortError");
      return context.decodeAudioData(data);
    }
    if (resolution.mediaType === "cloud-preview") {
      throw new Error("Cloud previews are deferred in this build.");
    }
    if (!resolution.url) throw new Error("preview file is unavailable");
    const response = await fetch(resolution.url, { signal });
    const data = await response.arrayBuffer();
    if (signal?.aborted)
      throw new DOMException("preview decode cancelled", "AbortError");
    return context.decodeAudioData(data);
  }

  private async ensureContext(): Promise<AudioContext> {
    this.audioContext ??= new AudioContext();
    this.startDeviceChangeMonitor();
    if (this.outputDeviceId) {
      const contextWithSink = this.audioContext as AudioContextWithSink;
      try {
        await contextWithSink.setSinkId?.(this.outputDeviceId);
      } catch (error) {
        logger.warn("Audio context output routing failed", {
          outputDevice: "custom",
          error: error instanceof Error ? error.message : String(error),
        });
        this.outputDeviceId = null;
        this.resetMediaSinkTracking();
      }
    }
    if (!this.playbackGain || !this.masterGain || !this.analyser) {
      this.playbackGain = this.audioContext.createGain();
      this.masterGain = this.audioContext.createGain();
      this.analyser = this.audioContext.createAnalyser();
      this.playbackGain.connect(this.masterGain);
      this.masterGain.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);
      this.applyGain();
    }
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    return this.audioContext;
  }

  private ensureMediaElement(): HtmlAudioElementWithSink {
    if (this.mediaElement) return this.mediaElement;
    this.startDeviceChangeMonitor();
    const audio = new Audio() as HtmlAudioElementWithSink;
    audio.preload = "auto";
    audio.addEventListener("ended", () => {
      if (this.mediaElement !== audio) return;
      this.emit({ status: "ready", playheadSeconds: audio.duration || 0 });
    });
    audio.addEventListener("loadedmetadata", () => {
      if (this.mediaElement !== audio) return;
      this.emit({ durationSeconds: audio.duration || this.state.durationSeconds });
    });
    audio.addEventListener("error", () => {
      if (this.mediaElement !== audio) return;
      this.emit({
        status: "failed",
        errorMessage: mediaErrorMessage(audio),
      });
    });
    audio.addEventListener("timeupdate", () => this.handleMediaTimeUpdate());
    this.resetMediaSinkTracking();
    this.mediaElement = audio;
    return audio;
  }

  private ensureMediaSource(audio: HtmlAudioElementWithSink): void {
    if (!this.audioContext || !this.playbackGain || this.mediaSource) return;
    this.mediaSource = this.audioContext.createMediaElementSource(audio);
    this.mediaSource.connect(this.playbackGain);
  }

  private async playMediaElement(requestId: number): Promise<void> {
    const audio = this.mediaElement;
    if (!audio) return;
    await this.resumeContextForPlayback();
    this.applyMediaSettings();
    this.seekMediaIntoPlayableRegion();
    await audio.play();
    if (!this.isCurrent(requestId)) {
      audio.pause();
      return;
    }
    this.emit({
      status: "playing",
      playheadSeconds: this.currentPlayheadSeconds(),
      durationSeconds: this.tempLoopPreview
        ? Math.max(this.state.durationSeconds, this.tempLoopPreview.region.endSeconds)
        : audio.duration || this.state.durationSeconds,
    });
    this.startMediaRegionMonitor();
  }

  private async resumeContextForPlayback(): Promise<void> {
    if (!this.audioContext || this.audioContext.state !== "suspended") return;
    try {
      await this.audioContext.resume();
    } catch (error) {
      logger.warn("Audio context resume failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleMediaTimeUpdate(): void {
    this.enforceMediaRegionBounds();
  }

  private applyMediaSettings(): void {
    const audio = this.mediaElement;
    if (!audio) return;
    const fadeGain = this.mediaRegionFadeGain(
      audio.currentTime || this.state.playheadSeconds,
    );
    audio.volume = Math.max(0, Math.min(1, fadeGain));
    audio.playbackRate = this.processing.playbackRate;
    this.applyMediaSink(audio);
  }

  private applyMediaSink(audio: HtmlAudioElementWithSink): void {
    if (!audio.setSinkId) return;
    const sinkId = this.outputDeviceId ?? "";
    if (
      this.mediaElementSinkId === sinkId ||
      this.mediaElementSinkPendingId === sinkId ||
      this.mediaElementSinkFailedId === sinkId
    ) {
      return;
    }
    this.mediaElementSinkPendingId = sinkId;
    void audio
      .setSinkId(sinkId)
      .then(() => {
        if (this.mediaElement !== audio || (this.outputDeviceId ?? "") !== sinkId)
          return;
        this.mediaElementSinkId = sinkId;
        this.mediaElementSinkFailedId = null;
      })
      .catch((error: unknown) => {
        if (this.mediaElement !== audio || (this.outputDeviceId ?? "") !== sinkId)
          return;
        this.mediaElementSinkFailedId = sinkId;
        logger.warn("Audio element output routing failed", {
          outputDevice: sinkId ? "custom" : "default",
          error: error instanceof Error ? error.message : String(error),
        });
        if (sinkId) {
          this.outputDeviceId = null;
          this.resetMediaSinkTracking();
          this.schedulePlaybackOutputRecovery();
        }
      })
      .finally(() => {
        if (this.mediaElementSinkPendingId === sinkId) {
          this.mediaElementSinkPendingId = null;
        }
      });
  }

  private applyMediaLooping(): void {
    if (!this.mediaElement) return;
    this.mediaElement.loop =
      Boolean(this.tempLoopPreview) || this.state.loopMode === "file";
  }

  private seekMediaIntoPlayableRegion(): void {
    const audio = this.mediaElement;
    if (audio && this.tempLoopPreview) return;
    if (!audio || this.state.loopMode === "file") return;
    const duration = audio.duration || this.state.durationSeconds;
    const region = validLoopRegion(this.loopRegion, duration);
    if (!region) return;
    audio.currentTime = regionPlaybackStartSeconds(
      audio.currentTime || this.state.playheadSeconds,
      duration,
      region,
    );
  }

  private enforceMediaRegionBounds(): void {
    const audio = this.mediaElement;
    if (audio && this.tempLoopPreview) {
      this.emit({ playheadSeconds: this.currentPlayheadSeconds() });
      return;
    }
    if (!audio || this.state.loopMode === "file") return;
    const duration = audio.duration || this.state.durationSeconds;
    const region = validLoopRegion(this.loopRegion, duration);
    if (!region) return;
    if (audio.currentTime < region.startSeconds) {
      audio.currentTime = region.startSeconds;
      return;
    }
    if (audio.currentTime < region.endSeconds - mediaRegionEndEpsilonSeconds) return;
    if (this.state.loopMode === "region") {
      audio.currentTime = region.startSeconds;
      this.emit({ playheadSeconds: region.startSeconds });
      return;
    }
    audio.pause();
    this.stopMediaRegionMonitor();
    audio.currentTime = region.endSeconds;
    this.emit({ status: "ready", playheadSeconds: region.endSeconds });
  }

  private startMediaRegionMonitor(): void {
    if (
      !this.mediaElement ||
      this.mediaRegionFrame !== null ||
      this.state.status !== "playing" ||
      typeof window === "undefined"
    ) {
      return;
    }
    const tick = () => {
      this.mediaRegionFrame = null;
      if (!this.mediaElement || this.state.status !== "playing") return;
      this.applyMediaSettings();
      this.enforceMediaRegionBounds();
      if (this.mediaElement && this.state.status === "playing") {
        this.startMediaRegionMonitor();
      }
    };
    this.mediaRegionFrame = window.requestAnimationFrame(tick);
  }

  private stopMediaRegionMonitor(): void {
    if (this.mediaRegionFrame === null || typeof window === "undefined") return;
    window.cancelAnimationFrame(this.mediaRegionFrame);
    this.mediaRegionFrame = null;
  }

  private startBuffer(buffer: AudioBuffer, offsetSeconds: number): void {
    if (!this.audioContext || !this.playbackGain) return;
    void this.resumeContextForPlayback();
    this.stopSource();
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.processing.playbackRate;
    if (this.tempLoopPreview) {
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = Math.min(
        buffer.duration,
        this.tempLoopPreview.loopDurationSeconds,
      );
      offsetSeconds = this.tempLoopOffsetFromPlayhead(offsetSeconds);
    } else if (this.state.loopMode === "file") {
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = buffer.duration;
    }
    const region = validLoopRegion(this.loopRegion, buffer.duration);
    let playbackDuration: number | undefined;
    let playbackEndSeconds = buffer.duration;
    const hasRegionFades = this.hasAudibleRegionFade(region);
    if (this.tempLoopPreview) {
      playbackEndSeconds = this.tempLoopPreview.region.endSeconds;
    } else if (this.state.loopMode === "region" && region) {
      offsetSeconds = regionPlaybackStartSeconds(
        offsetSeconds,
        buffer.duration,
        region,
      );
      if (hasRegionFades) {
        playbackDuration = region.endSeconds - offsetSeconds;
        playbackEndSeconds = region.endSeconds;
      } else {
        source.loop = true;
        source.loopStart = region.startSeconds;
        source.loopEnd = region.endSeconds;
      }
    } else if (region) {
      offsetSeconds = regionPlaybackStartSeconds(
        offsetSeconds,
        buffer.duration,
        region,
      );
      playbackDuration = region.endSeconds - offsetSeconds;
      playbackEndSeconds = region.endSeconds;
    }
    const envelopeGain = this.audioContext.createGain();
    this.applyBufferRegionFadeEnvelope(
      envelopeGain.gain,
      offsetSeconds,
      buffer.duration,
      buffer.sampleRate,
    );
    envelopeGain.connect(this.playbackGain);
    this.connectSourceForChannelMode(source, buffer, envelopeGain);
    source.onended = () => {
      if (this.source !== source || source.loop) return;
      envelopeGain.disconnect();
      if (this.state.loopMode === "region" && region && hasRegionFades) {
        this.startBuffer(buffer, region.startSeconds);
        return;
      }
      this.emit({ status: "ready", playheadSeconds: playbackEndSeconds });
    };
    this.source = source;
    this.startedAtContextTime = this.audioContext.currentTime;
    this.sourceOffsetSeconds = Math.max(0, Math.min(buffer.duration, offsetSeconds));
    source.start(0, this.sourceOffsetSeconds, playbackDuration);
    this.emit({
      status: "playing",
      playheadSeconds: this.tempLoopPreview
        ? this.tempLoopPlayheadFromOffset(this.sourceOffsetSeconds)
        : this.sourceOffsetSeconds,
    });
  }

  private stopSource(): void {
    const source = this.source;
    if (!source) return;
    this.source = null;
    try {
      source.stop();
    } catch {
      // Source may already be stopped by Web Audio.
    }
    source.disconnect();
  }

  private stopPlayback(): void {
    this.stopSource();
    this.stopMediaRegionMonitor();
    if (!this.mediaElement) return;
    this.mediaElement.pause();
  }

  private clearMediaElement(): void {
    if (!this.mediaElement) return;
    this.mediaElement.pause();
    this.mediaSource?.disconnect();
    this.mediaElement.removeAttribute("src");
    this.mediaElement.load();
    this.mediaElement = null;
    this.mediaSource = null;
    this.resetMediaSinkTracking();
    this.tempLoopPreview = null;
  }

  private resetMediaSinkTracking(): void {
    this.mediaElementSinkId = null;
    this.mediaElementSinkPendingId = null;
    this.mediaElementSinkFailedId = null;
  }

  private startDeviceChangeMonitor(): void {
    if (
      this.deviceChangeMonitorInstalled ||
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.addEventListener
    ) {
      return;
    }
    navigator.mediaDevices.addEventListener("devicechange", () =>
      this.schedulePlaybackOutputRecovery(),
    );
    this.deviceChangeMonitorInstalled = true;
  }

  private schedulePlaybackOutputRecovery(): void {
    if (
      typeof window === "undefined" ||
      this.deviceRecoveryTimer !== null ||
      this.state.status !== "playing"
    ) {
      return;
    }
    this.deviceRecoveryTimer = window.setTimeout(() => {
      this.deviceRecoveryTimer = null;
      void this.recoverPlaybackOutput();
    }, 150);
  }

  private async recoverPlaybackOutput(): Promise<void> {
    if (this.recoveringPlaybackOutput || this.state.status !== "playing") return;
    this.recoveringPlaybackOutput = true;
    try {
      const requestId = this.requestId;
      const playheadSeconds = this.currentPlayheadSeconds();
      this.resetMediaSinkTracking();
      await this.resumeContextForPlayback();
      if (!this.isCurrent(requestId) || this.state.status !== "playing") return;
      if (this.mediaElement) {
        this.applyMediaSettings();
        if (this.mediaElement.paused) {
          await this.playMediaElement(requestId);
        }
        return;
      }
      if (this.activeBuffer) {
        this.startBuffer(this.activeBuffer, playheadSeconds);
      }
    } catch (error) {
      logger.warn("Audio output recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.recoveringPlaybackOutput = false;
    }
  }

  private applyGain(): void {
    if (!this.playbackGain || !this.masterGain || !this.audioContext) return;
    const now = this.audioContext.currentTime;
    const playbackGain = processedGain(this.processing.mode, this.processing.gainDb);
    const masterGain = this.processing.muted ? 0 : this.processing.outputVolume;
    this.playbackGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.cancelScheduledValues(now);
    this.playbackGain.gain.setTargetAtTime(playbackGain, now, 0.01);
    this.masterGain.gain.setTargetAtTime(masterGain, now, 0.01);
  }

  private mediaRegionFadeGain(seconds: number): number {
    if (this.tempLoopPreview) return 1;
    const region = validLoopRegion(this.loopRegion, this.state.durationSeconds);
    if (!region) return 1;
    return regionFadeGain(seconds, region, this.regionFade);
  }

  private tempLoopOffsetFromPlayhead(playheadSeconds: number): number {
    const preview = this.tempLoopPreview;
    if (!preview) return playheadSeconds;
    const regionDuration = preview.region.endSeconds - preview.region.startSeconds;
    const headSkip = Math.min(preview.headSkipSeconds, regionDuration * 0.5);
    const relative = Math.max(
      0,
      Math.min(regionDuration, playheadSeconds - preview.region.startSeconds),
    );
    if (relative >= headSkip)
      return Math.min(preview.loopDurationSeconds, relative - headSkip);
    return Math.max(0, preview.loopDurationSeconds - headSkip + relative);
  }

  private tempLoopPlayheadFromOffset(offsetSeconds: number): number {
    const preview = this.tempLoopPreview;
    if (!preview) return offsetSeconds;
    const regionDuration = preview.region.endSeconds - preview.region.startSeconds;
    const headSkip = Math.min(preview.headSkipSeconds, regionDuration * 0.5);
    const bodyDuration = Math.max(0, preview.loopDurationSeconds - headSkip);
    const loopSeconds =
      ((offsetSeconds % preview.loopDurationSeconds) + preview.loopDurationSeconds) %
      preview.loopDurationSeconds;
    const relative =
      loopSeconds < bodyDuration
        ? headSkip + loopSeconds
        : regionDuration - headSkip + (loopSeconds - bodyDuration);
    return preview.region.startSeconds + Math.min(regionDuration, relative);
  }

  private hasAudibleRegionFade(region: WaveformRegion | null): boolean {
    if (!region || this.tempLoopPreview) return false;
    return this.regionFade.fadeInSeconds > 0 || this.regionFade.fadeOutSeconds > 0;
  }

  private applyBufferRegionFadeEnvelope(
    gain: AudioParam,
    offsetSeconds: number,
    durationSeconds: number,
    sampleRate: number,
  ): void {
    if (!this.audioContext || this.tempLoopPreview) {
      gain.value = 1;
      return;
    }
    const region = validLoopRegion(this.loopRegion, durationSeconds);
    if (!region) {
      gain.value = 1;
      return;
    }
    const startGain = regionFadeGain(offsetSeconds, region, this.regionFade);
    const now = this.audioContext.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(startGain, now);
    if (
      this.regionFade.fadeInSeconds > 0 &&
      offsetSeconds < region.startSeconds + this.regionFade.fadeInSeconds
    ) {
      const fadeEnd = region.startSeconds + this.regionFade.fadeInSeconds;
      const duration = Math.max(0, fadeEnd - offsetSeconds);
      if (duration > 0.001) {
        gain.setValueCurveAtTime(
          fadeCurve(
            regionFadeGain(offsetSeconds, region, this.regionFade),
            1,
            this.regionFade.fadeInSlope,
          ),
          now,
          duration,
        );
      } else {
        gain.setValueAtTime(1, now);
      }
    }
    if (this.regionFade.fadeOutSeconds > 0 && offsetSeconds < region.endSeconds) {
      const fadeStart = Math.max(
        region.startSeconds,
        region.endSeconds - this.regionFade.fadeOutSeconds,
      );
      const fadeStartTime = now + Math.max(0, fadeStart - offsetSeconds);
      gain.setValueAtTime(
        regionFadeGain(fadeStart, region, this.regionFade),
        fadeStartTime,
      );
      const lastAudibleSeconds = Math.max(
        fadeStart,
        region.endSeconds - 1 / Math.max(1, sampleRate),
      );
      const duration = Math.max(0, lastAudibleSeconds - fadeStart);
      if (duration > 0.001) {
        gain.setValueCurveAtTime(
          fadeCurve(1, 0, this.regionFade.fadeOutSlope),
          fadeStartTime,
          duration,
        );
        gain.setValueAtTime(0, now + Math.max(0, region.endSeconds - offsetSeconds));
      } else {
        gain.setValueAtTime(
          0,
          now + Math.max(0, lastAudibleSeconds - offsetSeconds),
        );
      }
    }
  }

  private connectSourceForChannelMode(
    source: AudioBufferSourceNode,
    buffer: AudioBuffer,
    destination: AudioNode,
  ): void {
    if (!this.audioContext) return;
    const sourceChannel = this.channelIndexFromMode(
      this.processing.channelMode,
      buffer.numberOfChannels,
    );
    if (sourceChannel === null || buffer.numberOfChannels < 2) {
      source.connect(destination);
      return;
    }
    const splitter = this.audioContext.createChannelSplitter(buffer.numberOfChannels);
    const merger = this.audioContext.createChannelMerger(2);
    source.connect(splitter);
    splitter.connect(merger, sourceChannel, 0);
    splitter.connect(merger, sourceChannel, 1);
    merger.connect(destination);
  }

  private validChannelMode(channelMode: ProcessingSettings["channelMode"]) {
    if (channelMode === "all") return channelMode;
    const sourceChannel = this.channelIndexFromMode(
      channelMode,
      this.activeBuffer?.numberOfChannels ?? Number.MAX_SAFE_INTEGER,
    );
    return sourceChannel === null ? "all" : channelMode;
  }

  private channelIndexFromMode(
    channelMode: ProcessingSettings["channelMode"],
    channelCount: number,
  ): number | null {
    if (channelMode === "all") return null;
    const match = /^channel:(\d+)$/.exec(channelMode);
    if (!match) return null;
    const index = Number(match[1]);
    return Number.isInteger(index) && index >= 0 && index < channelCount ? index : null;
  }

  private createMockBuffer(context: AudioContext, assetId: string): AudioBuffer {
    const durationSeconds = 1.84;
    const sampleRate = context.sampleRate;
    const buffer = context.createBuffer(
      2,
      Math.floor(durationSeconds * sampleRate),
      sampleRate,
    );
    const seed = [...assetId].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        const t = index / sampleRate;
        const envelope = Math.max(0, 1 - t / durationSeconds);
        data[index] =
          Math.sin(t * (280 + seed + channel * 80) * Math.PI * 2) * envelope * 0.25;
      }
    }
    return buffer;
  }

  private emit(patch: Partial<PreviewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private emitProcessing(): void {
    for (const listener of this.processingListeners) listener(this.processing);
  }
}

export const audioPreviewService = new AudioPreviewService();

function regionFadeGain(
  seconds: number,
  region: WaveformRegion,
  fade: RegionFade,
): number {
  const duration = Math.max(0, region.endSeconds - region.startSeconds);
  const fadeIn = Math.max(0, Math.min(fade.fadeInSeconds, duration));
  const fadeOut = Math.max(0, Math.min(fade.fadeOutSeconds, duration));
  let gain = 1;
  if (fadeIn > 0 && seconds < region.startSeconds + fadeIn) {
    gain *= Math.pow(
      Math.max(0, (seconds - region.startSeconds) / fadeIn),
      clampFadeSlope(fade.fadeInSlope),
    );
  }
  if (fadeOut > 0 && seconds > region.endSeconds - fadeOut) {
    gain *= Math.pow(
      Math.max(0, (region.endSeconds - seconds) / fadeOut),
      clampFadeSlope(fade.fadeOutSlope),
    );
  }
  return Math.max(0, Math.min(1, gain));
}

function fadeCurve(start: number, end: number, slope: number): Float32Array {
  const points = 64;
  const curve = new Float32Array(points);
  const clampedSlope = clampFadeSlope(slope);
  for (let index = 0; index < points; index += 1) {
    const t = index / (points - 1);
    curve[index] = start + (end - start) * Math.pow(t, clampedSlope);
  }
  return curve;
}

function clampFadeSlope(slope: number): number {
  return Math.max(0.25, Math.min(4, Number.isFinite(slope) ? slope : 1));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function crossfadePreviewErrorMessage(
  error: unknown,
  context: {
    assetId: string;
    path: string;
    byteLength: number;
    region: WaveformRegion;
    loopDurationSeconds: number;
  },
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const region = `${context.region.startSeconds.toFixed(6)}-${context.region.endSeconds.toFixed(6)}s`;
  const loopDuration = context.loopDurationSeconds.toFixed(6);
  const byteCount =
    context.byteLength > 0 ? `${context.byteLength} bytes` : "no bytes read";
  return `Crossfade loop preview failed: ${detail} (${context.assetId}, region ${region}, loop ${loopDuration}s, ${byteCount}, ${context.path})`;
}

function mediaErrorMessage(audio: HTMLAudioElement): string {
  const code = audio.error?.code;
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    return "Audio source is not supported by the streaming player.";
  }
  if (code === MediaError.MEDIA_ERR_NETWORK) return "Audio source could not be loaded.";
  if (code === MediaError.MEDIA_ERR_DECODE) return "Audio source could not be decoded.";
  return "Audio playback failed.";
}

function linearToDb(value: number): number | null {
  return value > 0 ? 20 * Math.log10(value) : null;
}

async function fetchPreviewArrayBuffer(
  url: string,
  signal: AbortSignal | undefined,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`preview file fetch failed: ${response.status}`);
  return response.arrayBuffer();
}
