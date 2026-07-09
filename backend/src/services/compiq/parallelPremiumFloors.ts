/**
 * CF-PARALLEL-PREMIUM-FLOOR (2026-07-06, Drew):
 *
 * Hobby-baseline minimum multiplier for known-rare parallels. Applied
 * as a FLOOR against the empirical calibration median in
 * siblingCardPriceFallback.
 *
 * Motivation:
 * The empirical calibration table (parallel-premiums-latest.json)
 * reports a MEDIAN across dozens of players. That median is heavily
 * skewed downward by cool-player Orange autos that trade at 2-3× base
 * — even though hot prospects' Orange autos routinely trade at
 * 20-40× base. The median is closer to the cool-player floor than
 * the true "well-known parallel" premium.
 *
 * Concrete case: 2025 Bowman Chrome Prospects Orange Auto median
 * premium = 4.364× (from ratioRange [1.59, 54.905], n=30). For Eli
 * Willits (#1 draft pick, hot prospect), 4.364× produces a $327
 * Orange Auto estimate when the real market floor is closer to
 * $1500-$2000. The hobby-consensus "Orange /25 auto = 15-25× base
 * auto" tracks reality much better than the empirical median.
 *
 * Design:
 * Each Bowman/Topps parallel maps to an approximate print run based
 * on hobby convention (Orange = /25, Red = /5, Gold = /50, etc.). We
 * assign a FLOOR multiplier by print run tier. When the empirical
 * calibration comes out BELOW the floor for a matching parallel,
 * use the floor instead.
 *
 * This is deliberately conservative — the floor represents the
 * "average hot prospect" market, not the top of the range. Cool
 * players won't be over-estimated much; hot prospects get a
 * defensible starting point instead of a demonstrably-too-low number.
 *
 * As we accumulate more Willits-class data and the calibration
 * script (#293) refines per-player multipliers, these floors become
 * unnecessary. Not retiring them today — they're the durable
 * "hobby-consensus" backstop.
 */

/**
 * Print-run inference by parallel name (case-insensitive substring
 * match). Covers Bowman + Topps family. Values are the print run tier
 * (or its top-of-range for banded parallels).
 */
const PARALLEL_TO_PRINT_RUN: Array<{
  match: (name: string) => boolean;
  printRun: number;
}> = [
  // ── 1-of-1s ────────────────────────────────────────────────────────
  { match: (n) => n.includes("superfractor"), printRun: 1 },
  { match: (n) => n.includes("printing plate") || n.includes("printing-plate"), printRun: 1 },

  // ═══════════════════════════════════════════════════════════════════
  // Panini Prizm family (NBA / NFL) — CF-PANINI-PRIZM-COVERAGE
  // (2026-07-06). Print runs per Panini's published spec. Some
  // parallels are unnumbered but visibly rarer than base — assigned a
  // print-run proxy for the floor tier.
  //
  // NOTE: These are listed BEFORE the generic Bowman/Topps color rules
  // below so "Gold Prizm" / "Red Prizm" / etc. match the Panini tier
  // instead of the Bowman color-only fallback.
  // ═══════════════════════════════════════════════════════════════════
  { match: (n) => n === "nebula prizm" || n === "nebula",         printRun: 1 },
  { match: (n) => n.includes("black finite") || n === "black prizm", printRun: 1 },
  { match: (n) => n === "gold vinyl" || n.includes("gold vinyl"), printRun: 5 },
  { match: (n) => n === "gold prizm" || (n.startsWith("gold ") && n.includes("prizm")), printRun: 10 },
  { match: (n) => n === "camo prizm" || n === "camo",             printRun: 25 },
  { match: (n) => n === "mojo prizm" || n === "mojo",             printRun: 25 },
  { match: (n) => n === "blue ice"   || n.includes("blue ice"),   printRun: 75 },
  { match: (n) => n === "purple prizm" || (n.startsWith("purple ") && n.includes("prizm")), printRun: 75 },
  { match: (n) => n === "hyper prizm" || n === "hyper",           printRun: 275 },
  { match: (n) => n === "red prizm"  || (n.startsWith("red ") && n.includes("prizm")),  printRun: 299 },
  { match: (n) => n === "silver prizm" || n === "silver",         printRun: 500 },   // unnumbered but scarce; floor tier proxy
  // CF-PANINI-GREEN-DISAMBIG (2026-07-08, Drew batch 3): Panini rule
  // tightened to require "prizm" so bare "green" flows to Bowman's
  // /99 auto rule below. Prior version returned 500 for any lone
  // "green" which collided with Bowman Draft Chrome Green auto /99.
  { match: (n) => n === "green prizm", printRun: 500 },

  // ═══════════════════════════════════════════════════════════════════
  // Bowman / Topps refractor family (baseball). Kept AFTER Panini so
  // "Gold Prizm" doesn't hit the generic "gold" rule.
  // ═══════════════════════════════════════════════════════════════════
  // ── Bowman Draft Chrome retail-exclusive parallels ─────────────────
  // CF-GUM-BALL-BUBBLEGUM (2026-07-08, Drew) — "snackpack" family.
  // "Gum Ball Refractor" is the CH catalog name; users search as
  // "Bubblegum" / "Bubble Gum" / "Snackpack". Same tier as Red /5.
  { match: (n) => n.includes("gum ball") || n.includes("bubblegum") || n.includes("bubble gum") || n.includes("snackpack"), printRun: 5 },
  // CF-RETAIL-SNACKPACK-SIBLINGS (2026-07-08, Drew audit follow-up):
  // Peanuts Refractor and Sunflower Seeds Refractor are the other
  // retail snackpack /5 parallels in the same Bowman Draft Chrome
  // family. Empirical medians support the /5 tier assignment:
  //   Peanuts Refractor 28.57× (n=29, 2025 BDC)
  //   Sunflower Seeds Refractor 23.43× (n=30, 2025 BDC)
  { match: (n) => n.includes("peanuts"), printRun: 5 },
  { match: (n) => n.includes("sunflower seeds") || n.includes("sunflower seed"), printRun: 5 },
  // CF-BOWMAN-LOGOFRACTOR (2026-07-08, Drew): /35 print run. Requires
  // a new /35 tier in PRINT_RUN_TO_FLOOR below.
  { match: (n) => n.includes("logofractor") || n.includes("logo fractor"), printRun: 35 },
  // CF-BLACK-XFRACTOR (2026-07-08, Drew): /10 print run. Fits the
  // existing /10 tier alongside Orange Shimmer.
  //
  // Order matters here — this rule must sit BEFORE the color-only
  // "Blue" / "Green" / etc. generic rules further down so "Black
  // X-Fractor" doesn't get swallowed by a generic Black rule.
  { match: (n) => n.includes("black x-fractor") || n.includes("black xfractor"), printRun: 10 },
  { match: (n) => n === "black" || (n.startsWith("black ") && n.includes("refractor")), printRun: 10 },

  // CF-PADPARADSCHA-SHIMMER-FANIMATION (2026-07-09, Drew — Owen Carey
  // Padparadscha showed parallelMultiplier=1 pre-fix because
  // "padparadscha sapphire" didn't match any print-run rule and fell
  // through to no-floor). Print runs per hobby convention:
  //   Padparadscha Sapphire     /1   (1/1 — Drew correction 2026-07-09)
  //   Bowman Fanimation         /5   (retail-exclusive; matches Red family)
  //   Red Shimmer Refractor     /5
  //   Gold Shimmer Refractor    /50
  //   Green Shimmer Refractor   /99
  //   Blue / Aqua / Sky Blue Shimmer Refractor  /75 (mid-tier Bowman
  //     Chrome shimmer parallels)
  //
  // Order: color-specific Shimmer rules FIRST (so "Red Shimmer" hits /5
  // not the generic /50-ish Shimmer fallback), then bare "Shimmer
  // Refractor" catch-all at /50 (safe middle ground for uncalibrated
  // shimmer variants CH may index).
  { match: (n) => n.includes("padparadscha"), printRun: 1 },
  { match: (n) => n.includes("fanimation"), printRun: 5 },
  { match: (n) => n.includes("red shimmer"), printRun: 5 },
  { match: (n) => n.includes("gold shimmer"), printRun: 50 },
  { match: (n) => n.includes("green shimmer"), printRun: 99 },
  { match: (n) => n.includes("blue shimmer") || n.includes("aqua shimmer") || n.includes("sky blue shimmer"), printRun: 75 },
  { match: (n) => n.includes("shimmer refractor") || n === "shimmer", printRun: 50 },
  // CF-BOWMAN-COLOR-AUTOS-BATCH-3 (2026-07-08, Drew batch 3): Bowman
  // Draft Chrome single-color autograph print runs. These must come
  // BEFORE the generic Bowman color rules below so bare "Green" (auto
  // /99) doesn't get swallowed by "Green Refractor" (/499) matching.
  //
  // Print runs per Drew's hobby knowledge:
  //   Green auto      /99
  //   Purple auto     /250
  //   Mini-Diamond   /100 (retail parallel)
  //   Sparkle        /299 (retail)
  //   Speckle        /299 (retail)
  { match: (n) => n === "green", printRun: 99 },
  { match: (n) => n === "purple", printRun: 250 },
  { match: (n) => n === "mini-diamond" || n === "mini diamond" || n.includes("mini-diamond refractor") || n.includes("mini diamond refractor"), printRun: 100 },
  { match: (n) => n === "sparkle" || n.includes("sparkle refractor"), printRun: 299 },
  { match: (n) => n === "speckle" || n.includes("speckle refractor"), printRun: 299 },
  // ── /5 or less (Red family) ────────────────────────────────────────
  { match: (n) => n === "red" || n.startsWith("red "), printRun: 5 },
  { match: (n) => n.includes("red refractor") || n.includes("red x-fractor"), printRun: 5 },
  // ── /10 ────────────────────────────────────────────────────────────
  // CF-ORANGE-SHIMMER-ORDER (2026-07-09): "orange shimmer" MUST come
  // BEFORE the generic "orange"/"orange " rule below, otherwise it
  // gets swallowed as /25 (the pre-existing ordering bug surfaced by
  // the CF-PADPARADSCHA-SHIMMER-FANIMATION test suite).
  { match: (n) => n.includes("orange shimmer"), printRun: 10 },
  { match: (n) => n.includes("orange refractor") && !n.includes("shimmer"), printRun: 25 },
  { match: (n) => n === "orange" || n.startsWith("orange "), printRun: 25 },
  { match: (n) => n.includes("orange x-fractor"), printRun: 25 },
  // ── /50 ────────────────────────────────────────────────────────────
  { match: (n) => n === "gold" || n.startsWith("gold "), printRun: 50 },
  { match: (n) => n.includes("gold refractor") || n.includes("gold x-fractor"), printRun: 50 },
  // ── /75 ────────────────────────────────────────────────────────────
  { match: (n) => n.includes("aqua"), printRun: 75 },
  { match: (n) => n.includes("purple refractor") || n.includes("purple x-fractor"), printRun: 250 },
  // ── /150 ───────────────────────────────────────────────────────────
  { match: (n) => n === "blue" || n.startsWith("blue "), printRun: 150 },
  { match: (n) => n.includes("blue refractor") || n.includes("blue x-fractor"), printRun: 150 },
  // ── /499 or /500 ───────────────────────────────────────────────────
  { match: (n) => n.includes("green refractor") || n.includes("green x-fractor"), printRun: 499 },
];

/**
 * Print-run tier → minimum premium multiplier against Base Auto.
 * Represents the hobby-consensus floor for an "average hot prospect"
 * — cool players will still be over-estimated by this floor, hot
 * prospects will get a defensible starting point.
 */
const PRINT_RUN_TO_FLOOR: Array<{ maxPrintRun: number; floor: number }> = [
  { maxPrintRun: 1,   floor: 100 },  // 1/1s
  { maxPrintRun: 5,   floor: 40  },  // Red /5
  { maxPrintRun: 10,  floor: 30  },  // Orange Shimmer /10, Black X-Fractor /10
  { maxPrintRun: 25,  floor: 15  },  // Orange /25
  // CF-PR-35-TIER (2026-07-08, Drew): Bowman Logofractor sits at /35 —
  // 12× floor is the midpoint between /25 (15×) and /50 (8×).
  { maxPrintRun: 35,  floor: 12  },  // Bowman Logofractor /35
  { maxPrintRun: 50,  floor: 8   },  // Gold /50
  { maxPrintRun: 75,  floor: 5   },  // Aqua /75
  // CF-PR-99-100-TIER (2026-07-08, Drew batch 3): Green /99 (auto),
  // Mini-Diamond /100. Both treated as the same tier — 4× floor
  // (midpoint between /75's 5× and /150's 3×).
  { maxPrintRun: 100, floor: 4   },  // Green auto /99, Mini-Diamond /100
  { maxPrintRun: 150, floor: 3   },  // Blue /150
  { maxPrintRun: 250, floor: 2   },  // Purple /250
  // CF-PR-299-TIER (2026-07-08, Drew batch 3): Sparkle /299, Speckle /299.
  // 1.8× floor sits between /250's 2× and /500's 1.5×.
  { maxPrintRun: 299, floor: 1.8 },  // Sparkle /299, Speckle /299
  { maxPrintRun: 500, floor: 1.5 },  // Green /499
];

/**
 * Infer the print run for a parallel by name. Returns null when the
 * parallel doesn't match any known tier (in which case no floor is
 * applied — the empirical calibration stands).
 */
export function inferPrintRun(parallelName: string): number | null {
  if (!parallelName || typeof parallelName !== "string") return null;
  const norm = parallelName.trim().toLowerCase();
  for (const rule of PARALLEL_TO_PRINT_RUN) {
    if (rule.match(norm)) return rule.printRun;
  }
  return null;
}

/**
 * Return the floor multiplier for a given print run. Returns null
 * when the print run doesn't map to a known tier.
 */
export function floorForPrintRun(printRun: number): number | null {
  if (!Number.isFinite(printRun) || printRun <= 0) return null;
  for (const tier of PRINT_RUN_TO_FLOOR) {
    if (printRun <= tier.maxPrintRun) return tier.floor;
  }
  return null;
}

/**
 * CF-PARALLEL-FLOOR-NON-AUTO-MULTIPLIER (2026-07-09, Drew — Owen Carey
 * Black BCP-69): the PRINT_RUN_TO_FLOOR table is calibrated to AUTO
 * cards, where the base auto ($50-100 range for a fringe prospect) ×
 * /10 floor 30× → $1,500-3,000 hits hobby-consensus. Applied verbatim
 * to non-auto base cards ($1-3 range) the same 30× floor yields $30-90
 * — well below hobby reality for rare non-auto parallels. Empirical
 * checks: non-auto Black /10, Red /5, Superfractor /1 all price ~1.8×
 * higher than the auto-calibrated floor implies.
 *
 * Applies a class-aware bump (currently a flat 1.8× on the auto floor
 * for non-auto callers). Tuned to Drew's calibration point that Owen
 * Carey non-auto Black /10 should project ~$100 vs the $55 the auto
 * floor produces on his $1.85 base median. Extract to per-tier values
 * once we accumulate more empirical anchors.
 *
 * `cardClass` defaults to "auto" for backward compatibility — every
 * existing caller of `floorForPrintRun` (mechanism1, sibling rescue)
 * was implicitly assuming auto anyway.
 */
const NON_AUTO_FLOOR_MULTIPLIER = 1.8;

export function floorForPrintRunByClass(
  printRun: number,
  cardClass: "auto" | "base",
): number | null {
  const base = floorForPrintRun(printRun);
  if (base === null) return null;
  return cardClass === "base"
    ? Math.round(base * NON_AUTO_FLOOR_MULTIPLIER * 100) / 100
    : base;
}

/**
 * Compute the effective multiplier = max(empiricalCalibration, floor).
 * Returns the empirical value unchanged when the parallel doesn't
 * match a known-rare tier OR the empirical value already exceeds
 * the floor. When the floor lifts the value, telemetry captures the
 * substitution so ops can KQL how often the calibration is being
 * overridden.
 */
export function applyPrintRunFloor(
  empiricalMultiplier: number,
  parallelName: string,
): { effective: number; flooredFrom: number | null; inferredPrintRun: number | null } {
  const printRun = inferPrintRun(parallelName);
  if (printRun === null) {
    return { effective: empiricalMultiplier, flooredFrom: null, inferredPrintRun: null };
  }
  const floor = floorForPrintRun(printRun);
  if (floor === null || empiricalMultiplier >= floor) {
    return { effective: empiricalMultiplier, flooredFrom: null, inferredPrintRun: printRun };
  }
  return {
    effective: floor,
    flooredFrom: empiricalMultiplier,
    inferredPrintRun: printRun,
  };
}
