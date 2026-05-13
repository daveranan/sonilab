import { describe, expect, it } from "vitest";

import {
  fitViewport,
  normalizeRegion,
  panViewport,
  xToSeconds,
  zoomViewport,
} from "./waveformMath";

describe("waveform math", () => {
  it("normalizes and clamps selected regions", () => {
    expect(normalizeRegion(0.8, 0.1, 1)).toEqual({
      startSeconds: 0.1,
      endSeconds: 0.8,
    });
    expect(normalizeRegion(0.1, 0.105, 1)).toBeNull();
  });

  it("zooms around the cursor and keeps the viewport in range", () => {
    const viewport = fitViewport(10, 1000);
    const zoomed = zoomViewport(viewport, 10, 1000, 500, 2);
    expect(zoomed.visibleStartSeconds).toBeCloseTo(2.5);
    expect(zoomed.visibleEndSeconds).toBeCloseTo(7.5);
    expect(xToSeconds(500, zoomed, 1000)).toBeCloseTo(5);
  });

  it("pans without leaving the file duration", () => {
    const viewport = {
      visibleStartSeconds: 2,
      visibleEndSeconds: 7,
      pixelsPerSecond: 200,
      fitToView: false,
    };
    expect(panViewport(viewport, 10, 1000, -100).visibleStartSeconds).toBeCloseTo(1.5);
    expect(panViewport(viewport, 10, 1000, 1000).visibleEndSeconds).toBe(10);
  });
});
