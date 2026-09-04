/**
 * CF-A-SUBSET-IS-PART-OF-THE-IDENTITY-WHEN-IT-HAS-TO-BE (Drew ruling,
 * 2026-09-04) — THE MATCHER HALF.
 *
 * The identity half lives in hobbyIqCardId.service (`subsetInId` puts a
 * `:sub-` segment in the slug) and the ingest half in
 * ingest-checklist-csv-to-catalog (it decides the clash from the catalog and
 * persists the flag). This module is the third: given a sale whose plain id
 * lands on a product rung the catalog says is CLASHING, which of the
 * subset-bearing ids — if any — does the title actually name?
 *
 * THE RULE, AND WHY IT REFUSES SO READILY
 *
 *   A title that NAMES the subset ("2000-01 Topps Chrome Aptitude for
 *   Altitude MJ1 Refractor") derives the subset-bearing id for that subset.
 *
 *   A title that does not name it derives the PLAIN id, and the rematch
 *   classifies it UNDERIVABLE-for-subset — report-only, never a guess.
 *
 * The refusal is the important half. #1741 measured the market's own answer
 * for the motivating case: all three sold_comps rows carrying "Johnson
 * Reprints" spell the card #2 or #7, and the rest of the pool does not
 * disambiguate the subsets at all. So most sales genuinely CANNOT be assigned,
 * and a matcher that picked the more popular subset would be inventing an
 * answer the seller never gave — filing a card into a pool it may not belong
 * to, which is the harm the whole ruling exists to prevent. An unassigned row
 * stays exactly where it is and is reported; it is not moved onto a coin flip.
 *
 * AMBIGUITY IS ALSO A REFUSAL. A title naming TWO of the clashing subsets, or
 * one whose match is not a whole-phrase match, yields nothing. There is no
 * "best" subset here — either the seller said which one, or they did not.
 */

/** How a title was resolved against a clashing rung's subsets. */
export type SubsetMatchOutcome =
  /** The title names exactly one of them. Use `subsetName`. */
  | "named"
  /** No candidate is named. The plain id stands; the rematch reports it. */
  | "unnamed"
  /** Two or more are named, so the title settles nothing. */
  | "ambiguous";

export interface SubsetMatch {
  outcome: SubsetMatchOutcome;
  /** The subset the title named, on "named" only. Null otherwise — this
   *  function never returns a subset it merely considered likely. */
  subsetName: string | null;
  /** Every candidate the title matched, so a report can show the ambiguity
   *  rather than just assert it. */
  matched: string[];
}

/** Fold to the comparable form: lowercase, punctuation to single spaces.
 *  Keeps digits, so "Series 1" and "Series 2" stay different subsets. */
export function foldSubsetText(raw: string | null | undefined): string {
  return String(raw ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Does `title` name `subset`? A WHOLE-PHRASE match on word boundaries, in the
 * folded form, so "Aptitude for Altitude" matches "...Aptitude For Altitude
 * MJ1..." and "Inserts" does not match "Insertsomething".
 *
 * Deliberately not a token-overlap or fuzzy score. A subset name like "Base
 * Set" or "Promos" shares tokens with half the titles in the corpus, and a
 * partial match on one of those would assign cards by coincidence.
 */
export function titleNamesSubset(title: string | null | undefined, subset: string | null | undefined): boolean {
  const t = foldSubsetText(title);
  const s = foldSubsetText(subset);
  if (!t || !s) return false;
  return ` ${t} `.includes(` ${s} `);
}

/**
 * Resolve a sale title against the subsets that share one clashing rung.
 *
 * `candidates` comes from the CATALOG — the subsetName of every row at this
 * (sport, year, setKey, cardNumber, parallel, isAuto, printRun). It is never
 * a vocabulary this module carries, because the clash is a fact about one
 * product and only the product's own rows state it.
 */
export function resolveSubsetFromTitle(
  title: string | null | undefined,
  candidates: ReadonlyArray<string | null | undefined>,
): SubsetMatch {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const c of candidates) {
    const s = String(c ?? "").trim();
    // Blank means unknown. An unknown subset is not a candidate to match
    // against, and it is certainly not the answer when nothing else matches.
    if (!s) continue;
    const k = foldSubsetText(s);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    clean.push(s);
  }
  const matched = clean.filter((c) => titleNamesSubset(title, c));
  if (matched.length === 1) return { outcome: "named", subsetName: matched[0], matched };
  if (matched.length > 1) return { outcome: "ambiguous", subsetName: null, matched };
  return { outcome: "unnamed", subsetName: null, matched };
}

/** The rematch class for a sale sitting on a plain id whose rung clashes and
 *  whose title does not settle which subset it is. Report-only: the row is
 *  described, never moved. */
export const UNDERIVABLE_FOR_SUBSET = "UNDERIVABLE-for-subset";
