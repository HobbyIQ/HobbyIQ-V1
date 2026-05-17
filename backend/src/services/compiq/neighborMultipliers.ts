// ---------------------------------------------------------------------------
// neighborMultipliers.ts
//
// Phase-1 hardcoded multiplier tables used by the Neighbor-Comp Synthesis
// Engine. These convert a neighbor sale (e.g., the base Refractor) into a
// synthetic estimate for an adjacent variant (e.g., Blue /150 Auto) when no
// direct comp exists.
//
// All multipliers are RELATIVE to a "base raw non-auto" reference = 1.0.
// When synthesizing, the engine computes:
//
//     syntheticPrice = neighborPrice
//                    * (targetMultiplierProduct / neighborMultiplierProduct)
//
// Phase-2 will recalibrate these from Cosmos `comp_logs` once 30 days of
// paired sales have accumulated.
// ---------------------------------------------------------------------------

// ── Grade multipliers ──────────────────────────────────────────────────────
// Anchored on a raw card = 0.28 so PSA 10 -> Raw ≈ 3.6× spread, matching the
// rough modern hobby norm. Adjusted slightly for BGS/SGC variants.
export const GRADE_MULTIPLIERS: Record<string, number> = {
  "PSA 10": 1.0,
  "BGS 10": 1.4,
  "BGS 9.5": 0.92,
  "SGC 10": 0.85,
  "PSA 9": 0.45,
  "BGS 9": 0.4,
  "SGC 9.5": 0.55,
  "SGC 9": 0.4,
  "PSA 8": 0.22,
  "Raw": 0.28,
  "Ungraded": 0.28,
};

// ── Parallel multipliers (relative to "base / refractor base") ────────────
// Lower-case key for lookup. Unknown parallels return null -> caller rejects.
export const PARALLEL_MULTIPLIERS: Record<string, number> = {
  base: 1.0,
  refractor: 1.5,
  "x-fractor": 2.2,
  prism: 1.8,
  mojo: 2.4,
  "sky blue": 2.8,
  blue: 3.5,
  "blue wave": 4.0,
  green: 5.5,
  "neon green": 6.5,
  purple: 4.5,
  pink: 5.0,
  red: 7.5,
  orange: 8.0,
  gold: 9.0,
  "gold wave": 11.0,
  black: 14.0,
  "black wave": 17.0,
  printing: 18.0,
  "printing plate": 18.0,
  superfractor: 28.0,
  "1/1": 25.0,
  atomic: 3.2,
  "x-fractor refractor": 2.0,
  speckle: 3.5,
  shimmer: 8.5,
  // ── normalizeParallel() canonical synonym keys ──────────────────────────
  // The CompIQ normalization layer collapses some human labels to snake_case
  // canonical keys (e.g. "Blue Wave" → "raywave_blue") before passing them
  // through the pricing pipeline. Map those canonical keys to the same
  // multipliers as the human labels so the pricing target
  // doesn't end up "unclassifiable" purely because of the rename.
  raywave_blue: 4.0,
  prism_silver: 1.5,
};

// ── Auto premium scaled by player tier ────────────────────────────────────
// Multiplicative on top of base/parallel. If we can't classify the player
// we default to "common" so we don't over-extrapolate.
export const AUTO_PREMIUM_BY_TIER: Record<string, number> = {
  superstar: 8.0, // Ohtani, Trout, Judge
  star: 5.0,      // perennial all-star
  prospect: 3.5,  // hyped MiLB
  common: 2.0,
};

// ── Print-run multipliers (relative to non-numbered) ──────────────────────
// Used when target has /N but neighbor doesn't, or vice-versa. Values come
// from the existing per-card weighting table in copilot-instructions.
export function printRunMultiplier(run: number | null): number {
  if (run == null || run <= 0) return 1.0;
  if (run <= 5) return 6.0;
  if (run <= 10) return 4.5;
  if (run <= 25) return 3.2;
  if (run <= 50) return 2.4;
  if (run <= 99) return 2.0;
  if (run <= 150) return 1.65;
  if (run <= 250) return 1.35;
  if (run <= 499) return 1.18;
  if (run <= 999) return 1.08;
  return 1.0;
}

// ── Year-delta decay (for ±1 year neighbors of same set/player) ──────────
// Modern releases hold value better than vintage in this engine's window.
// Use a flat 0.85 per year of distance; cap distance at ±2.
export function yearDeltaMultiplier(neighborYear: number | null, targetYear: number | null): number {
  if (!neighborYear || !targetYear) return 1.0;
  const delta = Math.abs(neighborYear - targetYear);
  if (delta === 0) return 1.0;
  if (delta === 1) return 0.92;
  if (delta === 2) return 0.78;
  return 0.6;
}

// ── Helper: normalize grade string for lookup ─────────────────────────────
export function gradeKey(gradingCompany: string | null, grade: string | null): string {
  if (!grade) return "Raw";
  const g = String(grade).trim();
  if (/^raw$|^ungraded$/i.test(g)) return "Raw";
  const company = (gradingCompany || "PSA").toUpperCase();
  // Normalize "10" / "9.5" / "9" with implied company.
  const numeric = g.match(/^(10|9\.5|9|8(\.5)?)$/)?.[1];
  if (numeric) return `${company} ${numeric}`;
  return g;
}

// ── Helper: normalize parallel string for lookup ──────────────────────────
export function parallelKey(parallel: string | null): string {
  if (!parallel) return "base";
  return parallel.toLowerCase().trim();
}

// ── Helper: resolve a multiplier OR null when unknown ─────────────────────
export function lookupGradeMultiplier(key: string): number | null {
  return GRADE_MULTIPLIERS[key] ?? null;
}

export function lookupParallelMultiplier(key: string): number | null {
  if (!key) return PARALLEL_MULTIPLIERS.base ?? null;
  const norm = key.toLowerCase().trim();

  // 1. Exact match (handles "refractor", "superfractor", "x-fractor refractor", "1/1", etc.)
  if (PARALLEL_MULTIPLIERS[norm] != null) return PARALLEL_MULTIPLIERS[norm];

  // 2. Strip trailing "refractor" — most colored Bowman/Topps Chrome parallels
  //    are listed as "Blue Refractor", "Blue Wave Refractor", "Orange Refractor",
  //    etc., but the multiplier table is keyed on the color descriptor only.
  const tokens = norm.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens[tokens.length - 1] === "refractor") {
    const stripped = tokens.slice(0, -1).join(" ");
    if (PARALLEL_MULTIPLIERS[stripped] != null) return PARALLEL_MULTIPLIERS[stripped];
    // 3. Try longest-prefix match (e.g. "blue wave" wins over "blue").
    for (let i = tokens.length - 1; i >= 1; i--) {
      const candidate = tokens.slice(0, i).join(" ");
      if (PARALLEL_MULTIPLIERS[candidate] != null) return PARALLEL_MULTIPLIERS[candidate];
    }
  }

  // 4. Last-resort: any single token matches the table.
  for (const tok of tokens) {
    if (PARALLEL_MULTIPLIERS[tok] != null) return PARALLEL_MULTIPLIERS[tok];
  }
  return null;
}

export function lookupAutoPremium(tier: string | null): number {
  if (!tier) return AUTO_PREMIUM_BY_TIER.common;
  return AUTO_PREMIUM_BY_TIER[tier.toLowerCase()] ?? AUTO_PREMIUM_BY_TIER.common;
}
