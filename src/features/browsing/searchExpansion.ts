const synonymGroups = [
  ["whoosh", "woosh", "swoosh", "swish", "sweep", "sweeper", "riser", "passby", "air"],
  ["clank", "clanking", "clang", "clanging", "metal", "metallic"],
  ["impact", "hit", "hits", "slam", "thud", "punch"],
  ["blast", "boom", "explosion", "explode"],
  ["drone", "drones", "atmo", "ambience", "ambiance", "ambient"],
  ["glitch", "glitched", "digital", "stutter"],
];

const synonymIndex = buildSynonymIndex(synonymGroups);

export function expandSearchTerm(term: string): string[] {
  const normalized = normalizeTerm(term);
  if (!normalized || normalized.startsWith("-")) return [term];

  const synonyms = synonymIndex.get(normalized);
  if (!synonyms) return [normalized];

  return [normalized, ...synonyms.filter((synonym) => synonym !== normalized)];
}

export function expandSearchTerms(terms: string[]): string[] {
  const expanded = new Set<string>();
  for (const term of terms) {
    for (const expandedTerm of expandSearchTerm(term)) {
      expanded.add(expandedTerm);
    }
  }
  return [...expanded];
}

function buildSynonymIndex(groups: string[][]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const group of groups) {
    const normalizedGroup = [...new Set(group.map(normalizeTerm).filter(Boolean))];
    for (const term of normalizedGroup) {
      index.set(term, normalizedGroup);
    }
  }
  return index;
}

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}
