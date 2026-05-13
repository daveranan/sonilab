export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gain);
}

export function estimateDecodedBytes(
  durationSeconds: number,
  sampleRate: number,
  channelCount: number,
): number {
  return Math.max(0, durationSeconds) * sampleRate * channelCount * 4;
}

export function clampPlaybackRate(value: number): number {
  return Math.min(4, Math.max(0.25, value));
}

export function processedGain(mode: "original" | "processed", gainDb: number): number {
  return mode === "processed" ? dbToGain(gainDb) : 1;
}

export function clampGainDb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(36, Math.max(-24, value));
}
