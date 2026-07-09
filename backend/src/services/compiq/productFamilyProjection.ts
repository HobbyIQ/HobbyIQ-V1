// CF-PRODUCT-FAMILY-PROJECTION (2026-07-09, Drew — Owen Carey 2026 Bowman
// Black Sapphire). When CH's catalog is missing an entire product line
// (e.g. 2026 Bowman Sapphire) but we CAN find comps for the equivalent
// parent product (Bowman Chrome Prospects for the same player + year +
// number), we still owe the user a defensible number rather than a
// silent catalog-miss.
//
// Approach — pure math:
//   1. Detect the "child" product family in the parsed query (Sapphire
//      is the launch case; more families extensible in the same table).
//   2. Rewrite the product string to point at the equivalent parent
//      product (Sapphire → Chrome Prospects).
//   3. Downstream re-runs findCompsRouted / fetchCompsByPlayer with the
//      rewritten product. When those return comps, the pricing helper
//      applies familyMultiplier × existing parallel floor multipliers.
//
// Attribution: results MUST be tagged with the projection source so iOS
// renders an honest "Estimated — CH catalog gap on 2026 Bowman Sapphire"
// caption rather than pretending we observed the price directly.

export interface ProductFamilyProjection {
  /** The family name we detected on the input product string. */
  familyName: string;
  /**
   * Rewritten product string used to find comps for the parent product.
   * Example: "2026 Bowman Sapphire" → "2026 Bowman Chrome Prospects".
   */
  parentProduct: string;
  /**
   * Price multiplier from parent-product base to child-product base. E.g.
   * Sapphire base sells for ~2.5× Chrome base on the same SKU (hobby
   * consensus; empirically 2-3× for recent releases). Applied AFTER the
   * usual parallel floor multiplier to keep the two math paths cleanly
   * separated.
   */
  familyMultiplier: number;
  /** Short human-readable attribution — surfaces on the iOS card panel. */
  attribution: string;
  /**
   * CF-FAMILY-VIA-PARALLEL (2026-07-09): the parallel string with the
   * family marker stripped, so downstream `inferPrintRun` gets a clean
   * parallel to score. Example: parallel input "Black Sapphire" →
   * effectiveParallel "Black" (which maps to /10 via existing rules).
   * Null when the input parallel didn't carry the family marker (the
   * family was detected via the product string alone) — in that case
   * the caller uses the input parallel unchanged.
   */
  effectiveParallel: string | null;
}

interface FamilyRule {
  match: (product: string) => boolean;
  /** Given the input product, produce the equivalent parent-product string. */
  rewrite: (product: string) => string;
  familyName: string;
  multiplier: number;
  attribution: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordered rules. First-match wins so more specific patterns come before
// generic ones. Rewrite functions preserve the input year prefix so
// downstream lookups (catalog search, parallel-premiums keyed by year)
// still align on the same release.
// ─────────────────────────────────────────────────────────────────────────────
const FAMILY_RULES: FamilyRule[] = [
  // Sapphire — the launch case. 2025 Sapphire products (Bowman Sapphire,
  // Bowman Chrome Sapphire, Bowman Draft Sapphire) are all in CH; 2026
  // Sapphire product line is absent from CH's catalog despite having
  // released. Same math applies to older gaps if any surface later.
  {
    familyName: "Sapphire",
    match: (p) => /\bsapphire\b/i.test(p),
    rewrite: (p) => {
      // "2026 Bowman Sapphire" → "2026 Bowman Chrome Prospects"
      // "2026 Bowman Chrome Sapphire" → "2026 Bowman Chrome Prospects"
      // "2025 Bowman Draft Sapphire" → "2025 Bowman Draft Chrome"
      let out = p
        .replace(/\bchrome\s+sapphire\b/i, "Chrome Prospects")
        .replace(/\bdraft\s+sapphire\b/i, "Draft Chrome")
        .replace(/\bbowman\s+sapphire\b/i, "Bowman Chrome Prospects")
        .replace(/\bsapphire\b/i, "Chrome Prospects")
        .replace(/\s+/g, " ")
        .trim();
      // Defensive: if the rewrite didn't add "chrome", tack on
      // "Chrome Prospects" as a suffix. Should only fire for exotic
      // product strings we haven't seen.
      if (!/chrome/i.test(out)) {
        out = `${out} Chrome Prospects`.trim();
      }
      return out;
    },
    // 2.5× Chrome base — midpoint of hobby-observed 2-3× band for recent
    // Sapphire releases. Tune once we accumulate empirical Sapphire/Chrome
    // ratio data via the projection telemetry event below.
    multiplier: 2.5,
    attribution:
      "Estimated — CH catalog gap on Sapphire product line; projected from Chrome equivalent × 2.5",
  },
];

/**
 * Detect whether the parsed query maps to a known product-family gap.
 *
 * CF-FAMILY-VIA-PARALLEL (2026-07-09, Drew — Owen Carey Black Sapphire):
 * the query parser routes bare "Sapphire" to the parallel field, not the
 * product field, so the initial ship of this function (product-only) never
 * fired on "2026 bowman owen carey black sapphire". Accepts both signals
 * and unions them: match the product first (more specific), fall back to
 * the parallel. When the family marker lives on the parallel, strip it
 * so downstream inferPrintRun scores the clean parallel token (e.g.
 * "Black Sapphire" → effectiveParallel="Black" → /10 floor).
 *
 * Returns null when no family rewrite applies (caller falls through to
 * its normal catalog-miss handling).
 */
export function detectProductFamily(
  product: string | null | undefined,
  parallel?: string | null | undefined,
): ProductFamilyProjection | null {
  const productStr =
    typeof product === "string" ? product.trim() : "";
  const parallelStr =
    typeof parallel === "string" ? parallel.trim() : "";

  // Prefer the product field — it's the more specific signal when both
  // exist (e.g. product="2026 Bowman Sapphire" AND parallel="Black").
  if (productStr) {
    for (const rule of FAMILY_RULES) {
      if (rule.match(productStr)) {
        const parentProduct = rule.rewrite(productStr);
        if (parentProduct.toLowerCase() === productStr.toLowerCase()) continue;
        return {
          familyName: rule.familyName,
          parentProduct,
          familyMultiplier: rule.multiplier,
          attribution: rule.attribution,
          effectiveParallel: null, // parallel unchanged
        };
      }
    }
  }

  // Fall back to the parallel field — the "Black Sapphire" case where the
  // parser routed "Sapphire" to parallel and left the product neutral.
  if (parallelStr) {
    for (const rule of FAMILY_RULES) {
      if (rule.match(parallelStr)) {
        // Rewrite as if the parallel WERE the product string. This
        // reuses the rule's rewrite table for consistent parent-product
        // resolution — "Black Sapphire" → "Black Chrome Prospects".
        // We only care about the parent product; the caller falls back
        // to a default like "Bowman Chrome Prospects" when the product
        // string is bare.
        const parentProduct =
          productStr && !rule.match(productStr)
            ? productStr.replace(/^\s*(19|20)\d{2}\s+/, "").trim() ||
              "Chrome Prospects"
            : rule.rewrite(parallelStr);
        // Strip the family marker from the parallel so the caller's
        // print-run inference scores the remaining tokens ("Black"
        // instead of "Black Sapphire").
        const effectiveParallel = parallelStr
          .replace(/\bsapphire\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();
        return {
          familyName: rule.familyName,
          parentProduct: parentProduct || "Chrome Prospects",
          familyMultiplier: rule.multiplier,
          attribution: rule.attribution,
          effectiveParallel: effectiveParallel || null,
        };
      }
    }
  }

  return null;
}
