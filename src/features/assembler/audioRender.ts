import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import {
  readPreviewFileBytes,
  resolvePreviewFile,
} from "@/features/audio-preview/commands";
import type { PreparedRegionDragFile } from "@/features/audio-preview/commands";

import type { AssemblyProject } from "./types";

const outputSampleRate = 48_000;

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

async function loadAudioBytes(assetId: string): Promise<ArrayBuffer> {
  const resolution = await resolvePreviewFile(assetId, "original");
  if (resolution.url) {
    const response = await fetch(resolution.url).catch(() => null);
    if (response?.ok) return response.arrayBuffer();
  }
  const bytes = await readPreviewFileBytes(assetId);
  if (!bytes) throw new Error(`Could not read ${assetId}.`);
  return bytes;
}

export async function renderAssemblyWav(project: AssemblyProject): Promise<Uint8Array> {
  const activeTracks = project.tracks.filter((track) => !track.muted);
  const soloTracks = activeTracks.filter((track) => track.solo);
  const audibleTracks = soloTracks.length ? soloTracks : activeTracks;
  const clips = audibleTracks.flatMap((track) =>
    track.clips.map((clip) => ({ clip, gain: track.gain })),
  );
  if (!clips.length) throw new Error("Add at least one audible clip first.");

  const assetIds = [...new Set(clips.map(({ clip }) => clip.assetId))];
  const decoder = new AudioContext();
  const decodedEntries = await Promise.all(
    assetIds.map(async (assetId) => {
      const bytes = await loadAudioBytes(assetId);
      return [assetId, await decoder.decodeAudioData(bytes.slice(0))] as const;
    }),
  );
  await decoder.close();
  const decoded = new Map(decodedEntries);
  const durationSeconds = Math.max(
    0.1,
    ...clips.map(({ clip }) => clip.startSeconds + clip.durationSeconds),
  );
  const frameCount = Math.ceil(durationSeconds * outputSampleRate);
  const context = new OfflineAudioContext(2, frameCount, outputSampleRate);

  for (const { clip, gain } of clips) {
    const buffer = decoded.get(clip.assetId);
    if (!buffer) continue;
    const offset = Math.min(
      clip.sourceStartSeconds,
      Math.max(0, buffer.duration - 0.001),
    );
    const duration = Math.min(clip.durationSeconds, buffer.duration - offset);
    if (duration <= 0) continue;
    const source = context.createBufferSource();
    const gainNode = context.createGain();
    source.buffer = buffer;
    const trackGain = Math.max(0, Math.min(2, gain));
    const fadeInSeconds = Math.min(
      duration,
      Math.max(0, clip.fadeInSeconds ?? 0),
    );
    const fadeOutSeconds = Math.min(
      duration - fadeInSeconds,
      Math.max(0, clip.fadeOutSeconds ?? 0),
    );
    const clipStart = clip.startSeconds;
    const clipEnd = clipStart + duration;
    gainNode.gain.setValueAtTime(fadeInSeconds > 0 ? 0 : trackGain, clipStart);
    if (fadeInSeconds > 0) {
      gainNode.gain.linearRampToValueAtTime(trackGain, clipStart + fadeInSeconds);
    }
    if (fadeOutSeconds > 0) {
      gainNode.gain.setValueAtTime(trackGain, clipEnd - fadeOutSeconds);
      gainNode.gain.linearRampToValueAtTime(0, clipEnd);
    }
    source.connect(gainNode).connect(context.destination);
    source.start(clip.startSeconds, offset, duration);
  }

  return encodeWav(await context.startRendering());
}

export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const bytesPerSample = 2;
  const dataLength = buffer.length * channels * bytesPerSample;
  const bytes = new Uint8Array(44 + dataLength);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);

  const channelData = Array.from({ length: channels }, (_, channel) =>
    buffer.getChannelData(channel),
  );
  let offset = 44;
  for (let frame = 0; frame < buffer.length; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channelData[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }
  return bytes;
}

export async function saveAssemblyWav(
  projectName: string,
  bytes: Uint8Array,
): Promise<string | null> {
  const safeName =
    projectName.trim().replace(/[<>:"/\\|?*]+/g, "-") || "Untitled assembly";
  if (hasTauriRuntime()) {
    const path = await save({
      defaultPath: `${safeName}.wav`,
      filters: [{ name: "Wave audio", extensions: ["wav"] }],
    });
    if (!path) return null;
    await invoke("write_assembly_wav", { path, bytes: Array.from(bytes) });
    return path;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${safeName}.wav`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return `${safeName}.wav`;
}

export async function prepareAssemblyExport(
  projectName: string,
  bytes: Uint8Array,
  format: string,
  formatSettings: Record<string, unknown> = {},
  tempFolder = "",
): Promise<PreparedRegionDragFile | null> {
  if (!hasTauriRuntime()) return null;
  return invoke<PreparedRegionDragFile>("prepare_assembly_drag_file", {
    projectName,
    bytes: Array.from(bytes),
    format: format.toLowerCase(),
    formatSettingsJson: JSON.stringify(formatSettings),
    tempFolder: tempFolder.trim() || null,
  });
}

export async function savePreparedAssemblyExport(
  projectName: string,
  prepared: PreparedRegionDragFile,
  format: string,
): Promise<string | null> {
  if (!hasTauriRuntime()) return null;
  const extension = format.toLowerCase();
  const safeName =
    projectName.trim().replace(/[<>:"/\\|?*]+/g, "-") || "Untitled assembly";
  const path = await save({
    defaultPath: `${safeName}.${extension}`,
    filters: [{ name: `${format.toUpperCase()} audio`, extensions: [extension] }],
  });
  if (!path) return null;
  await invoke("copy_prepared_assembly_export", {
    sourcePath: prepared.path,
    destinationPath: path,
  });
  return path;
}
