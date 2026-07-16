/**
 * CF-COMPIQ-PER-GRADE-BREAKDOWN (2026-07-01):
 * For a single card_id, fan out per grade and return a consolidated
 * per-grade breakdown. Where the grade has real live comps, return
 * them + the FMV. Where the grade has no comps, project from Raw
 * using the empirical multiplier table + mark as "projected".
 *
 * iOS uses this to render a grade picker on the card detail view:
 * user sees "Raw ($23, 50 comps) / PSA 9 ($52, projected / no comps) /
 * PSA 10 ($68, projected)" and selects the grade they own.
 */

import {
  getPricesByCard,
  getCardSales,
  type CardHedgeSale,
} from "./cardhedge.client.js";
import { getGraderPremium } from "./compiqEstimate.service.js";
import { projectNextSaleFromComps } from "./nextSaleProjection.service.js";

/** Standard grades surfaced when the caller doesn't specify. */
const DEFAULT_GRADES: ReadonlyArray<GradeKey> = [
  { label: "Raw", gradingCompany: null, gradeValue: null },
  { label: "PSA 10", gradingCompany: "PSA", gradeValue: 10 },
  { label: "PSA 9", gradingCompany: "PSA", gradeValue: 9 },
  { label: "PSA 8", gradingCompany: "PSA", gradeValue: 8 },
  { label: "BGS 10", gradingCompany: "BGS", gradeValue: 10 },
  { label: "BGS 9.5", gradingCompany: "BGS", gradeValue: 9.5 },
  { label: "BGS 9", gradingCompany: "BGS", gradeValue: 9 },
  { label: "SGC 10", gradingCompany: "SGC", gradeValue: 10 },
  { label: "SGC 9", gradingCompany: "SGC", gradeValue: 9 },
];

const CH_GRADE_STRING_MAP: Record<string, string> = {
  Raw: "Raw",
  "PSA 10": "PSA 10",
  "PSA 9": "PSA 9",
  "PSA 8": "PSA 8",
  "BGS 10": "BGS 10",
  "BGS 9.5": "BGS 9.5",
  "BGS 9": "BGS 9",
  "SGC 10": "SGC 10",
  "SGC 9": "SGC 9",
};

/** How many days back to fetch prices-by-card / comps per grade. */
const DAYS_WINDOW = 90;
/** Max concurrent CH grade probes. */
const GRADE_CONCURRENCY = 4;

export interface GradeKey {
  /** Display label (used as CH's `grade` string too). */
  label: string;
  /** Grading company, null for Raw. */
  gradingCompany: string | null;
  /** Numeric grade value, null for Raw. */
  gradeValue: number | null;
}

export interface GradeBreakdownRow {
  /** Display label (e.g., "Raw", "PSA 10"). */
  gradeLabel: string;
  gradingCompany: string | null;
  gradeValue: number | null;
  isRaw: boolean;

  /** How many actual CH comps we found. */
  compCount: number;
  /** Median price across the recent comps. */
  medianPrice: number | null;
  /** Fair market value — live median if compCount>=3, projected otherwise. */
  fairMarketValue: number | null;
  /** Most recent comp's price. */
  latestPrice: number | null;
  latestDate: string | null;
  daysSinceNewestComp: number | null;
  /** Up to 5 most recent comps, freshest first. */
  recentComps: Array<{
    date: string | null;
    price: number;
    title: string | null;
    url: string | null;
  }>;

  /** Projected price + range for empty/thin grades. Present on projected AND live. */
  predictedPrice: number | null;
  predictedPriceRange: { low: number; high: number } | null;

  /**
   * Source of the price:
   *   "live"      — 3+ real comps in the 90d window; fairMarketValue is
   *                 the trend-projected next sale from those comps
   *                 (never a median of them, per Drew 2026-07-15).
   *   "projected" — no or thin comps; predicted from Raw × grader premium
   *   "no-data"   — no Raw anchor to project from either
   */
  source: "live" | "projected" | "no-data";

  attribution: {
    // CF-NO-MEDIAN-FMV (2026-07-15): mechanism disambiguates the live
    // path between clean regression fit and single-point trend-adjusted
    // fallback. "unavailable" flows through on the no-data branch.
    mechanism:
      | "live-comps"
      | "live-comps-regression"
      | "live-comps-trend-adjusted-last-sale"
      | "grade-ladder-projection"
      | "unavailable";
    anchorGrade?: string;
    anchorPrice?: number;
    multiplier?: number;
  };

  /** 0.0-1.0. Higher = more comps + fresher + less projection. */
  confidence: number;
}

export interface CardGradesBreakdown {
  success: true;
  cardId: string;
  grades: GradeBreakdownRow[];
}

/**
 * Fetch one grade's raw stats from CH. Never throws — errors return
 * zero-comp rows so downstream projection kicks in.
 */
async function fetchGradeStats(
  cardId: string,
  chGradeString: string,
): Promise<{
  comps: CardHedgeSale[];
  dailyPriceCount: number;
}> {
  try {
    const [dailyPrices, comps] = await Promise.all([
      getPricesByCard(cardId, chGradeString, DAYS_WINDOW),
      getCardSales(cardId, chGradeString, 20),
    ]);
    return {
      comps: comps ?? [],
      dailyPriceCount: dailyPrices?.length ?? 0,
    };
  } catch (err) {
    console.warn(
      `[perGradeBreakdown] CH fetch failed cardId=${cardId} grade=${chGradeString}: ${(err as Error)?.message ?? err}`,
    );
    return { comps: [], dailyPriceCount: 0 };
  }
}

/** Median of a numeric array. Returns null when empty. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Turn CH's grade stats into a GradeBreakdownRow. Raw prices are the
 * projection anchor for all other grades (passed as rawPrice arg).
 * When compCount is 0 AND we have a rawPrice, project via grader
 * premium. When both are missing, return no-data.
 */
export function buildGradeBreakdownRow(
  grade: GradeKey,
  stats: { comps: CardHedgeSale[]; dailyPriceCount: number },
  rawAnchor: { price: number; cardYear?: number | null; isAutograph?: boolean } | null,
): GradeBreakdownRow {
  const isRaw = grade.gradingCompany === null;
  const comps = stats.comps ?? [];
  const validPrices = comps
    .map((c) => c.price)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0);
  const compCount = validPrices.length;
  const medianPrice = median(validPrices);

  // Latest comp — freshest by date.
  let latestPrice: number | null = null;
  let latestDate: string | null = null;
  let latestTs = 0;
  for (const c of comps) {
    if (typeof c.price !== "number" || c.price <= 0) continue;
    const ts = c.date ? Date.parse(c.date) || 0 : 0;
    if (ts > latestTs) {
      latestTs = ts;
      latestPrice = c.price;
      latestDate = c.date;
    }
  }
  const daysSinceNewestComp =
    latestTs > 0 ? Math.floor((Date.now() - latestTs) / (24 * 3600 * 1000)) : null;

  // Recent comps (freshest first).
  const recentComps = [...comps]
    .filter((c) => typeof c.price === "number" && c.price > 0)
    .sort((a, b) => {
      const ta = a.date ? Date.parse(a.date) || 0 : 0;
      const tb = b.date ? Date.parse(b.date) || 0 : 0;
      return tb - ta;
    })
    .slice(0, 5)
    .map((c) => ({
      date: c.date,
      price: c.price,
      title: c.title,
      url: c.url,
    }));

  // ── Live path: 3+ comps in window ─────────────────────────────
  //
  // CF-NO-MEDIAN-FMV (Drew, 2026-07-15): retired median-as-FMV in the
  // per-grade breakdown's live path. FMV is projected next sale from
  // this grade tier's trend across the comp pool. `medianPrice` is
  // still surfaced as a diagnostic column (median of past comps —
  // observed, not projected) so iOS/backtest can compare projection
  // vs midpoint, but `fairMarketValue` and `predictedPrice` now derive
  // from projectNextSaleFromComps.
  if (compCount >= 3 && medianPrice !== null) {
    const gradeCompsForProjection = comps
      .filter((c) => typeof c.price === "number" && c.price > 0)
      .map((c) => ({ price: c.price, soldDate: c.date ?? null }));
    const nextSale = projectNextSaleFromComps(gradeCompsForProjection);
    if (nextSale === null) {
      // Invariant break — compCount>=3 with all-invalid prices shouldn't
      // reach here. Fall through to projection path (no FMV emitted).
      return {
        gradeLabel: grade.label,
        gradingCompany: grade.gradingCompany,
        gradeValue: grade.gradeValue,
        isRaw,
        compCount,
        medianPrice: round(medianPrice),
        fairMarketValue: null,
        latestPrice: latestPrice !== null ? round(latestPrice) : null,
        latestDate,
        daysSinceNewestComp,
        recentComps,
        predictedPrice: null,
        predictedPriceRange: null,
        source: "no-data",
        attribution: { mechanism: "unavailable" },
        confidence: 0,
      };
    }
    return {
      gradeLabel: grade.label,
      gradingCompany: grade.gradingCompany,
      gradeValue: grade.gradeValue,
      isRaw,
      compCount,
      medianPrice: round(medianPrice),
      fairMarketValue: round(nextSale.nextSaleValue),
      latestPrice: latestPrice !== null ? round(latestPrice) : null,
      latestDate,
      daysSinceNewestComp,
      recentComps,
      predictedPrice: round(nextSale.nextSaleValue),
      predictedPriceRange: { low: nextSale.bounds.low, high: nextSale.bounds.high },
      source: "live",
      attribution: {
        mechanism: nextSale.method === "linear-regression"
          ? "live-comps-regression"
          : "live-comps-trend-adjusted-last-sale",
      },
      confidence: Math.min(1, nextSale.confidence + Math.min(0.15, compCount * 0.02)),
    };
  }

  // ── Projected path: no comps but we have a Raw anchor ──────────
  if (rawAnchor && rawAnchor.price > 0 && !isRaw) {
    const multiplier = getGraderPremium(
      grade.gradingCompany,
      String(grade.gradeValue ?? ""),
      rawAnchor.price,
      rawAnchor.isAutograph ? "autograph" : "base",
      rawAnchor.cardYear ?? null,
    );
    if (Number.isFinite(multiplier) && multiplier > 0) {
      const projected = round(rawAnchor.price * multiplier);
      const spread = Math.max(1, projected * 0.2);
      return {
        gradeLabel: grade.label,
        gradingCompany: grade.gradingCompany,
        gradeValue: grade.gradeValue,
        isRaw,
        compCount,
        medianPrice: medianPrice !== null ? round(medianPrice) : null,
        fairMarketValue: null,
        latestPrice: latestPrice !== null ? round(latestPrice) : null,
        latestDate,
        daysSinceNewestComp,
        recentComps,
        predictedPrice: projected,
        predictedPriceRange: { low: round(projected - spread), high: round(projected + spread) },
        source: "projected",
        attribution: {
          mechanism: "grade-ladder-projection",
          anchorGrade: "Raw",
          anchorPrice: round(rawAnchor.price),
          multiplier: Math.round(multiplier * 100) / 100,
        },
        confidence: 0.35,
      };
    }
  }

  // ── No-data path: neither live nor projectable ────────────────
  return {
    gradeLabel: grade.label,
    gradingCompany: grade.gradingCompany,
    gradeValue: grade.gradeValue,
    isRaw,
    compCount,
    medianPrice: medianPrice !== null ? round(medianPrice) : null,
    fairMarketValue: null,
    latestPrice: latestPrice !== null ? round(latestPrice) : null,
    latestDate,
    daysSinceNewestComp,
    recentComps,
    predictedPrice: null,
    predictedPriceRange: null,
    source: "no-data",
    attribution: { mechanism: "live-comps" },
    confidence: 0.1,
  };
}

/**
 * Main entry: fan out across grades, aggregate into a breakdown.
 * When Raw has zero comps, all other grades come back with source
 * "no-data" (no anchor to project from). When Raw is live, non-Raw
 * grades default to projected via multiplier.
 */
export async function computeCardGradesBreakdown(
  cardId: string,
  opts?: { grades?: ReadonlyArray<GradeKey>; cardYear?: number | null; isAutograph?: boolean },
): Promise<CardGradesBreakdown> {
  const grades = opts?.grades ?? DEFAULT_GRADES;

  // Step 1 — fetch Raw first (blocking) so we have the anchor for projections
  const rawGrade = grades.find((g) => g.gradingCompany === null);
  let rawStats: { comps: CardHedgeSale[]; dailyPriceCount: number } | null = null;
  if (rawGrade) {
    rawStats = await fetchGradeStats(cardId, CH_GRADE_STRING_MAP[rawGrade.label] ?? "Raw");
  }
  const rawValidPrices =
    rawStats?.comps
      .map((c) => c.price)
      .filter((p): p is number => typeof p === "number" && Number.isFinite(p) && p > 0) ?? [];
  const rawMedian = median(rawValidPrices);
  const rawAnchor =
    rawMedian !== null
      ? {
          price: rawMedian,
          cardYear: opts?.cardYear ?? null,
          isAutograph: opts?.isAutograph ?? false,
        }
      : null;

  // Step 2 — fetch non-Raw grades with bounded concurrency
  const nonRawGrades = grades.filter((g) => g.gradingCompany !== null);
  const nonRawStats = new Map<string, { comps: CardHedgeSale[]; dailyPriceCount: number }>();
  const queue = [...nonRawGrades];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const g = queue.shift();
      if (!g) return;
      const chGradeStr = CH_GRADE_STRING_MAP[g.label] ?? g.label;
      const stats = await fetchGradeStats(cardId, chGradeStr);
      nonRawStats.set(g.label, stats);
    }
  };
  await Promise.all(Array.from({ length: GRADE_CONCURRENCY }, () => worker()));

  // Step 3 — assemble breakdown rows
  const rows: GradeBreakdownRow[] = grades.map((g) => {
    if (g.gradingCompany === null) {
      return buildGradeBreakdownRow(g, rawStats ?? { comps: [], dailyPriceCount: 0 }, null);
    }
    const stats = nonRawStats.get(g.label) ?? { comps: [], dailyPriceCount: 0 };
    return buildGradeBreakdownRow(g, stats, rawAnchor);
  });

  return {
    success: true,
    cardId,
    grades: rows,
  };
}
