// CF-EBAY-BUYER-HISTORY (2026-07-12) — pull user's PURCHASE history via
// the legacy Trading API `GetMyeBayBuying` call. Sell Finances API is
// seller-scoped (payouts, fees on things you SELL) — buyer-side purchases
// live in the Trading API, which accepts OAuth2 tokens via the
// `X-EBAY-API-IAF-TOKEN` header (no new scope beyond api_scope).
//
// Verified live 2026-07-12 against Drew's account: 39 real purchases
// returned for a 30-day window with correct titles, prices, sellers.

import { XMLParser } from "fast-xml-parser";
import {
  getAccessToken,
} from "./ebayAuth.service.js";
import {
  readUserDoc,
  recordPurchase,
  writeUserDoc,
  type PortfolioPurchaseEntry,
} from "../portfolioiq/portfolioStore.service.js";
import {
  autoCreateHoldingForPurchase,
} from "../portfolioiq/ebayAutoHolding.service.js";
import { fetchEbayItemDetailsBatch } from "./ebayItemDetails.service.js";

const TRADING_API_URL = "https://api.ebay.com/ws/api.dll";
const COMPATIBILITY_LEVEL = "1349";
const SITE_ID = "0"; // US

/** GetMyeBayBuying WonList.DurationInDays cap per eBay Trading API docs. */
export const MAX_DURATION_DAYS = 90;

// ─── Response shape from XML parsing ───────────────────────────────────────

interface RawItem {
  ItemID?: string;
  Title?: string;
  ListingDetails?: {
    EndTime?: string;
  };
  Seller?: {
    UserID?: string;
  };
  SellingStatus?: {
    CurrentPrice?: { "#text"?: string | number; "@_currencyID"?: string } | string;
  };
  ShippingDetails?: {
    ShippingServiceOptions?: {
      ShippingServiceCost?: { "#text"?: string | number } | string;
    };
  };
}

interface RawTransaction {
  Item?: RawItem;
  TransactionID?: string;
  OrderLineItemID?: string;
  PaidTime?: string;
  TotalPrice?: { "#text"?: string | number } | string;
  TotalTransactionPrice?: { "#text"?: string | number } | string;
  QuantityPurchased?: number | string;
}

interface RawOrderTransaction {
  Transaction?: RawTransaction | RawTransaction[];
}

// ─── Public shape returned by the parse pass ───────────────────────────────

export interface ParsedBuyerPurchase {
  ebayOrderLineItemId: string;
  ebayItemId: string | null;
  ebayTransactionId: string | null;
  title: string;
  sellerUserId: string | null;
  purchaseDate: string; // ISO — prefer PaidTime, fall back to Item.ListingDetails.EndTime
  quantity: number;
  subtotal: number;     // TotalTransactionPrice; fall back to CurrentPrice * quantity
  shipping: number;
  tax: number;          // derived: max(0, TotalPrice - subtotal - shipping)
  totalCost: number;    // TotalPrice — authoritative all-in
}

// ─── XML fetch + parse ─────────────────────────────────────────────────────

function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  // Object with `#text` (fast-xml-parser preserveAttrs shape)
  if (typeof v === "object" && v !== null && "#text" in v) {
    return num((v as any)["#text"]);
  }
  return 0;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v !== null && "#text" in v) {
    return str((v as any)["#text"]);
  }
  return null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: true,
  textNodeName: "#text",
  trimValues: true,
});

/**
 * Fetch buyer purchase history via GetMyeBayBuying. Returns parsed rows +
 * whether more pages exist (single-page for MVP; extensions can paginate).
 *
 * Throws on non-2xx from eBay. Caller wraps in try/catch and translates to
 * a route-appropriate error.
 */
export async function fetchEbayBuyerHistory(
  userId: string,
  daysBack: number,
): Promise<{ purchases: ParsedBuyerPurchase[]; ebayTotalReported: number | null }> {
  const days = Math.min(MAX_DURATION_DAYS, Math.max(1, Math.floor(daysBack)));
  const token = await getAccessToken(userId);

  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <WonList>
    <Include>true</Include>
    <DurationInDays>${days}</DurationInDays>
    <Sort>EndTimeDescending</Sort>
    <Pagination>
      <EntriesPerPage>200</EntriesPerPage>
      <PageNumber>1</PageNumber>
    </Pagination>
  </WonList>
</GetMyeBayBuyingRequest>`;

  const res = await fetch(TRADING_API_URL, {
    method: "POST",
    headers: {
      "X-EBAY-API-CALL-NAME": "GetMyeBayBuying",
      "X-EBAY-API-COMPATIBILITY-LEVEL": COMPATIBILITY_LEVEL,
      "X-EBAY-API-IAF-TOKEN": token,
      "X-EBAY-API-SITEID": SITE_ID,
      "Content-Type": "text/xml",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`GetMyeBayBuying HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const xml = await res.text();
  const parsed = parser.parse(xml);
  const root = parsed?.GetMyeBayBuyingResponse;
  const ack = root?.Ack;
  if (ack && ack !== "Success" && ack !== "Warning") {
    const errCode = root?.Errors?.ErrorCode ?? "?";
    const errMsg = root?.Errors?.LongMessage ?? "unknown";
    throw new Error(`GetMyeBayBuying rejected: ${errCode} ${errMsg}`);
  }

  const wonList = root?.WonList;
  const totalReported =
    typeof wonList?.PaginationResult?.TotalNumberOfEntries === "number"
      ? wonList.PaginationResult.TotalNumberOfEntries
      : null;

  const rawOrderTxns = wonList?.OrderTransactionArray?.OrderTransaction;
  const orderTxnList: RawOrderTransaction[] = Array.isArray(rawOrderTxns)
    ? rawOrderTxns
    : rawOrderTxns
      ? [rawOrderTxns]
      : [];

  const purchases: ParsedBuyerPurchase[] = [];
  for (const orderTxn of orderTxnList) {
    const txns = Array.isArray(orderTxn.Transaction)
      ? orderTxn.Transaction
      : orderTxn.Transaction
        ? [orderTxn.Transaction]
        : [];
    for (const t of txns) {
      const parsed = mapTransactionToPurchase(t);
      if (parsed) purchases.push(parsed);
    }
  }
  return { purchases, ebayTotalReported: totalReported };
}

function mapTransactionToPurchase(t: RawTransaction): ParsedBuyerPurchase | null {
  const orderLineItemId = str(t.OrderLineItemID);
  if (!orderLineItemId) return null;    // no idempotency key — skip

  const item = t.Item ?? {};
  const totalPrice = num(t.TotalPrice);
  const totalTxnPrice = num(t.TotalTransactionPrice);
  const currentPrice = num(item.SellingStatus?.CurrentPrice);
  const qty = num(t.QuantityPurchased) || 1;
  const shipping = num(item.ShippingDetails?.ShippingServiceOptions?.ShippingServiceCost);

  // subtotal = per-item total. TotalTransactionPrice is authoritative;
  // fall back to CurrentPrice × quantity for older listings.
  const subtotal = totalTxnPrice > 0 ? totalTxnPrice : currentPrice * qty;
  const tax = Math.max(0, Math.round((totalPrice - subtotal - shipping) * 100) / 100);
  const totalCost = totalPrice > 0 ? totalPrice : Math.round((subtotal + shipping + tax) * 100) / 100;

  const purchaseDate =
    str(t.PaidTime) ??
    str(item.ListingDetails?.EndTime) ??
    new Date().toISOString();

  return {
    ebayOrderLineItemId: orderLineItemId,
    ebayItemId: str(item.ItemID),
    ebayTransactionId: str(t.TransactionID),
    title: str(item.Title) ?? "eBay purchase",
    sellerUserId: str(item.Seller?.UserID),
    purchaseDate,
    quantity: qty,
    subtotal: Math.round(subtotal * 100) / 100,
    shipping: Math.round(shipping * 100) / 100,
    tax,
    totalCost: Math.round(totalCost * 100) / 100,
  };
}

// ─── High-level import (idempotent via recordPurchase) ─────────────────────

export interface EbayImportSummary {
  daysWindow: number;
  fetched: number;
  imported: number;
  replayHits: number;
  skipped: number;
  errors: number;
  totalCost: number;
  ebayTotalReported: number | null;
  entries: PortfolioPurchaseEntry[];
  // CF-EBAY-AUTO-HOLDING (2026-07-12): counts from the post-import
  // batch pass that turns high-confidence purchases into holdings.
  // Sum is <= imported+replayHits — some purchases may already be linked
  // from a prior run (idempotent).
  holdingsCreated: number;
  holdingsNeedingReview: number;
  /** Purchases with parseConfidence <0.70 (couldn't auto-create). */
  holdingsSkipped: number;
  /** CF-EBAY-BROWSE-ENRICHMENT (2026-07-12): how many auto-created holdings
   *  received Browse API item-specifics enrichment. */
  holdingsBrowseEnriched: number;
}

export async function importEbayPurchaseHistory(
  userId: string,
  daysBack: number,
): Promise<EbayImportSummary> {
  const days = Math.min(MAX_DURATION_DAYS, Math.max(1, Math.floor(daysBack)));
  const { purchases, ebayTotalReported } = await fetchEbayBuyerHistory(userId, days);

  const summary: EbayImportSummary = {
    daysWindow: days,
    fetched: purchases.length,
    imported: 0,
    replayHits: 0,
    skipped: 0,
    errors: 0,
    totalCost: 0,
    ebayTotalReported,
    entries: [],
    holdingsCreated: 0,
    holdingsNeedingReview: 0,
    holdingsSkipped: 0,
    holdingsBrowseEnriched: 0,
  };

  for (const p of purchases) {
    // Skip zero-cost lines (e.g., returned/cancelled items sometimes show
    // as $0). Same guard as manual POST /erp/purchases.
    if (p.subtotal <= 0) {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await recordPurchase(userId, {
        purchaseDate: p.purchaseDate,
        source: "ebay",
        subtotal: p.subtotal,
        tax: p.tax,
        shipping: p.shipping,
        otherFees: 0,
        vendor: p.sellerUserId ?? undefined,
        notes: p.title,
        ebayOrderId: p.ebayOrderLineItemId,   // idempotency key
        ebayTransactionId: p.ebayTransactionId ?? undefined,
        ebayItemId: p.ebayItemId ?? undefined,   // for Browse API enrichment
      });
      if (result.replay) summary.replayHits += 1;
      else summary.imported += 1;
      summary.totalCost += result.entry.totalCost;
      summary.entries.push(result.entry);
    } catch (err) {
      summary.errors += 1;
      console.warn(
        JSON.stringify({
          event: "ebay_purchase_import_error",
          source: "ebayBuyerHistory.service",
          userId,
          orderLineItemId: p.ebayOrderLineItemId,
          error: (err as Error)?.message ?? String(err),
        }),
      );
    }
  }
  summary.totalCost = Math.round(summary.totalCost * 100) / 100;

  // CF-EBAY-AUTO-HOLDING (2026-07-12): post-import batch pass.
  // Reads the fresh user doc once, runs auto-create for every purchase
  // whose holdingIds is still empty (both new imports and any older
  // eBay purchases that pre-date this feature). One write at the end.
  //
  // Guardrail: idempotent — never touches a purchase already linked to
  // holdings. Safe to run repeatedly.
  try {
    const batchSummary = await runAutoHoldingBatch(userId);
    summary.holdingsCreated = batchSummary.created;
    summary.holdingsNeedingReview = batchSummary.needsReview;
    summary.holdingsSkipped = batchSummary.skipped;
    summary.holdingsBrowseEnriched = batchSummary.browseEnriched;
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "ebay_auto_holding_batch_error",
        source: "ebayBuyerHistory.service",
        userId,
        error: (err as Error)?.message ?? String(err),
      }),
    );
  }
  return summary;
}

// ─── Auto-holding batch pass (shared by import + backfill) ─────────────────

export interface AutoHoldingBatchSummary {
  processed: number;
  created: number;
  /** Auto-created holdings whose parseConfidence stayed <0.90 (still need
   *  iOS review). When Browse enrichment succeeds, needsReview drops to
   *  false — so this count reflects "created but not enriched by Browse". */
  needsReview: number;
  needsAttribution: number;
  skipped: number;
  /** CF-EBAY-BROWSE-ENRICHMENT (2026-07-12): how many auto-created holdings
   *  received Browse API item-specifics enrichment (grader/grade/aspects/
   *  images). Rest of `created` fell back to title-parse only (either
   *  Browse 404'd or the itemId couldn't be extracted). */
  browseEnriched: number;
}

/**
 * Walk every eBay-source purchase for the user, run the auto-create logic,
 * write ONCE at the end. Idempotent — purchases with holdingIds already
 * populated are silently skipped (see autoCreateHoldingForPurchase).
 *
 * Called by:
 *   - importEbayPurchaseHistory (as post-import pass)
 *   - POST /api/portfolio/erp/purchases/backfill-holdings (as user-triggered
 *     one-shot to attribute pre-existing eBay purchases)
 */
export async function runAutoHoldingBatch(userId: string): Promise<AutoHoldingBatchSummary> {
  const doc = await readUserDoc(userId);
  const purchases = doc.purchases ?? [];
  const summary: AutoHoldingBatchSummary = {
    processed: 0,
    created: 0,
    needsReview: 0,
    needsAttribution: 0,
    skipped: 0,
    browseEnriched: 0,
  };

  // ── CF-EBAY-BROWSE-ENRICHMENT (2026-07-12): prefetch item details for
  // every candidate purchase in ONE parallel batch (concurrency cap 8).
  // Cheap when there's nothing to enrich; the Browse API is fast (~200ms
  // per call, 8-in-flight → ~10 sec for 40 items). Errors on individual
  // items are silent nulls so a bad item doesn't take the batch down.
  //
  // itemId derivation: prefer explicit purchase.ebayItemId (populated by
  // fresh imports post-#382); fall back to extracting from
  // ebayOrderLineItemID ("itemId-txnId" format) for older purchases.
  const candidates = purchases
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => p.source === "ebay" && p.holdingIds.length === 0);
  const itemIds: string[] = candidates.map(({ p }) => extractItemId(p) ?? "");
  const detailsList = itemIds.some((id) => id.length > 0)
    ? await fetchEbayItemDetailsBatch(userId, itemIds, 8).catch((err) => {
        console.warn(
          JSON.stringify({
            event: "ebay_browse_prefetch_error",
            source: "ebayBuyerHistory.service",
            userId,
            error: (err as Error)?.message ?? String(err),
          }),
        );
        return new Array(itemIds.length).fill(null);
      })
    : new Array(itemIds.length).fill(null);
  const detailsByPurchaseIdx = new Map<number, Awaited<ReturnType<typeof fetchEbayItemDetailsBatch>>[number]>();
  candidates.forEach(({ idx }, i) => detailsByPurchaseIdx.set(idx, detailsList[i]));

  let mutated = false;
  for (let i = 0; i < purchases.length; i++) {
    const p = purchases[i];
    if (p.source !== "ebay") continue;
    summary.processed += 1;
    const details = detailsByPurchaseIdx.get(i) ?? null;
    const result = autoCreateHoldingForPurchase(doc, p, details);
    switch (result.status) {
      case "created":
        summary.created += 1;
        if (result.enriched) summary.browseEnriched += 1;
        // parseConfidence < 0.90 → flag as needsReview for iOS badge.
        // Enrichment bumps confidence to 0.95 so enriched holdings won't
        // count here (which is the point — Browse-confirmed data doesn't
        // need review).
        if ((result.holding as any).parseConfidence < 0.9) summary.needsReview += 1;
        mutated = true;
        break;
      case "needs-attribution":
        summary.needsAttribution += 1;
        summary.skipped += 1;
        break;
      case "skipped-low-confidence":
        summary.skipped += 1;
        break;
      case "skipped-already-linked":
        // Not counted — this is the "no-op re-run" case, not really "skipped
        // due to low confidence." Left out of the count for shape clarity.
        break;
    }
  }
  if (mutated) {
    await writeUserDoc(userId, doc);
  }
  return summary;
}

/**
 * Extract a legacy itemId from a purchase — either the explicit field or
 * derived from the OrderLineItemID "itemId-transactionId" format. Returns
 * null when neither is present (rare — older manually-created purchases).
 */
function extractItemId(p: PortfolioPurchaseEntry): string | null {
  if (p.ebayItemId && p.ebayItemId.trim()) return p.ebayItemId.trim();
  if (p.ebayOrderId && p.ebayOrderId.includes("-")) {
    const first = p.ebayOrderId.split("-")[0].trim();
    return first || null;
  }
  return null;
}
