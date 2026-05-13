import { dbToGain, gainToDb } from "./audioMath";
import {
  createGainProcessingChain,
  analysisCacheKey,
  processingHash,
  type ProcessingChain,
} from "./processingChain";

export type AnalysisStatus = "pending" | "complete" | "failed";

export type LevelAnalysis = {
  status: AnalysisStatus;
  peakDbfs: number | null;
  rmsDbfs: number | null;
  clippingSamples: number;
  headroomDb: number | null;
  sampleCount: number;
  processingHash: string;
  analyzedAt: string | null;
  errorMessage?: string;
};

export type LevelAnalysisPair = {
  original: LevelAnalysis;
  processed: LevelAnalysis;
};

const cache = new Map<string, LevelAnalysis>();

function pending(processingHashValue: string): LevelAnalysis {
  return {
    status: "pending",
    peakDbfs: null,
    rmsDbfs: null,
    clippingSamples: 0,
    headroomDb: null,
    sampleCount: 0,
    processingHash: processingHashValue,
    analyzedAt: null,
  };
}

export function analyzeBufferLevels(
  buffer: AudioBuffer,
  chain: ProcessingChain,
): LevelAnalysis {
  const linearGain = dbToGain(chain.gain.gainDb);
  let peak = 0;
  let sumSquares = 0;
  let sampleCount = 0;
  let clippingSamples = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    sampleCount += data.length;
    for (let index = 0; index < data.length; index += 1) {
      const value = data[index] * linearGain;
      const absolute = Math.abs(value);
      peak = Math.max(peak, absolute);
      sumSquares += value * value;
      if (absolute >= 1) clippingSamples += 1;
    }
  }

  const peakDbfs = peak > 0 ? gainToDb(peak) : Number.NEGATIVE_INFINITY;
  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const rmsDbfs = rms > 0 ? gainToDb(rms) : Number.NEGATIVE_INFINITY;

  return {
    status: "complete",
    peakDbfs,
    rmsDbfs,
    clippingSamples,
    headroomDb: Number.isFinite(peakDbfs) ? -peakDbfs : null,
    sampleCount,
    processingHash: processingHash(chain),
    analyzedAt: new Date().toISOString(),
  };
}

export function cachedLevelAnalysis(
  contentKey: string,
  buffer: AudioBuffer | null,
  gainDb: number,
  onComplete: (pair: LevelAnalysisPair) => void,
): LevelAnalysisPair {
  const originalChain = createGainProcessingChain(0);
  const processedChain = createGainProcessingChain(gainDb);
  const originalKey = analysisCacheKey(contentKey, originalChain);
  const processedKey = analysisCacheKey(contentKey, processedChain);
  const cachedOriginal = cache.get(originalKey);
  const cachedProcessed = cache.get(processedKey);

  if (cachedOriginal && cachedProcessed) {
    return { original: cachedOriginal, processed: cachedProcessed };
  }

  if (buffer) {
    globalThis.setTimeout(() => {
      const original = cachedOriginal ?? analyzeBufferLevels(buffer, originalChain);
      const processed = cachedProcessed ?? analyzeBufferLevels(buffer, processedChain);
      cache.set(originalKey, original);
      cache.set(processedKey, processed);
      onComplete({ original, processed });
    }, 0);
  }

  return {
    original: cachedOriginal ?? pending(processingHash(originalChain)),
    processed: cachedProcessed ?? pending(processingHash(processedChain)),
  };
}
