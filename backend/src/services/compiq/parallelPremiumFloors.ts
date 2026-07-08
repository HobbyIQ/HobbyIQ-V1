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
  // ── /5 or less (Red family) ────────────────────────────────────────
  { match: (n) => n === "red" || n.startsWith("red "), printRun: 5 },
  { match: (n) => n.includes("red refractor") || n.includes("red x-fractor"), printRun: 5 },
  // ── /10 ────────────────────────────────────────────────────────────
  { match: (n) => n.includes("orange refractor") && !n.includes("shimmer"), printRun: 25 },
  { match: (n) => n === "orange" || n.startsWith("orange "), printRun: 25 },
  { match: (n) => n.includes("orange x-fractor"), printRun: 25 },
  { match: (n) => n.includes("orange shimmer"), printRun: 10 },
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
  { maxPrintRun: 10,  floor: 30  },  // Orange Shimmer /10
  { maxPrintRun: 25,  floor: 15  },  // Orange /25
  { maxPrintRun: 50,  floor: 8   },  // Gold /50
  { maxPrintRun: 75,  floor: 5   },  // Aqua /75
  { maxPrintRun: 150, floor: 3   },  // Blue /150
  { maxPrintRun: 250, floor: 2   },  // Purple /250
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
