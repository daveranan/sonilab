import { describe, expect, it } from "vitest";

import { formatAudioTimeParts } from "./timeFormat";

describe("formatAudioTimeParts", () => {
  it("formats minute and hour durations with millisecond parts", () => {
    expect(formatAudioTimeParts(1935.129).full).toBe("32:15.129");
    expect(formatAudioTimeParts(5535.129).full).toBe("1:32:15.129");
  });

  it("rounds through second boundaries", () => {
    expect(formatAudioTimeParts(59.9996).full).toBe("1:00.000");
  });
});
