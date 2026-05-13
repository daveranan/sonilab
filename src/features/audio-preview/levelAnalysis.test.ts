import { describe, expect, it } from "vitest";

import { analyzeBufferLevels } from "./levelAnalysis";
import { createGainProcessingChain } from "./processingChain";

function testBuffer(channels: number[][]): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    getChannelData: (channel: number) => Float32Array.from(channels[channel]),
  } as AudioBuffer;
}

describe("level analysis", () => {
  it("measures full-file peak, rms, clipping, and headroom", () => {
    const analysis = analyzeBufferLevels(
      testBuffer([
        [0, 0.5, -1],
        [0.25, -0.25, 0.25],
      ]),
      createGainProcessingChain(0),
    );

    expect(analysis.peakDbfs).toBeCloseTo(0, 3);
    expect(analysis.rmsDbfs).toBeCloseTo(-6.21, 1);
    expect(analysis.clippingSamples).toBe(1);
    expect(analysis.headroomDb).toBeCloseTo(0, 3);
    expect(analysis.sampleCount).toBe(6);
  });

  it("applies gain before processed analysis", () => {
    const analysis = analyzeBufferLevels(
      testBuffer([[0.5, -0.5]]),
      createGainProcessingChain(6),
    );

    expect(analysis.peakDbfs).toBeCloseTo(-0.02, 1);
  });
});
