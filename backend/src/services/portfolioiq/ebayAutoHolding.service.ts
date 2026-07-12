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
import type { EbayItemDetails } from "../ebay/ebayItemDetails.service.js";

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
  | { status: "created"; holding: PortfolioHolding; parsed: ParsedListingTitle; enriched: boolean }
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
 *
 * When `details` is provided (from a Browse API prefetch), Browse-side data
 * is merged AUTHORITATIVELY over the title-parse for grader/grade/aspects/
 * images. Absent `details` → title-parse only (current-day behavior).
 */
export function autoCreateHoldingForPurchase(
  doc: AutoHoldingDocShape,
  purchase: PortfolioPurchaseEntry,
  details?: EbayItemDetails | null,
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
  if (details) applyBrowseEnrichment(holding, details);
  doc.holdings[holding.id] = holding;
  // Idempotent Set-union merge, symmetric with PATCH /link-holdings.
  const merged = new Set([...purchase.holdingIds, holding.id]);
  purchase.holdingIds = [...merged];

  return { status: "created", holding, parsed, enriched: !!details };
}

// ─── Holding construction ──────────────────────────────────────────────────

function buildHoldingFromParse(
  purchase: PortfolioPurchaseEntry,
  parsed: ParsedListingTitle,
): PortfolioHolding & Record<string, unknown> {
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

// ─── CF-EBAY-BROWSE-ENRICHMENT (2026-07-12) ────────────────────────────────
//
// Merge Browse API item detail data into a title-parsed holding. Browse data
// is AUTHORITATIVE for grader / grade / autograph flag / condition (structured
// item specifics beat title-string parsing). Aspects the parser couldn't get
// are backfilled here. Images + description are added for iOS render + future
// eBay-relisting flow.

const NORMALIZED_GRADER_MAP: Record<string, "PSA" | "BGS" | "SGC" | "CGC"> = {
  psa: "PSA",
  "professional sports authenticator (psa)": "PSA",
  "professional sports authenticator": "PSA",
  bgs: "BGS",
  "beckett grading services (bgs)": "BGS",
  "beckett grading services": "BGS",
  beckett: "BGS",
  sgc: "SGC",
  "sports guaranty company": "SGC",
  "sports guaranty co (sgc)": "SGC",
  cgc: "CGC",
  "certified guaranty company (cgc)": "CGC",
};

function normalizeGraderCompany(s: string | null): "PSA" | "BGS" | "SGC" | "CGC" | null {
  if (!s) return null;
  const lower = s.toLowerCase().trim();
  return NORMALIZED_GRADER_MAP[lower] ?? null;
}

function parseGradeValueLoose(s: string | null): number | undefined {
  if (!s) return undefined;
  const m = s.match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
}

export function applyBrowseEnrichment(
  holding: PortfolioHolding & Record<string, unknown>,
  details: EbayItemDetails,
): void {
  const aspects = details.aspects ?? {};

  // ── Grader + grade: authoritative from Browse if present ──────────
  const grader = normalizeGraderCompany(details.grader) ?? normalizeGraderCompany(aspects["Professional Grader"] ?? null);
  const graded = grader !== null || (details.condition ?? "").toLowerCase() === "graded";
  if (grader) {
    holding.gradeCompany = grader;
    holding.gradingCompany = grader;   // legacy alias
  }
  const gradeVal = parseGradeValueLoose(details.grade) ?? parseGradeValueLoose(aspects["Grade"] ?? null);
  if (gradeVal !== undefined) {
    holding.gradeValue = gradeVal;
  }
  // If Browse says Ungraded explicitly, clear a title-parsed grade so we
  // don't lie about it. Title regex sometimes picks up spurious "PSA 10"
  // in seller marketing copy that isn't a real slab.
  if (!graded && details.condition && details.condition.toLowerCase().includes("ungraded")) {
    holding.gradeCompany = undefined;
    holding.gradingCompany = undefined;
    holding.gradeValue = undefined;
  }

  // ── Autograph: Browse aspect authoritative ────────────────────────
  const autoAspect = aspects["Autographed"] ?? aspects["Autograph"];
  if (autoAspect !== undefined) {
    const yes = /^(y|yes|true)$/i.test(autoAspect);
    holding.isAuto = yes;
  }

  // ── Aspects we can backfill onto structured fields ────────────────
  if (!holding.playerName && aspects["Player"]) holding.playerName = aspects["Player"];
  if (!holding.playerName && aspects["Player/Athlete"]) holding.playerName = aspects["Player/Athlete"];
  if (aspects["Team"] && !(holding as any).team) (holding as any).team = aspects["Team"];
  if (aspects["Sport"] && !(holding as any).sport) (holding as any).sport = aspects["Sport"];
  if (aspects["Season"] && !holding.cardYear) {
    const y = Number(aspects["Season"]);
    if (Number.isFinite(y) && y >= 1900) holding.cardYear = y;
  }
  if (aspects["Set"] && !holding.setName) {
    holding.setName = aspects["Set"];
    holding.product = holding.product ?? aspects["Set"];
  }
  if (aspects["Manufacturer"] && !(holding as any).manufacturer) {
    (holding as any).manufacturer = aspects["Manufacturer"];
  }
  if (aspects["Parallel/Variety"] && !holding.parallel) {
    holding.parallel = aspects["Parallel/Variety"];
  }
  if (aspects["Card Number"] && !holding.cardNumber) {
    holding.cardNumber = aspects["Card Number"];
  }

  // ── Images: primary + additionals into holding.photos[] ───────────
  const imageUrls = [details.images.primary, ...details.images.additional].filter(
    (u): u is string => !!u,
  );
  if (imageUrls.length > 0) {
    // Backend already treats `photos` as the canonical image list.
    (holding as any).photos = imageUrls;
    (holding as any).ebayImageUrl = imageUrls[0];
  }

  // ── Description + item specifics for iOS + eBay relisting flow ────
  if (details.shortDescription) {
    (holding as any).ebayShortDescription = details.shortDescription;
  }
  if (Object.keys(aspects).length > 0) {
    (holding as any).ebayItemAspects = aspects;
  }
  if (details.categoryPath) {
    (holding as any).ebayCategoryPath = details.categoryPath;
  }
  if (details.seller) {
    (holding as any).ebaySeller = details.seller;
  }

  // ── Bump the parse confidence + drop needs-review when Browse data ──
  // provided the grader/grade/aspects the title couldn't. Confidence 0.95
  // is the "eBay confirmed" tier — the browse data is structured, not
  // parsed — so iOS's needs-review prompt drops away.
  const gotStructuredData = Object.keys(aspects).length > 0 || grader !== null || gradeVal !== undefined;
  if (gotStructuredData) {
    const priorConf = (holding as any).parseConfidence as number | undefined;
    (holding as any).parseConfidence = Math.max(priorConf ?? 0, 0.95);
    (holding as any).needsReview = false;
    (holding as any).enrichedFromEbay = true;
  }

  holding.lastUpdated = new Date().toISOString();
}
