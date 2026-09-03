import { clampEqGainDb, clampGainDb, clampPitchSemitones } from "./audioMath";
import type { ChannelMonitorMode, EqualizerSettings } from "./types";

export type GainStage = {
  enabled: true;
  gainDb: number;
  minDb: -24;
  maxDb: 36;
};

export type EqStage = {
  enabled: true;
  lowDb: number;
  midDb: number;
  highDb: number;
  minDb: -12;
  maxDb: 12;
};

export type PitchStage = {
  enabled: true;
  semitones: number;
  minSemitones: -12;
  maxSemitones: 12;
};

export type ChannelStage = {
  enabled: true;
  channels: number[];
};

export type ReverseStage = {
  enabled: true;
};

export type ProcessingChain = {
  version: 1;
  gain: GainStage;
  channel?: ChannelStage;
  eq?: EqStage;
  pitch?: PitchStage;
  reverse?: ReverseStage;
  chainOrder: ("reverse" | "gain" | "channel" | "eq" | "pitch")[];
};

export const ANALYSIS_PROFILE_HASH = "peak-rms-v1:sample-rms:decoded-pcm";

export function createGainProcessingChain(gainDb: number): ProcessingChain {
  return createProcessingChain({ gainDb });
}

export function createProcessingChain(input: {
  gainDb: number;
  channelMode?: ChannelMonitorMode;
  eq?: EqualizerSettings;
  pitchSemitones?: number;
  reversed?: boolean;
}): ProcessingChain {
  const channel = normalizedChannelStage(input.channelMode ?? "all");
  const eq = normalizedEqStage(input.eq);
  const pitch = normalizedPitchStage(input.pitchSemitones ?? 0);
  const reverse = input.reversed ? { enabled: true as const } : null;
  const chainOrder: ProcessingChain["chainOrder"] = [];
  if (reverse) chainOrder.push("reverse");
  chainOrder.push("gain");
  if (channel) chainOrder.push("channel");
  if (eq) chainOrder.push("eq");
  if (pitch) chainOrder.push("pitch");
  return {
    version: 1,
    gain: {
      enabled: true,
      gainDb: Number(clampGainDb(input.gainDb).toFixed(2)),
      minDb: -24,
      maxDb: 36,
    },
    ...(channel ? { channel } : {}),
    ...(eq ? { eq } : {}),
    ...(pitch ? { pitch } : {}),
    ...(reverse ? { reverse } : {}),
    chainOrder,
  };
}

export function canonicalProcessingChain(chain: ProcessingChain): string {
  return JSON.stringify({
    chainOrder: chain.chainOrder,
    ...(chain.channel ? { channel: chain.channel } : {}),
    ...(chain.eq ? { eq: chain.eq } : {}),
    gain: chain.gain,
    ...(chain.pitch ? { pitch: chain.pitch } : {}),
    ...(chain.reverse ? { reverse: chain.reverse } : {}),
    version: chain.version,
  });
}

export function processingHash(chain: ProcessingChain): string {
  const parts: string[] = [];
  if (chain.reverse?.enabled) {
    parts.push("reverse");
  }
  if (Math.abs(chain.gain.gainDb) >= 0.005) {
    parts.push(`gain:${chain.gain.gainDb.toFixed(2)}`);
  }
  if (chain.channel && chain.channel.channels.length > 0) {
    parts.push(`channel:${chain.channel.channels.join(",")}`);
  }
  if (chain.eq && hasAudibleEq(chain.eq)) {
    parts.push(
      `eq:${chain.eq.lowDb.toFixed(2)}:${chain.eq.midDb.toFixed(2)}:${chain.eq.highDb.toFixed(2)}`,
    );
  }
  if (chain.pitch && Math.abs(chain.pitch.semitones) >= 0.005) {
    parts.push(`pitch:${chain.pitch.semitones.toFixed(2)}`);
  }
  return parts.length === 0 ? "processing:none" : `processing:${parts.join(";")}`;
}

export function analysisCacheKey(
  assetContentKey: string,
  chain: ProcessingChain,
): string {
  return `analysis:v1:${assetContentKey}:full:${processingHash(chain)}:${ANALYSIS_PROFILE_HASH}`;
}

function normalizedEqStage(eq: EqualizerSettings | undefined): EqStage | null {
  if (!eq?.enabled) return null;
  const stage: EqStage = {
    enabled: true,
    lowDb: Number(clampEqGainDb(eq.lowDb).toFixed(2)),
    midDb: Number(clampEqGainDb(eq.midDb).toFixed(2)),
    highDb: Number(clampEqGainDb(eq.highDb).toFixed(2)),
    minDb: -12,
    maxDb: 12,
  };
  return hasAudibleEq(stage) ? stage : null;
}

function normalizedChannelStage(channelMode: ChannelMonitorMode): ChannelStage | null {
  if (channelMode === "all") return null;
  const channels = channelMode.startsWith("channels:")
    ? channelMode
        .slice("channels:".length)
        .split(",")
        .map((value) => Number(value))
    : [Number(channelMode.slice("channel:".length))];
  const uniqueChannels = Array.from(
    new Set(channels.filter((channel) => Number.isInteger(channel) && channel >= 0)),
  ).sort((left, right) => left - right);
  if (uniqueChannels.length === 0) return null;
  return {
    enabled: true,
    channels: uniqueChannels,
  };
}

function normalizedPitchStage(semitones: number): PitchStage | null {
  const clamped = Number(clampPitchSemitones(semitones).toFixed(2));
  if (Math.abs(clamped) < 0.005) return null;
  return {
    enabled: true,
    semitones: clamped,
    minSemitones: -12,
    maxSemitones: 12,
  };
}

function hasAudibleEq(eq: EqStage): boolean {
  return (
    Math.abs(eq.lowDb) >= 0.005 ||
    Math.abs(eq.midDb) >= 0.005 ||
    Math.abs(eq.highDb) >= 0.005
  );
}
