// CF-BUYERIQ-GRADE-AWARE-MATCH (Drew, 2026-09-03). The deal scanner's
// listing-to-card matcher, made grade-aware.
//
// THE DEFECT THIS FIXES. The scanner verified a listing's PARALLEL and
// player identity (titleMatchesParallel) and then measured its ask
// against the target tier's projection — with nothing in between
// checking that the listing was actually IN that tier. eBay's Browse
// keyword search does not filter by grade, and the ranker
// (ebayListingRank) only DEMOTES a mismatch (-15 wrong-grade, -30
// raw-but-graded) rather than excluding it, so a raw card comfortably
// survived into the top 5 for a "PSA 10" target and was then reported
// as ~70% off "its" projection. An adversarial sample found 6 of 8
// flagged deals were exactly this: a raw or lower-grade ask discounted
// against a higher tier's number.
//
// THE DOCTRINE (D21 — the grade curve IS the graded card). FMV is per
// exact identity INCLUDING grade tier. A deal is a listing priced below
// the projected next sale of ITS OWN tier. Therefore:
//
//   1. A graded listing must match the target on COMPANY *and* NUMERIC
//      GRADE. PSA 9 is not a cheap PSA 10; it is a different card with
//      its own pool and its own projection.
//   2. A raw listing compares ONLY against the raw tier.
//   3. When the listing's grade CANNOT BE READ from the evidence we
//      have, the scanner REFUSES to score it — "grade unknown, not
//      scored". It never defaults to raw, and never to the best tier.
//      Defaulting either way manufactures exactly the false positive
//      above: to raw, and every slab reads as a steal against the raw
//      projection; to the target's tier, and every unreadable title
//      inherits a number it was never measured against.
//
// WHY "UNKNOWN" IS A REAL BUCKET, NOT AN EDGE CASE. ActiveListing
// carries no condition, conditionId, itemSpecifics or aspects field —
// the Browse call requests none of them (see ebayListingSearch.service:
// item_summary/search with q + category_ids only). The TITLE is the
// entire grade evidence available. So "unreadable" is common, and
// silently bucketing it is how the original bug scored 6 of 8 wrong.
// Refusing costs us some true deals; scoring them costs the user money
// and costs the feed its credibility. Drew's ruling on the speculative
// tier applies with equal force here: a discount off a number the
// listing was never measured against is evidence we read the listing
// wrong, not evidence of a deal.
//
// Grade extraction REUSES portfolioiq/gradeParser.parseGradeLabel —
// the repo's most complete title parser (PSA/BGS/SGC/CGC/CSG/HGA,
// half-grades, Black Label with hedge guards, Authentic slabs, PSA
// descriptor vernacular, year/card-number stripping, and the
// grader-with-the-number-wins disambiguation tuned on real eBay
// titles). We do NOT add a seventh regex to the six already in the
// repo. What this module adds on top is the one thing no existing
// helper does: telling RAW apart from UNKNOWN.

import { parseGradeLabel } from "../portfolioiq/gradeParser.js";
import { canonicalGradeCompany } from "../catalog/gradeLadder.service.js";

/** What the title says the listing's grade tier is. */
export type ListingGradeReading =
  | { kind: "graded"; company: string; value: number; isBlackLabel: boolean; isAuthentic: boolean }
  /** The title AFFIRMATIVELY says ungraded ("raw", "ungraded", "no grade"). */
  | { kind: "raw" }
  /** Nothing in the title settles it. NOT scoreable. */
  | { kind: "unknown" };

/**
 * Words by which a seller affirmatively states the card is NOT in a
 * slab. Only these license a raw reading — the ABSENCE of a grade token
 * does not, because most raw listings say nothing at all and so do
 * plenty of graded ones whose grade sits in the item specifics we never
 * fetched.
 */
const RAW_ASSERTIONS: RegExp[] = [
  /\braw\b/i,
  /\bungraded\b/i,
  /\bnot\s+graded\b/i,
  /\bno\s+grade\b/i,
  /\bnon[\s-]?graded\b/i,
];

/**
 * A slab is being described even though we could not pin the number —
 * e.g. "PSA graded", "in a BGS slab", "just back from SGC". Such a
 * title is NOT raw, and it is not a readable tier either: it is
 * unknown, and must not be scored.
 */
// NOTE the negative lookbehind on "graded": the raw assertions above
// are themselves phrased with that word ("not graded", "non-graded"),
// so an unguarded /\bgraded\b/ fires on the very titles that most
// clearly say RAW and flips them to unknown. Pinned by the
// "AFFIRMATIVE raw assertion" test.
const GRADED_HINTS: RegExp[] = [
  /\b(psa|bgs|sgc|cgc|csg|hga|beckett)\b/i,
  /(?<!\bnot\s)(?<!\bnon[\s-]?)(?<!\bun)\bgraded\b/i,
  /\bslab(?:bed)?\b/i,
  /\bgem\s*m(?:t|int)\b/i,
];

/** Lots and multi-card listings have no single grade or single card. */
const LOT_PATTERNS: RegExp[] = [
  /\blot\s+of\s+\d+/i,
  /\b\d+\s*card\s+lot\b/i,
  /\bmixed\s+lot\b/i,
  /\brepack\b/i,
];

/** True when the title describes a multi-card lot rather than one card. */
export function isLotListing(title: string): boolean {
  const t = String(title ?? "");
  return LOT_PATTERNS.some((re) => re.test(t));
}

/**
 * Read a listing's grade tier from its title.
 *
 * Three outcomes, deliberately distinct — no existing helper in the
 * repo makes this distinction (parseGradeLabel returns null for BOTH
 * "explicitly raw" and "cannot tell", which is precisely the collapse
 * that let raw listings be priced as slabs).
 */
export function readListingGrade(title: string | null | undefined): ListingGradeReading {
  const t = String(title ?? "").trim();
  if (!t) return { kind: "unknown" };

  // A lot is never one card in one tier.
  if (isLotListing(t)) return { kind: "unknown" };

  const parsed = parseGradeLabel(t);
  if (parsed && parsed.gradeCompany) {
    const company = canonicalGradeCompany(parsed.gradeCompany) ?? parsed.gradeCompany.toUpperCase();
    return {
      kind: "graded",
      company,
      value: parsed.gradeValue,
      isBlackLabel: parsed.isBlackLabel === true,
      isAuthentic: parsed.isAuthentic === true,
    };
  }

  // No parseable grade. Distinguish "seller says raw" from "we cannot tell".
  const saysRaw = RAW_ASSERTIONS.some((re) => re.test(t));
  const hintsGraded = GRADED_HINTS.some((re) => re.test(t));

  // "PSA graded, raw price!" — contradictory. Unknown, not raw.
  if (saysRaw && !hintsGraded) return { kind: "raw" };
  return { kind: "unknown" };
}

/** The tier the user's target is in. */
export interface TargetTier {
  gradeCompany: string | null;
  gradeValue: number | null;
}

export type GradeMismatchReason =
  /** The title does not settle what tier this listing is in. */
  | "grade-unknown"
  /** Target is graded, listing is raw. */
  | "listing-raw-target-graded"
  /** Target is raw, listing is a slab. */
  | "listing-graded-target-raw"
  /** Both graded, different grading company. */
  | "grade-company-mismatch"
  /** Both graded, same company, different number. */
  | "grade-value-mismatch";

export type GradeMatchVerdict =
  | { ok: true; reading: ListingGradeReading }
  | { ok: false; reason: GradeMismatchReason; reading: ListingGradeReading };

/**
 * Does this listing belong to the target's grade tier?
 *
 * Exact identity including grade. Both must be raw, or both must be
 * graded by the SAME company at the SAME numeric grade. Anything we
 * cannot read is refused rather than assumed.
 */
export function listingMatchesGrade(
  title: string | null | undefined,
  target: TargetTier,
): GradeMatchVerdict {
  const reading = readListingGrade(title);
  const targetCompany = canonicalGradeCompany(target.gradeCompany);
  const targetIsRaw =
    targetCompany === null && (target.gradeValue === null || target.gradeValue === undefined);

  if (reading.kind === "unknown") {
    return { ok: false, reason: "grade-unknown", reading };
  }

  if (targetIsRaw) {
    // A raw target compares ONLY to the raw tier.
    if (reading.kind === "raw") return { ok: true, reading };
    return { ok: false, reason: "listing-graded-target-raw", reading };
  }

  // Target is graded.
  if (reading.kind === "raw") {
    return { ok: false, reason: "listing-raw-target-graded", reading };
  }

  // An Authentic slab carries no numeric tier and trades well below the
  // graded card; it is never a match for a numeric target.
  if (reading.isAuthentic) {
    return { ok: false, reason: "grade-value-mismatch", reading };
  }

  if (canonicalGradeCompany(reading.company) !== targetCompany) {
    return { ok: false, reason: "grade-company-mismatch", reading };
  }

  if (target.gradeValue === null || target.gradeValue === undefined) {
    // Target names a company but no number — we cannot assert the tier.
    return { ok: false, reason: "grade-unknown", reading };
  }

  if (reading.value !== target.gradeValue) {
    return { ok: false, reason: "grade-value-mismatch", reading };
  }

  return { ok: true, reading };
}
