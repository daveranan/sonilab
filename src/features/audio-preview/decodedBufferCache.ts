import { estimateDecodedBytes } from "./audioMath";

type CacheEntry = {
  assetId: string;
  contentKey: string;
  buffer: AudioBuffer;
  byteEstimate: number;
  lastAccessedAt: number;
};

export class DecodedBufferCache {
  private entries = new Map<string, CacheEntry>();
  private totalBytes = 0;

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  get(key: string): AudioBuffer | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.lastAccessedAt = performance.now();
    return entry.buffer;
  }

  set(key: string, assetId: string, contentKey: string, buffer: AudioBuffer): void {
    this.delete(key);
    const byteEstimate = estimateDecodedBytes(
      buffer.duration,
      buffer.sampleRate,
      buffer.numberOfChannels,
    );
    if (byteEstimate > this.maxBytes) return;
    this.entries.set(key, {
      assetId,
      contentKey,
      buffer,
      byteEstimate,
      lastAccessedAt: performance.now(),
    });
    this.totalBytes += byteEstimate;
    this.evictUntilUnderCap(new Set([key]));
  }

  warmKeys(activeKey: string | null, neighborKeys: Set<string>): void {
    const keep = new Set(neighborKeys);
    if (activeKey) keep.add(activeKey);
    for (const key of this.entries.keys()) {
      if (!keep.has(key)) this.delete(key);
    }
    this.evictUntilUnderCap(activeKey ? new Set([activeKey]) : new Set());
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalBytes -= entry.byteEstimate;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  snapshot(): { entryCount: number; totalBytes: number; keys: string[] } {
    return {
      entryCount: this.entries.size,
      totalBytes: this.totalBytes,
      keys: [...this.entries.keys()],
    };
  }

  private evictUntilUnderCap(pinnedKeys: Set<string>): void {
    while (this.totalBytes > this.maxBytes) {
      const victim = [...this.entries.entries()]
        .filter(([key]) => !pinnedKeys.has(key))
        .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
      if (!victim) break;
      this.delete(victim[0]);
    }
  }
}
