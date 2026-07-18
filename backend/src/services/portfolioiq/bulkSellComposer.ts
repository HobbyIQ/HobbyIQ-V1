// CF-BULK-SELL-COMPOSER (Drew, 2026-07-17). Pure math for the
// multi-card bulk-sell composer. Given a set of holdings with their
// predicted prices, compute the "individual sale" strategy vs the
// "bundle sale" strategy and recommend which nets more.
//
// eBay fee model:
//   Sale price × (1 − eBay fee % − shipping absorption)
//   Bundle discount: typical seller offers 10-20% off retail to move
//   a lot; captured via BUNDLE_DISCOUNT_PCT (default 15%).
//
// The recommendation is per-holding: for each card, comparing the
// expected net revenue via individual vs bundle. Users pick which
// cards go into the bundle vs list individually.

export interface BulkSellHolding {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  predictedPrice: number | null;
  marketValue: number | null;
  purchasePrice: number | null;
}

export interface BulkSellComposerOptions {
  /** eBay fee (0..1). Default 0.13 (13% is typical seller fee tier). */
  ebayFeePct?: number;
  /** Bundle discount applied to sum of individual predicted prices to
   *  approximate what a buyer would pay for a lot. Default 0.15 (15%). */
  bundleDiscountPct?: number;
  /** Per-listing shipping cost the seller absorbs on individual sales
   *  (bundle is usually one ship cost). Default $5 per card individually,
   *  $12 for the bundle. */
  perCardShippingCost?: number;
  bundleShippingCost?: number;
}

export interface BulkSellHoldingRecommendation {
  holdingId: string;
  playerName: string;
  cardTitle: string;
  predictedPrice: number;
  individualNetProceeds: number;   // predicted × (1 − fee) − shipping
  bundleShareOfNet: number;         // this card's share of the bundle net
  netDelta: number;                  // individualNet − bundleShare (positive = list individually)
  strategy: "list_individually" | "add_to_bundle" | "skip_missing_predicted";
}

export interface BulkSellComposerResult {
  candidates: BulkSellHoldingRecommendation[];
  totals: {
    individualStrategyNet: number;   // all listed individually
    bundleStrategyNet: number;        // all combined into one bundle
    combinedNet: number;              // list individual = individually, add_to_bundle = bundle
    recommendedStrategy: "all_individual" | "all_bundle" | "mixed";
    projectedLift: number;            // combinedNet − max(individual, bundle)
  };
  assumptions: {
    ebayFeePct: number;
    bundleDiscountPct: number;
    perCardShippingCost: number;
    bundleShippingCost: number;
  };
}

const DEFAULT_EBAY_FEE_PCT = 0.13;
const DEFAULT_BUNDLE_DISCOUNT_PCT = 0.15;
const DEFAULT_PER_CARD_SHIPPING = 5;
const DEFAULT_BUNDLE_SHIPPING = 12;

export function composeBulkSell(
  holdings: BulkSellHolding[],
  opts: BulkSellComposerOptions = {},
): BulkSellComposerResult {
  const ebayFeePct = opts.ebayFeePct ?? DEFAULT_EBAY_FEE_PCT;
  const bundleDiscountPct = opts.bundleDiscountPct ?? DEFAULT_BUNDLE_DISCOUNT_PCT;
  const perCardShippingCost = opts.perCardShippingCost ?? DEFAULT_PER_CARD_SHIPPING;
  const bundleShippingCost = opts.bundleShippingCost ?? DEFAULT_BUNDLE_SHIPPING;

  // Filter to holdings with predicted prices (can't recommend without a target)
  const priced = holdings.filter((h) => typeof h.predictedPrice === "number" && h.predictedPrice > 0);
  const missing = holdings.filter((h) => !(typeof h.predictedPrice === "number" && h.predictedPrice > 0));

  const sumPredicted = priced.reduce((s, h) => s + (h.predictedPrice ?? 0), 0);
  const bundleGrossPrice = sumPredicted * (1 - bundleDiscountPct);
  const bundleNet = bundleGrossPrice * (1 - ebayFeePct) - bundleShippingCost;

  const individualStrategyNet = priced.reduce(
    (s, h) => s + individualNet(h.predictedPrice!, ebayFeePct, perCardShippingCost),
    0,
  );

  const candidates: BulkSellHoldingRecommendation[] = [];
  let combinedNet = 0;

  for (const h of priced) {
    const price = h.predictedPrice!;
    const indivNet = individualNet(price, ebayFeePct, perCardShippingCost);
    // bundle share proportional to this card's contribution to bundle gross
    const bundleShare = sumPredicted > 0 ? (price / sumPredicted) * bundleNet : 0;
    const netDelta = round2(indivNet - bundleShare);
    const strategy: BulkSellHoldingRecommendation["strategy"] =
      indivNet > bundleShare ? "list_individually" : "add_to_bundle";
    combinedNet += strategy === "list_individually" ? indivNet : bundleShare;
    candidates.push({
      holdingId: h.holdingId,
      playerName: h.playerName,
      cardTitle: h.cardTitle,
      predictedPrice: round2(price),
      individualNetProceeds: round2(indivNet),
      bundleShareOfNet: round2(bundleShare),
      netDelta,
      strategy,
    });
  }

  for (const h of missing) {
    candidates.push({
      holdingId: h.holdingId,
      playerName: h.playerName,
      cardTitle: h.cardTitle,
      predictedPrice: 0,
      individualNetProceeds: 0,
      bundleShareOfNet: 0,
      netDelta: 0,
      strategy: "skip_missing_predicted",
    });
  }

  const bothStrategiesEqualWithinDollar =
    Math.abs(individualStrategyNet - bundleNet) < 1;
  const allIndividual = candidates.every(
    (c) => c.strategy === "list_individually" || c.strategy === "skip_missing_predicted",
  );
  const allBundle = candidates.every(
    (c) => c.strategy === "add_to_bundle" || c.strategy === "skip_missing_predicted",
  );

  const recommendedStrategy: BulkSellComposerResult["totals"]["recommendedStrategy"] =
    bothStrategiesEqualWithinDollar ? "mixed" :
    allIndividual ? "all_individual" :
    allBundle ? "all_bundle" :
    "mixed";

  const projectedLift = round2(
    combinedNet - Math.max(individualStrategyNet, bundleNet),
  );

  return {
    candidates,
    totals: {
      individualStrategyNet: round2(individualStrategyNet),
      bundleStrategyNet: round2(bundleNet),
      combinedNet: round2(combinedNet),
      recommendedStrategy,
      projectedLift,
    },
    assumptions: {
      ebayFeePct,
      bundleDiscountPct,
      perCardShippingCost,
      bundleShippingCost,
    },
  };
}

function individualNet(price: number, feePct: number, shipping: number): number {
  return price * (1 - feePct) - shipping;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export const _DEFAULT_EBAY_FEE_PCT = DEFAULT_EBAY_FEE_PCT;
export const _DEFAULT_BUNDLE_DISCOUNT_PCT = DEFAULT_BUNDLE_DISCOUNT_PCT;
