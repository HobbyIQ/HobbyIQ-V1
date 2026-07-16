// CF-EBAY-SOLD-COMPS-FOUNDATION (2026-07-12).
//
// Sale-side sibling of applyBrowseEnrichment. Called at ITEM_SOLD webhook
// time (or during backfill) to snapshot the eBay listing's item-specifics
// onto the resulting ledger entry BEFORE Browse API might 404 the listing.
//
// Every sale we complete becomes a first-class sold-comp in our own pool:
// same structured aspects the buy-side keys on. Foundation for future
// "market comps" surfacing — searching our sold pool by (year, set,
// parallel, grade) becomes cheap once every entry carries them.
//
// Fetching lives in the caller. This module is a pure merger, mirroring
// applyBrowseEnrichment so both sides drift together.

import type { PortfolioLedgerEntry } from "./portfolioStore.service.js";
import {
  readUserDoc,
  writeUserDoc,
} from "./portfolioStore.service.js";
import { fetchEbayItemDetails } from "../ebay/ebayItemDetails.service.js";
import type { EbayItemDetails } from "../ebay/ebayItemDetails.service.js";

export function applyBrowseEnrichmentToSale(
  entry: PortfolioLedgerEntry,
  details: EbayItemDetails,
): void {
  const aspects = details.aspects ?? {};

  // Aspects — full snapshot preserved for downstream matching.
  if (Object.keys(aspects).length > 0) {
    entry.ebayItemAspects = aspects;
  }

  // Images — primary + additionals. Kept separately from any user photos.
  const imageUrls = [details.images.primary, ...details.images.additional].filter(
    (u): u is string => !!u,
  );
  if (imageUrls.length > 0) {
    entry.ebayImageUrl = imageUrls[0];
    entry.ebaySoldImages = imageUrls;
  }

  // Description + category + seller — matter for iOS sale-detail view +
  // the future "identical listing" match on sold-comps.
  if (details.shortDescription) entry.ebayShortDescription = details.shortDescription;
  if (details.categoryPath) entry.ebayCategoryPath = details.categoryPath;
  if (details.seller?.username) entry.ebaySellerUsername = details.seller.username;

  // Marker: any structured data merged → this sale is a first-class
  // sold-comp for future queries.
  const gotStructured =
    Object.keys(aspects).length > 0 || imageUrls.length > 0 || !!details.categoryPath;
  if (gotStructured) {
    entry.enrichedFromEbay = true;
  }
}

// ─── Service entry point: enrich a single ledger entry ────────────────────

export type EnrichSaleResult =
  | { status: "enriched"; entry: PortfolioLedgerEntry }
  | { status: "no-listing-id" }
  | { status: "not-found" }
  | { status: "browse-404" }
  | { status: "already-enriched"; entry: PortfolioLedgerEntry }
  | { status: "error"; reason: string };

/**
 * Fetch Browse item details for a sale's ebayListingId and merge item
 * specifics onto the ledger entry. Idempotent — re-runs on an already-
 * enriched entry return "already-enriched" without a network call unless
 * `force` is set.
 */
export async function enrichSaleFromBrowse(
  userId: string,
  ledgerEntryId: string,
  opts: { force?: boolean } = {},
): Promise<EnrichSaleResult> {
  if (!userId || !ledgerEntryId) return { status: "error", reason: "missing userId or ledgerEntryId" };
  const doc = await readUserDoc(userId);
  const entry = doc.ledger.find((e) => e.id === ledgerEntryId);
  if (!entry) return { status: "not-found" };
  if (entry.enrichedFromEbay && !opts.force) return { status: "already-enriched", entry };
  const listingId = entry.ebayListingId?.trim();
  if (!listingId) return { status: "no-listing-id" };

  let details: EbayItemDetails | null = null;
  try {
    details = await fetchEbayItemDetails(userId, listingId);
  } catch (err) {
    return {
      status: "error",
      reason: (err as Error)?.message ?? "browse fetch failed",
    };
  }
  if (!details) return { status: "browse-404" };

  applyBrowseEnrichmentToSale(entry, details);
  await writeUserDoc(userId, doc);
  return { status: "enriched", entry };
}

// ─── Batch entry point ────────────────────────────────────────────────────

export interface EnrichSalesBatchSummary {
  processed: number;
  enriched: number;
  alreadyEnriched: number;
  browse404: number;
  missingListingId: number;
  errors: number;
}

/**
 * Iterate every ledger entry of `source === "ebay"` that has an
 * `ebayListingId` and hasn't been enriched yet. Sequential (not parallel)
 * to keep Cosmos writes simple; the volume is small (few dozen per user,
 * typically). Returns a summary the caller can log/surface.
 */
export async function backfillSalesEnrichment(
  userId: string,
): Promise<EnrichSalesBatchSummary> {
  const summary: EnrichSalesBatchSummary = {
    processed: 0,
    enriched: 0,
    alreadyEnriched: 0,
    browse404: 0,
    missingListingId: 0,
    errors: 0,
  };
  const doc = await readUserDoc(userId);
  const candidates = doc.ledger.filter(
    (e) => e.source === "ebay" && !!e.ebayListingId && !e.enrichedFromEbay,
  );
  summary.processed = candidates.length;

  for (const entry of candidates) {
    const listingId = entry.ebayListingId?.trim();
    if (!listingId) {
      summary.missingListingId += 1;
      continue;
    }
    let details: EbayItemDetails | null = null;
    try {
      details = await fetchEbayItemDetails(userId, listingId);
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "ebay_sale_enrich_error",
          source: "ebaySaleEnrichment.service",
          userId,
          ledgerEntryId: entry.id,
          listingId,
          error: (err as Error)?.message ?? String(err),
        }),
      );
      summary.errors += 1;
      continue;
    }
    if (!details) {
      summary.browse404 += 1;
      continue;
    }
    applyBrowseEnrichmentToSale(entry, details);
    summary.enriched += 1;
  }

  if (summary.enriched > 0) {
    await writeUserDoc(userId, doc);
  }
  return summary;
}

