import { describe, expect, it } from "vitest";

import { DecodedBufferCache } from "./decodedBufferCache";

function fakeBuffer(duration: number): AudioBuffer {
  return {
    duration,
    sampleRate: 48_000,
    numberOfChannels: 2,
  } as AudioBuffer;
}

describe("decoded buffer cache", () => {
  it("evicts least-recently-used buffers under the byte cap", () => {
    const cache = new DecodedBufferCache(48_000 * 2 * 4 * 2.5);
    cache.set("a", "a", "a", fakeBuffer(1));
    cache.set("b", "b", "b", fakeBuffer(1));
    cache.get("a");
    cache.set("c", "c", "c", fakeBuffer(1));

    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("b")).toBeNull();
    expect(cache.get("c")).not.toBeNull();
  });

  it("keeps current and nearby keys during aggressive eviction", () => {
    const cache = new DecodedBufferCache(48_000 * 2 * 4 * 4);
    cache.set("a", "a", "a", fakeBuffer(1));
    cache.set("b", "b", "b", fakeBuffer(1));
    cache.set("c", "c", "c", fakeBuffer(1));
    cache.warmKeys("b", new Set(["a"]));

    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("b")).not.toBeNull();
    expect(cache.get("c")).toBeNull();
  });

  it("stays under the memory ceiling during rapid preview browsing", () => {
    const maxBytes = 48_000 * 2 * 4 * 8;
    const cache = new DecodedBufferCache(maxBytes);

    for (let index = 0; index < 1_000; index += 1) {
      const key = `asset-${index}`;
      cache.set(key, key, `content-${index}`, fakeBuffer(0.5));
      cache.warmKeys(key, new Set([`asset-${index - 1}`, `asset-${index - 2}`]));
      expect(cache.snapshot().totalBytes).toBeLessThanOrEqual(maxBytes);
    }

    expect(cache.snapshot().entryCount).toBeLessThanOrEqual(3);
  });

  it("does not pin a single buffer larger than the memory ceiling", () => {
    const maxBytes = 48_000 * 2 * 4;
    const cache = new DecodedBufferCache(maxBytes);

    cache.set("large", "large", "large", fakeBuffer(2));

    expect(cache.get("large")).toBeNull();
    expect(cache.snapshot().totalBytes).toBe(0);
  });

  it("soaks thousands of short-file switches without cache growth", () => {
    const maxBytes = 48_000 * 2 * 4 * 12;
    const cache = new DecodedBufferCache(maxBytes);

    for (let index = 0; index < 5_000; index += 1) {
      const key = `short-${index}`;
      cache.set(key, key, `content-${index}`, fakeBuffer(0.1));
      cache.warmKeys(key, new Set([`short-${index - 1}`]));
    }

    const snapshot = cache.snapshot();
    expect(snapshot.totalBytes).toBeLessThanOrEqual(maxBytes);
    expect(snapshot.entryCount).toBeLessThanOrEqual(2);
  });
});
