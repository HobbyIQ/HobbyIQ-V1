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
import { countGradeSources, countTwinsCollapsed, emptyGradeSourceCounts, gradeSourceNote, stampGradeSources, type GradeSourceCounts } from "./gradeSource.js";
import type { ExactPoolRungLabel } from "./fmvRung.js";
import {
  projectGradeIndex,
  EXACT_POOL_INDEX_MIN_POOL,
  EXACT_POOL_INDEX_TIER_OWN_OLS,
  EXACT_POOL_INDEX_HALF_LIFE_DAYS,
  type GradeIndexProjection,
} from "./gradeIndexProjection.js";
import { cosmosOptionsFromConnectionString } from "../ops/cosmosConnectionPolicy.js";

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
// ── superseded for n=2/3 by RULING R25 (Drew, 2026-09-12) — see
//    thinPoolReading below; this section is kept for the n=1 / `widen`
//    history the policy still governs. ─────────────────────────────────
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
//   "last-sale"  (DEFAULT, Drew's ruling) the latest sale IS the market.
//                Since R25, this is the outcome for EVERY thin window (n=1,
//                2 or 3) unconditionally — there is no median alternative
//                left to outrank. Gillen: $729.
//   "widen"      the named alternative, off: for n=2/3 the widest window's
//                leading edge (the plain median of its newest <= 3 sales —
//                for n<=3 that is just those sales, never a wider-window
//                median) stands under exact-pool-leading-edge instead,
//                printing last-sale's number beside it. Gillen: $489.50
//                (last-sale says $729). A window with exactly ONE sale
//                stands under exact-pool-last-sale in either policy — there
//                is nothing else to widen to.
//
// ONE_SALE_WEIGHT_SHARE / ONE_SALE_AGREEMENT_PCT remain exported (a prior
// contract other code may still read) but no longer gate which RESULT wins
// for n=2/3: R25 retired the weighted-median branch they used to protect,
// so "does one sale carry enough weight to beat a median" is no longer the
// question — there is no median left to beat. ONE_SALE_AGREEMENT_PCT still
// decides whether `widen` (when enabled) prints a different number at all.
// The env var is the flip; the constant is the default.
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
  // CF-A-SELF-COMP-WEARS-EVERY-SOURCES-NAME (R59, Drew 2026-09-15). When
  // any sale behind this tier's number is the owner's own — tagged, or an
  // untagged vendor clone of a tagged row — the basis SAYS SO. Labelled
  // self-comps stand (project_self_comp_publish_labeled); what they may not
  // do is read as somebody else's trade. Null when none are the owner's.
  selfCompNote: string | null;
  // CF-A-GRADE-NAMES-ITS-SOURCE (R58 as amended, Drew 2026-09-15). Where the
  // grades behind THIS tier's number came from, and the sentence the basis
  // carries when any of them trace to a vendor product record rather than
  // the sale's own title. `gradeSourceNote` is null when every grade came
  // from a title — there is then nothing to caveat.
  gradeSources: GradeSourceCounts;
  gradeSourceNote: string | null;
  // CF-EXACT-POOL-GRADE-INDEX (Drew, 2026-09-13). The number of comps the
  // tier's PRICE was read from, when that differs from `sampleCount` (the
  // tier's own pool). Only the grade-index rung sets it — it prices off the
  // whole card's index points, not off this tier's rows alone — so a null
  // here means "the tier's own pool is what priced it", which is the case
  // for every other rung.
  compsUsed?: number | null;
  // CF-EXACT-POOL-GRADE-INDEX (Drew, 2026-09-13). Present ONLY on a tier
  // priced by `exact-pool-grade-index`: which tiers of this identity fed the
  // grade-free index, at what empirical multiplier, and what the index level
  // came out at. The rung reads sales from tiers OTHER than this one, so the
  // provenance has to say which — a reader cannot infer it from the tier's
  // own sample count, and `compsUsed` for this rung is the index's point
  // count, not the tier's. Rides onto pricingSourceMeta.
  gradeIndexMeta?: {
    indexAtNow: number;
    requestedMultiplier: number;
    halfLifeDays: number;
    /** Every tier that contributed index points, largest first. */
    contributions: Array<{ tier: string; sampleCount: number; multiplier: number }>;
    /** Tiers whose sales could NOT be indexed (no empirical multiplier). */
    skipped: Array<{ tier: string; sampleCount: number }>;
    /** How many points were this tier's own sales. */
    ownTierPoints: number;
  } | null;
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
  // ── CF-THE-LABEL-NAMES-THE-PARTITIONS-THAT-ANSWERED (R59, Drew 2026-09-15)
  //
  // The basis reports `id=<attempt label>`, which names the ATTEMPT — not
  // where the rows came from. Attempt 1 is labelled `hobbyiqCardId` and sets
  // BOTH cardId and hobbyiqCardId to the slug, and readExactPoolRows ORs the
  // two with no partitionKey — so it is a CROSS-PARTITION read.
  //
  // Measured on Rivera 1992 Bowman #302 BGS 9 (2026-09-15): the basis said
  // `id=hobbyiqCardId` while the slug partition holds 3 BGS 9 sales and the
  // eight the engine priced from came from the vendor-id partition too, every
  // row of which carries the slug on `hobbyiqCardId`. The label was not false;
  // it simply could not answer the question an auditor was asking.
  //
  // So the result reports how many DISTINCT partition keys actually returned
  // rows, and the basis appends it: `id=hobbyiqCardId(2 partitions)`.
  partitionsRead: number;
  // R58: the whole pool's grade provenance, for `pricingSourceMeta.gradeSources`.
  gradeSources: GradeSourceCounts;
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
    _cachedContainer = new CosmosClient(cosmosOptionsFromConnectionString(conn)).database(COSMOS_DATABASE).container(SOLD_COMPS_CONTAINER);
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
  // CF-A-GRADE-NAMES-ITS-SOURCE (R58 as amended, 2026-09-15). BEFORE dedupe,
  // and that ordering is the whole trick. `dedupeSoldComps` buckets by
  // (gradeKey, price) and keeps the FIRST row of each cluster — so a
  // ch-daily row and its ch-fill twin that agree on the grade collapse to
  // one, and the copy carrying the grader token in its title is exactly the
  // one dropped. Classify first and the surviving row keeps the evidence its
  // twin brought.
  stampGradeSources(raw);
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
  // CF-A-RECONCILED-TWIN-IS-ONE-SALE (R58, twin census 2026-09-16). How many
  // rows the twin reconciliation just removed — a vendor copy restamped from
  // its twin's sale title, which put it in the SAME dedupe bucket as that
  // twin, which the dedupe above then merged. Measured across both steps
  // because that is what happened: the stamp changes a grade, the dedupe
  // behind it turns two rows into one.
  //
  // Carried on the surviving rows rather than through fetchPoolRows's return
  // type: it is a fact about the READ, every consumer already passes these
  // rows around, and the per-tier counter is assembled from exactly the rows
  // that priced each tier — so the label and the number describe one pool
  // without threading a second value through four call sites.
  const twinsCollapsed = countTwinsCollapsed(raw, clean);
  if (twinsCollapsed > 0) {
    for (const r of clean) r.twinsCollapsedInRead = twinsCollapsed;
    console.log(JSON.stringify({
      event: "grade_source_twins_reconciled_and_merged",
      source: "unifiedPricing.fetchPoolRows",
      cardId,
      hobbyiqCardId,
      twinsCollapsed,
      detail: "vendor copies restamped from their twin's sale title, then merged by the 60-minute dedupe",
    }));
  }
  return clean;
}

/** The read's twin-reconciliation count, off whichever rows the caller holds.
 *  `fetchPoolRows` stamps the same figure on every surviving row, so a tier's
 *  subset reports the read's number rather than a per-tier recount — the rows
 *  it would recount from are exactly the ones the dedupe removed. 0 when the
 *  read merged nothing, which is the overwhelmingly common case. */
function twinsCollapsedIn(rows: ReadonlyArray<RawCompRow>): number {
  for (const r of rows) {
    const n = r.twinsCollapsedInRead;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return 0;
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
/** Sales this close together, at the same price and identity, are one sale
 *  reported twice — not two trades. 60s per R59. */
const SELF_COMP_CLONE_WINDOW_MS = 60_000;

/** The identity keys a row was found under, for clone matching. */
function identityKeysOf(r: RawCompRow): string[] {
  const keys: string[] = [];
  if (typeof r.cardId === "string" && r.cardId.trim()) keys.push(r.cardId.trim());
  if (typeof r.hobbyiqCardId === "string" && r.hobbyiqCardId.trim()) keys.push(r.hobbyiqCardId.trim());
  return keys;
}

/**
 * CF-A-SELF-COMP-WEARS-EVERY-SOURCES-NAME (R59, Drew 2026-09-15).
 *
 * The self-comp rule matched on `contributorUserId`, which only the row
 * the owner's own import wrote ever carries. The SAME sale also arrives
 * through the vendor feeds, anonymously, and those copies were invisible
 * to the rule.
 *
 * Measured on Rivera 1992 Bowman #302 BGS 9 (2026-09-15). Drew's 07-27
 * purchase is in the pool twice:
 *
 *   ebay-user-purchase::267728550616-…   slug partition    contributor=user-199fcbc9-…
 *   cardhedge::ch-daily::1785125199393…  vendor partition  contributor=null
 *
 * Same instant (2026-07-27T02:30), same $96, same BGS 9 — and the vendor
 * copy's own title names it: "…Rookie BGS 9 Mint". Whichever way the
 * reprieve branched, the owner's purchase stayed in the pool exactly once,
 * laundered through CardHedge and counted as an independent market comp.
 * On a thinner or newer pool that clone would set the price outright.
 *
 * So a row is the owner's when it is TAGGED as theirs, or when it is an
 * untagged clone of a tagged row: same identity (either key), same price,
 * sold within 60s. Clones are labelled exactly as the tagged row is.
 *
 * NOTHING IS DELETED. Labelled self-comps STAND (project_self_comp_publish
 * _labeled, and the per-tier reprieve below). This function decides what
 * counts as the OWNER's sale; it does not decide to drop it.
 */
function markSelfCompClones(
  rows: RawCompRow[],
  excludeContributorUserId: string,
): Set<RawCompRow> {
  const owned = new Set<RawCompRow>();
  const tagged = rows.filter((r) => r.contributorUserId === excludeContributorUserId);
  for (const r of tagged) owned.add(r);
  if (tagged.length === 0) return owned;
  for (const candidate of rows) {
    if (owned.has(candidate)) continue;
    // A row that names a DIFFERENT owner is that person's sale, not a clone.
    if (typeof candidate.contributorUserId === "string"
      && candidate.contributorUserId.trim() !== ""
      && candidate.contributorUserId !== excludeContributorUserId) continue;
    const cPrice = Number(candidate.price);
    const cTime = Date.parse(String(candidate.soldAt ?? ""));
    if (!Number.isFinite(cPrice) || !Number.isFinite(cTime)) continue;
    const cKeys = identityKeysOf(candidate);
    for (const own of tagged) {
      const oPrice = Number(own.price);
      const oTime = Date.parse(String(own.soldAt ?? ""));
      if (!Number.isFinite(oPrice) || !Number.isFinite(oTime)) continue;
      if (oPrice !== cPrice) continue;
      if (Math.abs(oTime - cTime) > SELF_COMP_CLONE_WINDOW_MS) continue;
      // Identity: the two rows must have been found under a shared key.
      const oKeys = identityKeysOf(own);
      const sharesIdentity = cKeys.length === 0 || oKeys.length === 0
        ? true            // a row with no keys projected cannot refute identity
        : cKeys.some((k) => oKeys.includes(k));
      if (!sharesIdentity) continue;
      // Grade must agree too — the same price at the same second in a
      // different tier is a different card's sale, not this one's clone.
      if (gradeLabel(own.gradeCompany, own.gradeValue)
        !== gradeLabel(candidate.gradeCompany, candidate.gradeValue)) continue;
      owned.add(candidate);
      // LABELLED THE SAME WAY, not deleted. Stamping the contributor is what
      // makes every downstream label rule — the self-anchored ratio, the
      // sell-draft caveat, the basis sentence — see this copy as the owner's
      // sale, which it is. The row object is the reader's own projection, so
      // this mutates nothing in Cosmos.
      candidate.contributorUserId = excludeContributorUserId;
      console.log(JSON.stringify({
        event: "self_comp_vendor_clone_labelled",
        source: candidate.source ?? null,
        ownerSource: own.source ?? null,
        price: cPrice,
        soldAt: candidate.soldAt,
        grade: gradeLabel(candidate.gradeCompany, candidate.gradeValue),
        detail: "an untagged vendor copy of the owner's own sale — labelled, not deleted",
      }));
      break;
    }
  }
  return owned;
}

/**
 * R59 item 5: the sentence the basis carries when the owner's own sale is
 * among the comps behind a tier's number. Labelled self-comps STAND — this
 * is the label, not a filter. Null when none of the sales are theirs.
 */
export function selfCompNoteFor(
  rows: ReadonlyArray<Pick<RawCompRow, "contributorUserId">>,
  ownerUserId: string | null,
): string | null {
  if (!ownerUserId) return null;
  const own = rows.reduce((n, r) => (r.contributorUserId === ownerUserId ? n + 1 : n), 0);
  if (own === 0) return null;
  const total = rows.length;
  if (own === total) {
    return total === 1
      ? "includes 1 sale that is your own purchase — it is the only sale behind this number"
      : `all ${total} sales behind this number are your own purchases`;
  }
  return `includes ${own} sale${own === 1 ? "" : "s"} that ${own === 1 ? "is" : "are"} your own purchase${own === 1 ? "" : "s"} (of ${total})`;
}

/** R59: the self-comp rule, exported so the clone pass is pinned directly
 *  rather than re-implemented in the test. Pure over the rows handed in. */
export function applySelfCompRuleForTest(
  rows: RawCompRow[],
  excludeContributorUserId?: string | null,
): RawCompRow[] {
  return applySelfCompRule(rows, excludeContributorUserId);
}

function applySelfCompRule(rows: RawCompRow[], excludeContributorUserId?: string | null): RawCompRow[] {
  if (!excludeContributorUserId) return rows;
  // R59: the owner's sale is every copy of it, not only the tagged one.
  const owned = markSelfCompClones(rows, excludeContributorUserId);
  const kept: RawCompRow[] = [];
  const byTier = new Map<string, RawCompRow[]>();
  for (const r of rows) {
    const label = gradeLabel(r.gradeCompany, r.gradeValue);
    let arr = byTier.get(label);
    if (!arr) { arr = []; byTier.set(label, arr); }
    arr.push(r);
  }
  for (const tierRowsForLabel of byTier.values()) {
    const others = tierRowsForLabel.filter((r) => !owned.has(r));
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
    partitionsRead: 0,
    gradeSources: emptyGradeSourceCounts(),
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
  // CF-EXACT-POOL-GRADE-INDEX (2026-09-13): the identity's rows at the WIDEST
  // window, captured in whichever branch ran. See the index block below for
  // why the index reads these rather than the cascade's selection.
  let widestWindowRows: RawCompRow[] = [];
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
    widestWindowRows = rowsWithin(maxWindow);
  } else if (opts.fixedWindowDays && opts.fixedWindowDays > 0) {
    selectedWindow = opts.fixedWindowDays;
    const rows = await queryComps(cardId, opts.hobbyiqCardId ?? null, selectedWindow, nowMs, opts.excludeContributorUserId ?? null, opts.hobbyiqCardIds ?? null, asOfMs);
    if (rows === null) return empty;
    comps = rows;
    widestWindowRows = rows;
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
    // The index needs the card's widest window regardless of where the
    // cascade stopped for the requested tier. When the cascade already read
    // 180d, reuse it; otherwise one more read of the same pool.
    widestWindowRows = selectedWindow === maxWindow
      ? comps
      : (await queryComps(cardId, opts.hobbyiqCardId ?? null, maxWindow, nowMs, opts.excludeContributorUserId ?? null, opts.hobbyiqCardIds ?? null, asOfMs)) ?? comps;
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

  // ── CF-EXACT-POOL-GRADE-INDEX (Drew, 2026-09-13): the card's grade-free
  // index, resolved ONCE before the per-tier loop. ─────────────────────────
  //
  // The index is a property of the CARD, not of a tier: the same points and
  // the same fit answer for every tier, and only the final multiplier
  // differs. Building it once here (rather than per tier) is what makes
  // "PSA 10 and SGC 9 of one card disagree only by their measured
  // multipliers" true by construction instead of by coincidence — and it is
  // also the only place the async calibration read can happen, since the
  // per-tier trend function is synchronous.
  //
  // The multiplier table is scoped the SAME way every other cross-tier path
  // scopes it — `calibrationScopeFor`, which reads (sport, family) off the
  // hiq slug — so the index and the raw→graded fill can never end up on
  // different tables for one card (project_per_sport_calibration_doctrine).
  //
  // Per-tier lookup order, both empirical, both from OUR pool:
  //   1. `lookupGradeRatioByTier` — the measured ratio for THIS grade
  //      (bowman-chrome/baseball SGC 9 = 1.29x, n=44). Preferred: it is the
  //      actual per-tier observation.
  //   2. `empiricalGradeMultiplier` — the company-level median x the shared
  //      sub-tier scaling, for a grade the byTier table does not cover.
  //   3. null — the tier is SKIPPED. Never a hardcoded matrix
  //      (project_empirical_only_multiplier_doctrine).
  const gradeIndexCache = new Map<string, GradeIndexProjection | null>();
  let indexMultiplierFor: ((tier: string) => number | null) | null = null;
  // Every sale of this identity at every tier, as the index needs them.
  //
  // CF-THE-INDEX-POOL-IS-THE-CARD-NOT-THE-CASCADE (2026-09-13). The rows are
  // the WHOLE window's, deliberately — NOT the union of whatever window each
  // tier's own density cascade happened to stop at.
  //
  // Two reasons, and the second is a contract. First, the index describes the
  // CARD's trend: the cascade is a per-tier density device answering "how far
  // back must THIS tier reach to have enough of its own sales", which says
  // nothing about how much of the card's history belongs in a card-wide fit.
  // Second, `perTierWindows` mode and the plain cascade select different rows
  // by construction, so an index built from the selected rows would give a
  // card two different prices depending on which mode the caller used —
  // precisely the disagreement `unifiedPerTierWindows.test.ts` pins against
  // ("the requested tier's headline equals … the cascade's own answer"), and
  // precisely the two-valuation-paths failure D16 exists to prevent.
  //
  // It must also not depend on WHICH TIER was requested, and that rules out
  // the cascade's selection for a second, independent reason: in per-tier
  // mode `comps` is the REQUESTED tier's window, so asking about a tier that
  // stopped at 90d would build the index from 10 rows while asking about a
  // tier that widened to 180d built it from 21 — the same card, the same
  // instant, two different index levels depending on the question. Measured
  // on the live Witt pool before this was fixed: PSA 10 saw 10 points and
  // PSA 9 saw 21.
  //
  // So the index reads the WIDEST window in every mode: the card's full
  // observed history, identical for every caller, every tier and both modes.
  // That is the right pool on the merits too — the cascade window is a
  // per-tier DENSITY device answering "how far back must THIS tier reach to
  // have enough of its own sales", which says nothing about how much of the
  // card's history belongs in a card-wide fit. Recency weighting, not window
  // truncation, is what decides how much an old sale counts here.
  const allIdentitySales: Array<{ tier: string; price: number; soldAt: string }> = [];
  for (const r of widestWindowRows) {
    allIdentitySales.push({
      tier: gradeLabel(r.gradeCompany, r.gradeValue),
      price: Number(r.price),
      soldAt: String(r.soldAt),
    });
  }
  if (allIdentitySales.length >= EXACT_POOL_INDEX_MIN_POOL) {
    try {
      const [{ empiricalGradeMultiplier }, { calibrationScopeFor }, { lookupGradeRatioByTier }] = await Promise.all([
        import("./canonicalFmv.service.js"),
        import("./observedGradeCurve.service.js"),
        import("./gradeCalibrationConfig.js"),
      ]);
      const { family, sport } = calibrationScopeFor({ slug: opts.hobbyiqCardId ?? cardId });
      indexMultiplierFor = (tier: string): number | null => {
        if (tier === "Raw") return 1;             // a definition, not a multiplier
        if (tier === UNKNOWN_GRADER_TIER) return null;  // deliberately unmatchable
        const sp = tier.lastIndexOf(" ");
        if (sp <= 0) return null;
        const company = tier.slice(0, sp);
        const value = Number(tier.slice(sp + 1));
        if (!Number.isFinite(value)) return null;
        const byTier = lookupGradeRatioByTier(family, company.toUpperCase(), value, sport);
        if (byTier !== null && Number.isFinite(byTier) && byTier > 0) return byTier;
        const companyLevel = empiricalGradeMultiplier(company, value, family, sport);
        return companyLevel !== null && Number.isFinite(companyLevel) && companyLevel > 0 ? companyLevel : null;
      };
    } catch {
      // No calibration reachable is no basis for an index. The tiers fall
      // through to the rungs they had before, which is the honest outcome.
      indexMultiplierFor = null;
    }
  }
  /** The card's index projected for one requested tier, memoized per tier. */
  function gradeIndexFor(tierLabel: string): GradeIndexProjection | null {
    if (!indexMultiplierFor) return null;
    const cached = gradeIndexCache.get(tierLabel);
    if (cached !== undefined) return cached;
    let built: GradeIndexProjection | null = null;
    try {
      built = projectGradeIndex(allIdentitySales, tierLabel, indexMultiplierFor, {
        nowMs,
        minPool: EXACT_POOL_INDEX_MIN_POOL,
        halfLifeDays: EXACT_POOL_INDEX_HALF_LIFE_DAYS,
      });
    } catch {
      built = null;
    }
    gradeIndexCache.set(tierLabel, built);
    return built;
  }

  // Trend + projected next sale per grade. Split rows into recent 14d
  // and prior 14d, compare weighted medians. Ratio > 1 = up trend.
  // predictedPrice = current weighted median × trend ratio (clamped
  // to ±50% to prevent thin-pool wild extrapolations).
  function computeTrendAndPrediction(rows: RawCompRow[], wMedian: number | null, tierLabel?: string): {
    marketValue: number | null;
    predictedPrice: number | null;
    trendPctPerWeek: number | null;
    trendDirection: "up" | "down" | "flat";
    rungLabel: ExactPoolRungLabel;
    projectionNote: string | null;
    gradeIndex?: GradeIndexProjection | null;
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
        // CF-AN-ANCHOR-THAT-IS-ONE-SALE-SAYS-SO (R57, Drew 2026-09-15). When
        // one sale carries more than half the recency weight, `n` describes
        // the query and not the estimate: the projection is that sale plus a
        // trend. The value stands — the basis stops implying otherwise.
        const concentrationWord = atNow.anchorDominatesPool
          ? `; effective n≈${atNow.effectiveN} of ${atNow.n} — anchor is the newest sale (${Math.round(atNow.anchorWeightShare * 100)}% of the recency weight)`
          : "";
        return {
          marketValue: Math.round(atNow.nextSaleValue * 100) / 100,
          predictedPrice: Math.round((at7d?.nextSaleValue ?? atNow.nextSaleValue) * 100) / 100,
          trendPctPerWeek: perWeek,
          trendDirection: Math.abs(perWeek) < 1 ? "flat" : (perWeek > 0 ? "up" : "down"),
          rungLabel: "exact-pool-projection",
          projectionNote: `anchored on the leading edge: recency-weighted level $${atNow.anchorPrice} sitting ${atNow.anchorAgeDays}d back (n=${atNow.n}); ${trendWord}${capWord}${concentrationWord}`,
        };
      }
    }

    // ── CF-EXACT-POOL-GRADE-INDEX (RULING, Drew 2026-09-13) ───────────────
    //
    //   "A graded tier must be priced from the WHOLE card's trend across
    //    grades, recency-weighted, not frozen on the tier's own last sale."
    //
    // This tier cannot fit its own trend (it did not reach the >= 8 branch
    // above), but the CARD might still have one. When the identity's pool —
    // raw and every grader/grade of the SAME hobbyiqCardId, never a sibling
    // card — holds at least EXACT_POOL_INDEX_MIN_POOL indexable sales, each
    // sale is divided by its own tier's empirical multiplier to give a
    // grade-free index point, the index is projected the same way the >= 8
    // OLS projects a single tier, and this tier's value is that projection
    // times ITS multiplier. See gradeIndexProjection.ts for the full note.
    //
    // Ordering is the doctrine, not a preference. It sits BELOW the >= 8
    // exact-tier OLS (direct evidence outranks derived: a tier that can fit
    // its own trend always keeps it) and ABOVE the thin-pool last-sale rung
    // (R25's "the newest sale is the market" is the right answer when there
    // is NOTHING better — a card-wide trend measured off this same card is
    // something better). It is an EXACT-POOL rung: every sale it reads is a
    // sale of this card, so R24's cost floor exempts it through
    // `isExactPoolRung` by construction.
    //
    // The Witt case this was written for
    // (hiq:baseball:2020:bowman-chrome:cpa-bwj:base:auto, 2026-09-13): 3 Raw,
    // 2 PSA 10, 1 BGS 9.5 and one 2-week-old SGC 9 at $1,300. Before: SGC 9
    // read exactly $1,300 under `exact-pool-last-sale` and no sale of any
    // other tier could move it. After: the seven sales index to a
    // raw-equivalent level of ~$956 at now, and SGC 9 = $956 x 1.29 =
    // ~$1,233. The $1,300 sale is still in the fit, at its own date, with its
    // own weight — it just no longer IS the answer.
    if (tierLabel) {
      // CF-THE-OLS-GATE-READS-THE-SAME-WINDOW-THE-INDEX-DOES (2026-09-13).
      // "Can this tier fit its own trend?" is measured over the SAME widest
      // window the index is built from, not over the rows the density cascade
      // selected for pricing. Otherwise the two disagree about what the tier
      // has: on the live Witt pool the PSA 10 tier holds 14 sales in 180d but
      // cascades to 90d (6 rows, the first window meeting minDirect=5), so a
      // gate reading the selected rows called a 14-sale tier too thin to fit
      // its own trend while the index beside it was reading all 14. The tier
      // has the evidence either way; a window chosen for density must not
      // decide which RUNG it gets.
      const ownTierSalesInWidestWindow = widestWindowRows.reduce(
        (n, r) => (gradeLabel(r.gradeCompany, r.gradeValue) === tierLabel
          && Number.isFinite(Date.parse(r.soldAt)) && Number(r.price) > 0 ? n + 1 : n),
        0,
      );
      const ownTierOls = datedForFit.length >= EXACT_POOL_INDEX_TIER_OWN_OLS
        || ownTierSalesInWidestWindow >= EXACT_POOL_INDEX_TIER_OWN_OLS;
      // CF-THE-INDEX-DOES-NOT-OVERRIDE-A-KEPT-SELF-COMP (2026-09-13).
      //
      // Two live rulings meet here, and the older one wins on its own ground.
      // `applySelfCompRule` has a deliberate reprieve: a tier whose ONLY
      // evidence is the owner's own purchase KEEPS that purchase, because
      // their own trade is the market signal for a tier that has no other
      // (CF-SELF-COMP-THIN-POOL, Drew 2026-08-04; published labelled, per
      // project_self_comp_publish_labeled). That reprieve was written against
      // a measured failure: Verlander 2005 Bowman Chrome BDP129 PSA 10
      // (holding bba3b7ad), whose only PSA 10 sale is Drew's own $251. When
      // the tier went empty it fell to a $96.34 grade-curve estimate — a
      // $155 gap on a real purchase price.
      //
      // Left unguarded, this rung re-opens exactly that gap by another door:
      // on that same fixture the index (raw sales of $20, $30.68 and $199.99,
      // anchoring near $30) prices the PSA 10 tier at ~$89 — within a few
      // dollars of the $96.34 the reprieve exists to prevent, and against a
      // sale the owner actually made. A cross-tier index is a strong signal
      // about a tier with THIN evidence; it is not a reason to overrule the
      // one trade of this exact card at this exact grade that we know
      // happened and deliberately kept.
      //
      // So: when every one of the tier's own sales is a CONTRIBUTED sale — a
      // purchase someone imported rather than a sale we observed on the open
      // market — the tier keeps the rung the self-comp doctrine gave it. A
      // tier with ANY independent sale of its own is thin, not self-anchored,
      // and the index prices it as normal.
      //
      // The test is on the ROWS, never on who is asking. Keying it off
      // `excludeContributorUserId` (which only the portfolio caller passes)
      // would hand the owner $251 and the public route $89 for the same card
      // at the same instant — two valuation paths, which is the one thing
      // this engine exists not to have. `selfCompThinPoolPerTier.test.ts`
      // pins that equality directly.
      const ownSales = rows.filter((r) => Number.isFinite(Date.parse(r.soldAt)));
      const selfAnchored = ownSales.length > 0 && ownSales.every((r) => !!r.contributorUserId);
      if (!ownTierOls && !selfAnchored) {
        const idx = gradeIndexFor(tierLabel);
        if (idx) {
          const contribWord = idx.contributions
            .map((c) => `${c.tier} n=${c.sampleCount} @${c.multiplier}x`)
            .join(", ");
          const trendWord = idx.slopeNote === "fit"
            ? `index trend ${idx.trendPctPerWeek >= 0 ? "+" : ""}${idx.trendPctPerWeek}%/wk applied forward ${idx.anchorAgeDays}d to now`
            : idx.slopeNote === "insane-fit"
              ? "the index fit is noise (>300%/month) — no trend applied"
              : "no index trend could be fit — the index anchor stands";
          const capWord = idx.cap === "newest-band" ? "; held inside ±25% of the newest index point" : "";
          const skipWord = idx.skipped.length > 0
            ? `; ${idx.skipped.map((s) => `${s.tier} n=${s.sampleCount}`).join(", ")} could not be indexed (no empirical multiplier) and contributed nothing`
            : "";
          return {
            marketValue: idx.tierValue,
            predictedPrice: idx.tierPredicted,
            trendPctPerWeek: idx.trendPctPerWeek,
            trendDirection: idx.trendDirection,
            rungLabel: "exact-pool-grade-index",
            projectionNote:
              `${datedForFit.length === 0 ? "no" : datedForFit.length} sale${datedForFit.length === 1 ? "" : "s"} at ${tierLabel} alone — too few to fit this tier's own trend, so the whole card's ${idx.points.length} sales across ${idx.contributions.length} tier${idx.contributions.length === 1 ? "" : "s"} (${contribWord}) were divided by their own empirical multipliers into one grade-free index; ${trendWord}${capWord}; index $${idx.indexAtNow} at now × the ${tierLabel} multiplier ${idx.requestedMultiplier}x = $${idx.tierValue}${skipWord}`,
            gradeIndex: idx,
          };
        }
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
   * RULING R25 (Drew, 2026-09-12). "When an exact pool has only 2 or 3 sales
   * (too few for a trend), FMV is the MOST RECENT sale, published with the
   * low-confidence label. Retire the weighted-median rung."
   *
   * Live case: Drew's Chipper Jones holding priced $2 under
   * `exact-pool-weighted-median` from a 3-sale raw pool whose largest member
   * was a PSA 9 sale that had landed in the raw tier by a since-fixed grade
   * bug (CF-A-GRADED-SALE-NEVER-ENTERS-THE-RAW-TIER) — but the deeper defect
   * was that the ladder was willing to average three sales into a number NO
   * SINGLE ONE of them supports, exactly the thing the golden rule forbids:
   * FMV is the projected next sale, never a median or mean.
   *
   * This retires the CF-ONE-SALE-WINDOW-POLICY (D22) heuristic's
   * weighted-median branches for n=2/3: that policy asked "does one sale
   * carry ENOUGH of the window's recency weight to outrank a median" — the
   * right question when the alternative to last-sale was a median at all.
   * R25 removes that alternative: with 2 or 3 sales there is no trend to
   * read, so the newest sale simply IS the answer, unconditionally, the same
   * way n=1 already always resolves to `exact-pool-last-sale`. The
   * ONE_SALE_WINDOW_POLICY env flip (last-sale / widen) and its two named
   * branches remain — Drew's own separate, still-live ruling — but with the
   * median alternative gone, "widen" now means "the leading edge of the
   * newest <= 3 sales", which for n <= 3 IS just those sales, so the note
   * still names both numbers for audit even though last-sale is no longer
   * competing with a median to get there.
   *
   * n=1 and n=2/3 share one shape: the newest sale stands under
   * `exact-pool-last-sale`, confidence via this module's own
   * confidenceScore(sampleCount, newestMs, nowMs) — a log-of-sample-count
   * score that already grades n=1 below n=2 below n=3, so the label does not
   * need to fork by sample count; the caller's own `sampleCount` field on
   * the tier carries that distinction. (observedGradeCurve.service.ts's
   * computeConfidence is the sibling used by the oneValuationPath /
   * portfolio surfaces; same shape, same doctrine, different module.)
   */
  function thinPoolReading(rows: RawCompRow[], wMedian: number | null): ReturnType<typeof computeTrendAndPrediction> {
    const timed = rows
      .map((r) => ({ price: Number(r.price), t: Date.parse(r.soldAt) }))
      .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.price) && x.price > 0)
      .sort((a, b) => b.t - a.t);
    if (timed.length === 0) {
      // No dated, positively-priced rows to anchor on — nothing to project
      // from. This is the one shape left that still needs the pool's
      // recency-weighted median as a last resort (an undated thin pool has
      // no "most recent sale" to name).
      return {
        marketValue: wMedian, predictedPrice: wMedian, trendPctPerWeek: null, trendDirection: "flat",
        rungLabel: "exact-pool-weighted-median",
        projectionNote: "recency-weighted median of an undated thin pool",
      };
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    const newest = timed[0];
    const newestAge = Math.round((nowMs - newest.t) / 86400_000);
    if (timed.length === 1) {
      return {
        marketValue: r2(newest.price), predictedPrice: r2(newest.price), trendPctPerWeek: null, trendDirection: "flat",
        rungLabel: "exact-pool-last-sale",
        projectionNote: `one sale in the widest window ($${r2(newest.price)}, ${newestAge}d ago) and nothing wider to widen to — the sale stands`,
      };
    }
    // R25: 2 or 3 sales is too few for a trend — the most recent sale IS the
    // market, unconditionally. The `widen` policy's leading edge (median of
    // the newest <= 3) is still computed and printed for audit, but it no
    // longer stands as an alternative RESULT: R25 supersedes D22's
    // "widen wins when no single sale carries the window" outcome for this
    // n-range specifically, because that outcome was a median.
    const edgeSales = timed.slice(0, 3).map((x) => x.price);
    const sorted = edgeSales.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const edge = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const disagreePct = edge > 0 ? Math.abs(newest.price - edge) / edge : 0;
    const policy = oneSaleWindowPolicy();
    if (policy === "widen" && disagreePct > ONE_SALE_AGREEMENT_PCT) {
      // The named alternative, off by default: the leading edge of the
      // newest <= 3 stands instead of the newest sale alone. For n <= 3 this
      // IS "the newest <= 3 sales", so it is still real evidence (never a
      // wider-window median) — just a different aggregation of the same thin
      // pool than R25's default.
      return {
        marketValue: r2(edge), predictedPrice: r2(edge), trendPctPerWeek: null, trendDirection: "flat",
        rungLabel: "exact-pool-leading-edge",
        projectionNote: `${timed.length} sales, too few for a trend (R25); the newest ($${r2(newest.price)}, ${newestAge}d ago) disagrees with the leading edge of the newest ${edgeSales.length} ($${r2(edge)}) by ${Math.round(disagreePct * 100)}%; ONE_SALE_WINDOW_POLICY=widen — the leading edge stands (last-sale would say $${r2(newest.price)})`,
      };
    }
    return {
      marketValue: r2(newest.price), predictedPrice: r2(newest.price), trendPctPerWeek: null, trendDirection: "flat",
      rungLabel: "exact-pool-last-sale",
      projectionNote: `${timed.length} sales, too few for a trend (R25: FMV is the most recent sale) — $${r2(newest.price)}, ${newestAge}d ago${disagreePct > ONE_SALE_AGREEMENT_PCT ? ` (leading edge of the newest ${edgeSales.length} would say $${r2(edge)})` : ""}`,
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
    const trend = computeTrendAndPrediction(rows, wMed, label);
    const gi = trend.gradeIndex ?? null;
    // R58: the provenance of THIS tier's grades, plus the read's twin
    // reconciliation count (stamped on every surviving row, so any tier's
    // subset reports the same per-read figure).
    const tierGradeSources = countGradeSources(rows, twinsCollapsedIn(rows));
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
      // R59: count the owner's own sales behind THIS tier's number. The
      // clone pass above has already stamped vendor copies, so this counts
      // every copy of the owner's trade, not only the tagged one.
      selfCompNote: selfCompNoteFor(rows, opts.excludeContributorUserId ?? null),
      // R58: the provenance of this tier's own grades. Counted off the rows
      // that priced it, so the sentence and the number describe one pool.
      gradeSources: tierGradeSources,
      gradeSourceNote: gradeSourceNote(tierGradeSources),
      // CF-EXACT-POOL-GRADE-INDEX: the comps this tier was PRICED FROM. For
      // every other rung that is the tier's own pool and this is absent; for
      // the index rung it is every index point, because that is what the
      // number was actually read off. `sampleCount` deliberately stays the
      // tier's OWN sales — it is what `unifiedTierHasPool` and the confidence
      // score mean by "this tier's pool", and inflating it with other tiers'
      // sales would claim a directness this rung does not have.
      compsUsed: gi ? gi.points.length : null,
      gradeIndexMeta: gi
        ? {
            indexAtNow: gi.indexAtNow,
            requestedMultiplier: gi.requestedMultiplier,
            halfLifeDays: EXACT_POOL_INDEX_HALF_LIFE_DAYS,
            contributions: gi.contributions,
            skipped: gi.skipped,
            ownTierPoints: gi.ownTierPoints,
          }
        : null,
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
    // R59: the partition keys that actually answered. `cardId` IS the
    // partition key on sold_comps, so distinct values = distinct partitions.
    partitionsRead: new Set(
      comps
        .map((r) => (typeof r.cardId === "string" ? r.cardId.trim() : ""))
        .filter((k) => k !== ""),
    ).size,
    gradeSources: countGradeSources(comps, twinsCollapsedIn(comps)),
    method: comps.length > 0 ? "weighted-median" : "no-basis",
    confidence: selectedConfidence || Math.min(1, comps.length / 30),
    computedAt: new Date(nowMs).toISOString(),
    rungLabel,
  };
}
