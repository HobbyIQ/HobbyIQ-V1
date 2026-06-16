// CF-FITTED-LADDER (2026-06-16) — empirical parallel-premium curve +
// finish-modifier table + per-bucket PSA 10 grade ratios.
//
// Replaces the chrome-draft heuristic multiplier table + Phase-2 power-
// law patch + high-tier (mult ≥ 14) auto-revert in the composed branch
// of gradedPriceProjection. Empirical basis: 521 (card, parallel)
// buckets across 196 BCPA 2022-2025 cards. Refractor-only fit
// R² = 0.821. See CF-LADDER-FIT in docs/SESSION_HANDOFF.md.

// ─── f(serial) — rarity baseline (Refractor finish) ────────────────────

/** Power-law rarity baseline: ratio = a · serial^(-b). */
export const FITTED_RARITY_A = 17.059;
export const FITTED_RARITY_B = 0.301;

/** Compute the rarity factor for a print run. */
function rarityFactor(serial: number): number {
  return FITTED_RARITY_A * Math.pow(serial, -FITTED_RARITY_B);
}

// ─── g(finish) — finish modifier ───────────────────────────────────────

/**
 * Finish premium modifier — multiplicative on f(serial). Refractor is
 * the 1.00× baseline. Only finishes with n ≥ 10 pooled fit points get a
 * registered modifier; thin-data finishes (wave n=3, reptilian n=2) and
 * any unmeasured finish default to refractor baseline (1.00×) with a
 * low-confidence flag so the bound widens to "ballpark".
 */
const FINISH_MODIFIERS: Readonly<Record<string, number>> = Object.freeze({
  refractor:      1.00,
  "mini-diamond": 1.23,
  lava:           0.93,
  shimmer:        0.91,
  speckle:        0.84,
  raywave:        0.79,
  atomic:         0.78,
  choice:         0.66,
  // Floored to 1.00 (refractor baseline) due to n < 10 — keep finish
  // detection working but treat the prediction as low-confidence:
  //   wave (n=3, all Orange Wave /25 — doesn't generalize)
  //   reptilian (n=2, single-card-likely artifact)
});

/**
 * (finish × serial) cells empirically observed in the fit corpus.
 * Applying g(finish) is high-confidence ONLY when the cell was measured;
 * cross-tier extrapolation (e.g., applying raywave's g=0.79 at /150 to
 * /5 where we have zero raywave data) is flagged low-confidence.
 */
const OBSERVED_FINISH_SERIAL_CELLS: ReadonlySet<string> = new Set([
  "refractor|499", "refractor|299", "refractor|250", "refractor|150",
  "refractor|99",  "refractor|75",  "refractor|50",  "refractor|25",
  "refractor|10",  "refractor|5",
  "mini-diamond|100", "mini-diamond|50",
  "lava|99",
  "shimmer|50", "shimmer|25",
  "speckle|299",
  "raywave|150",
  "atomic|100", "atomic|99",
  "choice|150",
  "wave|25",         // thin: floored to 1.00 but cell is observed
  "reptilian|150",   // thin: floored to 1.00 but cell is observed
]);

// ─── Parallel-finish parser ────────────────────────────────────────────

/**
 * Vocab regexes in most-specific-first order (longer/compound tokens
 * before their substrings). Matches the parser from CF-LADDER-FIT.
 */
const FINISH_PATTERNS: ReadonlyArray<{ finish: string; re: RegExp }> = [
  { finish: "superfractor",  re: /super[\s-]?fractor/i },
  { finish: "x-fractor",     re: /\bx[\s-]?fractor\b/i },
  { finish: "mini-diamond",  re: /mini[\s-]?diamond/i },
  { finish: "raywave",       re: /ray[\s-]?wave/i },
  { finish: "reptilian",     re: /reptilian/i },
  { finish: "padparadscha",  re: /padparadscha/i },
  { finish: "shimmer",       re: /\bshimmer\b/i },
  { finish: "lava",          re: /\blava\b/i },
  { finish: "wave",          re: /\bwave\b/i },
  { finish: "atomic",        re: /\batomic\b/i },
  { finish: "mojo",          re: /\bmojo\b/i },
  { finish: "speckle",       re: /\bspeckle\b/i },
  { finish: "sapphire",      re: /\bsapphire\b/i },
  { finish: "pulsar",        re: /\bpulsar\b/i },
  { finish: "choice",        re: /\bchoice\b/i },
];

/**
 * Parse the finish family from a Cardsight catalog parallel name.
 * "Refractor" (singular or plural) → "refractor"; any other vocab token
 * wins via the most-specific-first pattern order. Returns null when no
 * recognized finish token appears at all.
 */
export function parseFinishFromParallelName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  for (const fp of FINISH_PATTERNS) {
    if (fp.re.test(name)) return fp.finish;
  }
  if (/\brefractors?\b/i.test(name)) return "refractor";
  return null;
}

// ─── Composed multiplier ───────────────────────────────────────────────

export interface FittedComposedResult {
  /** Composed multiplier: base_raw × this = predicted parallel raw. */
  multiplier: number;
  /** Parsed finish family ("refractor" / "wave" / "shimmer" / …). */
  finish: string;
  /** Print run (numberedTo) used. */
  serial: number;
  /** f(serial) factor. */
  rarityFactor: number;
  /** g(finish) modifier actually applied. */
  finishModifier: number;
  /**
   * Low-confidence flag — true when ANY of:
   *   • serial ≤ 50 (top tier; pool can't model player-desirability premium)
   *   • (finish × serial) cell unobserved in the fit corpus
   *   • finish has no fitted modifier (defaulted to refractor baseline)
   * Caller maps to "ballpark" confidence tier + wide spread.
   */
  lowConfidence: boolean;
  /** Human-readable basis prose. */
  basis: string;
}

/**
 * Compute the fitted composed multiplier for a parallel target.
 * Returns null when the parallel name is missing or serial is unknown /
 * non-positive — caller falls through to other anchor paths or no-data.
 */
export function computeFittedComposedMultiplier(
  parallelName: string | null | undefined,
  numberedTo: number | null | undefined,
): FittedComposedResult | null {
  if (!parallelName) return null;
  if (numberedTo == null || !Number.isFinite(numberedTo) || numberedTo <= 0) return null;
  const serial = Math.round(numberedTo);
  const finish = parseFinishFromParallelName(parallelName) ?? "refractor";
  const rf = rarityFactor(serial);
  const knownModifier = FINISH_MODIFIERS[finish];
  const finishModifier = knownModifier ?? 1.00;
  const multiplier = rf * finishModifier;

  const isTopTier = serial <= 50;
  const cellObserved = OBSERVED_FINISH_SERIAL_CELLS.has(`${finish}|${serial}`);
  const unknownModifier = knownModifier == null;
  const lowConfidence = isTopTier || !cellObserved || unknownModifier;

  const reasons: string[] = [];
  if (isTopTier) reasons.push("serial ≤ 50 (top-tier residual)");
  if (!cellObserved && !isTopTier) reasons.push(`(${finish}, /${serial}) cell unobserved in fit corpus`);
  if (unknownModifier) reasons.push(`finish "${finish}" has no fitted modifier (defaulted to 1.00×)`);
  const lowConfNote = lowConfidence ? ` [low-conf: ${reasons.join("; ")}]` : "";
  const basis = `fitted parallel premium ${multiplier.toFixed(2)}× = f(/${serial}) ${rf.toFixed(2)}× × g(${finish}) ${finishModifier.toFixed(2)}×${lowConfNote}`;

  return { multiplier, finish, serial, rarityFactor: rf, finishModifier, lowConfidence, basis };
}

// ─── Per-bucket PSA 10 grade ratios ────────────────────────────────────

/**
 * PSA 10 / raw grade ratio per parallel-value bucket, pooled from CF-
 * LADDER-FIT Step 3 across the BCPA 2022-2025 corpus:
 *   base-and-/499 (serial ≥ 250): 1.74×  (n = 10 bucket samples)
 *   /150-/199    (serial 100-249): 2.66× (n = 2)
 *   /50-/99      (serial 25-99):   2.63× (n = 3)
 *   /5-/25       (serial 1-24):    2.63× — NO DATA in corpus; uses
 *                                  /50-/99 value as best-available proxy
 *                                  + low-confidence flag.
 *
 * PSA 9 and below are NOT swapped here: the pool shows base PSA 9 / raw
 * < 1.0× (0.58×, implausible since PSA 9 cannot trade below raw on
 * average), indicating the pool is too noisy for hardcoded ratios. Keep
 * the existing resolveRatio (tier-1 → player-set → release → market)
 * for non-PSA-10 grades. Flagged for a later calibration CF.
 */
export interface Psa10BucketRatio {
  ratio: number;
  bucket: string;
  lowConfidence: boolean;
}

const PSA10_BUCKETS: ReadonlyArray<{ name: string; lo: number; hi: number; ratio: number; lowConf: boolean }> = [
  { name: "base-and-/499", lo: 250, hi: 99999, ratio: 1.74, lowConf: false },
  { name: "/150-/199",     lo: 100, hi: 249,   ratio: 2.66, lowConf: false },
  { name: "/50-/99",       lo: 25,  hi: 99,    ratio: 2.63, lowConf: false },
  { name: "/5-/25",        lo: 1,   hi: 24,    ratio: 2.63, lowConf: true }, // no data in corpus
];

export function getPsa10BucketRatio(
  numberedTo: number | null | undefined,
): Psa10BucketRatio | null {
  if (numberedTo == null || !Number.isFinite(numberedTo) || numberedTo <= 0) return null;
  const serial = Math.round(numberedTo);
  for (const b of PSA10_BUCKETS) {
    if (serial >= b.lo && serial <= b.hi) {
      return { ratio: b.ratio, bucket: b.name, lowConfidence: b.lowConf };
    }
  }
  return null;
}

// ─── Per-tier residual bands ──────────────────────────────────────────

/**
 * CF-FITTED-RANGE-BAND-HONESTY (2026-06-17): empirical P10/median +
 * P90/median bands replace the hand-tuned ±25%-ish ladder. Shipped
 * containment of PSA 10 market truth landed at ~45% across the
 * validation cards (Esmerlyn 50%, Profar 29%, Albertus 44%) — the
 * tight band overclaimed precision. Bands now reflect the actual
 * cross-card variance from CF-LADDER-FIT's 521-point corpus.
 *
 * Hierarchy (single source of truth: ladder-fit-records.json residuals):
 *   1. (finish, serial) CELL band when n ≥ 10 AND span ≤ 3× (only 3
 *      cells survive both gates — most cells have one outlier widening
 *      span beyond 3, which is the brief's cap rule: cell > 3 → tier).
 *   2. SERIAL tier band aggregated across all finishes at that serial.
 *      Tier bands themselves can run wide (/50 = 8.58× span; /250 =
 *      2.80×); that's genuine cross-card variance, not noise — honest
 *      representation that the engine is more confident at /250 than /50.
 *   3. Global residual spread when serial unknown.
 *
 * Empirical residual = observed_ratio / fitted_ratio, where fitted =
 * 17.059 × serial^(-0.301) × g(finish). The band's low = P10/P50,
 * high = P90/P50 — fitted central maps to ~1.0× by construction, so
 * the point sits inside by definition.
 */
export interface FittedRangeBand {
  low: number;
  high: number;
}

/**
 * Cells that PASSED the brief's strict cap (n ≥ 10 AND span ≤ 3) — the
 * empirical residual is tight enough to anchor on the finish, not the
 * tier. Everything else falls back to the tier table.
 */
const FITTED_RANGE_CELL_BANDS: Readonly<Record<string, FittedRangeBand>> = Object.freeze({
  "refractor|99":     { low: 0.75, high: 1.52 }, // n=11, span 2.04×
  "mini-diamond|100": { low: 0.69, high: 1.92 }, // n=10, span 2.79×
  "refractor|250":    { low: 0.65, high: 1.82 }, // n=58, span 2.80×
});

/**
 * Per-serial bands aggregated across ALL finishes — the safety net
 * when a (finish, serial) cell is sparse OR widely-spread. Spans can
 * legitimately exceed 3× here; that IS the data. The /50 tier at
 * 8.58× span is the loudest signal that top-tier residuals are real
 * cross-card variance, not artifact.
 *
 * Honest spans by tier (P90/P10):
 *   /5  4.16×  (n=2  thin — fitted band derived from 2-card sample)
 *   /10 2.84×  (n=3  thin)
 *   /25 6.28×  (n=19)
 *   /50 8.58×  (n=51) ← widest tier, top-tier scarcity premium variance
 *   /75 3.87×  (n=17)
 *   /99 3.95×  (n=52)
 *   /100 4.48× (n=20)
 *   /150 4.83× (n=83)
 *   /250 2.80× (n=58) ← tightest mid tier, well-attested
 *   /299 5.07× (n=52)
 *   /499 4.18× (n=164)
 */
const FITTED_RANGE_TIER_BANDS: ReadonlyArray<{ serial: number; low: number; high: number }> = Object.freeze([
  { serial: 5,   low: 0.39, high: 1.61 },
  { serial: 10,  low: 0.64, high: 1.83 },
  { serial: 25,  low: 0.35, high: 2.19 },
  { serial: 50,  low: 0.42, high: 3.60 },
  { serial: 75,  low: 0.66, high: 2.56 },
  { serial: 99,  low: 0.58, high: 2.31 },
  { serial: 100, low: 0.68, high: 3.06 },
  { serial: 150, low: 0.48, high: 2.33 },
  { serial: 199, low: 0.48, high: 2.33 }, // share /150 bucket — same SCP-class
  { serial: 250, low: 0.65, high: 1.82 },
  { serial: 299, low: 0.64, high: 3.26 },
  { serial: 499, low: 0.57, high: 2.40 },
]);

/**
 * Global residual spread (P10/median, P90/median across all 521 fit
 * points). Used when serial is unknown or outside the tier table.
 */
const FITTED_RANGE_GLOBAL: FittedRangeBand = Object.freeze({ low: 0.55, high: 2.59 });

export function getFittedRangeBand(
  numberedTo: number | null | undefined,
  finish?: string | null,
): FittedRangeBand {
  if (numberedTo == null || !Number.isFinite(numberedTo) || numberedTo <= 0) {
    return FITTED_RANGE_GLOBAL;
  }
  const serial = Math.round(numberedTo);

  // 1. Try (finish, serial) cell band — only present for cells that
  //    passed n ≥ 10 AND span ≤ 3× per the brief's cap rule.
  if (finish) {
    const cell = FITTED_RANGE_CELL_BANDS[`${finish}|${serial}`];
    if (cell) return cell;
  }

  // 2. Tier band — exact serial match.
  for (const t of FITTED_RANGE_TIER_BANDS) {
    if (t.serial === serial) return { low: t.low, high: t.high };
  }

  // 3. Tier band — nearest serial (handles cards with off-grid serials
  //    like /35, /175 — pick the closest in-table bucket).
  let nearest = FITTED_RANGE_TIER_BANDS[0]!;
  let nearestDiff = Math.abs(serial - nearest.serial);
  for (const t of FITTED_RANGE_TIER_BANDS) {
    const d = Math.abs(serial - t.serial);
    if (d < nearestDiff) { nearest = t; nearestDiff = d; }
  }
  return { low: nearest.low, high: nearest.high };
}
