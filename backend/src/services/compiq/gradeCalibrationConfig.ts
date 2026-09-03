// CF-GRADE-CALIBRATION (Drew, 2026-07-20). Human-maintained code lives
// in this file; auto-generated data (GRADE_CALIBRATION +
// GRADE_CALIBRATION_BY_SPORT) lives in gradeCalibrationData.ts and is
// regenerated weekly by the Grade Calibration Refresh workflow.
//
// This split lets the workflow rewrite data without clobbering the
// classifier / lookup logic below. Consumers should import from this
// module (not the data module directly) so both surfaces travel
// together.
//
// Read at rung 5 of canonicalFmv.service.ts + at the empirical path
// in observedGradeCurve.service.ts. Returns null when the
// (family, grader) pair isn't covered — caller emits
// `grade_multiplier_uncovered` telemetry.

import {
  GRADE_CALIBRATION,
  GRADE_CALIBRATION_BY_SPORT,
  GRADE_MULTIPLIER_BY_VALUE_BAND,
  type GradeCalibrationEntry,
  type GradeCalibrationTierEntry,
  type ValueBandTierEntry,
} from "./gradeCalibrationData.js";

export { GRADE_CALIBRATION, GRADE_CALIBRATION_BY_SPORT, GRADE_MULTIPLIER_BY_VALUE_BAND };
export type { GradeCalibrationEntry, GradeCalibrationTierEntry, ValueBandTierEntry };

// CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22, issue #693). Raw-price
// bucket edges MUST match the calibration script (grade-calibrate.mjs)
// exactly. If the script changes bucket edges, update this in the same
// commit so the lookup keys align.
const VALUE_BAND_EDGES: Array<[number, number, string]> = [
  [0, 25, "Under $25"],
  [25, 50, "$25-49"],
  [50, 100, "$50-99"],
  [100, 250, "$100-249"],
  [250, 500, "$250-499"],
  [500, 1000, "$500-999"],
  [1000, 2500, "$1,000-2,499"],
  [2500, 5000, "$2,500-4,999"],
  [5000, 10000, "$5,000-9,999"],
  [10000, Infinity, "$10,000+"],
];

/** Which Raw-price bucket does a Raw anchor fall into? Returns null
 *  for non-positive / non-finite inputs. */
export function valueBandBucketOf(rawAnchor: number): string | null {
  if (!Number.isFinite(rawAnchor) || rawAnchor <= 0) return null;
  for (const [lo, hi, label] of VALUE_BAND_EDGES) {
    if (rawAnchor >= lo && rawAnchor < hi) return label;
  }
  return null;
}

/** Format a (grader, gradeValue) pair into the tier-key format the
 *  calibration table uses (matches ch_daily_sales.grade values). */
function tierKey(grader: string, gradeValue: number): string {
  return `${grader.toUpperCase()} ${gradeValue}`;
}

/** Which layer of the value-band ladder produced the multiplier. */
export type ValueBandResolveScope =
  | "sport-family"
  | "sport-family-adjacent"
  | "sport"
  | "baseline"
  | "uncovered";

// CF-VALUE-BAND-ADJACENT (Drew, 2026-07-31). Sample-size floor for the
// same-family adjacent-band rung. Bowman-chrome PSA 9 shows a stable
// 1.10× signal across all populated bands from $250 to $999 (n=14 to
// n=40), and NO data at $1K+. Prior lookup fell to bySport (mixed
// families, n=12, 1.28×) for those higher bands. The adjacent-band
// rung prefers the same-family signal even at a different price band
// over a same-band mixed-family aggregate. n≥10 required so we're not
// promoting a noise cell.
const MIN_ADJACENT_BAND_SAMPLE = 10;

// CF-VALUE-BAND-SAMPLE-FLOOR (2026-09-03, closeout of audit C-5/H-6).
// The EXACT-band rungs (1 and 2) had no sample floor of their own — they
// trusted whatever the generator emitted. That was true-by-accident
// rather than by construction: grade-calibrate.mjs happens to drop cells
// under n=5 today (measured on the shipped table: min sampleSize is
// exactly 5 at all three layers, 0 cells below it), so the lookup never
// saw a thin cell. But nothing in the LOOKUP said so, and the doctrine
// this PR is enforcing is "the most specific empirical cell WITH AN
// ADEQUATE SAMPLE wins" — the sample clause has to be enforced where the
// resolution decision is made, or a future generator change silently
// promotes noise cells over the coarser rungs beneath them.
//
// Set to the generator's own floor. A cell below it does not resolve;
// the ladder continues to the next rung (sport, then baseline, then the
// caller's byTier fall-through), which is the whole point — a thin cell
// falls THROUGH rather than winning on specificity alone.
const MIN_VALUE_BAND_SAMPLE = 5;

// CF-VALUE-BAND-ADJACENT-DISTANCE (2026-09-03, audit H-6). The rescue
// above gated sample size but NOT how far it reached. Unbounded, it let
// panini-contenders PSA 10 at $10,000+ borrow the "Under $25" ratio of
// 20.88x — nine bands away — because that was the nearest cell with
// n>=10. 602 such rescues were live; fixing C-4 alone would have raised
// that to 1,199, which is why H-6 had to ship in the same PR: reaching
// MORE stranded cells without bounding the reach makes pricing worse.
//
// The bound is measured, not chosen. Across every (sport|family, tier)
// in the shipped bySportFamily table that has two or more populated
// bands, the disagreement between two bands' medianRatio grows steeply
// with distance (n = pairs of populated bands):
//
//   distance   n     median   p75    p90     max    >2x
//   ────────────────────────────────────────────────────────
//     1       355    1.21x   1.78x  2.42x   4.24x   21.4%
//     2       262    1.39x   2.28x  3.09x   4.38x   30.5%
//     3       191    2.04x   3.07x  3.72x   7.09x   50.3%
//     4        96    2.40x   3.34x  4.11x  10.51x   58.3%
//     5        44    2.88x   3.81x  5.20x   8.14x   72.7%
//     6        19    4.08x   5.30x  6.95x   6.97x   84.2%
//     7         3    4.02x   5.64x  5.64x   5.64x  100.0%
//
// Distance 1 is the only rung where the typical neighbouring band still
// tells you what this band would have said: the median pair disagrees by
// 1.21x, and the substitution is wrong by more than 2x a fifth of the
// time. At distance 3 the MEDIAN pair already disagrees by more than 2x
// — the rescue stops being an estimate of the missing cell and becomes a
// different card's number. So: max distance 1.
const MAX_ADJACENT_BAND_DISTANCE = 1;

// OPEN QUESTION FOR DREW, raised by the same measurement (2026-09-03).
// The bound above fixes the harm H-6 named. But a held-out check of the
// rung itself suggests it may not deserve to outrank what it displaces at
// ANY distance. Taking every (sport|family, tier, band) cell whose true
// value the shipped table already knows, hiding it, and asking whether a
// neighbour would have predicted it better than the rung the rescue
// outranks (bySport, else baseline):
//
//   distance   n     rescue wins   displaced rung wins   median |log err|
//   ──────────────────────────────────────────────────────────────────────
//     1       394      67 (17%)         327 (83%)        0.266 vs 0.069
//     2       358      51 (14%)         307 (86%)        0.405 vs 0.066
//     3       300      21 (7%)          279 (93%)        0.810 vs 0.061
//
// The same-family signal loses to the mixed-family aggregate four times
// out of five even next door, and its typical error is ~4x larger. That
// argues for retiring rung 1.5 outright rather than bounding it — but
// that is a bigger call than the audit asked for, it would move more
// prices than this PR already does, and CF-VALUE-BAND-ADJACENT was an
// explicit Drew ruling (2026-07-31) made on the Hartman case. Bounding it
// removes the measured harm now; retiring it is Drew's call on this
// evidence. Do not quietly widen the bound in the meantime.

// Second, independent bound. Even a distance-1 neighbour is not a
// substitute across an order-of-magnitude change in the raw anchor: the
// bands themselves widen (the top band is $10,000+, unbounded), and the
// grade premium is a function of where the card sits in the market, not
// of the adjacent label. A rescue is refused when the neighbouring
// band's own observed raw median differs from this lookup's anchor by
// 10x or more. This is what actually stops the $10,000-borrows-from-
// Under-$25 shape even if MAX_ADJACENT_BAND_DISTANCE were ever relaxed.
const MAX_ADJACENT_BAND_ANCHOR_RATIO = 10;

export interface ValueBandLookupContext {
  /** Sport name lowercased ("baseball" / "football" / "basketball" / "hockey"). */
  sport?: string | null;
  /** GRADE_CALIBRATION family classifier output (e.g. "bowman-chrome",
   *  "topps-chrome", "panini-prizm"). Passed by callers that already
   *  ran classifyFamily(setName). */
  family?: string | null;
}

export interface ValueBandLookupResult {
  medianRatio: number;
  scope: ValueBandResolveScope;
  sampleSize: number;
}

/** CF-VALUE-BAND-V2 (Drew, 2026-07-26). Walk the fall-through ladder
 *  and return the finest cell that has data. Backwards-compat with the
 *  scalar-returning v1 lookup below. Order:
 *    1.   bySportFamily["sport|family"][bucket][tier]           — exact
 *    1.5. bySportFamily["sport|family"][adjacent bucket][tier]  — same
 *         family, nearest populated band (n ≥ MIN_ADJACENT_BAND_SAMPLE)
 *    2.   bySport[sport][bucket][tier]
 *    3.   baseline[bucket][tier]
 *    4.   null (caller falls back to hardcoded value-tier cap).
 *
 *  Rung 1.5 added CF-VALUE-BAND-ADJACENT (Drew, 2026-07-31): rescues
 *  the case where the exact family+band cell is empty but the same
 *  family has a strong signal at a nearby band. Prevents a bowman-
 *  chrome PSA 9 lookup at $2,500 raw from collapsing to bySport's
 *  mixed-family aggregate when bowman-chrome's own $250-$999 bands
 *  all show a consistent 1.10× (real regime for the family). */
export function lookupValueBandMultiplierWithScope(
  rawAnchor: number,
  grader: string,
  gradeValue: number,
  ctx: ValueBandLookupContext = {},
): ValueBandLookupResult | null {
  const bucket = valueBandBucketOf(rawAnchor);
  if (bucket === null) return null;
  const tier = tierKey(grader, gradeValue);
  const sport = ctx.sport ? String(ctx.sport).toLowerCase() : null;
  const family = ctx.family ? String(ctx.family).toLowerCase() : null;

  // A cell resolves only when it is well-formed AND clears the sample
  // floor (CF-VALUE-BAND-SAMPLE-FLOOR). A cell that fails either test is
  // not "the answer we happen to have" — it is not evidence, and the
  // ladder must keep walking to a rung that is.
  const isValid = (cell: { medianRatio?: number; sampleSize?: number } | undefined): cell is { medianRatio: number; sampleSize: number; rawMedian?: number } =>
    !!cell && typeof cell.medianRatio === "number" && Number.isFinite(cell.medianRatio) && cell.medianRatio > 0
    && typeof cell.sampleSize === "number" && cell.sampleSize >= MIN_VALUE_BAND_SAMPLE;

  // 1. sport + family exact band
  if (sport && family) {
    const sfKey = `${sport}|${family}`;
    const cell = GRADE_MULTIPLIER_BY_VALUE_BAND.bySportFamily?.[sfKey]?.[bucket]?.[tier];
    if (isValid(cell)) return { medianRatio: cell.medianRatio, scope: "sport-family", sampleSize: cell.sampleSize };

    // 1.5 sport + family, adjacent-band interpolation. Walk outward from
    // the target bucket and take the first cell that clears BOTH bounds:
    // a sample-size floor (MIN_ADJACENT_BAND_SAMPLE) and a distance
    // bound (MAX_ADJACENT_BAND_DISTANCE + the order-of-magnitude anchor
    // guard). See CF-VALUE-BAND-ADJACENT-DISTANCE for the measured
    // justification of the distance bound.
    for (const near of adjacentBandsFor(bucket)) {
      // Bound the reach. adjacentBandsFor returns nearest-first, so the
      // first over-distance candidate means every remaining one is
      // further still — stop rather than continue.
      if (near.distance > MAX_ADJACENT_BAND_DISTANCE) break;
      const nearCell = GRADE_MULTIPLIER_BY_VALUE_BAND.bySportFamily?.[sfKey]?.[near.label]?.[tier];
      if (!isValid(nearCell) || nearCell.sampleSize < MIN_ADJACENT_BAND_SAMPLE) continue;
      // Order-of-magnitude guard: refuse a neighbour whose own observed
      // raw median is 10x away from this lookup's anchor. rawMedian is
      // emitted by the generator for exactly this check; when it is
      // absent (older table), fall back to the band's lower edge, which
      // is the conservative reading.
      const nearAnchor = typeof nearCell.rawMedian === "number" && nearCell.rawMedian > 0
        ? nearCell.rawMedian
        : bandLowerEdge(near.label);
      if (nearAnchor > 0 && rawAnchor > 0) {
        const spread = Math.max(nearAnchor, rawAnchor) / Math.min(nearAnchor, rawAnchor);
        if (spread >= MAX_ADJACENT_BAND_ANCHOR_RATIO) continue;
      }
      return { medianRatio: nearCell.medianRatio, scope: "sport-family-adjacent", sampleSize: nearCell.sampleSize };
    }
  }
  // 2. sport
  if (sport) {
    const cell = GRADE_MULTIPLIER_BY_VALUE_BAND.bySport?.[sport]?.[bucket]?.[tier];
    if (isValid(cell)) return { medianRatio: cell.medianRatio, scope: "sport", sampleSize: cell.sampleSize };
  }
  // 3. baseline (pooled across everything).
  //
  // CF-POKEMON-ENGINE-WIRING applies to EVERY lookup order (2026-09-03,
  // audit C-5). The Pokemon refusal was written into lookupGradeRatio and
  // lookupGradeRatioByTier, but this function had no Pokemon guard and
  // runs FIRST in getGraderPremium — so a Pokemon PSA 10 was resolving to
  // the pooled (baseball-weighted) baseline band before the guarded
  // lookups were ever reached: 4.18x at a $30 raw anchor, 2.66x at $150,
  // 2.30x at $300, against pokemon's own byTier figure of 7.45x (n=1512).
  // 968,155 graded Pokemon rows were understated 1.8x-3.2x.
  //
  // The refusal is the same one the other two lookups make, for the same
  // reason: Pokemon grade math (PSA 10 vs 9 is often 10-30x) is nothing
  // like baseball's 2-3x, so the pooled baseline is not a coarser answer
  // for a Pokemon card — it is a wrong one, and a wrong number is worse
  // than null in a pricing-icon context. Returning null here lets the
  // caller fall through to the Pokemon-guarded byTier lookup, which
  // resolves the sport-scoped figure or refuses honestly.
  if (sport === "pokemon") return null;

  const baseCell = GRADE_MULTIPLIER_BY_VALUE_BAND.baseline?.[bucket]?.[tier];
  if (isValid(baseCell)) return { medianRatio: baseCell.medianRatio, scope: "baseline", sampleSize: baseCell.sampleSize };

  return null;
}

/** Return every value-band label except the target, nearest-first, each
 *  carrying its index distance from the target's position in
 *  VALUE_BAND_EDGES. The caller bounds the reach — see
 *  CF-VALUE-BAND-ADJACENT-DISTANCE. Distance is returned rather than
 *  discarded so the bound is enforced on real distance instead of on
 *  iteration order, which would silently stop bounding anything if this
 *  sort ever changed. */
function adjacentBandsFor(bucket: string): Array<{ label: string; distance: number }> {
  const idx = VALUE_BAND_EDGES.findIndex(([,, l]) => l === bucket);
  if (idx < 0) return [];
  return VALUE_BAND_EDGES
    .map(([,, l], i) => ({ label: l, distance: Math.abs(i - idx) }))
    .filter((x) => x.distance > 0)
    .sort((a, b) => a.distance - b.distance);
}

/** Lower edge ($) of a value band, by label. Used as a conservative
 *  stand-in for a band's observed raw median when the shipped table
 *  predates the rawMedian field. */
function bandLowerEdge(label: string): number {
  const row = VALUE_BAND_EDGES.find(([,, l]) => l === label);
  return row ? row[0] : 0;
}

/** CF-VALUE-BAND-CALIBRATION (Drew, 2026-07-22). Scalar wrapper for the
 *  ladder above — preserves the v1 lookup signature for callers that
 *  don't care about scope. When called WITHOUT ctx, behavior is
 *  identical to v1 (baseline-only): the ladder short-circuits at step 3
 *  because steps 1-2 need sport/family. When called WITH ctx, walks the
 *  full ladder and returns the finest cell's medianRatio. Returns null
 *  when no cell in the ladder has data. */
export function lookupValueBandMultiplier(
  rawAnchor: number,
  grader: string,
  gradeValue: number,
  ctx: ValueBandLookupContext = {},
): number | null {
  return lookupValueBandMultiplierWithScope(rawAnchor, grader, gradeValue, ctx)?.medianRatio ?? null;
}

/** Lookup helper. Returns null when the (family, grader) is uncovered.
 *  When `sport` is provided, prefers sport-specific calibration; falls
 *  back to the baseline table (currently baseball-derived). */
export function lookupGradeRatio(
  family: string,
  grader: string,
  sport?: string | null,
): number | null {
  if (sport) {
    const sportEntry = GRADE_CALIBRATION_BY_SPORT[sport]?.[family]?.[grader];
    if (sportEntry) return sportEntry.medianRatio;
    // CF-POKEMON-ENGINE-WIRING (Drew, 2026-07-26). Pokemon TCG grade
    // math differs materially from baseball (PSA 10 vs 9 = 10-30×, not
    // 2-3×). Refuse to fall through to the baseline (baseball-implicit)
    // table for Pokemon — a wrong number is worse than null in a
    // pricing-icon context. Try the sport-scoped "pokemon" catch-all
    // family first (POKEMON_FAMILIES ends with a catch-all), then
    // return null. Downstream FMV code handles null-ratio by degrading
    // gracefully (skipping the multiplier, returning a raw-only or
    // no-basis result).
    if (sport === "pokemon") {
      const catchAll = GRADE_CALIBRATION_BY_SPORT["pokemon"]?.["pokemon"]?.[grader];
      return catchAll ? catchAll.medianRatio : null;
    }
    // Non-Pokemon sports: baseline fall-through is fine (FB/BB grade
    // math is close enough to baseball's that a wrong-family estimate
    // beats null).
  }
  const entry = GRADE_CALIBRATION[family]?.[grader];
  return entry ? entry.medianRatio : null;
}

/** CF-SUBTIER-SCALING-SHARED (Drew, 2026-07-27). Multiplier applied to
 *  a family's company-level medianRatio when we don't have empirical
 *  per-tier data for the specific grade. Same shape used privately in
 *  canonicalFmv.service.ts and observedGradeCurve.service.ts — exported
 *  from here so every fallback path agrees. Keep private copies in sync
 *  or migrate them to this export in a follow-up. */
export function subTierScalingForFallback(gradeValue: number): number {
  if (!Number.isFinite(gradeValue)) return 0;
  if (gradeValue >= 10) return 1.00;
  if (gradeValue >= 9.5) return 0.65;
  if (gradeValue >= 9)   return 0.35;
  return 0.20;
}

// CF-GRADE-CALIBRATE-PER-TIER (Drew, 2026-07-22). Empirical per-tier
// lookup used by observedGradeCurve when it wants a specific grade
// multiplier (e.g. PSA 9 vs the company-level median). Returns null
// when the specific tier isn't covered so the caller can fall back to
// company-level × subTierScaling. Prefers sport-specific data with
// baseline fallback, mirroring lookupGradeRatio.
export function lookupGradeRatioByTier(
  family: string,
  grader: string,
  gradeValue: number,
  sport?: string | null,
): number | null {
  const tierKey = String(gradeValue);
  if (sport) {
    const sportEntry = GRADE_CALIBRATION_BY_SPORT[sport]?.[family]?.[grader];
    const sportTier = sportEntry?.byTier?.[tierKey];
    if (sportTier) return sportTier.medianRatio;
    // CF-POKEMON-ENGINE-WIRING (Drew, 2026-07-26). Pokemon-safe
    // fallback ladder: sport-scoped "pokemon" catch-all family, then
    // null. NEVER falls through to baseline (baseball-implicit)
    // multipliers — those would emit wildly wrong FMV for Pokemon
    // graded cards (10-30× vs baseball's 2-3× per-tier premium).
    if (sport === "pokemon") {
      const catchAll = GRADE_CALIBRATION_BY_SPORT["pokemon"]?.["pokemon"]?.[grader];
      const catchAllTier = catchAll?.byTier?.[tierKey];
      return catchAllTier ? catchAllTier.medianRatio : null;
    }
  }
  const baselineEntry = GRADE_CALIBRATION[family]?.[grader];
  const baselineTier = baselineEntry?.byTier?.[tierKey];
  if (baselineTier) return baselineTier.medianRatio;
  // Try the "other" fallback family — it aggregates every named family
  // and typically has broader tier coverage.
  const otherEntry = GRADE_CALIBRATION["other"]?.[grader];
  const otherTier = otherEntry?.byTier?.[tierKey];
  if (otherTier) return otherTier.medianRatio;
  return null;
}

/** Product-family classifier matching the calibration script. Any set
 *  string maps to a canonical family key or "other".
 *  Order matters: more-specific tokens must come BEFORE generic ones
 *  (e.g. "topps chrome update" before "topps chrome" before "topps"). */
export function classifyFamily(setName: string | null | undefined): string {
  // CF-CLASSIFY-FAMILY-HYPHEN-TOLERANT (Drew, 2026-07-27). Accept both
  // human strings ("Bowman Chrome") and slug forms ("bowman-chrome") —
  // hobbyIqCardId setKey is slug, most other callers pass the human
  // string. Substring matches below all use spaces, so normalize hyphens
  // + underscores to spaces up front.
  const s = String(setName ?? "").toLowerCase().replace(/[-_]+/g, " ");
  // CF-POKEMON-ENGINE-WIRING (Drew, 2026-07-26). Pokemon TCG expansion
  // set classifiers — mirror POKEMON_FAMILIES in grade-calibrate.mjs.
  // Check FIRST so a Pokemon setName never falls through to the sports-
  // brand catch-alls below (e.g. "Pokemon Prizm" doesn't exist but a
  // defensive first-check keeps the ordering safe if it ever does).
  // "pokemon" catch-all at the end so any unclassified Pokemon expansion
  // still maps to a sport-scoped calibration cell.
  if (s.includes("pokemon") || s.includes("pokémon")) {
    if (s.includes("hidden fates")) return "pokemon-hidden-fates";
    if (s.includes("shining fates")) return "pokemon-shining-fates";
    if (s.includes("vivid voltage")) return "pokemon-vivid-voltage";
    if (s.includes("brilliant stars")) return "pokemon-brilliant-stars";
    if (s.includes("astral radiance")) return "pokemon-astral-radiance";
    if (s.includes("lost origin")) return "pokemon-lost-origin";
    if (s.includes("silver tempest")) return "pokemon-silver-tempest";
    if (s.includes("crown zenith")) return "pokemon-crown-zenith";
    if (s.includes("evolving skies")) return "pokemon-evolving-skies";
    if (s.includes("fusion strike")) return "pokemon-fusion-strike";
    if (s.includes("celebrations")) return "pokemon-celebrations";
    if (s.includes("obsidian flames")) return "pokemon-obsidian-flames";
    if (s.includes("paldea evolved")) return "pokemon-paldea-evolved";
    if (s.includes("151")) return "pokemon-151";
    if (s.includes("scarlet")) return "pokemon-scarlet-violet";
    if (s.includes("sword")) return "pokemon-sword-shield";
    if (s.includes("sun & moon") || s.includes("sun and moon")) return "pokemon-sun-moon";
    if (s.includes("xy")) return "pokemon-xy";
    if (s.includes("black & white") || s.includes("black and white")) return "pokemon-black-white";
    if (s.includes("heartgold")) return "pokemon-heartgold";
    if (s.includes("platinum")) return "pokemon-platinum";
    if (s.includes("diamond")) return "pokemon-diamond-pearl";
    if (s.includes(" ex")) return "pokemon-ex";
    if (s.includes("neo")) return "pokemon-neo";
    if (s.includes("team rocket")) return "pokemon-team-rocket";
    if (s.includes("fossil")) return "pokemon-fossil";
    if (s.includes("jungle")) return "pokemon-jungle";
    if (s.includes("base")) return "pokemon-base";
    if (s.includes("legendary collection")) return "pokemon-legendary-collection";
    if (s.includes("shining legends")) return "pokemon-shining-legends";
    if (s.includes("japanese")) return "pokemon-japanese";
    return "pokemon";  // catch-all — always resolves to a sport-scoped cell
  }
  if (s.includes("bowman chrome draft") || s.includes("bowman draft chrome")) return "bowman-chrome-draft";
  if (s.includes("bowman chrome")) return "bowman-chrome";
  // CF-BOWMAN-DRAFT-IS-ITS-OWN-FAMILY (2026-09-01). "Bowman Draft" is a
  // distinct product from flagship Bowman — chrome-fronted, with the Chrome
  // Prospect Autographs (CPA-*) as its headline cards — so its grade curve
  // tracks bowman-chrome, not paper bowman. It MUST be tested before the bare
  // "bowman" token, which was swallowing it: classifyFamily("Bowman Draft")
  // returned "bowman" and a 2024 Bowman Draft CPA auto drew paper-Bowman
  // multipliers (PSA 9 1.83x) instead of its own. Exactly the shadowing shape
  // CF-OPTIC-BEFORE-DONRUSS fixed. Ordering is the whole fix.
  //
  // Paired with the { family: "bowman-draft", token: "Bowman Draft" } row in
  // scripts/grade-calibrate.mjs BASELINE_FAMILIES — the classifier and the
  // generator must name the same cell or the lookup misses. Until the weekly
  // Grade Calibration Refresh runs, lookupGradeRatioByTier falls through to
  // the "other" family, which is the honest answer for an uncalibrated cell.
  if (s.includes("bowman draft")) return "bowman-draft";
  // CF-CLASSIFY-CPA-AS-BOWMAN-CHROME (Drew, 2026-07-31). "Chrome Prospects
  // Autographs" (CPA-* card numbers) is Topps' formal name for the Bowman
  // Chrome auto insert set. Rows arrive in sold_comps under multiple
  // setKey variants ("bowman", "bowman-chrome", "chrome-prospects-
  // autographs" — CH tags them as generic "Bowman Baseball" while
  // Cardsight uses the subset text). Cross-setkey unifies the comp pool
  // at read time, but calibration lookups were still classifying the
  // subset-form slug to "other" and losing the family-scoped multiplier.
  // Rerouting to bowman-chrome here restores the CPA autos to their
  // correct calibration family so the adjacent-band rung can rescue
  // them when the exact price band isn't populated for bowman-chrome.
  if (s.includes("chrome prospects autographs") || s.includes("chrome prospect autographs")) return "bowman-chrome";
  if (s.includes("bowman sterling")) return "bowman-sterling";
  if (s.includes("bowman")) return "bowman";
  if (s.includes("topps chrome update")) return "topps-chrome-update";
  if (s.includes("topps chrome")) return "topps-chrome";
  if (s.includes("topps update")) return "topps-update";
  if (s.includes("topps heritage")) return "topps-heritage";
  if (s.includes("topps finest")) return "topps-finest";
  if (s.includes("topps pristine")) return "topps-pristine";
  if (s.includes("allen & ginter") || s.includes("allen and ginter")) return "topps-allen-ginter";
  if (s.includes("topps stadium club") || s.includes("stadium club")) return "topps-stadium-club";
  // CF-GOLD-LABEL-IS-NOT-FLAGSHIP-TOPPS (2026-09-01). Gold Label is a premium
  // chrome-stock product whose Class 1/2/3 tiers are serial-numbered
  // parallels; its grade economics are nothing like flagship paper Topps.
  // Before this line, classifyFamily("2017 Topps Gold Label") returned
  // "topps" — a SUPERSET cell (PSA 9 n=2562) pooled over tens of thousands of
  // paper commons, which is the wrong cell for a Gold Label card in the same
  // way panini-donruss was the wrong cell for an Optic card. Must be tested
  // before the bare "topps" token that was shadowing it.
  //
  // Paired with the { family: "topps-gold-label", token: "Gold Label" } row in
  // scripts/grade-calibrate.mjs BASELINE_FAMILIES. Until the weekly refresh
  // populates it, lookupGradeRatioByTier falls through to the "other" family
  // rather than silently reusing the paper-Topps number.
  if (s.includes("gold label")) return "topps-gold-label";
  if (s.includes("topps")) return "topps";
  if (s.includes("prizm")) return "panini-prizm";
  if (s.includes("select")) return "panini-select";
  if (s.includes("mosaic")) return "panini-mosaic";
  // CF-OPTIC-BEFORE-DONRUSS (Drew, 2026-08-31). Optic MUST be tested before
  // Donruss. Every Optic set name contains the word "donruss" -- the product
  // is literally "Donruss Optic", and D31 (#1596) made "donruss-optic" the
  // canonical setKey, so the slug form now carries the shadowing token too.
  // With "donruss" first, classifyFamily("donruss-optic") returned
  // "panini-donruss" and every Optic card silently drew paper-Donruss grade
  // multipliers (PSA 3.25 / BGS 1.58 vs Optic's own PSA 2.82 / BGS absent).
  // These are genuinely different cells, not a rounding difference: the
  // calibration script queries each family with an independent
  // CONTAINS(card_set, token), so panini-donruss (PSA n=1426) is a SUPERSET
  // that swallows panini-optic (PSA n=813) plus ~600 paper-Donruss rows.
  // Chrome-front Optic and paper Donruss are different cards with different
  // grade curves, so the superset cell is the wrong one for an Optic card.
  // Ordering is the whole fix -- the returned family key stays "panini-optic"
  // because that is how GRADE_CALIBRATION is keyed; only the INPUT spelling
  // changed in #1596, not the calibration cell name.
  if (s.includes("optic")) return "panini-optic";
  if (s.includes("donruss")) return "panini-donruss";
  // CF-FB-BB-BRANDS (Drew, 2026-07-20). Extended for FB/BB-specific
  // product lines uncovered by baseball-only classifier.
  if (s.includes("hoops")) return "panini-hoops";
  if (s.includes("contenders")) return "panini-contenders";
  if (s.includes("national treasures")) return "panini-national-treasures";
  if (s.includes("immaculate")) return "panini-immaculate";
  if (s.includes("flawless")) return "panini-flawless";
  if (s.includes("chronicles")) return "panini-chronicles";
  if (s.includes("obsidian")) return "panini-obsidian";
  if (s.includes("phoenix")) return "panini-phoenix";
  if (s.includes("spectra")) return "panini-spectra";
  if (s.includes("absolute")) return "panini-absolute";
  if (s.includes("score")) return "panini-score";
  if (s.includes("prestige")) return "panini-prestige";
  if (s.includes("certified")) return "panini-certified";
  if (s.includes("playoff")) return "panini-playoff";
  if (s.includes("revolution")) return "panini-revolution";
  if (s.includes("upper deck")) return "upper-deck";
  return "other";
}
