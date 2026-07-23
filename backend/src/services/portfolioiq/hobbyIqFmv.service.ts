// CF-HOBBYIQ-FMV (Drew, 2026-07-23, "we set the market" surface).
// Public HobbyIQ price for a canonical hobbyiqCardId slug. Reads from
// OUR sold_comps pool (not vendor calls). No vendor attribution — this
// is HobbyIQ's own price.
//
// Design principles:
//   - Deterministic given (slug, grade filter): same inputs → same output.
//   - Zero vendor calls. Every byte comes from sold_comps rows we own.
//   - Rich breakdown: comp count by source, autoStyle mix (on-card vs
//     sticker), gradeQualifier mix (OC/MK/ST/PD/MC/OF), recent comps
//     with all the fields iOS wants to render badges.
//   - Trend: linear regression slope (%/month) on the last 90 days when
//     n≥3, anchor+broader-fallback when n<3.
//
// Read path is a single cross-partition query against sold_comps by
// hobbyiqCardId. Backfill has populated 2.4M rows so lookups are fast.

import { CosmosClient, type Container } from "@azure/cosmos";

export interface HobbyIqFmvInput {
  hobbyiqCardId: string;              // canonical slug (hiq:sport:year:...)
  gradeCompany?: string | null;       // null = raw
  gradeValue?: number | null;
  /** Freshness cutoff. Rows older than this are dropped. Default 180 days. */
  maxAgeDays?: number;
  /** Max comps to include in the recentComps preview (for iOS render). */
  previewLimit?: number;
}

export interface HobbyIqFmvComp {
  price: number;
  soldAt: string;
  source: string;
  parallel?: string | null;
  autoStyle?: "on-card" | "sticker" | null;
  gradeQualifier?: string | null;
  url?: string | null;
}

export interface HobbyIqFmvBreakdown {
  bySource: Record<string, number>;    // { cardsight: 12, cardhedge: 5, ... }
  byAutoStyle: {
    onCard: number;
    sticker: number;
    unknown: number;
  };
  byGradeQualifier: Record<string, number>;   // { OC: 2, MK: 1, unqualified: 20 }
}

export interface HobbyIqFmvTrend {
  direction: "up" | "down" | "flat";
  slopePerMonthPct: number;              // signed
  method: "regression" | "anchor" | "none";
}

export interface HobbyIqFmvResult {
  slug: string;
  fmv: number | null;                    // median of fresh comps in the target grade
  compCount: number;                     // fresh + in-grade
  min: number | null;
  max: number | null;
  breakdown: HobbyIqFmvBreakdown;
  trend: HobbyIqFmvTrend;
  recentComps: HobbyIqFmvComp[];
  computedAt: string;
  cachedFrom: "sold_comps";              // provenance — always HobbyIQ's own pool
}

let cachedContainer: Container | null = null;
async function getSoldCompsContainer(): Promise<Container | null> {
  if (cachedContainer) return cachedContainer;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  try {
    const client = new CosmosClient(conn);
    const db = client.database(process.env.COSMOS_DATABASE ?? "hobbyiq");
    cachedContainer = db.container(process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps");
    return cachedContainer;
  } catch {
    return null;
  }
}

export async function computeHobbyIqFmv(input: HobbyIqFmvInput): Promise<HobbyIqFmvResult> {
  const slug = String(input.hobbyiqCardId ?? "").trim();
  const now = new Date();
  const emptyResult: HobbyIqFmvResult = {
    slug,
    fmv: null,
    compCount: 0,
    min: null,
    max: null,
    breakdown: {
      bySource: {},
      byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 },
      byGradeQualifier: {},
    },
    trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
    recentComps: [],
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };
  if (!slug || !slug.startsWith("hiq:")) return emptyResult;

  const container = await getSoldCompsContainer();
  if (!container) return emptyResult;

  const maxAgeDays = input.maxAgeDays ?? 180;
  const maxAgeMs = maxAgeDays * 86_400_000;
  const cutoffIso = new Date(now.getTime() - maxAgeMs).toISOString();

  const gradeCompany = input.gradeCompany ?? null;
  const gradeValue = input.gradeValue ?? null;

  // Cross-partition query by hobbyiqCardId slug. Filter by freshness +
  // grade tier inline so the response is only what matters.
  const gradeFilter = gradeCompany
    ? " AND c.gradeCompany = @gc AND c.gradeValue = @gv"
    : " AND (NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null)";
  const parameters: Array<{ name: string; value: string | number | null }> = [
    { name: "@slug", value: slug },
    { name: "@from", value: cutoffIso },
  ];
  if (gradeCompany) {
    parameters.push({ name: "@gc", value: gradeCompany });
    parameters.push({ name: "@gv", value: gradeValue });
  }

  let rows: Array<{
    price: number;
    soldAt: string;
    source: string;
    parallel?: string | null;
    autoStyle?: "on-card" | "sticker" | null;
    gradeQualifier?: string | null;
    url?: string | null;
  }> = [];
  try {
    const { resources } = await container.items.query({
      query: `SELECT c.price, c.soldAt, c.source, c.parallel, c.autoStyle, c.gradeQualifier, c.url
              FROM c
              WHERE c.hobbyiqCardId = @slug AND c.soldAt > @from${gradeFilter}
              ORDER BY c.soldAt DESC`,
      parameters,
    }).fetchAll();
    rows = resources;
  } catch {
    return emptyResult;
  }
  if (rows.length === 0) return emptyResult;

  const prices = rows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) return emptyResult;
  const sortedPrices = [...prices].sort((a, b) => a - b);
  const median = sortedPrices[Math.floor(sortedPrices.length / 2)];
  const min = sortedPrices[0];
  const max = sortedPrices[sortedPrices.length - 1];

  const breakdown: HobbyIqFmvBreakdown = {
    bySource: {},
    byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 },
    byGradeQualifier: {},
  };
  for (const r of rows) {
    breakdown.bySource[r.source] = (breakdown.bySource[r.source] ?? 0) + 1;
    if (r.autoStyle === "on-card") breakdown.byAutoStyle.onCard++;
    else if (r.autoStyle === "sticker") breakdown.byAutoStyle.sticker++;
    else breakdown.byAutoStyle.unknown++;
    const q = r.gradeQualifier ?? "unqualified";
    breakdown.byGradeQualifier[q] = (breakdown.byGradeQualifier[q] ?? 0) + 1;
  }

  const trend = computeTrend(rows);

  const previewLimit = input.previewLimit ?? 10;
  const recentComps: HobbyIqFmvComp[] = rows.slice(0, previewLimit).map((r) => ({
    price: Number(r.price),
    soldAt: r.soldAt,
    source: r.source,
    parallel: r.parallel ?? null,
    autoStyle: r.autoStyle ?? null,
    gradeQualifier: r.gradeQualifier ?? null,
    url: r.url ?? null,
  }));

  return {
    slug,
    fmv: median,
    compCount: prices.length,
    min,
    max,
    breakdown,
    trend,
    recentComps,
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };
}

/** Trend estimation. n≥3 → OLS regression on (daysAgo, price); n<3 →
 *  anchor slope of last vs first divided by span. Sign convention:
 *  positive = appreciating. */
function computeTrend(rows: Array<{ price: number; soldAt: string }>): HobbyIqFmvTrend {
  const points = rows
    .map((r) => ({ price: Number(r.price), t: Date.parse(r.soldAt) }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) {
    return { direction: "flat", slopePerMonthPct: 0, method: "none" };
  }
  const nowMs = Date.now();
  if (points.length >= 3) {
    // OLS on price vs daysAgo (negative x = older). We're regressing
    // price on days-forward from earliest so slope is $/day.
    const xs = points.map((p) => (p.t - points[0].t) / 86_400_000);
    const ys = points.map((p) => p.price);
    const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
    const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - meanX) * (ys[i] - meanY);
      den += (xs[i] - meanX) * (xs[i] - meanX);
    }
    const slopePerDay = den > 0 ? num / den : 0;
    const slopePerMonthPct = meanY > 0 ? (slopePerDay * 30 / meanY) * 100 : 0;
    const direction = slopePerMonthPct > 1 ? "up" : slopePerMonthPct < -1 ? "down" : "flat";
    return { direction, slopePerMonthPct, method: "regression" };
  }
  // Two-point anchor slope
  const first = points[0], last = points[points.length - 1];
  const spanDays = (last.t - first.t) / 86_400_000;
  if (spanDays <= 0 || first.price <= 0) {
    return { direction: "flat", slopePerMonthPct: 0, method: "anchor" };
  }
  const slopePerMonthPct = ((last.price - first.price) / first.price) / spanDays * 30 * 100;
  const direction = slopePerMonthPct > 1 ? "up" : slopePerMonthPct < -1 ? "down" : "flat";
  return { direction, slopePerMonthPct, method: "anchor" };
}
