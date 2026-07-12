// CF-EBAY-AUTO-HOLDING (2026-07-12, Drew — scope 3 followup).
//
// Bridge from parsed eBay listing title → real PortfolioHolding row on the
// user doc. Pure mutator: caller (import route OR backfill route) passes
// the user doc + a purchase entry, we parse the purchase.notes (which the
// import service stored as the listing title), and if parseConfidence
// ≥ 0.70 we mutate the doc:
//   1. Create a new PortfolioHolding row
//   2. Append the holding's id to the parent purchase's holdingIds[]
//
// The caller is responsible for writeUserDoc() after batching. Never
// creates a holding if the purchase already has holdingIds populated
// (idempotent — safe to re-run after a partial write).
//
// The generated holding carries:
//   source: "ebay-auto"          (distinguishes from manual holdings)
//   sourcePurchaseId: purchase.id (back-reference for cost-basis audit)
//   parseConfidence: number      (0.70-1.00; iOS renders a badge for <0.90)
//   needsReview: boolean         (true when confidence < 0.90)
//
// All three fields are ADDITIVE — existing consumers see them via
// (h as any).sourcePurchaseId etc. and don't need type changes to
// keep working.

import { randomUUID } from "node:crypto";
import type {
  PortfolioHolding,
} from "../../types/portfolioiq.types.js";
import {
  parseListingTitle,
  type ParsedListingTitle,
} from "./ebayTitleParser.service.js";
import type {
  PortfolioPurchaseEntry,
} from "./portfolioStore.service.js";

/**
 * Threshold at which we auto-create a holding from a purchase.
 * Confidence must be ≥ this value; below it we either flag needsAttribution
 * (0.40-0.69) or skip entirely (<0.40).
 */
export const AUTO_CREATE_CONFIDENCE_THRESHOLD = 0.7;
/** Below this the parse is too uncertain to even flag. */
export const NEEDS_ATTRIBUTION_MIN = 0.4;
/** Confidence below this on an auto-created holding triggers iOS's "review" badge. */
export const NEEDS_REVIEW_MAX = 0.9;

export type AutoHoldingResult =
  | { status: "created"; holding: PortfolioHolding; parsed: ParsedListingTitle }
  | { status: "needs-attribution"; parsed: ParsedListingTitle }
  | { status: "skipped-low-confidence"; parsed: ParsedListingTitle }
  | { status: "skipped-already-linked"; parsed: ParsedListingTitle };

/** Object with a mutable holdings map + purchases array. Kept loose so this
 *  service doesn't depend on the private UserDoc type in portfolioStore. */
export interface AutoHoldingDocShape {
  holdings: Record<string, PortfolioHolding>;
  purchases?: PortfolioPurchaseEntry[];
}

/**
 * Try to auto-create a holding for a single purchase. Mutates `doc` in place
 * when it does (or when it links to an existing holding). NEVER writes to
 * Cosmos itself — caller batches and writes once.
 */
export function autoCreateHoldingForPurchase(
  doc: AutoHoldingDocShape,
  purchase: PortfolioPurchaseEntry,
): AutoHoldingResult {
  if (purchase.holdingIds.length > 0) {
    return {
      status: "skipped-already-linked",
      parsed: parseListingTitle(purchase.notes ?? ""),
    };
  }
  const parsed = parseListingTitle(purchase.notes ?? "");

  if (parsed.parseConfidence < AUTO_CREATE_CONFIDENCE_THRESHOLD) {
    if (parsed.parseConfidence >= NEEDS_ATTRIBUTION_MIN) {
      return { status: "needs-attribution", parsed };
    }
    return { status: "skipped-low-confidence", parsed };
  }

  const holding = buildHoldingFromParse(purchase, parsed);
  doc.holdings[holding.id] = holding;
  // Idempotent Set-union merge, symmetric with PATCH /link-holdings.
  const merged = new Set([...purchase.holdingIds, holding.id]);
  purchase.holdingIds = [...merged];

  return { status: "created", holding, parsed };
}

// ─── Holding construction ──────────────────────────────────────────────────

function buildHoldingFromParse(
  purchase: PortfolioPurchaseEntry,
  parsed: ParsedListingTitle,
): PortfolioHolding {
  // Per-item cost: split the full totalCost across the eBay Quantity. For
  // single-item transactions (most eBay purchases of individual cards),
  // quantity = 1 and this collapses to purchase.totalCost.
  //
  // We don't preserve tax/shipping breakdown on the holding — the source
  // purchase already carries those, and the auto-created holding's
  // totalCostBasis is the all-in per-unit cost for realized-P&L math.
  const perItemAllIn = purchase.totalCost;

  const cardTitle = buildCardTitle(parsed);
  const gradeValue = parsed.grade ? extractGradeValue(parsed.grade) : undefined;

  // We build with `as any` for the ebay-auto specific fields since the
  // PortfolioHolding interface doesn't declare them yet — additive
  // schema, existing readers unaffected.
  const holding: PortfolioHolding & Record<string, unknown> = {
    id: randomUUID(),
    quantity: 1,
    purchasePrice: perItemAllIn,
    totalCostBasis: perItemAllIn,
    purchaseDate: purchase.purchaseDate,
    lastUpdated: new Date().toISOString(),
    notes: `Auto-imported from eBay purchase (confidence ${parsed.parseConfidence.toFixed(2)})`,
    // Vendor becomes purchaseSource so downstream "where did this come
    // from" reads work without a join.
    purchaseSource: `ebay:${purchase.vendor ?? "unknown"}`,
    // Additive fields NOT declared on the PortfolioHolding interface —
    // written via the Record<string, unknown> escape hatch so we don't
    // need a type migration to ship the ebay-auto marker set.
    addedAt: purchase.purchaseDate,
    cardStatus: "active",
    source: "ebay-auto",
    sourcePurchaseId: purchase.id,
    parseConfidence: parsed.parseConfidence,
    needsReview: parsed.parseConfidence < NEEDS_REVIEW_MAX,
  };

  // Populate parsed fields when present. Every parsed field can legitimately
  // be absent — writer converts each to undefined so the response shape
  // stays additive.
  if (parsed.year !== null) holding.cardYear = parsed.year;
  if (parsed.playerName) holding.playerName = parsed.playerName;
  if (parsed.setName) {
    holding.setName = parsed.setName;
    holding.product = parsed.setName;   // dual-populate for downstream readers
  }
  if (parsed.parallel) holding.parallel = parsed.parallel;
  if (parsed.cardNumber) holding.cardNumber = parsed.cardNumber;
  if (parsed.gradeCompany) {
    holding.gradeCompany = parsed.gradeCompany;
    holding.gradingCompany = parsed.gradeCompany;   // legacy field alias
  }
  if (gradeValue !== undefined) holding.gradeValue = gradeValue;
  if (cardTitle) holding.cardTitle = cardTitle;
  // CF-EBAY-AUTO-DETECTION (2026-07-12): isAuto is a declared field on
  // PortfolioHolding — populated when the parser flagged the title as
  // an autograph. Rookie signal preserved on notes (no dedicated boolean).
  if (parsed.isAuto) holding.isAuto = true;
  if (parsed.isRookie) {
    holding.notes = `${holding.notes} · rookie`;
  }

  return holding;
}

function buildCardTitle(parsed: ParsedListingTitle): string | undefined {
  const parts: string[] = [];
  if (parsed.year !== null) parts.push(String(parsed.year));
  if (parsed.setName) parts.push(parsed.setName);
  if (parsed.parallel) parts.push(parsed.parallel);
  if (parsed.playerName) parts.push(parsed.playerName);
  if (parsed.cardNumber) parts.push(`#${parsed.cardNumber}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractGradeValue(grade: string): number | undefined {
  const m = grade.match(/([\d.]+)$/);
  return m ? Number(m[1]) : undefined;
}
