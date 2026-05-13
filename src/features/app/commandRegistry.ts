export type AppCommand =
  | "focus-search"
  | "toggle-filter"
  | "new-tab"
  | "close-tab"
  | "next-tab"
  | "previous-tab"
  | "toggle-metadata"
  | "move-up"
  | "move-down"
  | "extend-up"
  | "extend-down"
  | "nudge-playhead-back"
  | "nudge-playhead-forward"
  | "page-up"
  | "page-down"
  | "first-row"
  | "last-row"
  | "select-all"
  | "toggle-preview"
  | "open-row"
  | "toggle-loop"
  | "add-to-collection"
  | "export-selection"
  | "volume-up"
  | "volume-down"
  | "channel-all"
  | "channel-left"
  | "channel-right"
  | "waveform-zoom-horizontal-in"
  | "waveform-zoom-horizontal-out"
  | "waveform-zoom-vertical-in"
  | "waveform-zoom-vertical-out"
  | "clear-transient";

export type ShortcutHelpItem = {
  command: AppCommand;
  label: string;
  shortcut: string;
  group: "Browse" | "Tabs" | "Preview" | "Waveform";
};

export const shortcutHelpItems: ShortcutHelpItem[] = [
  { command: "focus-search", label: "Search", shortcut: "Ctrl/Cmd+F", group: "Browse" },
  { command: "toggle-filter", label: "Filters", shortcut: "Alt+F", group: "Browse" },
  {
    command: "select-all",
    label: "Select all rows",
    shortcut: "Ctrl/Cmd+A",
    group: "Browse",
  },
  {
    command: "move-up",
    label: "Previous row",
    shortcut: "Up",
    group: "Browse",
  },
  {
    command: "move-down",
    label: "Next row",
    shortcut: "Down",
    group: "Browse",
  },
  {
    command: "extend-up",
    label: "Extend selection up",
    shortcut: "Shift+Up",
    group: "Browse",
  },
  {
    command: "extend-down",
    label: "Extend selection down",
    shortcut: "Shift+Down",
    group: "Browse",
  },
  {
    command: "page-up",
    label: "Page up",
    shortcut: "PageUp",
    group: "Browse",
  },
  {
    command: "page-down",
    label: "Page down",
    shortcut: "PageDown",
    group: "Browse",
  },
  {
    command: "first-row",
    label: "First row",
    shortcut: "Home",
    group: "Browse",
  },
  {
    command: "last-row",
    label: "Last row",
    shortcut: "End",
    group: "Browse",
  },
  {
    command: "open-row",
    label: "Open row",
    shortcut: "Enter",
    group: "Browse",
  },
  {
    command: "clear-transient",
    label: "Clear selection or region",
    shortcut: "Esc",
    group: "Browse",
  },
  {
    command: "new-tab",
    label: "New search tab",
    shortcut: "Ctrl/Cmd+T",
    group: "Tabs",
  },
  { command: "close-tab", label: "Close tab", shortcut: "Ctrl/Cmd+W", group: "Tabs" },
  { command: "next-tab", label: "Next tab", shortcut: "Ctrl/Cmd+Tab", group: "Tabs" },
  {
    command: "previous-tab",
    label: "Previous tab",
    shortcut: "Ctrl/Cmd+Shift+Tab",
    group: "Tabs",
  },
  {
    command: "toggle-metadata",
    label: "Metadata panel",
    shortcut: "Ctrl/Cmd+E",
    group: "Tabs",
  },
  {
    command: "toggle-preview",
    label: "Play or stop",
    shortcut: "Space",
    group: "Preview",
  },
  {
    command: "toggle-loop",
    label: "Loop",
    shortcut: "L",
    group: "Preview",
  },
  {
    command: "add-to-collection",
    label: "Add to collection",
    shortcut: "C",
    group: "Browse",
  },
  {
    command: "export-selection",
    label: "Send/export",
    shortcut: "S",
    group: "Preview",
  },
  {
    command: "nudge-playhead-back",
    label: "Nudge playhead back",
    shortcut: "Left",
    group: "Preview",
  },
  {
    command: "nudge-playhead-forward",
    label: "Nudge playhead forward",
    shortcut: "Right",
    group: "Preview",
  },
  {
    command: "volume-up",
    label: "Volume up",
    shortcut: "Ctrl/Cmd+Up",
    group: "Preview",
  },
  {
    command: "volume-down",
    label: "Volume down",
    shortcut: "Ctrl/Cmd+Down",
    group: "Preview",
  },
  {
    command: "channel-all",
    label: "All channels",
    shortcut: "Alt+0",
    group: "Preview",
  },
  { command: "channel-left", label: "Channel 1", shortcut: "Alt+1", group: "Preview" },
  { command: "channel-right", label: "Channel 2", shortcut: "Alt+2", group: "Preview" },
  {
    command: "waveform-zoom-horizontal-in",
    label: "Horizontal zoom in",
    shortcut: "T",
    group: "Waveform",
  },
  {
    command: "waveform-zoom-horizontal-out",
    label: "Horizontal zoom out",
    shortcut: "R",
    group: "Waveform",
  },
  {
    command: "waveform-zoom-vertical-in",
    label: "Vertical zoom in",
    shortcut: "Shift+T",
    group: "Waveform",
  },
  {
    command: "waveform-zoom-vertical-out",
    label: "Vertical zoom out",
    shortcut: "Shift+R",
    group: "Waveform",
  },
];

export function shouldIgnoreShortcut(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined") return false;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    target.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.getAttribute("role") === "slider"
  );
}

export function commandFromKeyboardEvent(event: KeyboardEvent): AppCommand | null {
  if (shouldIgnoreShortcut(event.target)) return null;

  const key = event.key.toLowerCase();
  const primary = event.ctrlKey || event.metaKey;

  if (primary && key === "f") {
    return "focus-search";
  }

  if (event.altKey && key === "f") return "toggle-filter";
  if (primary && key === "t") return "new-tab";
  if (primary && key === "w") return "close-tab";
  if (primary && event.key === "Tab") {
    return event.shiftKey ? "previous-tab" : "next-tab";
  }
  if (primary && key === "e") return "toggle-metadata";
  if (primary && key === "a") return "select-all";
  if (!primary && !event.altKey && key === "l") return "toggle-loop";
  if (primary && event.key === "ArrowUp") return "volume-up";
  if (primary && event.key === "ArrowDown") return "volume-down";
  if (event.altKey && event.key === "0") return "channel-all";
  if (event.altKey && event.key === "1") return "channel-left";
  if (event.altKey && event.key === "2") return "channel-right";
  if (!primary && !event.altKey && key === "s") return "export-selection";
  if (!primary && !event.altKey && key === "c") return "add-to-collection";
  if (!primary && !event.altKey && key === "t") {
    return event.shiftKey ? "waveform-zoom-vertical-in" : "waveform-zoom-horizontal-in";
  }
  if (!primary && !event.altKey && key === "r") {
    return event.shiftKey
      ? "waveform-zoom-vertical-out"
      : "waveform-zoom-horizontal-out";
  }

  switch (event.key) {
    case "ArrowLeft":
      return "nudge-playhead-back";
    case "ArrowRight":
      return "nudge-playhead-forward";
    case "ArrowUp":
      return event.shiftKey ? "extend-up" : "move-up";
    case "ArrowDown":
      return event.shiftKey ? "extend-down" : "move-down";
    case "PageUp":
      return "page-up";
    case "PageDown":
      return "page-down";
    case "Home":
      return "first-row";
    case "End":
      return "last-row";
    case " ":
      return "toggle-preview";
    case "Enter":
      return "open-row";
    case "Escape":
      return "clear-transient";
    default:
      return null;
  }
}
