import { clampGainDb } from "./audioMath";

export type GainStage = {
  enabled: true;
  gainDb: number;
  minDb: -24;
  maxDb: 36;
};

export type ProcessingChain = {
  version: 1;
  gain: GainStage;
  chainOrder: ["gain"];
};

export const ANALYSIS_PROFILE_HASH = "peak-rms-v1:sample-rms:decoded-pcm";

export function createGainProcessingChain(gainDb: number): ProcessingChain {
  return {
    version: 1,
    gain: {
      enabled: true,
      gainDb: Number(clampGainDb(gainDb).toFixed(2)),
      minDb: -24,
      maxDb: 36,
    },
    chainOrder: ["gain"],
  };
}

export function canonicalProcessingChain(chain: ProcessingChain): string {
  return JSON.stringify({
    chainOrder: chain.chainOrder,
    gain: chain.gain,
    version: chain.version,
  });
}

export function processingHash(chain: ProcessingChain): string {
  if (chain.gain.gainDb === 0) return "processing:none";
  return `processing:gain:${chain.gain.gainDb.toFixed(2)}`;
}

export function analysisCacheKey(
  assetContentKey: string,
  chain: ProcessingChain,
): string {
  return `analysis:v1:${assetContentKey}:full:${processingHash(chain)}:${ANALYSIS_PROFILE_HASH}`;
}
