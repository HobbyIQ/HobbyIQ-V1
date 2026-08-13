// CF-CATALOG-SEARCH-TIERS (Drew, 2026-08-12).
//
// The layer the catalog was missing. Drew: "the catalog is the search, the
// sold data matches to the catalog to be searchable... I want verified
// searchable and I want the stub cards to be found if it is a missing
// checklist item."
//
// So a catalog row has THREE states, not two:
//
//   VERIFIED     — checklist-backed or human-confirmed. Returned to users as
//                  a normal card. This is what search is FOR.
//   PROVISIONAL  — a stub created because we observed real sales for a card
//                  we have no checklist for. The card demonstrably exists —
//                  someone sold one — but its identity came from vendor text,
//                  not a checklist. Findable ONLY as a fallback, always
//                  flagged, never outranking a verified card.
//   EXCLUDED     — dead sources (`sales-derived`, `tree-builder-v1`, purged
//                  2026-08-08/09 for polluted playerNames) and rows explicitly
//                  rejected in review. Never returned, never a fallback.
//
// Every state is MATCHABLE. Sold comps roll up to verified, provisional and
// even excluded rows alike — matching is about coverage, and an imperfect
// identity still beats an orphaned sale. Only VISIBILITY is tiered. Match
// paths (catalogVerify, resolveSetKey, checklistNarrow, catalogMatcher) read
// everything and must not use this module.
//
// The provisional tier is also a demand signal: a user searching hard enough
// to land on a stub is telling us which checklist to build next. Those hits
// are worth feeding to catalog_seed_queue.

/** Stub sources: real cards, unverified identity. Dated per sweep
 *  (`sold-comps-stub-2026-08-12`), so this is a PREFIX test — a set would
 *  silently stop matching on the next sweep. */
const PROVISIONAL_SOURCE_PREFIXES = ["sold-comps-stub-"] as const;

/** Dead sources. Not provisional — actively harmful, pending retire scripts.
 *
 *  CF-RETIRE-CARDHEDGE-ROWS (Drew, 2026-08-13: "clean up cardhege please that
 *  is the problem").
 *
 *  CardHedge is switched off at runtime (CH_RUNTIME_DISABLED=true) but its rows
 *  stayed in card_catalog and kept surfacing as if they were cards we own:
 *
 *    - search returned four `cardhedge::` rows above the real card, every one
 *      with comps=0, because sales hang off the canonical slug not the vendor's
 *      copy of it (CF-SEARCH-CHECKLIST-IS-THE-INDEX)
 *    - the review picker offered vendor bubble.io ids as the options to accept
 *      (1606922959335x293409091214639100), so approving one pinned a holding to
 *      a vendor row
 *    - the matcher's fuzzy-parallel step resolved 2020 Bowman #BD152 to a
 *      cardhedge:: slug
 *
 *  Excluding by SOURCE — not deleting. sold_comps rows still reference vendor
 *  cardIds, and deleting the catalog rows would orphan real sales with no way
 *  back. This makes them invisible to search, suggestions and the verified
 *  tier while leaving the data intact and the change reversible by removing
 *  two strings.
 */
const EXCLUDED_SOURCES = new Set([
  "sales-derived",
  "tree-builder-v1",
  "cardhedge",
  "cardhedge-graded",
]);

/** Review states that are never user-facing. */
const EXCLUDED_VERIFICATION = new Set(["rejected"]);

export type CatalogTier = "verified" | "provisional" | "excluded";

export interface CatalogVisibilityRow {
  source?: string | null;
  verificationStatus?: string | null;
}

function isProvisionalSource(source: string | null | undefined): boolean {
  const s = String(source ?? "").trim();
  return PROVISIONAL_SOURCE_PREFIXES.some((p) => s.startsWith(p));
}

/**
 * Classify a catalog row for SEARCH purposes only.
 *
 * A row with no `source` is legacy-authoritative and counts as verified —
 * most of the existing catalog predates provenance tagging, and treating
 * absence as untrusted would empty the search index.
 */
export function catalogTier(row: CatalogVisibilityRow): CatalogTier {
  const source = String(row.source ?? "").trim();
  const status = String(row.verificationStatus ?? "").trim();

  if (status && EXCLUDED_VERIFICATION.has(status)) return "excluded";
  if (source && EXCLUDED_SOURCES.has(source)) return "excluded";
  // Provenance beats status: a stub stamped "verified" by a stray write is
  // still a stub. Promotion happens by REPLACING the row from a checklist.
  if (isProvisionalSource(source)) return "provisional";
  if (status === "pending-review") return "provisional";
  return "verified";
}

/** Primary tier — returned to users as normal cards. */
export function isVerifiedCatalogRow(row: CatalogVisibilityRow): boolean {
  return catalogTier(row) === "verified";
}

/** Fallback tier — surfaced only when nothing verified matched, and flagged.
 *  These are the "missing checklist item" hits. */
export function isProvisionalCatalogRow(row: CatalogVisibilityRow): boolean {
  return catalogTier(row) === "provisional";
}

/** SQL for the VERIFIED tier. Permissive on absent fields so legacy rows
 *  survive; AND-able into any catalog query. */
export function verifiedCatalogSqlClause(alias = "c"): string {
  const notDead = [...EXCLUDED_SOURCES].map((s) => `${alias}.source != '${s}'`).join(" AND ");
  const notStub = PROVISIONAL_SOURCE_PREFIXES
    .map((p) => `NOT STARTSWITH(${alias}.source, '${p}')`)
    .join(" AND ");
  const notFlagged = [...EXCLUDED_VERIFICATION, "pending-review"]
    .map((v) => `${alias}.verificationStatus != '${v}'`)
    .join(" AND ");
  return `((NOT IS_DEFINED(${alias}.source) OR (${notDead} AND ${notStub})) AND (NOT IS_DEFINED(${alias}.verificationStatus) OR (${notFlagged})))`;
}

/** SQL for the PROVISIONAL tier — stubs only, and never the dead sources.
 *  Run this as the fallback query when the verified tier came back empty. */
export function provisionalCatalogSqlClause(alias = "c"): string {
  const isStub = PROVISIONAL_SOURCE_PREFIXES
    .map((p) => `STARTSWITH(${alias}.source, '${p}')`)
    .join(" OR ");
  const notRejected = [...EXCLUDED_VERIFICATION]
    .map((v) => `${alias}.verificationStatus != '${v}'`)
    .join(" AND ");
  return `((${isStub}) AND (NOT IS_DEFINED(${alias}.verificationStatus) OR (${notRejected})))`;
}

/** Stamped on rows created from observed sales. Exported so the sweep, the
 *  search filters and the tests all agree on one spelling. */
export const STUB_VERIFICATION_STATUS = "pending-review";

/** Flag returned alongside provisional hits so the client can label them
 *  ("we have sales for this card but no verified checklist yet") rather than
 *  presenting a stub as an equal-confidence result. */
export const PROVISIONAL_HIT_FLAG = "provisionalCatalogEntry" as const;
