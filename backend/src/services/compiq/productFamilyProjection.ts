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
 * Detect whether the parsed product string maps to a known family gap.
 * Returns null when no family rewrite applies (in which case the caller
 * should fall through to its normal catalog-miss handling).
 */
export function detectProductFamily(
  product: string | null | undefined,
): ProductFamilyProjection | null {
  if (!product || typeof product !== "string") return null;
  const trimmed = product.trim();
  if (!trimmed) return null;
  for (const rule of FAMILY_RULES) {
    if (rule.match(trimmed)) {
      const parentProduct = rule.rewrite(trimmed);
      // Guard: reject rewrites that failed to actually change the product.
      // Without this, an infinite-loop retry could happen if the same
      // string kept matching the same rule.
      if (parentProduct.toLowerCase() === trimmed.toLowerCase()) continue;
      return {
        familyName: rule.familyName,
        parentProduct,
        familyMultiplier: rule.multiplier,
        attribution: rule.attribution,
      };
    }
  }
  return null;
}
