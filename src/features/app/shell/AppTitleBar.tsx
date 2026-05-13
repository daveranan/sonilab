import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bug, HelpCircle, Minus, Settings, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";

function appWindow() {
  return getCurrentWindow();
}

export function HeaderActions({
  onOpenDiagnostics,
  onOpenSettings,
  onOpenShortcuts,
}: {
  onOpenDiagnostics: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center" data-titlebar-interactive>
      <Button
        className="h-full w-9 rounded-none p-0 hover:bg-muted"
        onClick={onOpenShortcuts}
        size="icon"
        title="Shortcuts"
        variant="ghost"
      >
        <HelpCircle className="size-3.5" />
      </Button>
      <Button
        className="h-full w-9 rounded-none p-0 hover:bg-muted"
        onClick={onOpenDiagnostics}
        size="icon"
        title="Diagnostics"
        variant="ghost"
      >
        <Bug className="size-3.5" />
      </Button>
      <Button
        className="h-full w-9 rounded-none p-0 hover:bg-muted"
        onClick={onOpenSettings}
        size="icon"
        title="Settings"
        variant="ghost"
      >
        <Settings className="size-3.5" />
      </Button>
    </div>
  );
}

export function WindowControls() {
  return (
    <div className="flex h-9 shrink-0 items-center" data-titlebar-interactive>
      <Button
        className="h-full w-11 rounded-none p-0 hover:bg-muted"
        onClick={() => void appWindow().minimize()}
        size="icon"
        title="Minimize"
        variant="ghost"
      >
        <Minus className="size-3.5" />
      </Button>
      <Button
        className="h-full w-11 rounded-none p-0 hover:bg-muted"
        onClick={() => void appWindow().toggleMaximize()}
        size="icon"
        title="Maximize"
        variant="ghost"
      >
        <Square className="size-3" />
      </Button>
      <Button
        className="h-full w-11 rounded-none p-0 hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => void appWindow().close()}
        size="icon"
        title="Close"
        variant="ghost"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
