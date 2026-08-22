/**
 * CF-GRADE-CURVE-POOL-UNION (2026-08-22).
 *
 * The grade curve priced cards off a narrower comp pool than the portfolio did
 * for the SAME card, so the two surfaces disagreed before any math ran.
 *
 * unifiedPricing queries `(c.cardId = @cid OR c.hobbyiqCardId = @hiq)`. But
 * portfolioStore resolves a holding's slug to the dominant vendor cardId before
 * building the curve — and that resolution DROPPED the slug, so the overlay
 * unioned the vendor id against nothing.
 *
 * Measured across 24 real holdings with vendor rows: 12 changed, 19 tiers moved.
 *   Ohtani 2018 BC #1   SGC 9   $4,843.98 -> $1,660
 *   Max Williams        PSA 9      $56.70 -> $142.50 (refractor)
 *                       PSA 9      $56.70 ->  $20.50 (base)
 *
 * Those last two are the tell: two different parallels of the same player were
 * showing the IDENTICAL PSA 9 price off the narrow pool, and separate once the
 * union was restored.
 */
import { describe, it, expect } from "vitest";
import { resolveUnionSlug } from "../src/services/compiq/observedGradeCurve.service.js";

const SLUG = "hiq:baseball:2025:bowman-draft:cpa-mwi:refractor:auto";
const VENDOR = "1769288207053x553618194969604160";

describe("resolveUnionSlug — which slug the unified overlay unions against", () => {
  it("keeps the caller's slug when the id has been resolved to a vendor cardId", () => {
    // The regression case: portfolioStore hands us the vendor id it resolved to,
    // plus the slug it started from. Losing the slug here is the whole bug.
    expect(resolveUnionSlug(VENDOR, SLUG)).toBe(SLUG);
  });

  it("falls back to cardId when that IS the slug", () => {
    // Route callers only ever hold one id.
    expect(resolveUnionSlug(SLUG, null)).toBe(SLUG);
    expect(resolveUnionSlug(SLUG, undefined)).toBe(SLUG);
  });

  it("returns null when there is no slug anywhere", () => {
    // Nothing to widen with. Must not invent a union.
    expect(resolveUnionSlug(VENDOR, null)).toBeNull();
  });

  it("refuses a vendor id passed as the caller slug", () => {
    // Unioning an id against itself widens nothing and reads as if it did.
    expect(resolveUnionSlug(VENDOR, VENDOR)).toBeNull();
  });

  it("prefers the caller's slug over the cardId when both are slugs", () => {
    const other = "hiq:baseball:2025:bowman-draft:cpa-mwi:base:auto";
    expect(resolveUnionSlug(other, SLUG)).toBe(SLUG);
  });

  it("tolerates whitespace and empty strings without producing a bogus union", () => {
    expect(resolveUnionSlug(VENDOR, "   ")).toBeNull();
    expect(resolveUnionSlug(VENDOR, "")).toBeNull();
    expect(resolveUnionSlug(VENDOR, `  ${SLUG}  `)).toBe(SLUG);
  });
});
