// CF-CATALOG-RESOLVER (2026-07-13): CardHedge vendor source plugin.
//
// Wraps the existing searchCards helper into the VendorSource interface.
// This is thin — the actual CH API knowledge lives in cardhedge.client.ts.
// This adapter just maps CardQuery → searchCards args + response →
// CardResolution.

import type {
  CardQuery,
  CardResolution,
  VendorSource,
  ResolutionConfidence,
} from "./catalogResolver.service.js";
import { searchCards } from "./cardhedge.client.js";

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
    return {
      vendor: "cardhedge",
      cardId: top.card_id,
      // CH searchCards returns catalog metadata, not pricing directly. Pricing
      // is a separate call (getPricing) — for the resolver's "does this vendor
      // know this card" question, that's enough. FMV null here signals the
      // downstream pricing step to fetch.
      fairMarketValue: null,
      compCount: candidates.length,   // proxy: CH found N candidates
      freshestSaleDate: null,
      confidence: scoreConfidence(query, top),
      raw: top,
    };
  },
};
