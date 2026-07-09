import { Request, Response } from "express";
import { CompIQEstimateRequest, type PredictionCallContext } from "../../types/compiq.types.js";
import { DynamicPricingOrchestrator } from "../../modules/compiq/services/pricing/core/DynamicPricingOrchestrator.js";
import { normalizeGradeCompany, normalizeParallel, normalizeSetName } from "./normalizationDictionary.service.js";
import { normalizePlayerName } from "./parallelTokenizer.js";
import { findCompsRouted, searchCardsRouted, getCardSalesRouted, getCardSalesRoutedWithProvenance, getCardMetaById, type QueryContext, type RoutedCard, type CardIdentityHint } from "./cardsight.router.js";
import {
  type CardsightSaleRecord,
} from "./catalogSource.js";
// PHASE-4A-2.2 (2026-06-02): per-prediction cache-stats scope. The
// `cacheStatsContext.run` wrap around the body lets every cacheWrap call
// underneath tally hits/misses into a per-prediction bucket, which the
// predictionCorpus emit reads at write time to set `cache_hit` on the
// PredictionLogDocument. Single boundary, no signature churn at the 9
// call sites.
import { cacheStatsContext } from "../shared/cache.service.js";
import {
  parseCardQuery,
  getCompVariantMismatchReasons,
  type ParsedCardQuery,
} from "./cardQueryParser.js";
import { writeTrendSnapshot } from "../playerScore/trendHistory.service.js";
import { updatePlayerScoreFromEstimate } from "../playerScore/playerScore.service.js";
import { buildEngineMeta } from "./engineMeta.js";
import { getUserBySession } from "../authService.js";
import { classifyRegime } from "./regimeClassifier.js";
import { computePredictedRange, type PredictedRangeResult } from "./predictedRange.js";
// Issue #25 Phase 3 — tier-anchored predicted-range fallback (default OFF).
// Activated by env flag COMPIQ_PHASE3_TIER_ANCHORED=true. NEVER replaces the
// Phase 2 result; only augments when Phase 2 returns { low: null, high: null }.
import { computeTierAnchoredRange, type TierAnchoredResult } from "./predictedRangeTierAnchored.js";
import { buildPeerPool } from "./peerPoolBuilder.js";
import { getParallelAttributesLookup } from "./parallelAttributesLookup.js";
// Issue #25 Phase 3 REBUILD — multiplier-anchored predictedRange. Fires
// inside the variant-mismatch cross-parallel synthesis branch when sibling
// comps for the same player/year/set are available. Never replaces
// effectiveFmv; ADDS a forward-looking range alongside the synthesized FMV.
import {
  computeMultiplierAnchoredRange,
  type MultiplierAnchoredResult,
} from "./predictedRangeMultiplierAnchored.js";
import {
  computeMultiplierAnchoredPredictedPrice,
  type MultiplierAnchoredPredictedPriceResult,
} from "../../agents/multiplierAnchoredPredictedPrice.js";
import { type BowmanFamilyProduct, type BowmanFamilySubset } from "./chromeDraftMultipliers.js";
import { normalizeCardsightSetName } from "./cardsightSubsetNormalizer.js";
import {
  computeBaseAnchoredParallelFMV,
  type BaseAnchoredFmvResult,
} from "../../agents/baseAnchoredParallelFMV.js";
// CF-CH-LAST-SALE-MODEL-EXPECTATION removed with Cardsight decommission.
// modelExpectation + modelSignal are permanently null on every response;
// the cardhedge-last-sale path no longer emits a Build-B-derived signal.
type ModelExpectation = null;
type ModelSignal = null;
// TrendIQ Phase 1 (docs/phase0/trendiq_design.md) — forward-looking
// composite score. B.4.a wires Layer 1 only (player momentum from the
// signal aggregator); Layers 2 and 3 follow in B.4.b/c. The composite
// function already handles all 8 weight-table rows, so the response
// shape is stable across the phased rollout — missing layers just
// shift the weights per the locked matrix.
// CF-PLAYER-IN-SET-MOMENTUM (2026-06-09): TrendIQ Layer 1 source moved
// from the deprecated player-wide compsMomentum.json blob
// (fetchPlayerSignals) to a live per-(player, set) momentum signal.
// fetchPlayerSignals + the nightly blob job remain running but are no
// longer the source of truth here. CF-C re-homes the blob job to
// per-(player, set) tuples; this CF stops READING it.
import { fetchPlayerInSetMomentum } from "./playerInSetMomentum.service.js";
// CF-CARDSIGHT-SIBLING-DISCOVERY (2026-05-25 investigation, Approach A) —
// fetchSiblingSales wraps fetchCompsByPlayer + exact-card-id exclusion.
// See docs/phase0/cardsight_sibling_discovery_investigation.md.
import { fetchCompsByPlayer } from "./compsByPlayer.service.js";
import {
  computeCardTrajectory,
  computeSegmentTrajectory,
  computeSegmentTrajectoryAndFull,
  computeTrendIQ,
  formatTrendIQLogLine,
} from "./trendIQ.compute.js";
import type { TrendIQResult } from "./trendIQ.types.js";
// CF-NEXT-SALE-PREDICTION-LAYER (design d531939, Option B locked) —
// TrendIQ-driven forward projection layer on top of fairMarketValue.
import { computePredictedPrice } from "./forwardProjection.js";
import { writePredictionLog } from "./predictionCorpus.service.js";

// CF-DECOUPLE (2026-06-21): classify a free-text `body.product` string into
// the strict `BowmanFamilyProduct` union, returning `null` when the input is
// not Bowman-family (Topps Chrome, Panini Prizm, etc.). The 3 mechanism1
// call sites below short-circuit and skip the mechanism1 call entirely when
// this returns null — non-Bowman holdings then route through observed FMV /
// CF-A(a) base_auto_floor / honest null instead of being silently mis-routed
// to a Bowman row by the previous clamp.
//
// Replaces the pre-CF-DECOUPLE clamp `rawProduct.includes("Draft") ? "Bowman
// Draft" : "Bowman Chrome"` at the 3 sites, which force-fit ANY non-Bowman
// product (and bare "Bowman" at site #2) to "Bowman Chrome" — the silent
// mis-route the CF-PROD-RECON HALT surfaced.
//
// Preserves the legit half of the legacy fallback: Bowman free-text variants
// like "2024 Bowman Chrome RC" still normalize to "Bowman Chrome". The
// substring matching REQUIRES a "Bowman" word boundary so non-Bowman strings
// that incidentally contain "Draft" or "Chrome" (e.g. "Topps Chrome") no
// longer mis-resolve.
//
// Subset is intentionally NOT decoupled here — the spec's (B) scope leaves
// the hardcoded "Chrome Prospect Autographs" in place at all 3 sites. Bowman
// non-CPA holdings remain force-fit to CPA subset, a narrower residual
// addressed in CF-DECOUPLE-2 once a `cardsightSetName → BowmanFamilySubset`
// normalizer is properly budgeted.
export function classifyBowmanFamilyProduct(
  raw: string | undefined | null,
): BowmanFamilyProduct | null {
  const r = String(raw ?? "").trim();
  if (r.length === 0) return null;
  // Canonical strict matches first — direct passes for already-canonical input.
  if (r === "Bowman Draft") return "Bowman Draft";
  if (r === "Bowman Chrome") return "Bowman Chrome";
  if (r === "Bowman") return "Bowman";
  // Free-text Bowman normalization (preserves the legit half of the legacy
  // fallback). Order matters: more specific Bowman variants checked first.
  // Word-boundary anchored so non-Bowman strings can't sneak through via
  // incidental "Draft" / "Chrome" substrings (the pre-CF-DECOUPLE bug).
  if (/\bBowman\s+Draft\b/i.test(r)) return "Bowman Draft";
  if (/\bBowman\s+Chrome\b/i.test(r)) return "Bowman Chrome";
  if (/\bBowman\b/i.test(r)) return "Bowman";
  return null;
}

// CF-DECOUPLE (2026-06-21): null mechanism1 result emitted when the holding
// is non-Bowman (classifyBowmanFamilyProduct returns null at sites #1 and
// #2). Same shape `computeMultiplierAnchoredPredictedPrice` returns when no
// curated row matches — downstream `m1HasPrice` / `collisionM1 !== null`
// checks already null-handle this. Inlined as a constant to keep type
// drift impossible.
const NULL_MECHANISM1_RESULT: MultiplierAnchoredPredictedPriceResult = {
  predictedPrice: null,
  predictedPriceRange: null,
  predictedPriceAttribution: {
    mechanism: "multiplier-anchored",
    failureReason: "uncurated-subject-parallel",
  },
};

// Issue #25 Phase 3 — trim peer-pool diagnostics for the wire response.
// We keep counts only; sample comp data is not surfaced to the client.
function __extractPhase3Diags(
  d: Awaited<ReturnType<typeof buildPeerPool>>["diagnostics"],
) {
  return {
    primarySetCount: d.primarySetCount,
    fallbackSetsUsed: d.fallbackSetsUsed,
    fallbackPeerCount: d.fallbackPeerCount,
    totalCompsConsidered: d.totalCompsConsidered,
    dropCounts: d.dropCounts,
    nullReason: d.nullReason,
  };
}

// ---------------------------------------------------------------------------
// Card Hedge AI comp fetch (primary sold-data source — replaces Apify/eBay)
// ---------------------------------------------------------------------------

interface RawComp {
  price: number;
  title: string;
  soldDate: string;
  // CF-RECENTCOMPS-SALETYPE (2026-06-08): Cardsight wire-shape per-comp
  // listing_type ("fixed" | "auction" | null). Threaded through the
  // pipeline so the route-level recentComps[] can surface a saleType
  // chip to iOS. Optional + null-tolerant because the meaningful-query
  // fall-through path's RoutedResult may not always carry it.
  listingType?: string | null;
  // CF-RECENTCOMPS-IMAGEURL (2026-06-08): Cardsight wire-shape per-comp
  // image_url (typically `i.ebayimg.com/.../s-l225.jpg`). Threaded
  // alongside listingType so recentComps[] + excludedComps[] can show
  // a thumbnail. Null when the upstream record lacks it.
  imageUrl?: string | null;
}

/** CF-RECENTCOMPS-SALETYPE: map Cardsight's wire-shape listing_type to
 *  the iOS-facing saleType string. Unknown / null → undefined so the
 *  field is omitted on serialization. */
function saleTypeFromListingType(
  lt: string | null | undefined,
): "Buy It Now" | "Auction" | undefined {
  if (lt === "fixed") return "Buy It Now";
  if (lt === "auction") return "Auction";
  return undefined;
}

interface RegimeSummary {
  regime: "momentum" | "mean-reversion" | "illiquid" | "stable";
  volatilityPct: number;
  slopePctPerComp: number;
  confidence: number;
  note: string;
}

function detectMarketRegime(comps: RawComp[]): RegimeSummary {
  if (comps.length < 3) {
    return {
      regime: "illiquid",
      volatilityPct: 0,
      slopePctPerComp: 0,
      confidence: 0.25,
      note: "Low comp count; market treated as illiquid.",
    };
  }

  const prices = comps.map((c) => c.price).filter((p) => Number.isFinite(p) && p > 0);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((acc, p) => acc + (p - avg) * (p - avg), 0) / Math.max(1, prices.length - 1);
  const stdDev = Math.sqrt(Math.max(variance, 0));
  const volatilityPct = avg > 0 ? (stdDev / avg) * 100 : 0;

  const first = prices[0] ?? avg;
  const last = prices[prices.length - 1] ?? avg;
  const slopePctPerComp = first > 0 ? (((last - first) / first) * 100) / Math.max(1, prices.length - 1) : 0;

  if (volatilityPct > 35) {
    return {
      regime: "illiquid",
      volatilityPct,
      slopePctPerComp,
      confidence: 0.55,
      note: "Wide price dispersion indicates thin or fragmented liquidity.",
    };
  }

  if (slopePctPerComp > 1.5) {
    return {
      regime: "momentum",
      volatilityPct,
      slopePctPerComp,
      confidence: 0.68,
      note: "Recent comps are accelerating upward.",
    };
  }

  if (slopePctPerComp < -1.5) {
    return {
      regime: "mean-reversion",
      volatilityPct,
      slopePctPerComp,
      confidence: 0.66,
      note: "Recent comps are cooling after prior highs.",
    };
  }

  return {
    regime: "stable",
    volatilityPct,
    slopePctPerComp,
    confidence: 0.62,
    note: "Comps are clustered with no strong directional drift.",
  };
}

/**
 * Fetch recent sold comps from Card Hedge AI.
 *
 * Card Hedge is the authoritative sold-data source for CompIQ. We previously
 * called the Apify eBay actor here; that path returned 0 results in
 * production and has been removed entirely per the "no more apify" directive.
 *
 * Flow: free-text query → identifyCard() (AI match, requires ≥0.80 confidence)
 * with searchCards() fallback → getCardSales() for that card_id.
 *
 * Returns [] on any failure so the calling pipeline falls through to its
 * existing fallback estimate cleanly.
 */
interface FetchedComps {
  comps: RawComp[];
  card: {
    card_id: string;
    title: string | null;
    player: string | null;
    set: string | null;
    // CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): release/product line
    // (e.g. "Bowman Draft", "Topps Update"). Pinned path reads
    // pricing.card.set.release; routed path passes through the router's
    // detail.releaseName (which it also writes into `set`). Used by
    // Layer 1 source selection and the player-set-queue seed.
    release: string | null;
    year: string | number | null;
    number: string | null;
    variant: string | null;
  } | null;
  variantWarning: string[];
  /**
   * Sport category from Card Hedge's AI match (e.g. "Baseball",
   * "Basketball"). Null when no AI match, low confidence, or pinned-id
   * path (where category is not resolved). Consumed by the unsupported-
   * sport guard in computeEstimate.
   */
  aiCategory: string | null;
  /**
   * CF-CH-P5-PRIMARY (2026-06-25): which vendor served the comps.
   * "cardhedge" — CH won via the router's trust-guard.
   * "cardsight" — CS served (CH miss, blob, low-confidence bridge, or no
   *               identity to bridge).
   * null      — pre-P5 callers / unwired paths; treated as "cardsight" by
   *             the estimateSource mapping.
   */
  vendor?: "cardhedge" | "cardsight" | null;
  /**
   * CF-CH-P8-TESTS (2026-06-25): CardHedger's per-parallel card_id when CH
   * served the comps (from the bridge's identifyCard match). Undefined on
   * Cardsight rows. The engine response forwards this onto the corpus row's
   * chProvenance block; consumers can audit which CH catalog id served a
   * specific row.
   */
  chCardId?: string;
  /**
   * CF-CH-P8-TESTS (2026-06-25): trust-guard signal that accepted CH's data.
   *   "prices_by_card_honest" — primary signal (daily series non-empty)
   *   "title_cohesion_strong" — secondary (>=80% title cohesion on player+year)
   * Undefined on Cardsight rows.
   */
  chTrustReason?: "prices_by_card_honest" | "title_cohesion_strong";
  // CF-CARDSIGHT-RESOLVER-REDESIGN: parallel-match attribution.
  // Internal fine-grained source for telemetry/debugging; user-facing
  // 3-category collapse for response shape (exact/approximate/broad).
  // Surfaced on /api/compiq/estimate response so iOS can render
  // appropriate confidence disclosure.
  priceSourceInternal?: string;
  priceSource?: "exact" | "approximate" | "broad";
  parallelMatchFilteredCount?: number;
  parallelMatchUnifiedCount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CF-CH-P5-PRIMARY helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a CardIdentityHint from queryContext (the structured identity that
 * compiqEstimate threads down to fetchComps). Returns null when the
 * context isn't carrying enough to bridge over to CardHedge — playerName
 * is the hard floor (CH's card-match is fuzzy-text-driven and an empty
 * query cannot resolve usefully).
 */
function buildIdentityHintFromContext(
  ctx: QueryContext | undefined,
  parallelId?: string | null,
): CardIdentityHint | null {
  if (!ctx) return null;
  const playerName = (ctx.playerName ?? "").trim();
  if (!playerName) return null;
  return {
    playerName,
    cardYear: ctx.cardYear,
    product: ctx.product,
    parallel: ctx.parallel,
    // CF-ENGINE-PARALLEL-CANONICALIZE (2026-06-26): thread the Cardsight
    // parallel UUID into the bridge so the router can substitute the
    // catalog's authoritative parallel name + numberedTo for iOS's
    // loose `parallel` string. iOS's `/api/compiq/price-by-id` body
    // carries parallelId as a top-level field (NOT inside queryContext),
    // so the caller must pass it explicitly.
    parallelId: parallelId ?? undefined,
    number: ctx.cardNumber,
    isAuto: ctx.isAuto,
  };
}

/**
 * Build a FetchedComps.card identity from queryContext when CardHedge
 * serves comps on the pinned-id path. CH gives us comps but not the rich
 * Cardsight card metadata (set.name, set.release, etc.), so we synthesize
 * identity from the structured fields the caller already supplied. Same
 * shape as the stub-identity path used when Cardsight's pricing.card is
 * absent.
 */
function buildIdentityFromContext(
  ctx: QueryContext | undefined,
  pinnedCardId: string,
): NonNullable<FetchedComps["card"]> {
  return {
    card_id: pinnedCardId,
    title: null,
    player: ctx?.playerName ?? null,
    set: ctx?.product ?? null,
    release: ctx?.product ?? null,
    year: ctx?.cardYear ?? null,
    number: ctx?.cardNumber ?? null,
    variant: ctx?.parallel ?? null,
  };
}

/** Median of a numeric array. Returns null on empty input. */
function chComputeMedian(values: number[]): number | null {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * Map CardHedge RoutedSale[] (from getCardSalesRouted) to the engine's
 * RawComp[] shape. The fields match the free-text path's mapping at line
 * ~1714. listingType comes from CH's sale_type ("Auction" | "Best Offer");
 * imageUrl is null because CardHedge does not surface card images.
 */
function chSalesToRawComps(
  sales: Array<{ price: number; date: string | null; title: string | null; sale_type: string | null }>,
  bodyIdentity: { year?: string | number; product?: string; playerName?: string; parallel?: string; cardNumber?: string },
): RawComp[] {
  return sales
    .map((s) => ({
      price: s.price,
      title: s.title || [
        bodyIdentity.year,
        bodyIdentity.product,
        bodyIdentity.playerName,
        bodyIdentity.cardNumber,
        bodyIdentity.parallel,
      ].filter(Boolean).join(" "),
      soldDate: s.date ?? "",
      listingType: s.sale_type ?? null,
      imageUrl: null,
    }))
    .filter((c) => c.price > 0);
}

/**
 * Broader-pool trend signal.
 * Anchors stay pinned to the exact card_id's direct sales. The trend %
 * comes from ALL similar cards (same player + year + set, every variant)
 * so a thin/rare card with only 2 direct comps still gets a market-wide
 * direction reading instead of a flat noise number.
 */
export interface BroaderTrend {
  impliedTrendPct: number;
  direction: "up" | "down" | "flat";
  recentMedian: number | null;
  olderMedian: number | null;
  recentCount: number;
  olderCount: number;
  similarCardsScanned: number;
  totalSamples: number;
  windowRecentDays: number;
  windowOlderDays: number;
  basedOn: "exact" | "broader" | "insufficient";
}

// ---------------------------------------------------------------------------
// Velocity-weighted recency (Pricing Accuracy — Improvement 1)
// ---------------------------------------------------------------------------
// Sales from the last 48 hours carry 5x the weight of 3-week-old sales so the
// anchor price responds to recent market moves instead of lagging behind.
export function getSaleVelocityWeight(saleDate: string | number | Date | null | undefined): number {
  if (!saleDate) return 0.1;
  const ts = typeof saleDate === "number" ? saleDate : Date.parse(String(saleDate));
  if (!Number.isFinite(ts)) return 0.1;
  const hoursAgo = (Date.now() - ts) / (1000 * 60 * 60);
  if (hoursAgo <= 48) return 5.0;   // last 48h — hyper recent
  if (hoursAgo <= 168) return 2.0;  // last 7d — recent
  if (hoursAgo <= 504) return 1.0;  // last 21d — standard
  if (hoursAgo <= 720) return 0.3;  // last 30d — stale
  return 0.1;                        // older than 30d — very stale
}

// CF-BIN-VS-AUCTION-WEIGHT (2026-07-05, Drew): closed BIN sales encode
// a stronger forward-looking signal than closed auction sales. A BIN
// close means the buyer voluntarily paid the seller's fixed price
// without a bidding war forcing them upward; the seller's ask reflects
// deliberate current-market judgment. Auction closes reflect the
// second-highest bidder's ceiling. On the same card, BIN and auction
// prices systematically diverge — BIN typically 15-30% above matching
// auction. Weighting BIN heavier in the median catches the "market
// is running hot" signal earlier by letting deliberate-price data
// carry more of the aggregation.
const BIN_WEIGHT_MULTIPLIER = 1.5;
const AUCTION_WEIGHT_MULTIPLIER = 1.0;

/**
 * Classify a CH `sale_type` string into a weight multiplier. Case-
 * insensitive substring match. Unknown / null defaults to auction
 * weight so the change is monotonically upward-only (BIN samples
 * lift; nothing gets penalized below current behavior).
 */
export function getSaleTypeWeightMultiplier(saleType: string | null | undefined): number {
  if (!saleType || typeof saleType !== "string") return AUCTION_WEIGHT_MULTIPLIER;
  const s = saleType.toLowerCase();
  // Match common eBay listing type vocab. "auction with buy it now"
  // takes precedence over "auction" so that "AUCTION_WITH_BIN" doesn't
  // fall to the auction path — it still allowed a fixed-price close.
  if (s.includes("buy it now") || s.includes("fixed") || s.includes("bin") ||
      s.includes("buy_it_now") || s.includes("fixed_price")) {
    return BIN_WEIGHT_MULTIPLIER;
  }
  return AUCTION_WEIGHT_MULTIPLIER;
}

/**
 * Continuous weighted-median: returns the price at which cumulative weight
 * first crosses half of the total. Falls back to the highest-priced sample
 * when weights are degenerate.
 *
 * CF-BIN-VS-AUCTION-WEIGHT (2026-07-05): `saleType` is optional on each
 * sample. When present and identifies as BIN, that sample's weight is
 * multiplied by BIN_WEIGHT_MULTIPLIER on top of the recency weight.
 * Callers without sale_type context see identical behavior to pre-CF.
 */
export function computeWeightedMedian(
  samples: ReadonlyArray<{
    price: number;
    date: string | number | Date | null | undefined;
    saleType?: string | null;
  }>
): number | null {
  if (samples.length === 0) return null;
  const weighted = samples
    .filter((s) => Number.isFinite(s.price) && s.price > 0)
    .map((s) => ({
      price: s.price,
      weight: getSaleVelocityWeight(s.date) * getSaleTypeWeightMultiplier(s.saleType),
    }))
    .sort((a, b) => a.price - b.price);
  if (weighted.length === 0) return null;
  const totalWeight = weighted.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight <= 0) return weighted[Math.floor(weighted.length / 2)].price;
  const half = totalWeight / 2;
  let cum = 0;
  for (const item of weighted) {
    cum += item.weight;
    if (cum >= half) return item.price;
  }
  return weighted[weighted.length - 1].price;
}

// ---------------------------------------------------------------------------
// Comp quality filter (Pricing Accuracy — Improvement 2)
// ---------------------------------------------------------------------------
// Two-kind exclusion vocabulary (CF-EXCLUSION-WORD-BOUNDARY, 2026-06-08):
//   - string entries  → substring `title.includes(kw)` match. Used for
//                       multi-word phrases ("please read", " as is") and
//                       single-word tokens with no known substring
//                       conflict ("bundle", "wholesale").
//   - RegExp entries  → `kw.test(title)` match. Used for substring-prone
//                       single-word damage tokens. Pattern anchors the
//                       stem with `\b` on both sides and inflects via a
//                       trailing `(s|d|ed)?` group so plurals + past
//                       tense match without absorbing unrelated longer
//                       words (the canonical fix: `\bflaw(s|ed)?\b`
//                       matches `flaw / flaws / flawed` but NOT
//                       `Flawless`).
//
// Order matters — more specific phrases must precede their shorter prefixes
// so e.g. "lot of" matches before "lot ".
const EXCLUSION_KEYWORDS: ReadonlyArray<string | RegExp> = [
  // Lot sales (specific first) — substring
  "lot of", "lot ", "bundle", "collection", "bulk", "wholesale",
  "3 card", "5 card", "10 card", "set of", "group of",
  // Damaged / altered — word-anchored regexes.
  // Single unified pattern per stem; the inflection group means we
  // report `keyword:damage` for `damaged`/`damages` AND `damage` (single
  // reason key per stem makes the histogram cleaner).
  /\bdamage(d|s)?\b/,
  /\bcrease(d|s)?\b/,
  /\bbent\b/,
  /\bflaw(s|ed)?\b/,                       // ← bug 1 fix: was matching "Flawless"
  /\bscuff(s|ed)?\b/,
  /\bstain(s|ed)?\b/,
  /\bworn\b/,
  /\btrimmed\b/, /\baltered\b/, /\brestored\b/, /\brepaired\b/,
  /\bfake\b/, /\breprint(s|ed|ing)?\b/,
  // Water damage as a phrase stays substring — "damage" alone already
  // matches via the regex above, but "water damage" gives a more useful
  // reason key.
  "water damage",
  "writing on", "marks on",
  "poor condition", "fair condition", "rough condition", "rough shape",
  // Seller-condition disclaimers — "buyer beware" cues that disqualify
  // a comp from the math + display pool. Word-anchored where needed
  // ("as is" with leading space to avoid hitting "Atlas is").
  "see description", "see desc",
  "please read", "read description", "read desciption",
  " as is", " as-is", "(as is)", "(as-is)",
  // Redemption / not actual card
  "redemption", "placeholder", "digital",
  // Test / sample
  "prototype", "sample card", "test print",
];

function exclusionReasonLabel(kw: string | RegExp): string {
  if (typeof kw === "string") return kw.trim();
  // For regex entries, strip `\b` anchors + inflection groups so the
  // reason histogram reads `keyword:flaw` not `keyword:\\bflaw(s|ed)?\\b`.
  // We use the source up to the first `(` or end of pattern, then strip
  // leading/trailing `\b`.
  const src = kw.source;
  const stem = src.split("(")[0].replace(/\\b/g, "").trim();
  return stem;
}

interface CardIdentityLite {
  player?: string | null;
  year?: string | number | null;
  set?: string | null;
  // CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): the release/product line
  // (e.g. "Bowman Draft", "Topps Update"). Distinct from `set`, which is
  // the literal pricing.card.set.name — Cardsight uses "Base Set" for
  // every release's main subset, so `set` alone collides across releases.
  // Player-in-set scoping (Layer 1 source + nightly history key) must
  // use `release` so 2024 Bowman Draft Griffin and 2025 Topps Series 1
  // Griffin don't blend into one corrupted history.
  release?: string | null;
}

interface CompQualityVerdict {
  include: boolean;
  reason: string;
}

function scoreCompQuality(sale: RawComp, _card: CardIdentityLite): CompQualityVerdict {
  const title = (sale.title ?? "").toLowerCase();
  if (!title || !Number.isFinite(sale.price) || sale.price <= 0) {
    return { include: false, reason: "invalid" };
  }
  for (const kw of EXCLUSION_KEYWORDS) {
    if (typeof kw === "string") {
      if (title.includes(kw)) {
        return { include: false, reason: `keyword:${exclusionReasonLabel(kw)}` };
      }
    } else {
      if (kw.test(title)) {
        return { include: false, reason: `keyword:${exclusionReasonLabel(kw)}` };
      }
    }
  }
  return { include: true, reason: "ok" };
}

/**
 * Robust outlier trim using Median Absolute Deviation (MAD). A single wild
 * sale cannot inflate the spread the way it does with mean/σ, so this catches
 * real outliers even on small (n≥4) samples. Threshold uses the standard
 * modified-z-score cutoff: |0.6745·(p − median) / MAD| > 3.5.
 * Skipped when sample size < 4 or when the distribution is degenerate.
 *
 * Returns BOTH the kept set and the per-comp removed list so consumers
 * that need to surface excluded comps (CF-MARKET-READ-EXCLUDED-CALLOUT,
 * 2026-06-08) can label them individually. Existing applyCompQualityFilter
 * uses `removedComps.length` for the histogram count.
 */
function filterPriceOutliers(sales: RawComp[]): { kept: RawComp[]; removedComps: RawComp[] } {
  if (sales.length < 4) return { kept: sales, removedComps: [] };
  const prices = sales.map((s) => s.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  const absDevs = prices.map((p) => Math.abs(p - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)];
  if (mad <= 0) {
    // Degenerate spread — fall back to mean/σ so we still trim something useful
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev <= 0) return { kept: sales, removedComps: [] };
    const kept: RawComp[] = [];
    const removed: RawComp[] = [];
    for (const s of sales) {
      if (Math.abs(s.price - mean) <= stdDev * 2.5) kept.push(s);
      else removed.push(s);
    }
    return { kept, removedComps: removed };
  }
  const kept: RawComp[] = [];
  const removed: RawComp[] = [];
  for (const s of sales) {
    if (Math.abs(0.6745 * (s.price - median) / mad) <= 3.5) kept.push(s);
    else removed.push(s);
  }
  return { kept, removedComps: removed };
}

interface CompQualityResult {
  filtered: RawComp[];
  excluded: number;
  reasons: Record<string, number>;
}

/** CF-MARKET-READ-EXCLUDED-CALLOUT (2026-06-08): per-comp exclusion shape
 *  used by callers that need to surface the dropped comps individually
 *  (e.g. iOS Recent Sales list — "show greyed sub-section labeled
 *  Damaged / Read desc."). */
export interface CompExclusion {
  comp: RawComp;
  reason: string;
}

export interface CompQualityResultDetailed {
  filtered: RawComp[];
  excluded: CompExclusion[];
  reasons: Record<string, number>;
}

/** Same filter pass as applyCompQualityFilter but ALSO returns each
 *  excluded comp tagged with the reason that disqualified it. Used by
 *  marketRead.service to build the response's `excludedComps[]`. */
export function applyCompQualityFilterDetailed(
  sales: RawComp[],
  card: CardIdentityLite,
): CompQualityResultDetailed {
  const reasons: Record<string, number> = {};
  const excluded: CompExclusion[] = [];
  const passed: RawComp[] = [];
  for (const s of sales) {
    const verdict = scoreCompQuality(s, card);
    if (verdict.include) {
      passed.push(s);
    } else {
      reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
      excluded.push({ comp: s, reason: verdict.reason });
    }
  }
  const { kept, removedComps } = filterPriceOutliers(passed);
  if (removedComps.length > 0) {
    reasons["outlier"] = (reasons["outlier"] ?? 0) + removedComps.length;
    for (const r of removedComps) excluded.push({ comp: r, reason: "outlier" });
  }
  return { filtered: kept, excluded, reasons };
}

export function applyCompQualityFilter(sales: RawComp[], card: CardIdentityLite): CompQualityResult {
  // Delegate to the detailed implementation so the per-comp and
  // histogram paths can never diverge.
  const detailed = applyCompQualityFilterDetailed(sales, card);
  return {
    filtered: detailed.filtered,
    excluded: detailed.excluded.length,
    reasons: detailed.reasons,
  };
}

// ---------------------------------------------------------------------------
// Grader premium coefficients (Pricing Accuracy — Improvement 3)
// ---------------------------------------------------------------------------
// CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28): replaced the prior flat-per-grade
// table with a PRICE-TIERED structure sourced from Prospects Live's "Pitchers,
// Hitters, and PSA Grades: The PSA Grading Multiplier for MiLB Prospect Cards"
// (https://www.prospectslive.com/...). The prior flat 4.0× for PSA 10 was
// roughly correct at <$25 raw but systematically OVERSTATED graded value at
// the $50+ tier (real PSA 10 multiplier at $100+ raw is ~2.2×, not 4.0×) and
// UNDERSTATED PSA 9 at <$25 (real 2.56× vs old 1.7×). The article's data also
// confirms PSA 9 LOSES value above $50 raw — the prior 1.7× was a guaranteed
// over-claim there.
//
// SCOPE: pitching prospects baseline. Hitter data was promised by the article
// but not included in the published excerpt; we'll fold it in once we have
// either the article's update or our own observed data via the telemetry the
// CF adds below (logGraderRatioObserved). Veteran/established player
// multipliers may differ — the per-player overlay arrives in a follow-up CF
// after the data accumulates.
//
// BGS/SGC/CGC tiers derive multiplicatively from PSA per existing hobby
// convention (no independent dataset for them yet).
//
// HOW THE LOOKUP WORKS: when callers pass `rawPrice`, the function picks the
// matching tier. When they don't (legacy callers), the function returns the
// `fallback` tier value which equals the article's overall pitcher average.
// That fallback is intentionally a slight regression from the prior flat
// constants (PSA 10 3.43× vs 4.0×) — the prior constants were too high on
// average. The change in tier coverage is the entire point of this CF.

export type GradePriceTier = "<25" | "25-50" | "50-100" | "100+" | "fallback";

interface GradeTierTable {
  "<25": number;
  "25-50": number;
  "50-100": number;
  "100+": number;
  fallback: number;
}

const GRADER_PREMIUMS: Record<string, Record<string, GradeTierTable>> = {
  PSA: {
    // PSA 10 — article: 4.9 (<$25), ~3.6 ($25-50), ~2.8 ($50-100), ~2.2 ($100+),
    // overall avg 3.43 (pitching prospects, n≈60).
    "10": { "<25": 4.9, "25-50": 3.6, "50-100": 2.8, "100+": 2.2, fallback: 3.43 },
    // PSA 9 — article: 2.56 (<$25), ~1.5 ($25-50), <1.0 at $50+ (real value loss).
    // We clamp to 0.85 minimum to avoid extreme-loss baseline noise.
    "9":  { "<25": 2.56, "25-50": 1.5, "50-100": 0.95, "100+": 0.85, fallback: 1.70 },
    // PSA 8 — article: "consistently loses value" → all tiers below 1.0.
    "8":  { "<25": 0.95, "25-50": 0.90, "50-100": 0.85, "100+": 0.80, fallback: 0.90 },
    "7":  { "<25": 0.85, "25-50": 0.80, "50-100": 0.75, "100+": 0.70, fallback: 0.78 },
    "6":  { "<25": 0.75, "25-50": 0.70, "50-100": 0.65, "100+": 0.60, fallback: 0.68 },
    "5":  { "<25": 0.65, "25-50": 0.60, "50-100": 0.55, "100+": 0.50, fallback: 0.58 },
  },
  BGS: {
    // BGS 10 ("Black Label") — typically 1.5× PSA 10.
    "10":  { "<25": 7.35, "25-50": 5.40, "50-100": 4.20, "100+": 3.30, fallback: 5.15 },
    // BGS 9.5 ≈ PSA 10 × 0.89 (from external-source ratio: PSA 10 = BGS 9.5 × 1.12).
    "9.5": { "<25": 4.36, "25-50": 3.20, "50-100": 2.49, "100+": 1.96, fallback: 3.05 },
    // BGS 9 ≈ PSA 9 × 0.94.
    "9":   { "<25": 2.41, "25-50": 1.41, "50-100": 0.89, "100+": 0.80, fallback: 1.60 },
    "8.5": { "<25": 1.10, "25-50": 1.00, "50-100": 0.95, "100+": 0.90, fallback: 1.00 },
    "8":   { "<25": 1.00, "25-50": 0.95, "50-100": 0.90, "100+": 0.85, fallback: 0.95 },
  },
  SGC: {
    // SGC 10 ≈ PSA 10 × 0.85.
    "10":  { "<25": 4.17, "25-50": 3.06, "50-100": 2.38, "100+": 1.87, fallback: 2.92 },
    "9.5": { "<25": 3.72, "25-50": 2.74, "50-100": 2.13, "100+": 1.67, fallback: 2.61 },
    "9":   { "<25": 2.30, "25-50": 1.35, "50-100": 0.86, "100+": 0.77, fallback: 1.53 },
    "8.5": { "<25": 1.05, "25-50": 0.95, "50-100": 0.90, "100+": 0.85, fallback: 0.95 },
    "8":   { "<25": 0.95, "25-50": 0.90, "50-100": 0.85, "100+": 0.80, fallback: 0.90 },
  },
  CGC: {
    // CGC 10 ≈ PSA 10 × 0.80.
    "10":  { "<25": 3.92, "25-50": 2.88, "50-100": 2.24, "100+": 1.76, fallback: 2.74 },
    "9.5": { "<25": 3.49, "25-50": 2.56, "50-100": 1.99, "100+": 1.57, fallback: 2.44 },
    "9":   { "<25": 2.18, "25-50": 1.28, "50-100": 0.81, "100+": 0.73, fallback: 1.45 },
    "8.5": { "<25": 1.05, "25-50": 0.95, "50-100": 0.88, "100+": 0.83, fallback: 0.93 },
    "8":   { "<25": 0.93, "25-50": 0.88, "50-100": 0.83, "100+": 0.78, fallback: 0.88 },
  },
};

/**
 * CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28): map a raw anchor price to its
 * tier bucket. Boundaries chosen to match the Prospects Live article's
 * reported tier structure ($25, $50, $100 break points).
 */
export function rawPriceToGradeTier(rawPrice: number | null | undefined): GradePriceTier {
  if (rawPrice == null || !Number.isFinite(rawPrice) || rawPrice <= 0) {
    return "fallback";
  }
  if (rawPrice < 25) return "<25";
  if (rawPrice < 50) return "25-50";
  if (rawPrice < 100) return "50-100";
  return "100+";
}

/**
 * CF-VINTAGE-GRADER-PREMIUMS (2026-06-29): empirical multiplier table
 * calibrated from CardHedge data for vintage (pre-1990) cards. Shape:
 *   table[era][company][grade][tier] = ratio
 * where era ∈ {"1948-1969", "1970-1989"} and tier covers the wider
 * vintage price band (50-100, 100-500, ..., 5000+).
 *
 * Lazy load + null cache same pattern as auto table. Refresh ships
 * as CF-VINTAGE-MULTIPLIER-REFRESH-JOB follow-up.
 */
type VintageMultiplierTable = {
  calibratedAt?: string;
  sampleSize?: { totalObservations: number; uniqueCards: number };
  table?: Record<string, Record<string, Record<string, Record<string, number>>>>;
};

let _vintageTableCache: VintageMultiplierTable | null | undefined = undefined;
function getVintageTable(): VintageMultiplierTable | null {
  if (_vintageTableCache !== undefined) return _vintageTableCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const p = path.resolve(process.cwd(), "data/vintage-multipliers-latest.json");
    if (!fs.existsSync(p)) {
      _vintageTableCache = null;
      return null;
    }
    _vintageTableCache = JSON.parse(fs.readFileSync(p, "utf-8")) as VintageMultiplierTable;
    return _vintageTableCache;
  } catch (err) {
    console.warn(`[compiqEstimate] vintage-multipliers load failed: ${(err as Error)?.message ?? err}`);
    _vintageTableCache = null;
    return null;
  }
}

function vintageEraFor(year: number): string | null {
  if (year >= 1948 && year <= 1969) return "1948-1969";
  if (year >= 1970 && year <= 1989) return "1970-1989";
  return null;
}

/**
 * CF-AUTO-AWARE-MULTIPLIERS (2026-06-28): empirical auto-specific
 * multiplier table calibrated from 848 prospect-autograph cards' CH
 * 90-day-avg prices. Loaded lazily on first access; refreshed by a
 * weekly Azure Function (CF-AUTO-MULTIPLIER-REFRESH-JOB follows).
 * Fall through to the static GRADER_PREMIUMS when (a) the calibration
 * file is missing or fails to parse OR (b) the requested cardClass
 * is not "autograph".
 */
type AutoMultiplierTable = {
  calibratedAt?: string;
  sampleSize?: { total: number };
  table?: Record<string, Record<string, Record<string, number>>>;
};

let _autoTableCache: AutoMultiplierTable | null | undefined = undefined;
function getAutoTable(): AutoMultiplierTable | null {
  if (_autoTableCache !== undefined) return _autoTableCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const p = path.resolve(process.cwd(), "data/auto-multipliers-latest.json");
    if (!fs.existsSync(p)) {
      _autoTableCache = null;
      return null;
    }
    _autoTableCache = JSON.parse(fs.readFileSync(p, "utf-8")) as AutoMultiplierTable;
    return _autoTableCache;
  } catch (err) {
    console.warn(`[compiqEstimate] auto-multipliers load failed: ${(err as Error)?.message ?? err}`);
    _autoTableCache = null;
    return null;
  }
}

/**
 * CF-BASE-MULTIPLIER-ENGINE-WIRING (2026-06-29): empirical base-graded
 * multiplier table calibrated from 4,421 modern (1990+) base graded
 * observations across 6,880 unique cards. Replaces the static
 * GRADER_PREMIUMS table (hand-curated from a 2018 article) for modern
 * base graded cards.
 *
 * GATED by env var MULTIPLIER_BASE_TABLE_ENABLED — default OFF so the
 * deployed engine continues using static GRADER_PREMIUMS. Flip to
 * "true" in App Service application settings when ready to roll out.
 *
 * Expected impact on flip: modern PSA 10 base graded holdings see
 * 10-127% price increases (biggest delta in the <$25 raw tier where
 * static was 4.9× and empirical is 11.1×).
 */
type BaseMultiplierTable = {
  calibratedAt?: string;
  sampleSize?: { totalObservations: number; uniqueCards: number };
  table?: Record<string, Record<string, Record<string, number>>>;
};

let _baseTableCache: BaseMultiplierTable | null | undefined = undefined;
function getBaseTable(): BaseMultiplierTable | null {
  if (_baseTableCache !== undefined) return _baseTableCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const p = path.resolve(process.cwd(), "data/base-multipliers-latest.json");
    if (!fs.existsSync(p)) {
      _baseTableCache = null;
      return null;
    }
    _baseTableCache = JSON.parse(fs.readFileSync(p, "utf-8")) as BaseMultiplierTable;
    return _baseTableCache;
  } catch (err) {
    console.warn(`[compiqEstimate] base-multipliers load failed: ${(err as Error)?.message ?? err}`);
    _baseTableCache = null;
    return null;
  }
}

function isBaseTableEnabled(): boolean {
  // Read each time so test-time env stub flips take effect immediately.
  return String(process.env.MULTIPLIER_BASE_TABLE_ENABLED ?? "").toLowerCase() === "true";
}

/**
 * Tier resolver supporting both the static-table tiers (<25, 25-50,
 * 50-100, 100+) AND the empirical-table tiers (..., 100-250, 250-500,
 * 500-1000, 1000+). The caller's `rawPrice` lands in whichever tier
 * exists in the target table — we resolve by walking the table's
 * declared tier keys for the highest match the price clears.
 */
function resolveTierForTable(
  table: Record<string, number> | undefined,
  rawPrice: number | null | undefined,
): number | null {
  if (!table) return null;
  if (rawPrice == null || !Number.isFinite(rawPrice) || rawPrice <= 0) {
    return typeof table.fallback === "number" ? table.fallback : null;
  }
  const tierKeys = [
    "<25", "25-50", "50-100", "100-250", "250-500", "500-1000", "100+", "1000+",
    // CF-VINTAGE-GRADER-PREMIUMS (2026-06-29) — vintage scan emits a
    // higher-headroom tier scheme because vintage HOFs blow past the
    // modern-prospect ceilings ($66 Raw / $1.83M PSA 8 is in-band).
    "<50", "100-500", "1000-5000", "5000+",
  ];
  const present = tierKeys.filter((k) => typeof table[k] === "number");
  if (present.length === 0) {
    return typeof table.fallback === "number" ? table.fallback : null;
  }
  // Pick the tier the price falls into.
  const price = rawPrice;
  let pick: string | null = null;
  for (const k of present) {
    if (k === "<25" && price < 25) pick = k;
    else if (k === "25-50" && price >= 25 && price < 50) pick = k;
    else if (k === "50-100" && price >= 50 && price < 100) pick = k;
    else if (k === "100-250" && price >= 100 && price < 250) pick = k;
    else if (k === "250-500" && price >= 250 && price < 500) pick = k;
    else if (k === "500-1000" && price >= 500 && price < 1000) pick = k;
    else if (k === "100+" && price >= 100) pick = k;
    else if (k === "1000+" && price >= 1000) pick = k;
    // vintage tiers
    else if (k === "<50" && price < 50) pick = k;
    else if (k === "100-500" && price >= 100 && price < 500) pick = k;
    else if (k === "1000-5000" && price >= 1000 && price < 5000) pick = k;
    else if (k === "5000+" && price >= 5000) pick = k;
  }
  if (pick && typeof table[pick] === "number") return table[pick];
  return typeof table.fallback === "number" ? table.fallback : null;
}

export function getGraderPremium(
  gradingCompany: string | null | undefined,
  grade: string | null | undefined,
  rawPrice?: number | null,
  cardClass?: "autograph" | "base",
  cardYear?: number | null,
): number {
  if (!gradingCompany || grade == null) return 1.0;
  const company = String(gradingCompany).toUpperCase().trim();
  const gradeKey = String(grade).trim();

  // CF-VINTAGE-GRADER-PREMIUMS (2026-06-29): vintage takes precedence
  // over autograph + static for any card with year in [1948, 1989].
  // PSA grade multipliers on vintage cards are 10-100× higher than Raw
  // — the static table's 0.80 PSA 8 / Raw ratio at "100+" tier produces
  // the Mantle $2.28M class breakdown when applied to vintage. The
  // empirical vintage table is calibrated per era + price tier from
  // actual CH sale pairs.
  if (cardYear && cardYear >= 1948 && cardYear <= 1989) {
    const era = vintageEraFor(cardYear);
    const vintage = getVintageTable();
    if (era && vintage?.table?.[era]?.[company]?.[gradeKey]) {
      const tier = vintage.table[era][company][gradeKey];
      const vintageValue = resolveTierForTable(tier, rawPrice);
      if (vintageValue != null && Number.isFinite(vintageValue) && vintageValue > 0) {
        return vintageValue;
      }
    }
    // else fall through (vintage table may not cover every era/grade combo yet)
  }

  // CF-AUTO-AWARE-MULTIPLIERS (2026-06-28): prefer the empirical auto
  // table when the card is autograph-class. Falls through to the static
  // base table on any miss (no row for tier, no row for grade, no table
  // for company).
  if (cardClass === "autograph") {
    const auto = getAutoTable();
    const autoTier = auto?.table?.[company]?.[gradeKey];
    const autoValue = resolveTierForTable(autoTier, rawPrice);
    if (autoValue != null && Number.isFinite(autoValue) && autoValue > 0) {
      return autoValue;
    }
    // else fall through to base table (logged in telemetry as a calibration gap)
  }

  // CF-BASE-MULTIPLIER-ENGINE-WIRING (2026-06-29): when the env flag
  // MULTIPLIER_BASE_TABLE_ENABLED is "true", prefer the empirical base
  // table for modern (1990+) base graded cards. Default OFF preserves
  // the legacy static-table behavior — flip the flag in App Service
  // application settings when ready to roll out the new pricing.
  if (isBaseTableEnabled()) {
    const base = getBaseTable();
    const baseTier = base?.table?.[company]?.[gradeKey];
    const baseValue = resolveTierForTable(baseTier, rawPrice);
    if (baseValue != null && Number.isFinite(baseValue) && baseValue > 0) {
      return baseValue;
    }
    // else fall through to static
  }

  const tierTable = GRADER_PREMIUMS[company]?.[gradeKey];
  if (!tierTable) return 1.0;
  const tier = rawPriceToGradeTier(rawPrice);
  return tierTable[tier];
}

/**
 * CF-CH-TIERED-GRADER-PREMIUMS (2026-06-28): telemetry side-channel for the
 * per-player calibration follow-up. Logs an observed graded-to-raw ratio
 * whenever the engine has paired sales data (graded comp + raw median) for
 * the same card. Aggregating across many (player, grade) observations lets
 * us derive per-player multipliers later via App Insights KQL queries on
 * the `graded_ratio_observed` event.
 *
 * Fire-and-forget — never throws, never affects the priced response.
 * Telemetry payload kept minimal so storage cost stays bounded.
 */
export function logGraderRatioObserved(opts: {
  source: string;
  player: string | null;
  cardId: string | null;
  gradingCompany: string;
  grade: string;
  rawAnchor: number;
  gradedValue: number;
}): void {
  if (!opts.rawAnchor || opts.rawAnchor <= 0 || !opts.gradedValue || opts.gradedValue <= 0) return;
  const ratio = opts.gradedValue / opts.rawAnchor;
  const tier = rawPriceToGradeTier(opts.rawAnchor);
  try {
    console.log(JSON.stringify({
      event: "graded_ratio_observed",
      source: opts.source,
      player: opts.player,
      cardId: opts.cardId,
      gradingCompany: opts.gradingCompany,
      grade: opts.grade,
      rawAnchor: Math.round(opts.rawAnchor * 100) / 100,
      gradedValue: Math.round(opts.gradedValue * 100) / 100,
      ratio: Math.round(ratio * 1000) / 1000,
      tier,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // Telemetry failures must never propagate.
  }
}

/**
 * CF-CH-FMV-CROSS-VALIDATE (2026-06-28): emit one App Insights event
 * comparing our engine FMV against CardHedge's two reference shapes
 * (card-fmv = index-adjusted, price-estimate = direct). Fire-and-forget;
 * telemetry failures must never propagate.
 *
 * Drift signal interpretation (downstream KQL):
 *   ratio ~ 1.0   → our FMV agrees with CH's reference
 *   ratio < 0.7   → we're materially under CH (potentially undervaluing)
 *   ratio > 1.4   → we're materially over CH (potentially overvaluing)
 *   |ratio| outside [0.5, 2.0] consistently per-card → calibration target
 *
 * `engineFmv` is the composed Build B value the route is about to surface.
 * `chCardFmv` + `chPriceEstimate` are the two CH endpoints — pass null
 * when either fetch failed (telemetry still records the side that returned).
 */
export function logFmvDriftObserved(opts: {
  source: string;
  player: string | null;
  cardId: string;
  gradingCompany: string | null;
  grade: string | null;
  engineFmv: number | null;
  chCardFmv: {
    price: number;
    confidence: number | null;
    confidenceGrade: string | null;
    freshnessDays: number | null;
    method: string | null;
  } | null;
  chPriceEstimate: {
    price: number;
    confidence: number | null;
    method: string | null;
  } | null;
}): void {
  // Skip if neither CH signal is present — nothing to compare against.
  if (!opts.chCardFmv && !opts.chPriceEstimate) return;
  const engine = Number.isFinite(opts.engineFmv) && (opts.engineFmv ?? 0) > 0 ? opts.engineFmv : null;
  const cardFmvRatio = engine && opts.chCardFmv && opts.chCardFmv.price > 0
    ? Math.round((engine / opts.chCardFmv.price) * 1000) / 1000
    : null;
  const priceEstRatio = engine && opts.chPriceEstimate && opts.chPriceEstimate.price > 0
    ? Math.round((engine / opts.chPriceEstimate.price) * 1000) / 1000
    : null;
  try {
    console.log(JSON.stringify({
      event: "fmv_drift_observed",
      source: opts.source,
      player: opts.player,
      cardId: opts.cardId,
      gradingCompany: opts.gradingCompany,
      grade: opts.grade,
      engineFmv: engine,
      chCardFmv: opts.chCardFmv,
      chPriceEstimate: opts.chPriceEstimate,
      cardFmvRatio,
      priceEstRatio,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // Telemetry failures must never propagate.
  }
}

/**
 * CF-CH-TREND-INGEST (2026-06-28): derive a price-class momentum signal
 * from CardHedge's per-player weekly sales buckets. Returns a structured
 * shape with both raw inputs and a derived ratio so downstream KQL can
 * either consume the ratio directly or re-derive it with custom rules.
 *
 * The signal: ratio of the latest COMPLETE week's avg_sale vs the mean
 * of the prior 4 complete weeks. >1.1 → momentum up; <0.9 → down. The
 * "complete" gate excludes the always-partial current week to avoid
 * mid-week noise (CH's partial buckets are pro-rated and unstable).
 *
 * Exported for direct testing.
 */
export interface SalesBucketLite {
  start: string;
  end: string;
  count: number;
  average_sale: number;
  partial: boolean;
}

export interface SalesMomentumSignal {
  latestCompleteWeek: { start: string; end: string; avgSale: number; count: number } | null;
  priorMeanAvgSale: number | null;
  priorMeanCount: number | null;
  priorWeeks: number;
  momentumRatio: number | null;
  volumeRatio: number | null;
}

export function deriveSalesMomentum(buckets: ReadonlyArray<SalesBucketLite>): SalesMomentumSignal {
  const empty: SalesMomentumSignal = {
    latestCompleteWeek: null,
    priorMeanAvgSale: null,
    priorMeanCount: null,
    priorWeeks: 0,
    momentumRatio: null,
    volumeRatio: null,
  };
  if (!buckets?.length) return empty;
  // Walk from the most-recent end backward, finding the first COMPLETE week.
  const complete = buckets.filter((b) => !b.partial);
  if (complete.length < 2) return empty;
  const latest = complete[complete.length - 1];
  const prior = complete.slice(0, -1).slice(-4); // up to 4 weeks BEFORE latest
  if (prior.length === 0) return empty;
  const sumAvg = prior.reduce((s, b) => s + (Number.isFinite(b.average_sale) ? b.average_sale : 0), 0);
  const sumCount = prior.reduce((s, b) => s + (Number.isFinite(b.count) ? b.count : 0), 0);
  const priorMeanAvgSale = sumAvg / prior.length;
  const priorMeanCount = sumCount / prior.length;
  return {
    latestCompleteWeek: {
      start: latest.start,
      end: latest.end,
      avgSale: Math.round(latest.average_sale * 100) / 100,
      count: latest.count,
    },
    priorMeanAvgSale: Math.round(priorMeanAvgSale * 100) / 100,
    priorMeanCount: Math.round(priorMeanCount),
    priorWeeks: prior.length,
    momentumRatio: priorMeanAvgSale > 0
      ? Math.round((latest.average_sale / priorMeanAvgSale) * 1000) / 1000
      : null,
    volumeRatio: priorMeanCount > 0
      ? Math.round((latest.count / priorMeanCount) * 1000) / 1000
      : null,
  };
}

/**
 * CF-CH-TREND-INGEST (2026-06-28): emit an App Insights event with CH's
 * per-player trend signals alongside our existing engine output. Fire-
 * and-forget; pure telemetry — no price math impact this CF. Once we
 * have N weeks of paired observations we can decide whether to feed
 * momentumRatio into the trendIQ composite or treat it as a standalone
 * cascade-tier signal.
 */
export function logSalesMomentumObserved(opts: {
  source: string;
  player: string;
  cardId: string | null;
  signal: SalesMomentumSignal;
  totalSales30d: number | null;
}): void {
  if (!opts.signal || !opts.signal.latestCompleteWeek) return;
  try {
    console.log(JSON.stringify({
      event: "sales_momentum_observed",
      source: opts.source,
      player: opts.player,
      cardId: opts.cardId,
      latestCompleteWeekStart: opts.signal.latestCompleteWeek.start,
      latestCompleteWeekEnd: opts.signal.latestCompleteWeek.end,
      latestAvgSale: opts.signal.latestCompleteWeek.avgSale,
      latestWeekCount: opts.signal.latestCompleteWeek.count,
      priorMeanAvgSale: opts.signal.priorMeanAvgSale,
      priorMeanCount: opts.signal.priorMeanCount,
      priorWeeks: opts.signal.priorWeeks,
      momentumRatio: opts.signal.momentumRatio,
      volumeRatio: opts.signal.volumeRatio,
      totalSales30d: opts.totalSales30d,
      timestamp: new Date().toISOString(),
    }));
  } catch {
    // Telemetry failures must never propagate.
  }
}

/**
 * CF-CH-GRADE-LADDER-ANCHOR (2026-06-28): when the comp pool for the
 * requested grade is degenerate (null FMV, single rogue lowball, or
 * stale-only), climb the grade ladder via CH's prices-by-card endpoint
 * and back-compute the requested grade using our GRADER_PREMIUMS
 * tiered table. Mirrors CH's `anchor_multiplier_indexed` method but
 * uses OUR multiplier table (which the per-player calibration CF will
 * tune over time once telemetry accumulates).
 *
 * Per Drew's framing: "I want to tweak ours to work like theirs but
 * better". This is the first step — make the engine reach for a graded
 * anchor when raw is thin, the same way CH does. The "better" part
 * lives in our richer signal palette (per-card compsMomentum, cascade
 * model, fitted ladder) which can layer on top in follow-up CFs.
 *
 * Walks the grade ladder top-down, prefers the FRESHEST anchor with
 * data (not necessarily highest grade — staleness damping says a fresh
 * PSA 8 anchor beats a year-old PSA 10 anchor).
 */
export type GradeLadderGrade =
  | "PSA 10" | "PSA 9" | "PSA 8" | "PSA 7"
  | "BGS 10" | "BGS 9.5" | "BGS 9"
  | "SGC 10" | "SGC 9.5" | "SGC 9"
  | "Raw";

export interface GradeLadderAnchor {
  /** The grade we anchored on (NOT necessarily the requested grade). */
  anchorGrade: GradeLadderGrade;
  /** Latest closing price of the anchor grade. */
  anchorPrice: number;
  /** Days since the anchor's most-recent closing date. */
  anchorDaysOld: number;
  /** Number of daily-closing points seen for the anchor grade. */
  anchorSampleSize: number;
  /** Derived FMV for the REQUESTED grade (anchor × multiplier ratio). */
  derivedFmv: number;
  /** Multiplier ratio applied: anchorPrice × ratio = derivedFmv. */
  multiplierRatio: number;
  /** 0..1 confidence based on freshness + sample size. */
  confidence: number;
  /** User-facing explanation, e.g. "Estimated Raw from PSA 9 anchor..." */
  explanation: string;
}

// CF-LADDER-INCLUDE-RAW (2026-06-29): "Raw" is part of the ladder.
// Pre-fix: walker enumerated graded tiers only, so cards with only raw
// data in CH (most prospect autos pre-grading) had no anchor returned —
// the audit-surfaced 12 ENGINE_GAP holdings on Drew's portfolio. By
// inserting Raw at the END (low confidence vs a fresh graded anchor),
// the freshness selector still prefers a recent graded sale when one
// exists, but falls through to raw when nothing else has data.
const GRADE_LADDER_ORDER: GradeLadderGrade[] = [
  "PSA 10", "BGS 10", "SGC 10",
  "PSA 9", "BGS 9.5", "SGC 9.5",
  "PSA 8", "BGS 9", "SGC 9",
  "PSA 7",
  "Raw",
];

function gradeLadderToCompanyPair(g: GradeLadderGrade): { company: string; grade: string } | null {
  if (g === "Raw") return null;
  const m = g.match(/^(PSA|BGS|SGC)\s+(.+)$/);
  if (!m) return null;
  return { company: m[1], grade: m[2] };
}

function daysOldFromIsoDate(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  const ms = nowMs - t;
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Confidence model: 0.6 base (we're guessing from one anchor),
 * -0.1 per 30 days of staleness, +0.03 per sample (~5 samples saturates
 * at +0.15), clamped [0,1]. Calibrated to mirror CH's pattern (their
 * D-grade ≈ 0.18 at 236 days; this model gives ~0.21 at 236 days × 5
 * samples — comparable signal).
 */
export function gradeLadderConfidence(daysOld: number, sampleSize: number): number {
  const base = 0.6;
  const freshnessPenalty = (daysOld / 30) * 0.1;
  const sampleBonus = Math.min(0.15, sampleSize * 0.03);
  return Math.max(0, Math.min(1, base - freshnessPenalty + sampleBonus));
}

/**
 * anchorPrice * ratio = requestedGrade FMV.
 * ratio = premium(requested) / premium(anchor), both keyed off the
 * raw-price tier estimated from the anchor (two-step: anchor → raw
 * tier estimate → requested premium).
 */
export function gradeLadderConversionRatio(
  anchorGrade: GradeLadderGrade,
  requestedGrade: GradeLadderGrade,
  anchorPrice: number,
  cardClass?: "autograph" | "base",
  cardYear?: number | null,
): { ratio: number; rawTierUsed: number } {
  if (anchorGrade === requestedGrade) return { ratio: 1, rawTierUsed: anchorPrice };

  let rawFromAnchor: number;
  if (anchorGrade === "Raw") {
    rawFromAnchor = anchorPrice;
  } else {
    const ap = gradeLadderToCompanyPair(anchorGrade);
    if (!ap) return { ratio: 1, rawTierUsed: anchorPrice };
    const anchorPremium = getGraderPremium(ap.company, ap.grade, anchorPrice, cardClass, cardYear);
    rawFromAnchor = anchorPrice / anchorPremium;
  }

  let requestedPremium: number;
  if (requestedGrade === "Raw") {
    requestedPremium = 1;
  } else {
    const rp = gradeLadderToCompanyPair(requestedGrade);
    if (!rp) return { ratio: 1, rawTierUsed: rawFromAnchor };
    requestedPremium = getGraderPremium(rp.company, rp.grade, rawFromAnchor, cardClass, cardYear);
  }

  let anchorPremium: number;
  if (anchorGrade === "Raw") {
    anchorPremium = 1;
  } else {
    const ap = gradeLadderToCompanyPair(anchorGrade);
    if (!ap) return { ratio: 1, rawTierUsed: rawFromAnchor };
    anchorPremium = getGraderPremium(ap.company, ap.grade, rawFromAnchor, cardClass, cardYear);
  }

  const ratio = requestedPremium / anchorPremium;
  return { ratio, rawTierUsed: rawFromAnchor };
}

/**
 * Orchestrator. Walks the grade ladder via CH prices-by-card, picks
 * the freshest anchor with data, computes the requested-grade FMV.
 * Returns null when NO grade in the ladder had any data (truly
 * unpriceable card).
 *
 * `nowMs` injected for deterministic tests; production passes Date.now().
 * `fetchPrices` injected for tests; production uses CH client.
 */
export async function deriveGradeLadderAnchor(opts: {
  cardId: string;
  requestedGrade: GradeLadderGrade;
  cardClass?: "autograph" | "base";
  cardYear?: number | null;  // CF-VINTAGE-GRADER-PREMIUMS (2026-06-29)
  nowMs?: number;
  fetchPrices?: (cardId: string, grade: string, days: number) => Promise<{ closing_date: string; price: number }[]>;
}): Promise<GradeLadderAnchor | null> {
  const { cardId, requestedGrade, cardClass, cardYear } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  if (!cardId) return null;

  let fetcher = opts.fetchPrices;
  if (!fetcher) {
    const mod = await import("./cardhedge.client.js");
    fetcher = mod.getPricesByCard;
  }

  // Parallelize the ladder walk — CH's prices-by-card endpoint is
  // independent per grade, so 10 sequential fetches (~200ms each cold,
  // ~5ms each cached) becomes one round-trip wall clock. 12h cacheWrap
  // means second-visit cards are nearly free.
  const fetches = await Promise.all(
    GRADE_LADDER_ORDER.map((grade) =>
      fetcher!(cardId, grade, 365).then((prices) => ({ grade, prices })).catch(() => ({ grade, prices: [] as { closing_date: string; price: number }[] })),
    ),
  );

  let best: { grade: GradeLadderGrade; price: number; daysOld: number; sampleSize: number } | null = null;
  for (const { grade, prices } of fetches) {
    if (!prices?.length) continue;
    const latest = prices[prices.length - 1];
    if (!latest?.closing_date || !(latest.price > 0)) continue;
    const daysOld = daysOldFromIsoDate(latest.closing_date, nowMs);
    if (!best || daysOld < best.daysOld) {
      best = { grade, price: latest.price, daysOld, sampleSize: prices.length };
    }
  }

  if (!best) return null;

  const { ratio, rawTierUsed } = gradeLadderConversionRatio(best.grade, requestedGrade, best.price, cardClass, cardYear);
  let derivedFmv = Math.round(best.price * ratio * 100) / 100;
  const confidence = gradeLadderConfidence(best.daysOld, best.sampleSize);

  // CF-LADDER-INVERSE-SANITY-GATE (2026-06-29): Raw can NEVER exceed any
  // graded version of the same card — same card, different condition.
  // The volume test on 2026-06-29 surfaced 1952 Mantle deriving Raw at
  // $2.28M from a PSA 8 anchor at $1.83M (auto-multiplier table inversed
  // to 1.25×). For vintage HOF + high-grade-anchor cases the static
  // GRADER_PREMIUMS table doesn't apply — its calibration is for modern
  // prospect-tier cards and the inverse breaks down.
  //
  // Gate: when the anchor is graded AND we're deriving Raw, the result
  // MUST be ≤ anchor price. If the multiplier produced something higher,
  // the table is wrong for this card class; return null rather than ship
  // a fabricated number. Caller falls through to whatever else it has
  // (lastSale, null FMV, etc.) — better than emitting $2M on a card
  // worth $66.
  //
  // Cross-grade sanity: anchor PSA 8 → request PSA 10 SHOULD produce a
  // value > anchor (PSA 10 commands a premium). That's the OPPOSITE
  // direction and remains uncapped.
  const rankFor = (g: GradeLadderGrade): number => {
    if (g === "Raw") return 0;
    if (g.includes("10")) return 10;
    if (g.includes("9.5")) return 9.5;
    if (g.includes("9")) return 9;
    if (g.includes("8.5")) return 8.5;
    if (g.includes("8")) return 8;
    if (g.includes("7.5")) return 7.5;
    if (g.includes("7")) return 7;
    return 0;
  };
  const anchorRank = rankFor(best.grade);
  const requestedRank = rankFor(requestedGrade);
  const downgrading = anchorRank > requestedRank;
  // Threshold by card class. Autographs (empirical-calibrated): allow
  // 1.10× (covers the Kurtz/Hartman edge cases where the auto table
  // shows Raw ≈ PSA 9 at high tiers). Everything else: strict 1.0×
  // (Raw must be ≤ graded — physics-of-condition rule). The strict
  // path catches the volume-test Mantle 1.25× and the 34000× scale
  // breakdowns where the static base table is wrong for vintage HOF.
  const maxRatio = cardClass === "autograph" ? 1.10 : 1.00;
  if (downgrading && derivedFmv > best.price * maxRatio) {
    try {
      console.log(JSON.stringify({
        event: "ladder_inverse_sanity_gate_triggered",
        source: "compiqEstimate.deriveGradeLadderAnchor",
        cardId,
        anchorGrade: best.grade,
        anchorPrice: best.price,
        requestedGrade,
        rejectedDerivedFmv: derivedFmv,
        ratio,
        cardClass: cardClass ?? null,
        reason: "downgrading multiplier produced higher value than anchor — table miscalibrated for this card class",
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // Telemetry must never propagate.
    }
    // Refuse to ship an absurd value. Caller picks up null and falls
    // through to its own no-FMV path. (Future: surface the GRADED
    // anchor value separately so iOS can render "Last graded sold:
    // PSA 8 $1.83M" without claiming a Raw price.)
    return null;
  }

  const explanation =
    best.grade === requestedGrade
      ? `${best.grade} anchor $${best.price} (${best.daysOld}d old, ${best.sampleSize} samples), used directly.`
      : `Estimated ${requestedGrade} from the ${best.grade} anchor ($${best.price}, ${best.daysOld}d old), grade-adjusted ${best.grade}→${requestedGrade} via ${ratio.toFixed(3)}× (raw tier $${rawTierUsed.toFixed(2)}, ${best.sampleSize} samples).`;

  return {
    anchorGrade: best.grade,
    anchorPrice: best.price,
    anchorDaysOld: best.daysOld,
    anchorSampleSize: best.sampleSize,
    derivedFmv,
    multiplierRatio: ratio,
    confidence,
    explanation,
  };
}

/** Extracts a (company, grade) tuple from a free-text comp title, or null. */
export function detectGradeFromTitle(title: string): { company: string; grade: string } | null {
  if (!title) return null;
  const m = title.match(/\b(PSA|BGS|SGC|CGC)\s*([0-9]+(?:\.5)?)\b/i);
  if (!m) return null;
  return { company: m[1].toUpperCase(), grade: m[2] };
}

/**
 * Format a comp title's detected grade as a display label
 * (e.g. "PSA 7", "BGS 9.5"). Returns "Raw" when no grading
 * company is detectable from the title — this matches the
 * convention used elsewhere in the engine where unknown /
 * undetectable grade is treated as Raw (premium 1.0).
 *
 * Used by `recentComps` display so the iOS UI can label each
 * comp's grade explicitly without parsing the title client-side.
 * See issue #24 for the design decision.
 */
export function formatGradeLabel(title: string): string {
  const d = detectGradeFromTitle(title);
  return d ? `${d.company} ${d.grade}` : "Raw";
}

/**
 * Normalize a graded comp price back to its raw equivalent so PSA10 sales,
 * BGS9.5 sales, and raw sales can pool into one anchor.
 */
export function normalizeCompToRaw(sale: RawComp): number {
  const detected = detectGradeFromTitle(sale.title);
  if (!detected) return sale.price;
  const premium = getGraderPremium(detected.company, detected.grade);
  return premium > 0 ? sale.price / premium : sale.price;
}

export function applyGraderPremium(rawPrice: number, company: string | null, grade: string | null): number {
  const premium = getGraderPremium(company, grade);
  return rawPrice * premium;
}

// ---------------------------------------------------------------------------
// Data sufficiency gate (Pricing Accuracy — Improvement 4)
// ---------------------------------------------------------------------------
interface DataSufficiency {
  sufficient: boolean;
  level: "none" | "very_thin" | "thin" | "adequate";
  message: string;
}

const MINIMUM_COMPS_FOR_POINT_ESTIMATE = 3;

export function evaluateDataSufficiency(params: {
  usedComps: number;
  totalComps: number;
  recentCount: number;
}): DataSufficiency {
  const { usedComps, totalComps, recentCount } = params;
  if (usedComps === 0) {
    return {
      sufficient: false,
      level: "none",
      message: totalComps === 0
        ? "No recent sales found for this card."
        : `Found ${totalComps} sales but none passed quality checks.`,
    };
  }
  if (usedComps < MINIMUM_COMPS_FOR_POINT_ESTIMATE) {
    return {
      sufficient: false,
      level: "very_thin",
      message: `Only ${usedComps} usable sale${usedComps === 1 ? "" : "s"} — not enough to publish a point price.`,
    };
  }
  if (usedComps < 6 || recentCount < 2) {
    return {
      sufficient: true,
      level: "thin",
      message: `Thin data — based on ${usedComps} sales (${recentCount} in last 14d). Treat as approximate.`,
    };
  }
  return { sufficient: true, level: "adequate", message: "" };
}

// ── Selling Guidance ─────────────────────────────────────────────────────
// Translate the model's price lanes + comp pool into the four numbers a
// seller actually wants to see on screen:
//   - sellRange       low/high band you'd realistically realize
//   - quickSale       price that closes within ~48h (under-cut the floor)
//   - fair            balanced FMV (mid of the band)
//   - ebayListing     the BIN sticker price to post (above FMV to allow
//                     best-offer haggling and the eBay 13% fee)
//   - bestOfferFloor  the lowest best-offer you should accept
//   - auctionStart    a no-reserve auction starting bid
//   - breakEven       the gross sale price you need to net `fair` after
//                     default fees + shipping
// All values respect the data-sufficiency gate — if we suppressed the
// point estimate, every number in this block is null.
export interface SellingGuidance {
  sellRange: { low: number; high: number } | null;
  quickSale: number | null;
  fair: number | null;
  ebayListingPrice: number | null;
  bestOfferFloor: number | null;
  auctionStartPrice: number | null;
  breakEven: number | null;
  recommendedPlatform: "auction" | "buy_it_now" | "best_offer" | "wait";
  notes: string[];
  assumptions: { feePct: number; shippingCost: number };
}

export function buildSellingGuidance(params: {
  quickSaleValue: number | null;
  fairMarketValue: number | null;
  premiumValue: number | null;
  comps: Array<{ price: number; date?: string | null }>;
  recommendedMethod?: string | null;
  marketSpeed?: string | null;
  demand?: string | null;
  feePct?: number;
  shippingCost?: number;
}): SellingGuidance {
  const feePct = params.feePct ?? 0.13; // eBay managed payments ~13% blended
  const shippingCost = params.shippingCost ?? 1.0; // PWE included; seller eats label on raw

  const fair = typeof params.fairMarketValue === "number" ? params.fairMarketValue : null;
  const quick = typeof params.quickSaleValue === "number" ? params.quickSaleValue : null;
  const premium = typeof params.premiumValue === "number" ? params.premiumValue : null;

  if (fair == null) {
    return {
      sellRange: null,
      quickSale: null,
      fair: null,
      ebayListingPrice: null,
      bestOfferFloor: null,
      auctionStartPrice: null,
      breakEven: null,
      recommendedPlatform: "wait",
      notes: ["Not enough usable comps to publish selling guidance."],
      assumptions: { feePct, shippingCost },
    };
  }

  // Build a price band. Prefer the model's quick/premium lanes (which the
  // pipeline already produces from quantiles of the velocity-weighted pool)
  // and fall back to the 25th/75th percentile of the raw comp pool if a
  // lane is missing.
  const sortedPrices = params.comps
    .map((c) => c.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .sort((a, b) => a - b);
  const percentile = (p: number): number | null => {
    if (sortedPrices.length === 0) return null;
    if (sortedPrices.length === 1) return sortedPrices[0];
    const idx = Math.max(0, Math.min(sortedPrices.length - 1, Math.round((sortedPrices.length - 1) * p)));
    return sortedPrices[idx];
  };
  const low = quick ?? percentile(0.25) ?? fair * 0.85;
  const high = premium ?? percentile(0.75) ?? fair * 1.15;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  // eBay BIN sticker: list ~12% above fair so best-offer haggling lands at
  // fair, and 13% fees + shipping still net the seller close to FMV.
  const ebayListing = round2(fair * 1.12 + shippingCost);
  // Floor any best-offer should clear — slightly below quick-sale price.
  const bestOfferFloor = round2(Math.min(low, fair * 0.92));
  // Auction starter: aggressive 60% of fair, drives early bidders.
  const auctionStart = round2(Math.max(0.99, fair * 0.6));
  // Gross sale price needed to net `fair` post-fees & shipping.
  const breakEven = round2((fair + shippingCost) / (1 - feePct));

  // Pick a platform. Defer to the orchestrator's recommendedMethod if it
  // already returned a real choice; otherwise infer from market speed/demand.
  const incoming = (params.recommendedMethod ?? "").toLowerCase();
  let platform: SellingGuidance["recommendedPlatform"];
  if (incoming === "auction" || incoming === "buy_it_now" || incoming === "best_offer" || incoming === "wait") {
    platform = incoming;
  } else {
    const speed = (params.marketSpeed ?? "").toLowerCase();
    const demand = (params.demand ?? "").toLowerCase();
    if (speed === "fast" && (demand === "high" || demand === "medium")) platform = "auction";
    else if (demand === "high") platform = "buy_it_now";
    else if (demand === "low" || speed === "slow") platform = "best_offer";
    else platform = "buy_it_now";
  }

  const notes: string[] = [];
  notes.push(
    platform === "auction"
      ? `Start auction at $${auctionStart} to drive bidders; expect a clear in the $${round2(low)}–$${round2(high)} band.`
      : platform === "best_offer"
      ? `List BIN at $${ebayListing} with Best Offer enabled; auto-decline below $${bestOfferFloor}.`
      : platform === "wait"
      ? "Hold — market doesn't support a confident sale right now."
      : `List BIN at $${ebayListing}; accept best offers above $${bestOfferFloor}.`,
  );
  if (breakEven > ebayListing) {
    notes.push(
      `Heads up: at ${Math.round(feePct * 100)}% fees + $${shippingCost} shipping you'd need $${breakEven} gross to net the $${round2(fair)} fair price.`,
    );
  }

  return {
    sellRange: { low: round2(low), high: round2(high) },
    quickSale: quick != null ? round2(quick) : round2(low),
    fair: round2(fair),
    ebayListingPrice: ebayListing,
    bestOfferFloor,
    auctionStartPrice: auctionStart,
    breakEven,
    recommendedPlatform: platform,
    notes,
    assumptions: { feePct, shippingCost },
  };
}

// ── Sibling-sales pool (shared by fetchBroaderTrend + Layer 3 trajectory) ─
//
// Pre-fetches sales for same-player + same-year + same-set siblings of the
// resolved card_id (exact card_id excluded). Both fetchBroaderTrend (existing
// fixed-from-now trend) and computeSegmentTrajectory (new TrendIQ Layer 3
// last-sale-anchored trend) consume this same pool so we never double-fetch
// the same sibling sales across one estimate request.
//
// Caps: 8 siblings, 10 samples each. Same as the pre-refactor inlined values.
//
// Fallback param (Option A — added 2026-05-26 during B.4.c.3 live smoke):
// The Cardsight-exclusive resolved card identity often lacks `setName` /
// `year` (gap captured as CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS). Without
// fallback, fetchSiblingSales gate-tripped on `!set` for every Cardsight
// card and returned an empty pool — affecting both Layer 3 (no segment
// trajectory ever fired) AND the pre-existing fetchBroaderTrend (which
// silently fell back to exact-comp-only pool, mislabeling its 'broader
// trend' for unknown duration). Caller now passes `parsedQuery`-derived
// fields as fallback; sibling discovery uses them when cardIdentity is
// sparse.
export interface SiblingSalesPool {
  /** Sibling card_ids actually fetched (0..8 after filtering + cap). */
  siblingCardIds: string[];
  /** Flat sale list, pre-filtered for valid Date.parse + price > 0. */
  sales: Array<{ price: number; ts: number }>;
}

/**
 * Parse a grade string ("PSA 10" / "BGS 9.5" / "Raw") into the
 * gradeCompany + gradeValue shape that fetchCompsByPlayer accepts.
 *
 * Returns empty object for raw / ungraded / unparseable inputs — segment
 * trajectory then pools all grades, which is the right behavior for raw-
 * card queries (no graded-tier scoping makes sense).
 */
function parseGradeStringForCardsight(
  grade: string,
): { gradeCompany?: string; gradeValue?: string } {
  if (!grade) return {};
  const lower = grade.toLowerCase().trim();
  if (lower === "" || lower === "raw" || lower === "ungraded") return {};
  const m = grade.match(/^(PSA|BGS|SGC|CGC)\s*([0-9]+(?:\.5)?)$/i);
  if (!m) return {};
  return { gradeCompany: m[1].toUpperCase(), gradeValue: m[2] };
}

export async function fetchSiblingSales(
  card: NonNullable<FetchedComps["card"]>,
  grade: string,
): Promise<SiblingSalesPool> {
  // CF-CARDSIGHT-SIBLING-DISCOVERY Approach A (2026-05-25):
  // Wrap fetchCompsByPlayer + exact-card-id exclusion. fetchCompsByPlayer is
  // a production-tested service (shipped 2026-05-27 for adjacent MCP-rewire
  // flow) that handles searchCatalog + releaseName dictionary lookup +
  // chrome-fallback + top-K pricing fanout + 6h aggregate cache + dedupe.
  // See docs/phase0/cardsight_sibling_discovery_investigation.md for the
  // investigation that picked Approach A over B/C/D.
  //
  // CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS (2026-05-25):
  // Previously took a `fallback?: SiblingSalesFallback` parameter populated
  // from parsedQuery, because cardIdentity.set/year were structurally
  // undefined for Cardsight-exclusive cards. Phase 2 of this CF augments
  // findCompsViaCardsight to populate cardIdentity from getCardDetail's
  // rich response, eliminating the gap. The fallback is no longer needed
  // and has been retired — cardIdentity is now the true source of truth
  // for player + product + year.
  //
  // Same-grade scoping: parse the grade string and pass to
  // fetchCompsByPlayer so PSA 10's segment pool is built from PSA 10 sales
  // of related cards (not raw or other grades). Raw queries pass undefined
  // → segment includes all grades.
  const player = (card.player ?? "").trim();
  const product = (card.set ?? "").trim();
  const yearRaw = card.year ?? null;
  const cardYear =
    yearRaw != null && Number.isFinite(Number(yearRaw))
      ? Number(yearRaw)
      : undefined;
  const parsedGrade = parseGradeStringForCardsight(grade);

  console.log(
    `[compiq.trendIQ.L3.fetch] player="${player}" product="${product}" ` +
      `year=${cardYear ?? "null"} grade="${grade}" ` +
      `gradeParsed=${JSON.stringify(parsedGrade)}`,
  );

  if (!player || !product) {
    console.log(
      `[compiq.trendIQ.L3.fetch] early-return: missing player or product ` +
        `on cardIdentity (CF-CARDSIGHT-CARDIDENTITY-COMPLETENESS post-fix; ` +
        `if this fires often, getCardDetail augmentation may be degrading)`,
    );
    return { siblingCardIds: [], sales: [] };
  }

  // Outer try/catch — fetchCompsByPlayer can throw on aggregate-level errors
  // (its per-candidate failures are already tolerated internally).
  let result;
  try {
    result = await fetchCompsByPlayer({
      playerName: player,
      product,
      cardYear,
      gradeCompany: parsedGrade.gradeCompany,
      gradeValue: parsedGrade.gradeValue,
    });
  } catch (err) {
    console.log(
      `[compiq.trendIQ.L3.fetch] fetchCompsByPlayer threw: ` +
        `${(err as Error)?.message ?? err}`,
    );
    return { siblingCardIds: [], sales: [] };
  }

  // Exclude exact card_id from both cardIds + comps. Segment-trajectory
  // semantics per locked B.2 design: pool is SIBLINGS only (related cards
  // in the same player + product + year segment, EXCLUDING the exact card
  // being valued).
  const exactCardId = card.card_id;
  const siblingCardIds = result.cardIds.filter((id) => id !== exactCardId);
  const excludedCardIds = result.cardIds.length - siblingCardIds.length;

  const sales: Array<{ price: number; ts: number }> = [];
  let excludedComps = 0;
  for (const c of result.comps) {
    if (c.cardId === exactCardId) {
      excludedComps++;
      continue;
    }
    const ts = Date.parse(c.date || "");
    if (Number.isFinite(ts) && c.price > 0) {
      sales.push({ price: c.price, ts });
    }
  }

  console.log(
    `[compiq.trendIQ.L3.fetch] fetchCompsByPlayer returned ` +
      `cardIds=${result.cardIds.length} comps=${result.comps.length} ` +
      `cached=${result.cached} warnings=${result.warnings.length}; ` +
      `post-exclusion siblings=${siblingCardIds.length} sales=${sales.length} ` +
      `(excluded cardIds=${excludedCardIds} comps=${excludedComps})`,
  );
  if (result.warnings.length > 0) {
    console.log(
      `[compiq.trendIQ.L3.fetch] warnings: ${JSON.stringify(result.warnings)}`,
    );
  }

  return { siblingCardIds, sales };
}

async function fetchBroaderTrend(
  card: NonNullable<FetchedComps["card"]>,
  grade: string,
  exactComps: RawComp[],
  pool: SiblingSalesPool,
): Promise<BroaderTrend> {
  const RECENT_DAYS = 14;
  const OLDER_DAYS = 45; // 15..45-day window

  const blankOut = (basedOn: BroaderTrend["basedOn"]): BroaderTrend => ({
    impliedTrendPct: 0,
    direction: "flat",
    recentMedian: null,
    olderMedian: null,
    recentCount: 0,
    olderCount: 0,
    similarCardsScanned: 0,
    totalSamples: 0,
    windowRecentDays: RECENT_DAYS,
    windowOlderDays: OLDER_DAYS,
    basedOn,
  });

  const player = (card.player ?? "").trim();
  const set = (card.set ?? "").trim();
  if (!player || !set) return blankOut("insufficient");

  // Combine sibling pool with exact comps for the trend math. fetchBroaderTrend
  // intentionally pools exact + siblings together (existing behavior, pre-
  // refactor). Layer 3 segment trajectory consumes the SAME `pool` but does
  // NOT fold in exact comps — see computeSegmentTrajectory.
  const siblingIds = pool.siblingCardIds;
  const combined: Array<{ price: number; ts: number }> = [...pool.sales];
  for (const c of exactComps) {
    const ts = Date.parse(c.soldDate || "");
    if (Number.isFinite(ts) && c.price > 0) {
      combined.push({ price: c.price, ts });
    }
  }

  if (combined.length === 0) return blankOut("insufficient");

  const now = Date.now();
  const recentCutoff = now - RECENT_DAYS * 24 * 3600 * 1000;
  const olderCutoff = now - OLDER_DAYS * 24 * 3600 * 1000;

  const recent = combined.filter((p) => p.ts >= recentCutoff);
  const older = combined.filter((p) => p.ts < recentCutoff && p.ts >= olderCutoff);

  const recentMed = computeWeightedMedian(recent.map((p) => ({ price: p.price, date: p.ts })));
  const olderMed = computeWeightedMedian(older.map((p) => ({ price: p.price, date: p.ts })));

  // Need at least 2 in each window to call a trend; otherwise mark insufficient.
  if (recent.length < 2 || older.length < 2 || !recentMed || !olderMed) {
    return {
      ...blankOut(siblingIds.length > 0 ? "broader" : "exact"),
      recentMedian: recentMed,
      olderMedian: olderMed,
      recentCount: recent.length,
      olderCount: older.length,
      similarCardsScanned: siblingIds.length,
      totalSamples: combined.length,
    };
  }

  const pct = ((recentMed - olderMed) / olderMed) * 100;
  // Cap absurd swings (small-sample noise) to ±60%.
  const clamped = Math.max(-60, Math.min(60, pct));
  const direction: BroaderTrend["direction"] =
    clamped > 3 ? "up" : clamped < -3 ? "down" : "flat";

  return {
    impliedTrendPct: Math.round(clamped * 10) / 10,
    direction,
    recentMedian: Math.round(recentMed * 100) / 100,
    olderMedian: Math.round(olderMed * 100) / 100,
    recentCount: recent.length,
    olderCount: older.length,
    similarCardsScanned: siblingIds.length,
    totalSamples: combined.length,
    windowRecentDays: RECENT_DAYS,
    windowOlderDays: OLDER_DAYS,
    basedOn: siblingIds.length > 0 ? "broader" : "exact",
  };
}

// CF-PRICE-BY-ID-MIGRATION — Grade selector for the pinned cardId
// branch in fetchComps. Cardsight returns raw + graded as separate
// structures; CardHedge's getCardSales filtered by grade server-side.
// We replicate the filter on our side from the grade string.
//
// Grade string shapes (built upstream by formatGrade(gradeCompany, gradeValue)):
//   - "Raw"           → use pricing.raw.records (ungraded)
//   - "PSA 10"        → company="PSA", value="10" — find that grade in
//                       pricing.graded[]; return records or [] if missing
//   - "BGS 9.5"       → decimal grade values supported
//   - anything else   → safe fallback to raw records (preserves the prior
//                       behavior of "no specific grade → broadest pool")
export function selectSalesByGrade(
  pricing: { raw?: { records: CardsightSaleRecord[] }; graded: Array<{ company_name: string; grades: Array<{ grade_value: string | number; records: CardsightSaleRecord[] }> }> },
  grade: string,
): CardsightSaleRecord[] {
  if (!grade || grade === "Raw") {
    return pricing.raw?.records ?? [];
  }
  // Numeric grades only (e.g. "PSA 10", "BGS 9.5"). Non-numeric labels like
  // "PSA Authentic" don't match this regex and fall through to raw — out of
  // scope here, no current consumer requests them.
  const match = grade.match(/^([A-Za-z]+)\s+(\d+(?:\.\d+)?)$/);
  if (!match) {
    return pricing.raw?.records ?? [];
  }
  const company = match[1].toUpperCase();
  const value = match[2];
  const valueNum = Number(value);
  const companyEntry = pricing.graded.find(
    (c) => c.company_name.toUpperCase() === company,
  );
  if (!companyEntry) return [];
  // Numeric equality + duplicate-bucket merge.
  // - Why numeric: Cardsight's wire shape carries `grade_value` as either a
  //   string ("10") or a number (10) across companies / cards. Strict ===
  //   against the regex-captured string would silently miss the numeric form
  //   (the entire point of CF-GRADED-PRICE-BY-ID-ZERO-COMPS). Coercing both
  //   sides via Number() normalizes "10", 10, and "10.0" to the same key.
  // - Why merge: a single getPricing() response can emit the same grade_value
  //   under more than one entry (observed empirically on fda530ab: PSA 9
  //   appears twice with 117 + 3 records; BGS 10 twice with 1 + 4). Use
  //   filter+flatMap to concatenate all matching entries' records instead of
  //   .find which silently dropped the trailing duplicates.
  const matching = companyEntry.grades.filter((g) => Number(g.grade_value) === valueNum);
  return matching.flatMap((g) => g.records ?? []);
}

// CF-FILTER-CONSOLIDATION (2026-06-10): filterRecordsByParallel lifted
// into ./filters.ts so the value path AND the marketRead fact-pack path
// import the SAME helper (was duplicated as the local twin
// `filterByParallelHere` in marketRead.service.ts). Re-exported here so
// external consumers + existing imports keep working without a
// path change.
import { filterRecordsByParallel } from "./filters.js";
export { filterRecordsByParallel };

// CF-LASTSALE-SCAFFOLD (2026-06-10): exported helper that picks the
// single max-by-date record from a RawComp[] pool (post-(grade +
// parallel), unwindowed). The lastSale + daysSinceNewest fields on
// the est shape derive from the SAME picked record so they can't
// disagree on edge cases. Returns null when no record has a
// parseable, positive soldDate timestamp.
//
// Output shape mirrors what the /price-by-id response surfaces under
// `lastSale` — iOS reads it as-is for the no-value-screen "last sold
// $X, N ago" treatment.
export function pickLastSale(comps: ReadonlyArray<RawComp>): {
  soldDate: string;
  price: number;
  title: string | null;
  listingType: "fixed" | "auction" | null;
  imageUrl: string | null;
} | null {
  let best: RawComp | null = null;
  let bestTs = 0;
  for (const c of comps) {
    const ts = Date.parse(c.soldDate || "");
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (best === null || ts > bestTs) {
      best = c;
      bestTs = ts;
    }
  }
  if (best === null) return null;
  return {
    soldDate: best.soldDate || "",
    price: best.price,
    title: best.title ?? null,
    listingType:
      best.listingType === "fixed" || best.listingType === "auction"
        ? best.listingType
        : null,
    imageUrl: best.imageUrl ?? null,
  };
}

// CF-TREND-EXTRAPOLATED (2026-06-10): reprice a lastSale anchor across a
// stale gap using the player-in-set 14-day momentum signal. Damped,
// anti-compounding: the multiplier scales with how much of the gap the
// 14-day trend window actually covers, capped at one window (gapFactor
// = min(gap, WINDOW)/WINDOW). A fresh anchor (gap≈0) gets ~zero
// adjustment; a 14-day-old anchor gets the full multiplier; a
// 25-day-old anchor still gets the full multiplier (capped — no
// compounding beyond one window's worth of drift). Range widens with
// total gap and trend magnitude.
//
// Returns null when:
//   - gap is outside [0, TREND_CUTOFF_DAYS]
//   - multiplier is non-finite
//   - anchor price is non-positive
// Caller (insufficient short-circuit) treats null as "fall through to
// last-sale display" — no estimatedValue surfaced.

export const TREND_CUTOFF_DAYS = 30;
export const TREND_WINDOW_DAYS = 14;
const TREND_SPREAD_BASE = 0.12;
const TREND_SPREAD_MAX = 0.30;
const TREND_SPREAD_TREND_FACTOR = 0.25;
const TREND_SPREAD_GAP_FACTOR = 0.10;

export interface TrendExtrapolatedEstimate {
  estimatedValue: number;
  estimateRange: { low: number; high: number };
  basis: {
    anchorPrice: number;
    anchorDaysAgo: number;
    multiplier: number;
    gapFactor: number;
    adjustment: number;
    spread: number;
  };
}

export function repriceTrendExtrapolated(
  anchor: { price: number },
  gapDays: number,
  multiplier: number,
): TrendExtrapolatedEstimate | null {
  if (!Number.isFinite(gapDays) || gapDays < 0 || gapDays > TREND_CUTOFF_DAYS) return null;
  if (!Number.isFinite(multiplier)) return null;
  if (!Number.isFinite(anchor.price) || anchor.price <= 0) return null;

  const gapFactor = Math.min(gapDays, TREND_WINDOW_DAYS) / TREND_WINDOW_DAYS;
  const adjustment = (multiplier - 1.0) * gapFactor;
  const estimatedValue = anchor.price * (1 + adjustment);

  const spread = Math.max(
    TREND_SPREAD_BASE,
    Math.min(
      TREND_SPREAD_MAX,
      TREND_SPREAD_BASE
        + (gapDays / TREND_CUTOFF_DAYS) * TREND_SPREAD_GAP_FACTOR
        + Math.abs(multiplier - 1.0) * TREND_SPREAD_TREND_FACTOR,
    ),
  );

  return {
    estimatedValue: Math.round(estimatedValue * 100) / 100,
    estimateRange: {
      low: Math.round(estimatedValue * (1 - spread) * 100) / 100,
      high: Math.round(estimatedValue * (1 + spread) * 100) / 100,
    },
    basis: {
      anchorPrice: anchor.price,
      anchorDaysAgo: gapDays,
      multiplier,
      gapFactor: Math.round(gapFactor * 1000) / 1000,
      adjustment: Math.round(adjustment * 1000) / 1000,
      spread: Math.round(spread * 1000) / 1000,
    },
  };
}

async function fetchComps(
  query: string,
  grade: string = "Raw",
  pinnedCardId?: string,
  queryContext?: QueryContext,
  parallelId?: string | null,
): Promise<FetchedComps> {
  // CARD_HEDGE_API_KEY gate removed 2026-05-25 — see fetchBroaderTrend
  // comment above. Under CARDSIGHT_MODE=exclusive (production setting),
  // findCompsRouted goes directly to Cardsight; CardHedge auth is not a
  // dependency of this path.

  // ----- Phase 2 — meaningful-query fall-through ------------------------
  // When the iOS client sends a meaningful `query` text alongside
  // cardId, fetchComps falls through to findCompsRouted →
  // resolveCardId → Cardsight getPricing. The pinned-cardId path below
  // is the fast direct route when we already have the resolved cardId.
  //
  // CF-PRICE-BY-ID-PINNED-GATING (2026-06-08): "meaningful" means the
  // query carries SUBSTANTIVE text BEYOND the pinned cardId, not just
  // that the strings differ. The upstream cardTitle builder concatenates
  // body.playerName (=pinnedCardId on /price-by-id pinned calls) with
  // grade / parallel suffixes (e.g. "fda530ab-... PSA 10"). Those
  // suffixes aren't user-typed text — the same fields are already on
  // body.gradeCompany / body.parallel and reach fetchComps via the
  // explicit `grade` arg. Pinned branch remains the correct path here;
  // selectSalesByGrade applies the grade filter to the Cardsight pricing
  // response. Strict-`!==` against pinnedCardId was the pre-fix
  // behavior; it bypassed the pinned branch on every graded
  // /price-by-id call (PSA 10 / PSA 9 / BGS 9.5 silently returned 0
  // comps + null identity).
  //
  // Real iOS free-text override (e.g. "2024 Topps Chrome Skenes") does
  // NOT start with the pinned cardId UUID → still falls through. The
  // iOS resolvedLabel-falls-back-to-cardId case still hits the pinned
  // branch (the query IS the cardId — startsWith trivially true).
  const trimmedQuery = (query ?? "").trim();
  const trimmedPinned = pinnedCardId?.trim() ?? "";
  const hasMeaningfulQuery =
    trimmedQuery.length > 0 &&
    trimmedPinned.length > 0 &&
    !trimmedQuery.toLowerCase().startsWith(trimmedPinned.toLowerCase());

  // CF-REPRICE-PINNED-AUTHORITATIVE (2026-06-17): caller (e.g.
  // autoPriceHolding) declares the stored cardId authoritative —
  // the composed cardTitle is a derived display label, not a free-text
  // override. Skip the meaningful-query check and fire the pinned branch
  // even when "Mike Trout" doesn't start with the pinned UUID. Default-off:
  // /search, /price, /price-by-id callers leave it unset and keep the
  // existing free-text-override semantics.
  const pinnedAuthoritative = queryContext?.pinnedAuthoritative === true;

  // ----- Pinned cardId path ------------------------------------
  // CF-PRICE-BY-ID-MIGRATION (first sub-CF of CF-CARDHEDGE-DECOMMISSION-
  // FULL Phase 2): when the caller has already resolved a Cardsight
  // cardId (UUID), call cardsight.client.getPricing() directly. Skips
  // the text-resolution step (resolveCardId in cardsight.mapper) since
  // we already have the canonical cardId.
  //
  // Replaces the legacy CH path which called
  // getCardSalesRouted(pinnedCardId, ..., cardIdSource: "cardhedge")
  // and returned [] under CARDSIGHT_MODE=exclusive.
  //
  // Grade filtering is client-side here (CardHedge's getCardSales did
  // it server-side). Cardsight returns raw + graded as separate
  // structures; we select records based on the requested grade string.
  if (pinnedCardId && (!hasMeaningfulQuery || pinnedAuthoritative)) {
    // ── CF-PRICE-BY-ID-PLAYER-RESOLVE (2026-06-27) ───────────────────────
    // iOS pins the cardId and deliberately sends query=nil (see
    // APIService.priceByCardId / CF-PRICE-BY-ID-ROUTE). The route layer
    // then falls back to body.playerName = resolvedCardId, so by the time
    // we reach here queryContext.playerName is the raw numeric card_id (or
    // absent). That breaks two things: (1) the CardHedge comp bridge needs
    // a real playerName to resolve, and (2) cardIdentity.player echoes the
    // numeric id, so the iOS headline renders the raw id instead of the
    // player. Recover the real identity from the card-meta side cache
    // (written by searchCardsRouted at picker time) and fill the missing /
    // numeric-only fields. Falls through cleanly on a cache miss.
    const playerLooksMissing =
      !queryContext?.playerName ||
      queryContext.playerName.trim().length === 0 ||
      queryContext.playerName.trim() === pinnedCardId.trim();
    if (playerLooksMissing) {
      const meta = await getCardMetaById(pinnedCardId);
      if (meta?.player) {
        queryContext = {
          ...(queryContext ?? {}),
          playerName: meta.player,
          cardYear: queryContext?.cardYear ?? meta.year,
          product: queryContext?.product ?? meta.set,
          parallel: queryContext?.parallel ?? meta.variant,
          cardNumber: queryContext?.cardNumber ?? meta.number,
        };
        console.log(JSON.stringify({
          event: "compiq.fetchComps.pinned_player_recovered",
          source: "compiqEstimate.fetchComps",
          csCardId: pinnedCardId,
          recoveredPlayer: meta.player,
        }));
      }
    }
    // ── CF-CH-P5-PRIMARY: try CardHedge first via the router seam ─────────
    // When the request carries enough identity to bridge over to
    // CardHedge, attempt CH first. If trusted, return CH-sourced comps
    // and skip the Cardsight pricing call entirely. The router's
    // getCardSalesRouted falls back to Cardsight internally if anything
    // fails, BUT we want to keep the existing Cardsight pinned-id flow
    // (with parallel filter + title-match recovery + identity from
    // pricing.card) on CH miss — so we DON'T pass identity to the inner
    // router call here; instead we attempt CH explicitly and check the
    // source on the returned sales.
    // CF-ENGINE-PARALLEL-CANONICALIZE (2026-06-26): pass parallelId so the
    // router resolves it to the catalog's authoritative parallel name +
    // numberedTo, replacing iOS's loose `parallel` string in the CH bridge
    // query. fetchComps' 5th positional argument is `parallelId` — already
    // threaded through from /price-by-id's body.
    const chIdentity = buildIdentityHintFromContext(queryContext, parallelId);
    if (chIdentity) {
      try {
        // CF-CH-P8-TESTS: use the provenance-aware sibling so chCardId +
        // chTrustReason flow onto FetchedComps and ultimately the corpus row.
        const chResult = await getCardSalesRoutedWithProvenance(
          pinnedCardId,
          grade,
          25,
          chIdentity,
        );
        const chServed =
          chResult.sales.length > 0 && chResult.sales[0]?.source === "cardhedge";
        if (chServed) {
          const mapped = chSalesToRawComps(chResult.sales, {
            year: queryContext?.cardYear,
            product: queryContext?.product,
            playerName: queryContext?.playerName,
            parallel: queryContext?.parallel,
            cardNumber: queryContext?.cardNumber,
          });
          const identity = buildIdentityFromContext(queryContext, pinnedCardId);
          const chMedian = chComputeMedian(mapped.map((c) => c.price));
          console.log(JSON.stringify({
            event: "compiq.fetchComps.ch_served",
            source: "compiqEstimate.fetchComps",
            path: "pinned",
            csCardId: pinnedCardId,
            chCardId: chResult.chCardId ?? null,
            chTrustReason: chResult.chTrustReason ?? null,
            chCompCount: mapped.length,
            chMedian,
          }));
          return {
            comps: mapped,
            card: identity,
            variantWarning: [],
            aiCategory: null,
            vendor: "cardhedge",
            chCardId: chResult.chCardId,
            chTrustReason: chResult.chTrustReason,
          };
        }
      } catch (err) {
        // Non-blocking: any CH error falls through to the existing
        // Cardsight pinned-id path. Logged at warn for telemetry.
        console.warn(
          `[compiq.fetchComps] CH pinned-path threw, falling through to Cardsight: ${
            (err as Error)?.message ?? err
          }`,
        );
      }
    }

    // CF-CARDSIGHT-REMOVAL (Phase 3 Wave 3): the Cardsight pinned-id pricing
    // fallback has been removed. CardHedge is the sole comp source. When the
    // CardHedge-first attempt above does not serve (no identity bridge, no
    // match, or untrusted), return empty comps for the pinned card — we no
    // longer call Cardsight getPricing / getCardDetail. Identity is built
    // from the request context so the downstream "couldn't price reliably"
    // UI still renders the card honestly.
    const identity = buildIdentityFromContext(queryContext, pinnedCardId);
    console.warn(
      `[compiq.fetchComps] pinned cardId=${pinnedCardId} not served by CardHedge; ` +
        `Cardsight fallback removed — returning 0 comps`,
    );
    return {
      comps: [],
      card: identity,
      variantWarning: [],
      aiCategory: null,
      vendor: "cardhedge",
    };
  }

  const {
    card,
    sales,
    variantWarning,
    aiCategory,
    priceSource,
    priceSourceInternal,
    parallelMatchFilteredCount,
    parallelMatchUnifiedCount,
    chCardId: routedChCardId,
    chTrustReason: routedChTrustReason,
  } = await findCompsRouted(query, { grade, limit: 25, queryContext });

  // CF-CH-P5-PRIMARY: detect which vendor the router served from. The
  // router (P3) layers CH on top of CS via the bridge; sales carry
  // source="cardhedge" when CH won and source="cardsight" when CS served.
  // An empty sales array is treated as Cardsight (no comps to attribute).
  const routedVendor: "cardhedge" | "cardsight" =
    sales.length > 0 && sales[0]?.source === "cardhedge"
      ? "cardhedge"
      : "cardsight";

  if (routedVendor === "cardhedge" && card?.card_id) {
    const chMedian = chComputeMedian(
      sales.map((s) => s.price).filter((p) => Number.isFinite(p) && p > 0),
    );
    console.log(JSON.stringify({
      event: "compiq.fetchComps.ch_served",
      source: "compiqEstimate.fetchComps",
      path: "free-text",
      query,
      csCardId: card.card_id,
      chCardId: routedChCardId ?? null,
      chTrustReason: routedChTrustReason ?? null,
      chCompCount: sales.length,
      chMedian,
    }));
  }

  if (!card) {
    console.warn(`[compiq.fetchComps] Card Hedge found no matching card for "${query}"`);
    return {
      comps: [],
      card: null,
      variantWarning: [],
      aiCategory,
      vendor: routedVendor,
      priceSource,
      priceSourceInternal,
      parallelMatchFilteredCount,
      parallelMatchUnifiedCount,
    };
  }

  const identity = {
    card_id: card.card_id,
    title: card.title ?? card.name ?? null,
    player: card.player ?? null,
    set: card.set ?? null,
    // CF-PLAYER-IN-SET-RELEASE-KEY (2026-06-09): cardsight.router populates
    // `card.set` with detail.releaseName for this routed-search path (see
    // cardsight.router.ts:216-217 + 234-235), so it's already the release.
    // Mirror it onto `release` so callers can scope by release uniformly,
    // regardless of whether the request came in via the pinned-id path or
    // the fall-through routed-search path.
    release: card.set ?? null,
    year: card.year ?? null,
    number: card.number ?? null,
    variant: card.variant ?? null,
  };

  if (sales.length === 0) {
    console.warn(
      `[compiq.fetchComps] Card Hedge returned 0 comps for card_id=${card.card_id} query="${query}" grade=${grade}`
    );
    return {
      comps: [],
      card: identity,
      variantWarning,
      aiCategory,
      vendor: routedVendor,
      priceSource,
      priceSourceInternal,
      parallelMatchFilteredCount,
      parallelMatchUnifiedCount,
    };
  }

  // CF-PARALLEL-AWARE-VALUE serve-time guard (2026-06-09): the pinned
  // branch already filters at line ~1196; mirror it here so a stray
  // meaningful-query alongside parallelId can't route around the
  // structural per-record filter. parallelId present → keep only
  // records with that parallel_id; absent → keep base only (no
  // parallel_id). The routed-search sale shape doesn't declare
  // parallel_id but Cardsight's downstream sales DO carry it; defensive
  // cast to the generic shape filterRecordsByParallel expects.
  const salesWithParallel = sales as Array<{ parallel_id?: string | null } & typeof sales[number]>;
  const salesFiltered = filterRecordsByParallel(salesWithParallel, parallelId ?? null);
  if (salesFiltered.length === 0) {
    console.warn(
      `[compiq.fetchComps] fall-through: 0 comps after parallel filter (parallelId=${parallelId ?? "(base)"}) for card_id=${card.card_id}`
    );
    return {
      comps: [],
      card: identity,
      variantWarning,
      aiCategory,
      vendor: routedVendor,
      priceSource,
      priceSourceInternal,
      parallelMatchFilteredCount,
      parallelMatchUnifiedCount,
    };
  }

  const mapped: RawComp[] = salesFiltered
    .map((s) => ({
      price: s.price,
      title: s.title || [card.year, card.set, card.player, card.number, card.variant].filter(Boolean).join(" "),
      soldDate: s.date ?? "",
      // CF-RECENTCOMPS-SALETYPE: preserve listing_type from the
      // routed-search sale shape when present. Defensive cast — the
      // RoutedResult sale union doesn't always declare the field but
      // Cardsight's downstream sales DO carry it.
      listingType: (s as { listing_type?: string | null }).listing_type ?? null,
      // CF-RECENTCOMPS-IMAGEURL: same defensive cast — preserve image_url.
      imageUrl: (s as { image_url?: string | null }).image_url ?? null,
    }))
    .filter((c) => c.price > 0);

  console.log(
    `[compiq.fetchComps] Card Hedge: query="${query}" card_id=${card.card_id} comps=${mapped.length}`
  );
  return {
    comps: mapped,
    card: identity,
    variantWarning,
    aiCategory,
    vendor: routedVendor,
    chCardId: routedVendor === "cardhedge" ? routedChCardId : undefined,
    chTrustReason: routedVendor === "cardhedge" ? routedChTrustReason : undefined,
    priceSource,
    priceSourceInternal,
    parallelMatchFilteredCount,
    parallelMatchUnifiedCount,
  };
}

/**
 * Apply the CompIQ recency window: discard sales older than `windowDays` days
 * unless that would leave fewer than 3 comps (thin market — keep everything).
 *
 * Default `windowDays = 21` preserves the legacy 21-day rule byte-identically.
 * CF-PRICEHISTORY-60D (2026-06-10): the priceHistory[] series re-runs the
 * sub-market matcher at windowDays=60 for chart display only.
 */
function applyRecencyFilter(pool: RawComp[], windowDays: number = 21): RawComp[] {
  const cutoff = Date.now() - windowDays * 24 * 3600 * 1000;
  const fresh = pool.filter((c) => {
    if (!c.soldDate) return false;
    const ts = Date.parse(c.soldDate);
    return Number.isFinite(ts) && ts >= cutoff;
  });
  return fresh.length >= 3 ? fresh : pool;
}

/**
 * CF-PRICEHISTORY-60D (2026-06-10): evenly downsample an items array by
 * its sort-order index to a target count, preserving endpoints.
 *
 * Used to cap priceHistory[] at 150 points on dense 60d pools without
 * truncating to the most-recent-150 (which would lose temporal spread).
 * Caller is responsible for sorting `items` first; this fn picks
 * indices `round(i * (n - 1) / (target - 1))` for i in [0..target-1].
 *
 * Pure module-level export so the downsample logic is unit-testable
 * in isolation from computeEstimate's 30-step pipeline.
 */
export function evenlyDownsample<T>(items: ReadonlyArray<T>, target: number): T[] {
  if (target <= 0) return [];
  if (items.length <= target) return items.slice();
  if (target === 1) return [items[0]];
  const out: T[] = new Array(target);
  const step = (items.length - 1) / (target - 1);
  const seen = new Set<number>();
  for (let i = 0; i < target; i++) {
    let idx = Math.round(i * step);
    if (idx >= items.length) idx = items.length - 1;
    // Guard against duplicate picks on small n / large target — walk forward.
    while (seen.has(idx) && idx < items.length - 1) idx++;
    seen.add(idx);
    out[i] = items[idx];
  }
  return out;
}

/**
 * CF-PRICEHISTORY-60D (2026-06-10): loose typo-backstop for the 60d
 * priceHistory pool. Drops sales whose price falls outside
 * [median/10, median*10]. Intent: kill $1 / $50k typos against a ~$450
 * median; preserve real swings (e.g. $600 vs $450 median, ratio 1.33,
 * survives). Distinct from the value-path `filterPriceOutliers` (MAD)
 * which is dispersion-sensitive and clips real trend endpoints.
 * Skipped when sample size < 4 or median <= 0.
 */
function loosePriceTypoFilter(sales: RawComp[]): RawComp[] {
  if (sales.length < 4) return sales;
  const prices = sales.map((s) => s.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  if (!Number.isFinite(median) || median <= 0) return sales;
  const lo = median / 10;
  const hi = median * 10;
  return sales.filter((s) => s.price >= lo && s.price <= hi);
}

/**
 * Parse a Card Hedge grade string out of the user's free-text query.
 * Recognizes "PSA 10", "BGS 9.5", "SGC 10", "CGC 10", "Raw"/"ungraded".
 * Returns null when nothing is detected so caller falls back to "Raw".
 */
function parseGradeFromQuery(query: string): string | null {
  const q = query.toLowerCase();
  if (/\b(raw|ungraded)\b/.test(q)) return "Raw";
  const m = q.match(/\b(psa|bgs|sgc|cgc)\s*([0-9]+(?:\.5)?)\b/);
  if (m) {
    const co = m[1].toUpperCase();
    const val = m[2];
    return `${co} ${val}`;
  }
  return null;
}

/**
 * Comp-volume confidence ceiling per the CompIQ pricing rules:
 *   liquid    (≥10) → 95
 *   moderate  (5–9) → 80
 *   thin      (3–4) → 65
 *   very_thin (<3)  → 45
 * Halved further to 55 when variance exceeds 40%.
 */
function calibrateConfidence(rawConfidencePct: number, comps: { price: number }[]): number {
  const n = comps.length;
  let ceiling: number;
  if (n >= 10) ceiling = 95;
  else if (n >= 5) ceiling = 80;
  else if (n >= 3) ceiling = 65;
  else ceiling = 45;

  if (n >= 2) {
    const prices = comps.map((c) => c.price);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    if (mean > 0) {
      const std = Math.sqrt(prices.reduce((a, p) => a + (p - mean) ** 2, 0) / prices.length);
      if (std / mean > 0.4) ceiling = Math.min(ceiling, 55);
    }
  }

  return Math.min(rawConfidencePct, ceiling);
}

// ---------------------------------------------------------------------------
// Buy Window Score (1–10) — "Is now a good time to buy this card?"
// ---------------------------------------------------------------------------

export interface BuyWindowResult {
  score: number;          // 1..10
  label: string;          // "Strong Buy Window" etc.
  reasons: string[];      // 2–3 plain-English drivers
}

function computeBuyWindowScore(params: {
  trendDirection: "up" | "down" | "flat";
  trendPct: number;
  recentCount: number;
  olderCount: number;
  basedOn: BroaderTrend["basedOn"];
  signalMultiplier?: number;
  month: number;          // 1..12
  printRun?: number;      // e.g. 25, 99, 150
  grade?: string;
}): BuyWindowResult {
  let base = 5;

  // Trend direction adjustment
  if (params.trendDirection === "up" && params.trendPct >= 15) base += 2;
  else if (params.trendDirection === "up" && params.trendPct >= 5) base += 1;
  else if (params.trendDirection === "down" && params.trendPct <= -15) base -= 2;
  else if (params.trendDirection === "down" && params.trendPct <= -5) base -= 1;

  // Market depth adjustment
  const totalSales = params.recentCount + params.olderCount;
  if (totalSales >= 20) base += 1;
  else if (totalSales <= 3) base -= 1;

  // Signal multiplier adjustment
  if (typeof params.signalMultiplier === "number") {
    if (params.signalMultiplier >= 1.2) base += 1;
    else if (params.signalMultiplier <= 0.85) base -= 1;
  }

  // Seasonal adjustment (baseball calendar)
  const peakMonths = [3, 4, 7, 10];
  const offMonths = [11, 12, 1];
  if (peakMonths.includes(params.month)) base += 1;
  else if (offMonths.includes(params.month)) base -= 1;

  // Scarcity adjustment
  if (params.printRun && params.printRun <= 25) base += 1;
  if (params.printRun && params.printRun <= 10) base += 1;

  const score = Math.max(1, Math.min(10, base));

  const label =
    score >= 9 ? "Strong Buy Window" :
    score >= 7 ? "Good Time to Buy" :
    score >= 5 ? "Fair Buy Window" :
    score >= 3 ? "Weak Buy Window" :
    "Poor Buy Window";

  const reasons: string[] = [];
  if (params.trendDirection === "up" && params.trendPct >= 5) {
    reasons.push(`Price trending up ${params.trendPct.toFixed(0)}%`);
  } else if (params.trendDirection === "down" && params.trendPct <= -5) {
    reasons.push("Price falling — potential buy dip");
  }
  if (totalSales < 5) reasons.push("Thin market — price less reliable");
  else if (totalSales >= 20) reasons.push("Liquid market — reliable signal");
  if (peakMonths.includes(params.month)) reasons.push("Peak baseball season demand");
  else if (offMonths.includes(params.month)) reasons.push("Off-season — lower demand");
  if (params.printRun && params.printRun <= 25) {
    reasons.push(`Scarce card — only /${params.printRun} exist`);
  }
  if (typeof params.signalMultiplier === "number" && params.signalMultiplier >= 1.2) {
    reasons.push("Live demand signals running hot");
  } else if (typeof params.signalMultiplier === "number" && params.signalMultiplier <= 0.85) {
    reasons.push("Live demand signals cooling");
  }
  if (params.basedOn === "insufficient") {
    reasons.push("Limited comp history — confidence reduced");
  }

  return { score, label, reasons: reasons.slice(0, 3) };
}

// Extract a print run integer from a parallel string like "Blue /99" or "Red Refractor /25".
function parsePrintRun(parallel?: string | null): number | undefined {
  if (!parallel) return undefined;
  const m = String(parallel).match(/\/\s*(\d{1,5})/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Confidence Interval (range around the predicted price)
// ---------------------------------------------------------------------------

export interface ConfidenceIntervalResult {
  low: number;
  high: number;
  width: "narrow" | "moderate" | "wide";
  explanation: string;
}

function computeConfidenceInterval(params: {
  predictedPrice: number;
  recentCount: number;
  olderCount: number;
  basedOn: BroaderTrend["basedOn"];
  trendPct: number;
}): ConfidenceIntervalResult | null {
  if (!Number.isFinite(params.predictedPrice) || params.predictedPrice <= 0) return null;
  const totalSamples = params.recentCount + params.olderCount;

  let spreadPct: number;
  if (totalSamples >= 20 && params.basedOn === "exact") {
    spreadPct = 0.08;
  } else if (totalSamples >= 10) {
    spreadPct = 0.15;
  } else if (totalSamples >= 5) {
    spreadPct = 0.22;
  } else if (totalSamples >= 2) {
    spreadPct = 0.35;
  } else {
    spreadPct = 0.5;
  }

  if (Math.abs(params.trendPct) >= 20) spreadPct *= 1.3;

  const low = Math.round(params.predictedPrice * (1 - spreadPct));
  const high = Math.round(params.predictedPrice * (1 + spreadPct));
  const width: ConfidenceIntervalResult["width"] =
    spreadPct <= 0.1 ? "narrow" : spreadPct <= 0.25 ? "moderate" : "wide";

  const explanation =
    width === "narrow" ? `Based on ${totalSamples} recent sales — high confidence`
    : width === "moderate" ? `Based on ${totalSamples} sales — moderate confidence`
    : `Limited sales data (${totalSamples} found) — wide estimate range`;

  return { low, high, width, explanation };
}

// ---------------------------------------------------------------------------
// CF-FMV-NOWCAST Ship 1 — per-FMV uncertainty band
// ---------------------------------------------------------------------------
// Reuses the spreadPct table from computeConfidenceInterval above AND adds
// a staleness widening (computeConfidenceInterval today widens only on low
// samples + high trendPct — Ship 1 adds: an old newest-comp widens the band
// even with many samples).
//
// `siblingPath: true` starts the spread one band wider, matching the lower
// confidence cap (65 vs main-path 95) the sibling-pool rescue path emits.
//
// Honesty rule: when sampleCount or daysSinceNewest is unknown, default to
// the widest spread. We never know less and emit narrower.
//
// Output: {low, high} or {null, null} when FMV is unusable (null / 0 / NaN).
export function computeFmvBand(
  fmv: number | null,
  params: {
    sampleCount?: number | null;
    daysSinceNewest?: number | null;
    basedOn?: BroaderTrend["basedOn"] | null;
    trendPct?: number | null;
    siblingPath?: boolean;
  } = {},
): { low: number | null; high: number | null } {
  if (typeof fmv !== "number" || !Number.isFinite(fmv) || fmv <= 0) {
    return { low: null, high: null };
  }

  const sampleCount =
    typeof params.sampleCount === "number" && Number.isFinite(params.sampleCount)
      ? params.sampleCount
      : null;
  const daysSinceNewest =
    typeof params.daysSinceNewest === "number" && Number.isFinite(params.daysSinceNewest)
      ? params.daysSinceNewest
      : null;
  const basedOn = params.basedOn ?? "insufficient";
  const trendPct =
    typeof params.trendPct === "number" && Number.isFinite(params.trendPct)
      ? params.trendPct
      : 0;

  // Mirror computeConfidenceInterval (L1232-1242). Unknown sampleCount ->
  // widest band per the honesty rule.
  let spreadPct: number;
  if (sampleCount == null) {
    spreadPct = 0.5;
  } else if (sampleCount >= 20 && basedOn === "exact") {
    spreadPct = 0.08;
  } else if (sampleCount >= 10) {
    spreadPct = 0.15;
  } else if (sampleCount >= 5) {
    spreadPct = 0.22;
  } else if (sampleCount >= 2) {
    spreadPct = 0.35;
  } else {
    spreadPct = 0.5;
  }

  // Trend-widening (mirrors computeConfidenceInterval L1244).
  if (Math.abs(trendPct) >= 20) spreadPct *= 1.3;

  // Staleness widening — NEW in Ship 1. An old newest-comp widens the band
  // independently of sample count. Unknown daysSinceNewest -> widest staleness.
  if (daysSinceNewest == null) {
    spreadPct = Math.max(spreadPct, 0.5);
  } else if (daysSinceNewest > 90) {
    spreadPct *= 1.5;
  } else if (daysSinceNewest > 30) {
    spreadPct *= 1.25;
  } else if (daysSinceNewest > 7) {
    spreadPct *= 1.1;
  }

  // Sibling-pool path starts one band wider (its confidence cap is 65 vs
  // main-path 95 — the FMV is derived from related-card sales, not exact).
  if (params.siblingPath) {
    spreadPct *= 1.25;
  }

  // Final clamp.
  spreadPct = Math.max(0.05, Math.min(0.75, spreadPct));

  return {
    low: Math.round(fmv * (1 - spreadPct)),
    high: Math.round(fmv * (1 + spreadPct)),
  };
}

// ---------------------------------------------------------------------------
// CF-PREDICTION-CORPUS-EMISSION-COVERAGE — unified corpus emit
// ---------------------------------------------------------------------------
// Single source for the prediction_log payload. Called from every FMV-
// returning path in computeEstimate (main success + 4 fallback paths) so
// the corpus captures the full pricing population, not just the happy path.
//
// Handles missing data: `trendIQ` absent → zero-coverage stub
// (composite=1.0, direction="flat", coverage="insufficient", null
// components); `forwardProjectionFactor` defaults to 1.0; `compsUsed`
// defaults to 0. The payload field set + ordering matches the original
// inline emit at L2854-2897 to keep the dual-emit stdout JSON shape
// identical for the burn-in window.
//
// The emit itself is fire-and-forget — try/catch wraps both the
// console.log (to be safe against weird payloads) and the
// writePredictionLog call (writer is already non-throwing, but the
// caller's try/catch protects against future refactor regressions).
//
// `surfacedPrice` is computed here from `predictedPrice ?? fairMarketValue`
// per methodology — names the MAPE target unambiguously. The paired
// `surfacedPriceSource` distinguishes "predictedPrice was the headline"
// from "fairMarketValue was the headline" so a future analyst can
// stratify. `"none"` covers degenerate paths (unsupported_sport).
//
// CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): callContext is now
// REQUIRED — every caller of computeEstimate threads a typed
// PredictionCallContext, and computeEstimate forwards it to every emit
// site (the 5 paths from CF-PREDICTION-CORPUS-EMISSION-COVERAGE). The
// corpus row gains 4 attribution fields: source (closed enum),
// userId, holdingId, routedFromHolding. These are DESCRIPTIVE — they
// must NOT enter inputSignature (same card priced from two endpoints
// is the same prediction, just attributed differently).
export function emitPredictionToCorpus(params: {
  cardIdentity?: { card_id: string | null } | null;
  body: {
    playerName?: string;
    cardYear?: number;
    product?: string;
    parallel?: string;
    gradeCompany?: string;
    gradeValue?: number;
    cardId?: string;
  };
  fairMarketValue: number | null;
  fmvMechanism: "main-pipeline" | "sibling-pool-weighted-median" | "unavailable";
  predictedPrice: number | null;
  predictedPriceRange: { low: number; high: number } | null;
  predictedPriceMechanism: "trendiq-projection" | "multiplier-anchored" | "unavailable";
  forwardProjectionFactor?: number;
  trendIQ?: import("./trendIQ.types.js").TrendIQResult | null;
  compsUsed?: number;
  callContext: PredictionCallContext;
  // CF-TREND-EXTRAPOLATED (2026-06-10): audit signal — distinguishes
  // observed fmv (training-eligible) from trend-extrapolated estimates
  // (training-excluded via fairMarketValue=null). Descriptive only;
  // training-exclusion is structural via fairMarketValue, NOT this
  // flag. Required field on every emit so analysts can assert the
  // invariant: no row with estimateSource="trend-extrapolated" has a
  // non-null fairMarketValue.
  // CF-ESTIMATE-SOURCE-VENDOR-NEUTRAL (2026-07-04): renamed from
  // "cardhedge" / "cardhedge-last-sale" to vendor-neutral "live-market"
  // / "live-market-last-sale". The old literals should not appear on any
  // wire response. Consumers that switched on the old values must accept
  // both during the transition window — see corpusMapping.ts for the
  // dual-recognition pattern. Historical prediction_log rows written
  // before this rename still carry the legacy values as string data.
  estimateSource?:
    | "observed"
    | "live-market"
    | "live-market-last-sale"
    | "trend-extrapolated"
    | "last-sale"
    | "sibling-fallback"
    | null;
  estimatedValue?: number | null;
}): void {
  try {
    const fmv =
      typeof params.fairMarketValue === "number" && Number.isFinite(params.fairMarketValue)
        ? params.fairMarketValue
        : null;
    const predicted =
      typeof params.predictedPrice === "number" && Number.isFinite(params.predictedPrice)
        ? params.predictedPrice
        : null;
    const surfacedPrice = predicted ?? fmv ?? null;
    const surfacedPriceSource: "predictedPrice" | "fairMarketValue" | "none" =
      predicted !== null
        ? "predictedPrice"
        : fmv !== null
        ? "fairMarketValue"
        : "none";

    const trendIQ = params.trendIQ
      ? {
          composite: params.trendIQ.composite,
          direction: params.trendIQ.direction,
          coverage: params.trendIQ.coverage,
          components: {
            playerMomentum: params.trendIQ.components.playerMomentum?.multiplier ?? null,
            cardTrajectory: params.trendIQ.components.cardTrajectory?.multiplier ?? null,
            segmentTrajectory: params.trendIQ.components.segmentTrajectory?.multiplier ?? null,
          },
          // PHASE-4B-SLICE-1 (2026-06-01): pass-through TrendIQResult.weights
          // so the corpus's flat `trendIQ_weights` field can answer
          // "what weight did Layer 1 actually carry?" without traversing
          // the full nested trendIQ object.
          weights: params.trendIQ.weights,
          lastUpdated: params.trendIQ.lastUpdated,
        }
      : {
          // Zero-coverage stub for fallback paths that don't compute trendIQ.
          // composite=1.0 + coverage="insufficient" mirror forwardProjection.ts
          // graceful-degradation semantics; lastUpdated=null preserves the
          // "no signal anchor" distinction from a fresh 1.0-composite signal.
          composite: 1.0,
          direction: "flat" as const,
          coverage: "insufficient" as const,
          components: {
            playerMomentum: null,
            cardTrajectory: null,
            segmentTrajectory: null,
          },
          // PHASE-4B-SLICE-1: weights=null on the stub preserves the
          // "no Layer 1 weight assigned" distinction from a true
          // coverage="insufficient" computeTrendIQ result (which has
          // weights={0,0,0}, not null). Stub means "no trendIQ attempt
          // happened at all" — null is the right tri-state.
          weights: null,
          lastUpdated: null,
        };

    const __predictionEmit = {
      eventType: "prediction_emitted" as const,
      timestamp: new Date().toISOString(),
      cardId:
        params.cardIdentity?.card_id ?? params.body.cardId ?? null,
      playerName: params.body.playerName ?? null,
      cardYear: params.body.cardYear ?? null,
      product: params.body.product ?? null,
      parallel: params.body.parallel ?? null,
      gradeCompany: params.body.gradeCompany ?? null,
      gradeValue: params.body.gradeValue ?? null,
      fairMarketValue: fmv,
      fmvMechanism: params.fmvMechanism,
      surfacedPrice,
      surfacedPriceSource,
      predictedPrice: predicted,
      predictedPriceRange: params.predictedPriceRange,
      predictedPriceMechanism: params.predictedPriceMechanism,
      forwardProjectionFactor: params.forwardProjectionFactor ?? 1.0,
      trendIQ,
      compsUsed: params.compsUsed ?? 0,
      // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): attribution
      // axis — descriptive, NOT folded into inputSignature. The
      // §4.2/4.3 sale-join switches on routedFromHolding:
      //   - routedFromHolding=true → join via holdingId+userId to
      //     PortfolioLedgerEntry sale outcomes (the portfolio-attributable
      //     forward-direction hit-rate signal);
      //   - routedFromHolding=false → join via cardId to the
      //     broader eBay-sold outcome path (population MAPE).
      source: params.callContext.source,
      userId: params.callContext.userId ?? null,
      holdingId: params.callContext.holdingId ?? null,
      routedFromHolding: params.callContext.routedFromHolding,
      // CF-TREND-EXTRAPOLATED (2026-06-10): audit fields. Training-
      // exclusion is STRUCTURAL via fairMarketValue=null; estimateSource
      // is the descriptive signal that lets analysts assert the
      // invariant after the fact. estimatedValue is the display-only
      // figure (never routed into fairMarketValue).
      estimateSource: params.estimateSource ?? null,
      estimatedValue:
        typeof params.estimatedValue === "number" && Number.isFinite(params.estimatedValue)
          ? params.estimatedValue
          : null,
    };

    // CF-TREND-EXTRAPOLATED (2026-06-10): assert the structural
    // training-exclusion invariant — a trend-extrapolated row must
    // NEVER carry a non-null fairMarketValue. Defensive guard for
    // future refactors that accidentally route the estimate into fmv.
    if (params.estimateSource === "trend-extrapolated" && fmv !== null) {
      console.error(
        "[compiq.prediction_emitted] INVARIANT VIOLATION: estimateSource=trend-extrapolated with non-null fairMarketValue. " +
          "This row would contaminate training-as-observed. Forcing fairMarketValue to null on the corpus row.",
      );
      (__predictionEmit as { fairMarketValue: number | null }).fairMarketValue = null;
    }

    console.log("[compiq.prediction_emitted] " + JSON.stringify(__predictionEmit));
    writePredictionLog(__predictionEmit);
  } catch {
    // Logging must never block a pricing response.
  }

  // CF-PER-CARD-COMP-POOL-AUDIT (2026-06-29): side-channel telemetry
  // comparing the engine's surfaced FMV to CardHedge's reference FMV
  // for the same (chCardId, grade). Volume test 2026-06-29 surfaced
  // Class D drift cases (Bryant, Arenado where engine ≈ CH ± 50%);
  // this audit captures those events with enough context for offline
  // diagnosis. Fire-and-forget via setImmediate so it never adds to
  // pricing latency. getCardFmv is cached (12h TTL) so the audit is
  // essentially free when the pricing path already touched it.
  emitCompPoolAuditAsync({
    chCardId: params.cardIdentity?.card_id ?? params.body.cardId ?? null,
    gradeCompany: params.body.gradeCompany ?? null,
    gradeValue: params.body.gradeValue ?? null,
    engineFmv:
      typeof params.fairMarketValue === "number" && Number.isFinite(params.fairMarketValue)
        ? params.fairMarketValue
        : null,
    engineCompsUsed: params.compsUsed ?? 0,
    callSource: params.callContext?.source ?? null,
  });
}

/**
 * CF-PER-CARD-COMP-POOL-AUDIT (2026-06-29): build the CardHedge grade
 * string from the engine's (gradeCompany, gradeValue) pair. CH expects
 * "Raw" or "PSA 10" / "BGS 9.5" / "SGC 9". Returns null when inputs
 * don't combine into a recognizable grade label (audit skipped).
 */
export function formatGradeForCardHedge(
  gradeCompany: string | null | undefined,
  gradeValue: number | string | null | undefined,
): string | null {
  const valueStr = gradeValue == null ? "" : String(gradeValue).trim();
  const valueIsRaw = !valueStr || valueStr.toLowerCase() === "raw";
  const company = (gradeCompany == null ? "" : String(gradeCompany).trim()).toUpperCase();
  const companyIsRaw = !company || company === "RAW";

  // Value explicitly indicates Raw (or no grade at all).
  if (valueIsRaw) {
    // Edge: graded company is present but value missing — that's an
    // incomplete pair (the holding has "PSA" set but no numeric grade).
    // Drop the audit row rather than mis-classify as Raw.
    if (!companyIsRaw && valueStr === "") return null;
    return "Raw";
  }
  // Value is present and non-raw, but no company → can't form a grade label.
  if (companyIsRaw) return null;
  if (!["PSA", "BGS", "SGC", "CGC", "HGA"].includes(company)) return null;
  // Allowed grades: 10, 0-9, 0.5-9.5 (the standard half-grade scale).
  // 11+ or arbitrary decimals → out-of-band, audit skipped.
  if (!/^(10|[0-9](\.5)?)$/.test(valueStr)) return null;
  return `${company} ${valueStr}`;
}

function emitCompPoolAuditAsync(opts: {
  chCardId: string | null;
  gradeCompany: string | null;
  gradeValue: number | string | null;
  engineFmv: number | null;
  engineCompsUsed: number;
  callSource: string | null;
}): void {
  // Fast skip when there's nothing meaningful to audit. Done OUTSIDE
  // setImmediate so we don't even schedule the microtask for skip cases.
  if (!opts.chCardId || opts.engineFmv == null || opts.engineFmv <= 0) return;
  if (opts.engineCompsUsed === 0) return;
  const grade = formatGradeForCardHedge(opts.gradeCompany, opts.gradeValue);
  if (!grade) return;

  setImmediate(async () => {
    try {
      // Dynamic import mirrors the existing pattern in this file
      // (e.g. line 1343 getPricesByCard via dynamic import) to avoid
      // creating a top-level edge cardhedge.client → compiqEstimate.
      const mod = await import("./cardhedge.client.js");
      const chFmv = await mod.getCardFmv(opts.chCardId!, grade);
      if (!chFmv || typeof chFmv.price !== "number" || chFmv.price <= 0) {
        // CH has no FMV for this (cardId, grade). Useful audit signal —
        // tells us how often the engine prices something CH won't.
        console.log(JSON.stringify({
          event: "engine_vs_ch_fmv_audit",
          source: "compiq.emitPredictionToCorpus",
          chCardId: opts.chCardId,
          grade,
          engineFmv: opts.engineFmv,
          chFmv: null,
          ratio: null,
          engineCompsUsed: opts.engineCompsUsed,
          isDrift: false,
          chMissing: true,
          callSource: opts.callSource,
          timestamp: new Date().toISOString(),
        }));
        return;
      }
      const ratio = opts.engineFmv! / chFmv.price;
      // Drift bands: engine outside [0.7, 1.5] of CH is a Class D candidate
      // (the volume-test cases ranged 0.5×–2×). Tightening the band to
      // 0.7–1.5 captures the ~30% drift signal without false-positive
      // noise from natural sub-day price flicker.
      const isDrift = ratio < 0.7 || ratio > 1.5;
      console.log(JSON.stringify({
        event: "engine_vs_ch_fmv_audit",
        source: "compiq.emitPredictionToCorpus",
        chCardId: opts.chCardId,
        grade,
        engineFmv: opts.engineFmv,
        chFmv: chFmv.price,
        ratio: Math.round(ratio * 1000) / 1000,
        engineCompsUsed: opts.engineCompsUsed,
        chConfidenceGrade: chFmv.confidence_grade ?? null,
        chFreshnessDays: chFmv.freshness_days ?? null,
        chMethod: chFmv.method ?? null,
        isDrift,
        chMissing: false,
        callSource: opts.callSource,
        timestamp: new Date().toISOString(),
      }));
    } catch {
      // Audit never throws.
    }
  });
}

// ---------------------------------------------------------------------------
// CF-VARIANT-FILTER-LOOSENING — tier ladder constants + helpers
// ---------------------------------------------------------------------------

export type VariantStrictness = "T0" | "T1" | "T2" | "T3";

export const VARIANT_TIERS: ReadonlyArray<VariantStrictness> = ["T0", "T1", "T2", "T3"];

// Minimum surviving comps a tier must yield before we accept it. Below this
// we escalate to the next-looser tier. Matches the soft post-filter threshold
// already used in applyParallelFilter/applyAutoFilter/applyGradeFilter.
export const VARIANT_TIER_MIN_COMPS = 3;

// Confidence ceiling per tier (Q1 lock: multiplicative cap composition).
export const VARIANT_TIER_CAP: Readonly<Record<VariantStrictness, number>> = {
  T0: 95,
  T1: 80,
  T2: 65,
  T3: 55,
};

// Verdict-text annotation per tier (Q2 lock). T0 keeps the orchestrator's
// existing verdict text; T1/T2/T3 explicitly flag variant uncertainty so
// the iOS UI surfaces the approximation without needing new plumbing.
export const VARIANT_TIER_VERDICT: Readonly<Record<VariantStrictness, string | null>> = {
  T0: null,
  T1: "Variant approximation — parallel unverified",
  T2: "Estimate from broader pool — variant unverified",
  T3: "Pool estimate — verify variant before listing",
};

// Per-tier accepted rejection reasons. A rejection reason in the tier's set
// is TREATED AS "match" — the comp survives the filter at that tier. Anything
// outside the set remains a hard rejection.
//
// Invariants enforced across all tiers:
//   - comp_has_unwanted_auto: hard reject at every tier (Q4 lock). Base-card
//     requests must never price from auto-pool comps; the auto premium
//     discontinuity would poison the FMV.
//   - player_name_missing_from_comp: hard reject at every tier. Even T3 must
//     not price from a different player's comps.
const VARIANT_TIER_ACCEPTS: Readonly<Record<VariantStrictness, ReadonlySet<string>>> = {
  T0: new Set<string>(),
  T1: new Set<string>(["parallel_mismatch", "parallel_qualifier_mismatch"]),
  T2: new Set<string>(["parallel_mismatch", "parallel_qualifier_mismatch", "comp_missing_auto"]),
  T3: new Set<string>([
    "parallel_mismatch",
    "parallel_qualifier_mismatch",
    "comp_missing_auto",
    "print_run_mismatch",
  ]),
};

export interface TierLadderResult<C extends { title: string }> {
  chosenTier: VariantStrictness;
  variantFiltered: C[];
  variantExclusionReasons: Record<string, number>;
  variantExcludedCount: number;
  // Per-tier comp count after filtering. Useful for diagnostics + tests.
  tierLadderTrace: Record<VariantStrictness, number>;
  // True when even the loosest tier (T3) yields <VARIANT_TIER_MIN_COMPS comps.
  // Signals the caller to fall through to the variant-mismatch short-circuit.
  everythingFilteredOut: boolean;
}

// Enumerate ALL rejection reasons per comp (not just first-fired) and partition
// into (matched, rejected) for a given tier. A comp survives only if EVERY
// reason that applies to it is in the tier's accept set; if any non-accepted
// reason fires, the comp is rejected and counted under that reason.
//
// Using getCompVariantMismatchReasons (not isCompVariantMatch) is the key
// correctness fix: a comp that fails both comp_missing_auto AND
// print_run_mismatch must still be rejected at T2 (which accepts the auto
// drop but NOT print_run) even though comp_missing_auto would be the
// first-fired reason returned by isCompVariantMatch.
function classifyCompsForTier<C extends { title: string }>(
  comps: C[],
  parsed: ParsedCardQuery,
  tier: VariantStrictness
): { matched: C[]; reasons: Record<string, number> } {
  const accepts = VARIANT_TIER_ACCEPTS[tier];
  const matched: C[] = [];
  const reasons: Record<string, number> = {};
  for (const c of comps) {
    const allReasons = getCompVariantMismatchReasons(c.title, parsed);
    const blocking = allReasons.filter((r) => !accepts.has(r));
    if (blocking.length === 0) {
      matched.push(c);
      continue;
    }
    // Count under the FIRST blocking reason so the reason counts align with
    // isCompVariantMatch's first-fired ordering when the user inspects logs.
    const key = blocking[0];
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return { matched, reasons };
}

// CF-VARIANT-FILTER-LOOSENING: run the tier ladder T0→T3, breaking at the
// first tier with ≥VARIANT_TIER_MIN_COMPS surviving comps. If T3 still yields
// <VARIANT_TIER_MIN_COMPS, the caller falls through to the variant-mismatch
// short-circuit (legacy behavior preserved as final fallback).
//
// Tier loosening is monotonic in pool size (each tier's accept set is a
// superset of the prior tier's), so the loop terminates at the first tier
// that crosses the threshold without re-scanning prior tiers.
export function runVariantTierLadder<C extends { title: string }>(
  comps: C[],
  parsed: ParsedCardQuery
): TierLadderResult<C> {
  const trace: Record<VariantStrictness, number> = { T0: 0, T1: 0, T2: 0, T3: 0 };
  let chosenTier: VariantStrictness = "T0";
  let chosenMatched: C[] = [];
  let chosenReasons: Record<string, number> = {};
  for (const tier of VARIANT_TIERS) {
    const { matched, reasons } = classifyCompsForTier(comps, parsed, tier);
    trace[tier] = matched.length;
    chosenTier = tier;
    chosenMatched = matched;
    chosenReasons = reasons;
    if (matched.length >= VARIANT_TIER_MIN_COMPS) break;
  }
  // If no comps to begin with, T0 wins by default (everythingFilteredOut
  // would not fire — the no-comps path is handled by the thin-data branch
  // downstream). Otherwise: T3-and-still-thin means the ladder exhausted.
  const everythingFilteredOut =
    comps.length > 0 &&
    chosenTier === "T3" &&
    chosenMatched.length < VARIANT_TIER_MIN_COMPS &&
    (parsed.isAuto || Boolean(parsed.parallel));
  return {
    chosenTier,
    variantFiltered: chosenMatched,
    variantExclusionReasons: chosenReasons,
    variantExcludedCount: comps.length - chosenMatched.length,
    tierLadderTrace: trace,
    everythingFilteredOut,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

// CF-VARIANT-FILTER-BACKTEST options surface. Default behavior preserves
// production: tier ladder enabled, governed only by VARIANT_TIER_LADDER_ENABLED
// env (default true). When `tierLadderDisabledByHeader` is true, the caller
// (compiqEstimate route handler) has validated the per-request override is
// authorized; computeEstimate trusts it and bypasses the ladder for this
// request only. See `compiqEstimate` route handler for the auth gate.
export interface ComputeEstimateOptions {
  tierLadderDisabledByHeader?: boolean;
  /**
   * CF-TRENDIQ-SURFACES (2026-06-03): optional capture hook for the
   * raw Layer-3 data (sibling card IDs + pre/post sale rows + per-window
   * percentiles). Populated by `computeSegmentTrajectoryAndFull` alongside
   * the byte-identical SegmentTrajectoryComponent the composite math
   * reads. Only the /api/compiq/trendiq/full route opts in; every other
   * caller leaves this undefined and incurs zero behavior change.
   */
  captureSegmentTrajectoryFull?: (
    full: import("./trendIQ.types.js").SegmentTrajectoryFull | null,
  ) => void;
}

export async function computeEstimate(
  body: CompIQEstimateRequest,
  callContext: PredictionCallContext,
  options: ComputeEstimateOptions = {},
): Promise<Record<string, unknown>> {
  // PHASE-4A-2.2 (2026-06-02): wrap the body in a fresh cache-stats scope
  // so every `cacheWrap` call inside getPricing / searchCatalog / etc.
  // tallies into a per-prediction bucket. The predictionCorpus emit reads
  // the bucket at write time to populate `cache_hit` on the persisted doc.
  return cacheStatsContext.run({ hits: 0, misses: 0 }, async () => {
  // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): callContext is the
  // attribution axis for every emitPredictionToCorpus call below. The
  // 5 emit sites (unsupported_sport, variant-mismatch, sibling-pool,
  // no-recent-comps, main-pipeline) each forward this through unchanged.
  // tsc rejects free-string sources at the caller because callContext.source
  // is the closed `PredictionCorpusSource` literal union.

  // CF-PLAYERNAME-NORMALIZATION (2026-05-26): strip contamination tokens
  // from playerName before any catalog lookup. iOS scan path historically
  // concatenated set / parallel / status tokens into the player field for
  // ~9 of the user's ~16 real holdings. Read-path only; original stored
  // playerName preserved. Shadowing the parameter so downstream sites
  // automatically use the normalized value.
  if (body.playerName) {
    const normalized = normalizePlayerName(body.playerName);
    if (normalized && normalized !== body.playerName) {
      body = { ...body, playerName: normalized };
    }
  }

  // Detect "auto" / "autograph" inside the parallel string (e.g. "Blue
  // Refractor Auto") and treat it as if isAuto were explicitly set. Without
  // this, the parallel filter would happily pool non-auto base refractors
  // alongside the autograph variant and collapse the FMV.
  const autoTokenRegex = /\b(auto|autograph|autographed)\b/i;
  const parallelHasAutoToken = body.parallel ? autoTokenRegex.test(body.parallel) : false;
  const effectiveIsAuto = body.isAuto === true || parallelHasAutoToken;

  // Strip auto-tokens out of the parallel before normalization so the
  // remaining color/serial words survive (e.g. "Blue Refractor Auto" →
  // "Blue Refractor"). isAuto is now carried separately in subject + title.
  const parallelForNorm = body.parallel
    ? body.parallel.replace(autoTokenRegex, " ").replace(/\s+/g, " ").trim() || undefined
    : undefined;

  const normalizedParallel = normalizeParallel(parallelForNorm);
  const normalizedGradeCompany = normalizeGradeCompany(body.gradeCompany);
  // CF-SET-NAME-SYNONYMS (2026-07-08, Drew): expand hobby shorthand
  // (BDC → Bowman Draft Chrome, BCP → Bowman Chrome Prospects, etc.)
  // before the search query is built so CH matches the canonical set.
  const normalizedProduct = normalizeSetName(body.product);

  const cardTitle = [
    body.playerName,
    body.cardYear,
    normalizedProduct ?? body.product,
    normalizedParallel ?? parallelForNorm ?? body.parallel,
    normalizedGradeCompany ? `${normalizedGradeCompany} ${body.gradeValue}` : undefined,
    effectiveIsAuto ? "Auto" : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  // Build subject for the pipeline
  const subject = {
    playerName: body.playerName,
    cardYear: body.cardYear,
    product: body.product,
    parallel: normalizedParallel,
    gradeCompany: normalizedGradeCompany,
    gradeValue: body.gradeValue,
    isAuto: effectiveIsAuto,
  };

  // Fetch live comps from Card Hedge AI (primary sold-data source).
  // Card Hedge expects a slab grade string ("PSA 10", "BGS 9.5", ...) or "Raw"
  // for ungraded. Resolution order:
  //   1. Explicit gradeCompany + gradeValue on the request body
  //   2. Grade tokens parsed out of the free-text playerName/query
  //   3. Default "Raw"
  const explicitGrade =
    normalizedGradeCompany && body.gradeValue
      ? `${normalizedGradeCompany} ${body.gradeValue}`
      : null;
  const inferredGrade = explicitGrade ? null : parseGradeFromQuery(cardTitle);
  const cardHedgeGrade = explicitGrade ?? inferredGrade ?? "Raw";

  // Phase 2 — queryContext plumbing.
  //
  // Threads body's structured fields through fetchComps → findCompsRouted →
  // toCardsightQuery → resolveCardId so the catalog lookup uses the user's
  // intended playerName / year / product / parallel instead of the joined
  // cardTitle string (which contained sport-suffix + cardNumber noise that
  // contaminated playerName extraction inside the router).
  //
  // /price arrives structured (parseCardQuery already ran upstream in the
  // /price route via requestFromParsed). /estimate arrives structured per
  // CompIQEstimateRequest. /price-by-id sends body.playerName as the free-
  // text iOS displayLabel; we defensively re-parse it here when structured
  // fields are absent so the catalog lookup still gets clean inputs.
  const needsParseFallback =
    !body.cardYear &&
    !body.product &&
    typeof body.playerName === "string" &&
    /\b(19|20)\d{2}\b/.test(body.playerName);
  const parsed = needsParseFallback ? parseCardQuery(body.playerName!) : null;

  // When the defensive parse fires (parsed != null), body.playerName is the
  // raw iOS displayLabel — prefer parsed.playerName which has sport-suffix /
  // cardNumber / set-name noise stripped. When parse didn't fire, body's
  // playerName is already structured (set by /price's requestFromParsed or
  // /estimate's structured client body). Same logic for the other fields.
  const queryContext: QueryContext = {
    playerName: parsed?.playerName ?? body.playerName ?? undefined,
    cardYear: body.cardYear ?? parsed?.year ?? undefined,
    product: body.product ?? parsed?.set ?? undefined,
    parallel: body.parallel ?? parsed?.parallel ?? undefined,
    // CF-CH-THIN-COMP-PRIMARY (2026-06-26): thread parallelId so the
    // CH/CS divergence helper can filter CS sales by parallel_id and
    // suppress wrong-card comparisons.
    parallelId: body.parallelId ?? null,
    // Phase 2 v2 defect #11 — thread cardNumber so resolveCardId disambiguates
    // via detail-probe + LRU cache key includes it. Body's cardNumber comes
    // from /price route's requestFromParsed (set in this PR); parsed.cardNumber
    // is the /price-by-id defensive parse of an iOS displayLabel.
    cardNumber: body.cardNumber ?? parsed?.cardNumber ?? undefined,
    gradeCompany: normalizedGradeCompany ?? parsed?.gradingCompany ?? undefined,
    gradeValue:
      body.gradeValue !== undefined
        ? String(body.gradeValue)
        : parsed?.grade ?? undefined,
    // CF-CARDSIGHT-AUTO-COLOR-RESOLVE-+-PARALLEL-NORMALIZE (2026-06-01):
    // pass effectiveIsAuto so resolveCardId can re-select candidates
    // whose card-number auto-prefix matches user intent (the Q8'' wrong-
    // card guard's upstream half). effectiveIsAuto was computed at L1648
    // from body.isAuto || /\b(auto|autograph|autographed)\b/.test(body.parallel).
    isAuto: effectiveIsAuto,
    // CF-REPRICE-PINNED-AUTHORITATIVE (2026-06-17): forward body flag to
    // fetchComps so reprice (autoPriceHolding) can declare the stored
    // cardId authoritative without overloading playerName.
    pinnedAuthoritative: body.pinnedAuthoritative === true,
  };

  // ── Pre-modern guard ─────────────────────────────────────────────────────
  // CF-LAUNCH-HARDENING (2026-06-02): pre-1980 cards are out-of-scope for
  // CompIQ at launch. Cardsight catalog has thin pre-modern coverage (2024
  // Topps Chrome IS catalogued; 1969 Topps Bobby Cox IS NOT) and pre-modern
  // pricing dynamics (vintage grading premiums, condition-sensitivity,
  // small-pop pricing) require domain handling we don't ship today. Return
  // an explicit source="out-of-scope" with outOfScopeReason="pre-modern"
  // BEFORE fetchComps fires — saves a Cardsight call AND surfaces a clean
  // iOS-renderable "not in scope" shape (NOT the same as "we couldn't
  // find data"). Threshold 1980 is the conventional "modern era" cutoff
  // for sports cards; revisit if/when CompIQ adds vintage handling.
  const PRE_MODERN_YEAR_CUTOFF = 1980;
  const requestedYear =
    typeof body.cardYear === "number" && Number.isFinite(body.cardYear)
      ? body.cardYear
      : null;
  if (requestedYear !== null && requestedYear < PRE_MODERN_YEAR_CUTOFF) {
    console.log(
      `[compiq.computeEstimate] pre-modern out-of-scope short-circuit: query="${cardTitle}" year=${requestedYear}`,
    );
    emitPredictionToCorpus({
      cardIdentity: null,
      body,
      fairMarketValue: null,
      fmvMechanism: "unavailable",
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceMechanism: "unavailable",
      callContext,
    });
    return {
      source: "out-of-scope",
      // Unified flag for the iOS taxonomy: "this card is intentionally
      // outside CompIQ's launch scope" — distinct from "we couldn't
      // resolve / find data". Same flag fires on unsupported_sport (set
      // below) so iOS only needs one branch.
      outOfScopeReason: "pre-modern" as const,
      outOfScopeNote: `Pre-${PRE_MODERN_YEAR_CUTOFF} cards (vintage era) are out-of-scope at launch.`,
      cardIdentity: null,
      fairMarketValue: null,
      fairMarketValueLow: null,
      fairMarketValueHigh: null,
      marketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: null,
      quickSaleValue: null,
      premiumValue: null,
      compsUsed: 0,
      compsAvailable: 0,
      recentComps: [],
      variantWarning: [],
      confidence: { pricingConfidence: 0 },
      verdict: `Pre-${PRE_MODERN_YEAR_CUTOFF} cards are not priced at launch. CompIQ currently supports modern-era cards.`,
      gradeUsed: cardHedgeGrade,
      marketDNA: { trend: "flat", speed: "Normal" },
    } as Record<string, unknown>;
  }

  // CF-PARALLEL-AWARE-VALUE (2026-06-09): thread parallelId through to
  // fetchComps so the pinned-id branch can filter records by parallel
  // (or exclude parallels for base requests). UUID-shape was validated
  // at the route layer; trust it here.
  let fetched = await fetchComps(
    cardTitle,
    cardHedgeGrade,
    body.cardId,
    queryContext,
    body.parallelId ?? null,
  );

  // ── Catalog-miss guard ───────────────────────────────────────────────────
  // CF-LAUNCH-HARDENING (2026-06-02): when the free-text path's Cardsight
  // catalog search yields ZERO candidates (fetched.card === null AND no
  // comps), distinguish "Cardsight doesn't catalog this card" from
  // "Cardsight has the card but no recent sales" (the existing
  // no-recent-comps source). Both look the same in the corpus today
  // (fmvMechanism="unavailable") but they're different product states:
  //   - catalog-miss: pricing genuinely unavailable; suggest user verify
  //     query OR file as catalog gap
  //   - no-recent-comps: pricing might appear once a sale lands; OK to
  //     refresh later
  // Skip on the pinned cardId path — that path already resolved
  // a catalog entry by id; if no comps, it's definitionally no-recent-comps
  // not a catalog miss.
  if (!body.cardId && fetched.card === null && fetched.comps.length === 0) {
    console.log(
      `[compiq.computeEstimate] catalog-miss short-circuit: query="${cardTitle}"`,
    );
    emitPredictionToCorpus({
      cardIdentity: null,
      body,
      fairMarketValue: null,
      fmvMechanism: "unavailable",
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceMechanism: "unavailable",
      callContext,
    });
    return {
      source: "catalog-miss",
      cardIdentity: null,
      fairMarketValue: null,
      fairMarketValueLow: null,
      fairMarketValueHigh: null,
      marketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: null,
      quickSaleValue: null,
      premiumValue: null,
      compsUsed: 0,
      compsAvailable: 0,
      recentComps: [],
      variantWarning: [],
      confidence: { pricingConfidence: 0 },
      verdict:
        "We couldn't find this card in our catalog. Try simplifying the query (drop set parallel or grade) or check the spelling.",
      gradeUsed: cardHedgeGrade,
      marketDNA: { trend: "flat", speed: "Normal" },
    } as Record<string, unknown>;
  }

  // ── Sport-scope guard ────────────────────────────────────────────────────
  // CompIQ currently supports baseball only (issue #7). If Card Hedge's AI
  // confidently identified this card as a different sport, short-circuit
  // BEFORE any pricing math runs. We return a stub with source=
  // "unsupported_sport" rather than silently mis-pricing (e.g. case-15:
  // "1986 Fleer Michael Jordan PSA 8" was pricing as a 1991 UD Baseball
  // novelty at ~$46 because identifyCard returned the Basketball Jordan at
  // confidence 0.96). Multi-sport is future scope — when CompIQ adds a
  // sport, expand SUPPORTED_SPORTS rather than removing this gate.
  //
  // Note: this guard fires only when `aiCategory` is populated, which is
  // only the free-text query path (findCompsByQuery → identifyCard). The
  // pinned-card-id path never sets aiCategory because category is not
  // resolved there; that path is gated upstream by the iOS picker, which
  // is fed by /cardsearch → Cardsight (Baseball-locked at the catalog
  // search layer via segment=baseball).
  const SUPPORTED_SPORTS = new Set(["baseball"]);
  const detectedCategory = fetched.aiCategory;
  if (detectedCategory && !SUPPORTED_SPORTS.has(detectedCategory.toLowerCase())) {
    console.log(
      `[compiq.computeEstimate] unsupported-sport short-circuit: query="${cardTitle}" detected="${detectedCategory}"`
    );
    const sportLower = detectedCategory.toLowerCase();
    const unsupportedReason = `CompIQ currently supports baseball cards only. This appears to be a ${sportLower} card.`;
    // CF-PREDICTION-CORPUS-EMISSION-COVERAGE: emit on the unsupported-sport
    // path. fmvMechanism="unavailable", FMV=null, predicted=null →
    // surfacedPriceSource="none". Identity may still resolve (Cardsight
    // returned a card record even though the sport was wrong).
    emitPredictionToCorpus({
      cardIdentity: fetched.card ? { card_id: fetched.card.card_id ?? null } : null,
      body,
      fairMarketValue: null,
      fmvMechanism: "unavailable",
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceMechanism: "unavailable",
      callContext,
    });
    return {
      source: "unsupported_sport",
      // CF-LAUNCH-HARDENING (2026-06-02): unified iOS taxonomy flag —
      // identical semantics to the pre-modern out-of-scope branch above
      // so iOS only needs to check outOfScopeReason != null to detect
      // either flavor. unsupported_sport stays as the source string for
      // backward compat with the 10+ test files that pin it.
      outOfScopeReason: "unsupported-sport" as const,
      unsupportedSportReason: unsupportedReason,
      detectedSport: detectedCategory,
      cardIdentity: fetched.card
        ? {
            card_id: fetched.card.card_id,
            title: fetched.card.title ?? null,
            player: fetched.card.player ?? null,
            set: fetched.card.set ?? null,
            year: fetched.card.year ?? null,
            number: fetched.card.number ?? null,
            variant: fetched.card.variant ?? null,
          }
        : null,
      fairMarketValue: 0,
      fairMarketValueLow: null,
      fairMarketValueHigh: null,
      marketValue: null,
      predictedPrice: null,
      predictedPriceRange: null,
      predictedPriceAttribution: null,
      quickSaleValue: 0,
      premiumValue: 0,
      compsUsed: 0,
      compsAvailable: 0,
      recentComps: [],
      variantWarning: [],
      confidence: { pricingConfidence: 0 },
      verdict: `Unsupported sport (${detectedCategory}). CompIQ currently prices baseball cards only.`,
      gradeUsed: cardHedgeGrade,
      marketDNA: { trend: "flat", speed: "Normal" },
      // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
      // unsupported_sport never derives a last-sale figure — the comps
      // belong to a different sport CompIQ doesn't price. iOS treats
      // this as not-a-card.
      daysSinceNewestComp: null,
      lastSale: null,
      estimateSource: null,
      estimatedValue: null,
      estimateRange: null,
      estimateBasis: null,
    } as Record<string, unknown>;
  }

  // ── Player-identity guard ────────────────────────────────────────────────
  // Card Hedge `/cards/card-search` is a fuzzy match — a query for "Cooper
  // Bonemer" can resolve to "Cooper Pratt" if Bonemer isn't in the catalog.
  // Verify that the user's surname(s) appear in the resolved card's player
  // or title. If not, discard the entire comp pool so downstream paths fall
  // through to the eBay-sold-listing fallback (which uses the literal query).
  //
  // Skip the guard on the pinned-card-id path: comps were fetched
  // authoritatively by Card Hedge `card_id` (no fuzzy-match ambiguity to
  // defend against), and the guard's haystack relies on identity metadata
  // that the pinned path can't always populate (the card_id may not appear
  // in the top-20 `searchCards` hits used for the cosmetic identity lookup),
  // which would otherwise wipe valid comps.
  if (fetched.card && body.playerName && !body.cardId) {
    const wanted = body.playerName
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^a-z]/g, ""))
      .filter((t) => t.length >= 4); // ignore initials / short tokens
    const haystack = (
      (fetched.card.player ?? "") +
      " " +
      (fetched.card.title ?? "")
    ).toLowerCase();
    const missingSurnames = wanted.filter((t) => !haystack.includes(t));
    // ANY missing surname token disqualifies — CH "Cooper Pratt" must NOT
    // match a user query for "Cooper Bonemer" just because the first names
    // collide.
    if (wanted.length > 0 && missingSurnames.length > 0) {
      console.warn(
        `[compiq.computeEstimate] CH identity mismatch: query player="${body.playerName}" CH player="${fetched.card.player}" — discarding ${fetched.comps.length} wrong-player comps`
      );
      fetched = {
        comps: [],
        card: null,
        variantWarning: [...(fetched.variantWarning ?? []), "player_mismatch"],
        aiCategory: fetched.aiCategory,
      };
    }
  }

  // CF-TREND-DIRTY-POOL (2026-06-08): build a junk-excluded full-date pool
  // for the trend surfaces. The FMV pipeline narrows the pool through
  // recency → variant → quality stages; the trend surfaces (cardTrajectory,
  // broaderTrend) previously consumed the FULLY UNFILTERED `fetched.comps`,
  // so damaged / lot / (as is) listings dragged the trend medians while
  // the FMV computed on clean comps. Result: phantom-down trajectories on
  // clean-but-noisily-listed cards (Trout fda530ab: clean recent median
  // ≈ $420 but reported $250 because dirty listings hit the 14-day window).
  //
  // Fix: apply applyCompQualityFilter (EXCLUSION_KEYWORDS + outlier trim)
  // to the full-date pool BEFORE any recency narrowing. Feed that to
  // computeCardTrajectory + fetchBroaderTrend.exactComps so they slice
  // their own recent/older windows out of clean comps.
  //
  // Deliberately NOT applied here: variant / parallel / serial / grade
  // filters. computeCardTrajectory's coupling note (trendIQ.compute.ts:70)
  // documents that same-card variants move directionally together, so
  // the trend signal is intentionally broader than FMV. This change
  // excludes JUNK only; variant breadth is preserved.
  const trendCleanComps = applyCompQualityFilter(fetched.comps, {
    player: fetched.card?.player ?? body.playerName ?? null,
    year: fetched.card?.year ?? body.cardYear ?? null,
    set: fetched.card?.set ?? body.product ?? null,
  }).filtered;

  const recencyFilteredComps = applyRecencyFilter(fetched.comps);

  // ── Variant match filter — tiered loosening (CF-VARIANT-FILTER-LOOSENING) ─
  // Reject comps that don't match the requested variant BEFORE any quality
  // or anchor math runs. This catches the "Sky Blue base" comps that Card
  // Hedge returns when asked for "Blue Auto" — and prevents them from being
  // averaged into the FMV.
  //
  // Tier ladder (Option B per docs/phase0/variant_filter_loosening_design.md):
  // when strict T0 yields <3 surviving comps, progressively relax the per-
  // comp predicate. Each tier accepts a SUPERSET of the prior tier's pool.
  // First tier with ≥3 comps wins; cap pricing confidence by tier. T3 with
  // <3 → fall through to variant-mismatch short-circuit (legacy behavior
  // preserved as final fallback).
  //
  // Tier matrix (which rejection reasons are TREATED AS "ACCEPT" per tier):
  //   T0 (strict, cap 95): none accepted — all rejections stand
  //   T1 (drop parallel, cap 80): parallel_mismatch + parallel_qualifier_mismatch
  //   T2 (T1 + drop "missing auto", cap 65): + comp_missing_auto
  //   T3 (T2 + drop print-run, cap 55): + print_run_mismatch
  //
  // INVARIANTS:
  //   - comp_has_unwanted_auto stays HARD REJECT at all tiers (Q4 lock).
  //     Base-card requests must never price from auto-pool comps.
  //   - player_name_missing_from_comp stays HARD REJECT at all tiers — we
  //     must not price from a different player's comps even at T3.
  const parsedForGuard = parseCardQuery(cardTitle);
  // Override parsed flags with the explicit body fields when present so the
  // structured /estimate path (which doesn't run the route-level parser) still
  // gets correct variant info.
  if (effectiveIsAuto) parsedForGuard.isAuto = true;
  // "base" means no distinguishing parallel token — comp titles don't contain
  // the word "base", so injecting it here would cause isCompVariantMatch to
  // reject every valid base comp and trigger the variant-mismatch guard.
  if (normalizedParallel && normalizedParallel !== "base") parsedForGuard.parallel = normalizedParallel;
  if (body.cardYear) parsedForGuard.year = body.cardYear;

  // ── Q8'' refinement: Cardsight wrong-card-resolution detection ───────────
  // variantWarning has multiple subcases the original Q8 lock conflated.
  // First refinement (Q8'): short-circuit when "Parallel X not found ...
  // returning cardId only" fires. Empirical sweep (2026-05-26) showed Q8'
  // over-narrowed — it conflated TWO distinct subcases:
  //
  //   (a) WRONG-CARD resolution (Gage Wood Gold Auto): Cardsight maps the
  //       request to a fundamentally different card (Gold Auto numbered
  //       request → base BDC-4 prospect). Comps for the resolved card
  //       are wrong-card; tier ladder inappropriate.
  //   (b) RIGHT-CARD-DIFFERENT-PARALLEL (Trout Wal-Mart Border, Maddux
  //       TIFFANY, John Gil Gold): Cardsight resolves the CORRECT card_id
  //       but the user's requested parallel isn't separately catalogued.
  //       Comps are for the right card's broader pool. Tier ladder T1
  //       rescue is legitimate here.
  //
  // The parallelNotFound warning string is IDENTICAL between (a) and (b),
  // so we need a second signal to discriminate. Q8'' uses the auto-prefix
  // mismatch: when the resolved cardIdentity.number's auto-prefix XORs
  // against the user's effectiveIsAuto, the comp pool is for the wrong
  // SIDE of the auto/base discontinuity (the largest single price
  // discontinuity in card pricing, 5-100×).
  //
  // Q8'' fires only when BOTH signals are present:
  //   - parallelNotFound: Cardsight self-reports "returning cardId only"
  //   - autoPrefixMismatch: resolved cardIdentity.number auto-prefix XOR
  //                         user's effectiveIsAuto
  //
  // Empirically validated 5/5 affected holdings:
  //   Gage Wood (wrong-card):       parallelNotFound=true, prefixMismatch=true (BDC-4 base; user wanted auto)  → Q8'' fires
  //   Trout WMB (right-card):       parallelNotFound=true, prefixMismatch=false (US175 base; user wanted base) → ladder applies
  //   Maddux TIFFANY (right-card):  parallelNotFound=true, prefixMismatch=false (70T base;   user wanted base) → ladder applies
  //   John Gil Gold (right-card):   parallelNotFound=true, prefixMismatch=false (BCP-172 base; user wanted base) → ladder applies
  //   Bonemer Blue (wrong-card):    parallelNotFound=true, prefixMismatch=true (CPA-CBO auto; user wanted base) → Q8'' fires
  //
  // canonical "parallel not found" warning emitted by resolveCardId in
  // cardsight.mapper.ts:457. AUTO_PREFIX_RE token list mirrors the
  // canonical SKU prefixes from cardQueryParser.ts:319 (CPA / BCPA / BPA /
  // BCRRA / BCRA / CRA / BSA / BCA / TCA / USA / BBPA / BSPA / AU / FA /
  // ROA) anchored at start of the card-number string.
  const variantWarningTokens = (fetched.variantWarning ?? []).map((t) => t.toLowerCase());
  const parallelNotFound = variantWarningTokens.some((t) =>
    /returning\s+card[Ii]d\s+only/i.test(t)
  );
  const CARD_NUMBER_AUTO_PREFIX_RE =
    /^(cpa|bcpa|bpa|bcrra|bcra|cra|bsa|bca|tca|usa|bbpa|bspa|au|fa|roa)([-_\s]|$)/i;
  const resolvedCardNumber = (fetched.card?.number ?? "").trim();
  const resolvedIsAuto = CARD_NUMBER_AUTO_PREFIX_RE.test(resolvedCardNumber);
  const autoPrefixMismatch = effectiveIsAuto !== resolvedIsAuto;
  const cardsightWrongCardResolution = parallelNotFound && autoPrefixMismatch;

  // CF-VARIANT-FILTER-BACKTEST — tier ladder kill switch.
  // env VARIANT_TIER_LADDER_ENABLED=false → bypass ladder globally.
  // Per-request header override (options.tierLadderDisabledByHeader) is
  // authorized by the route handler (admin-testing-hobbyiq user OR
  // NODE_ENV !== production); this layer just trusts the flag.
  const tierLadderEnabledFromEnv =
    String(process.env.VARIANT_TIER_LADDER_ENABLED ?? "").trim().toLowerCase() !== "false";
  const tierLadderEffectivelyEnabled =
    tierLadderEnabledFromEnv && !options.tierLadderDisabledByHeader;
  const tierLadderBypassReason = !tierLadderEnabledFromEnv
    ? "env_disabled"
    : options.tierLadderDisabledByHeader
    ? "header_override"
    : null;

  let tierResult;
  if (cardsightWrongCardResolution) {
    // Skip tier ladder entirely. Use synthetic result: chosenTier=T0
    // (so confidence cap stays at 95 for the surfaced path), variantFiltered
    // empty, everythingFilteredOut=true so the short-circuit below fires.
    console.warn(
      `[compiq.computeEstimate] Q8'' wrong-card short-circuit: parallelNotFound=true autoPrefixMismatch=true (effectiveIsAuto=${effectiveIsAuto} resolvedCardNumber="${resolvedCardNumber}" resolvedIsAuto=${resolvedIsAuto}) — skipping tier ladder`
    );
    tierResult = {
      chosenTier: "T0" as VariantStrictness,
      variantFiltered: [] as typeof recencyFilteredComps,
      variantExclusionReasons: { cardsight_wrong_card: recencyFilteredComps.length },
      variantExcludedCount: recencyFilteredComps.length,
      tierLadderTrace: { T0: 0, T1: 0, T2: 0, T3: 0 } as Record<VariantStrictness, number>,
      everythingFilteredOut: true,
    };
  } else if (!tierLadderEffectivelyEnabled) {
    // CF-VARIANT-FILTER-BACKTEST: ladder bypass. Run only strict T0; if
    // T0 yields <VARIANT_TIER_MIN_COMPS and the request had variant
    // attributes, surface as variant-mismatch (legacy pre-tier-ladder
    // behavior). This is the "ladder disabled" arm of the paired backtest.
    console.warn(
      `[compiq.computeEstimate] tier ladder BYPASSED (${tierLadderBypassReason}). Running T0-only.`
    );
    const t0 = runVariantTierLadder(recencyFilteredComps, parsedForGuard);
    // Synthesize T0-only result: keep T0 trace count; zero out higher tiers;
    // flag everythingFilteredOut when T0 yielded <3 AND user requested
    // a variant attribute (matches the pre-ladder short-circuit semantics).
    const t0Count = t0.tierLadderTrace.T0;
    const hadVariantRequest =
      parsedForGuard.isAuto || Boolean(parsedForGuard.parallel);
    const t0Filtered: typeof recencyFilteredComps = [];
    const t0Reasons: Record<string, number> = {};
    // Re-classify with T0 strictly so variantFiltered reflects T0-only.
    for (const c of recencyFilteredComps) {
      const allReasons = getCompVariantMismatchReasons(c.title, parsedForGuard);
      if (allReasons.length === 0) {
        t0Filtered.push(c);
      } else {
        const key = allReasons[0];
        t0Reasons[key] = (t0Reasons[key] ?? 0) + 1;
      }
    }
    const t0EverythingFilteredOut =
      recencyFilteredComps.length > 0 &&
      t0Filtered.length < VARIANT_TIER_MIN_COMPS &&
      hadVariantRequest;
    tierResult = {
      chosenTier: "T0" as VariantStrictness,
      variantFiltered: t0Filtered,
      variantExclusionReasons: t0Reasons,
      variantExcludedCount: recencyFilteredComps.length - t0Filtered.length,
      tierLadderTrace: { T0: t0Count, T1: 0, T2: 0, T3: 0 } as Record<VariantStrictness, number>,
      everythingFilteredOut: t0EverythingFilteredOut,
    };
  } else if (
    fetched.priceSourceInternal === "title-matched-parallel"
    || fetched.priceSourceInternal === "title-match-low-sample"
  ) {
    // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): bypass the tier ladder's
    // VARIANT_TIER_MIN_COMPS=3 floor for title-match-recovered pools.
    // The recovery (applyParallelTitleMatch + sibling-registry guard +
    // span-scoped finish-vocab backstop) has already done the variant-
    // correctness check the tier ladder duplicates — running both layers
    // collapses 1-2 comp recovery pools to 0 even when they're cleanly
    // parallel-isolated. Synthesize a T0 tierResult: everything passes,
    // confidence calibration handles the thin-pool ceiling downstream
    // (calibrateConfidence's n<3 → 45% cap is the right surface).
    //
    // This branch fires ONLY for the two TITLE-MATCH internal sources;
    // cardsight-parallel-id (the actual Cardsight tag delivered) falls
    // through to the normal ladder because that path didn't filter
    // titles itself.
    console.log(
      `[compiq.computeEstimate] recovery-isolated pool (${fetched.priceSourceInternal}); bypassing tier ladder count-floor — pool size=${recencyFilteredComps.length}`,
    );
    tierResult = {
      chosenTier: "T0" as VariantStrictness,
      variantFiltered: recencyFilteredComps,
      variantExclusionReasons: {},
      variantExcludedCount: 0,
      tierLadderTrace: {
        T0: recencyFilteredComps.length,
        T1: 0,
        T2: 0,
        T3: 0,
      } as Record<VariantStrictness, number>,
      everythingFilteredOut: false,
    };
  } else if (
    fetched.vendor === "cardhedge" &&
    fetched.chTrustReason !== undefined &&
    recencyFilteredComps.length > 0
  ) {
    // CF-CH-THIN-COMP-PRIMARY (2026-06-26): CardHedge resolved a parallel-
    // specific chCardId via the canonicalized bridge (CF-ENGINE-PARALLEL-
    // CANONICALIZE). Every comp in fetched.comps is for THIS parallel by
    // construction — the bridge's card-match already did the variant-
    // correctness check the tier ladder duplicates. Running both layers
    // collapses 1-2 comp trusted-CH pools to 0 even when they're cleanly
    // parallel-isolated.
    //
    // Mirrors the CF-PINNED-PARALLEL-RECOVERY pattern above for title-
    // match recovery pools: synthesize a passing T0 tierResult; downstream
    // confidence calibration (calibrateConfidence's n<3 → 45% cap)
    // carries the thin-pool disclosure. The n==1 case is rendered as
    // "Last sold $X via 1 comp" via the cardhedge-last-sale estimateSource
    // emitted in the insufficient branch below.
    //
    // chTrustReason !== undefined gates this to the trust-guard-passed
    // path (prices_by_card_honest | title_cohesion_strong). If a future
    // value is added to the union, this branch picks it up automatically.
    console.log(
      `[compiq.computeEstimate] CH-trusted pool (chTrustReason=${fetched.chTrustReason}); bypassing tier ladder count-floor — pool size=${recencyFilteredComps.length}`,
    );
    tierResult = {
      chosenTier: "T0" as VariantStrictness,
      variantFiltered: recencyFilteredComps,
      variantExclusionReasons: {},
      variantExcludedCount: 0,
      tierLadderTrace: {
        T0: recencyFilteredComps.length,
        T1: 0,
        T2: 0,
        T3: 0,
      } as Record<VariantStrictness, number>,
      everythingFilteredOut: false,
    };
  } else {
    tierResult = runVariantTierLadder(recencyFilteredComps, parsedForGuard);
  }

  const {
    chosenTier,
    variantFiltered,
    variantExclusionReasons,
    variantExcludedCount,
    tierLadderTrace,
    everythingFilteredOut,
  } = tierResult;

  if (variantExcludedCount > 0 || chosenTier !== "T0") {
    console.log(
      `[compiq.computeEstimate] variant tier=${chosenTier} excluded ${variantExcludedCount}/${recencyFilteredComps.length} comps: ${JSON.stringify(variantExclusionReasons)} trace=${JSON.stringify(tierLadderTrace)}`
    );
  }

  // Substitute the variant-filtered pool for downstream stages when at least
  // some comps survived. Otherwise keep the original pool — the
  // dataSufficiency / variant-mismatch guard logic below handles the empty
  // case explicitly.
  const compsAfterVariantFilter = variantFiltered.length > 0 ? variantFiltered : recencyFilteredComps;

  // ── Variant-mismatch short-circuit (final fallback) ──────────────────────
  // Per Q8 lock (refined as Q8'): tier ladder applies to BOTH
  // everythingFilteredOut AND auto/serial variantWarning paths. The ladder
  // tries T0→T3 progressively; we only short-circuit when T3 also yields <3
  // comps OR Cardsight self-reported wrong-card resolution (Q8' above).
  if (everythingFilteredOut) {
    // CF-DECOUPLE (2026-06-21): null-safe product classification.
    // CF-DECOUPLE-2 (2026-06-21): null-safe subset normalization via
    // normalizeCardsightSetName(fetched.card.set). Replaces the previous
    // hardcoded "Chrome Prospect Autographs" — Bowman-non-CPA holdings
    // (flagship/Sterling/Platinum) used to mis-route to a CPA lookup;
    // now they normalize to their actual subset (when curated) or null
    // (when ambiguous/unmappable → mechanism1 skipped). Same null-safe
    // pattern as the product classifier.
    const subjectProduct = classifyBowmanFamilyProduct(body.product);
    const subjectSubset: BowmanFamilySubset | null = normalizeCardsightSetName(fetched.card?.set ?? null);
    const mechanism1: MultiplierAnchoredPredictedPriceResult = (subjectProduct === null || subjectSubset === null)
      ? NULL_MECHANISM1_RESULT
      : computeMultiplierAnchoredPredictedPrice({
          subject: {
            playerName: body.playerName ?? fetched.card?.player ?? "",
            year: Number(body.cardYear ?? fetched.card?.year ?? 0),
            product: subjectProduct,
            subset: subjectSubset,
            parallelName: normalizedParallel ?? body.parallel ?? "",
            isAutograph: effectiveIsAuto,
          },
          comps: fetched.comps.map((c) => ({
            title: c.title,
            price: c.price,
            soldDate: c.soldDate,
          })),
        });

    // CF-X (2026-06-20): when mechanism1 produces a multiplier-anchored
    // predicted price, surface estimated-tier fields so the writer
    // (autoPriceHolding / repriceHoldingsForUser) routes the holding into
    // Phase 5's estimated bucket — identical wire shape to CF-A(a)'s T3
    // base-auto-floor rebucket. estimateBasis flips on the subject row's
    // provenance flag so iOS can render the "provisional" badge for
    // sibling-provisional rows (X-Fractor rainbow today).
    //
    // CF-BUILD-B (2026-06-21): when mechanism1 returns null (curated row
    // missing OR pool can't anchor — Hartman's shape), try Build B as a
    // base-anchored fallback. Build B is provenance-gated to empirical
    // baseRelativePremium rows — ships DORMANT (zero rows carry the new
    // field at ship), activates per-tier as the worksheet PRs land.
    let m1HasPrice = mechanism1.predictedPrice !== null;
    let m1IsProvisional =
      mechanism1.predictedPriceAttribution.subjectProvenance === "sibling_provisional";
    let m1EstimatedValue: number | null = m1HasPrice ? mechanism1.predictedPrice : null;
    let m1EstimateLow: number | null = m1HasPrice ? (mechanism1.predictedPriceRange?.low ?? null) : null;
    let m1EstimateHigh: number | null = m1HasPrice ? (mechanism1.predictedPriceRange?.high ?? null) : null;
    let m1EstimateBasis: string | null = m1HasPrice
      ? (m1IsProvisional ? "multiplier_provisional" : "multiplier")
      : null;
    let m1EstimateConfidence:
      | "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null =
      m1HasPrice ? "rough" : null;
    let m1ValuationStatus: "observed" | "estimated" | null =
      m1HasPrice ? "estimated" : null;

    // CF-BUILD-B fallback: when mechanism1 yielded no price AND the
    // holding is Bowman-family (the classifier returned non-null above),
    // try Build B against the curated baseRelativePremium row. Dormant
    // until the worksheet PRs land empirical values + sampleBaseRange.
    // CF-DECOUPLE-2: same null-safe subjectSubset as mechanism1 above.
    let buildBResult: BaseAnchoredFmvResult | null = null;
    if (!m1HasPrice && subjectProduct !== null && subjectSubset !== null) {
      buildBResult = computeBaseAnchoredParallelFMV({
        subject: {
          playerName: body.playerName ?? fetched.card?.player ?? "",
          year: Number(body.cardYear ?? fetched.card?.year ?? 0),
          product: subjectProduct,
          subset: subjectSubset,
          parallelName: normalizedParallel ?? body.parallel ?? "",
        },
        comps: fetched.comps.map((c) => ({ title: c.title, price: c.price })),
      });
      if (buildBResult.isEstimate) {
        m1HasPrice = true;
        m1IsProvisional = false; // Build B requires empirical provenance
        m1EstimatedValue = buildBResult.estimatedValue;
        m1EstimateLow = buildBResult.estimateLow;
        m1EstimateHigh = buildBResult.estimateHigh;
        m1EstimateBasis = buildBResult.estimateBasis;
        m1EstimateConfidence = buildBResult.confidence;
        m1ValuationStatus = "estimated";
      }
    }

    const guardReasons: string[] = [];
    if (variantWarningTokens.length > 0) guardReasons.push(...variantWarningTokens);
    if (everythingFilteredOut) {
      const detail = Object.entries(variantExclusionReasons)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ");
      if (cardsightWrongCardResolution) {
        // Q8'' refinement: Cardsight resolved wrong card (parallelNotFound
        // + autoPrefixMismatch). Tier ladder deliberately skipped, not
        // exhausted. Different failure mode, different log phrasing.
        guardReasons.push(
          `Cardsight wrong-card resolution detected (parallelNotFound + autoPrefixMismatch: effectiveIsAuto=${effectiveIsAuto} resolvedCardNumber="${resolvedCardNumber}"); tier ladder bypassed`
        );
      } else {
        // CF-VARIANT-FILTER-LOOSENING: tier ladder tried T0→T3 and the
        // loosest tier still yielded <VARIANT_TIER_MIN_COMPS comps. Surface
        // the trace so the iOS verdict + log line show why even the
        // broadest pool couldn't satisfy the threshold.
        guardReasons.push(
          `tier ladder exhausted at T3 (trace=${JSON.stringify(tierLadderTrace)}; rejections: ${detail || "n/a"})`
        );
      }
    }
    const missing = guardReasons.join("; ") || "variant tokens";
    console.warn(
      `[compiq.computeEstimate] variant-mismatch guard tripped: query="${cardTitle}" reason="${missing}"`
    );

    // CF-PREDICTION-CORPUS-EMISSION-COVERAGE: emit on variant-mismatch.
    // fmvMechanism="unavailable" (FMV null); predicted comes from
    // mechanism1 (multiplier-anchored Bowman-family fallback) and is null
    // for non-Bowman cards — override mechanism to "unavailable" in that
    // case so the corpus stays honest about which rows have a real
    // forward prediction.
    emitPredictionToCorpus({
      cardIdentity: fetched.card ? { card_id: fetched.card.card_id ?? null } : null,
      body,
      fairMarketValue: null,
      fmvMechanism: "unavailable",
      predictedPrice: mechanism1.predictedPrice,
      predictedPriceRange: mechanism1.predictedPriceRange,
      predictedPriceMechanism:
        mechanism1.predictedPrice !== null
          ? mechanism1.predictedPriceAttribution.mechanism
          : "unavailable",
      compsUsed: compsAfterVariantFilter.length,
      callContext,
    });

    return {
      cardTitle,
      verdict: `No comps found for this exact variant (missing: ${missing}). Card Hedge doesn't have sold data for this card yet.`,
      action: "Hold",
      dealScore: 0,
      quickSaleValue: null,
      fairMarketValue: null,
      fairMarketValueLow: null,
      fairMarketValueHigh: null,
      marketValue: null,
      predictedPrice: mechanism1.predictedPrice,
      predictedPriceRange: mechanism1.predictedPriceRange,
      predictedPriceAttribution: mechanism1.predictedPriceAttribution,
      premiumValue: null,
      explanation: [
        `Requested ${effectiveIsAuto ? "autograph " : ""}variant not found in Card Hedge's sold database.`,
        `Closest match on file: ${fetched.card?.variant ?? "unknown"} (missing: ${missing}).`,
        "Will retry automatically once comps are recorded.",
      ],
      marketDNA: {
        demand: "Unknown",
        speed: "Unknown",
        risk: "High",
        trend: "Flat",
        marketCondition: "Variant Not Found",
      },
      marketRegime: {
        regime: "illiquid",
        volatilityPct: 0,
        slopePctPerComp: 0,
        confidence: 0.2,
        note: "Variant mismatch — no usable comps for the requested card.",
      },
      normalization: {
        parallelInput: body.parallel ?? null,
        parallelCanonical: normalizedParallel ?? null,
        gradeCompanyInput: body.gradeCompany ?? null,
        gradeCompanyCanonical: normalizedGradeCompany ?? null,
      },
      confidence: { pricingConfidence: 0, liquidityConfidence: 0, timingConfidence: 0 },
      exitStrategy: {
        recommendedMethod: "wait",
        expectedDaysToSell: null,
        timingRecommendation: "Wait for the variant's first comps to land in Card Hedge.",
      },
      freshness: { status: "Needs refresh" as const, lastUpdated: null },
      pricingAnalytics: null,
      estimate: null,
      // compsUsed = 0 because none of the fetched comps matched the
      // requested variant (so they can't price it). compsAvailable surfaces
      // the raw fetched count so the iOS UI can still say
      // "10 comps on file for this card — none match your variant" instead
      // of misleadingly showing 0.
      compsUsed: 0,
      compsAvailable: fetched.comps.length,
      cardIdentity: fetched.card,
      // Even though these comps didn't match the requested variant, surface
      // them so the iOS UI can show the user what Card Hedge *does* have on
      // file for this card — labeled "variant mismatch" so it's clear they
      // weren't used for pricing.
      recentComps: fetched.comps
        .slice()
        .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
        .map((c) => ({
          price: c.price,
          title: c.title,
          soldDate: c.soldDate,
          grade: formatGradeLabel(c.title),
          saleType: saleTypeFromListingType(c.listingType),
          imageUrl: c.imageUrl ?? undefined,
        })),
      gradeUsed: cardHedgeGrade,
      source: "variant-mismatch",
      daysSinceNewestComp: null,
      // CF-LASTSALE-SCAFFOLD (2026-06-10): variant-mismatch surfaces
      // fetched.comps as wrong-variant context only — those records are
      // for a different card, so deriving a "last sale of this card"
      // from them would be misleading. iOS treats variant-mismatch as
      // a separate state and shouldn't render last-sale prose here.
      lastSale: null,
      estimateSource: null,
      // CF-X (2026-06-20): when the multiplier-anchored mechanism returns
      // a non-null predicted price (subject's parallel is curated),
      // emit estimated-tier fields so the writer routes the holding into
      // Phase 5's estimated bucket — identical wire shape to CF-A(a)'s
      // T3 rebucket. When mechanism1.predictedPrice is null, this entire
      // block emits null/observed (legacy variant-mismatch behavior
      // preserved). The legacy estimateRange field stays null in both
      // cases (it's the last-sale fallback's range; orthogonal to the
      // multiplier-anchored estimateLow/High emitted above).
      estimatedValue: m1EstimatedValue,
      estimateRange: null,
      estimateLow: m1EstimateLow,
      estimateHigh: m1EstimateHigh,
      estimateBasis: m1EstimateBasis,
      estimateConfidence: m1EstimateConfidence,
      isEstimate: m1HasPrice,
      valuationStatus: m1ValuationStatus,
      variantWarning: fetched.variantWarning,
      // CF-VARIANT-MISMATCH-PRICESOURCE-PARITY (2026-05-28): propagate
      // the router's parallel-resolution attribution onto the variant-
      // mismatch response. The four fields describe HOW the comp POOL
      // was constructed by the router (parallel-id / title-matched /
      // unified) — that attribution remains accurate when the variant
      // filter rejects the pool downstream. Variant rejection itself
      // is communicated via `source: "variant-mismatch"` + variantWarning
      // (different axis). Parity with the successful path's surface at
      // line 2796-2799 unblocks iOS/sweeps/backtests distinguishing
      // variant-mismatch failures from other no-FMV outcomes.
      priceSource: fetched.priceSource ?? null,
      priceSourceInternal: fetched.priceSourceInternal ?? null,
      parallelMatchFilteredCount: fetched.parallelMatchFilteredCount ?? null,
      parallelMatchUnifiedCount: fetched.parallelMatchUnifiedCount ?? null,
      compQuality: {
        totalComps: 0,
        usedComps: 0,
        excluded: recencyFilteredComps.length,
        reasons: variantExclusionReasons,
        // CF-VARIANT-FILTER-LOOSENING: surface tier metadata on the
        // variant-mismatch fallback path too so iOS / sweeps / backtests
        // can distinguish "tier ladder exhausted" from "Cardsight
        // wrong-card resolution short-circuit" (Q8').
        variantStrictness: chosenTier,
        tierLadderTrace,
      },
      crossParallelAnchor: null,
      effectiveFmv: null,
      dataSufficiency: {
        sufficient: false,
        level: "none" as const,
        message: `Variant not found (missing: ${missing}).`,
      },
    };
  }

  // ── Comp Quality Filter (Pricing Accuracy — Improvement 2) ──────────────
  // Strip lot/damaged/altered listings and 2.5σ price outliers BEFORE any
  // anchor/median calculation. Surface counts in the response so the iOS
  // confidence row can say "Based on 8 of 12 sales (4 removed for quality)".
  const qualityFilter = applyCompQualityFilter(compsAfterVariantFilter, {
    player: fetched.card?.player ?? body.playerName ?? null,
    year: fetched.card?.year ?? body.cardYear ?? null,
    set: fetched.card?.set ?? body.product ?? null,
  });
  const rawComps = qualityFilter.filtered;
  const compQualityInfo = {
    totalComps: recencyFilteredComps.length,
    usedComps: qualityFilter.filtered.length,
    excluded: qualityFilter.excluded + variantExcludedCount,
    reasons: {
      ...qualityFilter.reasons,
      ...(variantExcludedCount > 0 ? { variant_mismatch: variantExcludedCount } : {}),
    },
    // CF-VARIANT-FILTER-LOOSENING: surface the tier the variant ladder
    // selected. T0 is the strict default; T1/T2/T3 indicate the pricing
    // pool was widened to find ≥3 surviving comps, with a capped
    // confidence per VARIANT_TIER_CAP. Read by iOS (informational) and
    // by tests asserting tier-transition behavior.
    variantStrictness: chosenTier,
    tierLadderTrace,
  };
  const cardIdentity = fetched.card;

  // CF-TREND-EXTRAPOLATED (2026-06-10): fire the player-in-set momentum
  // fetch EARLY so it's available before the insufficient short-circuit
  // (which uses it to optionally trend-extrapolate the lastSale into an
  // estimatedValue + estimateRange). On the success path, the same
  // resolved value flows downstream — the Promise.all at the prior
  // fetch site is collapsed to fetch sibling-pool only.
  //
  // Variable names re-used by the downstream `productForSignals`/
  // `cardYearForSignals` declarations were folded into this single
  // upstream declaration to avoid duplication and keep the trend's
  // sub-market scope (player + release + year) defined exactly once.
  const playerNameForSignals =
    cardIdentity?.player?.trim() || body.playerName?.trim() || "";
  const productForSignals =
    cardIdentity?.release?.trim()
    || cardIdentity?.set?.trim()
    || body.product?.trim()
    || "";
  const cardYearForSignals: number | undefined =
    typeof cardIdentity?.year === "number" && cardIdentity.year > 0
      ? cardIdentity.year
      : typeof body.cardYear === "number" && body.cardYear > 0
      ? body.cardYear
      : undefined;
  const playerMomentum = await (playerNameForSignals && productForSignals
    ? fetchPlayerInSetMomentum({
        playerName: playerNameForSignals,
        product: productForSignals,
        cardYear: cardYearForSignals,
      }).catch(() => null)
    : Promise.resolve(null));

  // --- Thin-data short-circuit ----------------------------------------------
  // CompIQ Anti-Yesterday Rule + "never anchor to a single stale sale".
  // Policy (relaxed for rare autographs / numbered parallels which sell less
  // often than base cards):
  //   - 0 comps              → insufficient (always)
  //   - 1 comp, <=14 days    → allow (priced with thinMarket flag downstream)
  //   - 1 comp, >14 days     → insufficient
  //   - 2 comps, newest <=180 days → allow (flag stale)
  //   - 2 comps, newest >180 days  → insufficient
  //   - 3+ comps, newest <=365 days → allow (flag stale if >60d)
  //   - 3+ comps, newest >365 days  → insufficient
  // Rationale: a low-pop prospect auto may only print 2-4 sales/year; refusing
  // to price it because the most recent sale was 90 days ago is worse than
  // returning a confidence-capped estimate with a `stale_comps` risk flag.
  // CF-LASTSALE-SCAFFOLD (2026-06-10): pick the single max-by-date record
  // from the post-(grade + parallel) UNWINDOWED pool via the exported
  // helper. lastSale + daysSinceNewest derive from the SAME record so
  // they can't disagree on edge cases (duplicate timestamps, etc.).
  const lastSalePick = pickLastSale(fetched.comps);
  const newestTs = lastSalePick ? Date.parse(lastSalePick.soldDate) || 0 : 0;
  const daysSinceNewest = newestTs > 0 ? Math.floor((Date.now() - newestTs) / (24 * 3600 * 1000)) : null;
  const lastSale = lastSalePick;

  const compCount = fetched.comps.length;
  // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): treat title-match-recovered
  // pools as "by definition recent enough" — the recovery isolated a
  // CLEAN parallel-specific sub-market via title tokens + sibling guard +
  // span-scoped finish-vocab backstop. For a rare /150 parallel a 30-day-
  // old sale is the truth; the age-based insufficient floor exists to
  // protect against "single stale base-mixed sale anchoring a generic
  // request," which doesn't apply to the recovery branch. The display
  // disclosure (dataSufficiency.level + priceSource="approximate") and
  // the corpus guardrail (low-sample → fmv=null at emit) carry the
  // confidence story; the on-screen FMV is honest for what it is.
  // compCount === 0 still nulls (recovery returned nothing usable).
  //
  // CF-PINNED-PARALLEL-RECOVERY (2026-06-11) follow-up: ONLY
  // title-matched-parallel (>=3) keeps the observed bypass. The
  // low-sample variant (<3 records) is INTENTIONALLY left to fall into
  // the insufficient short-circuit so it routes through the
  // trend-extrapolation path (repriceTrendExtrapolated → estimateSource
  // = "trend-extrapolated"|"last-sale" + estimatedValue + estimateRange
  // + marketValue/fairMarketValue null). Per the forward-looking value
  // model, a thin recovered parallel reads as an ESTIMATED next-sale
  // price, not a rear-view observed market value — same surface every
  // other thin card uses. iOS' value-spectrum render (7f0ec9b, merged
  // 2026-06-11) decodes the spectrum fields and renders the hedged
  // "Estimated next sale ~$X" treatment instead of the bold "Market
  // value" headline. Training exclusion is structural via
  // fairMarketValue=null in the existing insufficient-branch corpus
  // emit.
  const isRecoveryIsolatedPoolForCount =
    fetched.priceSourceInternal === "title-matched-parallel";
  // CF-CH-THIN-COMP-FRESH-SALE (2026-06-26): force trusted CH n=1 into the
  // insufficient branch REGARDLESS of sale age. The prior CF
  // (CF-CH-THIN-COMP-PRIMARY) added the "cardhedge-last-sale" split INSIDE
  // the insufficient branch, but the existing age rule "1 comp, <=14 days
  // → allow" routes fresh single CH sales (the prod case at 7 days old)
  // straight to the main pipeline — which can't FMV from n=1 and emits
  // null, leaving estimateSource=null and the holding marked "Low
  // confidence." Routing trusted CH n=1 to the insufficient branch lets
  // the cardhedge-last-sale ladder arm pick it up and render "Last sold
  // $X via 1 comp." Mirrors the trust-guard gate (chTrustReason !==
  // undefined) used by the variant-mismatch bypass + the estimateSource
  // split above; same trusted-CH detection across the three sites.
  const isChTrustedSingleSaleForce =
    fetched.vendor === "cardhedge" &&
    fetched.chTrustReason !== undefined &&
    compCount === 1;
  const insufficient =
    compCount === 0
    || isChTrustedSingleSaleForce
    || (!isRecoveryIsolatedPoolForCount && (
      (compCount === 1 && (daysSinceNewest == null || daysSinceNewest > 14)) ||
      (compCount === 2 && (daysSinceNewest == null || daysSinceNewest > 180)) ||
      (compCount >= 3 && (daysSinceNewest == null || daysSinceNewest > 365))
    ));

  if (insufficient) {
    // CF-DECOUPLE (2026-06-21): null-safe product classification. This site
    // never got CF-X's "Bowman" preservation — pre-CF-DECOUPLE it force-fit
    // EVEN bare "Bowman" flagship to "Bowman Chrome" (the worst of the 3
    // clamp sites). Post-classifier: bare "Bowman" routes to "Bowman" and
    // matches the correct curated row when one exists. Non-Bowman holdings
    // skip mechanism1 entirely.
    // CF-DECOUPLE-2 (2026-06-21): null-safe subset normalization. When
    // fetched.card.set normalizes to null (ambiguous or unmappable),
    // mechanism1 is skipped — no wrong-subset CPA route.
    const subjectProduct = classifyBowmanFamilyProduct(body.product);
    const subjectSubset: BowmanFamilySubset | null = normalizeCardsightSetName(fetched.card?.set ?? null);
    const mechanism1: MultiplierAnchoredPredictedPriceResult = (subjectProduct === null || subjectSubset === null)
      ? NULL_MECHANISM1_RESULT
      : computeMultiplierAnchoredPredictedPrice({
          subject: {
            playerName: body.playerName ?? fetched.card?.player ?? "",
            year: Number(body.cardYear ?? fetched.card?.year ?? 0),
            product: subjectProduct,
            subset: subjectSubset,
            parallelName: normalizedParallel ?? body.parallel ?? "",
            isAutograph: effectiveIsAuto,
          },
          comps: fetched.comps.map((c) => ({
            title: c.title,
            price: c.price,
            soldDate: c.soldDate,
          })),
        });

    const ageNote =
      daysSinceNewest != null
        ? `last comp was ${daysSinceNewest} days ago`
        : "no comps on file";
    const verdict = `Insufficient recent comps — ${ageNote}. Refine the query or wait for fresh sales.`;
    console.warn(
      `[compiq.computeEstimate] thin-data short-circuit: comps=${fetched.comps.length} daysSinceNewest=${daysSinceNewest} query="${cardTitle}"`
    );

    // CF-THIN-CARD-FULL-DETAIL-PARITY (2026-06-12): scratch vars to carry
    // the thin path's overall-trend signal onto the no-recent-comps return.
    // Computed inside the `if (cardIdentity)` block below (free piggyback on
    // the sibling-pool rescue's existing fetchSiblingSales). Hoisted here so
    // they survive past that block's closing brace and reach the return.
    //
    // GUARD: these feed the OVERALL TREND section's direction/context only.
    // They never overwrite the card's last-sale value, never flip the FMV-
    // null display-not-train flag, and never produce an estimatedValue.
    // (Repricing of the last sale → estimatedValue is still gated on
    // playerMomentum × repriceTrendExtrapolated below — unchanged.)
    let thinBranchSiblingPool: SiblingSalesPool = { siblingCardIds: [], sales: [] };
    let thinBranchBroaderTrend: BroaderTrend | null = null;
    let thinBranchTrendIQ: TrendIQResult | null = null;

    // CF-AUTOPRICE-SIBLING-DISCOVERY-WIRING (2026-05-26):
    // Before returning "no-recent-comps", try the sibling-pool rescue path.
    // Approach A pattern from CF-CARDSIGHT-SIBLING-DISCOVERY (e2d5864):
    // when direct Cardsight returns thin comps for a variant card, the
    // sibling pool (same player + product + year, different parallels)
    // often has dozens of sales we can use as a broader proxy for pricing.
    //
    // Variant filters (parallel/auto/grade) are deliberately NOT applied to
    // the sibling pool — siblings are different cards by construction;
    // narrowing them by exact-variant tokens defeats the rescue purpose.
    // The verdict text "Estimated from similar cards — variant unverified"
    // communicates the source clearly to downstream consumers.
    //
    // Confidence capped at 65 (vs direct-match's 95) reflects the
    // lower-precision nature of sibling-derived pricing. Variable confidence
    // based on sibling-pool quality is a follow-up CF.
    if (cardIdentity) {
      let siblingPool: SiblingSalesPool = { siblingCardIds: [], sales: [] };
      try {
        siblingPool = await fetchSiblingSales(cardIdentity, cardHedgeGrade);
      } catch (err) {
        console.warn(
          `[compiq.computeEstimate] sibling-pool rescue: fetchSiblingSales threw — falling through to "no-recent-comps": ${(err as Error)?.message ?? err}`
        );
      }
      thinBranchSiblingPool = siblingPool;

      // CF-THIN-CARD-FULL-DETAIL-PARITY (2026-06-12): compute broaderTrend +
      // trendIQ NOW so the no-recent-comps return shape matches the live
      // path. Free piggyback on the siblingPool we just fetched. Does NOT
      // affect the rescue path below — that path has its own self-contained
      // trendIQ compute at L3411-3424 with playerMomentum hardcoded to null
      // (its own design); we don't touch it. Live path (L3732+) untouched.
      //
      // playerMomentum is the hoisted per-(player, release, year) momentum
      // from L2957 (CF-TREND-EXTRAPOLATED). cardTrajectory typically nulls
      // on this branch (the recovery pool is by definition thin —
      // computeCardTrajectory needs ≥2 in 0-14d AND ≥2 in 15-45d on
      // trendCleanComps). segmentTrajectory load-bears off siblingPool.
      // Coverage degrades honestly to "insufficient" when all three are
      // null → flat composite + impliedPct 0; iOS' "Holding steady, no
      // clear direction" text fills that surface (per Phase 2 spec).
      try {
        thinBranchBroaderTrend = await fetchBroaderTrend(
          cardIdentity,
          cardHedgeGrade,
          trendCleanComps,
          siblingPool,
        );
      } catch (err) {
        console.warn(
          `[compiq.computeEstimate] thin-path fetchBroaderTrend threw — leaving broaderTrend=null: ${(err as Error)?.message ?? err}`,
        );
      }
      try {
        const cardTrajectory = computeCardTrajectory(
          trendCleanComps.map((c) => ({ price: c.price, soldDate: c.soldDate })),
        );
        const segR = computeSegmentTrajectoryAndFull(siblingPool, newestTs);
        thinBranchTrendIQ = computeTrendIQ({
          playerMomentum,
          cardTrajectory,
          segmentTrajectory: segR.component,
        });
        console.log(`[thin-path] ${formatTrendIQLogLine(thinBranchTrendIQ)}`);
      } catch (err) {
        console.warn(
          `[compiq.computeEstimate] thin-path computeTrendIQ threw — leaving trendIQ=null: ${(err as Error)?.message ?? err}`,
        );
      }

      // CF-CH-THIN-COMP-RESCUE-BYPASS (2026-06-26): when trusted CH n=1
      // routed into the insufficient branch (CF-CH-THIN-COMP-FRESH-SALE),
      // the single CH sale on the parallel-specific chCardId IS the
      // authoritative price for THIS card. Combining it with the sibling
      // pool (sales from OTHER parallels of the same player+product+year)
      // would override the honest "Last sold $X via 1 comp" headline with
      // a cross-card weighted median — the 2026-06-26 18:38Z prod trace
      // surfaced this as $8.50 on the Hartman BXF /150 holding. Skip the
      // rescue so the cardhedge-last-sale ladder arm at ~L4250 fires.
      //
      // Trust gate is the same `isChTrustedSingleSaleForce` used by the
      // variant-mismatch bypass and the insufficient-predicate force —
      // one consistent trust-guarded CH n=1 detection across all sites.
      // Non-CH cases (CS-served, CH untrusted) keep the existing sibling-
      // pool rescue verbatim.
      //
      // CF-SIBLING-POOL-SKIP-FOR-AUTOS (2026-07-04): when the target's
      // card_number is a Bowman-family autograph prefix (CPA-, HSA-, etc.),
      // the sibling pool is drawn from the ENTIRE player+product+year
      // segment — hundreds of base commons at $2-8 each drown out the
      // handful of matching parallel-auto sales at $200-1500. The 2026-07-03
      // Hartman LogoFractor (CPA-EHA) trace showed 315 sibling sales
      // producing a weighted median of $9 for a card CH catalogs at $1038.
      // Skip the rescue for auto targets and let applyAutoProjectionFallbacks
      // (compiq.routes.ts) handle it — Layer 4 there filters siblings to
      // auto-prefix-only and applies parallel-tier scaling, which is the
      // right pool for high-value autos.
      const NUMBER_IS_AUTO_PREFIX =
        /^(CPA|CDA|BCPA|BCDA|BDPA|BDA|BPA|BCRA|TCRA|TRA|FCA|USA|AU|HSA|RRA|PRV|TEK)(-|$)/i;
      const targetNumberForAutoCheck =
        typeof cardIdentity?.number === "string" ? cardIdentity.number : "";
      const targetIsAutoPrefix = NUMBER_IS_AUTO_PREFIX.test(
        targetNumberForAutoCheck,
      );
      if (targetIsAutoPrefix) {
        console.log(
          JSON.stringify({
            event: "sibling_pool_rescue_skipped_auto_target",
            source: "compiq.computeEstimate",
            cardId: cardIdentity?.card_id ?? null,
            targetNumber: targetNumberForAutoCheck,
            siblingPoolSize: siblingPool.sales.length,
            note: "Skipping sibling-pool rescue for auto target — cross-tier pool contamination. Downstream Layer 4 will handle.",
          }),
        );
      }
      if (
        siblingPool.sales.length > 0 &&
        !isChTrustedSingleSaleForce &&
        !targetIsAutoPrefix
      ) {
        const directSales: Array<{ price: number; ts: number }> = fetched.comps
          .map((c) => ({ price: c.price, ts: Date.parse(c.soldDate || "") }))
          .filter((s) => Number.isFinite(s.ts) && s.price > 0);
        const combinedSales = [...directSales, ...siblingPool.sales];
        const combinedNewestTs = combinedSales.reduce((max, s) => Math.max(max, s.ts), 0);
        const combinedDaysSinceNewest =
          combinedNewestTs > 0
            ? Math.floor((Date.now() - combinedNewestTs) / (24 * 3600 * 1000))
            : null;
        const combinedCount = combinedSales.length;

        // Same sufficiency thresholds as the direct-pool check (line 1562-1567).
        const stillInsufficient =
          combinedCount === 0 ||
          (combinedCount === 1 && (combinedDaysSinceNewest == null || combinedDaysSinceNewest > 14)) ||
          (combinedCount === 2 && (combinedDaysSinceNewest == null || combinedDaysSinceNewest > 180)) ||
          (combinedCount >= 3 && (combinedDaysSinceNewest == null || combinedDaysSinceNewest > 365));

        if (!stillInsufficient) {
          // CF-FMV-NOWCAST Ship 1: route through the existing exported
          // velocity-weighted median (getSaleVelocityWeight at L219-229 gives
          // 48h:5x, 7d:2x, 21d:1x, 30d:0.3x, older:0.1x — same decay law as
          // the main pipeline). combinedSales carries epoch-ms `ts`; pass as
          // the `date` field which getSaleVelocityWeight handles natively.
          // Defensive fallback: if computeWeightedMedian returns null (only
          // possible when every sample is filtered out — combinedCount===0
          // guard above already prevented this), reuse the plain median to
          // preserve the never-emit-NaN contract.
          const weightedFmv = computeWeightedMedian(
            combinedSales.map((s) => ({ price: s.price, date: s.ts })),
          );
          let fairMarketValue: number;
          if (weightedFmv !== null) {
            fairMarketValue = weightedFmv;
          } else {
            const sortedPrices = combinedSales.map((s) => s.price).sort((a, b) => a - b);
            fairMarketValue =
              sortedPrices.length % 2 === 1
                ? sortedPrices[(sortedPrices.length - 1) / 2]
                : (sortedPrices[sortedPrices.length / 2 - 1] + sortedPrices[sortedPrices.length / 2]) / 2;
          }
          // CF-FMV-NOWCAST trend-knob insertion point (NOT implemented this
          // ship — evidence-gated decision per ground-truth trace). When a
          // bounded trend signal arrives on the sibling-pool path, multiply
          // here:  fairMarketValue = fairMarketValue * trendCorrection
          // (factor clamped to e.g. [0.85, 1.15] for the thin-data path).
          // The downstream quickSale/premium/suggestedList cascade off `fmv`
          // so the correction propagates without additional plumbing.
          const round2 = (n: number) => Math.round(n * 100) / 100;
          const fmv = round2(fairMarketValue);
          const quickSaleValue = round2(fmv * 0.88);
          const premiumValue = round2(fmv * 1.15);
          const suggestedListPrice = round2(fmv * 1.05);
          const siblingFmvBand = computeFmvBand(fmv, {
            sampleCount: combinedCount,
            daysSinceNewest: combinedDaysSinceNewest,
            basedOn: "broader",
            trendPct: 0,
            siblingPath: true,
          });

          // Confidence: scale with combined-pool size + recency, then cap at 65.
          const recencyFactor =
            combinedDaysSinceNewest == null || combinedDaysSinceNewest > 90
              ? 0.6
              : combinedDaysSinceNewest > 30
              ? 0.8
              : 1.0;
          const sizeFactor = Math.min(1.0, combinedCount / 12);
          const computedConfidence = Math.round(80 * sizeFactor * recencyFactor);
          const pricingConfidence = Math.min(65, computedConfidence);

          const freshness =
            combinedDaysSinceNewest != null && combinedDaysSinceNewest <= 60 ? "Live" : "Stale";

          const siblingVerdict = "Estimated from similar cards — variant unverified";

          // CF-PREDICTION-PATH-FMV-FALLBACK (PREDICTION-ROBUSTNESS-RECON
          // 2026-06-02; Option C from the recon HALT). Pre-fix corpus
          // measurement: 27/27 (100%) of sibling-pool predictions had
          // predictedPrice=null because trendIQ was not computed on this
          // path. Fix: wire Layer 2 (cardTrajectory) + Layer 3
          // (segmentTrajectory) from the data the rescue already gathered;
          // skip Layer 1 (playerMomentum) — the signal fetch happens
          // LATER in the main path. The composite uses whatever layers
          // populate; coverage="insufficient" gracefully degrades to
          // predictedPrice=fmv (factor 1.0) per computePredictedPrice's
          // documented contract.
          //
          // Coverage expectations on this path:
          //   - L2 (cardTrajectory) needs ≥2 in 0-14d + ≥2 in 15-45d on
          //     the junk-excluded clean pool (CF-TREND-DIRTY-POOL).
          //     Often null on the sibling-pool path because direct comps
          //     are by definition thin here.
          //   - L3 (segmentTrajectory) needs ≥2 pre-anchor + ≥2 post-anchor
          //     in siblingPool.sales, anchored on newestTs (this card's
          //     last direct sale). Often the load-bearing layer; the
          //     sibling pool is exactly what L3 was designed to consume.
          //   - coverage="insufficient" when newestTs=0 OR pool is sparse
          //     → predictedPrice gracefully = fmv (factor 1.0), no
          //     fabrication.
          const cardTrajectory = computeCardTrajectory(
            trendCleanComps.map((c) => ({ price: c.price, soldDate: c.soldDate })),
          );
          // CF-TRENDIQ-SURFACES (2026-06-03): same windowing, byte-identical
          // component; .full is consumed only when caller opted into the
          // /trendiq/full capture hook.
          const segR = computeSegmentTrajectoryAndFull(siblingPool, newestTs);
          const segmentTrajectory = segR.component;
          options.captureSegmentTrajectoryFull?.(segR.full);
          const trendIQ = computeTrendIQ({
            playerMomentum: null,
            cardTrajectory,
            segmentTrajectory,
          });
          console.log(formatTrendIQLogLine(trendIQ));

          // Same predicted-price helper the main path uses (L3085).
          // Insufficient coverage → factor 1.0 → predictedPrice = fmv
          // (round2). Sufficient → bounded projection within [0.80, 1.30]
          // × fmv. Never null when fmv is a finite number, which is the
          // invariant of the sibling-pool rescue branch.
          const __siblingPredicted = computePredictedPrice(fmv, trendIQ);

          console.log(
            `[compiq.computeEstimate] sibling-pool rescue SUCCESS: direct=${directSales.length} ` +
              `sibling=${siblingPool.sales.length} combined=${combinedCount} ` +
              `daysSinceNewest=${combinedDaysSinceNewest} fmv=${fmv} confidence=${pricingConfidence} ` +
              `query="${cardTitle}"`
          );

          // CF-PREDICTION-CORPUS-EMISSION-COVERAGE: emit on sibling-pool
          // rescue success. fmvMechanism="sibling-pool-weighted-median".
          // CF-PREDICTION-PATH-FMV-FALLBACK: trendIQ + predictedPrice now
          // populated via the L2+L3-from-rescue-data wiring above; this
          // closes the 27/27 null-predicted gap measured in the
          // PREDICTION-ROBUSTNESS-RECON corpus query.
          emitPredictionToCorpus({
            cardIdentity: cardIdentity ? { card_id: cardIdentity.card_id ?? null } : null,
            body,
            fairMarketValue: fmv,
            fmvMechanism: "sibling-pool-weighted-median",
            predictedPrice: __siblingPredicted.predictedPrice,
            predictedPriceRange: __siblingPredicted.predictedPriceRange,
            predictedPriceMechanism: __siblingPredicted.predictedPriceAttribution.mechanism,
            forwardProjectionFactor: __siblingPredicted.forwardProjectionFactor,
            trendIQ,
            compsUsed: combinedCount,
            callContext,
          });

          return {
            cardTitle,
            verdict: siblingVerdict,
            action: "Hold",
            dealScore: 0,
            quickSaleValue,
            fairMarketValue: fmv,
            fairMarketValueLow: siblingFmvBand.low,
            fairMarketValueHigh: siblingFmvBand.high,
            marketValue: fmv,
            premiumValue,
            suggestedListPrice,
            predictedPrice: __siblingPredicted.predictedPrice,
            predictedPriceRange: __siblingPredicted.predictedPriceRange,
            predictedPriceAttribution: __siblingPredicted.predictedPriceAttribution,
            // CF-PREDICTION-PATH-FMV-FALLBACK: trendIQ now lifted into
            // the sibling-pool response. signalsLastUpdated mirrors the
            // main path's pattern (composite.lastUpdated which is L1's
            // last-write timestamp; null on this path because L1 isn't
            // fetched here).
            trendIQ,
            signalsLastUpdated: trendIQ.lastUpdated,
            explanation: [siblingVerdict],
            marketDNA: {
              demand: "Mixed",
              speed: "Normal",
              risk: "Medium",
              trend: "Flat",
              marketCondition: "Sibling-pool estimate",
            },
            marketRegime: {
              regime: "stable",
              volatilityPct: 0,
              slopePctPerComp: 0,
              confidence: pricingConfidence / 100,
              note: "Estimated from sibling pool — variant unverified.",
            },
            normalization: {
              parallelInput: body.parallel ?? null,
              parallelCanonical: normalizedParallel ?? null,
              gradeCompanyInput: body.gradeCompany ?? null,
              gradeCompanyCanonical: normalizedGradeCompany ?? null,
            },
            confidence: {
              pricingConfidence,
              liquidityConfidence: pricingConfidence,
              timingConfidence: pricingConfidence,
            },
            exitStrategy: {
              recommendedMethod: "list",
              expectedDaysToSell: null,
              timingRecommendation: "Verify variant before listing — pricing is from similar cards.",
            },
            freshness: {
              status: freshness as "Live" | "Stale",
              lastUpdated: new Date().toISOString(),
            },
            pricingAnalytics: null,
            estimate: fmv,
            compsUsed: combinedCount,
            compsAvailable: combinedCount,
            cardIdentity,
            recentComps: fetched.comps
              .slice()
              .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
              .map((c) => ({
                price: c.price,
                title: c.title,
                soldDate: c.soldDate,
                grade: formatGradeLabel(c.title),
                saleType: saleTypeFromListingType(c.listingType),
                imageUrl: c.imageUrl ?? undefined,
              })),
            gradeUsed: cardHedgeGrade,
            source: "sibling-pool",
            daysSinceNewestComp: combinedDaysSinceNewest,
            variantWarning: fetched.variantWarning,
            crossParallelAnchor: null,
            effectiveFmv: fmv,
            dataSufficiency: {
              sufficient: true,
              level: "low" as const,
              message: `Sibling-pool estimate from ${combinedCount} sales across related cards`,
            },
          };
        }
      }
    }

    // CF-PREDICTION-CORPUS-EMISSION-COVERAGE: emit on no-recent-comps
    // short-circuit. fmvMechanism="unavailable" (FMV null); predicted
    // comes from mechanism1 if Bowman-family, else null. compsUsed is
    // the raw fetched-comps count (which failed the sufficiency gate).
    // CF-TREND-EXTRAPOLATED (2026-06-10): when we reach this return
    // path, marketValue/fairMarketValue ARE null (no recent comps to
    // price from). If we also have an anchor (lastSale) + a usable
    // trend (playerMomentum) + a gap within cutoff, surface an
    // estimatedValue + estimateRange under a distinct field so iOS
    // can render "Estimated $X (range Y–Z), based on the last sale
    // N ago adjusted for the set's recent trend."
    //
    // The estimatedValue is INTENTIONALLY surfaced under
    // `estimatedValue` (NOT fairMarketValue). The training join's
    // realizedReturn formula reads fairMarketValue — leaving it null
    // is the structural gate that excludes trend-extrapolated rows
    // from training-as-observed. estimateSource is the audit signal
    // for the prediction-corpus emit (see emitPredictionToCorpus).
    //
    // Computed BEFORE the corpus emit so estimateSource can be passed
    // through and the invariant check (estimateSource=trend-extrapolated
    // implies fairMarketValue=null) fires at the right moment.
    const trendEstimate =
      playerMomentum && typeof playerMomentum.multiplier === "number" &&
      lastSale !== null && daysSinceNewest !== null
        ? repriceTrendExtrapolated(lastSale, daysSinceNewest, playerMomentum.multiplier)
        : null;
    // CF-CH-P5-PRIMARY: when CardHedge served comps but the engine couldn't
    // ground a confident FMV (n=1 thin-parallel case), still attribute the
    // path to CH so iOS / corpus know the data came from CardHedger. CH-thin
    // takes precedence over trend-extrapolated and last-sale.
    //
    // CF-CH-THIN-COMP-PRIMARY (2026-06-26): split the CH-served thin-comp
    // path into two surfaces by count:
    //   n==1 → "cardhedge-last-sale" (NEW). iOS renders "Last sold $X via
    //          1 comp" off lastSale; trendEstimate is SUPPRESSED so no
    //          competing estimatedValue prose appears.
    //   n>=2 → "cardhedge" (legacy CH-thin label). Trend-extrapolated
    //          remains an honest enrichment.
    // Detection uses fetched.chTrustReason as the trust gate (matches the
    // variant-mismatch bypass above) — anonymous-vendor CS comps don't
    // qualify.
    const isChTrustedThin =
      fetched.vendor === "cardhedge" &&
      fetched.chTrustReason !== undefined &&
      lastSale !== null;
    const isChTrustedSingleSale =
      isChTrustedThin && fetched.comps.length === 1;
    // CF-ESTIMATE-SOURCE-VENDOR-NEUTRAL (2026-07-04): "cardhedge" →
    // "live-market", "cardhedge-last-sale" → "live-market-last-sale"
    // for customer contract vendor-neutrality. Internal fetched.vendor
    // field stays as-is (never emits on the wire).
    const resolvedEstimateSource:
      | "live-market"
      | "live-market-last-sale"
      | "trend-extrapolated"
      | "last-sale"
      | null =
      isChTrustedSingleSale
        ? "live-market-last-sale"
        : isChTrustedThin
        ? "live-market"
        : trendEstimate !== null
        ? "trend-extrapolated"
        : lastSale !== null
        ? "last-sale"
        : null;
    // CF-CH-THIN-COMP-PRIMARY: trendEstimate suppressed on the n==1 CH path
    // so iOS sees a clean "Last sold $X via 1 comp" without a competing
    // forward-looking estimatedValue. n>=2 CH path and all CS paths
    // unchanged.
    const suppressTrendForChLastSale = isChTrustedSingleSale;
    const resolvedEstimatedValue = suppressTrendForChLastSale
      ? null
      : trendEstimate?.estimatedValue ?? null;
    const resolvedEstimateRange = suppressTrendForChLastSale
      ? null
      : trendEstimate?.estimateRange ?? null;
    const resolvedEstimateBasis = suppressTrendForChLastSale
      ? null
      : trendEstimate?.basis ?? null;

    // CF-CH-LAST-SALE-MODEL-EXPECTATION was removed with the Cardsight
    // decommission. modelExpectation + modelSignal are always null now;
    // iOS sees no Build-B-derived signal on the cardhedge-last-sale path.
    const modelExpectation: ModelExpectation = null;
    const modelSignal: ModelSignal = null;

    // CF-COMPIQ-SIBLING-BACKPORT (2026-07-07, Drew): fire the new-path
    // sibling fallback (PR #302/#307/#309) when the old path would
    // otherwise return null for estimatedValue. iOS is currently
    // hitting /api/compiq/search + /price-by-id (both route through
    // computeEstimate), NOT the new /card-panel — so without this
    // backport the ~280/day of production requests never see any of
    // the recent engine improvements (sibling anchor, print-run
    // floors, brand-family proxy, cross-class base fallback).
    //
    // Wire: attempt sibling fallback iff we have enough identity to
    // resolve a target (year, set, parallel, isAuto, playerName).
    // If sibling produces an estimate AND the existing trend-
    // extrapolated mechanism produced nothing, upgrade the response.
    // We PREFER trend-extrapolated when both fire — sibling is the
    // last-resort backstop.
    let backportedSiblingLineage:
      | Awaited<
          ReturnType<
            typeof import("./siblingCardPriceFallback.service.js")["attemptSiblingPriceFallback"]
          >
        >
      | null = null;
    let backportedEstimateValue: number | null = null;
    let backportedEstimateRange: { low: number; high: number } | null = null;
    if (
      resolvedEstimatedValue === null &&
      body.playerName &&
      body.playerName.trim().length > 0 &&
      body.cardYear &&
      body.product &&
      (normalizedParallel || body.parallel)
    ) {
      try {
        const parallelForFallback =
          normalizedParallel ?? (body.parallel as string | undefined);
        if (parallelForFallback) {
          const { attemptSiblingPriceFallback } = await import(
            "./siblingCardPriceFallback.service.js"
          );
          const year =
            typeof body.cardYear === "number"
              ? body.cardYear
              : parseInt(String(body.cardYear), 10);
          const fb = await attemptSiblingPriceFallback({
            targetCardId: `compiq-backport:${cardIdentity?.card_id ?? "no-id"}`,
            year,
            set: body.product as string,
            parallel: parallelForFallback,
            isAuto: effectiveIsAuto,
            playerName: body.playerName,
            trajectoryRateWeekly: null,   // no cheap rate on this path yet
          });
          if (fb && typeof fb.estimatedRawPrice === "number" && fb.estimatedRawPrice > 0) {
            backportedSiblingLineage = fb;
            backportedEstimateValue = fb.estimatedRawPrice;
            backportedEstimateRange = {
              low: Math.round(fb.estimatedRawPrice * 0.85 * 100) / 100,
              high: Math.round(fb.estimatedRawPrice * 1.15 * 100) / 100,
            };
            console.log(JSON.stringify({
              event: "compiq_sibling_backport_fired",
              source: "compiqEstimate",
              player: body.playerName,
              year,
              set: body.product,
              parallel: parallelForFallback,
              isAuto: effectiveIsAuto,
              estimatedRawPrice: fb.estimatedRawPrice,
              parallelPremium: fb.parallelPremium,
              floorApplied: fb.floorApplied,
              inferredPrintRun: fb.inferredPrintRun,
              siblingIsCrossClass: fb.siblingIsCrossClass,
              premiumMatchedSet: fb.premiumMatchedSet,
              premiumUsedProxy: fb.premiumUsedProxy,
            }));
          }
        }
      } catch (err) {
        console.warn(
          `[compiqEstimate] sibling backport threw — falling through: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    // Effective values that flow into the response. Sibling backport
    // wins ONLY when trend-extrapolation produced nothing.
    const finalEstimatedValue = resolvedEstimatedValue ?? backportedEstimateValue;
    const finalEstimateRange =
      resolvedEstimateRange ??
      (backportedEstimateRange
        ? [backportedEstimateRange.low, backportedEstimateRange.high]
        : null);
    const finalEstimateSource =
      resolvedEstimateSource ??
      (backportedEstimateValue !== null ? "sibling-fallback" : null);
    const finalEstimateBasis =
      resolvedEstimateBasis ??
      (backportedEstimateValue !== null
        ? `Sibling anchor via ${backportedSiblingLineage?.siblingIsCrossClass ? "Base card × cross-class × " : "Base Auto × "}${backportedSiblingLineage?.parallelPremium}× ${backportedSiblingLineage?.floorApplied ? "(floor)" : "(empirical)"}`
        : null);

    emitPredictionToCorpus({
      cardIdentity: cardIdentity ? { card_id: cardIdentity.card_id ?? null } : null,
      body,
      fairMarketValue: null,
      fmvMechanism: "unavailable",
      predictedPrice: mechanism1.predictedPrice,
      predictedPriceRange: mechanism1.predictedPriceRange,
      predictedPriceMechanism:
        mechanism1.predictedPrice !== null
          ? mechanism1.predictedPriceAttribution.mechanism
          : "unavailable",
      compsUsed: fetched.comps.length,
      callContext,
      // CF-TREND-EXTRAPOLATED (2026-06-10): audit fields. fairMarketValue
      // stays null (structural training-exclusion); estimateSource +
      // estimatedValue are descriptive only.
      estimateSource: finalEstimateSource,
      estimatedValue: finalEstimatedValue,
    });

    return {
      cardTitle,
      verdict,
      action: "Hold",
      dealScore: 0,
      quickSaleValue: null,
      // STRUCTURAL TRAINING-EXCLUSION GATE: fairMarketValue stays null
      // for the trend-extrapolated branch. trainingDatasetJoin's
      // realizedReturn formula returns null when fairMarketValue is
      // null/0, so this row contributes nothing to training as
      // observed. The estimatedValue below is for display only.
      fairMarketValue: null,
      fairMarketValueLow: null,
      fairMarketValueHigh: null,
      marketValue: null,
      estimatedValue: finalEstimatedValue,
      estimateRange: finalEstimateRange,
      estimateBasis: finalEstimateBasis,
      predictedPrice: mechanism1.predictedPrice,
      predictedPriceRange: mechanism1.predictedPriceRange,
      predictedPriceAttribution: mechanism1.predictedPriceAttribution,
      premiumValue: null,
      explanation: [verdict],
      marketDNA: {
        demand: "Unknown",
        speed: "Unknown",
        risk: "High",
        trend: "Flat",
        marketCondition: "Insufficient Data",
      },
      marketRegime: {
        regime: "illiquid",
        volatilityPct: 0,
        slopePctPerComp: 0,
        confidence: 0.2,
        note: "No usable recent comps.",
      },
      normalization: {
        parallelInput: body.parallel ?? null,
        parallelCanonical: normalizedParallel ?? null,
        gradeCompanyInput: body.gradeCompany ?? null,
        gradeCompanyCanonical: normalizedGradeCompany ?? null,
      },
      confidence: { pricingConfidence: 0, liquidityConfidence: 0, timingConfidence: 0 },
      exitStrategy: {
        recommendedMethod: "wait",
        expectedDaysToSell: null,
        timingRecommendation: "Wait for fresh comps before pricing this card.",
      },
      freshness: {
        status: "Needs refresh" as const,
        lastUpdated: null,
      },
      pricingAnalytics: null,
      estimate: null,
      compsUsed: fetched.comps.length,
      compsAvailable: fetched.comps.length,
      cardIdentity,
      // Return EVERY comp we found (no slice). When the prediction can't be
      // made the iOS UI shows the raw sales so the user can eyeball the
      // market themselves instead of seeing an empty "insufficient" screen.
      recentComps: fetched.comps
        .slice()
        .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0))
        .map((c) => ({
          price: c.price,
          title: c.title,
          soldDate: c.soldDate,
          grade: formatGradeLabel(c.title),
          saleType: saleTypeFromListingType(c.listingType),
          imageUrl: c.imageUrl ?? undefined,
        })),
      gradeUsed: cardHedgeGrade,
      source: "no-recent-comps",
      daysSinceNewestComp: daysSinceNewest,
      // CF-LASTSALE-SCAFFOLD + CF-TREND-EXTRAPOLATED (2026-06-10):
      // lastSale surfaces the most-recent sub-market-isolated sale.
      // estimateSource is "trend-extrapolated" when the four-condition
      // gate (above) produced an estimatedValue; falls back to
      // "last-sale" when an anchor exists but trend is unusable; null
      // when no anchor at all.
      lastSale,
      estimateSource: finalEstimateSource,
      // CF-COMPIQ-SIBLING-BACKPORT (2026-07-07): expose the sibling
      // lineage on the response so iOS can render a "Est via similar
      // card" badge. Null when trend-extrapolation already produced
      // an estimate or when sibling didn't fire.
      siblingFallback: backportedSiblingLineage
        ? {
            siblingCardId: backportedSiblingLineage.siblingCardId,
            siblingParallel: backportedSiblingLineage.siblingParallel,
            siblingBaseMedianRaw: backportedSiblingLineage.siblingBaseMedianRaw,
            siblingBaseProjectedToday:
              backportedSiblingLineage.siblingBaseProjectedToday,
            siblingWeeksSinceNewestSale:
              backportedSiblingLineage.siblingWeeksSinceNewestSale,
            parallelPremium: backportedSiblingLineage.parallelPremium,
            empiricalPremium: backportedSiblingLineage.empiricalPremium,
            floorApplied: backportedSiblingLineage.floorApplied,
            inferredPrintRun: backportedSiblingLineage.inferredPrintRun,
            premiumMatchedSet: backportedSiblingLineage.premiumMatchedSet,
            premiumUsedProxy: backportedSiblingLineage.premiumUsedProxy,
            siblingIsCrossClass: backportedSiblingLineage.siblingIsCrossClass,
            crossClassAutoPremium: backportedSiblingLineage.crossClassAutoPremium,
          }
        : null,
      // CF-CH-P8-TESTS: provenance also on the thin-comp/trend-extrapolated
      // branch when fetched.vendor === "cardhedge". Omitted otherwise so
      // CS-sourced trend-extrap rows stay byte-identical pre/post P8.
      chCardId: fetched.vendor === "cardhedge" ? fetched.chCardId : undefined,
      chTrustReason: fetched.vendor === "cardhedge" ? fetched.chTrustReason : undefined,
      // CF-CH-THIN-COMP-PRIMARY (2026-06-26): comp count on the CH-served
      // branch so iOS can render "via N comp(s)" generally (N comes from
      // the trusted-CH getCardSales response). corpusMapping reads this
      // into chProvenance.compCount.
      chCompCount: fetched.vendor === "cardhedge" ? fetched.comps.length : undefined,
      // CF-CH-LAST-SALE-MODEL-EXPECTATION (2026-06-26): the multiplier-
      // model expectation + buy/sell signal. Populated only on the
      // cardhedge-last-sale path AND only when Build B successfully
      // computed (curated row + empirical baseRelativePremium + enough
      // base autos in the parent's CS pool). undefined otherwise —
      // existing wire shape preserved for every other path.
      ...(modelExpectation ? { modelExpectation } : {}),
      ...(modelSignal ? { modelSignal } : {}),
      // CF-THIN-CARD-FULL-DETAIL-PARITY (2026-06-12): shape parity with
      // the live branch — surface trendIQ + broaderTrend (and the trendIQ
      // lastUpdated as signalsLastUpdated, mirroring the live path at
      // L4234) so iOS can render the OVERALL TREND section on this branch
      // off the same fields. Both are computed above in the cardIdentity
      // block and may be null when cardIdentity is null (rare) or when
      // the underlying fetches threw. trendIQ degrades honestly to
      // coverage="insufficient" / direction="flat" when all three layers
      // are null — the iOS surface fills that with "Holding steady, no
      // clear direction." Neither field overrides the headline last-sale
      // value; neither flips the fairMarketValue=null training gate.
      trendIQ: thinBranchTrendIQ,
      broaderTrend: thinBranchBroaderTrend,
      signalsLastUpdated: thinBranchTrendIQ?.lastUpdated ?? null,
      variantWarning: fetched.variantWarning,
      // CF-PINNED-PARALLEL-RECOVERY (2026-06-10): propagate the parallel-
      // match attribution onto the no-recent-comps thin-data branch too.
      // When recovery hit "unified-fallback-no-match" we want iOS to
      // still SEE that the parallel was the missing piece — and ops to
      // see the priceSourceInternal in telemetry — rather than collapse
      // to a generic "thin" state. Mirrors the variant-mismatch branch's
      // parity surface above (L3076-3079).
      priceSource: fetched.priceSource ?? null,
      priceSourceInternal: fetched.priceSourceInternal ?? null,
      parallelMatchFilteredCount: fetched.parallelMatchFilteredCount ?? null,
      parallelMatchUnifiedCount: fetched.parallelMatchUnifiedCount ?? null,
      crossParallelAnchor: null,
      effectiveFmv: null,
      dataSufficiency: {
        sufficient: false,
        level: "none" as const,
        message: ageNote,
      },
    };
  }

  // --- Sibling-sales pool fetch + TrendIQ Layer 1 fetch (parallel) ---------
  // siblingPool: one-shot sibling-sale fetch shared between fetchBroaderTrend
  //              (existing fixed-window trend) and computeSegmentTrajectory
  //              (TrendIQ Layer 3 last-sale-anchored trend). Both run in
  //              parallel with the player-signal fetch since they are
  //              independent network ops.
  // CF-PLAYER-IN-SET-MOMENTUM (2026-06-09): TrendIQ Layer 1 is now
  // computed LIVE from fetchCompsByPlayer (same enumeration as
  // fetchSiblingSales, but no exact-card exclusion — we want the whole
  // player-in-set pool, grade-agnostic). The deprecated player-wide
  // compsMomentum.json blob path (fetchPlayerSignals / fn-comps-
  // momentum nightly) is left running but is no longer the Layer 1
  // source. CF-C re-homes the blob job to per-(player, set) tuples;
  // this CF stops READING the player-wide blob.
  // CF-TREND-EXTRAPOLATED (2026-06-10): playerNameForSignals /
  // productForSignals / cardYearForSignals AND playerMomentum were
  // moved UP — declared once right after `cardIdentity` so the
  // insufficient short-circuit can use the trend signal. Here we just
  // fetch sibling-pool; momentum is already in scope from the upstream
  // await. No double-fetch.
  const siblingPool = cardIdentity
    ? await fetchSiblingSales(cardIdentity, cardHedgeGrade).catch(() => ({
        siblingCardIds: [] as string[],
        sales: [] as Array<{ price: number; ts: number }>,
      }))
    : {
        siblingCardIds: [] as string[],
        sales: [] as Array<{ price: number; ts: number }>,
      };
  // CF-TREND-DIRTY-POOL (2026-06-08): pass the junk-excluded clean pool
  // as exactComps (was `fetched.comps`). siblingPool hygiene is unchanged
  // — sibling junk is a SEPARATE pass (siblings flow through their own
  // fetch in fetchSiblingSales / fetchCompsByPlayer, with their own
  // hygiene policy — out of scope here).
  const broaderTrend = cardIdentity
    ? await fetchBroaderTrend(cardIdentity, cardHedgeGrade, trendCleanComps, siblingPool).catch(() => null)
    : null;

  // Find the most recent exact-match sale to serve as the anchor.
  const sortedExact = fetched.comps
    .slice()
    .sort((a, b) => (Date.parse(b.soldDate || "") || 0) - (Date.parse(a.soldDate || "") || 0));
  const anchorSale = sortedExact[0] ?? null;

  // Filter out numbered serials (/499, #/50, etc.) unless the request explicitly specifies a parallel.
  // This prevents refractors/prizms from skewing the base card FMV.
  const hasParallel = Boolean(body.parallel);
  const serialPattern = /(?:#\s*\/\s*|\/)\s*\d{1,4}(?:\b|$)/i;
  const filteredComps = hasParallel
    ? rawComps
    : rawComps.filter((c) => !serialPattern.test(c.title));
  // Fall back to unfiltered pool if filtering leaves too few comps
  const compsPool = filteredComps.length >= 3 ? filteredComps : rawComps;

  // --- Parallel keyword post-filter ---
  // Keeps only comps that mention the requested parallel (e.g. "Blue Raywave" or "Blue /99").
  // For multi-token parallels (e.g. "blue refractor") require ALL ≥3-char
  // tokens to appear in the comp title (AND match) so we don't pool plain
  // refractors with the blue refractor variant. Falls back progressively to
  // longest-token then full pool when fewer than 3 match so we never go dark.
  function applyParallelFilter(pool: RawComp[], parallel: string): RawComp[] {
    const lower = parallel.trim().toLowerCase();
    const tokens = lower.split(/\s+/).filter((w) => w.length >= 3);
    if (tokens.length === 0) return pool;

    // Strict AND match across all distinguishing tokens.
    const andMatch = pool.filter((c) => {
      const t = c.title.toLowerCase();
      return tokens.every((tok) => t.includes(tok));
    });
    if (andMatch.length >= 3) return andMatch;

    // Fallback: full-phrase substring match.
    const fullMatch = pool.filter((c) => c.title.toLowerCase().includes(lower));
    if (fullMatch.length >= 3) return fullMatch;

    // Last resort: longest single distinguishing token.
    const distinctWord = tokens.slice().sort((a, b) => b.length - a.length)[0];
    if (distinctWord) {
      const wordMatch = pool.filter((c) => c.title.toLowerCase().includes(distinctWord));
      if (wordMatch.length >= 3) return wordMatch;
    }
    return pool; // can't narrow further — keep full pool
  }

  // --- Auto/autograph post-filter ---
  // When the request is for an autograph variant, keep only comps whose title
  // mentions "auto" / "autograph" / "signed". Falls back to the unfiltered
  // pool if narrowing leaves fewer than 3 comps.
  function applyAutoFilter(pool: RawComp[]): RawComp[] {
    const autoRegex = /\b(auto|autograph|autographed|signed)\b/i;
    const filtered = pool.filter((c) => autoRegex.test(c.title));
    return filtered.length >= 3 ? filtered : pool;
  }

  // --- Grade keyword post-filter ---
  // When a grade is requested (e.g. "PSA 10"), only use comps that carry that grade in their title.
  function applyGradeFilter(pool: RawComp[], gradeStr: string): RawComp[] {
    const lower = gradeStr.trim().toLowerCase();
    const gradeMatch = pool.filter((c) => c.title.toLowerCase().includes(lower));
    return gradeMatch.length >= 3 ? gradeMatch : pool;
  }

  let refinedPool = compsPool;
  // Skip applyParallelFilter for "base" — base card comps don't carry the
  // word "base" as a variant token, so filtering on it drops all valid comps.
  if (normalizedParallel && normalizedParallel !== "base") refinedPool = applyParallelFilter(refinedPool, normalizedParallel);
  if (effectiveIsAuto) refinedPool = applyAutoFilter(refinedPool);
  if (normalizedGradeCompany && body.gradeValue !== undefined) {
    refinedPool = applyGradeFilter(refinedPool, `${normalizedGradeCompany} ${body.gradeValue}`);
  }

  const regime = detectMarketRegime(refinedPool);

  // ── Grader-premium normalization (Pricing Accuracy — Improvement 3) ─────
  // Convert every comp's sale price into a raw-equivalent before pooling, so
  // PSA10 + BGS9.5 + raw sales contribute to a single anchor. After the
  // pipeline computes the raw anchor we re-apply the target card's grader
  // premium below.
  //
  // `originalPrice` preserves the ORIGINAL Card Hedge sale price for each
  // comp so the user-facing `recentComps` payload can surface what each
  // card actually sold for instead of the engine's internal raw-equivalent
  // intermediate value. Internal anchor math continues to use the
  // normalized `price`. See issue #24.
  const targetPremium = getGraderPremium(normalizedGradeCompany, body.gradeValue?.toString());
  const normalizedRefinedPool: (RawComp & { originalPrice: number })[] = refinedPool.map((c) => ({
    ...c,
    originalPrice: c.price,
    price: normalizeCompToRaw(c),
  }));

  const comps = normalizedRefinedPool.map((c) => ({
    price: c.price,
    originalPrice: c.originalPrice,
    title: c.title,
    date: c.soldDate,
    source: "ebay",
    id: `${c.price}-${c.soldDate}`,
    // CF-RECENTCOMPS-SALETYPE: thread per-comp listingType through the
    // pipeline-internal comps shape so the route-level recentComps[]
    // can emit a saleType chip.
    listingType: c.listingType,
    // CF-RECENTCOMPS-IMAGEURL: same threading for image_url.
    imageUrl: c.imageUrl,
  }));

  // Build context for the pipeline
  const soldCount30d = comps.length;
  // Estimate active listings as ~40% of 30-day sold count (typical sell-through ratio for sports cards).
  // This gives an absorptionRate > 1.0 (sellers' market) for active cards rather than always 1.0.
  const activeListings = Math.max(1, Math.round(soldCount30d * 0.4));
  const context: {
    soldCount30d: number;
    activeListings: number;
    avgDaysToSell: number;
    volatilityIndex: number;
    rankingTrend: string;
    trendProjection?: {
      projectedPrice: number;
      rSquared: number;
      slope: number;
      confidence: number;
    };
    anchorModel?: {
      anchorPrice: number;
      anchorDate: string | null;
      longTermMultiplier: number;
      shortTermMultiplier: number;
      netTrendMultiplier: number;
      impliedTrendPct: number;
    };
    compPoolDebug?: {
      totalNormalized: number;
      exactMatchForTrend: number;
      usingFallbackPool: boolean;
    };
  } = {
    soldCount30d,
    activeListings,
    avgDaysToSell: 7,
    volatilityIndex: 40,
    rankingTrend: "flat",
  };

  // Run predictive analytics pipeline
  const result = DynamicPricingOrchestrator.run(subject, comps, context);

  // --- Override trend % with broader-pool signal ---------------------------
  // Anchor PRICE stays whatever the orchestrator picked from the exact comps,
  // but the trend direction/magnitude is driven by all similar cards in the
  // same player+year+set pool. This keeps a thin card with 2 direct sales
  // from showing a flat or noisy trend when the broader market is moving.
  if (broaderTrend && broaderTrend.basedOn !== "insufficient") {
    const anchorPrice = context.anchorModel?.anchorPrice ?? anchorSale?.price ?? 0;
    const anchorDate = context.anchorModel?.anchorDate ?? anchorSale?.soldDate ?? null;
    const net = 1 + broaderTrend.impliedTrendPct / 100;
    context.anchorModel = {
      anchorPrice,
      anchorDate,
      longTermMultiplier: net,
      shortTermMultiplier: net,
      netTrendMultiplier: Math.max(0.7, Math.min(1.5, net)),
      impliedTrendPct: broaderTrend.impliedTrendPct,
    };
  }

  const usedFallback = result.observability?.usedFallback ?? false;
  let { quickSaleValue, fairMarketValue, premiumValue } = result.priceLanes;

  // Re-apply the target card's grader premium. The orchestrator received
  // raw-normalized prices (Improvement 3), so its priceLanes are "raw
  // equivalent" — multiply by the requested grade's coefficient to land
  // the prediction back in the right grade band.
  const normalizedAnchorRaw = typeof fairMarketValue === "number" ? fairMarketValue : null;
  if (targetPremium !== 1.0) {
    if (typeof quickSaleValue === "number") quickSaleValue = quickSaleValue * targetPremium;
    if (typeof fairMarketValue === "number") fairMarketValue = fairMarketValue * targetPremium;
    if (typeof premiumValue === "number") premiumValue = premiumValue * targetPremium;
  }

  // ── Data Sufficiency Gate (Pricing Accuracy — Improvement 4) ────────────
  // Never publish a point price below the minimum-viable comp threshold.
  const dataSufficiency = evaluateDataSufficiency({
    usedComps: comps.length,
    totalComps: compQualityInfo.totalComps,
    recentCount: broaderTrend?.recentCount ?? 0,
  });
  // CF-PINNED-PARALLEL-RECOVERY (2026-06-11): bypass the 3-comp
  // sufficiency floor's FMV-null assignment for TITLE-MATCH-recovered
  // pools. Title-match isolated a clean parallel-specific sub-market
  // (word-boundary + sibling-registry guard + span-scoped finish-vocab
  // backstop); the single sale IS the honest market value for this
  // sub-market and surfacing it as an approximate FMV is the correct
  // UX — iOS reads priceSource="approximate" + dataSufficiency.level
  // ("very_thin"/"thin") and renders the thin-data disclosure. The
  // dataSufficiency object itself stays untouched so the disclosure
  // is preserved on the response. Corpus pollution is prevented by
  // the title-match-low-sample → fairMarketValue=null override at
  // the corpus emit further down — the on-screen FMV is honest
  // display data; the corpus emit excludes it from training.
  const isRecoveryIsolatedPool =
    fetched.priceSourceInternal === "title-matched-parallel"
    || fetched.priceSourceInternal === "title-match-low-sample";
  if (!dataSufficiency.sufficient && !isRecoveryIsolatedPool) {
    quickSaleValue = null as unknown as number;
    fairMarketValue = null as unknown as number;
    premiumValue = null as unknown as number;
  }

  // Map confidence bundle (ConfidenceEngine returns 0–100 integers already)
  // and then clamp each leg through the comp-volume gating ceiling so the
  // user never sees confidence=100 on a thin/illiquid card.
  //
  // CF-VARIANT-FILTER-LOOSENING (Q1 lock): apply the tier confidence cap via
  // multiplicative min — `effective = min(tier_cap, computed)`. Computed
  // confidence already degrades on thin/dispersed pools (via calibrateConfidence
  // + the rawPricing clamp); the tier cap layers on top so loose-pool prices
  // can't surface artificially-inflated confidence.
  const confidenceBundle = result.confidence ?? {};
  const tierCap = VARIANT_TIER_CAP[chosenTier];
  const rawPricing = Math.min(100, confidenceBundle.pricingConfidence ?? 60);
  const rawLiquidity = Math.min(100, confidenceBundle.liquidityConfidence ?? 60);
  const rawTiming = Math.min(100, confidenceBundle.timingConfidence ?? 60);
  const pricingConfidence = Math.min(tierCap, calibrateConfidence(rawPricing, comps));
  const liquidityConfidence = Math.min(tierCap, calibrateConfidence(rawLiquidity, comps));
  const timingConfidence = Math.min(tierCap, calibrateConfidence(rawTiming, comps));

  // Map marketDNA
  const dna = result.marketDNA ?? {};
  const marketSpeed = result.market?.marketSpeed ?? "normal";
  const marketPressure = result.market?.marketPressure ?? "balanced";
  const demandMap: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
  const speedMap: Record<string, string> = { fast: "Fast", normal: "Normal", slow: "Slow" };
  const riskMap: Record<string, string> = { low: "Low", medium: "Medium", high: "High" };
  const trendMap: Record<string, string> = { up: "Up", flat: "Flat", down: "Down" };
  const pressureMap: Record<string, string> = {
    buyers: "Buyer's Market",
    sellers: "Seller's Market",
    balanced: "Balanced Market",
  };

  // Freshness
  const now = new Date().toISOString();
  const freshnessStatus = usedFallback
    ? ("Needs refresh" as const)
    : comps.length > 0
    ? ("Live" as const)
    : ("Needs refresh" as const);

  // ── PlayerIQ writes (fire-and-forget, never block the estimate response) ──
  // 1) Log this card's broaderTrend to trend_history for the per-card chart
  //    and as input for the player-level market score aggregation.
  // 2) Refresh the player's PlayerScore in player_trends so /api/playeriq
  //    returns up-to-date numbers without needing the nightly batch.
  if (cardIdentity && broaderTrend) {
    const yearRaw = cardIdentity.year;
    const yearNum =
      typeof yearRaw === "number"
        ? yearRaw
        : typeof yearRaw === "string" && /^\d+$/.test(yearRaw)
        ? Number(yearRaw)
        : null;
    writeTrendSnapshot({
      cardId: cardIdentity.card_id,
      playerName: cardIdentity.player ?? "",
      year: yearNum,
      set: cardIdentity.set ?? null,
      cardNumber: cardIdentity.number ?? null,
      grade: cardHedgeGrade,
      broaderTrend,
      fairMarketValue: typeof fairMarketValue === "number" ? fairMarketValue : null,
      anchorPrice: context.anchorModel?.anchorPrice ?? null,
    });
  }
  if (cardIdentity?.player) {
    void updatePlayerScoreFromEstimate(cardIdentity.player);
  }

  // ── Buy Window Score + Confidence Interval ────────────────────────────
  const bwTrendDirection: "up" | "down" | "flat" = broaderTrend?.direction ?? "flat";
  const bwTrendPct = broaderTrend?.impliedTrendPct ?? 0;
  const bwRecent = broaderTrend?.recentCount ?? 0;
  const bwOlder = broaderTrend?.olderCount ?? 0;
  const bwBasedOn: BroaderTrend["basedOn"] = broaderTrend?.basedOn ?? "insufficient";
  const printRun = parsePrintRun(body.parallel) ?? parsePrintRun(normalizedParallel);
  const buyWindow = computeBuyWindowScore({
    trendDirection: bwTrendDirection,
    trendPct: bwTrendPct,
    recentCount: bwRecent,
    olderCount: bwOlder,
    basedOn: bwBasedOn,
    signalMultiplier: typeof (result as any).signals?.todayMultiplier === "number"
      ? (result as any).signals?.todayMultiplier
      : undefined,
    month: new Date().getUTCMonth() + 1,
    printRun,
    grade: cardHedgeGrade,
  });
  const confidenceInterval = computeConfidenceInterval({
    predictedPrice: typeof fairMarketValue === "number" ? fairMarketValue : 0,
    recentCount: bwRecent,
    olderCount: bwOlder,
    basedOn: bwBasedOn,
    trendPct: bwTrendPct,
  });

  const sellingGuidance = buildSellingGuidance({
    quickSaleValue: typeof quickSaleValue === "number" ? quickSaleValue : null,
    fairMarketValue: typeof fairMarketValue === "number" ? fairMarketValue : null,
    premiumValue: typeof premiumValue === "number" ? premiumValue : null,
    comps: comps.map((c) => ({ price: c.price, date: c.date ?? null })),
    recommendedMethod: result.exitStrategy?.recommendedMethod ?? null,
    marketSpeed: result.market?.marketSpeed ?? null,
    demand: dna.demand ?? null,
  });

  // ADR-0003 (Phase 3.2 option 3): neighbor synthesis removed.
  // Keep placeholders for compatibility until routes/clients stop reading
  // companion fields.
  const crossParallelAnchor = null;
  const effectiveFmv: number | null = typeof fairMarketValue === "number" ? fairMarketValue : null;

  // Issue #25 Phase 2 — compute regime + predicted range (read-only).
  // No pricing math reads from these fields.
  const regimeClassificationResult = classifyRegime(
    comps.map((c) => ({ price: c.originalPrice, date: c.date ?? null })),
  );
  const predictedRangeResultLocal: PredictedRangeResult = computePredictedRange({
    comps: comps.map((c) => ({
      price: c.originalPrice,
      title: c.title,
      date: c.date ?? null,
    })),
    targetGrade:
      normalizedGradeCompany && body.gradeValue !== undefined
        ? `${normalizedGradeCompany} ${body.gradeValue}`
        : "Raw",
    regimeResult: regimeClassificationResult,
    source: "live",
  });

  // ─── Issue #25 Phase 3 — tier-anchored fallback predicted range ──────────
  // Runs ONLY when:
  //   1. COMPIQ_PHASE3_TIER_ANCHORED=true (default OFF for safe rollout)
  //   2. Phase 2 returned a null range (no usable direct-parallel comps)
  //   3. The subject card has a `set` from Card Hedge identity
  // This block is purely ADDITIVE — surfaces as a separate response field
  // `predictedRangePhase3`; it never mutates `predictedRangeResult`.
  let predictedRangePhase3: (TierAnchoredResult & {
    peerPoolDiagnostics: ReturnType<typeof __extractPhase3Diags>;
  }) | null = null;
  try {
    const phase3Enabled = String(process.env.COMPIQ_PHASE3_TIER_ANCHORED ?? "")
      .trim()
      .toLowerCase() === "true";
    const phase2NullRange =
      predictedRangeResultLocal.predictedRange.low === null &&
      predictedRangeResultLocal.predictedRange.high === null;
    const subjectSet = (cardIdentity?.set ?? "").trim();
    if (phase3Enabled && phase2NullRange && subjectSet) {
      const subjectIsAuto = body.isAuto === true || (normalizedParallel ?? "").toLowerCase().includes("auto");
      const lookup = getParallelAttributesLookup();
      const peerPoolResult = await buildPeerPool({
        subjectPlayer: cardIdentity?.player ?? body.playerName ?? "",
        subjectSet,
        subjectParallelName: normalizedParallel ?? body.parallel ?? null,
        subjectIsAutograph: subjectIsAuto,
        comps: (fetched.comps ?? []).map((s) => ({
          price: s.price,
          title: s.title ?? "",
          soldDate: s.soldDate ?? null,
        })),
        lookup,
      });
      const tierResult = computeTierAnchoredRange({
        subjectTier: peerPoolResult.subjectTier,
        subjectRegime: regimeClassificationResult.regime ?? null,
        peerPool: peerPoolResult.peerPool,
      });
      predictedRangePhase3 = {
        ...tierResult,
        peerPoolDiagnostics: __extractPhase3Diags(peerPoolResult.diagnostics),
      };
      console.log(
        `[compiq.computeEstimate] Phase 3 tier-anchored fallback: ` +
          `subject="${subjectSet}" parallel="${normalizedParallel ?? "Base"}" ` +
          `subjectTier=${peerPoolResult.subjectTier} peers=${peerPoolResult.peerPool.length} ` +
          `range=${tierResult.predictedRange === null ? "null" : `$${tierResult.predictedRange.low}-$${tierResult.predictedRange.high}`} ` +
          `nullReason=${tierResult.diagnostics.nullReason ?? "none"}`,
      );
    }
  } catch (phase3Err) {
    // Defensive: never let Phase 3 block a price prediction.
    console.warn(
      `[compiq.computeEstimate] Phase 3 fallback failed:`,
      (phase3Err as Error)?.message ?? phase3Err,
    );
    predictedRangePhase3 = null;
  }

  // ── TrendIQ composite (Phase 1 B.4.a + B.4.b + B.4.c: all 3 layers) ────
  // Layer 2 reads from `trendCleanComps` — the exact-card pool with
  // EXCLUSION_KEYWORDS + outlier hits removed (CF-TREND-DIRTY-POOL,
  // 2026-06-08). Variants / parallels / serials are deliberately retained
  // — see computeCardTrajectory's coupling note (junk-excluded, variants
  // retained).
  // Layer 3 reads from siblingPool (sibling-sales only, exact excluded)
  // and uses the exact card's most-recent-sale timestamp (newestTs,
  // computed above) as the anchor. Re-anchor + pre-window resolution
  // documented in computeSegmentTrajectory header.
  const cardTrajectory = computeCardTrajectory(
    trendCleanComps.map((c) => ({ price: c.price, soldDate: c.soldDate })),
  );
  // CF-TRENDIQ-SURFACES (2026-06-03): same windowing, byte-identical
  // component for composite math; .full is consumed only when caller
  // opted into the /trendiq/full capture hook.
  const segMain = computeSegmentTrajectoryAndFull(siblingPool, newestTs);
  const segmentTrajectory = segMain.component;
  options.captureSegmentTrajectoryFull?.(segMain.full);
  const trendIQ = computeTrendIQ({
    playerMomentum,
    cardTrajectory,
    segmentTrajectory,
  });
  console.log(formatTrendIQLogLine(trendIQ));

  // CF-NEXT-SALE-PREDICTION-LAYER (design d531939) — operationalize
  // TrendIQ as a bounded forward projection on fairMarketValue. Coverage
  // "insufficient" → factor 1.0 → predictedPrice equals fairMarketValue
  // (graceful degradation). Mechanism 1 (multiplier-anchored) preserved
  // in the variant-mismatch and no-recent-comps fallback paths above.
  const __predicted = computePredictedPrice(
    typeof fairMarketValue === "number" ? fairMarketValue : null,
    trendIQ,
  );

  // Structured event log for the ML training corpus.
  // CF-PREDICTION-CORPUS STEP 1 (cardId emission, prior commit) added
  // cardId so the corpus's join axis to outcomes is clean from
  // day 1. CF-PREDICTION-CORPUS STEP 2 (this commit) added the Cosmos
  // writer consuming the same emit object verbatim per methodology §2.2.
  //
  // DUAL-EMIT BURN-IN per methodology §2.4: stdout emission preserved
  // alongside the Cosmos write. After confirmed live for one week, drop
  // the stdout in a separate CF.
  //
  // The corpus call MUST be non-blocking and MUST share the SAME emit
  // object the stdout serializes — so the two emissions stay shape-
  // identical and the corpus inherits zero parsing cost. Do NOT await
  // the corpus call (writePredictionLog is fire-and-forget; returns void).
  // CF-PREDICTION-CORPUS-EMISSION-COVERAGE: main-path success emit via the
  // unified helper. Replaces the prior inline payload construction. Same
  // payload shape; the helper adds `fmvMechanism`, `surfacedPrice`,
  // `surfacedPriceSource`.
  //
  // CF-PINNED-PARALLEL-RECOVERY (2026-06-11) corpus guard: exclude FMV
  // from training when the value-path consumed a TITLE-MATCH-LOW-SAMPLE
  // pool (recovery isolated 1-2 comps). The on-screen FMV is honest
  // display data with the "approximate" priceSource disclosing the
  // thin sample, but a 1-2-comp value isn't a robust ground-truth
  // realizedReturn anchor — joining it back through the corpus would
  // teach the model on noise. Same structural fmv=null gate as
  // CF-TREND-EXTRAPOLATED's display-not-train discipline.
  //
  // TITLE-MATCHED-PARALLEL (≥3 comps post-recovery) stays trainable —
  // that's a clean isolated pool large enough to anchor a realized
  // return.
  // CF-A(a): T3 ladder anchored on base-auto comps for a parallel request
  // is a labeled estimate — NOT a training-eligible observed FMV. Emit
  // corpus.fairMarketValue=null so the accuracy track excludes the row
  // (mirroring title-match-low-sample's exclusion intent). The local
  // `fairMarketValue` variable stays unchanged for the engine's internal
  // band/confidence/selling-guidance computations; only the corpus +
  // wire-response views null it out.
  const corpusFmv =
    fetched.priceSourceInternal === "title-match-low-sample"
      ? null
      : chosenTier === "T3"
      ? null
      : typeof fairMarketValue === "number"
      ? fairMarketValue
      : null;
  emitPredictionToCorpus({
    cardIdentity: cardIdentity ? { card_id: cardIdentity.card_id ?? null } : null,
    body,
    fairMarketValue: corpusFmv,
    fmvMechanism: "main-pipeline",
    predictedPrice: __predicted.predictedPrice,
    predictedPriceRange: __predicted.predictedPriceRange,
    predictedPriceMechanism: __predicted.predictedPriceAttribution.mechanism,
    forwardProjectionFactor: __predicted.forwardProjectionFactor,
    trendIQ,
    compsUsed: comps.length,
    callContext,
  });

  // CF-VARIANT-FILTER-LOOSENING (Q2 lock): when the tier ladder selected
  // T1/T2/T3, override the orchestrator's verdict with the tier-specific
  // annotation so the iOS UI surfaces variant uncertainty without needing
  // new response-shape plumbing. T0 keeps the orchestrator's verdict.
  const tierVerdictOverride = VARIANT_TIER_VERDICT[chosenTier];
  const verdictText = tierVerdictOverride ?? result.verdict ?? "Hold";

  // CF-PRICEHISTORY-60D (2026-06-10): build the 60-day chart series for
  // the comp page. Display-only — never flows into emitPredictionToCorpus
  // (verified: corpus emit at L3912 doesn't accept recentComps or
  // priceHistory). Independent of the value path: the 21d filter +
  // ladder + value-path quality filter above run untouched, and a
  // separate 60d window is matched against the SAME tier the 21d path
  // chose (no re-laddering — see CF-PRICEHISTORY-60D recon Q1: a richer
  // 60d count would land a broader tier and the chart's sub-market
  // would diverge from the FMV's).
  //
  // Quality split: keyword/identity exclusions stay full-strength
  // (lot/damage/wrong-card junk dropped uniformly across 0-60d).
  // Price-outlier trim is a LOOSE ratio backstop only — preserves real
  // dispersion so the trend line reflects what actually happened.
  // Post-tier parallel/auto/grade filters mirror the value path.
  // Downsample to 150 evenly across the date span when >150.
  const priceHistory: Array<{
    soldDate: string;
    price: number;
    listingType: "fixed" | "auction" | null;
  }> = (() => {
    if (!cardIdentity) return [];
    const windowed60 = applyRecencyFilter(fetched.comps, 60);
    if (windowed60.length === 0) return [];
    const tiered60 = classifyCompsForTier(windowed60, parsedForGuard, chosenTier).matched;
    if (tiered60.length === 0) return [];
    // Quality split: keyword full-strength via scoreCompQuality (same as
    // value path); outlier replaced with loose ratio-band typo backstop.
    const keywordPassed: RawComp[] = [];
    for (const c of tiered60) {
      const verdict = scoreCompQuality(c, {
        player: cardIdentity?.player ?? body.playerName ?? null,
        year: cardIdentity?.year ?? body.cardYear ?? null,
        set: cardIdentity?.set ?? body.product ?? null,
      });
      if (verdict.include) keywordPassed.push(c);
    }
    const typoFiltered = loosePriceTypoFilter(keywordPassed);
    // Mirror the value-path post-quality filters in the same order:
    // (1) serial filter when no parallel requested, (2) parallel match,
    // (3) auto match, (4) grade match. Reuse the local helpers defined
    // upthread so the predicates can never drift from the value path.
    let pool60: RawComp[] = hasParallel
      ? typoFiltered
      : typoFiltered.filter((c) => !serialPattern.test(c.title));
    if (pool60.length < 3) pool60 = typoFiltered;
    if (normalizedParallel && normalizedParallel !== "base") {
      pool60 = applyParallelFilter(pool60, normalizedParallel);
    }
    if (effectiveIsAuto) pool60 = applyAutoFilter(pool60);
    if (normalizedGradeCompany && body.gradeValue !== undefined) {
      pool60 = applyGradeFilter(pool60, `${normalizedGradeCompany} ${body.gradeValue}`);
    }
    // Sort ascending by soldDate so downsample preserves temporal endpoints.
    const sorted = pool60
      .filter((c) => {
        if (!c.soldDate) return false;
        const ts = Date.parse(c.soldDate);
        return Number.isFinite(ts) && ts > 0;
      })
      .sort((a, b) => (Date.parse(a.soldDate || "") || 0) - (Date.parse(b.soldDate || "") || 0));
    const capped = sorted.length > 150 ? evenlyDownsample(sorted, 150) : sorted;
    return capped.map((c) => ({
      soldDate: c.soldDate || "",
      price: c.price,
      listingType:
        c.listingType === "fixed" || c.listingType === "auction" ? c.listingType : null,
    }));
  })();

  // CF-FMV-NOWCAST Ship 1: per-FMV uncertainty band. Inputs live in scope
  // here from the broaderTrend block above + daysSinceNewest from L2007.
  // The band is additive — the FMV composition itself is unchanged.
  const mainFmvBand = computeFmvBand(
    typeof fairMarketValue === "number" ? fairMarketValue : null,
    {
      sampleCount: bwRecent + bwOlder,
      daysSinceNewest,
      basedOn: bwBasedOn,
      trendPct: bwTrendPct,
    },
  );

  // CF-A(a) — T3 BASE-AUTO FLOOR RE-BUCKET: when the variant tier ladder
  // selected T3 (loosest tier — accepts parallel_mismatch + print_run_mismatch),
  // the FMV is anchored on base-auto comps for a parallel/serialed request.
  // That's a labeled estimate, not an observed market value. Re-bucket the
  // dollars from fairMarketValue → estimatedValue + valuationStatus="estimated"
  // so the writer and Phase 5 route them as estimated. T0/T1/T2 unchanged.
  //
  // CF-X COLLISION RESOLUTION (2026-06-20): on T3 success, also call the
  // multiplier-anchored mechanism. When mechanism1 produces a non-null
  // predicted price (subject's parallel is curated AND ≥3 curated peer
  // parallels exist), it wins over the T3 base-auto floor. Reasoning:
  //
  //   - T3 base-auto is anchored on the WRONG comp pool (base autos for
  //     a parallel/serialed request). Known-weak estimate.
  //   - Multiplier-anchored uses peer sibling-parallel comps × subject's
  //     curated multiplier. Empirically grounded for the specific parallel.
  //   - When both are available, multiplier carries more parallel-specific
  //     signal. T3 base-auto is a strict downgrade.
  //
  // When mechanism1 returns null (uncurated parallel OR insufficient peer
  // pool), the T3 base-auto path fires exactly as CF-A(a) shipped.
  // estimateBasis distinguishes the path the iOS badge surfaces.
  const isT3Eligible = chosenTier === "T3" && typeof fairMarketValue === "number";
  let collisionM1: MultiplierAnchoredPredictedPriceResult | null = null;
  // CF-DECOUPLE (2026-06-21): null-safe product classification.
  // CF-BUILD-B (2026-06-21): hoisted out of the `if (isT3Eligible)` block
  // so the Build B fallback below can reuse it.
  // CF-DECOUPLE-2 (2026-06-21): null-safe subset normalization, also hoisted.
  const collisionSubjectProduct = classifyBowmanFamilyProduct(body.product);
  const collisionSubjectSubset: BowmanFamilySubset | null = normalizeCardsightSetName(fetched.card?.set ?? null);
  if (isT3Eligible) {
    if (collisionSubjectProduct !== null && collisionSubjectSubset !== null) {
      collisionM1 = computeMultiplierAnchoredPredictedPrice({
        subject: {
          playerName: body.playerName ?? fetched.card?.player ?? "",
          year: Number(body.cardYear ?? fetched.card?.year ?? 0),
          product: collisionSubjectProduct,
          subset: collisionSubjectSubset,
          parallelName: normalizedParallel ?? body.parallel ?? "",
          isAutograph: effectiveIsAuto,
        },
        comps: fetched.comps.map((c) => ({
          title: c.title,
          price: c.price,
          soldDate: c.soldDate,
        })),
      });
    }
  }
  // CF-X COLLISION GATE (2026-06-20 — owner-locked): multiplier wins over
  // the T3 base-auto floor ONLY when the subject row is `provenance:
  // "empirical"`. Sibling-provisional multipliers (X-Fractor rainbow
  // placeholders; values curated by analogy to known sibling parallels)
  // are analogy guesses — they fire where there's no alternative (the
  // variant-mismatch short-circuit path) but they DON'T override a real-
  // data base-auto floor in the collision. The base-auto floor uses real
  // sales from a wrong pool — known-low but grounded; a sibling-
  // provisional multiplier is grounded in an analogy that may or may not
  // hold. Don't trade real-if-wrong for guess-that-might-be-better.
  //
  // To flip a placeholder row into the collision-winner: re-curate it as
  // `provenance: "empirical"` once you have direct X-Fractor sales data.
  // No code change required — the gate reads the row's provenance flag.
  const m1HasPrice = collisionM1 !== null && collisionM1.predictedPrice !== null;
  const m1IsEmpirical =
    collisionM1?.predictedPriceAttribution.subjectProvenance === "empirical";
  const m1Wins = m1HasPrice && m1IsEmpirical;

  // CF-BUILD-B (2026-06-21): Build B fallback in the T3 collision path.
  // Slots BETWEEN mechanism1.empirical-win and the CF-A(a) base_auto_floor:
  //   mechanism1.empirical wins → Build B (empirical baseRelativePremium) → base_auto_floor → null
  // Dormant at ship (zero rows carry sampleBaseRange); activates per-tier
  // as worksheet PRs land empirical baseRelativePremium values.
  // CF-DECOUPLE-2 (2026-06-21): same null-safe collisionSubjectSubset.
  let collisionBuildB: BaseAnchoredFmvResult | null = null;
  if (isT3Eligible && !m1Wins && collisionSubjectProduct !== null && collisionSubjectSubset !== null) {
    collisionBuildB = computeBaseAnchoredParallelFMV({
      subject: {
        playerName: body.playerName ?? fetched.card?.player ?? "",
        year: Number(body.cardYear ?? fetched.card?.year ?? 0),
        product: collisionSubjectProduct,
        subset: collisionSubjectSubset,
        parallelName: normalizedParallel ?? body.parallel ?? "",
      },
      comps: fetched.comps.map((c) => ({ title: c.title, price: c.price })),
    });
  }
  const buildBWins = collisionBuildB !== null && collisionBuildB.isEstimate;
  const isT3BuildB = isT3Eligible && !m1Wins && buildBWins;
  const isT3BaseAuto = isT3Eligible && !m1Wins && !buildBWins;
  const isT3MultEstimate = isT3Eligible && m1Wins;
  const isAnyEstimate = isT3BaseAuto || isT3MultEstimate || isT3BuildB;

  const responseFmv: number | null = isAnyEstimate
    ? null
    : (typeof fairMarketValue === "number" ? fairMarketValue : null);
  const responseFmvLow: number | null = isAnyEstimate ? null : mainFmvBand.low;
  const responseFmvHigh: number | null = isAnyEstimate ? null : mainFmvBand.high;
  const responseEstimatedValue: number | null =
    isT3MultEstimate ? (collisionM1!.predictedPrice as number) :
    isT3BuildB ? collisionBuildB!.estimatedValue :
    isT3BaseAuto ? (fairMarketValue as number) :
    null;
  const responseEstimateLow: number | null =
    isT3MultEstimate ? (collisionM1!.predictedPriceRange?.low ?? null) :
    isT3BuildB ? collisionBuildB!.estimateLow :
    isT3BaseAuto ? mainFmvBand.low :
    null;
  const responseEstimateHigh: number | null =
    isT3MultEstimate ? (collisionM1!.predictedPriceRange?.high ?? null) :
    isT3BuildB ? collisionBuildB!.estimateHigh :
    isT3BaseAuto ? mainFmvBand.high :
    null;
  const responseValuationStatus: "observed" | "estimated" = isAnyEstimate ? "estimated" : "observed";
  const responseEstimateBasis: string | null =
    isT3MultEstimate
      ? (collisionM1!.predictedPriceAttribution.subjectProvenance === "sibling_provisional"
          ? "multiplier_provisional"
          : "multiplier")
      : isT3BuildB ? collisionBuildB!.estimateBasis
      : (isT3BaseAuto ? "base_auto_floor" : null);
  const responseEstimateConfidence:
    | "estimate" | "rough" | "ballpark" | "no-data" | "insufficient" | null =
    isT3BuildB ? collisionBuildB!.confidence :
    isAnyEstimate ? "rough" : null;
  const responseIsEstimate: boolean = isAnyEstimate;

  return {
    cardTitle,
    verdict: verdictText,
    action: result.action ?? "Hold",
    dealScore: result.dealScore ?? 50,
    quickSaleValue,
    fairMarketValue: responseFmv,
    fairMarketValueLow: responseFmvLow,
    fairMarketValueHigh: responseFmvHigh,
    marketValue: responseFmv,
    // CF-A(a): T3 re-bucket fields. populated only when chosenTier==="T3"
    // AND the engine computed a positive fairMarketValue from the base-auto
    // pool. T0/T1/T2 and the variant-mismatch short-circuit emit nulls here.
    estimatedValue: responseEstimatedValue,
    estimateLow: responseEstimateLow,
    estimateHigh: responseEstimateHigh,
    estimateConfidence: responseEstimateConfidence,
    estimateBasis: responseEstimateBasis,
    isEstimate: responseIsEstimate,
    valuationStatus: responseValuationStatus,
    predictedPrice: __predicted.predictedPrice,
    predictedPriceRange: __predicted.predictedPriceRange,
    predictedPriceAttribution: __predicted.predictedPriceAttribution,
    signalsLastUpdated: trendIQ.lastUpdated,
    premiumValue,
    trendIQ,
    explanation: result.explanationBullets?.length
      ? result.explanationBullets
      : ["Estimate based on available market data."],
    marketDNA: {
      demand: demandMap[dna.demand] ?? "Medium",
      speed: speedMap[marketSpeed] ?? "Normal",
      risk: riskMap[dna.risk] ?? "Medium",
      trend: trendMap[dna.trend] ?? "Flat",
      marketCondition: pressureMap[marketPressure] ?? "Balanced Market",
    },
    marketRegime: regime,
    // Issue #25 Phase 1 — read-only regime classifier. NO pricing math reads
    // from this field; it is surfaced on the API response only.
    regimeClassification: regimeClassificationResult,
    // Issue #25 Phase 2 — read-only predicted range. NO pricing math reads
    // from this field; it is surfaced on the API response only.
    predictedRangeResult: predictedRangeResultLocal,
    // Issue #25 Phase 3 — tier-anchored fallback range. Populated ONLY when
    // env flag COMPIQ_PHASE3_TIER_ANCHORED=true AND Phase 2 returned a null
    // range. Null in all other cases. NO pricing math reads from this field.
    predictedRangePhase3,
    normalization: {
      parallelInput: body.parallel ?? null,
      parallelCanonical: normalizedParallel ?? null,
      gradeCompanyInput: body.gradeCompany ?? null,
      gradeCompanyCanonical: normalizedGradeCompany ?? null,
    },
    confidence: { pricingConfidence, liquidityConfidence, timingConfidence },
    exitStrategy: {
      recommendedMethod: result.exitStrategy?.recommendedMethod ?? "auction",
      expectedDaysToSell: result.exitStrategy?.expectedDaysToSell ?? null,
      timingRecommendation:
        result.exitStrategy?.timingRecommendation ?? "List when market activity increases.",
    },
    freshness: {
      status: freshnessStatus,
      lastUpdated: comps.length > 0 ? now : null,
    },
    pricingAnalytics: context.trendProjection || context.anchorModel
      ? {
          projectedNextSale: context.trendProjection?.projectedPrice ?? null,
          trendSlope: context.trendProjection?.slope ?? null,
          rSquared: context.trendProjection?.rSquared ?? null,
          projectionConfidence: context.trendProjection?.confidence ?? null,
          anchorModel: context.anchorModel ?? null,
          compPoolDebug: context.compPoolDebug ?? null,
        }
      : null,
    broaderTrend,
    buyWindowScore: buyWindow.score,
    buyWindowLabel: buyWindow.label,
    buyWindowReasons: buyWindow.reasons,
    confidenceInterval,
    sellingGuidance,
    crossParallelAnchor,
    // CF-A(a): effectiveFmv mirrors fairMarketValue's T3 nullification so
    // downstream consumers reading effectiveFmv don't see a value the
    // engine has classified as estimated rather than observed.
    effectiveFmv: responseFmv,
    compQuality: compQualityInfo,
    graderPremium: {
      applied: targetPremium,
      company: normalizedGradeCompany ?? null,
      grade: body.gradeValue ?? null,
      normalizedAnchor: normalizedAnchorRaw,
    },
    dataSufficiency,
    // CF-A(a): legacy `estimate` field tracks the same response FMV.
    estimate: responseFmv,
    compsUsed: comps.length,
    // CF-COMP-TITLE-EXCLUSIONS-EXPAND (2026-06-07): surface the
    // pre-quality-filter Cardsight count as the denominator iOS shows
    // ("23 of 25 available"). The delta = comps Cardsight had for this
    // card that the quality filter removed (lot sales, damage/condition
    // disclaimers, etc.). recencyFilteredComps is the right anchor —
    // it represents trustworthy comps WITHIN the recency window before
    // any condition-quality cuts kicked in.
    compsAvailable: recencyFilteredComps.length,
    cardIdentity,
    recentComps: ((): Array<Record<string, unknown>> => {
      // CF-RECENTCOMPS-BELOWMARKET (2026-06-08): compute a local BIN
      // median from THIS comp pool so the belowMarket badge reflects
      // the same $X-ish anchor the marketRead factPack reports. 14d
      // window mirrors the marketRead window. originalPrice (the user-
      // facing display price) is the right anchor; normalized `price`
      // would mix grade-adjusted values into the threshold.
      //
      // belowMarket emits ONLY on this live happy-path site. The three
      // fallback paths (variant-mismatch / no-recent-comps / sibling-
      // pool) hold too thin a pool to anchor a benchmark — they skip
      // emission. Field omitted (not false) when the threshold can't
      // be computed, matching the saleType / imageUrl omit semantics.
      const cutoff14d = Date.now() - 14 * 24 * 3600 * 1000;
      const binPrices14d = comps
        .filter((c) => c.listingType === "fixed")
        .filter((c) => {
          const ts = Date.parse(c.date || "");
          return Number.isFinite(ts) && ts >= cutoff14d;
        })
        .map((c) => c.originalPrice)
        .sort((a, b) => a - b);
      let binMedianLocal: number | null = null;
      if (binPrices14d.length >= 2) {
        const n = binPrices14d.length;
        binMedianLocal =
          n % 2 === 0
            ? (binPrices14d[n / 2 - 1] + binPrices14d[n / 2]) / 2
            : binPrices14d[Math.floor(n / 2)];
      }
      const belowMarketThreshold =
        binMedianLocal !== null && binMedianLocal > 0 ? binMedianLocal * 0.65 : null;

      return comps
        .slice()
        .sort((a, b) => {
          const ta = Date.parse(a.date || "") || 0;
          const tb = Date.parse(b.date || "") || 0;
          return tb - ta;
        })
        .slice(0, 10)
        .map((c) => {
          const entry: Record<string, unknown> = {
            // Display the ORIGINAL Card Hedge sale price (not the post-
            // normalizeCompToRaw raw-equivalent intermediate). See issue #24.
            price: c.originalPrice,
            title: c.title,
            soldDate: c.date,
            grade: formatGradeLabel(c.title),
            // CF-RECENTCOMPS-SALETYPE (2026-06-08): emit "Buy It Now" /
            // "Auction" / omit, derived from Cardsight's listing_type.
            saleType: saleTypeFromListingType(c.listingType),
            // CF-RECENTCOMPS-IMAGEURL (2026-06-08): pass-through thumbnail
            // URL when present; omit when null so iOS uses a placeholder.
            imageUrl: c.imageUrl ?? undefined,
          };
          if (belowMarketThreshold !== null) {
            entry.belowMarket = c.originalPrice < belowMarketThreshold;
          }
          return entry;
        });
    })(),
    // CF-PRICEHISTORY-60D (2026-06-10): 60-day series for the comp-page
    // chart. Display-only — never enters the corpus emit at L3912.
    // Built upthread; coexists with recentComps as an independent surface.
    priceHistory,
    gradeUsed: cardHedgeGrade,
    source: comps.length > 0 ? "live" : "fallback",
    // CF-LASTSALE-SCAFFOLD (2026-06-10): mirror the insufficient branch.
    // daysSinceNewestComp + lastSale derive from the SAME record in the
    // unwindowed post-(grade + parallel) pool. estimateSource is
    // "observed" when a numeric marketValue is present, "last-sale" as
    // a fallback when fmv is null but a lastSale exists.
    daysSinceNewestComp: daysSinceNewest,
    lastSale,
    // CF-CH-P8-TESTS: surface CH provenance on the response when CH served.
    // corpusMapping reads these alongside estimateSource to build the
    // chProvenance block on the corpus row. Omitted when vendor !== cardhedge.
    chCardId: fetched.vendor === "cardhedge" ? fetched.chCardId : undefined,
    chTrustReason: fetched.vendor === "cardhedge" ? fetched.chTrustReason : undefined,
    // CF-CH-THIN-COMP-PRIMARY (2026-06-26): same compCount surfaced on the
    // success path (n>=2 CH-served — "cardhedge" estimateSource). iOS uses
    // it for "via N comp(s)" rendering even when FMV lands; corpus row's
    // chProvenance.compCount tracks the source's depth for analytics.
    chCompCount: fetched.vendor === "cardhedge" ? fetched.comps.length : undefined,
    // CF-ESTIMATE-SOURCE-VENDOR-NEUTRAL (2026-07-04): "cardhedge" →
    // "live-market". Internal `fetched.vendor === "cardhedge"` gate
    // keeps its internal name (mechanism identifier — never wire-facing).
    estimateSource:
      typeof fairMarketValue === "number"
        ? (fetched.vendor === "cardhedge" ? ("live-market" as const) : ("observed" as const))
        : lastSale !== null
        ? ("last-sale" as const)
        : null,
    // CF-TREND-EXTRAPOLATED (2026-06-10): legacy estimateRange field for
    // the last-sale fallback path. The success path doesn't populate it.
    // CF-A(a) (2026-06-20): estimatedValue and estimateBasis are now
    // declared above the return as part of the T3 re-bucket; they MUST
    // NOT be re-emitted here as nulls because that would clobber the
    // T3 value with null at object-spread evaluation.
    estimateRange: null,
    variantWarning: fetched.variantWarning,
    // CF-CARDSIGHT-RESOLVER-REDESIGN: parallel-match attribution. iOS
    // reads `priceSource` (3-category: exact / approximate / broad).
    // `priceSourceInternal` is the 7-value telemetry detail; included on
    // response for ops debugging but not part of the iOS contract.
    // `parallelMatchFilteredCount` / `parallelMatchUnifiedCount` enable
    // "N of M comps" disclosure when the user sees approximate/broad.
    priceSource: fetched.priceSource ?? null,
    priceSourceInternal: fetched.priceSourceInternal ?? null,
    parallelMatchFilteredCount: fetched.parallelMatchFilteredCount ?? null,
    parallelMatchUnifiedCount: fetched.parallelMatchUnifiedCount ?? null,
  };
  });  // close cacheStatsContext.run callback (PHASE-4A-2.2)
}

export async function simulateWhatIf(body: {
  playerName: string;
  cardYear?: number;
  product?: string;
  parallel?: string;
  gradeCompany?: string;
  gradeValue?: number;
  isAuto?: boolean;
  buyPrice?: number;
  holdDays?: number;
  feePct?: number;
  shippingCost?: number;
}): Promise<Record<string, unknown>> {
  const estimate = await computeEstimate({
    playerName: body.playerName,
    cardYear: body.cardYear,
    product: body.product,
    parallel: body.parallel,
    gradeCompany: body.gradeCompany,
    gradeValue: body.gradeValue,
    isAuto: body.isAuto,
  }, {
    // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): public what-if route,
    // no authenticated user upstream, never holding-routed.
    source: "compiq-simulate-whatif",
    userId: null,
    holdingId: null,
    routedFromHolding: false,
  });

  const buyPrice = Math.max(0.01, Number(body.buyPrice ?? (estimate.fairMarketValue as number) ?? 0));
  const holdDays = Math.max(1, Math.min(365, Number(body.holdDays ?? 45)));
  const feePct = Math.max(0, Math.min(0.3, Number(body.feePct ?? 0.12)));
  const shippingCost = Math.max(0, Number(body.shippingCost ?? 5));

  const fair = Number(estimate.fairMarketValue ?? 0);
  const regime = (estimate.marketRegime as RegimeSummary | undefined) ?? {
    regime: "stable",
    volatilityPct: 15,
    slopePctPerComp: 0,
    confidence: 0.5,
    note: "Default regime",
  };

  const driftByRegime: Record<RegimeSummary["regime"], number> = {
    momentum: 0.06,
    "mean-reversion": -0.03,
    illiquid: -0.01,
    stable: 0.02,
  };
  const horizonFactor = holdDays / 30;
  const drift = driftByRegime[regime.regime] * horizonFactor;
  const sigma = (regime.volatilityPct / 100) * Math.sqrt(Math.max(0.5, horizonFactor));

  const base = Math.max(1, fair * (1 + drift));
  const bear = Math.max(1, base * (1 - Math.max(0.05, sigma * 0.8)));
  const bull = Math.max(base, base * (1 + Math.max(0.06, sigma)));

  function scenario(price: number) {
    const gross = price;
    const net = gross * (1 - feePct) - shippingCost;
    const pnl = net - buyPrice;
    const roiPct = buyPrice > 0 ? (pnl / buyPrice) * 100 : 0;
    return {
      projectedSalePrice: Number(gross.toFixed(2)),
      projectedNet: Number(net.toFixed(2)),
      pnl: Number(pnl.toFixed(2)),
      roiPct: Number(roiPct.toFixed(2)),
    };
  }

  return {
    assumptions: {
      buyPrice,
      holdDays,
      feePct,
      shippingCost,
      regime: regime.regime,
      regimeConfidence: regime.confidence,
    },
    scenarios: {
      bear: scenario(bear),
      base: scenario(base),
      bull: scenario(bull),
    },
    estimate,
  };
}

// CF-VARIANT-FILTER-BACKTEST — restricted header override.
//
// Honors `x-variant-tier-ladder: disabled` ONLY when the request is from
// the admin-testing-hobbyiq user OR NODE_ENV is not "production". In all
// other production requests the header is silently ignored and the env
// flag governs. This keeps the header strictly a harness/diagnostic
// surface — it cannot be exploited to alter pricing in normal production
// traffic.
async function isTierLadderHeaderAuthorized(req: Request): Promise<boolean> {
  const headerVal = String(req.headers["x-variant-tier-ladder"] ?? "")
    .trim()
    .toLowerCase();
  if (headerVal !== "disabled") return false;

  const isProd =
    String(process.env.NODE_ENV ?? "").trim().toLowerCase() === "production";
  if (!isProd) return true;

  // Production path: require admin-testing-hobbyiq session.
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) return false;
  try {
    const user = await getUserBySession(sessionId);
    return user?.userId === "admin-testing-hobbyiq";
  } catch {
    return false;
  }
}

export async function compiqEstimate(req: Request, res: Response) {
  const tierLadderDisabledByHeader = await isTierLadderHeaderAuthorized(req);
  const data = await computeEstimate(req.body || {}, {
    // CF-PREDICTION-CORPUS-CALL-CONTEXT (2026-06-01): /api/compiq/estimate
    // is the structured-input direct estimate (iOS sends parsed fields).
    // Public route, no auth, never holding-routed.
    source: "compiq-estimate-structured",
    userId: null,
    holdingId: null,
    routedFromHolding: false,
  }, { tierLadderDisabledByHeader });
  // Stamp engine identity marker (pricingEngine / engineVersion / computedAt).
  // Non-breaking: existing clients ignore unknown JSON fields.
  //
  // Corpus wiring status: the Tier 3 collector (PR #2b) wires the free-text
  // query endpoints (/search, /price, /price-by-id, /bulk). /estimate is
  // deferred pending schema support for structured-input corpus rows
  // (querySource: "structured" — separate PR). See followup queue. The
  // synthesize-free-text approach was rejected because it would pollute
  // the training set with fake free-text rows that don't represent real
  // user input.
  res.json({ ...data, ...buildEngineMeta() });
}
