// CF-UNIFIED-PRICING (Drew, 2026-08-04). One pricing function that
// both the card catalog page + the portfolio holding view read from.
// Same query, same math, same output → numbers match by construction.
//
// Design:
//   - Query sold_comps for (cardId OR hobbyiqCardId) — union of every
//     ingest source we've captured (cardhedge + cardsight + tca-ebay +
//     user comps).
//   - Adaptive recency window: 30d → 60d → 90d → 180d cascading based
//     on comp density (matches hobbyIqFmv composite path adaptive
//     window).
//   - Filter out rows tagged priceAnomaly=true (Layer 1.5 — bad-parse
//     comps like Yellow Refractor mislabeled as Yellow X-Fractor).
//   - Group by (gradeCompany, gradeValue). Compute weighted median per
//     group using recency decay (newer sales carry more weight).
//   - Optional grade-argument selects one entry to return as the fmv.
//     Without grade, returns the full per-grade curve.
//
// Portfolio callers: pass grade → get fmv for THAT tier.
// Card catalog callers: omit grade → get full curve.
// Both derive the same numbers from the same rows.

import { CosmosClient, type Container } from "@azure/cosmos";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SOLD_COMPS_CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";

// Cascade windows for adaptive density-based lookback.
const WINDOWS = [
  { days: 30, minDirect: 20 },
  { days: 60, minDirect: 15 },
  { days: 90, minDirect: 10 },
  { days: 180, minDirect: 5 },
];

// Recency decay: sale weight = exp(-days_since_sale / HALF_LIFE_DAYS).
// 14d half-life means a 48h-old sale is ~5× weight of a 30d-old sale.
const HALF_LIFE_DAYS = 14;

export interface UnifiedGradeEntry {
  grade: string;                 // e.g. "PSA 9", "BGS 10", "Raw"
  gradeCompany: string | null;   // e.g. "PSA"; null for raw
  gradeValue: number | null;
  weightedMedian: number | null;
  plainMedian: number | null;
  sampleCount: number;
  p10: number | null;
  p90: number | null;
  newestSaleDate: string | null;
  valueSource: "observed" | "estimated" | "unavailable";
  confidence: number;            // 0-1 from sample count + recency
  // CF-UNIFIED-PRICING-PREDICTED (Drew, 2026-08-04). Projected next
  // sale from the recent trend. Same golden rule as canonicalFmv:
  // FMV = projected next sale, never a median. When trend is flat
  // or the pool is too thin for a signal, predictedPrice equals
  // weightedMedian.
  predictedPrice: number | null;
  trendPctPerWeek: number | null;   // slope × 7d as % of median
  trendDirection: "up" | "down" | "flat";
  // CF-UNIFIED-PRICING-MARKETVALUE (Drew, 2026-08-04). Trend-lifted
  // current market value: weightedMedian × full trend ratio. This is
  // what a trader marks their book at — "where would the next sale
  // clear if the current trend holds?" — and matches observedGradeCurve's
  // trendAdjustedValue math. Distinct from predictedPrice: predictedPrice
  // projects 7d FORWARD (sqrt of the 14d trend ratio), marketValue lifts
  // the CURRENT median TO current-trend-implied-value (full ratio).
  //
  // Why full ratio not sqrt: predictedPrice is projecting forward past
  // now; marketValue is the trend-implied clearing price AT now. For a
  // market up 25%/month, the weighted median at $2,326 lags reality
  // ($2,700 recent August sales). marketValue = $2,326 × 1.12 ≈ $2,600
  // matches what a buyer will actually pay THIS WEEK.
  marketValue: number | null;
}

export interface UnifiedPriceResult {
  cardId: string;
  fmv: number | null;            // requested-grade weighted median
  marketValue: number | null;    // requested-grade trend-lifted current market value
  predictedPrice: number | null; // requested-grade projected next sale (7d fwd)
  trendPctPerWeek: number | null;
  trendDirection: "up" | "down" | "flat";
  gradeCurve: UnifiedGradeEntry[];
  windowDays: number;            // adaptive window that produced these numbers
  totalSampleCount: number;
  method: "weighted-median" | "no-basis";
  confidence: number;
  computedAt: string;
}

let _cachedContainer: Container | null = null;
async function getContainer(): Promise<Container | null> {
  if (_cachedContainer) return _cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    _cachedContainer = new CosmosClient(conn).database(COSMOS_DATABASE).container(SOLD_COMPS_CONTAINER);
    return _cachedContainer;
  } catch { return null; }
}

interface RawCompRow {
  price: number;
  soldAt: string;
  gradeCompany: string | null;
  gradeValue: number | null;
  priceAnomaly?: boolean;
  contributorUserId?: string | null;
}

// CF-SELF-COMP-THIN-POOL (Drew, 2026-08-04). When the surviving pool
// after excluding the user's own contributions has fewer than this many
// other samples, we KEEP their self-comps — their own purchase IS the
// market signal for a rare parallel (Victor Figueroa Red Ink SSP: 1
// self-comp @ $278.60, 0 other comps). Filtering it out leaves nothing
// and legacy engine's fuzzy fallback produces $1.89.
const SELF_COMP_MIN_OTHER_SAMPLES = 3;

async function queryComps(
  cont: Container,
  cardId: string,
  hobbyiqCardId: string | null,
  windowDays: number,
  excludeContributorUserId?: string | null,
): Promise<RawCompRow[]> {
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const parts: string[] = ["c.soldAt >= @cutoff", "c.price > 0", "(NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true)"];
  const params: Array<{ name: string; value: string | number | boolean | null }> = [
    { name: "@cutoff", value: cutoff },
  ];
  // Union: match by cardId OR hobbyiqCardId (covers cross-vendor storage).
  parts.push("(c.cardId = @cid" + (hobbyiqCardId ? " OR c.hobbyiqCardId = @hiq" : "") + ")");
  params.push({ name: "@cid", value: cardId });
  if (hobbyiqCardId) params.push({ name: "@hiq", value: hobbyiqCardId });

  try {
    const { resources } = await cont.items.query<RawCompRow>({
      query: `SELECT c.price, c.soldAt, c.gradeCompany, c.gradeValue, c.priceAnomaly, c.contributorUserId FROM c WHERE ${parts.join(" AND ")}`,
      parameters: params,
    }, { maxItemCount: 500 }).fetchAll();
    const clean = (resources || []).filter((r) => Number.isFinite(r.price) && r.price > 0 && !!r.soldAt);
    // Post-filter: exclude self-comps ONLY when the surviving other-pool
    // is large enough to price on its own. See SELF_COMP_MIN_OTHER_SAMPLES.
    if (excludeContributorUserId) {
      const others = clean.filter((r) => r.contributorUserId !== excludeContributorUserId);
      if (others.length >= SELF_COMP_MIN_OTHER_SAMPLES) return others;
      // else: keep self-comps in — they carry the only market signal we have
    }
    return clean;
  } catch { return []; }
}

function gradeLabel(company: string | null, value: number | null): string {
  if (!company) return "Raw";
  return `${String(company).toUpperCase()} ${value ?? "?"}`;
}

function weightedMedian(rows: RawCompRow[], nowMs: number): number | null {
  if (rows.length === 0) return null;
  // Assign each row a weight via exp decay.
  const weighted = rows.map((r) => {
    const t = Date.parse(r.soldAt);
    const days = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 86400_000) : 30;
    const w = Math.exp(-days / HALF_LIFE_DAYS);
    return { price: Number(r.price), w };
  }).sort((a, b) => a.price - b.price);
  const totalW = weighted.reduce((s, r) => s + r.w, 0);
  if (totalW <= 0) return null;
  let cum = 0;
  const half = totalW / 2;
  for (const r of weighted) {
    cum += r.w;
    if (cum >= half) return r.price;
  }
  return weighted[weighted.length - 1].price;
}

function plainMedian(rows: RawCompRow[]): number | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].map((r) => Number(r.price)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(rows: RawCompRow[], p: number): number | null {
  if (rows.length < 4) return null;
  const sorted = [...rows].map((r) => Number(r.price)).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function confidenceScore(sampleCount: number, newestMs: number | null, nowMs: number): number {
  let score = Math.min(1, Math.log10(Math.max(1, sampleCount)) / Math.log10(20));
  if (newestMs) {
    const daysSinceNewest = Math.max(0, (nowMs - newestMs) / 86400_000);
    if (daysSinceNewest > 60) score *= 0.7;
    if (daysSinceNewest > 120) score *= 0.7;
  }
  return Math.max(0, Math.min(1, score));
}

/**
 * Compute unified pricing. Cascades window until enough direct-comp
 * density is available. Returns per-grade breakdown; when `grade` is
 * passed, `fmv` is the matched entry's weightedMedian.
 */
export async function computeUnifiedPrice(
  cardId: string,
  opts: {
    hobbyiqCardId?: string | null;
    grade?: { company: string | null; value: number | null } | null;
    // CF-EXCLUDE-SELF-COMPS (Drew, 2026-08-04). Portfolio callers pass
    // the requesting userId here so the user's own eBay-import purchases
    // don't recycle back as market comps against their own holdings.
    excludeContributorUserId?: string | null;
  } = {},
): Promise<UnifiedPriceResult> {
  const nowMs = Date.now();
  const empty: UnifiedPriceResult = {
    cardId,
    fmv: null,
    marketValue: null,
    predictedPrice: null,
    trendPctPerWeek: null,
    trendDirection: "flat",
    gradeCurve: [],
    windowDays: 180,
    totalSampleCount: 0,
    method: "no-basis",
    confidence: 0,
    computedAt: new Date(nowMs).toISOString(),
  };

  const container = await getContainer();
  if (!container) return empty;

  // Adaptive window — start tight, widen until direct-grade density
  // supports the requested read.
  let selectedWindow = 180;
  let comps: RawCompRow[] = [];
  for (const w of WINDOWS) {
    comps = await queryComps(container, cardId, opts.hobbyiqCardId ?? null, w.days, opts.excludeContributorUserId ?? null);
    // If a specific grade was requested, measure density on THAT grade
    // for cascade decision. Else use overall pool density.
    let densityCount = comps.length;
    if (opts.grade?.company) {
      const target = gradeLabel(opts.grade.company, opts.grade.value);
      densityCount = comps.filter((r) => gradeLabel(r.gradeCompany, r.gradeValue) === target).length;
    }
    if (densityCount >= w.minDirect) {
      selectedWindow = w.days;
      break;
    }
  }
  if (comps.length === 0) return empty;

  // Group by grade
  const groups = new Map<string, RawCompRow[]>();
  for (const r of comps) {
    const key = gradeLabel(r.gradeCompany, r.gradeValue);
    let arr = groups.get(key);
    if (!arr) { arr = []; groups.set(key, arr); }
    arr.push(r);
  }

  // Trend + projected next sale per grade. Split rows into recent 14d
  // and prior 14d, compare weighted medians. Ratio > 1 = up trend.
  // predictedPrice = current weighted median × trend ratio (clamped
  // to ±50% to prevent thin-pool wild extrapolations).
  function computeTrendAndPrediction(rows: RawCompRow[], wMedian: number | null): {
    marketValue: number | null;
    predictedPrice: number | null;
    trendPctPerWeek: number | null;
    trendDirection: "up" | "down" | "flat";
  } {
    if (wMedian === null || rows.length < 4) {
      return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
    }
    const cutoffMs = nowMs - 14 * 86400_000;
    const recent = rows.filter((r) => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t >= cutoffMs;
    });
    const prior = rows.filter((r) => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t < cutoffMs;
    });
    if (recent.length < 2 || prior.length < 2) {
      return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
    }
    const rMed = weightedMedian(recent, nowMs);
    const pMed = weightedMedian(prior, nowMs);
    if (!rMed || !pMed || pMed <= 0) {
      return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
    }
    const ratio = rMed / pMed;
    // Clamp to [0.5, 1.5] — anything more extreme is thin-pool noise.
    const cappedRatio = Math.max(0.5, Math.min(1.5, ratio));
    // CF-UNIFIED-PRICING-MARKETVALUE (Drew, 2026-08-04). marketValue
    // applies the FULL trend ratio so wMedian lifts to the current
    // trend-implied clearing price. Fixes strong-trend under-marking:
    // Ohtani PSA 9 wMedian $2,326 was dragged down by older July sales
    // while August was clearing $2,700+ — marketValue $2,326 × 1.12 ≈
    // $2,610 matches the recent 4-sale August cluster.
    const marketValue = Math.round(wMedian * cappedRatio * 100) / 100;
    // predictedPrice projects 7d forward from marketValue (sqrt of the
    // 14d comparison window since we're going half a step further out).
    const predicted = Math.round(wMedian * Math.pow(cappedRatio, 1.5) * 100) / 100;
    const pctPerWeek = Math.round((cappedRatio - 1) * 500) / 10; // ~ (ratio - 1) × 50 = %/week
    const direction: "up" | "down" | "flat" =
      Math.abs(pctPerWeek) < 1 ? "flat" : (pctPerWeek > 0 ? "up" : "down");
    return { marketValue, predictedPrice: predicted, trendPctPerWeek: pctPerWeek, trendDirection: direction };
  }

  const gradeCurve: UnifiedGradeEntry[] = [];
  for (const [label, rows] of groups.entries()) {
    if (rows.length === 0) continue;
    const newestMs = rows.reduce<number>((mx, r) => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t > mx ? t : mx;
    }, 0);
    const wMed = weightedMedian(rows, nowMs);
    const trend = computeTrendAndPrediction(rows, wMed);
    gradeCurve.push({
      grade: label,
      gradeCompany: rows[0].gradeCompany,
      gradeValue: rows[0].gradeValue,
      weightedMedian: wMed,
      plainMedian: plainMedian(rows),
      sampleCount: rows.length,
      p10: percentile(rows, 0.10),
      p90: percentile(rows, 0.90),
      newestSaleDate: newestMs > 0 ? new Date(newestMs).toISOString() : null,
      valueSource: "observed",
      confidence: confidenceScore(rows.length, newestMs || null, nowMs),
      marketValue: trend.marketValue,
      predictedPrice: trend.predictedPrice,
      trendPctPerWeek: trend.trendPctPerWeek,
      trendDirection: trend.trendDirection,
    });
  }
  gradeCurve.sort((a, b) => (b.sampleCount - a.sampleCount));

  // fmv + marketValue + predicted for a specific-grade lookup
  let fmv: number | null = null;
  let marketValue: number | null = null;
  let predictedPrice: number | null = null;
  let trendPctPerWeek: number | null = null;
  let trendDirection: "up" | "down" | "flat" = "flat";
  let selectedConfidence = 0;
  if (opts.grade?.company) {
    const target = gradeLabel(opts.grade.company, opts.grade.value);
    // CF-UNIFIED-GRADE-FALLBACK-CHAIN (Drew, 2026-08-04). When the requested
    // grade doesn't match any pool entry, fall back to the highest-sample
    // entry so we still return real market data. Common triggers:
    //   - Malformed grade ("PSA undefined" from a raw eBay import that
    //     picked up "PSA" from an unrelated title field)
    //   - Requested grade tier truly has no comps (e.g. Bobby Witt BGS 9.5
    //     when the pool only has PSA sales)
    //   - Rare tier lookups (SGC 10 when only PSA 10 sales exist)
    //
    // The fallback picks the largest-sample entry (already sorted at the
    // top of gradeCurve). Raw is a common winner because auto rookie pools
    // are Raw-dominated. Setting `matched` here means the top-level fmv /
    // marketValue / predictedPrice fields carry a real number instead of
    // null — which is what stops legacy fall-through from writing $18
    // sibling-rescue prices for cards that HAVE real pool data.
    let matched = gradeCurve.find((e) => e.grade === target);
    if (!matched && gradeCurve.length > 0) {
      matched = gradeCurve[0];
    }
    if (matched) {
      fmv = matched.weightedMedian;
      marketValue = matched.marketValue;
      predictedPrice = matched.predictedPrice;
      trendPctPerWeek = matched.trendPctPerWeek;
      trendDirection = matched.trendDirection;
      selectedConfidence = matched.confidence;
    }
  }

  return {
    cardId,
    fmv,
    marketValue,
    predictedPrice,
    trendPctPerWeek,
    trendDirection,
    gradeCurve,
    windowDays: selectedWindow,
    totalSampleCount: comps.length,
    method: comps.length > 0 ? "weighted-median" : "no-basis",
    confidence: selectedConfidence || Math.min(1, comps.length / 30),
    computedAt: new Date(nowMs).toISOString(),
  };
}
