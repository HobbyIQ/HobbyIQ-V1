// CF-CATALOG-RESOLVER (2026-07-13): CardHedge vendor source plugin.
//
// Wraps the existing searchCards helper into the VendorSource interface.
// This is thin — the actual CH API knowledge lives in cardhedge.client.ts.
// This adapter just maps CardQuery → searchCards args + response →
// CardResolution.
//
// CF-CH-VENDOR-RAW-COMPS (Drew, 2026-07-13, PR #408): once a candidate is
// identified, also pull CH's raw sales pool via getCardSales and emit them
// as ResolverComp[]. Closes the vendor-symmetry gap so downstream engine
// paths (grade rescue in PR #406, trend + prediction in PR #407) can
// operate on CH records the same way they do on Cardsight records.
// Graded comps are still left to CH's existing observedGradeCurve engine
// on the primary path — pulling per-grade sales here would add N round
// trips per resolve, and the primary path already covers that.

import type {
  CardQuery,
  CardResolution,
  ResolverComp,
  VendorSource,
  ResolutionConfidence,
} from "./catalogResolver.service.js";
import { searchCards, getCardSales } from "./cardhedge.client.js";

function buildQuery(q: CardQuery): string {
  const parts: string[] = [];
  if (q.cardYear) parts.push(String(q.cardYear));
  if (q.setName) parts.push(q.setName);
  if (q.playerName) parts.push(q.playerName);
  if (q.parallel) parts.push(q.parallel);
  if (q.cardNumber) parts.push(`#${q.cardNumber}`);
  return parts.join(" ").trim();
}

function scoreConfidence(q: CardQuery, candidate: any): ResolutionConfidence {
  let matches = 0;
  let checked = 0;
  if (q.cardYear && candidate.year) {
    checked++;
    if (Number(candidate.year) === q.cardYear) matches++;
  }
  if (q.cardNumber && candidate.number) {
    checked++;
    if (
      String(q.cardNumber).toLowerCase() === String(candidate.number).toLowerCase() ||
      String(candidate.number).toLowerCase().includes(String(q.cardNumber).toLowerCase())
    ) matches++;
  }
  if (q.parallel && candidate.variant) {
    checked++;
    const a = String(q.parallel).toLowerCase();
    const b = String(candidate.variant).toLowerCase();
    if (a === b || a.includes(b) || b.includes(a)) matches++;
  }
  if (checked === 0) return "low";
  const ratio = matches / checked;
  if (ratio >= 0.85) return "high";
  if (ratio >= 0.6) return "medium";
  return "low";
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const cardhedgeVendorSource: VendorSource = {
  name: "cardhedge",
  async resolveCard(query: CardQuery): Promise<CardResolution | null> {
    if (!query.playerName && !query.cardId) return null;
    const q = buildQuery(query);
    if (!q) return null;
    const filters = {
      player: query.playerName,
      set: query.setName,
      rookie: undefined,
    };
    let candidates;
    try {
      candidates = await searchCards(q, 5, filters);
    } catch {
      return null;
    }
    if (!candidates || candidates.length === 0) return null;
    const top = candidates[0];
    if (!top.card_id) return null;

    // CF-CH-VENDOR-RAW-COMPS (Drew, 2026-07-13, PR #408): pull CH's Raw
    // sales pool for the identified card. Best-effort — a failed fetch
    // still returns the identity resolution (so callers can see "CH
    // knows this card") with empty rawComps.
    let rawSales: Awaited<ReturnType<typeof getCardSales>> = [];
    try {
      rawSales = await getCardSales(top.card_id, "Raw", 30);
    } catch (err) {
      console.warn(JSON.stringify({
        event: "cardhedge_vendor_raw_sales_fetch_failed",
        source: "cardhedgeVendorSource",
        cardId: top.card_id,
        error: (err as Error)?.message ?? String(err),
      }));
    }

    const rawComps: ResolverComp[] = rawSales
      .filter((s) => typeof s.price === "number" && s.price > 0)
      .map((s) => ({
        saleDate: s.date ?? null,
        price: s.price,
        saleType: s.sale_type ?? undefined,
      }));

    const prices = rawComps.map((c) => c.price);
    const fmv = median(prices);
    const dates = rawComps
      .map((c) => c.saleDate)
      .filter((d): d is string => typeof d === "string" && d.length > 0)
      .sort();
    const freshestSaleDate = dates.length > 0 ? dates[dates.length - 1] : null;

    return {
      vendor: "cardhedge",
      cardId: top.card_id,
      fairMarketValue: fmv != null ? Math.round(fmv * 100) / 100 : null,
      compCount: rawComps.length,
      freshestSaleDate,
      confidence: scoreConfidence(query, top),
      rawComps,
      // Graded comps intentionally NOT populated here — CH's existing
      // observedGradeCurve engine handles graded on the primary path.
      // Adding per-grade sales fetches here would add N round trips per
      // resolve without materially helping the rescue paths (which mostly
      // fire when CH's primary already returned nothing).
      raw: top,
    };
  },
};
