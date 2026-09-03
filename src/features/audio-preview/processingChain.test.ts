import { describe, expect, it } from "vitest";

import {
  analysisCacheKey,
  canonicalProcessingChain,
  createGainProcessingChain,
  createProcessingChain,
  processingHash,
} from "./processingChain";

describe("processing chain", () => {
  it("creates a canonical gain-only processing contract", () => {
    const chain = createGainProcessingChain(6.004);

    expect(chain.chainOrder).toEqual(["gain"]);
    expect(chain.gain.gainDb).toBe(6);
    expect(canonicalProcessingChain(chain)).toBe(
      '{"chainOrder":["gain"],"gain":{"enabled":true,"gainDb":6,"minDb":-24,"maxDb":36},"version":1}',
    );
  });

  it("uses stable hashes for original and gain processing", () => {
    expect(processingHash(createGainProcessingChain(0))).toBe("processing:none");
    expect(processingHash(createGainProcessingChain(6))).toBe("processing:gain:6.00");
  });

  it("adds equalizer and pitch stages to the export contract", () => {
    const chain = createProcessingChain({
      gainDb: 3,
      eq: { enabled: true, lowDb: 2.25, midDb: -1, highDb: 0 },
      pitchSemitones: 2,
    });

    expect(chain.chainOrder).toEqual(["gain", "eq", "pitch"]);
    expect(processingHash(chain)).toBe(
      "processing:gain:3.00;eq:2.25:-1.00:0.00;pitch:2.00",
    );
    expect(canonicalProcessingChain(chain)).toContain('"pitch"');
  });

  it("adds selected channels to the export contract", () => {
    const chain = createProcessingChain({
      gainDb: 0,
      channelMode: "channels:0,2",
    });

    expect(chain.chainOrder).toEqual(["gain", "channel"]);
    expect(processingHash(chain)).toBe("processing:channel:0,2");
    expect(canonicalProcessingChain(chain)).toContain(
      '"channel":{"enabled":true,"channels":[0,2]}',
    );
  });

  it("adds temporary reversal to the export contract and cache identity", () => {
    const chain = createProcessingChain({ gainDb: 0, reversed: true });

    expect(chain.chainOrder).toEqual(["reverse", "gain"]);
    expect(chain.reverse).toEqual({ enabled: true });
    expect(processingHash(chain)).toBe("processing:reverse");
    expect(canonicalProcessingChain(chain)).toBe(
      '{"chainOrder":["reverse","gain"],"gain":{"enabled":true,"gainDb":0,"minDb":-24,"maxDb":36},"reverse":{"enabled":true},"version":1}',
    );
  });

  it("keys full-file analysis by asset content, gain settings, and profile", () => {
    const original = analysisCacheKey("asset-content-a", createGainProcessingChain(0));
    const processed = analysisCacheKey("asset-content-a", createGainProcessingChain(3));
    const changedAsset = analysisCacheKey(
      "asset-content-b",
      createGainProcessingChain(3),
    );

    expect(original).toContain("asset-content-a:full:processing:none");
    expect(processed).not.toBe(original);
    expect(changedAsset).not.toBe(processed);
  });
});
