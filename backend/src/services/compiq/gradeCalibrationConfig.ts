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
  | "sport"
  | "baseline"
  | "uncovered";

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
 *    1. bySportFamily["sport|family"][bucket][tier]
 *    2. bySport[sport][bucket][tier]
 *    3. baseline[bucket][tier]
 *    4. null (caller falls back to hardcoded value-tier cap). */
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

  const isValid = (cell: { medianRatio?: number } | undefined): cell is { medianRatio: number; sampleSize: number } =>
    !!cell && typeof cell.medianRatio === "number" && Number.isFinite(cell.medianRatio) && cell.medianRatio > 0;

  // 1. sport + family
  if (sport && family) {
    const sfKey = `${sport}|${family}`;
    const cell = GRADE_MULTIPLIER_BY_VALUE_BAND.bySportFamily?.[sfKey]?.[bucket]?.[tier];
    if (isValid(cell)) return { medianRatio: cell.medianRatio, scope: "sport-family", sampleSize: cell.sampleSize };
  }
  // 2. sport
  if (sport) {
    const cell = GRADE_MULTIPLIER_BY_VALUE_BAND.bySport?.[sport]?.[bucket]?.[tier];
    if (isValid(cell)) return { medianRatio: cell.medianRatio, scope: "sport", sampleSize: cell.sampleSize };
  }
  // 3. baseline (pooled across everything)
  const baseCell = GRADE_MULTIPLIER_BY_VALUE_BAND.baseline?.[bucket]?.[tier];
  if (isValid(baseCell)) return { medianRatio: baseCell.medianRatio, scope: "baseline", sampleSize: baseCell.sampleSize };

  return null;
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
  if (s.includes("topps")) return "topps";
  if (s.includes("prizm")) return "panini-prizm";
  if (s.includes("select")) return "panini-select";
  if (s.includes("mosaic")) return "panini-mosaic";
  if (s.includes("donruss")) return "panini-donruss";
  if (s.includes("optic")) return "panini-optic";
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
