import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { startDrag as startCrabnebulaDrag } from "@crabnebula/tauri-plugin-drag";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import type { LevelAnalysisPair } from "./levelAnalysis";
import {
  canonicalProcessingChain,
  createProcessingChain,
  processingHash,
} from "./processingChain";
import type {
  ChannelMonitorMode,
  EqualizerSettings,
  PreviewFileResolution,
  WaveformPeakData,
  WaveformRegion,
} from "./types";

export type ExportJobSnapshot = {
  id: string;
  assetId: string | null;
  status: string;
  exportScope: "full" | "region";
  format: string;
  processingHash: string;
  outputFolder: string;
  filenamePattern: string;
  outputPath: string | null;
  errorMessage: string | null;
  progress: number;
};

export type CacheKindSummary = {
  kind: string;
  entries: number;
  bytes: number;
};

export type CacheManagementSummary = {
  cacheDir: string;
  totalEntries: number;
  totalBytes: number;
  diskBytes: number;
  byKind: CacheKindSummary[];
};

export type AssetUserMetadata = {
  assetId: string;
  userTags: string[];
  userComment: string;
};

export type RegionNote = {
  id: string;
  assetId: string;
  startSeconds: number;
  endSeconds: number;
  comment: string;
  createdAt: string;
  updatedAt: string;
};

export type LicenseAttributionRow = {
  assetId: string;
  name: string;
  sourceName: string;
  path: string;
  license: string | null;
  attribution: string | null;
  originator: string | null;
  description: string | null;
  tags: string[];
};

export type UpdateFlowStatus = {
  currentVersion: string;
  channel: string;
  endpointConfigured: boolean;
  signingPublicKeyConfigured: boolean;
  updateCheckAvailable: boolean;
  message: string;
};

export type AppUpdateInstallResult = {
  status: "not-available" | "installed";
  version?: string;
};

export type AppUpdateAvailability = {
  available: boolean;
  version?: string;
  currentVersion?: string;
  body?: string;
};

export type ExportFormatSettings = {
  wavBitDepth?: number;
  wavSampleRate?: number;
  loopCrossfadeSeconds?: number;
  loopCrossfadeSlope?: number;
  regionFadeGapSeconds?: number;
  regionFadeInSeconds?: number;
  regionFadeInSlope?: number;
  regionFadeOutSeconds?: number;
  regionFadeOutSlope?: number;
  mp3BitrateKbps?: number;
  mp3Mode?: "cbr" | "vbr";
  oggQuality?: number;
  flacCompressionLevel?: number;
  aacBitrateKbps?: number;
  mp4Codec?: "aac" | "alac";
  mp4BitrateKbps?: number;
};

export type PreparedRegionDragFile = {
  assetId: string;
  path: string;
  format: string;
  regionStartSeconds: number;
  regionEndSeconds: number;
  processingHash: string;
};

export type NativeFileDragResponse = {
  ok: boolean;
  effect: "copy" | "none";
  error?: string;
  diagnostics: string[];
};

export type RegionFileDragResult = {
  prepared: PreparedRegionDragFile;
  nativeDrag: NativeFileDragResponse;
};

export type MultiFileDragResult = {
  prepared: PreparedRegionDragFile[];
  nativeDrag: NativeFileDragResponse;
};

type PluginDragResult = "Dropped" | "Cancelled" | "Cancel";
type PluginDragEvent = { result: PluginDragResult };
type PluginStartDrag = (
  options: { item: string[]; icon: string; mode: "copy" },
  onEvent?: (result: PluginDragEvent) => void,
) => Promise<void>;
type NativeFileDragFallback = (filePaths: string[]) => Promise<NativeFileDragResponse>;
type ExportProcessingInput = {
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
};

const transparentDragIcon =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const preparedDragFileCache = new Map<string, Promise<PreparedRegionDragFile>>();
const maxPreparedDragFileCacheEntries = 24;

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluginCancelledResponse(): NativeFileDragResponse {
  return {
    ok: false,
    effect: "none",
    error: "Plugin drag cancelled; temp file is ready.",
    diagnostics: ["CrabNebula drag-rs plugin reported cancel."],
  };
}

function cachedPreparedDragFile(
  key: string,
  prepare: () => Promise<PreparedRegionDragFile>,
): Promise<PreparedRegionDragFile> {
  const cached = preparedDragFileCache.get(key);
  if (cached) return cached;
  const promise = prepare().catch((error: unknown) => {
    preparedDragFileCache.delete(key);
    throw error;
  });
  preparedDragFileCache.set(key, promise);
  if (preparedDragFileCache.size > maxPreparedDragFileCacheEntries) {
    const firstKey = preparedDragFileCache.keys().next().value;
    if (firstKey) preparedDragFileCache.delete(firstKey);
  }
  return promise;
}

function createExportProcessingChain(input: ExportProcessingInput) {
  return createProcessingChain({
    gainDb: input.gainDb,
    channelMode: input.channelMode,
    eq: input.eq,
    pitchSemitones: input.pitchSemitones,
    reversed: input.reversed,
  });
}

export async function resolvePreviewFile(
  assetId: string,
  requestedMode: "original" | "processed",
): Promise<PreviewFileResolution> {
  if (hasTauri()) {
    try {
      const resolved = await invoke<PreviewFileResolution>("resolve_preview_file", {
        assetId,
        requestedMode,
      });
      return {
        ...resolved,
        path: normalizeWindowsFilePath(resolved.path),
        url: resolved.url ?? convertFileSrc(normalizeWindowsFilePath(resolved.path)),
      };
    } catch (error) {
      if (assetId.startsWith("asset-")) return mockPreviewFile(assetId);
      throw error;
    }
  }

  return mockPreviewFile(assetId);
}

function normalizeWindowsFilePath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  if (path.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

export async function readPreviewFileBytes(
  assetId: string,
): Promise<ArrayBuffer | null> {
  if (!hasTauri()) return null;
  const bytes = await invoke<number[]>("read_preview_file_bytes", { assetId });
  return new Uint8Array(bytes).buffer;
}

export async function cacheFreesoundPreview(
  assetId: string,
): Promise<{ assetId: string; path: string; byteSize: number } | null> {
  if (!hasTauri()) return null;
  return invoke<{ assetId: string; path: string; byteSize: number }>(
    "cache_freesound_preview",
    { assetId },
  );
}

export async function importFreesoundOriginal(
  assetId: string,
): Promise<{ assetId: string; path: string; byteSize: number } | null> {
  if (!hasTauri()) return null;
  return invoke<{ assetId: string; path: string; byteSize: number }>(
    "import_freesound_original",
    { assetId },
  );
}

export async function importCloudOriginal(
  assetId: string,
): Promise<{ assetId: string; path: string; byteSize: number } | null> {
  if (!hasTauri()) return null;
  return invoke<{ assetId: string; path: string; byteSize: number }>(
    "import_cloud_original",
    { assetId },
  );
}

export async function getWaveformPeaks(
  assetId: string,
  contentKey: string,
  channelMode: "mono" | "stereo" | "source",
  samplesPerPeak: number,
): Promise<WaveformPeakData> {
  if (hasTauri()) {
    try {
      return await invoke<WaveformPeakData>("get_waveform_peaks", {
        assetId,
        contentKey,
        channelMode,
        samplesPerPeak,
      });
    } catch (error) {
      if (contentKey.startsWith("mock:")) {
        return mockWaveformPeaks(assetId, contentKey, channelMode, samplesPerPeak);
      }
      throw error;
    }
  }

  return mockWaveformPeaks(assetId, contentKey, channelMode, samplesPerPeak);
}

export async function getCachedWaveformPeaks(
  assetId: string,
  contentKey: string,
  channelMode: "mono" | "stereo" | "source",
  samplesPerPeak: number,
): Promise<WaveformPeakData | null> {
  if (hasTauri()) {
    try {
      return await invoke<WaveformPeakData | null>("get_cached_waveform_peaks", {
        assetId,
        contentKey,
        channelMode,
        samplesPerPeak,
      });
    } catch {
      return null;
    }
  }

  return mockWaveformPeaks(assetId, contentKey, channelMode, samplesPerPeak);
}

export async function getCachedWaveformPeakRange(
  assetId: string,
  contentKey: string,
  channelMode: "mono" | "stereo" | "source",
  samplesPerPeak: number,
  startSeconds: number,
  endSeconds: number,
): Promise<WaveformPeakData | null> {
  if (hasTauri()) {
    try {
      return await invoke<WaveformPeakData | null>("get_cached_waveform_peak_range", {
        assetId,
        contentKey,
        channelMode,
        samplesPerPeak,
        startSeconds,
        endSeconds,
      });
    } catch {
      return null;
    }
  }

  return mockWaveformPeaks(assetId, contentKey, channelMode, samplesPerPeak);
}

function mockPreviewFile(assetId: string): PreviewFileResolution {
  return {
    assetId,
    contentKey: `mock:${assetId}`,
    path: "",
    url: null,
    mediaType: "mock",
    durationSeconds: 1.84,
    channelCount: 2,
    processedAvailable: false,
  };
}

export async function analyzeAudioLevels(
  assetId: string,
  gainDb: number,
): Promise<LevelAnalysisPair | null> {
  if (!hasTauri()) return null;
  return invoke<LevelAnalysisPair>("analyze_audio_levels", { assetId, gainDb });
}

export async function cancelAudioJob(jobId: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("cancel_audio_job", { jobId });
}

export type AudioRuntimeStatus = {
  waveformActive: number;
  waveformMaxActive: number;
  waveformQueueDepth: number;
  analysisActive: number;
  analysisMaxActive: number;
};

export async function audioRuntimeStatus(): Promise<AudioRuntimeStatus | null> {
  if (!hasTauri()) return null;
  return invoke<AudioRuntimeStatus>("audio_runtime_status");
}

export async function cancelExportJob(jobId: string): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("cancel_export_job", { jobId });
}

export async function enforceCacheLimit(limitBytes: number): Promise<{
  limitBytes: number;
  beforeBytes: number;
  afterBytes: number;
  removedEntries: number;
} | null> {
  if (!hasTauri()) return null;
  return invoke("enforce_cache_limit", { limitBytes });
}

export async function cacheManagementSummary(): Promise<CacheManagementSummary | null> {
  if (!hasTauri()) return null;
  return invoke<CacheManagementSummary>("cache_management_summary");
}

export async function licenseAttributionReport(
  limit = 200,
): Promise<LicenseAttributionRow[]> {
  if (!hasTauri()) return [];
  return invoke<LicenseAttributionRow[]>("license_attribution_report", { limit });
}

export async function assetUserMetadata(assetId: string): Promise<AssetUserMetadata> {
  if (!hasTauri()) return { assetId, userTags: [], userComment: "" };
  return invoke<AssetUserMetadata>("asset_user_metadata", { assetId });
}

export async function updateAssetUserMetadata(input: {
  assetId: string;
  userTags: string[];
  userComment: string;
}): Promise<AssetUserMetadata> {
  if (!hasTauri()) {
    return {
      assetId: input.assetId,
      userTags: input.userTags,
      userComment: input.userComment,
    };
  }
  return invoke<AssetUserMetadata>("update_asset_user_metadata", input);
}

export async function listRegionNotes(assetId: string): Promise<RegionNote[]> {
  if (!hasTauri()) return [];
  return invoke<RegionNote[]>("list_region_notes", { assetId });
}

export async function upsertRegionNote(input: {
  id?: string | null;
  assetId: string;
  startSeconds: number;
  endSeconds: number;
  comment: string;
}): Promise<RegionNote> {
  if (!hasTauri()) {
    return {
      id: input.id ?? `mock-note-${Date.now()}`,
      assetId: input.assetId,
      startSeconds: input.startSeconds,
      endSeconds: input.endSeconds,
      comment: input.comment,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  return invoke<RegionNote>("upsert_region_note", input);
}

export async function deleteRegionNote(id: string): Promise<boolean> {
  if (!hasTauri()) return true;
  return invoke<boolean>("delete_region_note", { id });
}

export async function updateFlowStatus(): Promise<UpdateFlowStatus | null> {
  if (!hasTauri()) return null;
  return invoke<UpdateFlowStatus>("update_flow_status");
}

export async function checkInstallAndRelaunchUpdate(
  onStatus?: (status: string) => void,
): Promise<AppUpdateInstallResult> {
  if (!hasTauri()) return { status: "not-available" };
  onStatus?.("Checking for updates...");
  const update = await check();
  if (!update) {
    onStatus?.("No update available.");
    return { status: "not-available" };
  }

  let downloaded = 0;
  let totalBytes = 0;
  onStatus?.(`Downloading ${update.version}...`);
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      totalBytes = event.data.contentLength ?? 0;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      if (totalBytes > 0) {
        const percent = Math.round((downloaded / totalBytes) * 100);
        onStatus?.(`Downloading ${update.version} (${percent}%)...`);
      }
    } else if (event.event === "Finished") {
      onStatus?.("Update installed. Restarting...");
    }
  });
  await relaunch();
  return { status: "installed", version: update.version };
}

export async function checkForAppUpdate(): Promise<AppUpdateAvailability> {
  if (!hasTauri()) return { available: false };
  const update = await check();
  if (!update) return { available: false };
  return {
    available: true,
    body: update.body,
    currentVersion: update.currentVersion,
    version: update.version,
  };
}

export async function queueGainExportJob(input: {
  assetId: string;
  format: string;
  outputFolder: string;
  filenamePattern?: string;
  region: WaveformRegion | null;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
}): Promise<ExportJobSnapshot | null> {
  if (!hasTauri()) return null;
  const chain = createExportProcessingChain(input);
  return invoke<ExportJobSnapshot>("queue_export_job", {
    assetId: input.assetId,
    format: input.format.toLowerCase(),
    outputFolder: input.outputFolder,
    filenamePattern: input.filenamePattern ?? "{name}_processed",
    exportScope: input.region ? "region" : "full",
    regionStartSeconds: input.region?.startSeconds ?? null,
    regionEndSeconds: input.region?.endSeconds ?? null,
    formatSettingsJson: "{}",
    processingJson: canonicalProcessingChain(chain),
    processingHash: processingHash(chain),
    preserveFolderStructure: false,
    includeAttributionSidecar: false,
    overwriteMode: "rename",
  });
}

export async function queueGainExportJobs(input: {
  assetIds: string[];
  format: string;
  outputFolder: string;
  filenamePattern: string;
  scope: "full" | "region";
  region: WaveformRegion | null;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
  loopCrossfadeSeconds?: number | null;
  loopCrossfadeSlope?: number | null;
  regionFadeGapSeconds?: number | null;
  regionFadeInSeconds?: number | null;
  regionFadeInSlope?: number | null;
  regionFadeOutSeconds?: number | null;
  regionFadeOutSlope?: number | null;
  formatSettings: ExportFormatSettings;
  preserveFolderStructure: boolean;
  includeAttributionSidecar: boolean;
  overwriteMode: "skip" | "replace" | "rename";
}): Promise<ExportJobSnapshot[] | null> {
  if (!hasTauri()) return null;
  const chain = createExportProcessingChain(input);
  const formatSettings = {
    ...input.formatSettings,
    loopCrossfadeSeconds: input.loopCrossfadeSeconds ?? undefined,
    loopCrossfadeSlope: input.loopCrossfadeSlope ?? undefined,
    regionFadeGapSeconds: input.regionFadeGapSeconds ?? undefined,
    regionFadeInSeconds: input.regionFadeInSeconds ?? undefined,
    regionFadeInSlope: input.regionFadeInSlope ?? undefined,
    regionFadeOutSeconds: input.regionFadeOutSeconds ?? undefined,
    regionFadeOutSlope: input.regionFadeOutSlope ?? undefined,
  };
  return invoke<ExportJobSnapshot[]>("queue_export_jobs", {
    assetIds: input.assetIds,
    format: input.format.toLowerCase(),
    outputFolder: input.outputFolder,
    filenamePattern: input.filenamePattern,
    exportScope: input.scope,
    regionStartSeconds: input.scope === "region" ? input.region?.startSeconds : null,
    regionEndSeconds: input.scope === "region" ? input.region?.endSeconds : null,
    formatSettingsJson: JSON.stringify(formatSettings),
    processingJson: canonicalProcessingChain(chain),
    processingHash: processingHash(chain),
    preserveFolderStructure: input.preserveFolderStructure,
    includeAttributionSidecar: input.includeAttributionSidecar,
    overwriteMode: input.overwriteMode,
  });
}

export async function listExportJobs(limit = 50): Promise<ExportJobSnapshot[]> {
  if (!hasTauri()) return [];
  return invoke<ExportJobSnapshot[]>("list_export_jobs", { limit });
}

export async function retryExportJob(jobId: string): Promise<ExportJobSnapshot[]> {
  if (!hasTauri()) return [];
  return invoke<ExportJobSnapshot[]>("retry_export_job", { jobId });
}

export async function pickOutputFolder(): Promise<string | null> {
  if (!hasTauri()) return null;
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function defaultExportFolder(): Promise<string> {
  if (!hasTauri()) return "";
  const paths = await invoke<{ data_dir?: string; dataDir?: string }>("app_paths");
  return `${paths.data_dir ?? paths.dataDir ?? ""}\\Exports`;
}

export async function prepareRegionDragFile(input: {
  assetId: string;
  displayName?: string;
  format: string;
  region: WaveformRegion;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
  loopCrossfadeSeconds?: number | null;
  loopCrossfadeSlope?: number | null;
  regionFadeGapSeconds?: number | null;
  regionFadeInSeconds?: number | null;
  regionFadeInSlope?: number | null;
  regionFadeOutSeconds?: number | null;
  regionFadeOutSlope?: number | null;
  formatSettings?: ExportFormatSettings;
  tempFolder?: string;
}): Promise<PreparedRegionDragFile | null> {
  if (!hasTauri()) return null;
  const chain = createExportProcessingChain(input);
  const request = {
    assetId: input.assetId,
    displayName: input.displayName ?? null,
    format: input.format.toLowerCase(),
    regionStartSeconds: input.region.startSeconds,
    regionEndSeconds: input.region.endSeconds,
    loopCrossfadeSeconds: input.loopCrossfadeSeconds ?? null,
    loopCrossfadeSlope: input.loopCrossfadeSlope ?? null,
    regionFadeGapSeconds: input.regionFadeGapSeconds ?? null,
    regionFadeInSeconds: input.regionFadeInSeconds ?? null,
    regionFadeInSlope: input.regionFadeInSlope ?? null,
    regionFadeOutSeconds: input.regionFadeOutSeconds ?? null,
    regionFadeOutSlope: input.regionFadeOutSlope ?? null,
    formatSettingsJson: JSON.stringify(input.formatSettings ?? {}),
    processingJson: canonicalProcessingChain(chain),
    processingHash: processingHash(chain),
    tempFolder: input.tempFolder?.trim() || null,
  };
  return cachedPreparedDragFile(`region:${JSON.stringify(request)}`, () =>
    invoke<PreparedRegionDragFile>("prepare_region_drag_file", request),
  );
}

export async function prepareAssetDragFile(input: {
  assetId: string;
  displayName?: string;
  format: string;
  region?: WaveformRegion | null;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
  regionFadeGapSeconds?: number | null;
  regionFadeInSeconds?: number | null;
  regionFadeInSlope?: number | null;
  regionFadeOutSeconds?: number | null;
  regionFadeOutSlope?: number | null;
  formatSettings?: ExportFormatSettings;
  tempFolder?: string;
}): Promise<PreparedRegionDragFile | null> {
  if (!hasTauri()) return null;
  const chain = createExportProcessingChain(input);
  const request = {
    assetId: input.assetId,
    displayName: input.displayName ?? null,
    format: input.format.toLowerCase(),
    exportScope: input.region ? "region" : "full",
    regionStartSeconds: input.region?.startSeconds ?? null,
    regionEndSeconds: input.region?.endSeconds ?? null,
    regionFadeGapSeconds: input.regionFadeGapSeconds ?? null,
    regionFadeInSeconds: input.regionFadeInSeconds ?? null,
    regionFadeInSlope: input.regionFadeInSlope ?? null,
    regionFadeOutSeconds: input.regionFadeOutSeconds ?? null,
    regionFadeOutSlope: input.regionFadeOutSlope ?? null,
    formatSettingsJson: JSON.stringify(input.formatSettings ?? {}),
    processingJson: canonicalProcessingChain(chain),
    processingHash: processingHash(chain),
    tempFolder: input.tempFolder?.trim() || null,
  };
  return cachedPreparedDragFile(`asset:${JSON.stringify(request)}`, () =>
    invoke<PreparedRegionDragFile>("prepare_asset_drag_file", request),
  );
}

async function invokeNativeFileDrag(
  filePaths: string[],
): Promise<NativeFileDragResponse> {
  return invoke<NativeFileDragResponse>("start_native_file_drag", {
    request: {
      filePath: filePaths[0],
      filePaths,
      allowedEffect: "copy",
    },
  });
}

async function startPluginFileDrag(
  paths: string[],
  pluginStartDrag: PluginStartDrag,
  icon: string,
): Promise<NativeFileDragResponse> {
  let dragResult: PluginDragResult | null = null;
  await pluginStartDrag(
    {
      item: paths,
      icon,
      mode: "copy",
    },
    (event) => {
      dragResult = event.result;
    },
  );
  if (dragResult === "Cancel" || dragResult === "Cancelled") {
    return pluginCancelledResponse();
  }
  return {
    ok: true,
    effect: "copy",
    error: undefined,
    diagnostics: [
      `CrabNebula drag-rs plugin started drag for ${paths.length} file(s).`,
    ],
  };
}

export async function startPreparedFilesDrag(
  filePaths: string[],
  options: {
    pluginStartDrag?: PluginStartDrag;
    nativeFallback?: NativeFileDragFallback;
    icon?: string;
    preferNative?: boolean;
  } = {},
): Promise<NativeFileDragResponse> {
  const paths = filePaths.filter((path) => path.trim().length > 0);
  if (paths.length === 0) {
    return {
      ok: false,
      effect: "none",
      error: "No prepared files are available for drag.",
      diagnostics: [],
    };
  }

  const pluginStartDrag = options.pluginStartDrag ?? startCrabnebulaDrag;
  const nativeFallback = options.nativeFallback ?? invokeNativeFileDrag;
  const preferNative = options.preferNative ?? false;
  if (preferNative) {
    let nativeFailure: NativeFileDragResponse;
    try {
      const native = await nativeFallback(paths);
      if (native.ok) return native;
      nativeFailure = {
        ...native,
        diagnostics: [
          "Native file drag was preferred for this file set.",
          ...native.diagnostics,
        ],
      };
    } catch (nativeError) {
      nativeFailure = {
        ok: false,
        effect: "none",
        error: `Native file drag failed: ${errorMessage(nativeError)}`,
        diagnostics: ["Native file drag was preferred for this file set."],
      };
    }
    try {
      const plugin = await startPluginFileDrag(
        paths,
        pluginStartDrag,
        options.icon ?? transparentDragIcon,
      );
      return {
        ...plugin,
        diagnostics: [
          nativeFailure.error ?? "Native file drag did not complete.",
          ...nativeFailure.diagnostics,
          ...plugin.diagnostics,
        ],
      };
    } catch (pluginError) {
      return {
        ok: false,
        effect: "none",
        error: nativeFailure.error ?? "Native file drag failed.",
        diagnostics: [
          ...nativeFailure.diagnostics,
          `CrabNebula drag-rs plugin also failed: ${errorMessage(pluginError)}`,
        ],
      };
    }
  }
  try {
    return await startPluginFileDrag(
      paths,
      pluginStartDrag,
      options.icon ?? transparentDragIcon,
    );
  } catch (pluginError) {
    const pluginDiagnostic = `CrabNebula drag-rs plugin failed: ${errorMessage(pluginError)}`;
    if (paths.length > 1) {
      return {
        ok: false,
        effect: "none",
        error:
          "Multi-file drag could not start safely; prepared files are still available.",
        diagnostics: [
          pluginDiagnostic,
          "Skipped the blocking Windows native multi-file drag fallback.",
        ],
      };
    }
    try {
      const fallback = await nativeFallback(paths);
      return {
        ...fallback,
        diagnostics: [pluginDiagnostic, ...fallback.diagnostics],
      };
    } catch (fallbackError) {
      return {
        ok: false,
        effect: "none",
        error: `Native file drag fallback failed: ${errorMessage(fallbackError)}`,
        diagnostics: [pluginDiagnostic],
      };
    }
  }
}

export async function deletePreparedDragFiles(paths: string[]): Promise<number> {
  if (!hasTauri() || paths.length === 0) return 0;
  preparedDragFileCache.clear();
  return invoke<number>("delete_prepared_drag_files", { paths });
}

export async function startRegionFileDrag(input: {
  assetId: string;
  displayName?: string;
  format: string;
  region: WaveformRegion;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
  loopCrossfadeSeconds?: number | null;
  loopCrossfadeSlope?: number | null;
  regionFadeGapSeconds?: number | null;
  regionFadeInSeconds?: number | null;
  regionFadeInSlope?: number | null;
  regionFadeOutSeconds?: number | null;
  regionFadeOutSlope?: number | null;
  formatSettings?: ExportFormatSettings;
  tempFolder?: string;
}): Promise<RegionFileDragResult | null> {
  if (!hasTauri()) return null;
  const prepared = await prepareRegionDragFile(input);
  if (!prepared) return null;
  const nativeDrag = await startPreparedFilesDrag([prepared.path]);
  return { prepared, nativeDrag };
}

export async function startAssetFileDrag(input: {
  assetId: string;
  displayName?: string;
  format: string;
  region?: WaveformRegion | null;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
  formatSettings?: ExportFormatSettings;
  tempFolder?: string;
}): Promise<RegionFileDragResult | null> {
  if (!hasTauri()) return null;
  const prepared = await prepareAssetDragFile(input);
  if (!prepared) return null;
  const nativeDrag = await startPreparedFilesDrag([prepared.path]);
  return { prepared, nativeDrag };
}

export async function startAssetFilesDrag(input: {
  assets: { assetId: string; displayName?: string }[];
  format: string;
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
  formatSettings?: ExportFormatSettings;
  tempFolder?: string;
}): Promise<MultiFileDragResult | null> {
  if (!hasTauri()) return null;
  const prepared: PreparedRegionDragFile[] = [];
  for (const asset of input.assets) {
    const next = await prepareAssetDragFile({
      assetId: asset.assetId,
      displayName: asset.displayName,
      format: input.format,
      formatSettings: input.formatSettings,
      gainDb: input.gainDb,
      channelMode: input.channelMode,
      eq: input.eq,
      pitchSemitones: input.pitchSemitones,
      reversed: input.reversed,
      region: null,
      tempFolder: input.tempFolder,
    });
    if (next) prepared.push(next);
  }
  if (prepared.length === 0) return null;
  const nativeDrag = await startPreparedFilesDrag(prepared.map((file) => file.path));
  return { prepared, nativeDrag };
}

export async function revealPreparedRegionDragFile(path: string): Promise<void> {
  if (!hasTauri()) return;
  await revealItemInDir(path);
}

export async function resolveBrowseRowPath(input: {
  rowId: string;
  rowKind: "asset" | "folder";
}): Promise<string | null> {
  if (!hasTauri()) return null;
  return invoke<string>("resolve_browse_row_path", {
    rowId: input.rowId,
    rowKind: input.rowKind,
  });
}

export async function openBrowseRowInExplorer(input: {
  rowId: string;
  rowKind: "asset" | "folder";
}): Promise<void> {
  const path = await resolveBrowseRowPath(input);
  if (!path) return;
  if (input.rowKind === "folder") {
    try {
      await openPath(path);
    } catch {
      await revealItemInDir(path);
    }
    return;
  }
  try {
    await revealItemInDir(path);
  } catch {
    await openPath(parentPath(path));
  }
}

export async function openLocalPath(path: string): Promise<void> {
  if (!path) return;
  try {
    await openPath(path);
  } catch {
    if (
      typeof navigator !== "undefined" &&
      /Windows/i.test(navigator.userAgent) &&
      /\.(?:log|ndjson|json|txt)$/i.test(path)
    ) {
      try {
        await openPath(path, "notepad");
        return;
      } catch {
        // Fall through to Explorer if no text editor can be launched.
      }
    }
    await revealItemInDir(path);
  }
}

function parentPath(path: string): string {
  const normalized = path.replace(/\//g, "\\");
  const index = normalized.lastIndexOf("\\");
  return index > 0 ? normalized.slice(0, index) : path;
}

export async function deleteBrowseRow(input: {
  rowId: string;
  rowKind: "asset" | "folder";
}): Promise<boolean> {
  if (!hasTauri()) return false;
  return invoke<boolean>("delete_browse_row", {
    rowId: input.rowId,
    rowKind: input.rowKind,
  });
}

export function mockWaveformPeaks(
  assetId: string,
  contentKey: string,
  channelMode: "mono" | "stereo" | "source",
  samplesPerPeak: number,
): WaveformPeakData {
  const peakCount = 512;
  const channels = Array.from(
    { length: channelMode === "mono" ? 1 : 2 },
    (_, channel) => {
      const minimums: number[] = [];
      const maximums: number[] = [];
      for (let index = 0; index < peakCount; index += 1) {
        const envelope = 0.2 + 0.75 * Math.abs(Math.sin(index * 0.031 + channel));
        const transient = index % 41 === 0 ? 1 : envelope;
        maximums.push(Number(Math.min(1, transient).toFixed(4)));
        minimums.push(Number((-Math.min(1, envelope * 0.9)).toFixed(4)));
      }
      return { minimums, maximums };
    },
  );

  return {
    assetId,
    contentKey,
    peakVersion: 1,
    channelMode,
    samplesPerPeak,
    durationSeconds: 1.84,
    sampleRate: 48_000,
    channelCount: channels.length,
    peakFilePath: "",
    peakStartSeconds: undefined,
    peakEndSeconds: undefined,
    channels,
    segmentMarkers: [
      {
        id: `${assetId}:segment:intro`,
        assetId,
        name: "A",
        startSeconds: 0.2,
        endSeconds: 0.56,
        createdAt: new Date(0).toISOString(),
      },
    ],
    clippingMarkers: [],
    cached: false,
  };
}
