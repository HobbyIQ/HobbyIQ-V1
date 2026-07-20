// CF-ONE-CLICK-LISTING (Drew, 2026-07-17). Compose a fully pre-filled
// eBay listing draft from a persisted holding + optional target price.
// The user's ONLY input in the happy path is "list this card" — we
// derive title, description, aspects, photos, condition, and price
// from what we already know about the holding.
//
// This is the composer half — user reviews and clicks Publish; the
// existing /api/ebay/listings/publish route does the real work.

import type { PortfolioHolding } from "../../types/portfolioiq.types.js";
import type { HoldingListingInput } from "../ebay/ebayListing.service.js";

export interface ComposeListingOverrides {
  /** User-supplied target price. Defaults to holding.predictedPrice,
   *  then holding.fairMarketValue, then estimatedValue. */
  targetPrice?: number;
  /** User-editable description. Falls back to the auto-generated one. */
  description?: string;
  /** Enable eBay Best Offer. Default true — sellers typically want it. */
  bestOfferEnabled?: boolean;
  /** Percentage below listing price for the auto-decline threshold on
   *  Best Offer. Default 15% (so a $2600 list refuses <$2210 offers). */
  bestOfferAutoDeclinePct?: number;
  quantity?: number;
}

/** Derive the eBay listing input shape from a persisted holding.
 *  Returns null when the holding is missing required identity fields
 *  (playerName, cardYear, setName) — the caller renders "add these
 *  fields first" instead of a broken listing. */
export function composeListingInput(
  holding: PortfolioHolding,
  overrides: ComposeListingOverrides = {},
): HoldingListingInput | null {
  const playerName = String(holding.playerName ?? "").trim();
  const cardYear = typeof holding.cardYear === "number" ? holding.cardYear : null;
  const setName = String(holding.setName ?? holding.product ?? "").trim();
  if (!playerName || !cardYear || !setName) return null;

  const price = pickTargetPrice(holding, overrides.targetPrice);
  if (price <= 0) return null;

  const bestOfferEnabled = overrides.bestOfferEnabled ?? true;
  const bestOfferMinPrice = bestOfferEnabled
    ? round2(price * (1 - (overrides.bestOfferAutoDeclinePct ?? 0.15)))
    : undefined;

  // Brand derivation: pull the leading word from setName (Bowman /
  // Topps / Panini / Upper Deck etc). Fine for the ~99% case; the
  // ebay preview will still accept any string.
  const brand = pickBrand(setName, holding);

  const grade = holding.gradeValue ? String(holding.gradeValue).trim() : undefined;
  const gradingCompany = holding.gradingCompany
    ? String(holding.gradingCompany).trim()
    : holding.gradeCompany
      ? String(holding.gradeCompany).trim()
      : undefined;

  const photos = extractPhotos(holding);

  return {
    holdingId: holding.id,
    playerName,
    cardTitle: buildInternalCardTitle(holding),
    cardYear,
    brand,
    setName,
    product: setName,   // eBay's "Product Line" — same as set for most cards
    sport: (holding as { sport?: string }).sport ?? undefined,
    cardNumber: holding.cardNumber ? String(holding.cardNumber).trim().replace(/^#+/, "") : undefined,
    parallel: holding.parallel ? String(holding.parallel).trim() : undefined,
    serialNumber: (holding as { serialNumber?: string }).serialNumber,
    printRun: (holding as { printRun?: number }).printRun,
    isAuto: inferIsAuto(holding),
    isPatch: inferIsPatch(holding),
    isRookie: inferIsRookie(holding),
    variation: undefined,
    team: (holding as { team?: string }).team ? String((holding as { team?: string }).team).trim() : undefined,
    grade,
    gradingCompany,
    certNumber: (holding as { certNumber?: string }).certNumber,
    conditionEstimate: undefined,
    conditionNotes: undefined,
    quantity: overrides.quantity ?? 1,
    listingPrice: price,
    bestOfferEnabled,
    bestOfferMinPrice,
    imageFrontUrl: photos[0],
    imageBackUrl: photos[1],
    photos: photos.length > 2 ? photos : undefined,
    description: overrides.description,
    // CF-EBAY-ASPECTS-MERGE (Drew, 2026-07-20). Pass the rich aspects
    // captured from the original eBay import through so buildItemAspects
    // can merge required-by-category fields (League, Type, Country/
    // Region of Manufacture, Year Manufactured, etc.) that eBay rejects
    // the inventory_item PUT without.
    ebayItemAspects: (holding as { ebayItemAspects?: Record<string, string> }).ebayItemAspects,
  };
}

function pickTargetPrice(holding: PortfolioHolding, override?: number): number {
  if (typeof override === "number" && override > 0) return round2(override);
  if (typeof holding.predictedPrice === "number" && holding.predictedPrice > 0) {
    return round2(holding.predictedPrice);
  }
  if (typeof holding.fairMarketValue === "number" && holding.fairMarketValue > 0) {
    return round2(holding.fairMarketValue);
  }
  if (typeof holding.estimatedValue === "number" && holding.estimatedValue > 0) {
    return round2(holding.estimatedValue);
  }
  return 0;
}

function pickBrand(setName: string, holding: PortfolioHolding): string {
  const explicit = (holding as { manufacturer?: string }).manufacturer;
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
  const first = setName.replace(/^\s*\d{4}\s+/, "").split(/\s+/)[0];
  return first || "Unknown";
}

function buildInternalCardTitle(h: PortfolioHolding): string {
  const parts: string[] = [];
  if (h.cardYear) parts.push(String(h.cardYear));
  if (h.setName ?? h.product) parts.push(String(h.setName ?? h.product));
  if (h.parallel) parts.push(String(h.parallel));
  if (h.playerName) parts.push(String(h.playerName));
  if (h.cardNumber) parts.push(`#${String(h.cardNumber).replace(/^#+/, "")}`);
  return parts.join(" ").trim();
}

function extractPhotos(h: PortfolioHolding): string[] {
  const arr = (h as { photos?: string[] }).photos;
  if (Array.isArray(arr) && arr.length > 0) {
    return arr.filter((u) => typeof u === "string" && u.length > 0);
  }
  const front = (h as { imageUrl?: string; ebayImageUrl?: string }).imageUrl
    ?? (h as { ebayImageUrl?: string }).ebayImageUrl;
  return front ? [front] : [];
}

function inferIsAuto(h: PortfolioHolding): boolean {
  const explicit = (h as { isAuto?: boolean }).isAuto;
  if (typeof explicit === "boolean") return explicit;
  const combined = `${h.parallel ?? ""} ${h.cardTitle ?? ""} ${h.setName ?? h.product ?? ""}`.toLowerCase();
  return /\bauto(?:graph)?\b/.test(combined);
}

function inferIsPatch(h: PortfolioHolding): boolean {
  const combined = `${h.parallel ?? ""} ${h.cardTitle ?? ""}`.toLowerCase();
  return /\bpatch\b/.test(combined);
}

function inferIsRookie(h: PortfolioHolding): boolean {
  const combined = `${h.parallel ?? ""} ${h.cardTitle ?? ""} ${(h as { notes?: string }).notes ?? ""}`.toLowerCase();
  return /\brookie\b|\brc\b|1st\s+bowman|first\s+bowman/.test(combined);
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
