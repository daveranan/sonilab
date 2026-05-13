import { ChevronRight, Home } from "lucide-react";

export function Breadcrumbs({
  segments,
  onNavigate,
}: {
  segments: string[];
  onNavigate?: (index: number) => void;
}) {
  return (
    <nav className="flex h-8 select-none items-center gap-1 overflow-hidden border-b border-border bg-background px-3 text-[12px] text-muted-foreground/80">
      <button
        className="flex size-5 shrink-0 items-center justify-center hover:text-foreground"
        onClick={() => onNavigate?.(-1)}
        title="Open root"
        type="button"
      >
        <Home className="size-3.5" />
      </button>
      {segments.map((segment, index) => (
        <span className="flex min-w-0 items-center gap-1" key={`${index}:${segment}`}>
          <ChevronRight className="size-3 shrink-0" />
          <button
            className="truncate hover:text-foreground"
            onClick={() => onNavigate?.(index)}
            title={segment}
            type="button"
          >
            {segment}
          </button>
        </span>
      ))}
    </nav>
  );
}
