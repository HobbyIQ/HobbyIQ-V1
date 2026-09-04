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
import { assessSellerIndependence, MIN_INDEPENDENT_SELLERS } from "./sellerIndependence.js";
import { dedupeSoldComps } from "../portfolioiq/dedupeSoldComps.js";
import { projectFromLeadingEdge } from "./nextSaleProjection.service.js";
import { readExactPoolRows, type ExactPoolRow } from "./exactPoolReader.js";
import type { ExactPoolRungLabel } from "./fmvRung.js";

const COSMOS_DATABASE = process.env.COSMOS_DATABASE ?? "hobbyiq";
const SOLD_COMPS_CONTAINER = process.env.COSMOS_SOLD_COMPS_CONTAINER ?? "sold_comps";

// Cascade windows for adaptive density-based lookback.
//
// CF-7-30-60 (Drew, 2026-08-05). Three-tier cascade per Drew's spec:
//   1. Last 7d if the cluster is dense (>= 5 sales)  →  hot-week price
//   2. Otherwise expand to 30d (>= 10 sales)         →  steady month
//   3. Otherwise expand to 60d (>= 5 sales)          →  broader pool
//      + the downstream playerRatio multiplier (already applied in the
//        computation loop below) lifts stale medians by the wider
//        player-pool trend when the exact-cardId sample is old.
// 90d/180d retained as ultimate thin-market fallbacks so vintage
// (1970s O-Pee-Chee etc.) still get some FMV instead of null. Anything
// hitting the 180d tier has visible low confidence.
//
// Prior config was 30d/60d/90d/180d, which dragged FMV behind hot
// cards mid-surge. Concrete case: 2018 Bowman Chrome Ohtani PSA 9
// 7d median $2,650 vs engine's 30d median $2,400 → FMV lagged ~$250.
// CF-WINDOW-FLOOR-60D (2026-08-22). The 7d and 30d tiers are gone, and the
// reason is measured rather than preferred. Same Ohtani PSA 9 as the note
// above, 884 deduped sales, value and trend by window:
//
//     7d   $2,433.09   -17.9%/wk   n=36     <- what the cascade was picking
//    14d   $2,601.51    -5.9%/wk   n=91
//    30d   $1,769.34   -38.5%/wk   n=164    <- worst of all
//    60d   $2,926.50    +4.2%/wk   n=415
//    90d   $2,926.50    +3.7%/wk   n=625
//   180d   $2,926.50    +3.2%/wk   n=884
//
// Everything at 60d and beyond agrees; everything below it is noise, and the
// cascade picked the SHORTEST window that had enough sales — so the busiest
// cards, the ones with the most evidence, were priced off the least of it.
// Individual sales of this card span $2,341-$3,050, so seven days of them can
// say anything.
//
// WHY THIS DOES NOT REINTRODUCE THE LAG THE 7d TIER WAS ADDED TO FIX. That
// note is about a long-window MEDIAN trailing a surge. The level is no longer
// a median — CF-TREND-FROM-FIT-NOT-LAST-THREE makes it a trend fit read AT
// NOW, so the slope carries it forward instead of averaging it backward. On
// this card the 180d fit returns $2,926.50, ABOVE the 30d median of $2,768,
// on a market that is genuinely rising. Long window, current answer.
//
// The weighted median that remains is recency-decayed at a 14d half-life, so
// it does not sit still either.
const WINDOWS = [
  { days: 60, minDirect: 5 },
  { days: 90, minDirect: 5 },
  { days: 180, minDirect: 3 },
];

// D16: how many of a tier's sales ride on the result for the wire's comp list.
const TIER_SALES_ON_WIRE = 50;

// Recency decay: sale weight = exp(-days_since_sale / HALF_LIFE_DAYS).
// 14d half-life means a 48h-old sale is ~5× weight of a 30d-old sale.
const HALF_LIFE_DAYS = 14;

// ── CF-ONE-SALE-WINDOW-POLICY (D22, Drew 2026-08-30) ─────────────────────
//
// Holding afd40fed — Theo Gillen 2024 Bowman Draft CPA-TG Blue Refractor
// /150, raw. Five sales: $125, $161.50, $192.51, $250 (2025) and $729 on
// 2026-08-20. The 60d and 90d windows hold that one sale; the 180d window
// holds two, and with a 14-day half-life the $729 sale carries 99.99% of the
// window's recency weight — so the weighted median IS the one sale, and the
// card read $729 ("projected next sale" at n = 1, the NEEDS DREW item).
//
// The rule, as a named policy Drew can flip. Drew ruled 2026-08-30 19:50Z:
// "Keep — the latest sale is the market."
//
//   "last-sale"  (DEFAULT, Drew's ruling) the latest sale IS the market. When
//                a thin window's newest sale carries >= ONE_SALE_WEIGHT_SHARE
//                of the recency weight and DISAGREES (beyond
//                ONE_SALE_AGREEMENT_PCT) with the leading edge of the widest
//                window — the plain median of its newest <= 3 sales — the
//                newest sale stands under exact-pool-last-sale, and the basis
//                prints what widen would have said. Gillen: $729
//                (widen would say $489.50).
//   "widen"      the named alternative, off: a one-sale window does not win
//                on its own — the widest window's leading edge stands under
//                exact-pool-leading-edge, the basis printing $729 beside it.
//
// When the carrying sale AGREES with the leading edge there is nothing to
// decide and the weighted median stands under its own label. A window with
// exactly ONE sale stands under exact-pool-last-sale in either policy. The
// env var is the flip; the constant is the default.
export type OneSaleWindowPolicy = "widen" | "last-sale";
export const ONE_SALE_WINDOW_POLICY_DEFAULT: OneSaleWindowPolicy = "last-sale";
export function oneSaleWindowPolicy(): OneSaleWindowPolicy {
  const v = String(process.env.ONE_SALE_WINDOW_POLICY ?? "").trim().toLowerCase();
  return v === "last-sale" || v === "widen" ? v : ONE_SALE_WINDOW_POLICY_DEFAULT;
}
/** The newest sale "carries the window" when it holds this share of the
 *  pool's recency weight. Gillen 99.99%; the D16 thin fixture ($50 at 3d,
 *  $60 at 30d) 87%. */
export const ONE_SALE_WEIGHT_SHARE = 0.75;
/** The newest sale agrees with the leading edge when within this fraction. */
export const ONE_SALE_AGREEMENT_PCT = 0.25;

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
  // CF-RUNG-LABEL (D4 PR 1, 2026-08-29). Which branch of
  // computeTrendAndPrediction produced marketValue / predictedPrice for
  // this tier. Every tier here is the EXACT (identity, grade) pool; the
  // label names the aggregation. Written in exactly one place — the branch
  // that returned the number — so no consumer has to infer it.
  rungLabel: ExactPoolRungLabel;
  // CF-ONE-VALUATION-PATH (D16, 2026-08-30). The sales this tier was priced
  // from, newest first (capped), so a wire's comp list / sales history is
  // the SAME rows that produced the number — not a second read.
  // CF-SELF-COMP-LABEL-REACHES-THE-RESULT (Drew, 2026-09-03). The row's
  // contributor rides with the sale. A sale the OWNER contributed is what
  // makes a published result self-anchored, and the reprieve above can KEEP
  // such a row in the priced pool; without this field every consumer
  // downstream sees somebody else's sale and the label never fires.
  sales?: Array<{ price: number; soldAt: string; source: string | null; contributorUserId: string | null; sellerHandle?: string | null }>;
  // CF-THE-PROJECTION-IS-THE-LEADING-EDGE (D22). What the rung did, in
  // prose for the basis: the anchor and how far back it sits, the trend
  // applied from there, the newest-sale band, or the one-sale policy's
  // verdict with the OTHER policy's number beside it. Never the label.
  projectionNote: string | null;
  // D22: why this window — the cascade's path for this tier ("60d n=15" or
  // "60d n=1, 90d n=1, 180d n=2"), stated so the basis can say it.
  windowNote: string | null;
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
  // CF-RUNG-LABEL (D4 PR 1). The rung that produced the top-level
  // fmv / marketValue / predictedPrice: the matched tier's own label when
  // the requested grade had a pool entry; "cross-grade-fallback" when the
  // answer was rescaled off ANOTHER grade's pool (CF-UNIFIED-GRADE-
  // FALLBACK-CHAIN) — real sales, wrong grade, so NOT an exact-pool rung;
  // "no-basis" when there is no number (including a curve-only call with
  // no grade requested).
  rungLabel: ExactPoolRungLabel | "cross-grade-fallback" | "no-basis";
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

type RawCompRow = ExactPoolRow;

// CF-SELF-COMP-THIN-POOL (Drew, 2026-08-04). When the surviving pool
// after excluding the user's own contributions has fewer than this many
// other samples, we KEEP their self-comps — their own purchase IS the
// market signal for a rare parallel (Victor Figueroa Red Ink SSP: 1
// self-comp @ $278.60, 0 other comps). Filtering it out leaves nothing
// and legacy engine's fuzzy fallback produces $1.89.
const SELF_COMP_MIN_OTHER_SAMPLES = MIN_INDEPENDENT_SELLERS;

/** The identity's deduped pool in the window. `null` when Cosmos is not
 *  configured. CF-ONE-VALUATION-PATH (D16): the query lives in
 *  exactPoolReader so a test can feed one fixture pool below the engine. */
async function fetchPoolRows(
  cardId: string,
  hobbyiqCardId: string | null,
  windowDays: number,
  nowMs: number,
  hobbyiqCardIds: readonly string[] | null = null,
  asOfMs: number | null = null,
): Promise<RawCompRow[] | null> {
  const resources = await readExactPoolRows({ cardId, hobbyiqCardId, hobbyiqCardIds, windowDays, nowMs, asOfMs });
  if (resources === null) return null;
  const raw = resources.filter((r) => Number.isFinite(r.price) && r.price > 0 && !!r.soldAt);
  // CF-DEDUPE-SOLD-COMPS (2026-08-22). One sale arrives up to three times —
  // cardsight, cardhedge and tca-ebay all ingest the same eBay transaction,
  // and cardhedge writes it twice at different timestamp precision. On
  // Ohtani 2018 BC #1 that is 340 of 1,238 rows.
  //
  // It matters here more than anywhere else: the leading edge below is the
  // MEDIAN OF THE LAST 3 SALES, so two copies of one sale outvote every
  // other recent sale and become the market value. That is how this card
  // reported "-9.7%, falling" while its own PSA 9 sales rose +16%/month.
  const clean = dedupeSoldComps(raw);
  if (clean.length !== raw.length) {
    console.log(JSON.stringify({
      event: "sold_comps_deduped",
      source: "unifiedPricing.queryComps",
      cardId,
      hobbyiqCardId,
      before: raw.length,
      after: clean.length,
      removed: raw.length - clean.length,
    }));
  }
  return clean;
}

/** Post-filter: exclude self-comps ONLY when the surviving other-pool is
 *  large enough to price on its own. See SELF_COMP_MIN_OTHER_SAMPLES. Pure,
 *  so the per-tier window mode can apply it to each window exactly as the
 *  cascade applied it to each query.
 *
 * CF-SELF-COMP-THIN-POOL-IS-PER-TIER (Drew, 2026-09-02). The thin-pool
 * reprieve is measured PER TIER, because a tier is what gets priced. The
 * whole-card count answered the wrong question: it asked "does this CARD
 * have 3 other sales?" when the number being served is "what is this card
 * worth in PSA 10?".
 *
 * Measured on Justin Verlander 2005 Bowman Chrome BDP129 PSA 10
 * (bba3b7ad): the PSA 10 pool is one sale — Drew's own $251. The card also
 * carries 5 Raw/BGS rows, so the card-wide test saw `others.length = 5 >= 3`
 * and dropped the only PSA 10 sale there is. The tier went empty and the
 * holding fell to `grade-curve-estimate` $96.34, while /canonical-fmv —
 * which passes no user and so never ran this filter — served the real
 * $251 `exact-pool-last-sale`. Same function, same pool, same moment: the
 * $155 gap was this count, and the Raw sales it counted can say nothing
 * about a PSA 10.
 *
 * Per tier, the reprieve now fires exactly where Drew wrote it to: a tier
 * whose only evidence is the owner's own purchase keeps that purchase (and
 * is published labeled, per the self-comp doctrine), while a tier with a
 * real market of its own still excludes the owner's sale from it. */
function applySelfCompRule(rows: RawCompRow[], excludeContributorUserId?: string | null): RawCompRow[] {
  if (!excludeContributorUserId) return rows;
  const kept: RawCompRow[] = [];
  const byTier = new Map<string, RawCompRow[]>();
  for (const r of rows) {
    const label = gradeLabel(r.gradeCompany, r.gradeValue);
    let arr = byTier.get(label);
    if (!arr) { arr = []; byTier.set(label, arr); }
    arr.push(r);
  }
  for (const tierRowsForLabel of byTier.values()) {
    const others = tierRowsForLabel.filter((r) => r.contributorUserId !== excludeContributorUserId);
    // CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04). "Can this tier
    // price itself without the owner?" is the 3-INDEPENDENT-SELLER question
    // (Drew, 2026-09-01), and it is asked here on seller identity whenever
    // the surviving rows carry one. When they do not — which is nearly
    // always, sold_comps having a seller handle on 24 of 6.87M rows — the
    // verdict falls back to the row count it has always used and SAYS so on
    // `basis`, so the caveat downstream is the honest one. The decision
    // itself is unchanged for unverifiable pools: same floor, same rows.
    const verdict = assessSellerIndependence(others);
    kept.push(...(verdict.meets ? others : tierRowsForLabel));
  }
  return kept;
}

async function queryComps(
  cardId: string,
  hobbyiqCardId: string | null,
  windowDays: number,
  nowMs: number,
  excludeContributorUserId?: string | null,
  hobbyiqCardIds: readonly string[] | null = null,
  asOfMs: number | null = null,
): Promise<RawCompRow[] | null> {
  const rows = await fetchPoolRows(cardId, hobbyiqCardId, windowDays, nowMs, hobbyiqCardIds, asOfMs);
  return rows === null ? null : applySelfCompRule(rows, excludeContributorUserId);
}

/**
 * CF-A-GRADED-SALE-NEVER-ENTERS-THE-RAW-TIER (Drew, 2026-09-04).
 *
 * This function used to read `if (!company) return "Raw"` — a falsy
 * `gradeCompany` was taken as a POSITIVE ASSERTION that the sale was raw.
 * It is not. It is an ABSENCE, and the pool is full of rows where the absence
 * means "never populated at ingest", not "ungraded": `gradeParser.ts` records
 * ~7,900 AUTH slabs in the wrong bucket, and `backfill-grade-from-title.cjs`
 * exists solely to fill this field from titles — its query targets exactly the
 * three shapes this branch called Raw (`NOT IS_DEFINED`, `null`, `""`). That
 * script defaults to dry mode, so those rows are still in the pool.
 *
 * Measured in the 2026-09-04 audit: a raw 1997 Metal Universe Chipper Jones
 * #31 priced $2.00 off a weighted median on n=3 whose largest member was a
 * PSA 9 sale at $40 that had landed in the RAW tier by this branch. The
 * engine cannot contradict it downstream: `exactPoolReader`'s projection does
 * not select `c.title`, so the one field that proves the row is graded never
 * reaches the engine at all.
 *
 * The fix is to stop asserting. A row is Raw only when it is raw the way
 * `gradeLadder.isRaw` already defines it — no company AND no grade value.
 * A row carrying a grade VALUE with no company is a graded sale of an
 * unrecorded grader, and it gets the same treatment `gradeValueToken` already
 * gives an unreadable value: a deliberately unmatchable token. It matches no
 * requested tier, so it prices nothing and contaminates nothing — it is
 * excluded from the raw pool without being silently deleted from the curve,
 * which is what makes the population visible instead of invisible.
 */
export const UNKNOWN_GRADER_TIER = "GRADED ?";

function gradeLabel(company: string | null, value: number | null): string {
  if (!company) {
    // Not "no company therefore raw" — "no company AND no grade therefore raw".
    const token = gradeValueToken(value);
    return token === "?" ? "Raw" : UNKNOWN_GRADER_TIER;
  }
  return `${String(company).toUpperCase()} ${gradeValueToken(value)}`;
}

/**
 * CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02). The tier label is an
 * IDENTITY, and it is built by this function on BOTH sides of the tier match
 * below — once from the caller's requested grade, once from each pool row. So
 * the value must render the same way for a numerically identical grade,
 * whatever type it arrives as; any difference demotes a real exact-grade pool
 * to `cross-grade-fallback`.
 *
 *   10 / "10" / "10.0" / 10.0 / " 10"  ->  "10"     (one tier, one spelling)
 *   NaN / null / undefined             ->  "?"      (not a grade at all)
 *
 * The previous `${value ?? "?"}` was the live defect: `??` does not catch
 * NaN, so a gradeValue that failed to parse rendered "PSA NaN", matched no
 * tier, and fell through to another grade's pool. Four portfolioStore call
 * sites build the request grade with a bare `Number(...)` that can yield NaN
 * (holdingGrade and normalizeGrade filter it; those four did not) and write
 * the resulting rung straight onto the holding — so normalizing here fixes
 * every caller at the one seam both sides of the comparison already share.
 * "?" is deliberately kept unmatchable: see the fallback block for why an
 * unreadable grade refuses rather than borrowing another tier's number.
 */
function gradeValueToken(value: number | null | undefined): string {
  // CF-A-GRADED-SALE-NEVER-ENTERS-THE-RAW-TIER (2026-09-04): absence is
  // rejected BEFORE the numeric parse. `Number(null)` and `Number("")` are
  // both 0 — finite — so a row with no grade value used to render the token
  // "0". That was harmless while a falsy company short-circuited to "Raw"
  // above; now that the company branch consults this token to tell a raw row
  // from a graded-but-companyless one, a null rendering as "0" would evict
  // every genuinely raw sale from the raw tier. Absence first, parse second.
  if (value === null || value === undefined || (value as unknown) === "") return "?";
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? String(n) : "?";
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
/**
 * CF-PLAYER-TREND-ADJUSTMENT (Drew, 2026-08-04). When the exact-cardId
 * pool has stale samples (newest > 60 days old), fetch the wider player
 * pool to compute a real market-movement ratio and apply it as a trend
 * lift on the marketValue. Cam Caminiti Blue Refractor Auto: 2 exact-
 * cardId samples 17-19 months old ($76, $160, median $118). Wider Cam
 * Caminiti 2024 pool has 213 recent comps that DO have movement — we
 * use their trend to project our old exact-cardId median forward.
 *
 * Returns a ratio to multiply the stale median by. 1.0 means no trend
 * (thin wider pool, no signal). Clamped to [0.5, 3.0] to prevent
 * runaway adjustments on outlier player-pool moves.
 */
// POOL-1 residue (audit, 2026-09-03). The player-trend rung already excluded
// `priceAnomaly` rows but not adjudicated ones, so a row a human had marked
// wrong still moved the ratio that projects a stale exact-card median forward.
// Same store-form predicate as exactPoolReader:84-85.
const ADJUDICATION_FILTER =
  "(NOT IS_DEFINED(c.flaggedWrong) OR c.flaggedWrong != true)"
  + " AND (NOT IS_DEFINED(c.excludedFromFmv) OR c.excludedFromFmv != true)";

async function computePlayerPoolTrendRatio(
  cont: Container,
  playerName: string,
  cardYear: number,
  nowMs: number,
): Promise<number> {
  const cutoffRecent = new Date(nowMs - 30 * 86400_000).toISOString();
  const cutoffPrior = new Date(nowMs - 90 * 86400_000).toISOString();
  const priorEnd = cutoffRecent;
  try {
    // Recent 30d
    const { resources: recent } = await cont.items.query<{ price: number }>({
      query: `SELECT c.price FROM c WHERE c.playerName = @p AND c.cardYear = @y AND c.soldAt >= @cut AND c.price > 0 AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true) AND ${ADJUDICATION_FILTER}`,
      parameters: [{ name: "@p", value: playerName }, { name: "@y", value: cardYear }, { name: "@cut", value: cutoffRecent }],
    }, { maxItemCount: 300 }).fetchAll();
    // Prior 30d (30-90 days ago)
    const { resources: prior } = await cont.items.query<{ price: number }>({
      query: `SELECT c.price FROM c WHERE c.playerName = @p AND c.cardYear = @y AND c.soldAt >= @from AND c.soldAt < @to AND c.price > 0 AND (NOT IS_DEFINED(c.priceAnomaly) OR c.priceAnomaly != true) AND ${ADJUDICATION_FILTER}`,
      parameters: [{ name: "@p", value: playerName }, { name: "@y", value: cardYear }, { name: "@from", value: cutoffPrior }, { name: "@to", value: priorEnd }],
    }, { maxItemCount: 300 }).fetchAll();
    if (recent.length < 5 || prior.length < 5) return 1.0;
    const sorted = (arr: Array<{ price: number }>) => arr.map((r) => r.price).sort((a, b) => a - b);
    const median = (arr: number[]) => arr[Math.floor(arr.length / 2)];
    const rMed = median(sorted(recent));
    const pMed = median(sorted(prior));
    if (!Number.isFinite(rMed) || !Number.isFinite(pMed) || pMed <= 0) return 1.0;
    const ratio = rMed / pMed;
    return Math.max(0.5, Math.min(3.0, ratio));
  } catch {
    return 1.0;
  }
}

export async function computeUnifiedPrice(
  cardId: string,
  opts: {
    hobbyiqCardId?: string | null;
    // CF-AN-IDENTITY-RESOLVES-TO-ITS-ROW (2026-08-30). The identity's other
    // slug key(s), read in the SAME pool query: an un-numbered id and its one
    // numbered twin are one card whose rows sit under two keys until the D29
    // fleet re-keys sold_comps. exactPoolSupremacy forms this from the
    // resolver's answer; nothing here unions on its own.
    hobbyiqCardIds?: readonly string[] | null;
    grade?: { company: string | null; value: number | null } | null;
    // CF-PLAYER-TREND-ADJUSTMENT (Drew, 2026-08-04). When passed with
    // cardYear, unified pricing applies a wider-player-pool trend
    // ratio to marketValue if the exact-cardId newest sale is > 60d old.
    // Turns a stale $118 exact median into $118 × 1.2 = $142 when the
    // wider player pool is trending up 20%.
    playerName?: string | null;
    cardYear?: number | null;
    // CF-EXCLUDE-SELF-COMPS (Drew, 2026-08-04). Portfolio callers pass
    // the requesting userId here so the user's own eBay-import purchases
    // don't recycle back as market comps against their own holdings.
    excludeContributorUserId?: string | null;
    // CF-FIXED-WIDE-WINDOW (Drew, 2026-08-08). Grade-curve panel needs
    // every tier that has ANY recent activity, not just the ones with
    // sales in the adaptive-selected (usually tight) window. When
    // fixedWindowDays is set, skip the WINDOWS cascade and query
    // exactly that many days. buildObservedGradeCurve passes 180.
    // Ohtani PSA 10 example: newest sale 2026-07-30 (9d old) was
    // excluded from the 7-day window → PSA 10 wasn't in unified.gradeCurve
    // at all → no leading-edge trend. Fixed 180 window catches every
    // tier with sales in the last 6 months.
    fixedWindowDays?: number;
    // CF-ONE-VALUATION-PATH (D16, 2026-08-30). Every tier chooses its OWN
    // window by its own density — the same 60 → 90 → 180 cascade the
    // requested tier has always had, applied to each tier of the curve
    // from one 180d read. So a tier's curve entry IS the number that tier
    // would get as a headline: the four pricing routes and the grade curve
    // derive from one result, and a dense PSA 10 next to a sparse Raw no
    // longer reads the Raw pool at 180d while the headline read it at 60d.
    // When set, fixedWindowDays is ignored (the read is always 180d).
    perTierWindows?: boolean;
    // CF-AS-OF-IS-AN-UPPER-BOUND (#1651, the engine backtest, 2026-09-02).
    // Evaluate the engine as of a PAST instant: `nowMs` below becomes this
    // value, so every window, weight, half-life, trend cutoff and confidence
    // decay in this module reckons from it — this module was already fully
    // nowMs-threaded, so one substitution moves the whole computation — and
    // the pool read additionally refuses any row at or after it.
    //
    // Undefined in production, where nowMs is the wall clock and the read has
    // no ceiling, exactly as before.
    asOfMs?: number | null;
  } = {},
): Promise<UnifiedPriceResult> {
  const asOfMs = typeof opts.asOfMs === "number" && Number.isFinite(opts.asOfMs) ? opts.asOfMs : null;
  // The engine's single clock. In a backtest it is the evaluation instant, so
  // "30 days of sales" means the 30 days before THAT point, not before today.
  const nowMs = asOfMs ?? Date.now();
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
    rungLabel: "no-basis",
  };

  const container = await getContainer();

  // CF-RAW-IS-A-TIER (D4 "one valuation path", PR 4 — 2026-08-29). Which
  // tier the caller asked for:
  //   undefined                    -> the curve only; nothing priced at the top
  //   null, or a grade w/o company -> the Raw tier
  //   { company, value }           -> that graded tier
  // Every portfolio / fmv caller passes `grade: gCo ? {...} : null`, so a raw
  // holding arrived here as null and — because the top-level fill below was
  // gated on opts.grade?.company — never got a price: it fell through to the
  // legacy engine while its graded siblings took the unified early exit. The
  // raw pool is an exact-identity pool like any other tier and is priced the
  // same way.
  const requestedTier: string | null = opts.grade === undefined
    ? null
    : gradeLabel(opts.grade?.company ?? null, opts.grade?.value ?? null);
  const requestedIsRaw = requestedTier === "Raw";
  // A GRADED request (a company was named) whose numeric value did not
  // survive the caller's parsing: null, undefined or NaN. Renders "PSA ?" /
  // "PSA NaN", which is a tier that cannot exist in the pool. See the
  // fallback block below for why this refuses rather than falls back.
  // `Number(null)` is 0, which is finite — so the value is tested directly
  // rather than through a coercion that would read a missing grade as 0.
  const requestedGradeValue = opts.grade?.value;
  const requestedGradeIsUnreadable = !requestedIsRaw
    && requestedTier !== null
    && (requestedGradeValue === null
      || requestedGradeValue === undefined
      || !Number.isFinite(Number(requestedGradeValue)));

  // Adaptive window — start tight, widen until direct-grade density
  // supports the requested read. When opts.fixedWindowDays is passed
  // (grade-curve panel), skip the cascade and use exactly that window.
  // When opts.perTierWindows is passed, read 180d once and let every tier
  // run the cascade on its own rows (D16).
  const maxWindow = WINDOWS[WINDOWS.length - 1].days;
  let selectedWindow = 180;
  let comps: RawCompRow[] = [];
  // Per-tier mode: the rows each tier is priced from, by tier label.
  const tierRows = new Map<string, { rows: RawCompRow[]; windowDays: number }>();
  // D22: the cascade's path per tier, for the basis ("60d n=1, 90d n=1, 180d n=2").
  const tierWindowNotes = new Map<string, string>();
  if (opts.perTierWindows) {
    const all = await fetchPoolRows(cardId, opts.hobbyiqCardId ?? null, maxWindow, nowMs, opts.hobbyiqCardIds ?? null, asOfMs);
    if (all === null || all.length === 0) return empty;
    const withinWindow = new Map<number, RawCompRow[]>();
    const rowsWithin = (days: number): RawCompRow[] => {
      let cached = withinWindow.get(days);
      if (!cached) {
        const cutoffMs = nowMs - days * 86400_000;
        cached = applySelfCompRule(
          all.filter((r) => { const t = Date.parse(r.soldAt); return Number.isFinite(t) && t >= cutoffMs; }),
          opts.excludeContributorUserId ?? null,
        );
        withinWindow.set(days, cached);
      }
      return cached;
    };
    const labels = new Set(rowsWithin(maxWindow).map((r) => gradeLabel(r.gradeCompany, r.gradeValue)));
    for (const label of labels) {
      let chosen: { rows: RawCompRow[]; windowDays: number } | null = null;
      const path: string[] = [];
      for (const w of WINDOWS) {
        const rows = rowsWithin(w.days).filter((r) => gradeLabel(r.gradeCompany, r.gradeValue) === label);
        path.push(`${w.days}d n=${rows.length}`);
        if (rows.length >= w.minDirect) { chosen = { rows, windowDays: w.days }; break; }
      }
      if (!chosen) {
        chosen = { rows: rowsWithin(maxWindow).filter((r) => gradeLabel(r.gradeCompany, r.gradeValue) === label), windowDays: maxWindow };
        path.push(`${maxWindow}d with all ${chosen.rows.length}`);
      }
      if (chosen.rows.length > 0) { tierRows.set(label, chosen); tierWindowNotes.set(label, path.join(", ")); }
    }
    // The result's window and pool size describe the requested tier's read
    // — the same numbers the cascade reported for it.
    selectedWindow = (requestedTier && tierRows.get(requestedTier)?.windowDays) || maxWindow;
    comps = rowsWithin(selectedWindow);
  } else if (opts.fixedWindowDays && opts.fixedWindowDays > 0) {
    selectedWindow = opts.fixedWindowDays;
    const rows = await queryComps(cardId, opts.hobbyiqCardId ?? null, selectedWindow, nowMs, opts.excludeContributorUserId ?? null, opts.hobbyiqCardIds ?? null, asOfMs);
    if (rows === null) return empty;
    comps = rows;
  } else {
    const path: string[] = [];
    for (const w of WINDOWS) {
      const rows = await queryComps(cardId, opts.hobbyiqCardId ?? null, w.days, nowMs, opts.excludeContributorUserId ?? null, opts.hobbyiqCardIds ?? null, asOfMs);
      if (rows === null) return empty;
      comps = rows;
      // If a specific tier was requested, measure density on THAT tier
      // for cascade decision. Else use overall pool density.
      let densityCount = comps.length;
      if (requestedTier) {
        densityCount = comps.filter((r) => gradeLabel(r.gradeCompany, r.gradeValue) === requestedTier).length;
      }
      path.push(`${w.days}d n=${densityCount}`);
      if (densityCount >= w.minDirect) {
        selectedWindow = w.days;
        break;
      }
    }
    if (requestedTier) tierWindowNotes.set(requestedTier, path.join(", "));
  }
  if (comps.length === 0 && tierRows.size === 0) return empty;

  // Group by grade — in per-tier mode each tier already holds its own
  // window's rows; otherwise every tier shares the selected window.
  const groups = new Map<string, RawCompRow[]>();
  if (opts.perTierWindows) {
    for (const [label, t] of tierRows) groups.set(label, t.rows);
  } else {
    for (const r of comps) {
      const key = gradeLabel(r.gradeCompany, r.gradeValue);
      let arr = groups.get(key);
      if (!arr) { arr = []; groups.set(key, arr); }
      arr.push(r);
    }
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
    rungLabel: ExactPoolRungLabel;
    projectionNote: string | null;
  } {
    // ── CF-TREND-FROM-FIT-NOT-LAST-THREE (2026-08-22) ──────────────────
    //
    // marketValue used to be the MEDIAN OF THE LAST 3 SALES, with direction
    // taken from those 3 against the next 10 — roughly one day of activity on
    // a busy card. That is not a trend, it is the newest sale's jitter.
    //
    // Shohei Ohtani 2018 Bowman Chrome #1 PSA 9, 224 real sales after dedupe:
    //
    //   last 3      $2,341 / $3,050 / $2,401  -> median $2,401, "-11%, falling"
    //   regression  over the same 224 sales   -> +16.0%/month, $2,762 today
    //   30d median                            -> $2,768
    //
    // Two independent methods agree at ~$2,765 and the shipped number was
    // $2,401 and pointing down. Individual sales of this card range
    // $2,341-$3,050, so any three of them can say anything.
    //
    // So fit the trend over the window and read it AT NOW. That is the golden
    // rule as written — FMV is the projected next sale from the pool's trend,
    // never a median — and projectNextSaleFromComps already implements it,
    // including the guards that make a fit safe: a thin-pool slope clamp and a
    // +/-25% median-anchor cap so an outlier cannot drag the output away from
    // the observed clearing price.
    //
    // The leading-edge path below is KEPT as the fallback for pools too thin
    // to fit, which is what it was always good at.
    //
    // ── CF-THE-PROJECTION-IS-THE-LEADING-EDGE (D22, Drew 2026-08-30) ──────
    //
    // The OLS fit's level was the WINDOW's centroid — the mean price at the
    // mean date — so on Max Williams CPA-MWI (60d, ten sales at $25–38 in
    // the newest week, $12–21 before) the line carried a $14-era level
    // forward and read $18.74, below every one of the last ten sales. The
    // projection is now anchored on the leading edge: the recency-weighted
    // median at its own (recency-weighted) time, and the window's trend
    // moves it forward from THERE to now. See projectFromLeadingEdge.
    const datedForFit = rows
      .map((r) => ({ price: Number(r.price), soldDate: String(r.soldAt ?? "") }))
      .filter((c) => Number.isFinite(c.price) && c.price > 0 && Number.isFinite(Date.parse(c.soldDate)));
    if (datedForFit.length >= 8) {
      const atNow = projectFromLeadingEdge(datedForFit, { forwardDays: 0, nowMs, halfLifeDays: HALF_LIFE_DAYS });
      const at7d = projectFromLeadingEdge(datedForFit, { forwardDays: 7, nowMs, halfLifeDays: HALF_LIFE_DAYS });
      if (atNow && atNow.nextSaleValue > 0) {
        // slopePerMonthPct -> per week, the unit this function reports in.
        const perWeek = Math.round((atNow.slopePerMonthPct / (30 / 7)) * 10) / 10;
        const trendWord = atNow.slopeNote === "fit"
          ? `trend ${perWeek >= 0 ? "+" : ""}${perWeek}%/wk of the anchor, applied forward ${atNow.anchorAgeDays}d to now`
          : atNow.slopeNote === "insane-fit" ? "the window's fit is noise (>300%/month) — no trend applied" : "no trend fit — the anchor stands";
        const capWord = atNow.cap === "newest-band" ? `; held inside ±25% of the newest sale ($${atNow.newestPrice}, ${atNow.newestAgeDays}d ago)` : "";
        return {
          marketValue: Math.round(atNow.nextSaleValue * 100) / 100,
          predictedPrice: Math.round((at7d?.nextSaleValue ?? atNow.nextSaleValue) * 100) / 100,
          trendPctPerWeek: perWeek,
          trendDirection: Math.abs(perWeek) < 1 ? "flat" : (perWeek > 0 ? "up" : "down"),
          rungLabel: "exact-pool-projection",
          projectionNote: `anchored on the leading edge: recency-weighted level $${atNow.anchorPrice} sitting ${atNow.anchorAgeDays}d back (n=${atNow.n}); ${trendWord}${capWord}`,
        };
      }
    }

    if (wMedian === null || rows.length < 4) {
      return thinPoolReading(rows, wMedian);
    }

    // CF-LEADING-EDGE-MV (Drew, 2026-08-08). Tier 1 of the recency
    // cascade: when the last 3 days have >= LEADING_EDGE_MIN sales,
    // marketValue is the plain median of those sales — captures the
    // "trading at $X now" reality for actively-moving cards. Weighted
    // median over 7-180d smooths older comps that no longer reflect the
    // current clearing price. Concrete case: Ohtani 2018 BC RC PSA 9 on
    // 2026-08-08. Last 3d has 4 sales at $2,600 / $2,900 / $3,000 /
    // $3,000. Plain median = $3,000. Prior form returned wMedian ~$2,700
    // (7d weighted median including $2,432 and $2,650 from Aug 5-6).
    // Trend signal still computed from wider window when available.
    // CF-LEADING-EDGE-BY-COUNT (Drew, 2026-08-08). Switched from
    // "last N days" to "last N SALES by soldAt DESC" per Drew:
    // "use 3 4 5". Anchor MV on the freshest cluster regardless of
    // density. Ohtani PSA 9 example — last-3 sales are all Aug 7 at
    // $2,900/$3,000/$3,000 (median $3,000). Prior-N form using days
    // was still averaging in Aug 5-6 sales at $2,432-$2,700 (median
    // dropped to $2,727). Count-based leading edge picks the true
    // current clearing price.
    //
    // Anchor: prefer 5-of-latest if available, else fall through to
    // 4, then 3. Below LEADING_EDGE_MIN = 3, no leading edge — fall
    // through to weighted median (last-resort).
    // CF-LEADING-N-TUNE (Drew, 2026-08-08). Prefer N=3 not 5. Bias
    // toward the FRESHEST cluster — median of last 5 pulls in older
    // dips from within the week. Ohtani PSA 9 concrete: last-5 median
    // $2,727 (includes an Aug-6 $2,432 low), last-3 median $2,900
    // (Aug-7 cluster only). Latter matches "trading at $3k now".
    const LEADING_EDGE_MIN = 3;
    const LEADING_EDGE_PREF = 3;
    const LEADING_PRIOR_N = 10;  // trend from next-oldest 10 sales
    // Sort rows by soldAt DESC. Nulls / bad dates go last.
    const timedRows = rows
      .map((r) => ({ r, t: Date.parse(r.soldAt) }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => b.t - a.t);
    const leadingCount = Math.min(LEADING_EDGE_PREF, timedRows.length);
    const leadingSales = timedRows.slice(0, leadingCount).map((x) => Number(x.r.price));
    const leadingPriorSales = timedRows.slice(leadingCount, leadingCount + LEADING_PRIOR_N).map((x) => Number(x.r.price));
    function medOf(arr: number[]): number | null {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
    }
    let leadingEdgeMv: number | null = null;
    let leadingEdgeTrendPct: number | null = null;
    let leadingEdgeDirection: "up" | "down" | "flat" = "flat";
    if (leadingSales.length >= LEADING_EDGE_MIN) {
      leadingEdgeMv = medOf(leadingSales);
      const priorMed = medOf(leadingPriorSales);
      if (leadingEdgeMv != null && priorMed != null && priorMed > 0) {
        const ratio = Math.max(0.5, Math.min(1.5, leadingEdgeMv / priorMed));
        // Approximate: leading N sales cover ~half a week of activity
        // (varies by density). Normalize the ratio to per-week for the
        // pctPerWeek signal, then let the caller project forward.
        leadingEdgeTrendPct = Math.round(((ratio - 1) * 100) * 10) / 10;
        leadingEdgeDirection = Math.abs(leadingEdgeTrendPct) < 1 ? "flat"
          : leadingEdgeTrendPct > 0 ? "up" : "down";
      }
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
      // Not enough for wider trend — leading-edge stands alone.
      if (leadingEdgeMv != null) {
        const forwardFactor = leadingEdgeTrendPct != null
          ? 1 + (leadingEdgeTrendPct / 100) * (7 / 7)  // project 7 days forward
          : 1;
        return {
          marketValue: leadingEdgeMv,
          predictedPrice: Math.round(leadingEdgeMv * forwardFactor * 100) / 100,
          trendPctPerWeek: leadingEdgeTrendPct,
          trendDirection: leadingEdgeDirection,
          rungLabel: "exact-pool-leading-edge",
          projectionNote: `median of the newest ${leadingCount} sales ($${leadingSales.join(", $")}); too few for a wider trend`,
        };
      }
      return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat", rungLabel: "exact-pool-weighted-median", projectionNote: "recency-weighted median; no leading edge or trend could be read" };
    }
    const rMed = weightedMedian(recent, nowMs);
    const pMed = weightedMedian(prior, nowMs);
    if (!rMed || !pMed || pMed <= 0) {
      return { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat", rungLabel: "exact-pool-weighted-median", projectionNote: "recency-weighted median; the 14d-vs-prior trend could not be read" };
    }
    const ratio = rMed / pMed;
    // Clamp to [0.5, 1.5] — anything more extreme is thin-pool noise.
    const cappedRatio = Math.max(0.5, Math.min(1.5, ratio));
    const widerPctPerWeek = Math.round((cappedRatio - 1) * 500) / 10;

    // CF-LEADING-ANCHOR-CLEAN (Drew, 2026-08-08). When leading-edge
    // (last 3-5 sales) fired, MV is the leading median directly — no
    // multiplication by the wider trend. The wider trend may be flat
    // or slightly negative because it includes older comps that no
    // longer reflect the current clearing price. Multiplying the
    // leading anchor by that ratio drags MV DOWN when the market has
    // clearly moved UP recently (Ohtani PSA 9: leading median $2,900
    // × wider ratio 0.94 = $2,727 — wrong direction).
    //
    // Trend %: prefer leading-edge trend (last-5 vs next-10) which
    // reflects the actual current move; fall back to wider if the
    // leading signal wasn't computable. Predicted = MV × (1 + trend%
    // × forward-factor).
    if (leadingEdgeMv != null) {
      const trendPct = leadingEdgeTrendPct ?? widerPctPerWeek;
      const direction: "up" | "down" | "flat" = leadingEdgeTrendPct != null
        ? leadingEdgeDirection
        : (Math.abs(widerPctPerWeek) < 1 ? "flat" : (widerPctPerWeek > 0 ? "up" : "down"));
      // Project 7d forward
      const forwardFactor = 1 + (trendPct / 100);
      return {
        marketValue: Math.round(leadingEdgeMv * 100) / 100,
        predictedPrice: Math.round(leadingEdgeMv * forwardFactor * 100) / 100,
        trendPctPerWeek: trendPct,
        trendDirection: direction,
        rungLabel: "exact-pool-leading-edge",
        projectionNote: `median of the newest ${leadingCount} sales ($${leadingSales.join(", $")}) against the ${leadingPriorSales.length} before them`,
      };
    }

    // Leading-edge unavailable — fall back to wMedian × wider trend.
    const marketValue = Math.round(wMedian * cappedRatio * 100) / 100;
    const predicted = Math.round(wMedian * Math.pow(cappedRatio, 1.5) * 100) / 100;
    const direction: "up" | "down" | "flat" =
      Math.abs(widerPctPerWeek) < 1 ? "flat" : (widerPctPerWeek > 0 ? "up" : "down");
    return { marketValue, predictedPrice: predicted, trendPctPerWeek: widerPctPerWeek, trendDirection: direction, rungLabel: "exact-pool-weighted-median", projectionNote: "recency-weighted median × the 14d-vs-prior ratio (no leading edge could be read)" };
  }

  /**
   * CF-ONE-SALE-WINDOW-POLICY (D22). The thin rung (n < 4): the
   * recency-weighted median, UNLESS one sale carries the window — then the
   * policy above decides between that sale and the widest window's leading
   * edge, and the note prints the number the other policy would have given.
   */
  function thinPoolReading(rows: RawCompRow[], wMedian: number | null): ReturnType<typeof computeTrendAndPrediction> {
    const timed = rows
      .map((r) => ({ price: Number(r.price), t: Date.parse(r.soldAt) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.price) && x.price > 0)
      .sort((a, b) => b.t - a.t);
    const plain = { marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null as number | null, trendDirection: "flat" as const, rungLabel: "exact-pool-weighted-median" as const };
    if (wMedian === null || timed.length === 0) return { ...plain, projectionNote: "recency-weighted median of an undated thin pool" };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const weights = timed.map((x) => Math.exp(-Math.max(0, (nowMs - x.t) / 86400_000) / HALF_LIFE_DAYS));
    const totalW = weights.reduce((s, w) => s + w, 0);
    const share = totalW > 0 ? weights[0] / totalW : 1;
    const newest = timed[0];
    const newestAge = Math.round((nowMs - newest.t) / 86400_000);
    if (timed.length === 1) {
      return {
        marketValue: r2(newest.price), predictedPrice: r2(newest.price), trendPctPerWeek: null, trendDirection: "flat",
        rungLabel: "exact-pool-last-sale",
        projectionNote: `one sale in the widest window ($${r2(newest.price)}, ${newestAge}d ago) and nothing wider to widen to — the sale stands`,
      };
    }
    if (share < ONE_SALE_WEIGHT_SHARE) {
      return { ...plain, projectionNote: `recency-weighted median of ${timed.length} sales; the newest carries ${Math.round(share * 100)}% of the weight (< ${Math.round(ONE_SALE_WEIGHT_SHARE * 100)}%)` };
    }
    // One sale carries the window.
    const edgeSales = timed.slice(0, 3).map((x) => x.price);
    const sorted = edgeSales.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const edge = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const disagreePct = edge > 0 ? Math.abs(newest.price - edge) / edge : 0;
    const policy = oneSaleWindowPolicy();
    const sharePct = share >= 0.9995 ? ">99.9" : String(Math.round(share * 1000) / 10);
    if (disagreePct <= ONE_SALE_AGREEMENT_PCT) {
      return {
        ...plain,
        projectionNote: `the newest sale ($${r2(newest.price)}, ${newestAge}d ago) carries ${sharePct}% of the window's recency weight and agrees with the leading edge of the newest ${edgeSales.length} ($${r2(edge)}) within ${Math.round(disagreePct * 100)}% — the weighted median stands`,
      };
    }
    if (policy === "last-sale") {
      return {
        marketValue: r2(newest.price), predictedPrice: r2(newest.price), trendPctPerWeek: null, trendDirection: "flat",
        rungLabel: "exact-pool-last-sale",
        projectionNote: `the newest sale ($${r2(newest.price)}, ${newestAge}d ago) carries ${sharePct}% of the window's recency weight and disagrees with the leading edge of the newest ${edgeSales.length} ($${r2(edge)}) by ${Math.round(disagreePct * 100)}%; ONE_SALE_WINDOW_POLICY=last-sale (Drew: the latest sale is the market) — the sale stands (widen would say $${r2(edge)})`,
      };
    }
    return {
      marketValue: r2(edge), predictedPrice: r2(edge), trendPctPerWeek: null, trendDirection: "flat",
      rungLabel: "exact-pool-leading-edge",
      projectionNote: `the newest sale ($${r2(newest.price)}, ${newestAge}d ago) carries ${sharePct}% of the window's recency weight and disagrees with the leading edge of the newest ${edgeSales.length} ($${r2(edge)}) by ${Math.round(disagreePct * 100)}%; ONE_SALE_WINDOW_POLICY=widen — the leading edge stands (last-sale would say $${r2(newest.price)})`,
    };
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
      rungLabel: trend.rungLabel,
      projectionNote: trend.projectionNote,
      windowNote: tierWindowNotes.get(label) ?? null,
      sales: rows
        .map((r) => ({ price: Number(r.price), soldAt: String(r.soldAt), source: r.source ?? null, contributorUserId: r.contributorUserId ?? null, sellerHandle: r.sellerHandle ?? null, t: Date.parse(r.soldAt) }))
        .sort((a, b) => (Number.isFinite(b.t) ? b.t : 0) - (Number.isFinite(a.t) ? a.t : 0))
        .slice(0, TIER_SALES_ON_WIRE)
        .map(({ price, soldAt, source, contributorUserId, sellerHandle }) => ({ price, soldAt, source, contributorUserId, sellerHandle })),
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
  let rungLabel: UnifiedPriceResult["rungLabel"] = "no-basis";
  if (requestedTier) {
    const target = requestedTier;
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
    // CF-EXACT-GRADE-OUTRANKS-CROSS-GRADE (2026-09-02). The fallback below is
    // for a tier with NO pool of its own. It is narrowed by one rule: an
    // UNREADABLE grade value never silently reprices as some other grade.
    //
    // Measured: holding 6fc204f7 (Greg Maddux, 1987 Topps Traded Tiffany
    // #70T, PSA 10) read $361.49 while its own pool held two genuine PSA 10
    // sales, $1,900 and $1,850. A graded request whose numeric value did not
    // survive parsing renders "PSA ?" (or "PSA NaN" -- `??` does not catch
    // NaN), which is a tier no pool can contain. It matched nothing, fell
    // through here, and took the largest OTHER tier -- the PSA 9s -- so the
    // holding carried a PSA 9-derived number under a PSA 10 identity.
    //
    // A grade we cannot read is a MISSING answer, not a licence to answer
    // about a different grade: it refuses to no-basis and the caller keeps
    // whatever evidence it already had.
    //
    // The requested tier's own pool needs no rescue here -- `e.grade ===
    // target` already matches it whenever it exists, because both sides of
    // that comparison are built by the same gradeLabel. (Verified by
    // mutation: adding a normalized-label rescue changed no assertion.)
    // There is no minimum-sample gate on this path and there must not be
    // one: one real sale of THIS card at THIS grade outranks a rescaled read
    // of another grade at any n >= 1 -- last-sale doctrine.
    let matched = gradeCurve.find((e) => e.grade === target);
    let requestedButFallbackMatched = false;
    if (!matched && gradeCurve.length > 0) {
      if (requestedGradeIsUnreadable) {
        matched = undefined;   // refuse: no number beats a wrong-grade number
      } else {
        matched = gradeCurve[0];
        requestedButFallbackMatched = true;
      }
    }
    if (matched) {
      fmv = matched.weightedMedian;
      marketValue = matched.marketValue;
      predictedPrice = matched.predictedPrice;
      trendPctPerWeek = matched.trendPctPerWeek;
      trendDirection = matched.trendDirection;
      selectedConfidence = matched.confidence;
      // CF-RUNG-LABEL: the tier's own rung when the requested grade matched;
      // a fallback rung when the number is another grade's pool rescaled.
      rungLabel = requestedButFallbackMatched ? "cross-grade-fallback" : matched.rungLabel;

      // CF-UNIFIED-GRADE-MULTIPLIER-TRANSLATE (Drew, 2026-08-07). When
      // the requested grade didn't match a pool entry AND we fell back
      // to a different tier, apply getGraderPremium to translate that
      // tier's value to the requested grade. Eric Hartman PSA 10 raw
      // pool $1,713 was returning as-is for a PSA 10 request — the
      // wire needed raw × PSA 10 multiplier (~2.5-3× for a hot
      // prospect auto).
      //
      // CF-RAW-IS-A-TIER: symmetric for a Raw request with no raw pool —
      // the graded tier's premium is divided back out (toMult = 1.0), the
      // same table in the other direction, still labelled cross-grade.
      const requestedGraded = !requestedIsRaw && opts.grade?.company && opts.grade.value != null
        ? { company: String(opts.grade.company), value: String(opts.grade.value) }
        : null;
      if (requestedButFallbackMatched && (requestedIsRaw || requestedGraded)) {
        try {
          const fromCompany = matched.gradeCompany;
          const fromValue = matched.gradeValue;
          const { getGraderPremium } = await import("./compiqEstimate.service.js");
          const fromMult = fromCompany
            ? getGraderPremium(fromCompany, String(fromValue ?? ""), fmv ?? null, "autograph", opts.cardYear ?? null, null, null, null)
            : 1.0;
          const toMult = requestedGraded
            ? getGraderPremium(requestedGraded.company, requestedGraded.value, fmv ?? null, "autograph", opts.cardYear ?? null, null, null, null)
            : 1.0;
          // CF-EMPIRICAL-ONLY-NO-GRADER-MATRIX (2026-09-03, audit H-7
          // residual). Either premium can now refuse. This whole block
          // exists because `matched` is a DIFFERENT grade's pool: without a
          // successful rescale the numbers are that other grade's, and
          // shipping them under the "cross-grade-fallback" label is a
          // false-confidence answer, not a conservative one. So a refusal
          // has to withhold the price rather than leave it un-rescaled —
          // the caller's own no-basis handling then applies.
          const canRescale =
            fromMult !== null && Number.isFinite(fromMult) && fromMult > 0
            && toMult !== null && Number.isFinite(toMult) && toMult > 0;
          const rescale = canRescale ? (toMult! / fromMult!) : null;
          if (rescale === null || !Number.isFinite(rescale) || rescale <= 0) {
            fmv = null;
            marketValue = null;
            predictedPrice = null;
            rungLabel = "no-basis";
          } else if (rescale !== 1.0) {
            if (fmv !== null) fmv = Math.round(fmv * rescale * 100) / 100;
            if (marketValue !== null) marketValue = Math.round(marketValue * rescale * 100) / 100;
            if (predictedPrice !== null) predictedPrice = Math.round(predictedPrice * rescale * 100) / 100;
          }
        } catch {
          // A thrown lookup is no more evidence than a refused one. Same
          // reasoning as above: the pool we matched is another grade's.
          fmv = null;
          marketValue = null;
          predictedPrice = null;
          rungLabel = "no-basis";
        }
      }

      // CF-PLAYER-TREND-ADJUSTMENT (Drew, 2026-08-04). When the matched
      // grade's newest sale is > 60 days old AND we have player+year
      // context, pull a broader player-pool trend ratio and apply it
      // to marketValue + predictedPrice. Turns "$118 from 17-month-old
      // Cam Caminiti Blue Refractor sales" into "$118 × 1.2 = $142"
      // if the wider Cam Caminiti 2024 pool is trending up 20%.
      const newestMs = matched.newestSaleDate ? Date.parse(matched.newestSaleDate) : 0;
      const daysSinceNewest = newestMs > 0 ? (nowMs - newestMs) / 86400_000 : 0;
      if (daysSinceNewest > 60 && opts.playerName && opts.cardYear && marketValue !== null && container) {
        try {
          const playerRatio = await computePlayerPoolTrendRatio(
            container,
            opts.playerName,
            opts.cardYear,
            nowMs,
          );
          if (playerRatio !== 1.0) {
            const adjustedMarket = Math.round(marketValue * playerRatio * 100) / 100;
            const adjustedPredicted = predictedPrice !== null
              ? Math.round(predictedPrice * playerRatio * 100) / 100
              : null;
            marketValue = adjustedMarket;
            predictedPrice = adjustedPredicted;
            const pctPerWeek = Math.round((playerRatio - 1) * 500) / 10;
            trendPctPerWeek = pctPerWeek;
            trendDirection = Math.abs(pctPerWeek) < 1
              ? "flat"
              : pctPerWeek > 0 ? "up" : "down";
          }
        } catch {
          // Silent — fall back to unmodified matched values.
        }
      }
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
    rungLabel,
  };
}
