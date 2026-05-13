import { Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import type React from "react";

import type { SearchFilterChip, SearchWarning } from "@/features/browsing/browseTypes";
import {
  applySearchSuggestion,
  resolveSearchSuggestions,
} from "@/features/browsing/searchSuggestions";

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
  const suggestionState = useMemo(
    () => resolveSearchSuggestions(value, caretIndex),
    [caretIndex, value],
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
    onChange(nextValue);
    const resolvedCaretIndex = nextCaretIndex ?? nextValue.length;
    setCaretIndex(resolvedCaretIndex);
    globalThis.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(resolvedCaretIndex, resolvedCaretIndex);
    });
  }

  function acceptSuggestion(index = resolvedActiveSuggestionIndex) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    const applied = applySearchSuggestion(value, caretIndex, suggestion);
    setInputValue(applied.value, applied.caretIndex);
  }

  return (
    <div className="relative min-w-[320px] flex-1" data-titlebar-interactive>
      <div className="flex h-9 items-center gap-2 rounded-sm border border-border bg-input/10 px-2 text-sm">
        <Search className="size-4 text-muted-foreground" />
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          onBlur={() => setIsFocused(false)}
          onChange={(event) => {
            updateCaret(event.target.selectionStart ?? event.target.value.length);
            onChange(event.target.value);
          }}
          onClick={(event) =>
            updateCaret(event.currentTarget.selectionStart ?? value.length)
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
            if (event.key === "Enter") onSubmit();
          }}
          onKeyUp={(event) =>
            updateCaret(event.currentTarget.selectionStart ?? value.length)
          }
          onSelect={(event) =>
            updateCaret(event.currentTarget.selectionStart ?? value.length)
          }
          placeholder="Search sounds, tag:metal duration:<2 format:wav"
          ref={inputRef}
          value={value}
        />
        {value ? (
          <button
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setInputValue("")}
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
        <div className="absolute left-0 right-0 top-11 z-50 overflow-hidden rounded-md border border-border bg-panel shadow-xl">
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
      {activeFilterChips.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {activeFilterChips.map((chip) => (
            <button
              className="h-6 rounded-sm border border-border bg-panel px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              key={chip.id}
              onClick={() => onRemoveFilterChip(chip.id)}
              type="button"
            >
              {chip.negated ? "-" : ""}
              {chip.label} x
            </button>
          ))}
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
