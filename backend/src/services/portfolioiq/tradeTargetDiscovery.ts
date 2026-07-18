// CF-TRADE-TARGET-DISCOVERY (Drew, 2026-07-17). Pure math for spotting
// listings whose asking price is meaningfully below the engine's
// estimate — potential undervalued buys.
//
// For each active eBay listing we know about, compare its asking
// price to the engine's estimate for the same card. Rank by
// discount percentage. Rule out listings we don't have engine
// coverage for (no comparison possible).

export interface TradeTargetListing {
  id: string;
  cardId: string;
  cardTitle: string;
  playerName: string;
  askPrice: number;
  imageUrl: string | null;
  listingUrl: string;
  sellerUsername: string;
  sellerFeedbackScore: number | null;
  /** Engine's estimate for this specific card. */
  engineMarketValue: number | null;
  enginePredictedPrice: number | null;
  /** True when the engine's estimate is a compound-multiplier
   *  guestimate (PR #545) — we soften the buy signal here because
   *  the engine value itself carries wider bands. */
  isGuestimate: boolean;
  /** Listing match-score signal from eBay active-listings ranker
   *  (higher = better match against the target SKU). */
  matchScore: number;
}

export interface TradeTargetResult {
  cardId: string;
  playerName: string;
  cardTitle: string;
  imageUrl: string | null;
  askPrice: number;
  engineValue: number;              // basis for comparison
  discountPct: number;              // 0..1 (0.20 = 20% below)
  discountAbsolute: number;          // engineValue - askPrice
  confidence: "high" | "medium" | "low";
  reason: string;
  listingUrl: string;
  seller: { username: string; feedbackScore: number | null };
}

export interface TradeTargetOptions {
  /** Minimum discount to surface as a candidate. Default 0.15 (15% below engine). */
  minDiscountPct?: number;
  /** Ceiling; anything below this is suspicious (broken listing, wrong item,
   *  seller scam). Default 0.60. */
  maxDiscountPct?: number;
  /** Ranker match-score minimum. Below this = skip (bad match). Default 40. */
  minMatchScore?: number;
  /** Cap results. Default 20. */
  limit?: number;
}

const DEFAULT_MIN_DISCOUNT = 0.15;
const DEFAULT_MAX_DISCOUNT = 0.60;
const DEFAULT_MIN_MATCH_SCORE = 40;
const DEFAULT_LIMIT = 20;

export function discoverTradeTargets(
  listings: TradeTargetListing[],
  opts: TradeTargetOptions = {},
): TradeTargetResult[] {
  const minDiscount = opts.minDiscountPct ?? DEFAULT_MIN_DISCOUNT;
  const maxDiscount = opts.maxDiscountPct ?? DEFAULT_MAX_DISCOUNT;
  const minMatchScore = opts.minMatchScore ?? DEFAULT_MIN_MATCH_SCORE;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const candidates: TradeTargetResult[] = [];

  for (const listing of listings) {
    if (listing.matchScore < minMatchScore) continue;
    if (!Number.isFinite(listing.askPrice) || listing.askPrice <= 0) continue;

    // Prefer marketValue over predictedPrice — MV is the "today"
    // benchmark, PredictedPrice is a forward projection. If MV is
    // absent (thin-comp SKU), fall back to predicted.
    const engineValue =
      listing.engineMarketValue !== null && listing.engineMarketValue > 0
        ? listing.engineMarketValue
        : listing.enginePredictedPrice !== null && listing.enginePredictedPrice > 0
        ? listing.enginePredictedPrice
        : null;
    if (engineValue === null) continue;   // no basis to compare

    const discountPct = 1 - listing.askPrice / engineValue;
    if (discountPct < minDiscount) continue;
    if (discountPct > maxDiscount) continue;   // suspicious deal

    // Confidence: guestimate → low (band is wider); high match + observed engine → high
    const confidence: TradeTargetResult["confidence"] =
      listing.isGuestimate ? "low" :
      listing.matchScore >= 80 ? "high" :
      "medium";

    const reason = buildReason(discountPct, confidence, listing);

    candidates.push({
      cardId: listing.cardId,
      playerName: listing.playerName,
      cardTitle: listing.cardTitle,
      imageUrl: listing.imageUrl,
      askPrice: round2(listing.askPrice),
      engineValue: round2(engineValue),
      discountPct: round4(discountPct),
      discountAbsolute: round2(engineValue - listing.askPrice),
      confidence,
      reason,
      listingUrl: listing.listingUrl,
      seller: {
        username: listing.sellerUsername,
        feedbackScore: listing.sellerFeedbackScore,
      },
    });
  }

  candidates.sort((a, b) => {
    // Prefer higher confidence, then higher discount, then higher match
    const confRank = { high: 3, medium: 2, low: 1 } as const;
    if (confRank[b.confidence] !== confRank[a.confidence]) {
      return confRank[b.confidence] - confRank[a.confidence];
    }
    return b.discountPct - a.discountPct;
  });

  return candidates.slice(0, limit);
}

function buildReason(
  discountPct: number,
  confidence: TradeTargetResult["confidence"],
  listing: TradeTargetListing,
): string {
  const pctText = `${Math.round(discountPct * 100)}% below engine`;
  const confidenceSuffix =
    confidence === "high" ? "high-confidence match" :
    confidence === "medium" ? "solid match" :
    "engine used guestimate — band is wide";
  const sellerSuffix =
    listing.sellerFeedbackScore !== null
      ? `seller @${listing.sellerUsername} (${listing.sellerFeedbackScore})`
      : `seller @${listing.sellerUsername}`;
  return `${pctText} · ${confidenceSuffix} · ${sellerSuffix}`;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

export const _DEFAULT_MIN_DISCOUNT = DEFAULT_MIN_DISCOUNT;
export const _DEFAULT_MAX_DISCOUNT = DEFAULT_MAX_DISCOUNT;
export const _DEFAULT_MIN_MATCH_SCORE = DEFAULT_MIN_MATCH_SCORE;
