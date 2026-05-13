import { describe, expect, it } from "vitest";

import {
  analysisCacheKey,
  canonicalProcessingChain,
  createGainProcessingChain,
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
