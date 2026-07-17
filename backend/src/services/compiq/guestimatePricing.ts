// CF-GUESTIMATE-PRICING (Drew, 2026-07-17). Pure math for pricing
// cards that have NO direct comps AND no family-blend coverage —
// compound multiplier estimation from a family baseline.
//
// Formula:
//   guestimate = familyBaseRawPrice
//              × playerTierMultiplier
//              × parallelMultiplier
//              × autoPremium         (only when isAuto)
//              × printRunMultiplier
//              × gradeMultiplier
//              × eraDecay            (0.7×–1.2× based on age in years)
//
// Each factor missing = 1.0, so a caller only pays the multipliers it
// actually knows. Confidence tier is derived from HOP COUNT — a
// two-factor estimate is "rough", a five-factor estimate is "ballpark".
//
// Attribution chain is returned as a string list so iOS can render
// "how we got here" transparently: seller sees this is a compound
// estimate, not a firm number.

import { GRADE_MULTIPLIERS, PARALLEL_MULTIPLIERS, AUTO_PREMIUM_BY_TIER, printRunMultiplier } from "./neighborMultipliers.js";

export type PlayerTier = "superstar" | "star" | "prospect" | "common" | "unknown";

export interface GuestimateInputs {
  /** Median Raw price for the base variant of the family. Required. */
  familyBaseRawPrice: number;
  /** Family label for attribution (e.g. "2026 Bowman Chrome Baseball"). */
  familyLabel: string;
  /** Player tier from observed median. "unknown" if no data. */
  playerTier: PlayerTier;
  /** Parallel name as it appears on the card (e.g. "Orange Shimmer Refractor"). */
  parallel: string | null;
  /** Grade tier (e.g. "PSA 10", "Raw"). Defaults to "Raw" when null. */
  gradeTier: string | null;
  /** Print run, if numbered (e.g. 25 for /25). Null when unnumbered. */
  printRun: number | null;
  /** Whether the card is an autograph. Compounds AUTO_PREMIUM_BY_TIER. */
  isAuto: boolean;
  /** Years since release. Used for era decay (>=3y → 0.7×, <1y → 1.2×). */
  ageYears: number | null;
}

export type GuestimateConfidence = "ballpark" | "rough" | "estimate" | "insufficient";

export interface GuestimateResult {
  price: number;
  rangeLow: number;
  rangeHigh: number;
  confidence: GuestimateConfidence;
  hops: number;
  attribution: string[];
}

/** Parallel-normalize: lowercase + strip common suffixes/prefixes so a
 *  vendor-supplied "Orange Shimmer Refractor" and "orange shimmer" both
 *  find the same table row. Also handles "Refractor" as base=1.0 (it's
 *  the vanilla Refractor, not a colored parallel). */
function parallelLookupKey(parallel: string): number {
  const p = parallel.toLowerCase().trim()
    .replace(/\s+refractor$/i, "")   // strip trailing " Refractor"
    .replace(/^refractor$/i, "base") // vanilla Refractor is the base
    .replace(/\s+auto(?:graph)?$/i, "")
    .trim();
  const direct = PARALLEL_MULTIPLIERS[p];
  if (typeof direct === "number") return direct;
  // Fall back to any single-word color hit
  for (const word of p.split(/\s+/)) {
    const hit = PARALLEL_MULTIPLIERS[word];
    if (typeof hit === "number") return hit;
  }
  return 1.0;
}

const PLAYER_TIER_MULTIPLIER: Record<PlayerTier, number> = {
  superstar: 8.0,   // matches AUTO_PREMIUM_BY_TIER — ballpark for non-auto too
  star: 3.5,
  prospect: 1.4,
  common: 0.6,
  unknown: 0.8,     // conservative default — better to under-guess a stranger
};

function eraDecay(ageYears: number | null): number {
  if (ageYears === null || ageYears < 0) return 1.0;
  if (ageYears < 1) return 1.2;    // hot-out-of-pack (<1 year post-release)
  if (ageYears < 2) return 1.0;    // steady
  if (ageYears < 4) return 0.85;
  return 0.7;                      // aged out (4+ years)
}

/** Confidence from hop count — each meaningful multiplier is a "hop".
 *  Fewer hops = closer to a real data point = higher confidence.
 *  Real cards regularly hit 6-7 hops (family + player + parallel + auto
 *  + printRun + grade + era) — we accept those with "ballpark" tier
 *  and let iOS render the wider confidence band. */
function scoreConfidence(hops: number): GuestimateConfidence {
  if (hops <= 3) return "estimate";
  if (hops <= 5) return "rough";
  if (hops <= 8) return "ballpark";
  return "insufficient";
}

/** Range band widens with hop count. ±20% at 2 hops → ±60% at 8 hops. */
function bandPct(hops: number): number {
  if (hops <= 2) return 0.20;
  if (hops <= 3) return 0.30;
  if (hops <= 5) return 0.40;
  if (hops <= 7) return 0.50;
  return 0.60;
}

export function computeGuestimate(inp: GuestimateInputs): GuestimateResult | null {
  if (!Number.isFinite(inp.familyBaseRawPrice) || inp.familyBaseRawPrice <= 0) {
    return null;
  }

  const chain: string[] = [];
  let hops = 0;
  let value = inp.familyBaseRawPrice;
  chain.push(`${inp.familyLabel} base Raw median $${round2(value)}`);
  hops++;

  const playerMult = PLAYER_TIER_MULTIPLIER[inp.playerTier];
  if (playerMult !== 1.0) {
    value *= playerMult;
    chain.push(`× ${playerMult}× player tier (${inp.playerTier})`);
    hops++;
  }

  if (inp.parallel && inp.parallel.trim().length > 0) {
    const pm = parallelLookupKey(inp.parallel);
    if (pm !== 1.0) {
      value *= pm;
      chain.push(`× ${pm}× parallel (${inp.parallel})`);
      hops++;
    }
  }

  if (inp.isAuto) {
    const autoMult = AUTO_PREMIUM_BY_TIER[
      inp.playerTier === "unknown" ? "common" : inp.playerTier
    ] ?? 2.0;
    value *= autoMult;
    chain.push(`× ${autoMult}× autograph premium`);
    hops++;
  }

  if (inp.printRun !== null && inp.printRun > 0) {
    const prm = printRunMultiplier(inp.printRun);
    if (prm !== 1.0) {
      value *= prm;
      chain.push(`× ${prm}× print run (/${inp.printRun})`);
      hops++;
    }
  }

  const gradeKey = inp.gradeTier ?? "Raw";
  const gm = GRADE_MULTIPLIERS[gradeKey];
  if (typeof gm === "number") {
    // The GRADE_MULTIPLIERS table is anchored on PSA 10 = 1.0 with Raw = 0.28.
    // We convert to a "vs Raw" multiplier: gm / rawAnchor. So Raw = 1.0 in
    // this frame, PSA 10 = 1/0.28 ≈ 3.57×, PSA 9 = 0.45/0.28 ≈ 1.61×.
    const rawAnchor = GRADE_MULTIPLIERS["Raw"] ?? 0.28;
    const vsRaw = gm / rawAnchor;
    if (Math.abs(vsRaw - 1.0) > 0.01) {
      value *= vsRaw;
      chain.push(`× ${round2(vsRaw)}× grade (${gradeKey})`);
      hops++;
    }
  }

  const ed = eraDecay(inp.ageYears);
  if (ed !== 1.0) {
    value *= ed;
    chain.push(`× ${ed}× era decay (${inp.ageYears?.toFixed(1)}y)`);
    hops++;
  }

  const confidence = scoreConfidence(hops);
  if (confidence === "insufficient") return null;

  const band = bandPct(hops);
  return {
    price: round2(value),
    rangeLow: round2(value * (1 - band)),
    rangeHigh: round2(value * (1 + band)),
    confidence,
    hops,
    attribution: chain,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
