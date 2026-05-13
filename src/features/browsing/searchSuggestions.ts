import type { SearchFilterField } from "./browseTypes";
import { tagCategories } from "./tagCategories";

export type SearchSuggestionKind = "field" | "value";

export type SearchSuggestion = {
  id: string;
  kind: SearchSuggestionKind;
  label: string;
  insertText: string;
  detail: string;
  field?: SearchFilterField;
};

export type SearchSuggestionResult = {
  title: string;
  suggestions: SearchSuggestion[];
  activeTokenStart: number;
  activeTokenEnd: number;
};

type SearchFieldDescriptor = {
  field: SearchFilterField;
  detail: string;
  values: string[];
};

const tagSuggestionValues = Array.from(
  new Set(tagCategories.flatMap((category) => category.tags)),
).sort((left, right) => left.localeCompare(right));

const fieldDescriptors: SearchFieldDescriptor[] = [
  {
    field: "tag",
    detail: "Match a tag",
    values: tagSuggestionValues,
  },
  {
    field: "license",
    detail: "Match normalized license",
    values: ["cc0", "by", "by-nc", "unknown"],
  },
  {
    field: "rights",
    detail: "Match use-rights flags",
    values: ["commercial", "attribution", "share-alike", "unknown"],
  },
  {
    field: "duration",
    detail: "Duration in seconds",
    values: ["<1", "<2", "0.2..1.5", ">=5"],
  },
  {
    field: "format",
    detail: "File/container format",
    values: ["wav", "mp3", "ogg", "flac", "aif"],
  },
  {
    field: "codec",
    detail: "Audio codec",
    values: ["pcm", "mp3", "vorbis", "flac", "aiff"],
  },
  { field: "rate", detail: "Sample rate in Hz", values: ["44100", "48000", ">=48000"] },
  { field: "bitdepth", detail: "Bit depth", values: ["16", "24", ">=24"] },
  {
    field: "channels",
    detail: "Channel count or alias",
    values: ["1", "2", "mono", "stereo"],
  },
  { field: "size", detail: "File size", values: ["<5mb", "1mb..20mb"] },
  {
    field: "source",
    detail: "Local source name",
    values: ["local"],
  },
  {
    field: "provider",
    detail: "Provider id",
    values: ["local"],
  },
  {
    field: "path",
    detail: "Path substring or prefix",
    values: ["physics/surfaces", "ui", "folder-12"],
  },
  {
    field: "collection",
    detail: "Collection membership",
    values: ["favorites", "export-queue", "project-impacts"],
  },
  {
    field: "originator",
    detail: "Originator/author text",
    values: ["valve", "library"],
  },
  { field: "rating", detail: "Rating", values: [">=4", ">=3", "<3"] },
  {
    field: "modified",
    detail: "Modified date",
    values: ["2026-01-01..2026-02-01", "<7d"],
  },
  {
    field: "indexed",
    detail: "Indexed date or age",
    values: ["<7d", "2026-01-01..2026-02-01"],
  },
  {
    field: "imported",
    detail: "Imported/downloaded locally",
    values: ["true", "false"],
  },
  {
    field: "played",
    detail: "Recently played date",
    values: ["2026-01-01..2026-02-01"],
  },
  {
    field: "exported",
    detail: "Recently exported date",
    values: ["2026-01-01..2026-02-01"],
  },
  { field: "available", detail: "Availability state", values: ["true", "false"] },
  { field: "missing", detail: "Include missing files", values: ["true", "false"] },
  { field: "favorite", detail: "Favorite state", values: ["true", "false"] },
  {
    field: "availability",
    detail: "Exact availability state",
    values: ["available", "missing"],
  },
  {
    field: "status",
    detail: "Status state",
    values: ["available", "missing", "probe_failed", "unsupported"],
  },
  { field: "waveform", detail: "Waveform cache state", values: ["cached"] },
  { field: "analyzed", detail: "Analysis state", values: ["true", "false"] },
  { field: "peak", detail: "Peak dBFS", values: [">-3", "-6..-1"] },
  { field: "rms", detail: "RMS dBFS", values: ["-24..-12", "<-18"] },
  { field: "clipping", detail: "Clipping state", values: ["true", "false"] },
  { field: "headroom", detail: "Headroom dB", values: [">=3", "1..6"] },
];

function activeTokenRange(
  query: string,
  caretIndex: number,
): { start: number; end: number } {
  const safeCaret = Math.max(0, Math.min(caretIndex, query.length));
  let start = safeCaret;
  let end = safeCaret;

  while (start > 0 && !/\s/.test(query[start - 1]!)) start -= 1;
  while (end < query.length && !/\s/.test(query[end]!)) end += 1;

  return { start, end };
}

function normalizeToken(token: string): { negated: boolean; value: string } {
  return token.startsWith("-")
    ? { negated: true, value: token.slice(1) }
    : { negated: false, value: token };
}

export function resolveSearchSuggestions(
  query: string,
  caretIndex: number,
): SearchSuggestionResult {
  const { start, end } = activeTokenRange(query, caretIndex);
  const rawToken = query.slice(start, end);
  const { negated, value } = normalizeToken(rawToken);
  const colonIndex = value.indexOf(":");

  if (colonIndex >= 0) {
    const fieldName = value.slice(0, colonIndex).toLowerCase() as SearchFilterField;
    const descriptor = fieldDescriptors.find((entry) => entry.field === fieldName);
    if (!descriptor) {
      return {
        title: "Filters",
        suggestions: [],
        activeTokenStart: start,
        activeTokenEnd: end,
      };
    }

    const rawValue = value.slice(colonIndex + 1).toLowerCase();
    const suggestions = descriptor.values
      .filter((candidate) => candidate.toLowerCase().startsWith(rawValue))
      .map((candidate) => ({
        id: `${descriptor.field}:${candidate}`,
        kind: "value" as const,
        label: candidate,
        insertText: `${negated ? "-" : ""}${descriptor.field}:${candidate} `,
        detail: descriptor.detail,
        field: descriptor.field,
      }));

    return {
      title: descriptor.field,
      suggestions,
      activeTokenStart: start,
      activeTokenEnd: end,
    };
  }

  const fieldPrefix = value.toLowerCase();
  const suggestions = fieldDescriptors
    .filter((entry) => entry.field.startsWith(fieldPrefix))
    .map((entry) => ({
      id: entry.field,
      kind: "field" as const,
      label: `${negated ? "-" : ""}${entry.field}:`,
      insertText: `${negated ? "-" : ""}${entry.field}:`,
      detail: entry.detail,
      field: entry.field,
    }));

  return {
    title: "Filters",
    suggestions,
    activeTokenStart: start,
    activeTokenEnd: end,
  };
}

export function applySearchSuggestion(
  query: string,
  caretIndex: number,
  suggestion: SearchSuggestion,
): { value: string; caretIndex: number } {
  const { start, end } = activeTokenRange(query, caretIndex);
  const before = query.slice(0, start);
  const after = query.slice(end);
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
  const insertText = `${needsLeadingSpace ? " " : ""}${suggestion.insertText}`;
  const nextValue = `${before}${insertText}${after}`;
  const nextCaret = before.length + insertText.length;

  return {
    value: nextValue,
    caretIndex: nextCaret,
  };
}
