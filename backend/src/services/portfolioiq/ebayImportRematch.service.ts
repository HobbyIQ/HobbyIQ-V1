// CF-EBAY-IMPORT-REMATCH (Drew, 2026-07-18). Walk eBay-auto-imported
// holdings, re-run the CardHedge match on the ORIGINAL eBay title,
// and update (cardId, parallel, cardNumber, isAuto, setName, product)
// from CH's canonical response. Purchase price becomes a sanity
// check — if the freshly-derived FMV comes back < 20% of what the
// user paid, we flag the holding as needsReview so iOS can prompt.
//
// Why: eBay's own title parser sometimes ate key tokens ("Auto",
// "CPA-EHA" vs "BCP-102", parallel color words). Since we already
// stored the ORIGINAL cardTitle on each holding, we can replay the
// import with a stronger parser + CH's canonical catalog.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import { searchCards } from "../compiq/cardhedge.client.js";

export interface RematchResult {
  holdingId: string;
  ebayTitle: string;
  purchasePrice: number | null;
  before: {
    parallel: string | null;
    cardNumber: string | null;
    setName: string | null;
    cardId: string | null;
    fairMarketValue: number | null;
  };
  after: {
    parallel: string | null;
    cardNumber: string | null;
    setName: string | null;
    cardId: string | null;
    matchConfidence: number;
    matchSource: "cardhedge-search" | "unchanged" | "no_match";
  };
  needsReview: boolean;
  reviewReason: string | null;
  changed: boolean;
}

const PURCHASE_PRICE_SANITY_FLOOR_PCT = 0.20;   // FMV < 20% of paid → flag

/** Return true when the ebay-imported holding is a candidate for
 *  remap. Skip cards that are already grade-locked (cert number
 *  present) since those have concrete identity. */
export function isRematchCandidate(h: PortfolioHolding): boolean {
  if (!h.cardTitle || String(h.cardTitle).trim().length === 0) return false;
  const source = (h as { source?: string }).source ?? "";
  const purchaseSource = (h as { purchaseSource?: string }).purchaseSource ?? "";
  if (source !== "ebay-auto" && !/ebay/i.test(purchaseSource)) return false;
  if ((h as { certNumber?: string }).certNumber) return false;   // graded, canonical
  return true;
}

/** Re-run CH match on the eBay title + description context. Never
 *  throws. When no strong match, returns the "unchanged" outcome. */
export async function rematchOne(
  holding: PortfolioHolding,
): Promise<RematchResult> {
  const title = String(holding.cardTitle ?? "").trim();
  const purchasePrice = typeof holding.purchasePrice === "number" ? holding.purchasePrice : null;
  const before = {
    parallel: (holding.parallel as string | null | undefined) ?? null,
    cardNumber: (holding.cardNumber as string | null | undefined) ?? null,
    setName: (holding.setName as string | null | undefined) ?? null,
    cardId: (holding.cardId as string | null | undefined) ?? null,
    fairMarketValue: typeof holding.fairMarketValue === "number" ? holding.fairMarketValue : null,
  };
  const base: Omit<RematchResult, "after" | "changed" | "needsReview" | "reviewReason"> = {
    holdingId: holding.id,
    ebayTitle: title,
    purchasePrice,
    before,
  };

  const emptyAfter = (source: RematchResult["after"]["matchSource"], conf = 0) => ({
    ...base,
    after: {
      parallel: before.parallel,
      cardNumber: before.cardNumber,
      setName: before.setName,
      cardId: before.cardId,
      matchConfidence: conf,
      matchSource: source,
    },
    needsReview: !!(purchasePrice && before.fairMarketValue !== null
      && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT),
    reviewReason: purchasePrice && before.fairMarketValue !== null
      && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT
      ? `FMV $${before.fairMarketValue.toFixed(2)} under 20% of paid $${purchasePrice.toFixed(2)}`
      : null,
    changed: false,
  } as RematchResult);

  if (!title) return emptyAfter("unchanged");

  try {
    // Query CH with the raw title — CH's tokenizer handles the fuzzy
    // matching. We add a purchase-price hint via keeping the title
    // intact; the searchCards implementation walks CH's card-search.
    const cards = await searchCards(title, 5);
    if (!cards || cards.length === 0) return emptyAfter("no_match");

    // Pick the highest-confidence card. searchCards returns them
    // ordered; the top hit is the best. When multiple hits at the
    // same score exist and one carries CPA-*/BCPA-* card_number
    // matching a token in the ebay title (like "CPA-EHA"), prefer it.
    const top = pickBestMatch(cards, title);
    if (!top) return emptyAfter("no_match");

    const after = {
      parallel: (top.variant ?? before.parallel) as string | null,
      cardNumber: (top.number ?? before.cardNumber) as string | null,
      setName: (top.set ?? before.setName) as string | null,
      cardId: (top.card_id ?? before.cardId) as string | null,
      matchConfidence: (top as { confidence?: number }).confidence ?? 0.8,
      matchSource: "cardhedge-search" as const,
    };
    const changed =
      after.parallel !== before.parallel
      || after.cardNumber !== before.cardNumber
      || after.cardId !== before.cardId;

    return {
      ...base,
      after,
      changed,
      needsReview: !!(purchasePrice && before.fairMarketValue !== null
        && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT),
      reviewReason: purchasePrice && before.fairMarketValue !== null
        && before.fairMarketValue < purchasePrice * PURCHASE_PRICE_SANITY_FLOOR_PCT
        ? `FMV $${before.fairMarketValue.toFixed(2)} under 20% of paid $${purchasePrice.toFixed(2)}`
        : null,
    };
  } catch {
    return emptyAfter("no_match");
  }
}

interface CardMatchCandidate {
  card_id?: string;
  title?: string | null;
  player?: string | null;
  set?: string | null;
  number?: string | null;
  variant?: string | null;
  year?: number | string | null;
  confidence?: number;
}

function pickBestMatch(cards: CardMatchCandidate[], title: string): CardMatchCandidate | null {
  if (cards.length === 0) return null;
  const t = title.toLowerCase();
  const scored = cards.map((c) => {
    let bonus = 0;
    const num = String(c.number ?? "").toLowerCase();
    if (num && t.includes(num.toLowerCase())) bonus += 30;
    // Bowman Chrome Prospect Autographs number pattern: CPA-EHA, CPA-OC etc.
    if (/^(cpa|bcpa|bspa|cda|bcda)-/.test(num)) {
      if (/auto|autograph/i.test(t)) bonus += 20;
    }
    const variant = String(c.variant ?? "").toLowerCase();
    if (variant && t.includes(variant.toLowerCase())) bonus += 25;
    // Player match: reward when the title contains the player's name
    const player = String(c.player ?? "").toLowerCase();
    if (player && t.includes(player)) bonus += 15;
    return { c, score: (c.confidence ?? 0.5) * 100 + bonus };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.c ?? null;
}
