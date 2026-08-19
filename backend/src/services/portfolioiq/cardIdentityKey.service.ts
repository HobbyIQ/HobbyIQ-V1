// CF-CARD-IDENTITY-VS-GRADE (Drew, 2026-08-19: "lets fix the dimensions and do
// it properly" / "we want to have all grades available for people").
//
// THE ONE RULE: a card's IDENTITY and its GRADE are different dimensions, and
// grade is never read out of a slug by position.
//
// Both are legitimate and both must exist. Print run is part of IDENTITY — a
// Gold /50 is a different card from a Refractor /499. Grade is a PRICING
// dimension OF one card — the same Gold /50 in PSA 9 and PSA 10.
//
// card_catalog models this correctly today via a deliberate grade explode
// (catalogBatch `grade-explode-2026-08-10`): one row per (card, grade), with
// the card identity kept in `parentSlug` and the grade in fields.
//
//     hobbyiqCardId  hiq:baseball:2026:bowman:bp-102:base:no-auto:psa-9-5
//     parentSlug     hiq:baseball:2026:bowman:bp-102:base:no-auto
//     gradeCompany   PSA
//     gradeValue     9.5
//     gradeTier      psa-9-5
//
// Measured 2026-08-19 over 1,385,495 Bowman rows (2023-26): 597,433 rows carry
// grade fields and 597,433 carry parentSlug — exactly consistent. Nothing to
// repair. What was missing is an enforced way to ASK.
//
// WHY THIS FILE EXISTS RATHER THAN A COMMENT. sold_comps and card_catalog put
// different things in slug segment 7 — a print run (`num-499`) in comps, a
// grade tier (`psa-9-5`) in exploded catalog rows. A join on `hobbyiqCardId`
// therefore treats every graded row as a different card and manufactures
// ORPHANs; a join on `parentSlug` alone drops every ungraded row, which is most
// of them. Callers need one function that is right in both directions.
//
// AND SLUG-SNIFFING FOR A GRADE IS A TRAP. While auditing this, a regex
// `/:(psa|bgs|sgc|cgc|raw)(-|$)/` was used to find "rows whose grade is only in
// the slug". It reported 221 — every one a FALSE POSITIVE, because those cards
// have a CARD NUMBER beginning `PSA-`:
//
//     hiq:football:2024:bowman:psa-th2:sky-blue:no-auto:num-499
//
// A positionally-blind match on a slug cannot tell segment 4 from segment 7.
// Grade comes from FIELDS. That is what `gradeOf` is for, and why
// `cardIdentityKey` never inspects the tail of a slug.

/** The seven identity segments: hiq:sport:year:setKey:cardNumber:parallel:auto,
 *  plus an optional print-run segment which IS part of identity. */
const IDENTITY_SEGMENTS = 7;

/** Grade tokens only ever appear in segment 8 of an EXPLODED catalog row, and
 *  only when segment 8 is not a print run. Exported for tests, not for callers
 *  — callers use `gradeOf`. */
// `[0-9]{1,2}` because a grade of TEN is two digits — the first cut used a
// single `[0-9]` and silently failed to recognise every PSA 10 and BGS 10, the
// most valuable rows in the catalog.
export const GRADE_TIER_RE = /^(psa|bgs|sgc|cgc|ace|tag|hga)-[0-9]{1,2}(-[0-9])?(-black)?$|^raw$/i;

export interface CardIdentityInput {
  hobbyiqCardId?: string | null;
  parentSlug?: string | null;
}

export interface GradeInput {
  gradeCompany?: string | null;
  gradeValue?: number | string | null;
  gradeTier?: string | null;
}

/**
 * The slug that identifies the CARD, ignoring grade.
 *
 * - An exploded catalog row returns its `parentSlug`.
 * - Everything else returns its own slug.
 * - A slug whose 8th segment is a grade tier has it stripped, as a backstop for
 *   rows written before the explode carried `parentSlug`.
 *
 * A print-run segment (`num-499`) is PRESERVED — it is identity, not grade.
 *
 * Returns null when there is no usable slug, so callers must decide what to do
 * rather than silently matching on an empty string.
 */
export function cardIdentityKey(row: CardIdentityInput): string | null {
  const parent = typeof row.parentSlug === "string" ? row.parentSlug.trim() : "";
  if (parent) return parent;

  const slug = typeof row.hobbyiqCardId === "string" ? row.hobbyiqCardId.trim() : "";
  if (!slug) return null;

  const parts = slug.split(":");
  // Only segment 8 can be a grade tier, and only if it looks like one. This is
  // a POSITIONAL check on purpose — a card number of `psa-th2` lives in segment
  // 4 and must never be mistaken for a grade.
  if (parts.length > IDENTITY_SEGMENTS && GRADE_TIER_RE.test(parts[IDENTITY_SEGMENTS])) {
    return parts.slice(0, IDENTITY_SEGMENTS).join(":");
  }
  return slug;
}

/**
 * The grade of a row, read from FIELDS only.
 *
 * Never inspects the slug. A row with no grade fields is RAW/ungraded, which is
 * a real answer rather than a missing one.
 */
export function gradeOf(row: GradeInput): { company: string | null; value: number | null; tier: string } {
  const company = typeof row.gradeCompany === "string" && row.gradeCompany.trim()
    ? row.gradeCompany.trim().toUpperCase() : null;
  const raw = row.gradeValue;
  const value = raw == null || raw === "" ? null : Number(raw);
  if (!company || value == null || Number.isNaN(value)) return { company: null, value: null, tier: "raw" };
  const tier = typeof row.gradeTier === "string" && row.gradeTier.trim()
    ? row.gradeTier.trim().toLowerCase()
    : `${company.toLowerCase()}-${String(value).replace(".", "-")}`;
  return { company, value, tier };
}

/** True when two rows describe the same physical card, whatever their grades. */
export function isSameCard(a: CardIdentityInput, b: CardIdentityInput): boolean {
  const ka = cardIdentityKey(a);
  const kb = cardIdentityKey(b);
  return ka !== null && ka === kb;
}
