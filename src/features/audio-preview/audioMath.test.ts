import { describe, expect, it } from "vitest";

import { clampGainDb, dbToGain, gainToDb, processedGain } from "./audioMath";
import { regionPlaybackStartSeconds, validLoopRegion } from "./previewService";

describe("audio math", () => {
  it("converts gain and dB", () => {
    expect(dbToGain(6)).toBeCloseTo(1.995, 3);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
  });

  it("bypasses processed gain in original mode", () => {
    expect(processedGain("original", 12)).toBe(1);
    expect(processedGain("processed", 6)).toBeCloseTo(1.995, 3);
  });

  it("clamps MVP gain range", () => {
    expect(clampGainDb(-30)).toBe(-24);
    expect(clampGainDb(40)).toBe(36);
  });

  it("validates selected-region loop points against buffer duration", () => {
    expect(validLoopRegion({ startSeconds: 0.1, endSeconds: 0.4 }, 1)).toEqual({
      startSeconds: 0.1,
      endSeconds: 0.4,
    });
    expect(validLoopRegion({ startSeconds: 0.9, endSeconds: 2 }, 1)).toEqual({
      startSeconds: 0.9,
      endSeconds: 1,
    });
    expect(validLoopRegion({ startSeconds: 0.1, endSeconds: 0.105 }, 1)).toEqual({
      startSeconds: 0.1,
      endSeconds: 0.105,
    });
    expect(validLoopRegion({ startSeconds: 0.1, endSeconds: 0.1005 }, 1)).toBeNull();
  });

  it("keeps selected-region playback starts inside the region", () => {
    const region = { startSeconds: 0.2, endSeconds: 0.6 };
    expect(regionPlaybackStartSeconds(0.1, 1, region)).toBe(0.2);
    expect(regionPlaybackStartSeconds(0.4, 1, region)).toBe(0.4);
    expect(regionPlaybackStartSeconds(0.6, 1, region)).toBe(0.2);
    expect(regionPlaybackStartSeconds(1.4, 1, region)).toBe(0.2);
  });
});
