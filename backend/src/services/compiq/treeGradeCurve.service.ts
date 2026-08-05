// CF-TREE-GRADE-CURVE (Drew, 2026-08-05).
//
// Reads Grade nodes for a variant from the Card→Variant→Grade tree and
// prices each one by querying sold_comps directly for that (variant,
// gradeCompany, gradeValue) triple. Returns the tier list the tree
// knows about, each populated with real market value + 7d/30d trend.
//
// This is what the /card-panel and /observed-grade-curve routes call
// when the tree has data for the requested card. When the tree has no
// data (year not built yet), callers fall back to the CH-based grade
// curve as before.
//
// Design:
//   1. Resolve variantSlug from the request's cardId
//   2. Query card_catalog: SELECT c.gradeLabel, c.gradeCompany, c.gradeValue
//      FROM c WHERE kind = "grade" AND variantSlug = @slug
//   3. For each grade node, run a targeted sold_comps aggregation:
//        window: 7d if >=3 sales else 30d else 60d else 90d
//        median + trend from that window's samples
//   4. Return per-tier: label, sampleCount, marketValue, weightedMedian,
//      predictedPrice, trend direction, confidence
//
// All queries are scoped to variantSlug = hobbyiqCardId (existing
// sold_comps schema). Post sold_comps re-link this becomes single-
// partition reads on gradeId; for now it's cross-partition scoped
// to the variant's slug.

import { CosmosClient, type Container } from "@azure/cosmos";

const DB = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SC = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";
let _catalog: Container | null = null;
let _soldComps: Container | null = null;
function getContainers(): { catalog: Container; soldComps: Container } | null {
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) return null;
  if (!_catalog || !_soldComps) {
    const client = new CosmosClient(conn);
    _catalog = client.database(DB).container("card_catalog");
    _soldComps = client.database(DB).container(SC);
  }
  return { catalog: _catalog!, soldComps: _soldComps! };
}

// Window cascade for per-grade pricing. Tighter than unified's global
// cascade because per-tier signal is thinner. First tier that hits
// >=3 sales wins.
const WINDOWS = [7, 30, 60, 90, 180];
const MIN_SAMPLES = 3;

export interface TreeGradeEntry {
  gradeLabel: string;
  gradeCompany: string | null;
  gradeValue: number | null;
  windowDays: number;
  sampleCount: number;
  weightedMedian: number | null;
  marketValue: number | null;
  predictedPrice: number | null;
  trendDirection: "up" | "down" | "flat";
  trendPctPerWeek: number | null;
  confidence: number;
  newestSaleAt: string | null;
  observedAtBuild: number;
}

export interface TreeGradeCurveResult {
  variantSlug: string;
  entries: TreeGradeEntry[];
  totalSampleCount: number;
}

interface SaleRow { price: number; soldAt: string; }

function weightedMedian(rows: SaleRow[], nowMs: number): number | null {
  if (rows.length === 0) return null;
  const HALF_LIFE_DAYS = 14;
  const weighted = rows.map((r) => {
    const t = Date.parse(r.soldAt);
    const days = Number.isFinite(t) ? Math.max(0, (nowMs - t) / 86400_000) : 30;
    return { p: r.price, w: Math.exp(-days / HALF_LIFE_DAYS) };
  }).sort((a, b) => a.p - b.p);
  const totalW = weighted.reduce((s, x) => s + x.w, 0);
  if (totalW <= 0) return null;
  let acc = 0;
  for (const x of weighted) {
    acc += x.w;
    if (acc >= totalW / 2) return Math.round(x.p * 100) / 100;
  }
  return weighted[weighted.length - 1].p;
}

function plainMedian(rows: SaleRow[]): number | null {
  if (rows.length === 0) return null;
  const s = rows.map((r) => r.price).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2 * 100) / 100 : s[mid];
}

function computeTrend(rows: SaleRow[], wMedian: number | null, nowMs: number): {
  marketValue: number | null; predictedPrice: number | null;
  trendPctPerWeek: number | null; trendDirection: "up" | "down" | "flat";
} {
  if (wMedian === null || rows.length < 4) {
    return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
  }
  const cutoffMs = nowMs - 14 * 86400_000;
  const recent = rows.filter((r) => Date.parse(r.soldAt) >= cutoffMs);
  const prior = rows.filter((r) => Date.parse(r.soldAt) < cutoffMs);
  if (recent.length < 2 || prior.length < 2) {
    return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
  }
  const rMed = weightedMedian(recent, nowMs);
  const pMed = weightedMedian(prior, nowMs);
  if (!rMed || !pMed || pMed <= 0) {
    return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
  }
  const ratio = rMed / pMed;
  const capped = Math.max(0.5, Math.min(1.5, ratio));
  const marketValue = Math.round(wMedian * capped * 100) / 100;
  const predicted = Math.round(wMedian * Math.pow(capped, 1.5) * 100) / 100;
  const pctPerWeek = Math.round((capped - 1) * 500) / 10;
  const direction: "up" | "down" | "flat" =
    Math.abs(pctPerWeek) < 1 ? "flat" : pctPerWeek > 0 ? "up" : "down";
  return { marketValue, predictedPrice: predicted, trendPctPerWeek: pctPerWeek, trendDirection: direction };
}

function confidenceFor(n: number, newestMs: number | null, nowMs: number): number {
  if (n === 0) return 0;
  const sampleScore = Math.min(1, n / 10);
  const daysOld = newestMs ? Math.max(0, (nowMs - newestMs) / 86400_000) : 180;
  const recencyScore = Math.max(0, 1 - daysOld / 90);
  return Math.round((sampleScore * 0.6 + recencyScore * 0.4) * 100) / 100;
}

async function fetchSalesForGrade(
  soldComps: Container,
  variantSlug: string,
  gradeCompany: string | null,
  gradeValue: number | null,
  windowDays: number,
): Promise<SaleRow[]> {
  const cutoff = new Date(Date.now() - windowDays * 86400_000).toISOString();
  const clauses = ["c.price > 0", "c.soldAt >= @cutoff", "c.hobbyiqCardId = @slug"];
  const params: Array<{ name: string; value: string | number | null }> = [
    { name: "@slug", value: variantSlug },
    { name: "@cutoff", value: cutoff },
  ];
  if (gradeCompany) {
    clauses.push("UPPER(c.gradeCompany) = @gc");
    params.push({ name: "@gc", value: gradeCompany.toUpperCase() });
    if (gradeValue !== null) {
      clauses.push("(c.gradeValue = @gv OR c.gradeValue = @gvStr)");
      params.push({ name: "@gv", value: gradeValue });
      params.push({ name: "@gvStr", value: String(gradeValue) });
    }
  } else {
    clauses.push("(NOT IS_DEFINED(c.gradeCompany) OR c.gradeCompany = null)");
  }
  try {
    const { resources } = await soldComps.items.query<SaleRow>({
      query: `SELECT c.price, c.soldAt FROM c WHERE ${clauses.join(" AND ")}`,
      parameters: params,
    }, { maxItemCount: 500 }).fetchAll();
    return resources.filter((r) => Number.isFinite(r.price) && r.price > 0 && !!r.soldAt);
  } catch { return []; }
}

export interface BuildTreeGradeCurveInput {
  cardIdOrSlug: string;
  hobbyiqCardId?: string | null;
}

export async function buildTreeGradeCurve(input: BuildTreeGradeCurveInput): Promise<TreeGradeCurveResult | null> {
  const conts = getContainers();
  if (!conts) return null;
  const { catalog, soldComps } = conts;

  // Resolve variantSlug (== hobbyiqCardId for now) from the input.
  let variantSlug: string | null = input.hobbyiqCardId ?? null;
  if (!variantSlug) {
    try {
      const { resources } = await catalog.items.query<{ hobbyiqCardId?: string }>({
        query: "SELECT TOP 1 c.hobbyiqCardId FROM c WHERE c.id = @id OR c.cardId = @id OR c.hobbyiqCardId = @id",
        parameters: [{ name: "@id", value: input.cardIdOrSlug }],
      }, { maxItemCount: 1 }).fetchAll();
      variantSlug = resources[0]?.hobbyiqCardId ?? null;
    } catch { /* leave null */ }
  }
  if (!variantSlug) return null;

  // Query tree: which Grade nodes exist for this variant?
  interface GradeNode {
    gradeLabel: string;
    gradeCompany: string | null;
    gradeValue: number | null;
    observedSalesAtBuild?: number;
  }
  let treeNodes: GradeNode[] = [];
  try {
    const { resources } = await catalog.items.query<GradeNode>({
      query: `SELECT c.gradeLabel, c.gradeCompany, c.gradeValue, c.observedSalesAtBuild
              FROM c WHERE c.kind = "grade" AND c.variantSlug = @slug`,
      parameters: [{ name: "@slug", value: variantSlug }],
    }, { maxItemCount: 200 }).fetchAll();
    treeNodes = resources;
  } catch { /* leave empty */ }
  if (treeNodes.length === 0) return null;

  const nowMs = Date.now();
  const entries: TreeGradeEntry[] = [];
  let totalSampleCount = 0;

  for (const g of treeNodes) {
    let selectedRows: SaleRow[] = [];
    let selectedWindow = 180;
    for (const w of WINDOWS) {
      const rows = await fetchSalesForGrade(soldComps, variantSlug, g.gradeCompany, g.gradeValue, w);
      if (rows.length >= MIN_SAMPLES) {
        selectedRows = rows;
        selectedWindow = w;
        break;
      }
      selectedRows = rows;
      selectedWindow = w;
    }
    const wMed = weightedMedian(selectedRows, nowMs);
    const trend = computeTrend(selectedRows, wMed, nowMs);
    const newestMs = selectedRows.reduce<number>((mx, r) => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t > mx ? t : mx;
    }, 0);
    const conf = confidenceFor(selectedRows.length, newestMs || null, nowMs);
    totalSampleCount += selectedRows.length;
    entries.push({
      gradeLabel: g.gradeLabel,
      gradeCompany: g.gradeCompany,
      gradeValue: g.gradeValue,
      windowDays: selectedWindow,
      sampleCount: selectedRows.length,
      weightedMedian: wMed,
      marketValue: trend.marketValue,
      predictedPrice: trend.predictedPrice,
      trendDirection: trend.trendDirection,
      trendPctPerWeek: trend.trendPctPerWeek,
      confidence: conf,
      newestSaleAt: newestMs > 0 ? new Date(newestMs).toISOString() : null,
      observedAtBuild: g.observedSalesAtBuild ?? 0,
    });
  }

  // Sort: Raw first, then PSA descending, then BGS, SGC, CGC descending.
  const rank = (e: TreeGradeEntry): number => {
    if (!e.gradeCompany) return 0;
    const base = { PSA: 100, BGS: 200, SGC: 300, CGC: 400, CSG: 500, HGA: 600 }[e.gradeCompany] ?? 900;
    return base - (e.gradeValue ?? 0);
  };
  entries.sort((a, b) => rank(a) - rank(b));

  return { variantSlug, entries, totalSampleCount };
}
