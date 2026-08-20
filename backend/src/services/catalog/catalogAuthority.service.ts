// CF-CATALOG-AUTHORITY (Drew, 2026-08-20: "Every card in the catalog with all
// possible grades. All sold comps matching to the correct card and grade to be
// able to see trends. So should we simplify since we seem to overcomplicate
// this?").
//
// THE MODEL IS THREE THINGS, AND IT IS ALREADY RIGHT:
//
//   card_catalog  the universe — every card x every grade (the grade explode)
//   sold_comps    observations, each attaching to exactly ONE (card, grade)
//   trends        the price series per (card, grade) over time
//
// Nothing here changes that. What was overcomplicated is the CODE around it,
// specifically one question asked in five different places with five slightly
// different answers: "does this catalog row count as evidence?"
//
// That question was reimplemented in audit-checklist-conformance,
// repair-cardnumber-hyphen, probe-cardboardchecklist-coverage,
// audit-orphan-causes and unify-catalog-setkeys — each with its own regex, and
// the differences between them were not deliberate. One of those differences
// mattered enough to flip 51 card-number prefixes from "repair" to "blocked".
//
// So: one declaration, used everywhere.
//
// ── WHY AUTHORITY IS NOT THE SAME AS TRUST ──────────────────────────────────
//
// A row can be worth KEEPING and still not be allowed to DECIDE anything.
// Measured across 40,090,298 catalog rows, 56 sources:
//
//   CHECKLIST  34,176,691  85.2%   transcribes a printed checklist
//   VENDOR      2,167,086   5.4%   records how a VENDOR types
//   DERIVED     3,405,953   8.5%   generated from our own comps/inference
//   UNKNOWN       340,568   0.8%
//
// DERIVED is the dangerous class, because it makes the catalog judge itself: a
// mis-slugged comp seeds a catalog row, and that row then confirms the comp.
// `sold-comps-stub` is the purest case — catalog rows built FROM sold comps —
// and `ingest-auto-seed` and `catalog-explode-actuals` are the same shape at
// larger scale. They are often the ONLY row a card has, so deleting them would
// lose coverage; they simply must never outvote a checklist.
//
// VENDOR is not authority either, and that is doctrine rather than opinion:
// consume CardHedge SALES, not CardHedge PRODUCT fields. A setKey, a parallel
// and a card number are all product fields. Drew, on a cardhedge row filed under
// the wrong set: "that is correct, cardhedge classified it wrongly." Cardsight
// is retired from matching.
//
// ── SOURCE STRINGS ROT, SO MATCH BY PATTERN ─────────────────────────────────
//
// Dated scrape runs (`beckett-scraped-2026-08-19`) and `-graded` twins mint a
// NEW source string every run. An exact allowlist therefore decays a little
// every night. One did: it recognised 5 of ~30 checklist sources and reported
// 6.1% checklist coverage where the truth was 87.8%, discarding
// baseballcardpedia's 918,828 rows. An audit whose authority set decays reports
// a shrinking evidence base as though it were a growing data problem.

/** What a catalog row is allowed to decide. */
export type CatalogAuthority = "checklist" | "vendor" | "derived" | "unknown";

/** Generated from our own observations or inference. Never adjudicates. */
const DERIVED = /^(ingest-auto-seed|sold-comps-stub|catalog-explode|tree-builder|sales-derived|pool)/;

/** A marketplace or pricing vendor. Records how the VENDOR types, not what was
 *  printed — so it is evidence of a listing, never of a card's identity. */
const VENDOR = /^(cardhedge|cardsight|ebay|user-verified)/;

/** Transcribes a printed checklist. The only class that may adjudicate. */
const CHECKLIST = /checklist|beckett|cardpedia|bccp|cardboard.?connection|almanac|hobbymonitor|tcdb|tcgdex|pokemon-tcg-data|official-pdf/;

/**
 * Classify a catalog row's source.
 *
 * Order matters: DERIVED is tested first because several derived sources embed
 * a checklist-ish word, and a row we generated must not be promoted by its own
 * name. `-graded` is stripped because a graded twin has the same provenance as
 * its parent.
 */
export function catalogAuthorityOf(source: string | null | undefined): CatalogAuthority {
  const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
  if (!s || s === "undefined" || s === "null") return "unknown";
  if (DERIVED.test(s)) return "derived";
  if (VENDOR.test(s)) return "vendor";
  if (/-product-structure$/.test(s)) return "vendor";
  if (CHECKLIST.test(s)) return "checklist";
  return "unknown";
}

/** May this row decide which set/number/parallel a card belongs to? */
export function canAdjudicate(source: string | null | undefined): boolean {
  return catalogAuthorityOf(source) === "checklist";
}

/**
 * May this row's setKey be rewritten to a checklist-backed one?
 *
 * Everything that is not itself a checklist. A vendor's product classification
 * and our own seeds are both re-keyable; a checklist row never is, because a
 * checklist is what put it there.
 */
export function isReKeyable(source: string | null | undefined): boolean {
  return catalogAuthorityOf(source) !== "checklist";
}

/**
 * Rank sources when choosing a survivor among duplicate rows for one card.
 * Higher wins. Deliberately coarse — within a class, callers should break ties
 * on completeness (a row carrying a print run beats one that does not) rather
 * than on which source happened to be scraped last.
 */
export function authorityRank(source: string | null | undefined): number {
  switch (catalogAuthorityOf(source)) {
    case "checklist": return 3;
    case "vendor": return 2;
    case "derived": return 1;
    default: return 0;
  }
}
