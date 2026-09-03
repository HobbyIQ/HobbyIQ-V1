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

function computeTrendWithBaseline(
  selectedRows: SaleRow[],
  priorMonthRows: SaleRow[],
  wMedian: number | null,
  nowMs: number,
  selectedWindow: number,
): {
  marketValue: number | null; predictedPrice: number | null;
  trendPctPerWeek: number | null; trendDirection: "up" | "down" | "flat";
} {
  if (wMedian === null) {
    return { marketValue: null, predictedPrice: null, trendPctPerWeek: null, trendDirection: "flat" };
  }

  // Strategy A — narrow window (<=7d) uses "prior month" as baseline.
  // Compare the tight window's median against the older-than-window
  // portion of the 30d pool. Works even with 3-4 samples in the tight
  // window, which is exactly when the wide-window 14d/14d split fails.
  if (selectedWindow <= 7 && priorMonthRows.length >= 3) {
    const cutoffMs = nowMs - selectedWindow * 86400_000;
    const olderThanWindow = priorMonthRows.filter((r) => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t < cutoffMs;
    });
    if (olderThanWindow.length >= 2) {
      const priorMed = weightedMedian(olderThanWindow, nowMs);
      if (priorMed && priorMed > 0) {
        const ratio = wMedian / priorMed;
        const capped = Math.max(0.5, Math.min(1.5, ratio));
        // For narrow windows: marketValue stays at wMedian (that IS the
        // current clearing price). predictedPrice projects the trend
        // forward 7 more days.
        const predicted = Math.round(wMedian * capped * 100) / 100;
        const pctPerWeek = Math.round((capped - 1) * 500) / 10;
        const direction: "up" | "down" | "flat" =
          Math.abs(pctPerWeek) < 1 ? "flat" : pctPerWeek > 0 ? "up" : "down";
        return { marketValue: wMedian, predictedPrice: predicted, trendPctPerWeek: pctPerWeek, trendDirection: direction };
      }
    }
  }

  // Strategy B — wider window (>=30d) does the classic 14d recent vs
  // prior split within the window. Same math the original engine uses.
  if (selectedRows.length >= 4) {
    const cutoffMs = nowMs - 14 * 86400_000;
    const recent = selectedRows.filter((r) => Date.parse(r.soldAt) >= cutoffMs);
    const prior = selectedRows.filter((r) => Date.parse(r.soldAt) < cutoffMs);
    if (recent.length >= 2 && prior.length >= 2) {
      const rMed = weightedMedian(recent, nowMs);
      const pMed = weightedMedian(prior, nowMs);
      if (rMed && pMed && pMed > 0) {
        const ratio = rMed / pMed;
        const capped = Math.max(0.5, Math.min(1.5, ratio));
        const marketValue = Math.round(wMedian * capped * 100) / 100;
        const predicted = Math.round(wMedian * Math.pow(capped, 1.5) * 100) / 100;
        const pctPerWeek = Math.round((capped - 1) * 500) / 10;
        const direction: "up" | "down" | "flat" =
          Math.abs(pctPerWeek) < 1 ? "flat" : pctPerWeek > 0 ? "up" : "down";
        return { marketValue, predictedPrice: predicted, trendPctPerWeek: pctPerWeek, trendDirection: direction };
      }
    }
  }

  // Fallback — no trend signal. Both values reflect the current median.
  return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat" };
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
  // POOL-1 residue (audit, 2026-09-03). The grade curve reads sold_comps
  // directly, not through exactPoolReader, and so inherited none of that
  // reader's adjudication filter: a row a human or a triage pass had already
  // marked `flaggedWrong` / `excludedFromFmv` still entered the tier's price
  // sample here. The curve IS the graded card's price (D21), so a wrong row
  // that the pool had removed still moved a published number.
  //
  // Same store-form predicate as exactPoolReader:84-85 -- `!= true` rather
  // than `= false`, with the NOT IS_DEFINED disjunct that keeps the
  // overwhelming majority of rows (which carry neither flag) in the sample.
  const clauses = [
    "c.price > 0",
    "c.soldAt >= @cutoff",
    "c.hobbyiqCardId = @slug",
    "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)",
    "(NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)",
  ];
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

// CF-ENRICH-HELPER (Drew, 2026-08-05). Shared enrichment used by BOTH
// grade-curve endpoints (/card-panel wrapper AND /observed-grade-curve)
// so the field-mapping logic doesn't drift between two copies. Mutates
// the provided `entries` array in place: overwrites CH-derived rows
// where a tree tier has real data, appends new rows for tree tiers the
// CH curve didn't include. Recomputes and returns the new total sample
// count so the header widget stays in sync.
//
// Returns null (and doesn't touch entries) when the tree has no data
// for this card — CH values then flow through unmodified.
export interface EnrichableEntry {
  grader: string;
  grade: number | string;
  sampleCount: number;
  weightedMedianPrice: number | null;
  trendAdjustedValue: number | null;
  predictedPriceAt30d: number | null;
  predictedPricePct: number | null;
  newestSaleDate: string | null;
  value: number | null;
  valueSource: string;
  confidenceScore: number;
  daysSinceNewestSale?: number | null;
  estimatedMultiplier?: number | null;
  estimatedFrom?: string | null;
  predictedPriceRangeLow?: number | null;
  predictedPriceRangeHigh?: number | null;
  trendAdjustmentPct?: number | null;
}

export async function enrichEntriesWithTree(
  entries: EnrichableEntry[],
  input: BuildTreeGradeCurveInput,
): Promise<{ totalSampleCount: number; tierCount: number } | null> {
  const tree = await buildTreeGradeCurve(input);
  if (!tree || tree.entries.length === 0) return null;
  // CF-GRADE-LABEL-BUGFIX (Drew, 2026-08-10). Same fix pattern as
  // compiq.routes.ts:3900 unified overlay. ObservedGradeEntry.grade
  // already contains the grader prefix (e.g. "PSA 10", "BGS 9.5"),
  // so `${grader} ${grade}` produced "PSA PSA 10" that never matched
  // tree.entries.gradeLabel="PSA 10". The map missed, the else-branch
  // pushed a duplicate entry, and iOS rendered PSA 9 / PSA 10 twice
  // (once from CANONICAL_GRADES, once from the appended tree row).
  const labelOf = (e: EnrichableEntry): string => {
    const gradeStr = String(e.grade).trim();
    return e.grader === "Raw" || gradeStr.toLowerCase() === "raw"
      ? "Raw" : gradeStr;
  };
  const byLabel = new Map<string, EnrichableEntry>(entries.map((e) => [labelOf(e), e]));
  for (const t of tree.entries) {
    if (t.sampleCount === 0) continue;
    const existing = byLabel.get(t.gradeLabel);
    if (existing) {
      existing.sampleCount = t.sampleCount;
      existing.weightedMedianPrice = t.weightedMedian;
      existing.trendAdjustedValue = t.marketValue;
      existing.predictedPriceAt30d = t.predictedPrice;
      existing.predictedPricePct = t.trendPctPerWeek;
      existing.newestSaleDate = t.newestSaleAt;
      existing.valueSource = "observed";
      existing.confidenceScore = t.confidence;
      existing.value = t.weightedMedian;
      existing.trendAdjustmentPct = t.trendPctPerWeek;
    } else {
      entries.push({
        grader: t.gradeCompany ?? "Raw",
        grade: t.gradeValue ?? "Raw",
        sampleCount: t.sampleCount,
        weightedMedianPrice: t.weightedMedian,
        trendAdjustedValue: t.marketValue,
        predictedPriceAt30d: t.predictedPrice,
        predictedPricePct: t.trendPctPerWeek,
        newestSaleDate: t.newestSaleAt,
        value: t.weightedMedian,
        valueSource: "observed",
        confidenceScore: t.confidence,
        daysSinceNewestSale: t.newestSaleAt
          ? Math.round((Date.now() - Date.parse(t.newestSaleAt)) / 86400_000)
          : null,
        estimatedMultiplier: null,
        estimatedFrom: null,
        predictedPriceRangeLow: null,
        predictedPriceRangeHigh: null,
        trendAdjustmentPct: t.trendPctPerWeek,
      });
    }
  }
  const totalSampleCount = entries.reduce((n, e) => n + (typeof e.sampleCount === "number" ? e.sampleCount : 0), 0);
  return { totalSampleCount, tierCount: tree.entries.length };
}

export async function buildTreeGradeCurve(input: BuildTreeGradeCurveInput): Promise<TreeGradeCurveResult | null> {
  const conts = getContainers();
  if (!conts) return null;
  const { catalog, soldComps } = conts;

  // Resolve variantSlug (== hobbyiqCardId for now) from the input.
  //   1. Caller-provided hobbyiqCardId wins if present.
  //   2. Otherwise try card_catalog by id/cardId/hobbyiqCardId — hits
  //      slug or canonical rows.
  //   3. Otherwise try sold_comps by cardId — catches Cardsight/vendor
  //      IDs that the URL layer passes through. sold_comps stores both
  //      cardId (vendor) and hobbyiqCardId, so one point lookup returns
  //      the mapping.
  let variantSlug: string | null = input.hobbyiqCardId ?? null;
  if (!variantSlug) {
    try {
      const { resources } = await catalog.items.query<{ hobbyiqCardId?: string }>({
        query: "SELECT TOP 1 c.hobbyiqCardId FROM c WHERE c.id = @id OR c.cardId = @id OR c.hobbyiqCardId = @id",
        parameters: [{ name: "@id", value: input.cardIdOrSlug }],
      }, { maxItemCount: 1 }).fetchAll();
      variantSlug = resources[0]?.hobbyiqCardId ?? null;
    } catch { /* try sold_comps next */ }
  }
  if (!variantSlug) {
    try {
      const { resources } = await soldComps.items.query<{ hobbyiqCardId?: string }>({
        query: "SELECT TOP 1 c.hobbyiqCardId FROM c WHERE c.cardId = @id AND IS_DEFINED(c.hobbyiqCardId) AND c.hobbyiqCardId != null",
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
    // CF-GRADE-NODE-NULL-VALUE-FILTER (Drew, 2026-08-06). Skip malformed
    // grade nodes where company is set but value is null — these come
    // from sold_comps rows where a source tagged "PSA" without a numeric
    // grade. They render as ghost "PSA 10 with no data" rows next to
    // the real PSA 10 tier because the UI defaults null → 10 for display.
    treeNodes = resources.filter((g) => {
      if (g.gradeCompany && (g.gradeValue === null || g.gradeValue === undefined)) return false;
      return true;
    });
  } catch { /* leave empty */ }
  if (treeNodes.length === 0) return null;

  const nowMs = Date.now();
  const entries: TreeGradeEntry[] = [];
  let totalSampleCount = 0;

  // CF-GRADE-CURVE-SERIAL-FANOUT (Drew, 2026-08-15: "the search takes
  // easily 10 seconds"). This was `for (const g of treeNodes)` with an
  // `await` inside, so every grade node waited for the one before it. Each
  // node then walks WINDOWS = [7,30,60,90,180] until it finds MIN_SAMPLES,
  // so a card with 15 grade tiers could serialize ~75 Cosmos round trips
  // into one request. Measured against prod: search p50 1.91s but p90
  // 10.29s, and latency tracked the number of Cosmos calls almost exactly
  // (289 calls per search under 2s, 618 per search over 10s).
  //
  // The grades are independent — the body only accumulates a commutative
  // sum and pushes an entry, and `entries` is explicitly sorted by grader
  // and tier immediately afterwards — so ordering never depended on the
  // loop order. Fan the nodes out and keep the WINDOWS walk serial inside
  // each, since that one is a deliberate widening search that breaks as
  // soon as it has enough samples.
  const perGrade = await Promise.all(treeNodes.map(async (g) => {
    let selectedRows: SaleRow[] = [];
    let selectedWindow = 180;
    let priorMonthRows: SaleRow[] = [];
    for (const w of WINDOWS) {
      const rows = await fetchSalesForGrade(soldComps, variantSlug, g.gradeCompany, g.gradeValue, w);
      if (rows.length >= MIN_SAMPLES) {
        selectedRows = rows;
        selectedWindow = w;
        // CF-7D-FORECAST-BASELINE (Drew, 2026-08-05). For narrow (<=30d)
        // selected windows, fetch the 30d window separately so we have
        // a "prior month" baseline for trend even when the selected
        // window is too tight to split internally. Cheap query — same
        // partition, wider cutoff.
        if (w < 30) {
          priorMonthRows = await fetchSalesForGrade(soldComps, variantSlug, g.gradeCompany, g.gradeValue, 30);
        }
        break;
      }
      selectedRows = rows;
      selectedWindow = w;
    }
    const wMed = weightedMedian(selectedRows, nowMs);
    const trend = computeTrendWithBaseline(selectedRows, priorMonthRows, wMed, nowMs, selectedWindow);
    const newestMs = selectedRows.reduce<number>((mx, r) => {
      const t = Date.parse(r.soldAt);
      return Number.isFinite(t) && t > mx ? t : mx;
    }, 0);
    const conf = confidenceFor(selectedRows.length, newestMs || null, nowMs);
    // CF-TOTAL-SALES-LIFETIME (Drew, 2026-08-06). Prior sum used
    // selectedRows.length which is the tightest-window count per tier
    // (often 5-38 for popular cards where each tier narrows to 7d/30d).
    // Displayed as "X total sales across grades" that reads like the
    // WHOLE pool is 60-80 sales for Ohtani when reality is 793. Use
    // observedSalesAtBuild (the tree's lifetime count at build) when
    // present, fall back to selectedRows.length only if the tree node
    // didn't get counted at build time.
    return {
      sampleContribution: g.observedSalesAtBuild ?? selectedRows.length,
      entry: {
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
      } satisfies TreeGradeEntry,
    };
  }));

  for (const r of perGrade) {
    totalSampleCount += r.sampleContribution;
    entries.push(r.entry);
  }

  // Sort: Raw first, then PSA descending, then BGS, SGC, CGC descending.
  const rank = (e: TreeGradeEntry): number => {
    if (!e.gradeCompany) return 0;
    const base = { PSA: 100, BGS: 200, SGC: 300, CGC: 400, CSG: 500, HGA: 600 }[e.gradeCompany] ?? 900;
    return base - (e.gradeValue ?? 0);
  };
  entries.sort((a, b) => rank(a) - rank(b));

  // CF-GRADE-CURVE-MONOTONIC (Drew, 2026-08-06, revised same day).
  // Grade tiles must ascend WITHIN a grader. Removed the Raw-as-floor
  // rule — Raw and graded pools are different markets, Raw's weighted
  // median can legitimately exceed some PSA tiers when the Raw pool
  // contains high-end sales the low PSA tier doesn't. Only enforce
  // ascending PSA 8 ≤ PSA 9 ≤ PSA 10, BGS 8 ≤ 9 ≤ 9.5 ≤ 10 within
  // each grader.
  const graders = new Set(entries.map((e) => e.gradeCompany).filter((g): g is string => !!g));
  for (const grader of graders) {
    const tierRows = entries
      .filter((e) => e.gradeCompany === grader && typeof e.gradeValue === "number")
      .sort((a, b) => (a.gradeValue as number) - (b.gradeValue as number));
    let prevFloor: number | null = null;
    for (const t of tierRows) {
      const own = t.marketValue ?? t.weightedMedian ?? null;
      if (prevFloor !== null && own !== null && own < prevFloor) {
        t.marketValue = prevFloor;
        t.weightedMedian = prevFloor;
        if (t.predictedPrice !== null && t.predictedPrice < prevFloor) {
          t.predictedPrice = prevFloor;
        }
      } else if (own !== null) {
        prevFloor = own;
      }
    }
  }

  return { variantSlug, entries, totalSampleCount };
}
