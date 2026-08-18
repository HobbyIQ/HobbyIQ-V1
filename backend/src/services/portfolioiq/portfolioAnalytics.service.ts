// CF-PORTFOLIO-BREAKDOWN (Drew, 2026-08-17). The allocation / risk / quality
// analysis behind Portfolio Breakdown, computed SERVER-SIDE so web and iOS
// render the same numbers by construction.
//
// WHY IT LIVES HERE. The first cut of this shipped as a Swift service. Adding a
// TypeScript copy for the web dashboard would have created two implementations
// of one rule, and they drift — which is the same defect this codebase has now
// been bitten by three separate times (the slug guard vs computeHobbyIqCardId,
// the price-outlier diverter vs dataCleanJob, the null-slug backfill vs
// ingest). So the judgement lives once, on the server, and both clients render
// what they are handed.
//
// VALUE-WEIGHTED THROUGHOUT. Shares, concentration and quality are computed on
// portfolio VALUE, never card count — one grail plus nine commons is not
// "mostly commons". Quantity multiplies exposure: four copies of a $50 card is
// $200, and treating it as $50 understates concentration in exactly the case
// that matters.
//
// WHAT IT CANNOT SEE, IT SAYS. Holdings carry no print-run field and no
// population data, so print run is PARSED from the parallel / card-name text
// and is null when the vendor never wrote it. Null means UNKNOWN, not
// UNNUMBERED — folding those together would silently mark every tersely
// described card as non-scarce, which is the direction that flatters a
// portfolio. `unknownScarcityValueShare` reports how much value that covers so
// a thin-data collection cannot render as a confident verdict.

export type PortfolioCategory =
  | "establishedGreatness" | "trueScarcity" | "eliteProspects" | "speculation";

export type AllocationStatus =
  | "onTarget" | "slightlyUnderweight" | "underweight"
  | "slightlyOverweight" | "overweight";

export type ScarcityBand =
  | "oneOfOne" | "ultraScarce" | "veryScarce" | "scarce"
  | "limited" | "highPrintRun" | "unnumbered" | "unknown";

export type QualityTier = "cornerstone" | "strongHold" | "market" | "speculative";

export type PlayerClassification =
  | "establishedSuperstar" | "establishedStar" | "youngMLBStar" | "mlbRegular"
  | "eliteProspect" | "prospect" | "speculativeProspect"
  | "retiredLegend" | "vintageLegend" | "unknown";

/** The HobbyIQ Target Portfolio. NOT the user's current allocation. */
export const TARGET_ALLOCATION: Record<PortfolioCategory, number> = {
  establishedGreatness: 0.40,
  trueScarcity: 0.30,
  eliteProspects: 0.20,
  speculation: 0.10,
};

/**
 * CF-VERTICAL-NEUTRAL-CATEGORIES (Drew, 2026-08-17: "better names for
 * allocation? Since this is all products not just baseball").
 *
 * The original names were baseball-shaped — "Elite Prospects" is meaningless
 * for Pokemon or Yu-Gi-Oh!, and "Established Greatness" reads as PLAYERS. The
 * underlying ideas are vertical-neutral and survive intact: proven durable
 * demand, genuinely constrained supply, unproven but quality position,
 * short-term momentum. Only the words needed to travel.
 *
 * "Icons" covers a Charizard and a Blue-Eyes as well as an Ohtani. Finance
 * vocabulary ("blue chip") was rejected deliberately — this is a hobby tool,
 * not a trading terminal.
 *
 * The KEYS are unchanged on purpose: they are the wire contract iOS already
 * decodes, and renaming them would break a shipped client to no benefit.
 */
export const CATEGORY_LABEL: Record<PortfolioCategory, string> = {
  establishedGreatness: "Established Icons",
  trueScarcity: "True Scarcity",
  eliteProspects: "Emerging Upside",
  speculation: "Speculation",
};

/** One-line explanation per bucket, rendered under the name so the category is
 *  self-describing without a legend. Written to read for any vertical. */
export const CATEGORY_BLURB: Record<PortfolioCategory, string> = {
  establishedGreatness: "Proven names and characters with durable collector demand",
  trueScarcity: "Vintage, low serial numbers, low pop — supply that is genuinely constrained",
  eliteProspects: "Unproven but high-quality positions taken early",
  speculation: "Momentum plays and cards held to resell rather than keep",
};

/** The subset of a holding this analysis reads. Deliberately narrow so the
 *  service cannot quietly depend on fields a caller might not send. */
export interface AnalyzableHolding {
  id?: string;
  playerName?: string | null;
  cardName?: string | null;
  setName?: string | null;
  parallel?: string | null;
  year?: string | number | null;
  grade?: string | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  cost?: number | null;
  currentValue?: number | null;
  fairMarketValue?: number | null;
  quantity?: number | null;
  status?: string | null;
}

export interface Allocation {
  /** One of the four built-in categories, OR a user-defined tier id when the
   *  caller supplied custom tiers. Widened deliberately: pretending a custom
   *  tier id is one of the four would be a lie the type system then enforces. */
  category: PortfolioCategory | (string & {});
  label: string;
  /** Self-describing one-liner so the category needs no legend. */
  blurb: string;
  currentShare: number;
  targetShare: number;
  value: number;
  cardCount: number;
  status: AllocationStatus;
  driftPoints: number;
}

export interface RiskMetric {
  name: string;
  score: number;
  polarity: "riskIsBad" | "strengthIsGood";
  level: "low" | "moderate" | "high";
  label: string;
  detail: string;
  isConcerning: boolean;
}

export interface Concentration {
  dimension: "player" | "year" | "product" | "gradeTier";
  displayName: string;
  label: string;
  share: number;
  value: number;
  cardCount: number;
  isWarning: boolean;
  guidance: string;
}

export interface QualityBucket {
  tier: QualityTier;
  label: string;
  blurb: string;
  cardCount: number;
  value: number;
  valueShare: number;
}

export interface Recommendation {
  kind: "allocation" | "concentration" | "quality" | "scarcity" | "consolidation" | "strength";
  title: string;
  detail: string;
  priority: number;
}

export interface UpgradeOpportunity {
  cardCount: number;
  combinedValue: number;
  lowValue: number;
  highValue: number;
  insight: string;
}

export interface ScoreComponent { name: string; score: number; weight: number }

export interface PortfolioAnalyticsResult {
  totalValue: number;
  totalCost: number;
  totalProfitLoss: number;
  roi: number;
  cardCount: number;
  score: { value: number; tier: string; components: ScoreComponent[] };
  allocations: Allocation[];
  risk: RiskMetric[];
  concentrations: Concentration[];
  qualityBuckets: QualityBucket[];
  recommendations: Recommendation[];
  upgradeOpportunities: UpgradeOpportunity[];
  unknownScarcityValueShare: number;
}

// ---------------------------------------------------------------- tunables

const VINTAGE_YEAR_CUTOFF = 1980;
const INSERT_ERA: [number, number] = [1990, 1999];
const MODERN_YEAR_FLOOR = 2015;
const PLAYER_CONCENTRATION_WARNING = 0.22;
const YEAR_CONCENTRATION_WARNING = 0.35;
const PRODUCT_CONCENTRATION_WARNING = 0.40;
const UPGRADE_FLOOR = 100;
const UPGRADE_CEILING = 400;
const UPGRADE_MIN_CARDS = 4;

/** Seed set used ONLY to lift a name out of "unknown". Deliberately short so
 *  nobody mistakes it for a market ranking; a PlayerIQ tier feed is the real
 *  source and the seam is left for it. */
const ESTABLISHED_SEED = [
  "ohtani", "judge", "witt", "acuna", "acuña", "trout", "betts", "soto",
  "harper", "freeman", "skenes", "guerrero", "tatis", "ramirez", "lindor",
  "alvarez", "devers", "seager", "machado", "arenado", "altuve", "bregman",
];

const PROSPECT_TOKENS = [
  "bowman chrome prospect", "bowman prospect", "1st bowman", "bowman 1st",
  "bowman draft", "prospect auto", "chrome prospect", "bowman sterling", "prospects",
];

// ---------------------------------------------------------------- helpers

const pct = (v: number) => `${Math.round(v * 100)}%`;
const money = (v: number) =>
  `$${Math.round(v).toLocaleString("en-US")}`;

function qty(h: AnalyzableHolding): number {
  return Math.max(1, Number(h.quantity ?? 1) || 1);
}

/** Canonical FMV first, then current value, times quantity. */
function effectiveValue(h: AnalyzableHolding): number {
  const unit = Number(h.fairMarketValue ?? h.currentValue ?? 0) || 0;
  return Math.max(0, unit) * qty(h);
}

function yearOf(h: AnalyzableHolding): number | null {
  const raw = String(h.year ?? "");
  const m = /(19|20)\d{2}/.exec(raw);
  return m ? Number(m[0]) : null;
}

function isOwned(h: AnalyzableHolding): boolean {
  const s = String(h.status ?? "").toLowerCase();
  return !(s.includes("sold") || s.includes("archived") || s.includes("deleted") || s.includes("pending-review"));
}

function isGraded(h: AnalyzableHolding): boolean {
  if (h.gradeCompany && String(h.gradeCompany).trim()) return true;
  const g = String(h.grade ?? "").toLowerCase();
  return !!g && !g.includes("raw") && !g.includes("ungraded");
}

/**
 * Print run parsed from the card's own text: an explicit "/N" serial, plus the
 * named parallels whose run is a convention rather than printed on the card.
 * Returns null when neither is present — see the header on why that is not 0.
 */
export function parsePrintRun(parallel: string, cardName: string): number | null {
  const hay = `${parallel ?? ""} ${cardName ?? ""}`.toLowerCase();
  const m = /(?<![\d])\/\s*(\d{1,5})/.exec(hay);
  if (m) {
    const n = Number(m[1]);
    if (n > 0) return n;
  }
  if (hay.includes("1/1") || hay.includes("one of one") || hay.includes("superfractor")) return 1;
  // Longest-first so "true gold" is not shadowed by a bare "gold" rule.
  const named: Array<[string, number]> = [
    ["true gold", 50], ["gold vinyl", 5], ["red refractor", 5],
    ["black refractor", 10], ["orange refractor", 25],
    ["gold refractor", 50], ["blue refractor", 150],
  ];
  for (const [token, run] of named) if (hay.includes(token)) return run;
  return null;
}

export function scarcityBand(printRun: number | null): ScarcityBand {
  if (printRun === null) return "unknown";
  if (printRun === 1) return "oneOfOne";
  if (printRun <= 10) return "ultraScarce";
  if (printRun <= 25) return "veryScarce";
  if (printRun <= 99) return "scarce";
  if (printRun <= 499) return "limited";
  return "highPrintRun";
}

/** `unknown` scores mid-low rather than zero: absence of evidence is not
 *  evidence of a huge print run. */
const BAND_SCORE: Record<ScarcityBand, number> = {
  oneOfOne: 1.0, ultraScarce: 0.92, veryScarce: 0.80, scarce: 0.65,
  limited: 0.45, highPrintRun: 0.20, unnumbered: 0.15, unknown: 0.30,
};

function isProspectCard(h: AnalyzableHolding): boolean {
  const hay = `${h.setName ?? ""} ${h.cardName ?? ""} ${h.parallel ?? ""}`.toLowerCase();
  return PROSPECT_TOKENS.some((t) => hay.includes(t));
}

export function classify(h: AnalyzableHolding): PlayerClassification {
  const year = yearOf(h);
  const name = String(h.playerName ?? "").toLowerCase();
  if (year !== null && year < VINTAGE_YEAR_CUTOFF) return "vintageLegend";
  if (isProspectCard(h)) {
    const band = scarcityBand(parsePrintRun(String(h.parallel ?? ""), String(h.cardName ?? "")));
    if (band === "oneOfOne" || band === "ultraScarce" || band === "veryScarce") return "eliteProspect";
    if (band === "scarce" || band === "limited") return "prospect";
    return "speculativeProspect";
  }
  if (ESTABLISHED_SEED.some((s) => name.includes(s))) return "establishedSuperstar";
  if (year !== null && year < 2000) return "retiredLegend";
  return "unknown";
}

const isEstablished = (c: PlayerClassification) =>
  ["establishedSuperstar", "establishedStar", "youngMLBStar", "mlbRegular", "retiredLegend", "vintageLegend"].includes(c);
const isProspectClass = (c: PlayerClassification) =>
  ["eliteProspect", "prospect", "speculativeProspect"].includes(c);

/**
 * Which target bucket a holding belongs to.
 *
 * Precedence is SUPPLY first, then player. A /10 is constrained supply whoever
 * is on it, and a prospect card with an ordinary print run is a speculation
 * whatever the prospect's ranking. The other order would let a known name
 * launder an unnumbered high-pop modern card into Established Greatness.
 */
export function categoryFor(h: AnalyzableHolding): PortfolioCategory {
  const year = yearOf(h);
  const run = parsePrintRun(String(h.parallel ?? ""), String(h.cardName ?? ""));
  const band = scarcityBand(run);
  const cls = classify(h);

  if (year !== null && year < VINTAGE_YEAR_CUTOFF) return "trueScarcity";
  if (band === "oneOfOne" || band === "ultraScarce" || band === "veryScarce") return "trueScarcity";
  if (year !== null && year >= INSERT_ERA[0] && year <= INSERT_ERA[1] && run !== null) return "trueScarcity";
  if (isProspectClass(cls)) return band === "scarce" || band === "limited" ? "eliteProspects" : "speculation";
  if (isEstablished(cls)) return "establishedGreatness";
  return band === "scarce" ? "trueScarcity" : "speculation";
}

function qualityTier(band: ScarcityBand, cls: PlayerClassification,
                     vintage: boolean, graded: boolean): QualityTier {
  if (vintage && graded) return "cornerstone";
  switch (band) {
    case "oneOfOne": case "ultraScarce": return "cornerstone";
    case "veryScarce": return isProspectClass(cls) ? "strongHold" : "cornerstone";
    case "scarce": return "strongHold";
    case "limited": return isEstablished(cls) ? "strongHold" : "market";
    case "highPrintRun": case "unnumbered":
      return isProspectClass(cls) ? "speculative" : (graded ? "market" : "speculative");
    default:
      if (vintage) return "strongHold";
      if (isEstablished(cls) && graded) return "market";
      return isProspectClass(cls) ? "speculative" : "market";
  }
}

/** Drift is measured in PERCENTAGE POINTS of the whole portfolio, not as a
 *  ratio of the target — 3 points off a 10% target is on target for any real
 *  decision, and a ratio would scream about the smallest bucket forever. */
export function allocationStatus(current: number, target: number): AllocationStatus {
  const drift = (current - target) * 100;
  if (drift < -10) return "underweight";
  if (drift < -3) return "slightlyUnderweight";
  if (drift <= 3) return "onTarget";
  if (drift <= 10) return "slightlyOverweight";
  return "overweight";
}

const STATUS_LABEL: Record<AllocationStatus, string> = {
  onTarget: "ON TARGET",
  slightlyUnderweight: "SLIGHTLY UNDERWEIGHT",
  underweight: "UNDERWEIGHT",
  slightlyOverweight: "SLIGHTLY OVERWEIGHT",
  overweight: "OVERWEIGHT",
};
export { STATUS_LABEL };

const TIER_META: Record<QualityTier, { label: string; blurb: string }> = {
  cornerstone: { label: "Tier 1 — Cornerstone", blurb: "True scarcity, iconic cards, vintage grails, key low-numbered rookies" },
  strongHold: { label: "Tier 2 — Strong Holds", blurb: "Scarce rookies, Bowman 1sts, established stars, desirable numbered cards" },
  market: { label: "Tier 3 — Market Cards", blurb: "Good liquidity, but higher population or replaceable supply" },
  speculative: { label: "Tier 4 — Speculative", blurb: "Prospects, flips, high-pop cards, volatile players" },
};

function scoreTier(v: number): string {
  if (v >= 90) return "Elite";
  if (v >= 80) return "Strong Portfolio";
  if (v >= 70) return "Good Portfolio";
  if (v >= 60) return "Moderate Risk";
  if (v >= 50) return "High Risk";
  return "Speculative";
}

function levelOf(score: number): "low" | "moderate" | "high" {
  return score < 0.34 ? "low" : score < 0.67 ? "moderate" : "high";
}

function metricLabel(score: number, polarity: RiskMetric["polarity"]): string {
  const lvl = levelOf(score);
  if (polarity === "riskIsBad") return lvl.toUpperCase();
  return lvl === "high" ? "STRONG" : lvl === "moderate" ? "ADEQUATE" : "THIN";
}

// ---------------------------------------------------------------- entry

/**
 * CF-CUSTOM-TIERS (2026-08-17). When the user has defined their own tiers, the
 * allocation section is computed against THOSE instead of the built-in four.
 *
 * Everything else — score, risk, concentration, quality — is unchanged, because
 * those measure properties of the cards rather than of the user's chosen
 * buckets. Only "Allocation Fit" inside the score moves, which is correct: it
 * is the one component that asks "does this match the target", and the target
 * is now theirs.
 */
export function analyzeWithCustomTiers(
  holdings: AnalyzableHolding[],
  tiers: import("./portfolioCustomTiers.js").CustomTier[],
): PortfolioAnalyticsResult {
  const base = analyzePortfolio(holdings);
  if (base.cardCount === 0 || tiers.length === 0) return base;

  // Lazily required so the default path pays nothing for this.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assignTier, UNASSIGNED_TIER_ID } =
    require("./portfolioCustomTiers.js") as typeof import("./portfolioCustomTiers.js");

  const owned = holdings.filter((h) => isOwned(h) && effectiveValue(h) > 0);
  const totalValue = owned.reduce((s, h) => s + effectiveValue(h), 0);

  const bucket = new Map<string, { value: number; count: number }>();
  for (const h of owned) {
    const value = effectiveValue(h);
    const id = assignTier(tiers, {
      printRun: parsePrintRun(String(h.parallel ?? ""), String(h.cardName ?? "")),
      year: yearOf(h),
      graded: isGraded(h),
      isAuto: Boolean((h as { isAuto?: boolean }).isAuto),
      product: `${h.setName ?? ""} ${h.cardName ?? ""} ${h.parallel ?? ""}`.toLowerCase(),
      name: String(h.playerName ?? "").toLowerCase(),
      value,
    });
    const cur = bucket.get(id) ?? { value: 0, count: 0 };
    cur.value += value;
    cur.count += 1;
    bucket.set(id, cur);
  }

  const allocations: Allocation[] = tiers.map((t) => {
    const b = bucket.get(t.id) ?? { value: 0, count: 0 };
    const currentShare = b.value / totalValue;
    return {
      category: t.id as PortfolioCategory,
      label: t.name,
      blurb: t.blurb ?? "",
      currentShare,
      targetShare: t.targetShare,
      value: b.value,
      cardCount: b.count,
      status: allocationStatus(currentShare, t.targetShare),
      driftPoints: (currentShare - t.targetShare) * 100,
    };
  });

  // Anything the user's rules did not catch is shown, not absorbed. Hiding it
  // would make a rule set look complete when it is not.
  const un = bucket.get(UNASSIGNED_TIER_ID);
  if (un && un.value > 0) {
    allocations.push({
      category: UNASSIGNED_TIER_ID as PortfolioCategory,
      label: "Unassigned",
      blurb: "Cards no tier rule matched — adjust your rules to place these",
      currentShare: un.value / totalValue,
      targetShare: 0,
      value: un.value,
      cardCount: un.count,
      status: allocationStatus(un.value / totalValue, 0),
      driftPoints: (un.value / totalValue) * 100,
    });
  }

  const totalDrift = allocations.reduce((s, a) => s + Math.abs(a.driftPoints), 0) / 2;
  const allocationFit = Math.min(1, Math.max(0, 1 - totalDrift / 50));
  const components = base.score.components.map((c) =>
    c.name === "Allocation Fit" ? { ...c, score: allocationFit } : c);
  const scoreValue = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0) * 100);

  const recommendations = [
    ...allocations
      .filter((a) => a.status !== "onTarget" && a.category !== UNASSIGNED_TIER_ID)
      .map((a) => ({
        kind: "allocation" as const,
        title: `${a.driftPoints < 0 ? "Increase" : "Reduce"} ${a.label}`,
        detail: `${pct(a.currentShare)} of value against your ${pct(a.targetShare)} target — ${Math.round(Math.abs(a.driftPoints))} points ${a.driftPoints < 0 ? "under" : "over"}.`,
        priority: Math.round(Math.abs(a.driftPoints)) + 40,
      })),
    ...base.recommendations.filter((r) => r.kind !== "allocation"),
  ].sort((a, b) => b.priority - a.priority).slice(0, 5);

  return {
    ...base,
    allocations,
    score: { value: scoreValue, tier: scoreTier(scoreValue), components },
    recommendations,
  };
}

export function analyzePortfolio(holdings: AnalyzableHolding[]): PortfolioAnalyticsResult {
  const owned = (holdings ?? []).filter((h) => isOwned(h) && effectiveValue(h) > 0);
  const totalValue = owned.reduce((s, h) => s + effectiveValue(h), 0);

  if (owned.length === 0 || totalValue <= 0) {
    return {
      totalValue: 0, totalCost: 0, totalProfitLoss: 0, roi: 0, cardCount: 0,
      score: { value: 0, tier: scoreTier(0), components: [] },
      allocations: [], risk: [], concentrations: [], qualityBuckets: [],
      recommendations: [], upgradeOpportunities: [], unknownScarcityValueShare: 0,
    };
  }

  const totalCost = owned.reduce((s, h) => s + (Number(h.cost ?? 0) || 0) * qty(h), 0);

  const derived = owned.map((h) => {
    const year = yearOf(h);
    const run = parsePrintRun(String(h.parallel ?? ""), String(h.cardName ?? ""));
    const band = scarcityBand(run);
    const cls = classify(h);
    const vintage = (year ?? 9999) < VINTAGE_YEAR_CUTOFF;
    const graded = isGraded(h);
    const value = effectiveValue(h);

    let liquidity = 0.35;
    if (graded) liquidity += 0.30;
    if (isEstablished(cls)) liquidity += 0.15;
    if (cls === "unknown") liquidity -= 0.05;
    if (band === "oneOfOne") liquidity -= 0.10;   // rare AND illiquid
    if (value < 25) liquidity -= 0.15;
    if (value > 5000) liquidity -= 0.05;
    liquidity = Math.min(1, Math.max(0, liquidity));

    let supply: number;
    if (year === null || year < MODERN_YEAR_FLOOR) supply = 0.15;   // vintage supply is fixed
    else supply = { oneOfOne: 0.05, ultraScarce: 0.05, veryScarce: 0.15, scarce: 0.30,
                    limited: 0.50, highPrintRun: 0.80, unnumbered: graded ? 0.75 : 0.90,
                    unknown: 0.60 }[band];

    return {
      h, value, cost: (Number(h.cost ?? 0) || 0) * qty(h),
      category: categoryFor(h), tier: qualityTier(band, cls, vintage, graded),
      cls, band, run, liquidity, supply, weight: value / totalValue,
    };
  });

  // --- allocations
  const allocations: Allocation[] = (Object.keys(TARGET_ALLOCATION) as PortfolioCategory[]).map((category) => {
    const bucket = derived.filter((d) => d.category === category);
    const value = bucket.reduce((s, d) => s + d.value, 0);
    const currentShare = value / totalValue;
    const targetShare = TARGET_ALLOCATION[category];
    return {
      category, label: CATEGORY_LABEL[category], blurb: CATEGORY_BLURB[category],
      currentShare, targetShare, value,
      cardCount: bucket.length,
      status: allocationStatus(currentShare, targetShare),
      driftPoints: (currentShare - targetShare) * 100,
    };
  });

  // --- quality
  const qualityBuckets: QualityBucket[] = (Object.keys(TIER_META) as QualityTier[]).map((tier) => {
    const bucket = derived.filter((d) => d.tier === tier);
    const value = bucket.reduce((s, d) => s + d.value, 0);
    return { tier, ...TIER_META[tier], cardCount: bucket.length, value, valueShare: value / totalValue };
  });

  // --- concentration
  const concentrations: Concentration[] = [];
  const topBy = (
    dimension: Concentration["dimension"], displayName: string,
    threshold: number, guidance: string, key: (h: AnalyzableHolding) => string | null,
  ) => {
    const value = new Map<string, number>();
    const count = new Map<string, number>();
    for (const d of derived) {
      const k = (key(d.h) ?? "").trim();
      if (!k) continue;
      value.set(k, (value.get(k) ?? 0) + d.value);
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    let best: [string, number] | null = null;
    for (const entry of value.entries()) if (!best || entry[1] > best[1]) best = entry;
    if (!best) return;
    const share = best[1] / totalValue;
    concentrations.push({
      dimension, displayName, label: best[0], share, value: best[1],
      cardCount: count.get(best[0]) ?? 0, isWarning: share > threshold, guidance,
    });
  };

  topBy("player", "Player Concentration", PLAYER_CONCENTRATION_WARNING,
    "Try to keep any single player below roughly 20–25% unless you are intentionally building a PC.",
    (h) => h.playerName ?? null);
  topBy("year", "Single-Year Concentration", YEAR_CONCENTRATION_WARNING,
    "A single year carrying most of the value ties the portfolio to one release cycle.",
    (h) => { const y = yearOf(h); return y === null ? null : String(y); });
  topBy("product", "Product Concentration", PRODUCT_CONCENTRATION_WARNING,
    "One product dominating means one checklist's market moves the whole portfolio.",
    (h) => h.setName ?? null);
  topBy("gradeTier", "Grade Concentration", 0.55,
    "Heavy weighting to one grade tier concentrates grading-standard and population risk.",
    (h) => (isGraded(h) ? `${h.gradeCompany ?? "Graded"} ${h.gradeValue ?? ""}`.trim() : "Raw / Ungraded"));

  concentrations.sort((a, b) => b.share - a.share);

  // --- risk
  const weighted = (f: (d: typeof derived[number]) => number) =>
    derived.reduce((s, d) => s + f(d) * d.value, 0) / totalValue;
  const shareWhere = (f: (d: typeof derived[number]) => boolean) =>
    derived.filter(f).reduce((s, d) => s + d.value, 0) / totalValue;

  const establishedShare = shareWhere((d) => isEstablished(d.cls));
  const prospectShare = shareWhere((d) => isProspectClass(d.cls));
  const scarcityScore = weighted((d) => BAND_SCORE[d.band]);
  const liquidityScore = weighted((d) => d.liquidity);
  const supplyScore = weighted((d) => d.supply);
  const playerShare = concentrations.find((c) => c.dimension === "player")?.share ?? 0;
  // Herfindahl on value weights, inverted: reads real concentration in a way a
  // card count cannot — 50 cards where one is 60% of value is not diversified.
  const hhi = derived.reduce((s, d) => s + d.weight * d.weight, 0);
  const diversification = Math.min(1, Math.max(0, 1 - hhi));

  const mk = (name: string, score: number, polarity: RiskMetric["polarity"], detail: string): RiskMetric => ({
    name, score, polarity, level: levelOf(score), label: metricLabel(score, polarity), detail,
    isConcerning: polarity === "riskIsBad" ? levelOf(score) === "high" : levelOf(score) === "low",
  });

  const risk: RiskMetric[] = [
    mk("Established Player Exposure", establishedShare, "strengthIsGood",
       `${pct(establishedShare)} of value sits with established or historically significant players.`),
    mk("Scarcity Quality", scarcityScore, "strengthIsGood", "Value-weighted scarcity across the collection."),
    mk("Prospect Exposure", prospectShare, "riskIsBad",
       `${pct(prospectShare)} of value is in prospect cards, whose outcomes are unresolved.`),
    mk("Modern Supply Risk", supplyScore, "riskIsBad",
       "Exposure to modern cards whose supply is not meaningfully constrained."),
    mk("Player Concentration", Math.min(1, playerShare / 0.5), "riskIsBad",
       `Largest single-player weighting is ${pct(playerShare)} of value.`),
    mk("Liquidity", liquidityScore, "strengthIsGood",
       "How readily the collection could be converted at a fair price."),
    mk("Portfolio Diversification", diversification, "strengthIsGood",
       "Spread of value across holdings rather than card count."),
  ];

  // --- score
  const totalDrift = allocations.reduce((s, a) => s + Math.abs(a.driftPoints), 0) / 2;
  const allocationFit = Math.min(1, Math.max(0, 1 - totalDrift / 50));
  const unrealised = totalCost > 0
    ? Math.min(1, Math.max(0, ((totalValue - totalCost) / totalCost + 0.5) / 2.0))
    : 0.5;
  const speculativeShare = shareWhere((d) => d.category === "speculation");
  const riskAdjusted = Math.min(1, Math.max(0, unrealised * (1 - speculativeShare * 0.5)));

  const components: ScoreComponent[] = [
    { name: "Allocation Fit", score: allocationFit, weight: 0.20 },
    { name: "Scarcity Quality", score: scarcityScore, weight: 0.18 },
    { name: "Established Exposure", score: establishedShare, weight: 0.14 },
    { name: "Concentration", score: 1 - Math.min(1, playerShare / 0.5), weight: 0.13 },
    { name: "Liquidity", score: liquidityScore, weight: 0.12 },
    { name: "Supply Risk", score: 1 - supplyScore, weight: 0.10 },
    { name: "Diversification", score: diversification, weight: 0.08 },
    { name: "Risk-Adjusted Return", score: riskAdjusted, weight: 0.05 },
  ];
  const scoreValue = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0) * 100);

  // --- upgrades
  const candidates = derived.filter(
    (d) => d.value >= UPGRADE_FLOOR && d.value <= UPGRADE_CEILING &&
           (d.tier === "market" || d.tier === "speculative"),
  );
  const upgradeOpportunities: UpgradeOpportunity[] = [];
  if (candidates.length >= UPGRADE_MIN_CARDS) {
    const combined = candidates.reduce((s, d) => s + d.value, 0);
    const lo = Math.floor((combined * 0.8) / 100) * 100;
    const hi = Math.floor((combined * 1.05) / 100) * 100;
    upgradeOpportunities.push({
      cardCount: candidates.length, combinedValue: combined,
      lowValue: Math.min(...candidates.map((d) => d.value)),
      highValue: Math.max(...candidates.map((d) => d.value)),
      insight: `These ${candidates.length} cards hold ${money(combined)} between them in a band where supply is replaceable. That is roughly one ${money(lo)}–${money(hi)} cornerstone card with better scarcity and more durable collector demand.`,
    });
  }

  // --- recommendations
  const recommendations: Recommendation[] = [];
  for (const a of allocations) {
    if (a.status === "onTarget") continue;
    const gap = Math.abs(a.driftPoints);
    const direction = a.driftPoints < 0 ? "Increase" : "Reduce";
    recommendations.push({
      kind: "allocation", title: `${direction} ${a.label}`,
      detail: `${direction === "Increase" ? "Currently" : "You hold"} ${pct(a.currentShare)} of value against a ${pct(a.targetShare)} target — ${Math.round(gap)} points ${a.driftPoints < 0 ? "under" : "over"}.`,
      priority: Math.round(gap) + 40,
    });
  }
  for (const c of concentrations) {
    if (!c.isWarning) continue;
    recommendations.push({
      kind: "concentration", title: `${c.displayName} Risk`,
      detail: `${pct(c.share)} of portfolio value is tied to ${c.label}. ${c.guidance}`,
      priority: Math.round(c.share * 100) + 30,
    });
  }
  const scarceShare = shareWhere((d) => d.run !== null && d.run <= 100);
  if (scarceShare >= 0.35) {
    recommendations.push({
      kind: "strength", title: "Strong scarcity base",
      detail: `${pct(scarceShare)} of portfolio value is in cards numbered /100 or lower.`,
      priority: 25,
    });
  } else if (scarceShare < 0.15) {
    recommendations.push({
      kind: "scarcity", title: "Thin on genuine scarcity",
      detail: `Only ${pct(scarceShare)} of value is in cards numbered /100 or lower. Serial numbers alone are not scarcity — print run is what matters.`,
      priority: 45,
    });
  }
  const spec = qualityBuckets.find((q) => q.tier === "speculative");
  if (spec && spec.valueShare > 0.30) {
    recommendations.push({
      kind: "quality", title: "Heavy in speculative cards",
      detail: `${pct(spec.valueShare)} of value sits in Tier 4 cards across ${spec.cardCount} holdings.`,
      priority: 42,
    });
  }
  if (upgradeOpportunities[0]) {
    recommendations.push({
      kind: "consolidation", title: "Consolidation opportunity",
      detail: upgradeOpportunities[0].insight, priority: 35,
    });
  }
  recommendations.sort((a, b) => b.priority - a.priority);

  const unknownScarcityValueShare = shareWhere((d) => d.band === "unknown");

  return {
    totalValue, totalCost,
    totalProfitLoss: totalValue - totalCost,
    roi: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
    cardCount: owned.length,
    score: { value: scoreValue, tier: scoreTier(scoreValue), components },
    allocations, risk, concentrations, qualityBuckets,
    recommendations: recommendations.slice(0, 5),
    upgradeOpportunities, unknownScarcityValueShare,
  };
}
