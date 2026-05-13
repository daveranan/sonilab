import { Circle, X } from "lucide-react";

export type ViewTabModel = {
  id: string;
  label: string;
  closeable: boolean;
  dirty?: boolean;
};

export function ViewTabs({
  activeTabId,
  tabs,
  onActivate,
  onClose,
}: {
  activeTabId: string;
  tabs: ViewTabModel[];
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  function focusTab(index: number) {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-view-tab-index="${index}"]`)?.focus();
    });
  }

  return (
    <div
      className="flex h-8 select-none items-end gap-1 overflow-hidden border-b border-border bg-panel px-3"
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <div
          aria-selected={tab.id === activeTabId}
          className={`flex h-7 max-w-40 select-none items-center gap-1.5 truncate border border-b-0 px-2 text-[12px] ${
            tab.id === activeTabId
              ? "border-border bg-background text-foreground"
              : "border-transparent bg-background/30 text-muted-foreground/75 hover:text-foreground"
          }`}
          data-view-tab-index={index}
          key={tab.id}
          onClick={() => onActivate(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate(tab.id);
              return;
            }
            if (event.key === "Tab") {
              event.preventDefault();
              const delta = event.shiftKey ? -1 : 1;
              const nextIndex = (index + delta + tabs.length) % tabs.length;
              onActivate(tabs[nextIndex].id);
              focusTab(nextIndex);
            }
          }}
          role="tab"
          tabIndex={tab.id === activeTabId ? 0 : -1}
        >
          {tab.id === activeTabId ? (
            <Circle className="size-2 fill-primary text-primary" />
          ) : null}
          <span className="truncate">{tab.label}</span>
          {tab.dirty ? <span className="text-primary">*</span> : null}
          {tab.closeable ? (
            <button
              aria-label={`Close ${tab.label}`}
              className="flex size-4 items-center justify-center hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              tabIndex={-1}
              type="button"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
