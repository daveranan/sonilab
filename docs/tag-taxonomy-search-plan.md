# Tag Taxonomy and Search Expansion Plan

## Direction

Tagify first, categorize second.

Imported metadata tags are useful evidence, but they are not authoritative. Indexing should preserve imported tags, add deterministic derived tags from filename/path/description, and store category groupings as derived metadata. Search expansion should handle loose meanings and synonyms without writing those synonyms back onto the asset.

## Terms

- Imported tags: tags from library metadata files such as CSV/XLS/PDF.
- Derived tags: factual tags inferred from local evidence, like filename, path, and description.
- Categories: UI groupings derived from tags, such as `material`, `content`, `motion`, and `tone`.
- Synonyms: query-only expansions, such as `whoosh -> swish, swoosh, sweep, riser, passby`.

## Execution Plan

1. Enriched indexing
   - Merge imported tags with derived tags.
   - Extract generic keyword tags from every meaningful filename/path/description token.
   - Store tag provenance/category data in `metadata_json.tagEnrichment`.
   - Keep `asset_tags` as the searchable canonical tag set.

2. Query expansion
   - Expand free-text search terms through a synonym map before building the backend FTS query.
   - Do not expand negated terms.
   - Do not write synonym expansions into `asset_tags`.
   - Keep expansion conservative so results broaden without becoming noisy.

3. Tag category sidebar
   - Add a backend command that returns categories and tag counts for the active local scope.
   - Render a compact `Local > Tags` tree beneath the existing local libraries.
   - Clicking a tag opens/searches `tag:<tag>`.
   - Clicking a category filters to all tags in that category once OR-style filtering exists.

4. Ranked search
   - Keep exact query terms weighted above synonyms.
   - Prefer exact name/tag hits over broad description/path hits.
   - Add synonym hit explanation later in the inspector or result metadata.

5. Review loop
   - Add an editable taxonomy/synonym config later.
   - Log zero-result searches and high-noise expansions for tuning.
   - Add user overrides only after the automatic layer is useful.

## Initial Categories

- `material`: metal, wood, glass, stone, sand, water, air, cloth
- `content`: impact, blast, whoosh, riser, drone, ambience, glitch, bass drop
- `motion`: passby, scrape, swipe
- `tone`: cinematic, dark, scary, aggressive, deep, high, harsh, tonal, atonal

## Guardrails

Do not convert subjective or related meanings into hard tags. For example, `clanking` may search near `hihat` later, but `hihat` should not be attached to a clanking metal sound unless the metadata or classifier has real evidence that it is a hihat.
