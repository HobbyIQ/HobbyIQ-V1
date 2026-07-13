// CF-CATALOG-RESOLVER (2026-07-13): sold-comps vendor source plugin.
//
// Uses our OWN users' completed eBay sales as a pricing source. Every
// completed sale on our platform was Browse-enriched (PR #384) with the
// listing's aspects, so we have a rich structured comp pool. When CH has
// a catalog gap, our own sold pool might have priced the exact SKU
// already — that's the coverage-gap fix.
//
// Wraps the existing querySoldComps helper into the VendorSource
// interface. Uses aspect matching to pick the best comp for a query.

import type {
  CardQuery,
  CardResolution,
  VendorSource,
} from "./catalogResolver.service.js";
import { querySoldComps } from "../portfolioiq/ebaySoldComps.service.js";

/** Aggregate a set of sold comps into a single resolution:
 *   - fairMarketValue = median unit sale price
 *   - compCount = number of matching sales
 *   - freshestSaleDate = most recent sale */
function aggregate(comps: Awaited<ReturnType<typeof querySoldComps>>["comps"]): {
  fmv: number;
  freshest: string | null;
} {
  const prices = comps.map((c) => c.unitSalePrice).filter((p) => p > 0);
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? 0
    : sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const dates = comps.map((c) => c.soldAt).filter((d) => d);
  const freshest = dates.length === 0
    ? null
    : dates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return { fmv: Math.round(median * 100) / 100, freshest };
}

export const soldCompsVendorSource: VendorSource = {
  name: "sold-comps",
  async resolveCard(query: CardQuery): Promise<CardResolution | null> {
    // Cast into the sold-comps query shape.
    const gradeQuery = query.gradeCompany && query.gradeValue
      ? `${query.gradeCompany} ${query.gradeValue}`
      : query.gradeCompany;
    let result;
    try {
      result = await querySoldComps({
        year: query.cardYear,
        set: query.setName,
        parallel: query.parallel,
        grade: gradeQuery,
        playerName: query.playerName,
        cardNumber: query.cardNumber,
        isAuto: query.isAuto,
        cardId: query.cardId,
        limit: 20,
      });
    } catch {
      return null;
    }
    if (!result || result.count === 0) return null;
    const { fmv, freshest } = aggregate(result.comps);
    // Confidence: single perfect-match comp → high; 3+ comps → high;
    // 1-2 partial matches → medium; else low.
    const confidence =
      result.count >= 3 ? "high" :
      result.count >= 1 && result.comps[0].matchScore >= 0.85 ? "high" :
      result.count >= 1 ? "medium" : "low";
    // Sold-comps don't have a canonical cardId — use the first matching
    // comp's cardId if it exists (from PR #392+ pattern), else derive
    // a stable synthetic id from the aspects for cache/reconciliation.
    const cardId = (result.comps[0].ebayItemAspects?.["cardId"] as string)
      ?? `sold-comps:${query.cardYear ?? "?"}-${query.setName ?? "?"}-${query.playerName ?? "?"}-${query.parallel ?? "?"}`;
    return {
      vendor: "sold-comps",
      cardId,
      fairMarketValue: fmv,
      compCount: result.count,
      freshestSaleDate: freshest,
      confidence,
      raw: { stats: result.stats, count: result.count },
    };
  },
};
