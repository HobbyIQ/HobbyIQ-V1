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

/**
 * Generated from our own observations or inference. Never adjudicates.
 *
 * CF-A-DERIVED-SOURCE-MAY-NOT-SPELL-CHECKLIST (2026-09-04). The class comment
 * below says DERIVED is tested first "because several derived sources embed a
 * checklist-ish word". Two families we actually write were embedding one and
 * escaping this regex anyway, because the regex is ANCHORED and their names do
 * not start with a listed stem:
 *
 *   derived-from-base-checklist-2026-08-23          -> was CHECKLIST, rank 3
 *   derived-from-base-checklist-tiffany-2026-08-23  -> was CHECKLIST, rank 3
 *   sales-attested                                  -> was UNKNOWN,   rank 0
 *   sales-attested-2026-08                          -> was UNKNOWN,   rank 0
 *
 * The first pair is the worse of the two and is the exact failure this class
 * exists to prevent: a row SYNTHESISED from a base card (create-tiffany-cards-
 * from-base, create-product-line-cards-from-base) was ranking EQUAL to a real
 * transcription. Equal rank does not merely fail to lose -- mergeCatalogEntries
 * breaks a rank tie on confidence with `>`, so on a tie the INCUMBENT keeps the
 * row. A synthetic row therefore could not be corrected by the checklist that
 * should own the card; the ingest wrote and the merge discarded.
 *
 * `sales-attested` is the same shape one rung lower: rows attested by our own
 * sales, landing at rank 0, BELOW the ingest-auto-seed rows they are siblings
 * of. materialize-ungraded-parents.cjs already documents this exact hazard for
 * its own `ingest-auto-seed-graded-attested` and named that one to inherit the
 * prefix deliberately. These two never got the same treatment.
 *
 * The fix is to keep the anchor (an unanchored `derived` would sweep any source
 * with the word anywhere) and add the two stems by name. `sales-` is NOT
 * widened to a bare prefix: a future `sales-checklist-…` transcription must not
 * be demoted by a word in its name any more than a derived one is promoted by
 * one.
 */
const DERIVED = /^(ingest-auto-seed|sold-comps-stub|catalog-explode|tree-builder|sales-derived|sales-attested|derived-from|pool)/;

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
 * The narrower set trusted for HOW A VALUE IS SPELLED — punctuation, hyphens,
 * casing — as opposed to WHICH CARDS EXIST.
 *
 * SOURCE QUALITY IS QUESTION-DEPENDENT, and conflating the two questions is a
 * real bug we shipped and had to unpick. Coverage wants every transcription;
 * formatting wants only the meticulous ones. Measured over Bowman
 * BCP/BP/BDC/BD/BTP numbers (hy = "BCP-109", no = "BCP109"):
 *
 *     checklistcenter        85,139 hy      0 no     0%
 *     checklistcenter-graded 81,612 hy      0 no     0%
 *     checklist              10,608 hy     12 no     0%
 *     beckett-* (all runs)    5,087 hy      0 no     0%
 *     checklistinsider        3,100 hy      0 no     0%
 *     ------------------------------------------------------
 *     baseballcardpedia     153,296 hy 21,300 no    12%
 *     bccp                   65,775 hy 14,411 no    18%
 *     checklistcenter-html   13,866 hy  4,200 no    23%
 *
 * Dedicated transcriptions are unanimous; the wiki-style sources disagree with
 * THEMSELVES 12-18% of the time. Judging punctuation on those blocks correct
 * repairs on noise — widening this predicate to match canAdjudicate flipped 51
 * card-number prefixes from "repair" to "blocked" on exactly that.
 *
 * Note `checklistcenter-html` is excluded while `checklistcenter` is trusted:
 * same site, different extraction, and the HTML path is the dirtiest source
 * measured. The suffix matters.
 */
export function isTranscriptionGrade(source: string | null | undefined): boolean {
  const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
  if (s === "checklistcenter-html") return false;
  return /^(checklistcenter|checklist|checklistinsider|beckett)/.test(s);
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
 * Was this row generated from our own observations rather than transcribed?
 *
 * The predicate callers actually want when they ask "is this row dirty" — and
 * the one they kept re-declaring as a two-element Set. `sales-derived` and
 * `tree-builder-v1` are the two everyone remembers; `ingest-auto-seed`,
 * `sold-comps-stub`, `catalog-explode` and `pool` are the same shape at much
 * larger scale and were being treated as clean.
 *
 * NOT the same question as "should a user see this row" — see catalogVisibility,
 * which is deliberately narrower because a derived row is often the ONLY row a
 * card has, and hiding it would lose coverage rather than gain accuracy.
 */
export function isDerived(source: string | null | undefined): boolean {
  return catalogAuthorityOf(source) === "derived";
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

// ── R2: WHICH PRODUCT DOES A CARD BELONG TO? ────────────────────────────────
//
// CF-THE-CHECKLIST-THAT-NAMES-THE-PRODUCT-WINS (Drew, 2026-08-30, D29/R2):
// "the checklist that names the product wins; bcp's Bowman page is not that."
//
// A CPA auto filed under BOTH `bowman` and `bowman-chrome` is not two cards.
// One of those two rows is a dedicated checklist transcription of a specific
// release; the other is a wiki page that lists the insert under whichever
// product its editor filed it beside. Measured over the bowman CPA scope
// (2020-2026, 117,529 identities): 2,385 identities have exactly ONE
// dedicated key and at least one bcp-family key at another product.
//
// `catalogAuthorityOf` CANNOT draw this line, and deliberately so. Its
// CHECKLIST class exists to answer "is this row evidence at all", and for that
// question baseballcardpedia's 918,828 rows are emphatically yes -- narrowing
// it discarded them once already (see the header). So this is an ADDED
// predicate, not a widened one: `canAdjudicate`, `isReKeyable` and
// `authorityRank` keep the answers they have, and the new question gets its
// own name. (CF-THE-RECURRING-BUG-SHAPE: right guard, wrong scope -- editing
// the existing regex would have moved three other consumers with it.)
//
// The split is the same one `isTranscriptionGrade` already measured for
// punctuation, and for the same reason: the dedicated transcriptions are
// unanimous, the wiki sources disagree with THEMSELVES 12-18% of the time. A
// source that cannot agree with itself about a hyphen is not the source that
// decides which product a card shipped in.
//
// `checklistcenter-html` is excluded exactly as it is for formatting: same
// site, different extraction, the dirtiest source measured.

/** Dedicated per-release checklist transcriptions -- the only sources that may
 *  name WHICH PRODUCT a card belongs to (D29/R2). */
const DEDICATED_CHECKLIST = /^(checklistcenter|checklistinsider|beckett|cardboardchecklist)/;

/** The wiki-style sources. Real evidence that a card EXISTS; never evidence of
 *  which product it shipped in -- their product pages aggregate inserts. */
const BCP_FAMILY = /^(baseballcardpedia|bccp)/;

/**
 * May this source name which PRODUCT a card belongs to?
 *
 * Strictly narrower than `canAdjudicate`: every dedicated checklist can
 * adjudicate, but not every adjudicating source names the product.
 */
export function isDedicatedChecklist(source: string | null | undefined): boolean {
  const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
  if (s === "checklistcenter-html") return false;
  if (DERIVED.test(s)) return false;
  return DEDICATED_CHECKLIST.test(s);
}

/** A wiki-family source (baseballcardpedia, bccp). Its product filing folds. */
export function isBcpFamily(source: string | null | undefined): boolean {
  const s = String(source ?? "").toLowerCase().trim().replace(/-graded$/, "");
  return BCP_FAMILY.test(s);
}
