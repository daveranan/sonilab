import { Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type React from "react";

import type { SearchFilterChip, SearchWarning } from "@/features/browsing/browseTypes";
import { tokenizeSearchInput } from "@/features/browsing/searchGrammar";
import {
  applySearchSuggestion,
  commitSearchTokenAtCaret,
  resolveSearchSuggestions,
} from "@/features/browsing/searchSuggestions";

function formatChipQueryToken(chip: SearchFilterChip): string {
  const prefix = chip.negated ? "-" : "";
  const colonIndex = chip.label.indexOf(":");
  if (colonIndex < 0) return `${prefix}${chip.label}`;

  const field = chip.label.slice(0, colonIndex);
  const value = chip.label.slice(colonIndex + 1);
  const formattedValue = /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  return `${prefix}${field}:${formattedValue}`;
}

function chipTokenKey(chip: SearchFilterChip): string {
  return `${chip.negated ? "-" : ""}${chip.label}`.toLowerCase();
}

function visibleInputValueForQuery(
  queryText: string,
  chips: SearchFilterChip[],
): string {
  const removals = new Map<string, number>();
  for (const chip of chips) {
    const key = chipTokenKey(chip);
    removals.set(key, (removals.get(key) ?? 0) + 1);
  }

  return tokenizeSearchInput(queryText)
    .tokens.filter((token) => {
      const key = token.toLowerCase();
      const count = removals.get(key) ?? 0;
      if (count === 0) return true;
      if (count === 1) removals.delete(key);
      else removals.set(key, count - 1);
      return false;
    })
    .join(" ");
}

function queryValueFromChipsAndInput(
  chips: SearchFilterChip[],
  inputValue: string,
): string {
  return [...chips.map(formatChipQueryToken), inputValue.trim()]
    .filter(Boolean)
    .join(" ");
}

function commitDelimitedInputValue(inputValue: string): string | null {
  if (!inputValue.includes(",")) return null;

  const segments = inputValue.split(",");
  const committedSegments = segments
    .slice(0, -1)
    .map((segment) => {
      const trimmedSegment = segment.trim();
      if (!trimmedSegment) return "";
      return (
        commitSearchTokenAtCaret(trimmedSegment, trimmedSegment.length)?.value ??
        trimmedSegment
      ).trim();
    })
    .filter(Boolean);
  const trailingSegment = segments[segments.length - 1]?.replace(/^\s+/, "") ?? "";

  return [...committedSegments, trailingSegment].filter(Boolean).join(" ");
}

export function TopSearchBar({
  value,
  activeFilterChips = [],
  warnings = [],
  inputRef,
  onChange,
  onRemoveFilterChip = () => {},
  onSubmit,
  onStartNewSearch = () => {},
}: {
  value: string;
  activeFilterChips?: SearchFilterChip[];
  warnings?: SearchWarning[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onRemoveFilterChip?: (chipId: string) => void;
  onSubmit: () => void;
  onStartNewSearch?: () => void;
}) {
  const [isFocused, setIsFocused] = useState(false);
  const [caretIndex, setCaretIndex] = useState(value.length);
  const inputValue = useMemo(
    () => visibleInputValueForQuery(value, activeFilterChips),
    [activeFilterChips, value],
  );
  const resolvedCaretIndex = Math.min(caretIndex, inputValue.length);
  const suggestionState = useMemo(
    () => resolveSearchSuggestions(inputValue, resolvedCaretIndex),
    [inputValue, resolvedCaretIndex],
  );
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0);
  const suggestions = suggestionState.suggestions;
  const suggestionsOpen = isFocused && suggestions.length > 0;
  const resolvedActiveSuggestionIndex =
    suggestions.length === 0
      ? 0
      : Math.min(activeSuggestionIndex, suggestions.length - 1);

  function updateCaret(nextCaretIndex: number) {
    setCaretIndex(nextCaretIndex);
  }

  function setInputValue(nextValue: string, nextCaretIndex?: number) {
    onChange(queryValueFromChipsAndInput(activeFilterChips, nextValue));
    const resolvedCaretIndex = nextCaretIndex ?? nextValue.length;
    setCaretIndex(resolvedCaretIndex);
    globalThis.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(resolvedCaretIndex, resolvedCaretIndex);
    });
  }

  function clearSearch() {
    onChange("");
    setCaretIndex(0);
    globalThis.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(0, 0);
    });
  }

  function acceptSuggestion(index = resolvedActiveSuggestionIndex) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    const applied = applySearchSuggestion(inputValue, resolvedCaretIndex, suggestion);
    setInputValue(applied.value, applied.caretIndex);
  }

  return (
    <div className="relative min-w-[320px] flex-1" data-titlebar-interactive>
      <div
        className={`flex min-h-9 flex-wrap items-center gap-1 rounded-sm border bg-input/10 px-2 py-1 text-sm ${
          isFocused ? "border-ring/70" : "border-border"
        }`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) inputRef.current?.focus();
        }}
      >
        <Search className="mr-1 size-4 shrink-0 text-muted-foreground" />
        {activeFilterChips.map((chip) => (
          <button
            aria-label={`Remove ${chip.label} filter`}
            className="inline-flex h-6 max-w-[180px] shrink-0 items-center gap-1 rounded-sm border border-border bg-panel px-2 text-[11px] text-foreground shadow-sm hover:bg-muted"
            key={chip.id}
            onClick={() => onRemoveFilterChip(chip.id)}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
          >
            <span className="truncate">
              {chip.negated ? "-" : ""}
              {chip.label}
            </span>
            <X className="size-3 shrink-0 text-muted-foreground" />
          </button>
        ))}
        <input
          className="h-6 min-w-[120px] flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          onBlur={() => setIsFocused(false)}
          onChange={(event) => {
            const committedValue = commitDelimitedInputValue(event.target.value);
            if (committedValue !== null) {
              setInputValue(committedValue, committedValue.length);
              return;
            }
            setInputValue(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }}
          onClick={(event) =>
            updateCaret(event.currentTarget.selectionStart ?? inputValue.length)
          }
          onFocus={() => setIsFocused(true)}
          onKeyDown={(event) => {
            if (suggestionsOpen && event.key === "ArrowDown") {
              event.preventDefault();
              setActiveSuggestionIndex((current) =>
                Math.min(current + 1, suggestions.length - 1),
              );
              return;
            }
            if (suggestionsOpen && event.key === "ArrowUp") {
              event.preventDefault();
              setActiveSuggestionIndex((current) => Math.max(current - 1, 0));
              return;
            }
            if (suggestionsOpen && event.key === "Tab") {
              event.preventDefault();
              acceptSuggestion();
              return;
            }
            if (suggestionsOpen && event.key === "Enter") {
              event.preventDefault();
              acceptSuggestion();
              return;
            }
            if (event.key === "Escape") {
              setIsFocused(false);
              return;
            }
            if (
              event.key === "Backspace" &&
              inputValue.length === 0 &&
              activeFilterChips.length > 0
            ) {
              event.preventDefault();
              onRemoveFilterChip(activeFilterChips[activeFilterChips.length - 1]!.id);
              return;
            }
            if (event.key === ",") {
              const committed = commitSearchTokenAtCaret(
                inputValue,
                event.currentTarget.selectionStart ?? resolvedCaretIndex,
              );
              if (committed) {
                event.preventDefault();
                setInputValue(committed.value, committed.caretIndex);
                return;
              }
            }
            if (event.key === "Enter") onSubmit();
          }}
          onKeyUp={(event) =>
            updateCaret(event.currentTarget.selectionStart ?? inputValue.length)
          }
          onSelect={(event) =>
            updateCaret(event.currentTarget.selectionStart ?? inputValue.length)
          }
          placeholder={
            activeFilterChips.length > 0
              ? ""
              : "Search sounds, tag:metal duration:<2 format:wav"
          }
          ref={inputRef}
          value={inputValue}
        />
        {value ? (
          <button
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground"
            onClick={clearSearch}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
        <button
          aria-label="Start new search tab"
          className="text-muted-foreground hover:text-foreground"
          onClick={onStartNewSearch}
          title="Start new search tab"
          type="button"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {suggestionsOpen ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-md border border-border bg-panel shadow-xl">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase text-muted-foreground">
            {suggestionState.title}
          </div>
          <div className="max-h-72 overflow-auto py-1">
            {suggestions.map((suggestion, index) => (
              <button
                className={`grid w-full grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-3 px-3 py-2 text-left text-[12px] ${
                  index === resolvedActiveSuggestionIndex
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                }`}
                key={suggestion.id}
                onClick={() => acceptSuggestion(index)}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <span className="truncate font-medium text-foreground">
                  {suggestion.label}
                </span>
                <span className="truncate">{suggestion.detail}</span>
              </button>
            ))}
          </div>
          <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
            Tab or Enter to accept. Up/Down to navigate.
          </div>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="mt-1 truncate text-[11px] text-amber-300">
          {warnings.map((warning) => warning.message).join(" ")}
        </div>
      ) : null}
    </div>
  );
}
