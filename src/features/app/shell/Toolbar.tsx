import { Filter, List, RefreshCw, Search, SlidersHorizontal } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { SearchSort, SearchSortKey } from "@/features/browsing/browseTypes";
import type { BrowseDensity } from "@/features/browsing/BrowseTable";
import { useModalManager } from "./modalManager";

const licenseHelp: Record<string, string> = {
  cc0: "CC0: generally usable without attribution.",
  by: "Attribution license: reuse requires author credit.",
  "by-nc": "Non-commercial license: avoid for commercial work.",
  unknown: "Unknown license: inspect the source before export.",
  ambiguous: "Ambiguous license: inspect the source before export.",
};

const sortOptions: { key: SearchSortKey; label: string }[] = [
  { key: "bestMatch", label: "Best match" },
  { key: "name", label: "Name" },
  { key: "duration", label: "Duration" },
  { key: "modifiedTime", label: "Modified" },
  { key: "format", label: "Format" },
  { key: "sampleRate", label: "Sample rate" },
  { key: "peak", label: "Peak" },
  { key: "rms", label: "RMS" },
  { key: "source", label: "Source" },
  { key: "fileSize", label: "File size" },
  { key: "rating", label: "Rating" },
  { key: "importedDate", label: "Imported date" },
  { key: "indexedDate", label: "Indexed date" },
  { key: "recentlyPlayed", label: "Recently played" },
  { key: "recentlyExported", label: "Recently exported" },
];
const densityCycle: BrowseDensity[] = ["compact", "standard", "expanded"];
const densityLabels: Record<BrowseDensity, string> = {
  compact: "Compact rows",
  standard: "Standard rows",
  expanded: "Expanded rows",
};
const toolbarControlClass =
  "mt-1 h-8 w-full rounded-md border border-input bg-black px-2 text-[12px] text-foreground outline-none focus-visible:border-primary";

export function Toolbar({
  resultCount,
  loading,
  onApplyFilter,
  sort,
  onSortChange,
  density,
  onDensityChange,
  refreshStatus,
  onRefresh,
}: {
  resultCount: number;
  loading: boolean;
  onApplyFilter: (query: string) => void;
  sort: SearchSort;
  onSortChange: (sort: SearchSort) => void;
  density: BrowseDensity;
  onDensityChange: (density: BrowseDensity) => void;
  refreshStatus: string | null;
  onRefresh: () => void;
}) {
  const modalManager = useModalManager();
  const filterOpen = modalManager.isOpen("filter-builder");
  const sortOpen = modalManager.isOpen("sort-menu");
  const [filters, setFilters] = useState({
    source: "",
    provider: "",
    collection: "",
    favorite: "",
    license: "",
    rights: "",
    tag: "",
    originator: "",
    duration: "",
    format: "",
    codec: "",
    bitdepth: "",
    size: "",
    available: "",
    status: "",
    rating: "",
    modified: "",
    peak: "",
    rms: "",
    clipping: "",
    headroom: "",
  });
  function setFilter(name: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [name]: value }));
  }

  function applyFilter() {
    const query = filterQuery();
    onApplyFilter(query);
    modalManager.close("filter-builder");
  }

  function filterQuery() {
    const parts = [
      filters.source ? `source:${filters.source}` : "",
      filters.provider ? `provider:${filters.provider}` : "",
      filters.collection ? `collection:${filters.collection}` : "",
      filters.favorite ? `favorite:${filters.favorite}` : "",
      filters.license ? `license:${filters.license}` : "",
      filters.rights ? `rights:${filters.rights}` : "",
      filters.tag.trim() ? `tag:${filters.tag.trim()}` : "",
      filters.originator ? `originator:${filters.originator}` : "",
      filters.duration ? `duration:${filters.duration}` : "",
      filters.format ? `format:${filters.format}` : "",
      filters.codec ? `codec:${filters.codec}` : "",
      filters.bitdepth ? `bitdepth:${filters.bitdepth}` : "",
      filters.size ? `size:${filters.size}` : "",
      filters.available ? `available:${filters.available}` : "",
      filters.status ? `status:${filters.status}` : "",
      filters.rating ? `rating:${filters.rating}` : "",
      filters.modified ? `modified:${filters.modified}` : "",
      filters.peak ? `peak:${filters.peak}` : "",
      filters.rms ? `rms:${filters.rms}` : "",
      filters.clipping ? `clipping:${filters.clipping}` : "",
      filters.headroom ? `headroom:${filters.headroom}` : "",
    ].filter(Boolean);
    return parts.join(" ");
  }

  function saveSearch() {
    window.dispatchEvent(
      new CustomEvent("sonilabs:save-search-intent", {
        detail: { query: filterQuery() },
      }),
    );
    modalManager.close("filter-builder");
  }

  function clearAll() {
    setFilters(
      (current) =>
        Object.fromEntries(
          Object.keys(current).map((key) => [key, ""]),
        ) as typeof filters,
    );
  }

  function resetGroup(group: "location" | "rights" | "audio" | "status" | "levels") {
    const groups = {
      location: ["source", "provider", "collection", "favorite"],
      rights: ["license", "rights"],
      audio: ["tag", "originator", "duration", "format", "codec", "bitdepth", "size"],
      status: ["available", "status", "rating", "modified"],
      levels: ["peak", "rms", "clipping", "headroom"],
    } satisfies Record<string, (keyof typeof filters)[]>;
    setFilters((current) => ({
      ...current,
      ...Object.fromEntries(groups[group].map((key) => [key, ""])),
    }));
  }

  const activeChips = Object.entries(filters).filter(([, value]) => Boolean(value));
  const sortLabel =
    sortOptions.find((option) => option.key === sort.key)?.label ?? "Sort";
  const densityLabel = densityLabels[density];

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ kind: string }>).detail;
      if (detail?.kind === "toggle-filter") modalManager.toggle("filter-builder");
    };
    window.addEventListener("sonilabs:toolbar-intent", handler);
    return () => window.removeEventListener("sonilabs:toolbar-intent", handler);
  }, [modalManager]);

  return (
    <div
      className="relative flex h-9 shrink-0 items-center gap-1 self-start px-1"
      data-titlebar-interactive
    >
      <span className="min-w-24 whitespace-nowrap px-2 text-left text-[12px] text-muted-foreground">
        {resultCount.toLocaleString()} results
      </span>
      <Button
        aria-expanded={filterOpen}
        className="size-7 p-0"
        onClick={() => modalManager.toggle("filter-builder")}
        size="icon"
        title="Filters"
        variant="ghost"
      >
        <Filter className="size-3.5" />
      </Button>
      {filterOpen ? (
        <div className="absolute right-0 top-10 z-40 max-h-[76vh] w-[520px] overflow-auto rounded-lg border border-border bg-panel p-3 text-left shadow-lg">
          <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase text-muted-foreground">
            <span>Filter builder</span>
            <button
              className="text-primary hover:underline"
              onClick={clearAll}
              type="button"
            >
              Clear all
            </button>
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {activeChips.map(([key, value]) => (
              <button
                className="h-6 rounded-md border border-border px-2 text-[11px] text-muted-foreground hover:bg-muted"
                key={key}
                onClick={() => setFilter(key as keyof typeof filters, "")}
                type="button"
              >
                {key}:{value} x
              </button>
            ))}
          </div>
          <FilterGroup onReset={() => resetGroup("location")} title="Location">
            <Select
              label="Provider"
              onChange={(v) => setFilter("provider", v)}
              value={filters.provider}
              values={["", "local"]}
            />
            <Select
              label="Source"
              onChange={(v) => setFilter("source", v)}
              value={filters.source}
              values={["", "local"]}
            />
            <Select
              label="Collection"
              onChange={(v) => setFilter("collection", v)}
              value={filters.collection}
              values={["", "favorites", "export-queue"]}
            />
            <Select
              label="Favorite"
              onChange={(v) => setFilter("favorite", v)}
              value={filters.favorite}
              values={["", "true", "false"]}
            />
          </FilterGroup>
          <FilterGroup onReset={() => resetGroup("rights")} title="Rights">
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Select
                    label="License"
                    onChange={(v) => setFilter("license", v)}
                    value={filters.license}
                    values={["", "cc0", "by", "by-nc", "ambiguous", "unknown"]}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {licenseHelp[filters.license] ?? "Any license."}
              </TooltipContent>
            </Tooltip>
            <Select
              label="Rights"
              onChange={(v) => setFilter("rights", v)}
              value={filters.rights}
              values={[
                "",
                "commercial",
                "attribution",
                "share-alike",
                "ambiguous",
                "unknown",
              ]}
            />
          </FilterGroup>
          <FilterGroup onReset={() => resetGroup("audio")} title="Text and Audio">
            <Text
              label="Tags"
              onChange={(v) => setFilter("tag", v)}
              placeholder="impact, metal, ui"
              value={filters.tag}
            />
            <Text
              label="Originator"
              onChange={(v) => setFilter("originator", v)}
              value={filters.originator}
            />
            <Select
              label="Duration"
              onChange={(v) => setFilter("duration", v)}
              value={filters.duration}
              values={["", "<1", "<2", "1..5", ">=5"]}
            />
            <Select
              label="Format"
              onChange={(v) => setFilter("format", v)}
              value={filters.format}
              values={["", "wav", "mp3", "ogg", "flac", "aif"]}
            />
            <Select
              label="Codec"
              onChange={(v) => setFilter("codec", v)}
              value={filters.codec}
              values={["", "pcm", "mp3", "vorbis", "flac"]}
            />
            <Select
              label="Bit depth"
              onChange={(v) => setFilter("bitdepth", v)}
              value={filters.bitdepth}
              values={["", "16", "24", ">=24"]}
            />
            <Text
              label="File size"
              onChange={(v) => setFilter("size", v)}
              placeholder="<5mb"
              value={filters.size}
            />
          </FilterGroup>
          <FilterGroup onReset={() => resetGroup("status")} title="Status and Dates">
            <Select
              label="Available"
              onChange={(v) => setFilter("available", v)}
              value={filters.available}
              values={["", "true", "false"]}
            />
            <Select
              label="Status"
              onChange={(v) => setFilter("status", v)}
              value={filters.status}
              values={["", "available", "missing", "probe_failed", "unsupported"]}
            />
            <Select
              label="Rating"
              onChange={(v) => setFilter("rating", v)}
              value={filters.rating}
              values={["", ">=4", ">=3", "<3"]}
            />
            <Text
              label="Modified date"
              onChange={(v) => setFilter("modified", v)}
              placeholder="2026-01-01..2026-02-01"
              value={filters.modified}
            />
            <DisabledFilter
              label="Imported date"
              reason="No imported_at metadata in the active mock source."
            />
          </FilterGroup>
          <FilterGroup onReset={() => resetGroup("levels")} title="Levels">
            <Text
              label="Peak"
              onChange={(v) => setFilter("peak", v)}
              placeholder=">-3"
              value={filters.peak}
            />
            <Text
              label="RMS"
              onChange={(v) => setFilter("rms", v)}
              placeholder="-24..-12"
              value={filters.rms}
            />
            <Select
              label="Clipping"
              onChange={(v) => setFilter("clipping", v)}
              value={filters.clipping}
              values={["", "true", "false"]}
            />
            <Text
              label="Headroom"
              onChange={(v) => setFilter("headroom", v)}
              placeholder=">=3"
              value={filters.headroom}
            />
          </FilterGroup>
          <div className="mt-3 flex gap-2">
            <Button className="h-8 flex-1 gap-1.5" onClick={applyFilter} size="sm">
              <Search className="size-3.5" />
              Apply
            </Button>
            <Button className="h-8" onClick={saveSearch} size="sm" variant="ghost">
              Save search
            </Button>
          </div>
        </div>
      ) : null}
      <Button
        aria-expanded={sortOpen}
        className="size-7 p-0"
        onClick={() => modalManager.toggle("sort-menu")}
        size="icon"
        title={`Sort: ${sortLabel}`}
        variant="ghost"
      >
        <SlidersHorizontal className="size-3.5" />
      </Button>
      {sortOpen ? (
        <div className="absolute right-0 top-10 z-40 w-56 rounded-lg border border-border bg-panel p-2 text-left shadow-lg">
          <div className="mb-1 px-2 text-[11px] font-semibold uppercase text-muted-foreground">
            Sort
          </div>
          {sortOptions.map((option) => (
            <button
              className={`flex h-7 w-full items-center justify-between px-2 text-[12px] hover:bg-muted ${
                sort.key === option.key ? "text-foreground" : "text-muted-foreground"
              }`}
              key={option.key}
              onClick={() => {
                onSortChange({
                  key: option.key,
                  direction:
                    sort.key === option.key && sort.direction === "asc"
                      ? "desc"
                      : "asc",
                  stableTieBreaker: "assetId",
                });
                modalManager.close("sort-menu");
              }}
              type="button"
            >
              <span>{option.label}</span>
              {sort.key === option.key ? (
                <span>{sort.direction === "asc" ? "Asc" : "Desc"}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <Button
        className="size-7 p-0"
        onClick={() => {
          const currentIndex = densityCycle.indexOf(density);
          onDensityChange(densityCycle[(currentIndex + 1) % densityCycle.length]);
        }}
        size="icon"
        title={`List density: ${densityLabel}`}
        variant="ghost"
      >
        <List className="size-3.5" />
      </Button>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="size-7 p-0"
            onClick={onRefresh}
            size="icon"
            title="Refresh"
            variant="ghost"
          >
            <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </TooltipTrigger>
        {refreshStatus ? <TooltipContent>{refreshStatus}</TooltipContent> : null}
      </Tooltip>
    </div>
  );
}

function FilterGroup({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="mt-2 border-t border-border/70 pt-2">
      <legend className="flex w-full items-center justify-between text-[11px] font-semibold uppercase text-muted-foreground">
        {title}
        <button
          className="normal-case text-primary hover:underline"
          onClick={onReset}
          type="button"
        >
          Reset group
        </button>
      </legend>
      <div className="mt-2 grid grid-cols-2 gap-2">{children}</div>
    </fieldset>
  );
}

function Select({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[11px] text-muted-foreground">
      {label}
      <select
        className={toolbarControlClass}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {values.map((option) => (
          <option key={option || "any"} value={option}>
            {option || "Any"}
          </option>
        ))}
      </select>
    </label>
  );
}

function Text({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-[11px] text-muted-foreground">
      {label}
      <input
        className={toolbarControlClass}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

function DisabledFilter({ label, reason }: { label: string; reason: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="block text-[11px] text-muted-foreground/70">
          {label}
          <input
            className="mt-1 h-8 w-full rounded-md border border-input bg-muted/30 px-2 text-[12px] outline-none"
            disabled
            value="Unavailable"
            readOnly
          />
        </label>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
