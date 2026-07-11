// CF-NO-NULL-PRICING (2026-07-11, Drew — Tier 7 fallback):
// Era-typed set-doc baseline lookup. Fires ONLY when we can identify
// (year, product) but the ladder has no matching ParallelDoc AND the
// higher tiers (parallel-floor / scarcity-prior) also missed.
//
// This is the deepest fallback before returning null. The formula is:
//
//   baseline = setTypeBaseline(setType, era)
//   floor    = baseline × gradeMultiplier(gradeCompany, gradeValue)
//
// Confidence tag: 15 (very low). Range is wide (-70% / +200%) — this
// is a rough era estimate, not a market signal.
//
// ──── Discipline ─────────────────────────────────────────────────────────
//
// The baseline table is HAND-CURATED educated guesses drawn from hobby
// context, not sales data. It'll be wrong for outliers (a Hall-of-Famer
// rookie in a 1990 Fleer set is worth vastly more than the "1988-1994 Base"
// baseline suggests). But it's better than returning null for a card the
// user asked about.
//
// The primary purpose is to KEEP THE PIPELINE FROM RETURNING NULL. iOS
// will render Tier 7 estimates with a strong "verify with comps" caveat.
//
// ──── Rollout ────────────────────────────────────────────────────────────
//
// Env flag COMPIQ_SETDOC_BASELINE_ENABLED (default false). When off, the
// module returns null and the engine falls through to the current
// "unavailable" path. Flag on = engine emits Tier 7 baselines.

// ─── Set-type × era baseline table ────────────────────────────────────────
//
// SetType strings match the reference-catalog SetDoc `setType` field.
// Era buckets align with hobby milestones:
//   1988-1994 — pre-parallel junk-wax era
//   1995-2005 — chromium era begins, print runs shrink
//   2006-2015 — modern parallel proliferation
//   2016-2026 — Panini/Bowman parallel explosion
//
// Values are the typical raw base-card sale price for that (setType, era).
// A PSA 10 grade will multiply this by ~5-15x depending on the tier.

export type Era = "1988-1994" | "1995-2005" | "2006-2015" | "2016-2026";

const SET_TYPE_BASELINES: Record<string, Record<Era, number>> = {
  // Base flagship products (Topps, Fleer, Score, Donruss, Upper Deck base)
  base: {
    "1988-1994": 2,
    "1995-2005": 3,
    "2006-2015": 5,
    "2016-2026": 8,
  },
  // Traded / Update sets — slightly rarer than base
  traded: {
    "1988-1994": 3,
    "1995-2005": 4,
    "2006-2015": 6,
    "2016-2026": 10,
  },
  update: {
    "1988-1994": 3,
    "1995-2005": 4,
    "2006-2015": 6,
    "2016-2026": 10,
  },
  // Premium sets (Fleer Ultra, Upper Deck SP, Stadium Club)
  premium: {
    "1988-1994": 5,
    "1995-2005": 10,
    "2006-2015": 15,
    "2016-2026": 25,
  },
  // Chromium products (Topps Chrome, Bowman Chrome pre-2010)
  chromium: {
    "1988-1994": 10,
    "1995-2005": 20,
    "2006-2015": 30,
    "2016-2026": 45,
  },
  // Premium chromium (Finest, Bowman's Best)
  "premium-chromium": {
    "1988-1994": 15,
    "1995-2005": 30,
    "2006-2015": 50,
    "2016-2026": 75,
  },
  // Ultra premium (Sterling, Definitive, Dynasty, National Treasures, Flawless)
  "ultra-premium": {
    "1988-1994": 50,
    "1995-2005": 100,
    "2006-2015": 150,
    "2016-2026": 250,
  },
  // Retro-styled (Heritage, Archives, Allen & Ginter, Gypsy Queen)
  retro: {
    "1988-1994": 3,
    "1995-2005": 6,
    "2006-2015": 10,
    "2016-2026": 15,
  },
  // Autograph-focused (Bowman Sterling, Playoff Absolute, Leaf Signature)
  autograph: {
    "1988-1994": 30,
    "1995-2005": 75,
    "2006-2015": 125,
    "2016-2026": 200,
  },
  // Metallic (Fleer Metal Universe, Skybox Metal, Leaf Metal)
  metallic: {
    "1988-1994": 8,
    "1995-2005": 15,
    "2006-2015": 25,
    "2016-2026": 40,
  },
  // Draft/Prospects (Bowman Draft Picks, Panini Prizm Draft, Panini Elite Extra)
  draft: {
    "1988-1994": 5,
    "1995-2005": 8,
    "2006-2015": 12,
    "2016-2026": 20,
  },
  // Sapphire chromium (Bowman Chrome Sapphire, Topps Chrome Sapphire)
  "sapphire-chromium": {
    "1988-1994": 15,
    "1995-2005": 30,
    "2006-2015": 60,
    "2016-2026": 100,
  },
  // Insert-heavy / multi-brand (Panini Chronicles, Multi-Brand)
  "multi-brand": {
    "1988-1994": 5,
    "1995-2005": 10,
    "2006-2015": 15,
    "2016-2026": 25,
  },
};

// Default when setType is unrecognized — treat as base
const DEFAULT_SET_TYPE = "base";

// ─── Era classifier ──────────────────────────────────────────────────────

export function eraForYear(year: number): Era | null {
  if (!Number.isFinite(year)) return null;
  if (year < 1988 || year > 2030) return null;
  if (year <= 1994) return "1988-1994";
  if (year <= 2005) return "1995-2005";
  if (year <= 2015) return "2006-2015";
  return "2016-2026";
}

// ─── Set-type normalizer ─────────────────────────────────────────────────
//
// The reference catalog stores freeform setType strings like "Premium",
// "Ultra Premium", "Chromium", etc. Normalize to the table keys.

export function normalizeSetType(raw: string | null | undefined): string {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return DEFAULT_SET_TYPE;
  // Ordered from most-specific to least so "premium chromium" wins over "premium".
  if (s.includes("ultra premium")) return "ultra-premium";
  if (s.includes("premium chromium")) return "premium-chromium";
  if (s.includes("sapphire")) return "sapphire-chromium";
  if (s.includes("chromium")) return "chromium";
  if (s.includes("metallic")) return "metallic";
  if (s.includes("retro") || s.includes("throwback")) return "retro";
  if (s.includes("autograph")) return "autograph";
  if (s.includes("draft") || s.includes("prospect")) return "draft";
  if (s.includes("multi-brand") || s.includes("insert")) return "multi-brand";
  if (s.includes("traded")) return "traded";
  if (s.includes("update")) return "update";
  if (s.includes("premium")) return "premium";
  if (s.includes("base")) return "base";
  return DEFAULT_SET_TYPE;
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface SetDocBaselineResult {
  /** The raw baseline price before grade adjustment. */
  baseline: number;
  /** The era bucket used for the lookup. */
  era: Era;
  /** The normalized setType key used for the lookup. */
  setTypeKey: string;
  /** Wide-range lower + upper bound (baseline × 0.3 / 3.0). */
  range: { low: number; high: number };
}

/**
 * Look up the era-typed baseline for a (setType, year) tuple.
 *
 * Returns null when:
 *   * env flag is off (default)
 *   * inputs are incomplete or out of era range
 *
 * Never throws.
 */
export function lookupSetDocBaseline(
  setType: string | null | undefined,
  year: number | null | undefined,
): SetDocBaselineResult | null {
  if (process.env.COMPIQ_SETDOC_BASELINE_ENABLED !== "true") return null;
  if (!year || !Number.isFinite(year)) return null;
  const era = eraForYear(year);
  if (!era) return null;
  const setTypeKey = normalizeSetType(setType);
  const table = SET_TYPE_BASELINES[setTypeKey] ?? SET_TYPE_BASELINES[DEFAULT_SET_TYPE];
  const baseline = table[era];
  return {
    baseline,
    era,
    setTypeKey,
    range: {
      low: Math.round(baseline * 0.3 * 100) / 100,
      high: Math.round(baseline * 3.0 * 100) / 100,
    },
  };
}

/**
 * Compute the final Tier 7 floor from a baseline + a caller-supplied
 * grade multiplier. The grade multiplier is passed in from the existing
 * engine grade-projection code so we don't duplicate that logic.
 *
 * Returns null when the baseline lookup returns null.
 */
export function applyGradeToSetDocBaseline(
  setType: string | null | undefined,
  year: number | null | undefined,
  gradeMultiplier: number | null | undefined,
): (SetDocBaselineResult & { floor: number; floorRange: { low: number; high: number } }) | null {
  const base = lookupSetDocBaseline(setType, year);
  if (!base) return null;
  const g = typeof gradeMultiplier === "number" && Number.isFinite(gradeMultiplier) && gradeMultiplier > 0
    ? gradeMultiplier
    : 1;
  const floor = Math.round(base.baseline * g * 100) / 100;
  return {
    ...base,
    floor,
    floorRange: {
      low: Math.round(base.range.low * g * 100) / 100,
      high: Math.round(base.range.high * g * 100) / 100,
    },
  };
}
