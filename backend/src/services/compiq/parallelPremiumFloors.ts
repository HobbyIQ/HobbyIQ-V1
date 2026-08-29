/**
 * Print-run inference by PARALLEL NAME — the hobby-convention map from a
 * parallel's name to its print run ("Orange" -> /25, "Gold" -> /50, ...).
 *
 * D4 PR 5 (2026-08-29): this file used to be CF-PARALLEL-PREMIUM-FLOOR — it
 * also held PRINT_RUN_TO_FLOOR, a hobby-consensus table of MINIMUM
 * multipliers by print-run tier (1/1 = 100x, /5 = 40x, /10 = 30x, /25 = 15x,
 * /35 = 12x, /50 = 8x, /75 = 5x, /100 = 4x, /150 = 3x, /250 = 2x, /299 =
 * 1.8x, /500 = 1.5x; x1.8 for non-autos), and applyPrintRunFloor lifted the
 * measured premium to that floor. That is the "8.00x parallel (floor lifted
 * from 1.00x)" behind the $1,109 Marconi German estimate: no measurement, a
 * table said 8x. The table and every function that read it are deleted.
 * Multipliers come from measurements only (empiricalParallelPremium.ts); a
 * parallel with no measurement gets no price.
 *
 * What remains is a print-run GUESS by name. It is not a multiplier and it
 * is not a price. Consumers: observedGradeCurve (is this parallel rare
 * enough to try the sibling rescue?) and compiqEstimate's year-first
 * print-run inference, as the last fallback behind the reference catalog
 * and the year-aware Bowman dataset.
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
  // CF-BOWMAN-LOGOFRACTOR (2026-07-08, Drew): /35 print run.
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
 * Infer the print run for a parallel by name. Returns null when the
 * name matches no known parallel. A guess about scarcity, never a
 * multiplier.
 */
export function inferPrintRun(parallelName: string): number | null {
  if (!parallelName || typeof parallelName !== "string") return null;
  const norm = parallelName.trim().toLowerCase();
  for (const rule of PARALLEL_TO_PRINT_RUN) {
    if (rule.match(norm)) return rule.printRun;
  }
  return null;
}
