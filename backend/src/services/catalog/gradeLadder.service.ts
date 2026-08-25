// CF-ONE-GRADE-LADDER (Drew, 2026-08-25: "I want to organize the graded
// companies and numbers the right way").
//
// ONE DECLARATION OF WHICH GRADES EACH COMPANY ACTUALLY ISSUES, because the
// catalog is currently full of grades that do not exist. Measured over
// card_catalog on 2026-08-25:
//
//   PSA   10:1,474,515   9:1,469,344   8:1,464,459   9.5:1,462,071
//   BGS   10:2,924,281   9.5:1,462,803 9:1,462,526   8.5:9,876
//   CGC   10:1,462,663   9.5:1,462,183 9:10,106
//   SGC   10:1,463,128   9.5:10,381    9:10,214
//
// PSA HAS NO 9.5. Its scale runs ... 8, 8.5, 9, 10 -- the jump from 9 to 10 is
// the single best-known feature of PSA grading, and it is why a PSA 10 carries
// the premium it does. Those 1,462,071 rows are cards that cannot exist.
//
// You can read the defect straight off the shape: each generated rung sits at
// ~1.46M (one per card) while genuinely OBSERVED grades sit near 10k. A ladder
// was exploded per company from one shared grade set, without ever asking which
// grades that company issues. This file is that question, answered once.
//
// BGS 10 IS DOUBLE EVERY OTHER RUNG (2,924,281 = 2.00 x 1,462,140). Beckett
// issues both a Pristine 10 and a Black Label 10 -- the same numeric grade, two
// different cards, wildly different money -- and vendor taxonomies conflate
// them (see the Cardsight Pristine-10 conflation). That surplus is a DUPLICATE
// population, not a phantom-grade one, so it is deliberately NOT expressed as a
// grade rule here; it needs the label preserved, not the row deleted.
//
// SCOPE. This says which grades a company ISSUES. It does not say which grades
// are worth generating a catalog row for -- that is a coverage decision and a
// different question.

/** Companies whose scale we assert. Anything else is unknown, not invalid. */
export type GradeCompany = "PSA" | "BGS" | "SGC" | "CGC" | "CSG" | "HGA" | "TAG" | "BCCG" | "ISA" | "AGS" | "ARENA CLUB";

/** Half-point scale from `min` to 10 inclusive: 1, 1.5, 2 ... 9.5, 10. */
function halfScale(min: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= 10 + 1e-9; v += 0.5) out.push(Math.round(v * 10) / 10);
  return out;
}

/**
 * PSA runs the half scale to 8.5, then 9, then 10. There is NO 9.5 and no 9.5
 * equivalent; a "PSA 9.5" is either a mis-parse or another company's grade
 * wearing PSA's name.
 */
const PSA_SCALE: number[] = [
  1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 10,
];

const LADDERS: Record<GradeCompany, number[]> = {
  PSA: PSA_SCALE,
  // Beckett, CGC/CSG, SGC and the newer graders all issue half points the whole
  // way up, 9.5 included. 9.5 is BGS's Gem Mint and is common, not exotic.
  BGS: halfScale(1),
  SGC: halfScale(1),
  CGC: halfScale(1),
  CSG: halfScale(1),
  HGA: halfScale(1),
  TAG: halfScale(1),
  ISA: halfScale(1),
  AGS: halfScale(1),
  "ARENA CLUB": halfScale(1),
  // Beckett's club-grade scale is coarse and whole-number only; a BCCG 9.5 is
  // not a thing.
  BCCG: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
};

/** Spellings seen in the data, mapped to the canonical company. */
const ALIASES: Record<string, GradeCompany> = {
  PSA: "PSA", "PSA/DNA": "PSA",
  BGS: "BGS", BECKETT: "BGS", "BECKETT GRADING": "BGS", "BECKETT GRADING SERVICES": "BGS",
  SGC: "SGC", "SPORTSCARD GUARANTY": "SGC",
  CGC: "CGC", "CGC CARDS": "CGC",
  CSG: "CSG", "CERTIFIED SPORTS GUARANTY": "CSG",
  HGA: "HGA", "HYBRID GRADING APPROACH": "HGA",
  TAG: "TAG",
  BCCG: "BCCG",
  ISA: "ISA",
  AGS: "AGS",
  "ARENA CLUB": "ARENA CLUB",
  // Both spellings appear in card_catalog (6 rows and 3 rows) and are one
  // company. Folding them here is what stops that being two graders forever.
  "MINT GRADING SERVICE": "AGS",
  "MNT GRADING": "AGS",
};

/**
 * Canonical company for a raw value, or null when it is not a grader we know.
 *
 * Null is NOT the same as invalid. `RARE EDITION` and `THE FINAL AUTHORITY`
 * (one row each) are almost certainly title text that a parser mistook for a
 * grader, and saying "unknown" lets a caller quarantine them without this file
 * having to adjudicate every piece of junk that ever lands in the field.
 */
export function canonicalGradeCompany(raw: string | null | undefined): GradeCompany | null {
  const s = String(raw ?? "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!s) return null;
  return ALIASES[s] ?? null;
}

/** The grades a company issues, or null if we do not assert a scale for it. */
export function gradesFor(company: string | null | undefined): number[] | null {
  const c = canonicalGradeCompany(company);
  return c ? LADDERS[c] : null;
}

/**
 * Does this company issue this grade?
 *
 * Returns true for an unknown company: we decline to call a grade impossible on
 * a scale we have not established. Only a company whose ladder we DO assert can
 * produce a false, which keeps this safe to use as a delete predicate.
 */
export function isIssuedGrade(company: string | null | undefined, value: number | null | undefined): boolean {
  const ladder = gradesFor(company);
  if (!ladder) return true;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return ladder.includes(Math.round(value * 10) / 10);
}

/**
 * The inverse, stated positively so call sites read as intent: a row asserting
 * a grade its own company does not issue.
 */
export function isImpossibleGrade(company: string | null | undefined, value: number | null | undefined): boolean {
  if (canonicalGradeCompany(company) === null) return false;
  if (value === null || value === undefined) return false;
  return !isIssuedGrade(company, value);
}

/**
 * One representation of "not graded". card_catalog currently says this two
 * ways -- `undefined` on 22,485,001 rows and `null` on 1,567,312 -- which is
 * the same drift the field normaliser exists to remove, never applied here.
 */
export function isRaw(company: string | null | undefined, value: number | null | undefined): boolean {
  return canonicalGradeCompany(company) === null && (value === null || value === undefined);
}

/** Every company whose ladder this file asserts. */
export const GRADE_COMPANIES = Object.keys(LADDERS) as GradeCompany[];
