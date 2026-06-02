import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://${path}`,
  invoke: invokeMock,
}));

vi.mock("@crabnebula/tauri-plugin-drag", () => ({
  startDrag: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

import {
  prepareRegionDragFile,
  queueGainExportJobs,
  startPreparedFilesDrag,
} from "./commands";

function enableTauriRuntime() {
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
    });
  }
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
}

describe("export file drag command helper", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enableTauriRuntime();
  });

  it("sends a single prepared path through the CrabNebula plugin by default", async () => {
    const pluginStartDrag = vi.fn(async (_options, onEvent) => {
      onEvent?.({ result: "Dropped" });
    });
    const nativeFallback = vi.fn();

    const result = await startPreparedFilesDrag(["C:\\tmp\\one.wav"], {
      pluginStartDrag,
      nativeFallback,
    });

    expect(result.ok).toBe(true);
    expect(result.effect).toBe("copy");
    expect(pluginStartDrag).toHaveBeenCalledWith(
      expect.objectContaining({
        item: ["C:\\tmp\\one.wav"],
        mode: "copy",
      }),
      expect.any(Function),
    );
    expect(nativeFallback).not.toHaveBeenCalled();
  });

  it("uses native COM drag first for multi-file drags by default", async () => {
    const pluginStartDrag = vi.fn();
    const nativeFallback = vi.fn(async () => ({
      ok: true,
      effect: "copy" as const,
      error: undefined,
      diagnostics: ["native"],
    }));

    const result = await startPreparedFilesDrag(
      ["C:\\tmp\\one.wav", "C:\\tmp\\two.wav"],
      {
        pluginStartDrag,
        nativeFallback,
      },
    );

    expect(result.ok).toBe(true);
    expect(nativeFallback).toHaveBeenCalledWith([
      "C:\\tmp\\one.wav",
      "C:\\tmp\\two.wav",
    ]);
    expect(pluginStartDrag).not.toHaveBeenCalled();
  });

  it("falls back to native COM drag with all paths when plugin drag fails", async () => {
    const pluginStartDrag = vi.fn(async () => {
      throw new Error("plugin unavailable");
    });
    const nativeFallback = vi.fn(async () => ({
      ok: true,
      effect: "copy" as const,
      error: undefined,
      diagnostics: ["fallback"],
    }));

    const result = await startPreparedFilesDrag(
      ["C:\\tmp\\one.wav", "C:\\tmp\\two.wav"],
      {
        pluginStartDrag,
        nativeFallback,
        preferNative: false,
      },
    );

    expect(result.ok).toBe(true);
    expect(nativeFallback).toHaveBeenCalledWith([
      "C:\\tmp\\one.wav",
      "C:\\tmp\\two.wav",
    ]);
    expect(result.diagnostics[0]).toContain("plugin unavailable");
  });

  it("uses native COM drag first for rendered export files when requested", async () => {
    const pluginStartDrag = vi.fn();
    const nativeFallback = vi.fn(async () => ({
      ok: true,
      effect: "copy" as const,
      error: undefined,
      diagnostics: ["native"],
    }));

    const result = await startPreparedFilesDrag(["C:\\tmp\\rendered.ogg"], {
      pluginStartDrag,
      nativeFallback,
      preferNative: true,
    });

    expect(result.ok).toBe(true);
    expect(nativeFallback).toHaveBeenCalledWith(["C:\\tmp\\rendered.ogg"]);
    expect(pluginStartDrag).not.toHaveBeenCalled();
  });

  it("sends crossfade and fade controls in queued export settings", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await queueGainExportJobs({
      assetIds: ["asset-1"],
      filenamePattern: "{name}",
      format: "wav",
      formatSettings: { wavBitDepth: 16 },
      gainDb: 0,
      includeAttributionSidecar: false,
      loopCrossfadeSeconds: 0.05,
      loopCrossfadeSlope: 1.8,
      outputFolder: "C:\\exports",
      overwriteMode: "rename",
      preserveFolderStructure: false,
      regionFadeGapSeconds: 0.005,
      regionFadeInSeconds: 0.01,
      regionFadeInSlope: 0.5,
      regionFadeOutSeconds: 0.02,
      regionFadeOutSlope: 2,
      region: { startSeconds: 0, endSeconds: 0.2 },
      scope: "region",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "queue_export_jobs",
      expect.objectContaining({
        exportScope: "region",
        regionStartSeconds: 0,
        regionEndSeconds: 0.2,
        formatSettingsJson: JSON.stringify({
          wavBitDepth: 16,
          loopCrossfadeSeconds: 0.05,
          loopCrossfadeSlope: 1.8,
          regionFadeGapSeconds: 0.005,
          regionFadeInSeconds: 0.01,
          regionFadeInSlope: 0.5,
          regionFadeOutSeconds: 0.02,
          regionFadeOutSlope: 2,
        }),
      }),
    );
  });

  it("sends tiny-region crossfade values to Tauri without frontend clamping", async () => {
    invokeMock.mockResolvedValueOnce({
      assetId: "asset-1",
      path: "C:\\temp\\tiny.wav",
      format: "wav",
      regionStartSeconds: 0,
      regionEndSeconds: 0.001,
      processingHash: "processing:none",
    });

    await prepareRegionDragFile({
      assetId: "asset-1",
      displayName: "tiny.wav",
      format: "wav",
      formatSettings: { wavBitDepth: 16 },
      gainDb: 0,
      loopCrossfadeSeconds: 0.0004,
      loopCrossfadeSlope: 0.25,
      region: { startSeconds: 0, endSeconds: 0.001 },
      tempFolder: "C:\\temp",
    });

    expect(invokeMock).toHaveBeenCalledWith(
      "prepare_region_drag_file",
      expect.objectContaining({
        regionStartSeconds: 0,
        regionEndSeconds: 0.001,
        loopCrossfadeSeconds: 0.0004,
        loopCrossfadeSlope: 0.25,
      }),
    );
  });
});
