import { describe, expect, it } from "vitest";

import { commandFromKeyboardEvent, shortcutHelpItems } from "./commandRegistry";

function keyboardEvent(key: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...init,
  } as KeyboardEvent;
}

describe("command registry", () => {
  it("maps navigation shortcuts", () => {
    expect(commandFromKeyboardEvent(keyboardEvent("ArrowDown"))).toBe("move-down");
    expect(
      commandFromKeyboardEvent(keyboardEvent("ArrowDown", { shiftKey: true })),
    ).toBe("extend-down");
    expect(commandFromKeyboardEvent(keyboardEvent("f", { ctrlKey: true }))).toBe(
      "focus-search",
    );
    expect(commandFromKeyboardEvent(keyboardEvent("a", { ctrlKey: true }))).toBe(
      "select-all",
    );
  });

  it("maps current app polish shortcuts", () => {
    expect(commandFromKeyboardEvent(keyboardEvent("f", { altKey: true }))).toBe(
      "toggle-filter",
    );
    expect(commandFromKeyboardEvent(keyboardEvent("Tab", { ctrlKey: true }))).toBe(
      "next-tab",
    );
    expect(
      commandFromKeyboardEvent(keyboardEvent("Tab", { ctrlKey: true, shiftKey: true })),
    ).toBe("previous-tab");
    expect(commandFromKeyboardEvent(keyboardEvent("t"))).toBe(
      "waveform-zoom-horizontal-in",
    );
    expect(commandFromKeyboardEvent(keyboardEvent("T", { shiftKey: true }))).toBe(
      "waveform-zoom-vertical-in",
    );
    expect(commandFromKeyboardEvent(keyboardEvent("c"))).toBe("add-to-collection");
    expect(commandFromKeyboardEvent(keyboardEvent("l"))).toBe("toggle-loop");
    expect(commandFromKeyboardEvent(keyboardEvent("l", { ctrlKey: true }))).toBeNull();
  });

  it("keeps help data aligned with concrete commands", () => {
    const commands = shortcutHelpItems.map((item) => item.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(shortcutHelpItems.some((item) => item.shortcut === "Ctrl/Cmd+F")).toBe(true);
    expect(shortcutHelpItems.some((item) => item.shortcut === "C")).toBe(true);
    expect(shortcutHelpItems.some((item) => item.shortcut === "L")).toBe(true);
    expect(shortcutHelpItems.some((item) => item.shortcut === "Shift+T")).toBe(true);
    expect(shortcutHelpItems.map((item) => item.command).sort()).toEqual([
      "add-to-collection",
      "channel-all",
      "channel-left",
      "channel-right",
      "clear-transient",
      "close-tab",
      "export-selection",
      "extend-down",
      "extend-up",
      "first-row",
      "focus-search",
      "last-row",
      "move-down",
      "move-up",
      "new-tab",
      "next-tab",
      "nudge-playhead-back",
      "nudge-playhead-forward",
      "open-row",
      "page-down",
      "page-up",
      "previous-tab",
      "select-all",
      "toggle-filter",
      "toggle-loop",
      "toggle-metadata",
      "toggle-preview",
      "volume-down",
      "volume-up",
      "waveform-zoom-horizontal-in",
      "waveform-zoom-horizontal-out",
      "waveform-zoom-vertical-in",
      "waveform-zoom-vertical-out",
    ]);
  });
});
