import { describe, expect, it } from "vitest";

import { defaultAppConfig, parseAppConfig } from "./app-config";

describe("app config schema", () => {
  it("provides production defaults", () => {
    expect(defaultAppConfig.cache.decodedAudioMb).toBeGreaterThanOrEqual(64);
    expect(defaultAppConfig.export.defaultFormat).toBe("wav");
    expect(defaultAppConfig.libraries.cloud.freesound.defaultLicense).toBe("cc0");
    expect(defaultAppConfig.libraries.cloud.credentials).toEqual([]);
  });

  it("validates local library entries", () => {
    const config = parseAppConfig({
      libraries: {
        local: [{ id: "local-main", name: "Main", path: "D:/Audio" }],
      },
    });

    expect(config.libraries.local[0]?.enabled).toBe(true);
  });

  it("keeps cloud secrets behind credential references", () => {
    const config = parseAppConfig({
      libraries: {
        cloud: {
          credentials: [{ provider: "freesound", credentialRef: "keychain:freesound" }],
        },
      },
    });

    expect(config.libraries.cloud.credentials[0]?.credentialRef).toBe(
      "keychain:freesound",
    );
  });
});
