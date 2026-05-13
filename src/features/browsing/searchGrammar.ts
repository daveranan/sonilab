import type {
  SearchFilter,
  SearchFilterField,
  SearchQuery,
  SearchWarning,
  SourceScope,
} from "./browseTypes";
import { defaultSearchSort } from "./sortModel";

const filterFields = new Set<SearchFilterField>([
  "tag",
  "tagany",
  "license",
  "rights",
  "duration",
  "format",
  "codec",
  "rate",
  "bitdepth",
  "channels",
  "size",
  "source",
  "provider",
  "path",
  "collection",
  "originator",
  "uploader",
  "rating",
  "modified",
  "indexed",
  "imported",
  "played",
  "exported",
  "available",
  "missing",
  "favorite",
  "availability",
  "status",
  "waveform",
  "analyzed",
  "peak",
  "rms",
  "clipping",
  "headroom",
]);

const channelAliases = new Map([
  ["mono", 1],
  ["stereo", 2],
]);

const numericFields = new Set<SearchFilterField>([
  "duration",
  "rate",
  "bitdepth",
  "channels",
  "size",
  "rating",
  "peak",
  "rms",
  "headroom",
]);

const booleanFields = new Set<SearchFilterField>([
  "available",
  "missing",
  "favorite",
  "imported",
  "analyzed",
  "clipping",
]);

const dateFields = new Set<SearchFilterField>([
  "modified",
  "indexed",
  "played",
  "exported",
]);

type TextFilterField = Exclude<
  SearchFilterField,
  | "duration"
  | "rate"
  | "bitdepth"
  | "channels"
  | "size"
  | "rating"
  | "peak"
  | "rms"
  | "headroom"
  | "available"
  | "missing"
  | "favorite"
  | "imported"
  | "analyzed"
  | "clipping"
  | "modified"
  | "indexed"
  | "played"
  | "exported"
>;

type TokenizeResult = {
  tokens: string[];
  warnings: SearchWarning[];
};

export function tokenizeSearchInput(input: string): TokenizeResult {
  const tokens: string[] = [];
  const warnings: SearchWarning[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (const char of input.trim()) {
    if ((char === `"` || char === "'") && quote === null) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (/\s/.test(char) && quote === null) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  if (quote !== null) {
    warnings.push({
      code: "unterminated-quote",
      message: "Search contains an unterminated quoted string.",
      token: input,
    });
  }

  return { tokens, warnings };
}

function parseBoolean(value: string): boolean | null {
  if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
  if (["false", "no", "0"].includes(value.toLowerCase())) return false;
  return null;
}

function parseNumericFilter(
  field:
    | "duration"
    | "rate"
    | "bitdepth"
    | "channels"
    | "size"
    | "rating"
    | "peak"
    | "rms"
    | "headroom",
  raw: string,
  negated: boolean,
): SearchFilter | SearchWarning {
  const normalized = raw.toLowerCase();
  const alias = field === "channels" ? channelAliases.get(normalized) : undefined;
  if (alias !== undefined) {
    return { field, operator: "=", value: alias, raw, negated };
  }

  const rangeParts = normalized.split("..");
  if (rangeParts.length === 2) {
    const start = parseNumberWithUnit(field, rangeParts[0]);
    const end = parseNumberWithUnit(field, rangeParts[1]);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return { field, operator: "range", value: start, valueEnd: end, raw, negated };
    }
  }

  const comparison = normalized.match(/^(<=|>=|<|>|=)?(.+)$/);
  const value = parseNumberWithUnit(field, comparison?.[2] ?? "");
  if (!comparison || !Number.isFinite(value)) {
    return {
      code: "invalid-number",
      message: `Invalid numeric value for ${field}.`,
      token: `${field}:${raw}`,
    };
  }

  return {
    field,
    operator: (comparison[1] ?? "=") as "<" | "<=" | ">" | ">=" | "=",
    value,
    raw,
    negated,
  };
}

function parseNumberWithUnit(field: SearchFilterField, raw: string): number {
  if (field !== "size") return Number(raw);
  const match = raw
    .trim()
    .toLowerCase()
    .match(/^(-?\d+(?:\.\d+)?)(b|kb|mb|gb)?$/);
  if (!match) return Number.NaN;
  const value = Number(match[1]);
  const unit = match[2] ?? "b";
  const multiplier =
    unit === "gb" ? 1024 ** 3 : unit === "mb" ? 1024 ** 2 : unit === "kb" ? 1024 : 1;
  return value * multiplier;
}

function parseDateFilter(
  field: "modified" | "indexed" | "played" | "exported",
  raw: string,
  negated: boolean,
): SearchFilter | SearchWarning {
  const rangeParts = raw.split("..");
  if (rangeParts.length === 2 && rangeParts[0] && rangeParts[1]) {
    return {
      field,
      operator: "range",
      value: rangeParts[0],
      valueEnd: rangeParts[1],
      raw,
      negated,
    };
  }

  const comparison = raw.match(/^(<=|>=|<|>|=)?(.+)$/);
  if (!comparison?.[2]) {
    return {
      code: "invalid-filter",
      message: `Invalid date value for ${field}.`,
      token: `${field}:${raw}`,
    };
  }

  return {
    field,
    operator: (comparison[1] ?? "=") as "<" | "<=" | ">" | ">=" | "=",
    value: comparison[2],
    raw,
    negated,
  };
}

function parseFilter(
  token: string,
  field: SearchFilterField,
  value: string,
  negated: boolean,
): SearchFilter | SearchWarning {
  if (!value) {
    return {
      code: "invalid-filter",
      message: `Filter ${field} needs a value.`,
      token,
    };
  }

  if (numericFields.has(field)) {
    return parseNumericFilter(
      field as
        | "duration"
        | "rate"
        | "bitdepth"
        | "channels"
        | "size"
        | "rating"
        | "peak"
        | "rms"
        | "headroom",
      value,
      negated,
    );
  }

  if (dateFields.has(field)) {
    return parseDateFilter(
      field as "modified" | "indexed" | "played" | "exported",
      value,
      negated,
    );
  }

  if (booleanFields.has(field)) {
    const parsed = parseBoolean(value);
    if (parsed === null) {
      return {
        code: "invalid-filter",
        message: `Filter ${field} expects true or false.`,
        token,
      };
    }
    return {
      field: field as
        | "available"
        | "missing"
        | "favorite"
        | "imported"
        | "analyzed"
        | "clipping",
      value: parsed,
      negated,
    };
  }

  return { field: field as TextFilterField, value: value.toLowerCase(), negated };
}

export function parseSearchGrammar(
  input: string,
  sourceScope: SourceScope = { kind: "all" },
): { query: SearchQuery; warnings: SearchWarning[] } {
  const tokenized = tokenizeSearchInput(input);
  const text: string[] = [];
  const filters: SearchFilter[] = [];
  const warnings = [...tokenized.warnings];
  let includeUnavailable = false;

  for (const rawToken of tokenized.tokens) {
    const negated = rawToken.startsWith("-");
    const token = negated ? rawToken.slice(1) : rawToken;
    const filterMatch = token.match(/^([a-zA-Z][a-zA-Z-]*):(.*)$/);

    if (!filterMatch) {
      text.push(negated ? `-${token.toLowerCase()}` : token.toLowerCase());
      continue;
    }

    const field = filterMatch[1] as SearchFilterField;
    const value = filterMatch[2];
    if (!filterFields.has(field)) {
      warnings.push({
        code: "unknown-filter",
        message: `Unknown search filter ${field}.`,
        token: rawToken,
      });
      continue;
    }

    const parsed = parseFilter(rawToken, field, value, negated);
    if ("code" in parsed) {
      warnings.push(parsed);
      continue;
    }

    if (parsed.field === "missing" && parsed.value && !parsed.negated) {
      includeUnavailable = true;
    }
    filters.push(parsed);
  }

  return {
    query: {
      text,
      filters,
      sort: defaultSearchSort,
      sourceScope,
      includeUnavailable,
      activeFilterChips: filters.map((filter, index) => ({
        id: `${filter.field}-${index}`,
        label:
          "operator" in filter
            ? `${filter.field}:${filter.raw}`
            : `${filter.field}:${String(filter.value)}`,
        field: filter.field,
        negated: filter.negated,
      })),
    },
    warnings,
  };
}
