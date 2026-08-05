// CF-HOBBYIQ-FMV (Drew, 2026-07-23, "we set the market" surface).
// Public HobbyIQ price for a canonical hobbyiqCardId slug. Reads from
// OUR sold_comps pool (not vendor calls). No vendor attribution — this
// is HobbyIQ's own price.
//
// Design principles:
//   - Deterministic given (slug, grade filter): same inputs → same output.
//   - Zero vendor calls. Every byte comes from sold_comps rows we own.
//   - NEVER returns "no data" when we can compute something reasonable.
//     Fallback ladder — direct-slug → cross-printRun → sibling-parallel
//     → family-baseline. First rung that produces ≥1 comp wins; the
//     `method` field records which rung fired so iOS can render a
//     confidence hint.
//   - Rich breakdown: comp count by source, autoStyle mix, gradeQualifier
//     mix, recent comps with all fields iOS wants for badges.
//   - Trend: OLS regression when n≥3; anchor slope when n=2; flat below.

import { CosmosClient, type Container } from "@azure/cosmos";
import { parseHobbyIqCardId, slugify } from "./hobbyIqCardId.service.js";
import { loadPopulationForSlug, type CardPopulationLookup } from "./cardPopulationLookup.service.js";
import { getGraderPremium } from "../compiq/compiqEstimate.service.js";
import { projectNextSaleFromComps } from "../compiq/nextSaleProjection.service.js";
import { fetchPlayerInSetMomentum, momentumMultiplierToPctPerMonth } from "../compiq/playerInSetMomentum.service.js";
import { findNeighborComps, compositeFilterFromCardId, summarizeByDistance } from "./findNeighborComps.service.js";
import { computeAxisAdjustment, getLatestMomentum } from "./marketMomentum.service.js";

// CF-HOBBYIQ-FMV-INCLUDE-USER-PURCHASE (Drew, 2026-07-27). Reverses the
// 2026-07-24 exclusion of source="ebay-user-purchase". The rationale
// for excluding was "cost-basis inflation" — a user paying above market
// for a card and that price becoming their own FMV. In practice the
// exclusion silently killed direct-slug matches for cards where the
// user's own eBay purchase is the primary or only comp, causing:
//   - Devin Taylor Gold Wave Refractor PSA 9: 1 real PSA 9 sale at $196
//     was excluded → engine walked to sibling-parallel base auto at $22.
//   - Eric Hartman Orange Shimmer PSA 10: dropped from 3→2 raw direct
//     comps, below the ≥3 threshold in grade-cross-raw rung 7 → walked
//     to sibling-parallel median $110 × PSA10 mult, priced at $258
//     instead of using the actual $1531/$1190/$1185 direct-slug pool.
//
// ebay-user-purchase IS a real market transaction (someone SOLD to the
// user). Cost-basis-inflation risk is handled by the qualityFlags
// system (price-outlier drops from the pool). Trust that layer to catch
// overpays; don't silently blacklist a whole source class.
//
// canonicalFmv.service.ts:950 already INCLUDES ebay-user-purchase in
// its allowed sources; hobbiq-fmv now matches that treatment.
const EXCLUDED_SOURCES: readonly string[] = [];

// CF-HOBBYIQ-FMV-QUALITY-FLAGS (Drew, 2026-07-24). Rows tagged with any
// of these qualityFlags are structurally suspect and should not anchor
// the median. They stay in sold_comps for the "flagged comps" UI and
// downstream inspection, but the FMV endpoint filters them out.
// CF-USER-COMP-FLAG (Drew, 2026-07-26). "user-flagged" is added when
// the flag-comp endpoint receives a user report. Drops the comp from
// FMV compute the same way the algorithmic flags do. See
// flagComp.service.ts for the write path + threshold logic.
const FILTER_QUALITY_FLAGS = ["price-outlier", "raw-priced-like-graded", "same-day-same-slug-dupe", "user-flagged"];

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
  bySource: Record<string, number>;
  byAutoStyle: {
    onCard: number;
    sticker: number;
    unknown: number;
  };
  byGradeQualifier: Record<string, number>;
}

export interface HobbyIqFmvTrend {
  direction: "up" | "down" | "flat";
  slopePerMonthPct: number;
  method: "regression" | "anchor" | "none";
}

/** Which rung of the fallback ladder produced the number. */
export type HobbyIqFmvMethod =
  | "direct-slug"                // exact slug + grade match (highest confidence)
  | "cross-setkey"               // same year+cardNumber+parallel+isAuto+sport, ANY setKey — rescues cards where ingest fragmentation put the same physical card under different product slugs (e.g. "bowman" vs "bowman-chrome" vs "chrome-prospects-autographs" for the same CPA-EHA auto). Higher confidence than sibling-parallel because parallel still matches; slightly lower than direct-slug because setKey unification means the pool crosses ingest variants.
  | "cross-printrun"             // same identity ignoring printRun (specific variants exist, this one doesn't)
  | "same-printrun-cross-parallel" // same cardNumber + auto + printRun, other parallels (best sibling for numbered cards)
  | "printrun-discovery"         // target has no printRun; find the DOMINANT printRun for this identity and use it
  | "sibling-parallel"           // same cardNumber + auto, different parallels (all variants of the same card)
  | "family-baseline"            // same year + cardNumber, any variant (broadest same-card fallback)
  | "grade-cross-raw"            // grade requested but no graded comps at any rung; raw median × graded multiplier
  | "composite-neighbor"         // CF-HOBBYIQFMV-COMPOSITE (Drew, 2026-07-30). Composite axis-drop pool + per-axis calibration multipliers. Runs BEFORE the legacy string-slug ladder when HOBBYIQFMV_COMPOSITE_ENABLED=true and target has enough enriched neighbors.
  | "no-basis";                  // truly nothing — should be rare after the ladder

export interface HobbyIqFmvResult {
  slug: string;
  fmv: number | null;
  compCount: number;
  min: number | null;
  max: number | null;
  breakdown: HobbyIqFmvBreakdown;
  trend: HobbyIqFmvTrend;
  recentComps: HobbyIqFmvComp[];
  /** CF-HOBBYIQ-FMV-LADDER (Drew, 2026-07-23). Which rung produced the
   *  fmv. iOS can render a confidence indicator + human-readable note. */
  method: HobbyIqFmvMethod;
  basisNote: string;
  confidence: number;      // 0.0-1.0
  /** CF-HOBBYIQ-FMV-POPULATION (Drew, 2026-07-24). Per-grader graded
   *  population for the resolved card identity. Present when card_population
   *  has data for this card; null when the fill hasn't reached it yet or
   *  Cardsight has no pop data for the SKU. iOS renders a scarcity badge
   *  (e.g. "PSA10 pop 47"). NOT yet used in fmv math — that comes with
   *  scarcity multiplier calibration in a follow-up. */
  population: CardPopulationLookup | null;
  /** CF-HOBBYIQ-FMV-QUALITY (Drew, 2026-07-24). Trust indicator for the
   *  FMV number, on a 0.0-1.0 scale. Combines comp count, freshness,
   *  source diversity, and how many nearby comps were dropped as flagged
   *  by the comp-quality framework. iOS renders this as a progress bar
   *  or badge separate from `method`/`confidence`. */
  quality: {
    score: number;             // 0.0-1.0
    flaggedCompCount: number;  // # comps dropped as unreliable at the winning rung
    sources: string[];         // distinct sources contributing to the winning pool
  };
  computedAt: string;
  cachedFrom: "sold_comps";
}

interface PoolRow {
  price: number;
  soldAt: string;
  source: string;
  parallel?: string | null;
  autoStyle?: "on-card" | "sticker" | null;
  gradeQualifier?: string | null;
  url?: string | null;
  isAuto?: boolean;
  printRun?: number | null;
  gradeCompany?: string | null;
  gradeValue?: number | null;
  qualityFlags?: string[];
  // Included only so the cross-setKey rung can count distinct source
  // slug variants for its basisNote; not consumed by anything else.
  hobbyiqCardId?: string;
  // CF-HOBBYIQ-FMV-PROJECT-NOT-MEDIAN (Drew, 2026-07-28). Player+product
  // pulled off the pool row so buildResult can fetch matched-cohort /
  // player-in-set momentum without re-querying by slug (which the
  // service already parsed). Enables the direct-slug path to project
  // next sale via nextSaleProjection.service.ts instead of returning
  // a bare median — the golden-rule fix that surfaced on Hartshorn
  // Blue Auto (2 same-day $608 comps medianed to $608, ignored a
  // meaningful player momentum signal).
  playerName?: string | null;
  product?: string | null;
  cardYear?: number | null;
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

/** Fetch rows by an arbitrary SQL WHERE clause. Encapsulates the
 *  cross-partition query + freshness + column list. */
async function queryPool(
  container: Container,
  whereClause: string,
  parameters: Array<{ name: string; value: string | number | boolean | null }>,
  cutoffIso: string,
): Promise<PoolRow[]> {
  const params = [
    ...parameters,
    { name: "@from", value: cutoffIso },
  ];
  try {
    // Cosmos SQL rejects "NOT IN ()" (empty tuple), so only append the
    // source-exclusion clause when we actually have sources to exclude.
    // Otherwise every query silently errors → try/catch returns [] →
    // every rung on every request returns no-basis (this is the bug
    // the empty-EXCLUDED_SOURCES change tripped on 2026-07-27).
    const sourceClause = EXCLUDED_SOURCES.length > 0
      ? ` AND c.source NOT IN (${EXCLUDED_SOURCES.map((s) => `'${s}'`).join(", ")})`
      : "";
    // CF-FLAG-CARDSIGHT-099 (Drew, 2026-08-05). Drop rows that other
    // subsystems have already tagged as bad-identity/bad-price. Matches
    // findNeighborComps line 187; catches the 39K cardsight $0.99
    // pollution and any other flaggedWrong rows across the pool.
    const { resources } = await container.items.query({
      query: `SELECT c.price, c.soldAt, c.source, c.parallel, c.autoStyle, c.gradeQualifier, c.url,
                     c.isAuto, c.printRun, c.gradeCompany, c.gradeValue, c.qualityFlags,
                     c.hobbyiqCardId, c.playerName, c.product, c.cardYear
              FROM c
              WHERE ${whereClause} AND c.soldAt > @from${sourceClause}
                AND (NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong = false)
              ORDER BY c.soldAt DESC`,
      parameters: params,
    }).fetchAll();
    return resources as PoolRow[];
  } catch {
    return [];
  }
}

/** Partition rows into { kept, flagged } based on qualityFlags. Any row
 *  with a flag in FILTER_QUALITY_FLAGS is dropped from FMV computation
 *  but counted so the response can emit flaggedCompCount. */
function partitionByQuality(rows: PoolRow[]): { kept: PoolRow[]; flagged: PoolRow[] } {
  const kept: PoolRow[] = [];
  const flagged: PoolRow[] = [];
  for (const r of rows) {
    const flags = Array.isArray(r.qualityFlags) ? r.qualityFlags : [];
    if (flags.some((f) => FILTER_QUALITY_FLAGS.includes(f))) flagged.push(r);
    else kept.push(r);
  }
  return { kept, flagged };
}

/** Compute a 0.0-1.0 quality score for a winning pool. */
function computeQualityScore(kept: PoolRow[], flagged: PoolRow[]): {
  score: number; flaggedCompCount: number; sources: string[];
} {
  const n = kept.length;
  const flaggedCount = flagged.length;
  const total = n + flaggedCount;
  const sources = [...new Set(kept.map((r) => r.source).filter(Boolean))];
  const compTerm = 1 - Math.exp(-n / 20);
  let freshTerm = 0;
  if (n > 0) {
    const mostRecent = Math.max(...kept.map((r) => Date.parse(r.soldAt) || 0));
    const daysAgo = (Date.now() - mostRecent) / 86_400_000;
    freshTerm = daysAgo <= 30 ? 1 : daysAgo <= 60 ? 1 - (daysAgo - 30) / 30 : 0;
  }
  const sourceBonus = sources.length >= 2 ? 0.1 : 0;
  const flagPenalty = total > 0 ? -0.25 * (flaggedCount / total) : 0;
  const raw = 0.55 * compTerm + 0.30 * freshTerm + sourceBonus + flagPenalty;
  const score = Math.max(0, Math.min(1, raw));
  return { score, flaggedCompCount: flaggedCount, sources };
}

/** Apply the caller's grade filter in-JS (SQL side is optimistic; JS
 *  handles the null-vs-undefined case that Cosmos SQL fumbles). */
function filterByGrade(
  rows: PoolRow[],
  gradeCompany: string | null,
  gradeValue: number | null,
): PoolRow[] {
  const isRawRequest = !gradeCompany && gradeValue === null;
  return rows.filter((r) => {
    const docCompany = typeof r.gradeCompany === "string"
      ? r.gradeCompany.trim().toUpperCase()
      : "";
    const docValue = typeof r.gradeValue === "number" && Number.isFinite(r.gradeValue)
      ? r.gradeValue
      : null;
    const docIsRaw = docCompany === "" && docValue === null;
    if (isRawRequest) return docIsRaw;
    return docCompany === (gradeCompany ?? "").trim().toUpperCase()
      && docValue === gradeValue;
  });
}

export async function computeHobbyIqFmv(input: HobbyIqFmvInput): Promise<HobbyIqFmvResult> {
  const slug = String(input.hobbyiqCardId ?? "").trim();
  const now = new Date();

  const noBasis: HobbyIqFmvResult = {
    slug,
    fmv: null,
    compCount: 0,
    min: null,
    max: null,
    breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
    trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
    recentComps: [],
    method: "no-basis",
    basisNote: "No comparable sales in the last 180 days",
    confidence: 0,
    population: null,
    quality: { score: 0, flaggedCompCount: 0, sources: [] },
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };

  if (!slug || !slug.startsWith("hiq:")) return noBasis;

  // CF-UNIFIED-PRICING-CONVERGE (Drew, 2026-08-04). Portfolio pricing
  // pipeline already bypasses this function via unified early-exit,
  // but external endpoints (/api/compiq/hobbyiq-fmv, /canonical-fmv,
  // /card-detail) still call it. Return unified pricing's numbers so
  // external consumers see the same fmv as portfolio + Grade Curve.
  //
  // fmv = unified.marketValue (trend-lifted current — the ONE number)
  // basisNote carries the math trace. Ladder + composite + rare-card
  // paths below only fire when unified has no data (thin pool).
  try {
    const { computeUnifiedPrice } = await import("../compiq/unifiedPricing.service.js");
    const gradeCo = typeof input.gradeCompany === "string" && input.gradeCompany.trim().length > 0
      ? input.gradeCompany.trim()
      : null;
    const gradeVal = typeof input.gradeValue === "number" && Number.isFinite(input.gradeValue)
      ? input.gradeValue
      : null;
    const u = await computeUnifiedPrice(slug, {
      hobbyiqCardId: slug,
      grade: gradeCo ? { company: gradeCo, value: gradeVal } : null,
    });
    const canonical = u.marketValue ?? u.fmv;
    if (canonical !== null && canonical > 0 && u.confidence >= 0.3) {
      return {
        slug,
        fmv: canonical,
        compCount: u.totalSampleCount,
        min: u.fmv,
        max: u.predictedPrice,
        breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
        trend: {
          direction: (u.trendDirection ?? "flat") as "up" | "down" | "flat",
          slopePerMonthPct: (u.trendPctPerWeek ?? 0) * 4,
          method: "regression",
        },
        recentComps: [],
        method: "unified-market-value" as any,
        basisNote: `unified: window=${u.windowDays}d median=$${u.fmv?.toFixed(0) ?? "?"} marketValue=$${u.marketValue?.toFixed(0) ?? "?"} predicted=$${u.predictedPrice?.toFixed(0) ?? "?"} trend=${u.trendDirection} ${u.trendPctPerWeek?.toFixed(1) ?? "?"}%/wk conf=${u.confidence.toFixed(2)}`,
        confidence: u.confidence,
        population: null,
        quality: { score: u.confidence, flaggedCompCount: 0, sources: ["unified"] },
        computedAt: now.toISOString(),
        cachedFrom: "sold_comps",
      };
    }
  } catch {
    // Never fails the fmv path — legacy ladder below stays as fallback.
  }

  const container = await getSoldCompsContainer();
  if (!container) return noBasis;

  const parsed = parseHobbyIqCardId(slug);
  if (!parsed) return noBasis;

  // CF-HOBBYIQFMV-COMPOSITE-PATH (Drew, 2026-07-30). When the flag is
  // on AND the target has enough composite-enriched comps, take the
  // composite axis-drop path FIRST — it produces a semantically
  // tighter pool than the string-slug widening rungs and applies
  // per-axis calibration multipliers to the projected next sale.
  // Falls through to the legacy 8-rung ladder on null return.
  if (process.env.HOBBYIQFMV_COMPOSITE_ENABLED === "true") {
    try {
      const compositeResult = await tryCompositePath(input, container, parsed, slug, now);
      if (compositeResult) return compositeResult;
    } catch { /* silent-safe — fall through to legacy */ }
  }

  // CF-RARE-CARD-ANCHOR-RUNG (Drew, 2026-08-02). Rare parallels
  // (1-of-1s, /5, /10, deep-vintage stars) fail the standard ladder —
  // their own pool has 0-2 comps in 180d so every rung returns thin
  // or no-basis. This rung anchors on the LAST actual sale for the
  // exact slug and projects forward by the parent pool's delta since
  // that sale. Runs BEFORE the ladder as an early-return when the
  // direct-slug pool is genuinely thin.
  try {
    const { computeRareCardFmv } = await import("./rareCardFmv.service.js");
    const rare = await computeRareCardFmv({ hobbyiqCardId: slug });
    if (rare.qualifies && rare.fmv !== null) {
      const population = await loadPopulationForSlug(slug).catch(() => null);
      return {
        slug,
        fmv: rare.fmv,
        compCount: (rare.lastSale ? 1 : 0) + (rare.parentComps.afterCount || 0),
        min: rare.confidenceBand?.low ?? rare.fmv,
        max: rare.confidenceBand?.high ?? rare.fmv,
        breakdown: {
          bySource: rare.lastSale ? { [rare.lastSale.source]: 1 } : {},
          byAutoStyle: { onCard: 0, sticker: 0, unknown: 1 },
          byGradeQualifier: {},
        },
        trend: {
          direction: (rare.parentDeltaPct ?? 0) > 0 ? "up" : (rare.parentDeltaPct ?? 0) < 0 ? "down" : "flat",
          slopePerMonthPct: rare.parentDeltaPct ?? 0,
          method: "anchor",
        },
        recentComps: rare.lastSale
          ? [{ price: rare.lastSale.price, soldAt: rare.lastSale.soldAt, source: rare.lastSale.source }]
          : [],
        method: "no-basis",   // no dedicated ladder rung name for rare-card-anchor yet; basisNote carries the detail
        basisNote: rare.basisNote,
        confidence: rare.parentDeltaPct !== null ? 0.65 : 0.45,
        population,
        quality: { score: rare.parentDeltaPct !== null ? 0.7 : 0.5, flaggedCompCount: 0, sources: rare.lastSale ? [rare.lastSale.source] : [] },
        computedAt: now.toISOString(),
        cachedFrom: "sold_comps",
      };
    }
    // rare.qualifies=false means the pool is NOT thin — normal ladder handles it
  } catch { /* silent-safe — fall through to legacy ladder */ }

  // Fire the population lookup in parallel with the first ladder rung. It
  // reads OUR containers (card_catalog → card_population) so it's cheap;
  // running it concurrently with the pool queries hides its latency.
  const populationPromise = loadPopulationForSlug(slug).catch(() => null);

  const maxAgeDays = input.maxAgeDays ?? 180;
  const cutoffIso = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();
  const gradeCompany = input.gradeCompany ?? null;
  const gradeValue = input.gradeValue ?? null;

  // CF-HOBBYIQ-FMV-BROADER-TREND-ANCHOR (Drew, 2026-07-28, revised
  // 2026-07-30). Read the same-identity broader-set trend ONCE per
  // computeHobbyIqFmv call and thread into every buildResult.
  //
  // ORIGINAL query pooled ANY parallel of same (year, cardNumber,
  // isAuto, sport). Problem: if recent sales are all BASE ($5) and
  // earlier sales were mixed with GOLD/RED ($200+), OLS regression
  // reads a huge negative slope — but that's a COLOR-MIX SHIFT over
  // time, not a market decay. Seen in A/B on 2026 Bowman CPA-BA
  // returning -41%/mo when the color mix was rotating from earlier
  // GOLD sales to recent BLUE and BASE.
  //
  // FIX: restrict the broader pool to the SAME colorFamily as the
  // target when the target row has a composite. That way OLS reads
  // the price trend of the specific variant class, not the mix. Falls
  // back to the wider pool when target lacks composite (unbackfilled).
  // Target's colorFamily comes from a quick composite lookup fired
  // alongside the trend query so it doesn't add serial latency.
  const targetCompositePromise = container.items.query<{ composite?: { colorFamily?: string | null } | null }>({
    query: "SELECT TOP 1 c.composite FROM c WHERE c.hobbyiqCardId = @slug",
    parameters: [{ name: "@slug", value: slug }],
  }).fetchAll().then(({ resources }) => resources[0]?.composite ?? null).catch(() => null);

  const broaderIdentityTrendPromise = targetCompositePromise.then(async (targetComp) => {
    const targetColor = targetComp?.colorFamily ?? null;
    const params: Array<{ name: string; value: string | number | boolean | null }> = [
      { name: "@y", value: parsed.year },
      { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
      { name: "@auto", value: parsed.isAuto },
      { name: "@sport", value: parsed.sport },
    ];
    let where = "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport";
    if (targetColor) {
      where += " AND c.composite.colorFamily = @cf";
      params.push({ name: "@cf", value: targetColor });
    }
    return queryPool(container, where, params, cutoffIso);
  })
    .then((broaderRows) => {
      const kept = partitionByQuality(broaderRows).kept;
      if (kept.length < 3) return null;
      const t = computeTrend(
        kept.map((r) => ({ price: Number(r.price), soldAt: r.soldAt })),
      );
      if (t.method !== "regression") return null;
      const slope = t.slopePerMonthPct;
      if (!Number.isFinite(slope)) return null;
      // Guard runaway trends. With same-color pool, real market
      // direction rarely exceeds ±25%/mo — anything larger is OLS
      // pathology from a tight same-week volume spike or a single
      // outlier. Cap tight.
      return Math.max(-25, Math.min(25, slope));
    })
    .catch(() => null);

  // ─── Rung 0 (PRE-empts direct-slug): printrun-discovery-preferred ──
  // When the target slug has NO printRun tag AND the identity has a
  // substantial pool of comps at a specific print run, that /N pool is
  // almost certainly the real physical card — direct-slug on the
  // no-printRun form would hit a ghost pool created by lossy title
  // parsing (some listings don't spell "/150" so their persist happens
  // without the printRun suffix). Fires only when the /N pool has >= 5
  // comps at a single print run, keeping this from misfiring on cards
  // that legitimately have no numbered variant (Base, unnumbered
  // Refractors, etc.).
  let rows: PoolRow[];
  if (parsed.printRun === null || parsed.printRun === undefined) {
    // Query without the parallel filter — c.parallel in sold_comps is
    // the human label ("Blue Refractor") but parsed.parallel is the
    // slug fragment ("blue-refractor"). Filter parallel in JS after slug
    // normalization.
    const identityRows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport AND IS_DEFINED(c.printRun) AND c.printRun != null",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
      ],
      cutoffIso,
    );
    // Filter by parallel using slug-side normalization on both sides.
    const targetParallelSlug = parsed.parallel;
    const parallelMatched = identityRows.filter((r) => slugify(r.parallel ?? "") === targetParallelSlug);
    const graded = filterByGrade(parallelMatched, gradeCompany, gradeValue);
    if (graded.length >= 5) {
      const byRun = new Map<number, PoolRow[]>();
      for (const r of graded) {
        const pr = Number(r.printRun);
        if (!Number.isFinite(pr)) continue;
        if (!byRun.has(pr)) byRun.set(pr, []);
        byRun.get(pr)!.push(r);
      }
      let bestRun: number | null = null;
      let bestPool: PoolRow[] = [];
      for (const [pr, pool] of byRun.entries()) {
        if (pool.length > bestPool.length) { bestRun = pr; bestPool = pool; }
      }
      if (bestPool.length >= 5) {
        return buildResult(slug, bestPool, "printrun-discovery",
          `Estimated from ${bestPool.length} sale${bestPool.length === 1 ? "" : "s"} of the /${bestRun} variant (dominant SKU at this identity — target slug is un-tagged)`,
          confidenceForRung("printrun-discovery", bestPool.length),
          input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
      }
    }
  }

  // ─── Rung 1: exact slug + grade ─────────────────────────────────────
  rows = await queryPool(
    container,
    "c.hobbyiqCardId = @slug",
    [{ name: "@slug", value: slug }],
    cutoffIso,
  );
  rows = filterByGrade(rows, gradeCompany, gradeValue);
  if (rows.length > 0) {
    return buildResult(slug, rows, "direct-slug",
      `Direct match: ${rows.length} sale${rows.length === 1 ? "" : "s"} of this exact card`,
      confidenceForRung("direct-slug", rows.length),
      input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
  }

  // ─── Rung 1.5 (NEW): cross-setKey identity + parallel ────────────────
  // Rescue for ingest-fragmentation: the same physical card is often
  // stored in sold_comps under multiple slug variants because CH,
  // Cardsight, and eBay emit different product strings that
  // normalizeSetKey maps to different setKeys (e.g. "bowman" vs
  // "bowman-chrome" vs "chrome-prospects-autographs" for the same
  // CPA-EHA Chrome Prospects Auto). Direct-slug misses those. Sibling-
  // parallel finds them but ALSO includes every other parallel at the
  // same cardNumber, diluting rare rainbow parallels to base-auto
  // medians. This rung threads the needle: query by
  // (year, cardNumber, isAuto, sport) — any setKey — then JS-filter to
  // the target parallel slug.
  //
  // Only fires when direct-slug came up empty. Higher confidence than
  // sibling-parallel because parallel identity still matches; slightly
  // lower than direct-slug because we're crossing ingest variants.
  //
  // CF-CATALOG-GAP-NO-BASIS (Drew, 2026-07-28). We also record whether
  // the target parallel had ANY comps at the identity, so the
  // sibling-parallel fallback can refuse to fabricate when a rare
  // parallel (Black /1, Superfractor, Red /5) has zero direct data.
  // Devin Taylor CPA-DT Black auto: pool has 461 comps across every
  // OTHER parallel, but zero at "Black" — walking to sibling-parallel
  // returned $4 for a card that cost $650. Better UX: emit no-basis
  // and route to verify_queue so Drew can spot-check.
  let targetParallelHadIdentityComps = false;
  {
    const identityRows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
      ],
      cutoffIso,
    );
    const targetParallelSlug = parsed.parallel;
    const parallelMatched = identityRows.filter(
      (r) => slugify(r.parallel ?? "") === targetParallelSlug,
    );
    targetParallelHadIdentityComps = parallelMatched.length > 0;
    // Only count as a hit if this rung finds MORE than direct-slug did
    // AND the target slug isn't already the "canonical" hit — otherwise
    // we'd return the same pool with a lower-confidence label. The
    // guard `direct-slug returned 0` is enforced by the empty-rows
    // check preceding this block.
    const graded = filterByGrade(parallelMatched, gradeCompany, gradeValue);
    if (graded.length > 0) {
      // Count distinct slugs unified — surfaced in basisNote so the
      // user can see how many ingest variants contributed.
      const distinctSlugs = new Set(graded.map((r) => (r as { hobbyiqCardId?: string }).hobbyiqCardId));
      const variantCount = distinctSlugs.size;
      const variantSuffix = variantCount > 1
        ? ` (unified across ${variantCount} ingest variants)`
        : "";
      return buildResult(slug, graded, "cross-setkey",
        `Estimated from ${graded.length} sale${graded.length === 1 ? "" : "s"} of this exact card${variantSuffix}`,
        confidenceForRung("cross-setkey", graded.length),
        input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
    }
  }

  // ─── Rung 2: same identity ignoring printRun ────────────────────────
  // Strip the print-run suffix and match anything with the same
  // player/year/set/cardNumber/parallel/auto. Useful when the /50 auto
  // has no sales but the /150 and /99 variants do — approximate but
  // grounded.
  const slugNoPrintRun = slug.replace(/:num-\d+$/, "");
  if (slugNoPrintRun !== slug) {
    rows = await queryPool(
      container,
      "STARTSWITH(c.hobbyiqCardId, @stem)",
      [{ name: "@stem", value: slugNoPrintRun }],
      cutoffIso,
    );
    rows = filterByGrade(rows, gradeCompany, gradeValue);
    if (rows.length > 0) {
      return buildResult(slug, rows, "cross-printrun",
        `Estimated from ${rows.length} sale${rows.length === 1 ? "" : "s"} of the same card at other print runs`,
        confidenceForRung("cross-printrun", rows.length),
        input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
    }
  }

  // ─── Rung 3: same-printrun-cross-parallel ─────────────────────────
  // Same year + cardNumber + auto + PRINT RUN, other parallels. For
  // numbered cards, all /50 auto variants (Gold Wave, Gold Shimmer,
  // Gold Refractor, etc.) trade in a tight band vs the base auto (no
  // printRun). This rung finds the "right" price stratum without
  // getting polluted by cheap base autos. Only fires when the target
  // slug has a print run.
  if (parsed.printRun !== null && parsed.printRun !== undefined) {
    rows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport AND c.printRun = @pr",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
        { name: "@pr", value: parsed.printRun },
      ],
      cutoffIso,
    );
    if (rows.length > 0) rows = filterByGrade(rows, gradeCompany, gradeValue);
    if (rows.length > 0) {
      return buildResult(slug, rows, "same-printrun-cross-parallel",
        `Estimated from ${rows.length} sale${rows.length === 1 ? "" : "s"} of same-print-run variants (/${parsed.printRun})`,
        confidenceForRung("same-printrun-cross-parallel", rows.length),
        input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
    }
  }

  // ─── Rung 4 (NEW): printrun-discovery ─────────────────────────────
  // Fires when the target slug has NO printRun (Drew's holding data
  // often lacks the /N tag even for numbered variants). Finds the
  // DOMINANT printRun in the pool for this identity — same cardNumber
  // + parallel + auto — and uses that pool's median. Rescues cases
  // where Ingest split the same physical /150 card across a "/150"-
  // tagged pool and a "no-printRun" ghost pool depending on whether
  // the listing title spelled out the run.
  if (parsed.printRun === null || parsed.printRun === undefined) {
    rows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport AND IS_DEFINED(c.printRun) AND c.printRun != null",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
      ],
      cutoffIso,
    );
    // Filter parallel in JS (persisted label vs slug fragment) then apply grade.
    const targetParallelSlug = parsed.parallel;
    rows = rows.filter((r) => slugify(r.parallel ?? "") === targetParallelSlug);
    if (rows.length > 0) rows = filterByGrade(rows, gradeCompany, gradeValue);
    if (rows.length >= 3) {
      // Group by printRun, pick the pool with the most sales (that's
      // the market's dominant SKU for this identity).
      const byRun = new Map<number, PoolRow[]>();
      for (const r of rows) {
        const pr = Number(r.printRun);
        if (!Number.isFinite(pr)) continue;
        if (!byRun.has(pr)) byRun.set(pr, []);
        byRun.get(pr)!.push(r);
      }
      let bestRun: number | null = null;
      let bestPool: PoolRow[] = [];
      for (const [pr, pool] of byRun.entries()) {
        if (pool.length > bestPool.length) { bestRun = pr; bestPool = pool; }
      }
      if (bestPool.length >= 3) {
        return buildResult(slug, bestPool, "printrun-discovery",
          `Estimated from ${bestPool.length} sale${bestPool.length === 1 ? "" : "s"} of the /${bestRun} print-run variant (dominant SKU at this identity)`,
          confidenceForRung("printrun-discovery", bestPool.length),
          input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
      }
    }
  }

  // ─── Rung 5: sibling-parallel — same cardNumber + auto, ANY parallel ─
  // Same year+cardNumber+auto flag, any parallel + print run. Broader
  // than rung 4 — includes Base autos and other print runs. Fires when
  // rung 4 was empty (or slug had a print run).
  //
  // CF-CATALOG-GAP-NO-BASIS (Drew, 2026-07-28). Skip this rung when
  // the target parallel had ZERO comps at the identity AND the target
  // isn't Base. Sibling-parallel across ALL parallels would return a
  // Base-auto median that's fundamentally wrong for a rare parallel
  // (Black /1 auto priced from Base auto sales = fabrication). Better
  // to emit no-basis and route to verify_queue.
  const targetIsBase = parsed.parallel === "base";
  const shouldSkipSiblingParallel = !targetParallelHadIdentityComps && !targetIsBase;
  if (!shouldSkipSiblingParallel) {
    rows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@auto", value: parsed.isAuto },
        { name: "@sport", value: parsed.sport },
      ],
      cutoffIso,
    );
    if (rows.length > 0) {
      rows = filterByGrade(rows, gradeCompany, gradeValue);
    }
    if (rows.length > 0) {
      return buildResult(slug, rows, "sibling-parallel",
        `Estimated from ${rows.length} sale${rows.length === 1 ? "" : "s"} of sibling parallels of this card`,
        confidenceForRung("sibling-parallel", rows.length),
        input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
    }
  }

  // ─── Rung 4: family-baseline — same year + cardNumber, any variant ───
  // Broadest same-card rung. Same year + cardNumber gives player-year-
  // typical value across ANY variant (auto/no-auto, any parallel). Useful
  // as a floor when even sibling parallels are thin.
  //
  // CF-CATALOG-GAP-NO-BASIS: same gate as sibling-parallel — if the
  // target parallel has ZERO comps at the identity AND isn't Base,
  // this rung's cross-variant median is fabrication territory.
  if (!shouldSkipSiblingParallel) {
    rows = await queryPool(
      container,
      "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.sport = @sport",
      [
        { name: "@y", value: parsed.year },
        { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
        { name: "@sport", value: parsed.sport },
      ],
      cutoffIso,
    );
    if (rows.length > 0) {
      rows = filterByGrade(rows, gradeCompany, gradeValue);
    }
    if (rows.length > 0) {
      return buildResult(slug, rows, "family-baseline",
        `Estimated from ${rows.length} same-card sale${rows.length === 1 ? "" : "s"} across variants`,
        confidenceForRung("family-baseline", rows.length),
        input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
    }
  }

  // ─── Rung 7 (NEW): grade-cross-raw ───────────────────────────────────
  // Grade was requested but no graded comps at ANY rung. Fall back to raw
  // comps at the same identity (walk the same ladder without the grade
  // filter) and apply the observed graded multiplier from GRADE_CALIBRATION.
  // Rescues thin-market PSA10 auto lookups where raw comps exist. Explicit
  // confidence dip because the number is derived, not observed.
  if (gradeCompany && gradeValue !== null && gradeValue !== undefined) {
    // Walk raw rungs from most-specific to broadest. For numbered cards
    // (target has printRun), same-printrun-cross-parallel raw is
    // critical — keeps the /50 tier (e.g. Gold Wave $875 for CPA-GW /50
    // auto) intact instead of falling to sibling-parallel which dilutes
    // with unnumbered base autos.
    const rawRungs: Array<{ where: string; params: Array<{ name: string; value: string | number | boolean | null }>; method: HobbyIqFmvMethod; note: (n: number) => string; parallelFilter?: string }> = [
      { where: "c.hobbyiqCardId = @slug", params: [{ name: "@slug", value: slug }], method: "direct-slug", note: (n) => `Grade estimated from ${n} raw sale${n === 1 ? "" : "s"} of this exact card × ${gradeCompany} ${gradeValue} multiplier` },
      // NEW rung: cross-setKey raw, before same-printrun-cross-parallel.
      // Same rescue as the observed cross-setKey rung above — physical
      // card is fragmented across ingest variants. JS-filters on parallel
      // slug so rare parallels don't get diluted to base-auto medians.
      {
        where: "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport",
        params: [
          { name: "@y", value: parsed.year },
          { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
          { name: "@auto", value: parsed.isAuto },
          { name: "@sport", value: parsed.sport },
        ],
        method: "cross-setkey",
        parallelFilter: parsed.parallel,
        note: (n) => `Grade estimated from ${n} raw sale${n === 1 ? "" : "s"} of this exact card across ingest variants × ${gradeCompany} ${gradeValue} multiplier`,
      },
    ];
    if (parsed.printRun !== null && parsed.printRun !== undefined) {
      rawRungs.push({
        where: "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport AND c.printRun = @pr",
        params: [
          { name: "@y", value: parsed.year },
          { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() },
          { name: "@auto", value: parsed.isAuto },
          { name: "@sport", value: parsed.sport },
          { name: "@pr", value: parsed.printRun },
        ],
        method: "same-printrun-cross-parallel",
        note: (n) => `Grade estimated from ${n} raw sale${n === 1 ? "" : "s"} of same-print-run variants (/${parsed.printRun}) × ${gradeCompany} ${gradeValue} multiplier`,
      });
    }
    // CF-CATALOG-GAP-NO-BASIS: sibling-parallel raw dilutes hard on
    // rare parallels. Only include when the target IS Base OR the
    // target had ≥1 comp at the identity (thin market, sibling is
    // an honest floor). Otherwise skip and let the ladder emit
    // no-basis.
    if (targetIsBase || targetParallelHadIdentityComps) {
      rawRungs.push({
        where: "c.cardYear = @y AND UPPER(c.cardNumber) = @cn AND c.isAuto = @auto AND c.sport = @sport",
        params: [{ name: "@y", value: parsed.year }, { name: "@cn", value: (parsed.cardNumber ?? "").toUpperCase() }, { name: "@auto", value: parsed.isAuto }, { name: "@sport", value: parsed.sport }],
        method: "sibling-parallel",
        note: (n) => `Grade estimated from ${n} raw sale${n === 1 ? "" : "s"} of sibling parallels × ${gradeCompany} ${gradeValue} multiplier`,
      });
    }
    for (const rung of rawRungs) {
      let rawRows = await queryPool(container, rung.where, rung.params, cutoffIso);
      // Cross-setKey rung applies its parallel filter in JS on top of the
      // SQL-side identity query. Other rungs skip this (their WHERE
      // clauses already scope to the intended pool).
      if (rung.parallelFilter) {
        rawRows = rawRows.filter((r) => slugify(r.parallel ?? "") === rung.parallelFilter);
      }
      rawRows = filterByGrade(rawRows, null, null);   // raw only
      // CF-GRADE-CROSS-RAW-EXACT-IDENTITY-N2 (Drew, 2026-07-28). Exact-
      // identity rungs (direct-slug + cross-setkey) accept n≥2 raw
      // comps as the anchor; the broader rungs (same-printrun-cross-
      // parallel + sibling-parallel) keep the n≥3 floor.
      //
      // Verified live 2026-07-28 on Hartman Gold Refractor Auto PSA 9:
      // pool has 2 real Gold Refractor raw sales at $1,475 + $2,500 →
      // median $2,500 × PSA9 mult (1.18) = $2,950. Prior n≥3 gate
      // dropped through to sibling-parallel raw (832 comps of BASE +
      // every parallel, median $113) × 1.18 = $133 → returned $370.
      // A rare parallel's own 2 sales carry far more identity-signal
      // than 832 unrelated sibling sales; the broader rungs keep the
      // n≥3 floor precisely because they DO dilute across parallels.
      const rawFloor = (rung.method === "direct-slug" || rung.method === "cross-setkey") ? 2 : 3;
      if (rawRows.length >= rawFloor) {
        const rawPrices = rawRows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
        if (rawPrices.length === 0) continue;
        const rawMedian = rawPrices[Math.floor(rawPrices.length / 2)];
        const cardClass = parsed.isAuto ? "autograph" : "base";
        // CF-CALIBRATION-LADDER-IN-GRADER-PREMIUM (Drew, 2026-07-27).
        // parsed.setKey is a hyphen-slug ("bowman-chrome"); classifyFamily
        // inside getGraderPremium does substring matches on the LOWERED
        // string so hyphens vs. spaces both hit. parsed.sport is passed
        // as the sportHint so the calibration ladder can route into the
        // sport-scoped cells (baseball × bowman-chrome × band × tier).
        const multiplier = getGraderPremium(gradeCompany, String(gradeValue), rawMedian, cardClass, parsed.year, parsed.setKey, null, parsed.sport);
        if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
        const gradedFmv = rawMedian * multiplier;

        // CF-ESTIMATE-NO-SYNTH-POOLROW (Drew, 2026-07-28). Don't
        // synthesize graded PoolRows from raw × multiplier — that
        // pollutes the trend/regression with derived numbers pretending
        // to be observations. Instead: compute the projection on the
        // ACTUAL raw pool, then scale the fmv by the multiplier at
        // the end. min/max/trend all come from real observed prices
        // (raw), just multiplied by the same constant so the shape is
        // preserved. Result stays flagged `method: "grade-cross-raw"`
        // so consumers know this fmv is a synthesized graded value.
        //
        // Full raw pool goes into buildResult so trend + projection
        // math sees genuine observations; the ×multiplier applies
        // consistently to fmv, min, max, recentComps.
        const rawResult = await buildResult(slug, rawRows, "grade-cross-raw",
          rung.note(rawPrices.length) + ` (${multiplier.toFixed(2)}×, applied to raw median $${Math.round(rawMedian)} → $${Math.round(gradedFmv)})`,
          confidenceForRung("grade-cross-raw", rawPrices.length),
          input.previewLimit ?? 10, now, await populationPromise, await broaderIdentityTrendPromise);
        return {
          ...rawResult,
          fmv: rawResult.fmv !== null ? rawResult.fmv * multiplier : null,
          min: rawResult.min !== null ? rawResult.min * multiplier : null,
          max: rawResult.max !== null ? rawResult.max * multiplier : null,
          recentComps: rawResult.recentComps.map((c) => ({ ...c, price: c.price * multiplier })),
        };
      }
    }
  }

  // CF-CATALOG-GAP-NO-BASIS (Drew, 2026-07-28). If we skipped
  // sibling-parallel because the target parallel is rare + missing
  // data, enqueue a catalog-gap item so Drew can see the SKUs the
  // engine can't confidently price. Fire-and-forget; never blocks
  // the caller (no-basis still returns).
  if (shouldSkipSiblingParallel) {
    void (async () => {
      try {
        const { enqueueForVerify } = await import("./verifyQueue.service.js");
        await enqueueForVerify({
          reason: "catalog-gap",
          saleInput: {
            cardId: `hiq:${slug.slice(4)}`,
            playerName: "(unknown — catalog-gap)",
            cardYear: parsed.year,
            setName: parsed.setKey,
            parallel: parsed.parallel,
            cardNumber: parsed.cardNumber,
            isAuto: parsed.isAuto,
            gradeCompany,
            gradeValue,
            price: 0,
            soldAt: new Date().toISOString(),
            source: "manual-user-entry",
            sourceExternalId: null,
            title: null,
            imageUrl: null,
            sellerHandle: null,
            sport: parsed.sport,
            verifiedByUser: false,
            confidence: 0,
          },
          signal: {
            note: `no direct data for parallel "${parsed.parallel}" at (${parsed.year}, ${parsed.cardNumber}, ${parsed.isAuto ? "auto" : "no-auto"}) — refusing to fabricate from siblings`,
          },
        });
      } catch { /* silent */ }
    })();
  }

  const population = await populationPromise;
  return {
    ...noBasis,
    basisNote: shouldSkipSiblingParallel
      ? `No comparable sales for parallel "${parsed.parallel}" at this card — data gap flagged for review`
      : noBasis.basisNote,
    population,
    quality: { score: 0, flaggedCompCount: 0, sources: [] },
  };
}

// Confidence per rung × sample size. Direct + big sample → 0.95;
// family-baseline + 1 sample → 0.20. Callers can use this to render
// a "high/medium/low confidence" pill on iOS.
function confidenceForRung(rung: HobbyIqFmvMethod, n: number): number {
  const nBonus = Math.min(0.2, n / 100);      // saturating bonus for sample size
  switch (rung) {
    case "direct-slug":                  return Math.min(0.95, 0.75 + nBonus);
    // Between direct-slug and cross-printrun — parallel identity still
    // matches, only setKey was normalized differently at ingest.
    case "cross-setkey":                 return Math.min(0.90, 0.70 + nBonus);
    case "cross-printrun":               return Math.min(0.80, 0.55 + nBonus);
    case "same-printrun-cross-parallel": return Math.min(0.70, 0.45 + nBonus);
    case "printrun-discovery":           return Math.min(0.75, 0.55 + nBonus);
    case "sibling-parallel":             return Math.min(0.55, 0.30 + nBonus);
    case "family-baseline":              return Math.min(0.40, 0.20 + nBonus);
    case "grade-cross-raw":              return Math.min(0.45, 0.25 + nBonus);
    // Composite-neighbor: ceiling 0.90 — respects direct-slug legacy
    // hits when both are present. Confidence is also set inline in
    // tryCompositePath based on axis distance; this is the fallback.
    case "composite-neighbor":           return Math.min(0.90, 0.65 + nBonus);
    case "no-basis":                     return 0;
  }
}

async function buildResult(
  slug: string,
  rowsIn: PoolRow[],
  method: HobbyIqFmvMethod,
  basisNote: string,
  confidence: number,
  previewLimit: number,
  now: Date,
  population: CardPopulationLookup | null,
  // CF-HOBBYIQ-FMV-BROADER-TREND-ANCHOR (Drew, 2026-07-28). Rare
  // parallels with 1-2 comps have no regression signal in their OWN
  // pool. But the same (year, cardNumber, isAuto, sport) identity —
  // across every parallel — usually DOES have enough dated comps to
  // read a broader-set direction. Caller computes it once at the top
  // of computeHobbyIqFmv and threads it into every rung's buildResult
  // so the anchor branch can uplift a rare comp with the same trend
  // its base sibling is riding. Null when the broader query is thin
  // too, or when player-in-set momentum already covered the same
  // signal (Layer 1 wins the priority race).
  broaderIdentityTrendPctPerMonth: number | null = null,
): Promise<HobbyIqFmvResult> {
  const { kept: rows, flagged } = partitionByQuality(rowsIn);
  const quality = computeQualityScore(rows, flagged);
  const prices = rows.map((r) => Number(r.price)).filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length === 0) {
    return {
      slug, fmv: null, compCount: 0, min: null, max: null,
      breakdown: { bySource: {}, byAutoStyle: { onCard: 0, sticker: 0, unknown: 0 }, byGradeQualifier: {} },
      trend: { direction: "flat", slopePerMonthPct: 0, method: "none" },
      recentComps: [],
      method: "no-basis",
      basisNote: "No comparable sales",
      confidence: 0,
      population,
      quality,
      computedAt: now.toISOString(),
      cachedFrom: "sold_comps",
    };
  }

  const sortedPrices = [...prices].sort((a, b) => a - b);
  const median = sortedPrices[Math.floor(sortedPrices.length / 2)];
  const min = sortedPrices[0];
  const max = sortedPrices[sortedPrices.length - 1];

  // CF-HOBBYIQ-FMV-PROJECT-NOT-MEDIAN (Drew, 2026-07-28).
  //
  // FMV is the projected NEXT sale from the pool's trend — never a
  // median (golden rule / feedback_no_medians_project_next_sale). Prior
  // implementation emitted `median` as fmv, which was flat-wrong on the
  // Hartshorn Blue Auto case: 2 same-day $608 comps → median $608 with
  // no player-momentum signal applied. Downstream reprice trusted that
  // number as the "canonical HobbyIQ price."
  //
  // Now: route every rung's winning pool through projectNextSaleFromComps
  // — regression when n≥3 with distinct dates, anchor + broader-trend
  // fallback below. Broader-trend source: player-in-set momentum (Layer
  // 1 of the compiq trend stack, cached, 14-day window normalized to
  // %/month). Same helper canonicalFmv uses on the CH/CS engine side,
  // so the two pricing surfaces converge on the same math.
  //
  // forwardDays=0 matches canonicalFmv: "worth today," not "worth in
  // 30 days" — FMV is a current-sale projection, not a forecast.
  //
  // minNForRegression=3 also matches canonical to guard against
  // unbounded 2-point OLS extrapolation on thin pools.
  //
  // Fallback: if the projection helper returns null (0 usable priced
  // comps — shouldn't happen given the check above), fall back to
  // median so the ladder still emits SOMETHING rather than silently
  // dropping the rung. Logged with a warning so we notice.
  const anchorRow = rows.find((r) => typeof r.playerName === "string" && (r.playerName ?? "").trim() !== "")
    ?? rows[0];
  const playerName = (anchorRow.playerName ?? "").trim();
  const product = (anchorRow.product ?? "").trim();
  const cardYear = typeof anchorRow.cardYear === "number" && Number.isFinite(anchorRow.cardYear)
    ? anchorRow.cardYear
    : undefined;

  let trendPctPerMonth: number | null = null;
  let trendSource: "player-in-set" | "broader-identity" | "none" = "none";
  if (playerName && product) {
    try {
      const momentum = await fetchPlayerInSetMomentum({
        playerName,
        product,
        cardYear,
      });
      trendPctPerMonth = momentumMultiplierToPctPerMonth(momentum?.multiplier ?? null);
      if (trendPctPerMonth !== null) trendSource = "player-in-set";
    } catch {
      trendPctPerMonth = null;
    }
  }
  // CF-HOBBYIQ-FMV-BROADER-TREND-ANCHOR fallback: when player-in-set
  // momentum is unavailable (thin cache, missing playerName, etc.) but
  // the same-identity broader pool CAN read a trend, use it. Rare
  // parallels ARE anchors — a Blue Refractor Auto with 2 same-day
  // comps at $608 sits on top of a Base pool trending +26%/mo; the
  // Blue anchor should ride that same broader-set signal even without
  // its own dated regression.
  if (trendPctPerMonth === null && broaderIdentityTrendPctPerMonth !== null && Number.isFinite(broaderIdentityTrendPctPerMonth)) {
    trendPctPerMonth = broaderIdentityTrendPctPerMonth;
    trendSource = "broader-identity";
  }

  const projection = projectNextSaleFromComps(
    rows.map((r) => ({ price: Number(r.price), soldDate: r.soldAt })),
    {
      broaderTrendPctPerMonth: trendPctPerMonth,
      forwardDays: 0,
      minNForRegression: 3,
      nowMs: now.getTime(),
    },
  );

  let fmv: number;
  if (projection && projection.nextSaleValue > 0) {
    fmv = projection.nextSaleValue;
  } else {
    // Shouldn't hit — the priced.length > 0 guard means projection has
    // at least 1 comp to anchor on. Belt-and-suspenders: fall back to
    // median so the rung still emits, log so we notice the shape drift.
    console.warn(JSON.stringify({
      event: "hobbyiq_fmv_projection_null_fallback",
      slug,
      method,
      compCount: prices.length,
      trendPctPerMonth,
      trendSource,
    }));
    fmv = median;
  }

  // Telemetry: when broader-identity trend kicked in on a thin rung,
  // emit an event so App Insights can slice by rung × trend-source.
  // Also useful for verifying the fix on Hartshorn-class cards.
  if (trendSource === "broader-identity" && projection?.method === "trend-adjusted-last-sale") {
    console.log(JSON.stringify({
      event: "hobbyiq_fmv_broader_identity_trend_applied",
      slug,
      method,
      compCount: prices.length,
      broaderTrendPctPerMonth: Math.round(trendPctPerMonth! * 100) / 100,
      medianWouldHaveBeen: median,
      projectedFmv: fmv,
    }));
  }

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
    fmv,
    compCount: prices.length,
    min,
    max,
    breakdown,
    trend,
    recentComps,
    method,
    basisNote,
    confidence,
    population,
    quality,
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };
}

function computeTrend(rows: Array<{ price: number; soldAt: string }>): HobbyIqFmvTrend {
  const points = rows
    .map((r) => ({ price: Number(r.price), t: Date.parse(r.soldAt) }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  if (points.length < 2) {
    return { direction: "flat", slopePerMonthPct: 0, method: "none" };
  }
  if (points.length >= 3) {
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
  const first = points[0], last = points[points.length - 1];
  const spanDays = (last.t - first.t) / 86_400_000;
  if (spanDays <= 0 || first.price <= 0) {
    return { direction: "flat", slopePerMonthPct: 0, method: "anchor" };
  }
  const slopePerMonthPct = ((last.price - first.price) / first.price) / spanDays * 30 * 100;
  const direction = slopePerMonthPct > 1 ? "up" : slopePerMonthPct < -1 ? "down" : "flat";
  return { direction, slopePerMonthPct, method: "anchor" };
}

// ─── CF-GRADE-BREAKDOWN-SINGLE-SCAN (Drew, 2026-07-26) ───────────────
// Efficient per-grade summary from ONE Cosmos scan of a slug's comps.
// Replaces the /card-detail?includeGradeLadder=true implementation
// that fired 7 parallel computeHobbyIqFmv calls (measured 15-17s cold
// on prod due to Cosmos SDK contention). Single-scan approach:
//
//   1. One SELECT for c.hobbyiqCardId = @slug over the freshness window
//   2. Filter out flagged rows via partitionByQuality
//   3. Group by (gradeCompany, gradeValue) — including "Raw" (both null)
//   4. Per group: median = fmv, count = compCount, 30d/60d trend
//
// Only returns tiers with at least MIN_TIER_COMPS direct comps (default
// 2). Missing tiers are OMITTED — iOS shows "insufficient data" not a
// fabricated fallback multiplier. Empirical-only doctrine preserved.

export interface GradeBreakdownTier {
  /** Human display label — "PSA 10", "BGS 9.5", "SGC 10", "Raw". */
  gradeLabel: string;
  gradeCompany: string | null;   // null = raw
  gradeValue: number | null;     // null = raw
  fmv: number;                   // median of comps in this tier
  compCount: number;             // direct comps at this tier in window
  trend: "up" | "down" | "flat"; // 30d vs prior-60d median direction
  min: number;
  max: number;
  freshestSoldAt: string;
}

export interface GradeBreakdownResult {
  slug: string;
  tiers: GradeBreakdownTier[];   // sorted by fmv desc; Raw last
  totalCompsScanned: number;
  processingMs: number;
  computedAt: string;
}

/** Empirical per-tier summary from a single Cosmos scan. Returns
 *  {tiers: []} when the slug has no comps in the window. */
export async function computeGradeBreakdownSingleScan(
  slug: string,
  opts: { maxAgeDays?: number; minTierComps?: number } = {},
): Promise<GradeBreakdownResult> {
  const t0 = Date.now();
  const now = new Date();
  const empty: GradeBreakdownResult = {
    slug, tiers: [], totalCompsScanned: 0,
    processingMs: 0, computedAt: now.toISOString(),
  };
  if (!slug || !slug.startsWith("hiq:")) return { ...empty, processingMs: Date.now() - t0 };

  const container = await getSoldCompsContainer();
  if (!container) return { ...empty, processingMs: Date.now() - t0 };

  const maxAgeDays = opts.maxAgeDays ?? 180;
  const minTierComps = opts.minTierComps ?? 2;
  const cutoffIso = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString();

  // ONE query. Every tier gets computed from this pool.
  const rows = await queryPool(container, "c.hobbyiqCardId = @slug", [{ name: "@slug", value: slug }], cutoffIso);
  if (rows.length === 0) return { ...empty, processingMs: Date.now() - t0 };

  // Drop flagged rows (same discipline as the primary FMV path).
  const { kept } = partitionByQuality(rows);

  // Group by (gradeCompany, gradeValue). "Raw" key = (null, null).
  const byGrade = new Map<string, { company: string | null; value: number | null; rows: PoolRow[] }>();
  for (const r of kept) {
    const company = (typeof r.gradeCompany === "string" && r.gradeCompany.trim().length > 0)
      ? r.gradeCompany.trim().toUpperCase() : null;
    const value = (typeof r.gradeValue === "number" && Number.isFinite(r.gradeValue)) ? r.gradeValue : null;
    const key = company === null ? "raw" : `${company}:${value}`;
    if (!byGrade.has(key)) byGrade.set(key, { company, value, rows: [] });
    byGrade.get(key)!.rows.push(r);
  }

  const cutoff30 = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const tiers: GradeBreakdownTier[] = [];
  for (const { company, value, rows: groupRows } of byGrade.values()) {
    const prices: number[] = [];
    for (const r of groupRows) {
      const p = Number(r.price);
      if (Number.isFinite(p) && p > 0) prices.push(p);
    }
    if (prices.length < minTierComps) continue;    // skip tiers with too few comps
    const sorted = [...prices].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // 30d/60d trend from THIS group's rows only (no cross-tier contamination)
    const recent30: number[] = [], prior60: number[] = [];
    for (const r of groupRows) {
      const p = Number(r.price);
      if (!Number.isFinite(p) || p <= 0) continue;
      if (r.soldAt >= cutoff30) recent30.push(p);
      else prior60.push(p);
    }
    let trend: "up" | "down" | "flat" = "flat";
    if (recent30.length >= 2 && prior60.length >= 2) {
      const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
      const m30 = med(recent30);
      const m60 = med(prior60);
      if (m60 > 0) {
        const pct = ((m30 - m60) / m60) * 100;
        trend = pct > 3 ? "up" : pct < -3 ? "down" : "flat";
      }
    }

    const gradeLabel = company === null ? "Raw" : `${company} ${value}`;
    // Pick freshest soldAt in this group (rows sorted by soldAt DESC from queryPool)
    const freshest = groupRows.map(r => r.soldAt).sort().reverse()[0] ?? "";

    tiers.push({
      gradeLabel, gradeCompany: company, gradeValue: value,
      fmv: Math.round(median * 100) / 100,
      compCount: prices.length,
      trend,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      freshestSoldAt: freshest,
    });
  }

  // Sort: Raw always last, others by fmv desc (highest tier first — PSA 10 > BGS 9.5 > ...)
  tiers.sort((a, b) => {
    if (a.gradeCompany === null && b.gradeCompany !== null) return 1;
    if (a.gradeCompany !== null && b.gradeCompany === null) return -1;
    return b.fmv - a.fmv;
  });

  return {
    slug, tiers,
    totalCompsScanned: rows.length,
    processingMs: Date.now() - t0,
    computedAt: new Date().toISOString(),
  };
}

// ─── CF-HOBBYIQFMV-COMPOSITE-PATH (Drew, 2026-07-30) ─────────────────
//
// The composite-based FMV path. When HOBBYIQFMV_COMPOSITE_ENABLED=true
// AND the target has enough composite-enriched neighbors, we build the
// projected next sale from a semantically-tight pool (axis-drop
// widening via findNeighborComps) and multiply by per-axis calibration
// multipliers (color ladder, edition premium, finish premium, autoStyle
// premium, gradeTier multiplier). Returns null when the target pool is
// too thin or composite fields aren't yet populated on the neighbors —
// caller falls through to the legacy 8-rung ladder.
//
// Design intent:
//   - Never HURT confidence vs legacy — if the composite pool is
//     thinner than 5 comps we bail; legacy always fills in.
//   - Multipliers apply MULTIPLICATIVELY to the base trend fit. Missing
//     calibrations default to 1.0 (silent-safe).
//   - method="composite-neighbor" in the returned result so we can
//     A/B compare against legacy on the same target.
//
// Env:
//   HOBBYIQFMV_COMPOSITE_ENABLED=true — feature flag (default off)
//   HOBBYIQFMV_COMPOSITE_MIN_COMPS=5  — floor for using composite path
//   HOBBYIQFMV_COMPOSITE_MAX_DIST=4   — max axis drops before bail
async function tryCompositePath(
  input: HobbyIqFmvInput,
  container: Container,
  parsed: NonNullable<ReturnType<typeof parseHobbyIqCardId>>,
  slug: string,
  now: Date,
): Promise<HobbyIqFmvResult | null> {
  // CF-COMPOSITE-TIGHTEN (Drew, 2026-07-30). A/B test showed the
  // composite path was over-widening — 200-row pools across every
  // prospect in a set. Root cause: filter lacked cardNumber (fixed in
  // findNeighborComps). Belt-and-suspenders here: cap MAX_DIST at 2
  // (only drop 2 variant axes before giving up), cap the working pool
  // at 30 (median of a small tight pool is what we want, not a huge
  // mixed pool), and require min 3 direct-match comps to fire.
  const MIN_COMPS = Number(process.env.HOBBYIQFMV_COMPOSITE_MIN_COMPS ?? "3");
  const MAX_DIST = Number(process.env.HOBBYIQFMV_COMPOSITE_MAX_DIST ?? "2");
  const MAX_POOL = Number(process.env.HOBBYIQFMV_COMPOSITE_MAX_POOL ?? "30");

  // Step 1: Derive filter from slug. Enrich with the target's own
  // composite (colorFamily / edition / finishModifier) when available.
  const baseFilter = compositeFilterFromCardId(slug);
  // Look up target row to grab its composite fields; short TOP-1 query
  // and best-effort.
  interface TargetCompositeShape {
    colorFamily?: string | null;
    edition?: string | null;
    finishModifier?: string | null;
    isRefractor?: boolean | null;
  }
  let targetComposite: TargetCompositeShape | null = null;
  try {
    const { resources } = await container.items.query<{ composite: TargetCompositeShape | null; autoStyle: "on-card" | "sticker" | null }>({
      query: "SELECT TOP 1 c.composite, c.autoStyle FROM c WHERE c.hobbyiqCardId = @slug",
      parameters: [{ name: "@slug", value: slug }],
    }).fetchAll();
    if (resources[0]?.composite) {
      targetComposite = resources[0].composite;
    }
  } catch { /* silent */ }

  const filter = {
    ...baseFilter,
    ...(targetComposite?.colorFamily ? { colorFamily: targetComposite.colorFamily } : {}),
    ...(targetComposite?.edition ? { edition: targetComposite.edition } : {}),
    ...(targetComposite?.finishModifier ? { finishModifier: targetComposite.finishModifier } : {}),
    ...(input.gradeCompany ? { gradeCompany: input.gradeCompany } : {}),
    ...(input.gradeValue != null ? { gradeValue: input.gradeValue } : {}),
  };

  // Step 2: Neighbor lookup with axis-drop widening.
  // Note: filter is anchored on (sport, cardYear, cardNumber, isAuto)
  // via compositeFilterFromCardId — those NEVER drop. Only variant
  // axes (color / finish / edition / etc) widen if the tight pool is
  // thin. maxComps=MAX_POOL keeps the working pool small enough that
  // the median stays representative of THIS card, not the set cohort.
  //
  // CF-ADAPTIVE-WINDOW (Drew, 2026-08-03). "Recency over past —
  // small window on highly traded cards." Instead of always using
  // 180d, start tight and widen only when the pool is thin.
  // Highly-traded cards (Ohtani PSA 9, current-year rookies) run
  // 30d = fresh median. Rare cards (BGS Black Label, /5 parallels)
  // fall back to 180d so we don't starve.
  const explicitWindow = input.maxAgeDays;
  async function fetchAdaptive() {
    if (explicitWindow) {
      const n = await findNeighborComps(container, filter, {
        maxDistance: MAX_DIST, minComps: MIN_COMPS, maxComps: MAX_POOL,
        recencyDays: explicitWindow,
      });
      return { neighbors: n, windowDays: explicitWindow };
    }
    // Try 30d → 60d → 90d → 180d until we have enough comps at d=0
    // (exact match on the anchor). Only widen when direct pool thin.
    for (const days of [30, 60, 90, 180]) {
      const n = await findNeighborComps(container, filter, {
        maxDistance: MAX_DIST, minComps: MIN_COMPS, maxComps: MAX_POOL,
        recencyDays: days,
      });
      const exact = n.filter((row) => row.distance === 0);
      const usable = exact.length >= MIN_COMPS ? exact : n;
      // Densely-traded threshold: >= 20 direct-match comps = enough
      // depth in the shortest window to trust the current-market read.
      // Below that, keep widening.
      if (days === 30 && exact.length >= 20) return { neighbors: n, windowDays: 30 };
      if (days === 60 && exact.length >= 15) return { neighbors: n, windowDays: 60 };
      if (days === 90 && exact.length >= 10) return { neighbors: n, windowDays: 90 };
      if (days === 180 && usable.length >= MIN_COMPS) return { neighbors: n, windowDays: 180 };
    }
    return { neighbors: [] as Awaited<ReturnType<typeof findNeighborComps>>, windowDays: 180 };
  }
  const { neighbors, windowDays } = await fetchAdaptive();

  if (neighbors.length < MIN_COMPS) {
    return null; // Fall through to legacy ladder
  }

  // Step 3: Prefer the tightest match. If distance=0 has enough comps,
  // use ONLY those — never contaminate a good direct-slug pool with
  // widened neighbors. Only fall to the mixed set when distance=0 is
  // insufficient.
  const exact = neighbors.filter(n => n.distance === 0);
  const workingComps = exact.length >= MIN_COMPS ? exact : neighbors;

  // Project next sale using the same math as the legacy path.
  // CF-COMPOSITE-TREND-FORWARD (Drew, 2026-08-03). Was forwardDays:0
  // which returned the pool median — VIOLATED the "FMV = projected
  // next sale from trend, never median" golden rule. Now projects 30
  // days forward so a rising Ohtani pool actually reads as trending
  // up in the returned FMV, not just in the separate trend field.
  // Thin-pool cap in projectNextSaleFromComps already clamps wild
  // regression extrapolations, so this can't over-shoot on 3-comp
  // pools with 5-day windows.
  const compsForProjection = workingComps.map(n => ({
    price: Number(n.doc.price),
    soldAt: String(n.doc.soldAt),
  }));
  const projection = projectNextSaleFromComps(compsForProjection, { monthsForward: 1, minNForRegression: 3 });
  if (!projection || !Number.isFinite(projection.nextSaleValue)) return null;

  // Step 4: Compute per-axis multiplier adjustment ONLY for axes that
  // were DROPPED to gather workingComps. Applying, say, the BLUE
  // multiplier to a pool that's already BLUE-only double-counts the
  // premium. Only when the finishModifier axis was dropped do we
  // multiply by the target's finishModifier premium — because the pool
  // then contains mixed finishes and needs to be normalized up to the
  // target's finish. gradeCompany + gradeValue are always in the
  // filter, so gradeTier is never applied here (pool is grade-matched
  // by construction).
  const droppedAxes = new Set(workingComps.flatMap(n => n.droppedAxes));
  const adjustment = await computeAxisAdjustment({
    productLine: parsed.setKey,
    colorFamily: droppedAxes.has("colorFamily") ? (targetComposite?.colorFamily ?? null) : null,
    edition: droppedAxes.has("edition") ? (targetComposite?.edition ?? null) : null,
    finishModifier: droppedAxes.has("finishModifier") ? (targetComposite?.finishModifier ?? null) : null,
    autoStyle: null,
    gradeCompany: null,
    gradeValue: null,
  });

  const baseFmv = projection.nextSaleValue;
  const adjustedFmv = baseFmv * adjustment.factor;

  // Step 5: Build the response. Use the same shape as legacy for
  // downstream compatibility.
  const workingDocs = workingComps.map(n => n.doc as {
    price: number; soldAt: string; source: string;
    hobbyiqCardId?: string | null; parallel?: string | null;
    autoStyle?: "on-card" | "sticker" | null; gradeQualifier?: string | null;
  });
  const prices = workingDocs.map(d => Number(d.price)).filter(p => Number.isFinite(p) && p > 0);
  prices.sort((a, b) => a - b);
  const min = prices[0] ?? null;
  const max = prices[prices.length - 1] ?? null;

  const bySource: Record<string, number> = {};
  const byAutoStyle = { onCard: 0, sticker: 0, unknown: 0 };
  const byGradeQualifier: Record<string, number> = {};
  for (const d of workingDocs) {
    const s = String(d.source ?? "unknown");
    bySource[s] = (bySource[s] ?? 0) + 1;
    if (d.autoStyle === "on-card") byAutoStyle.onCard++;
    else if (d.autoStyle === "sticker") byAutoStyle.sticker++;
    else byAutoStyle.unknown++;
    if (d.gradeQualifier) byGradeQualifier[d.gradeQualifier] = (byGradeQualifier[d.gradeQualifier] ?? 0) + 1;
  }

  const trend = computeTrend(workingDocs.map(d => ({ price: Number(d.price), soldAt: String(d.soldAt) })));
  const summary = summarizeByDistance(workingComps);
  const distanceHint = summary.map(s => `d${s.distance}=${s.count}`).join(", ");
  const adjustmentHint = Object.keys(adjustment.breakdown).length > 0
    ? `× ${Object.entries(adjustment.breakdown).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" × ")}`
    : "no multipliers applied";

  // Confidence blend: 0.85 for exact-composite match, decays 0.10 per
  // axis dropped. Never above 0.95 to preserve headroom for direct-slug
  // legacy hits when they're available.
  const meanDistance = workingComps.reduce((s, n) => s + n.distance, 0) / workingComps.length;
  const confidence = Math.max(0.30, Math.min(0.95, 0.90 - meanDistance * 0.10));

  return {
    slug,
    fmv: Math.round(adjustedFmv * 100) / 100,
    compCount: workingDocs.length,
    min,
    max,
    breakdown: { bySource, byAutoStyle, byGradeQualifier },
    trend,
    recentComps: workingDocs.slice(0, 5).map(d => ({
      price: Number(d.price),
      soldAt: String(d.soldAt),
      source: String(d.source),
      parallel: d.parallel ?? null,
      url: null,
      autoStyle: d.autoStyle ?? null,
      gradeQualifier: d.gradeQualifier ?? null,
    })),
    method: "composite-neighbor",
    basisNote: `Composite path: ${workingDocs.length} neighbors [${distanceHint}] over ${windowDays}d ${adjustmentHint}. Base projection $${baseFmv.toFixed(2)} → adjusted $${adjustedFmv.toFixed(2)}.`,
    confidence,
    population: null,
    quality: { score: confidence, flaggedCompCount: 0, sources: Object.keys(bySource) },
    computedAt: now.toISOString(),
    cachedFrom: "sold_comps",
  };
}
