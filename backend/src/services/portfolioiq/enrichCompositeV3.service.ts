// CF-COMPOSITE-V3-ENRICH (Drew, 2026-07-31). Additive-only enrichment
// on top of the v1 composite. Computes 4 new axes from data already
// stored on the row (plus productLine + year from the slug) — no
// title re-parsing needed, so this can backfill 3.4M sold_comps rows
// via a cheap read-modify-write loop.
//
// New axes:
//   era                   — E0_vintage..E4_modern (from cardYear)
//   ladderVerdict         — matched-verified | matched-probable |
//                           impossible-serial | color-not-in-ladder |
//                           no-ladder
//   ladderTierColor       — canonical color from the matched tier
//                           (nullable; only set when verdict is a
//                           match)
//   ladderTierRun         — expected serialRun from the matched tier
//                           (nullable; only set when verdict is a match
//                           and the tier has a numeric run)
//   paniniColorEquivalent — chrome-side equivalent for cross-vendor
//                           pooling (nullable; only set for panini
//                           products with mappable colors)

import {
  resolveEra,
  resolvePaniniColorEquivalent,
  validateAgainstLadder,
} from "./parallelVocabulary.service.js";

export interface CompositeV3Fields {
  era: string | null;
  ladderVerdict:
    | "matched-verified"
    | "matched-probable"
    | "impossible-serial"
    | "color-not-in-ladder"
    | "no-ladder"
    | null;
  ladderTierColor: string | null;
  ladderTierRun: number | null;
  paniniColorEquivalent: string | null;
}

/**
 * Compute the 4 v3 composite fields from an existing row's identity.
 * All inputs are ALREADY on the row (via v1 composite + slug parse),
 * so this is a pure function over the row shape — safe to call from
 * the persist path (new writes) AND from a backfill loop (existing
 * rows).
 */
export function enrichCompositeV3(input: {
  cardYear: number | null | undefined;
  productLine: string | null | undefined;
  colorFamily: string | null | undefined;
  serialRun: number | null | undefined;
}): CompositeV3Fields {
  const era = resolveEra(input.cardYear);
  const paniniColorEquivalent = resolvePaniniColorEquivalent(
    input.productLine,
    input.colorFamily,
  );

  // Ladder verdict requires all three: product, color, and either a
  // serial or explicit null-unnumbered. When any anchor is missing
  // return no-ladder so downstream can distinguish "no verdict
  // computed" from a real match.
  if (!input.productLine || !input.colorFamily) {
    return {
      era,
      ladderVerdict: "no-ladder",
      ladderTierColor: null,
      ladderTierRun: null,
      paniniColorEquivalent,
    };
  }

  const verdict = validateAgainstLadder(
    input.productLine,
    input.cardYear,
    input.colorFamily,
    input.serialRun ?? null,
  );

  // Flatten the discriminated union into two scalar fields so it
  // stores cleanly on the row + is trivially indexable in Cosmos.
  switch (verdict.verdict) {
    case "matched-verified":
    case "matched-probable": {
      const color = String(
        (verdict.tier as { color?: string; name?: string }).color ??
        (verdict.tier as { color?: string; name?: string }).name ??
        "",
      ).toUpperCase() || null;
      const run =
        typeof verdict.tier.run === "number" ? verdict.tier.run : null;
      return {
        era,
        ladderVerdict: verdict.verdict,
        ladderTierColor: color,
        ladderTierRun: run,
        paniniColorEquivalent,
      };
    }
    case "impossible-serial":
    case "color-not-in-ladder":
    case "no-ladder":
      return {
        era,
        ladderVerdict: verdict.verdict,
        ladderTierColor: null,
        ladderTierRun: null,
        paniniColorEquivalent,
      };
  }
}
