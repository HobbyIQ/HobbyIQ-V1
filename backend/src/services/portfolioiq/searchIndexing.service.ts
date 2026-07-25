// CF-SEARCH-INDEXING (Drew, 2026-07-25). Single source of truth for how
// card_catalog rows are indexed for /card-search.
//
// Two derivations, always computed together:
//
//   1. searchText  — lowercase whitespace-joined concat of every field
//                    that could match a query. Used by the tier-2
//                    CONTAINS fallback and by the fuzzy-Levenshtein path.
//   2. searchTokens — deduped alphanumeric tokens from searchText, with
//                     hyphen-split fragments included ("cpa-eha" → also
//                     "cpa" + "eha"). Used by the tier-1 ARRAY_CONTAINS
//                     fast-path (Cosmos index-accelerated).
//
// Consumers:
//   - scripts/comp-quality/backfill-search-fields.cjs (nightly + one-shot)
//   - persistVendorCatalog.service.ts (runtime insert path)
//   - canonicalCardSearch.service.ts (reader — reads the fields)
//
// The .cjs backfill script duplicates this logic in CJS form (see the
// buildSearchText/buildSearchTokens helpers in that file). Kept in sync
// manually — 20 lines of pure-function code, no compiler dependency.

export interface SearchIndexInput {
  player?: string | null;
  releaseName?: string | null;
  setName?: string | null;
  number?: string | null;
  year?: string | number | null;
  parallels?: Array<{ name?: string | null } | null> | null;
  attributes?: Array<string | null> | null;
  // Runtime persistVendorCatalog uses these lightweight fields — they
  // don't exist on Cardsight-crawled rows, but including them keeps the
  // helper usable across both schemas.
  variant?: string | null;
  title?: string | null;
  set?: string | null;   // vendor-shape alias for releaseName
}

/** Lowercase whitespace-joined concat of every match-eligible field. */
export function buildSearchText(row: SearchIndexInput): string {
  const parts: string[] = [];
  if (row.player) parts.push(String(row.player));
  if (row.releaseName) parts.push(String(row.releaseName));
  if (row.set && row.set !== row.releaseName) parts.push(String(row.set));
  if (row.setName && row.setName !== row.releaseName && row.setName !== row.set) parts.push(String(row.setName));
  if (row.title && row.title !== row.releaseName && row.title !== row.set && row.title !== row.setName) parts.push(String(row.title));
  if (row.number) parts.push(String(row.number));
  if (row.year !== undefined && row.year !== null && row.year !== "") parts.push(String(row.year));
  if (row.variant) parts.push(String(row.variant));
  if (Array.isArray(row.parallels)) {
    for (const p of row.parallels) if (p && p.name) parts.push(String(p.name));
  }
  if (Array.isArray(row.attributes)) {
    for (const a of row.attributes) if (a) parts.push(String(a));
  }
  return parts.join(" ").toLowerCase();
}

/** Deduped alphanumeric tokens from searchText, hyphen-split fragments
 *  included so "cpa" hits "cpa-eha" and "bcp" hits "bcp-102". */
export function buildSearchTokens(searchText: string | null | undefined): string[] {
  if (!searchText) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const raw = String(searchText).toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean);
  for (const r of raw) {
    if (r.length >= 2 && !seen.has(r)) { seen.add(r); out.push(r); }
    if (r.includes("-")) {
      for (const f of r.split("-")) {
        if (f.length >= 2 && !seen.has(f)) { seen.add(f); out.push(f); }
      }
    }
  }
  return out;
}

/** Combined helper — computes both in one call. */
export function buildSearchIndex(row: SearchIndexInput): { searchText: string; searchTokens: string[] } {
  const searchText = buildSearchText(row);
  return { searchText, searchTokens: buildSearchTokens(searchText) };
}
