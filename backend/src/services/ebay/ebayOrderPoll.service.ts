/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — sale-detection poller.
 *
 * Replaces the previously-planned ITEM_SOLD webhook path as the PRIMARY
 * sale-ingestion mechanism. Webhook handler at ebayWebhook.routes.ts
 * remains wired (idempotency-safe race; account-deletion handler
 * required for compliance), but is unsubscribed at the eBay developer
 * portal and dormant in prod.
 *
 * Architecture (per docs/phase0/PROJECT_PLAN_2026-06-01.md Track 1):
 *   1. Read user's token + cursor from ebay_connections.
 *   2. Compute query window [cursor - 1h .. now] — back-walk is QUERY ONLY,
 *      not a persisted state change. The 1h overlap covers eBay's brief
 *      eventual-consistency window + clock skew between our server + theirs.
 *   3. GET /sell/fulfillment/v1/order with lastmodifieddate filter,
 *      paginated via response.next.
 *   4. Per order, per line item: extract listingId (legacyItemId first,
 *      fallback to listingId), cross-user holding lookup, call
 *      markHoldingSoldFromEbay (idempotent on holdingId+orderId — re-seen
 *      orders return marked-sold-deduped with zero side effects).
 *   5. Advance cursor MONOTONICALLY:
 *        newLastPolledAt = max(prev lastPolledAt, max(processed order.lastModifiedDate))
 *      Never written back below its prior value. Empty poll OR fetch
 *      failure mid-pagination → cursor unchanged → next poll re-walks
 *      the same window.
 *
 * What's left null on the ledger row (pending Finances enrichment):
 *   finalValueFee, paymentProcessingFee, promotedListingFee, adFee,
 *   otherFees, netPayout, actualShippingCost. ITEM_SOLD-class envelopes
 *   never carry fees; the order resource is the same shape. Fees arrive
 *   via the separate /sell/finances/v1/transaction sweep (Track 1 Slice
 *   A/B/C).
 *
 * Test interface: __ebayOrderPollInternals exposes the fetch helper for
 * mockable HTTP. NOT for prod consumption.
 */

import { getAccessToken } from "./ebayAuth.service.js";
import {
  readTokenRecord,
  writeTokenRecord,
  type EbayTokenRecord,
} from "./ebayTokenStore.service.js";
import {
  findHoldingByEbayListingIdAcrossUsers,
  markHoldingSoldFromEbay,
} from "../portfolioiq/portfolioStore.service.js";

const SANDBOX = (process.env.EBAY_ENV ?? "sandbox") !== "production";
const EBAY_API_BASE = SANDBOX ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";

const OVERLAP_BACK_WALK_MS = 60 * 60 * 1000;     // 1h query-window overlap
const PAGE_LIMIT = 50;                            // getOrders limit per page
const MAX_PAGES = 20;                             // safety cap (50 × 20 = 1000 orders / poll)

interface EbayOrderLineItem {
  lineItemId?: string;
  legacyItemId?: string;
  listingId?: string;
  title?: string;
  quantity?: number;
  lineItemCost?: { value?: string | number; currency?: string };
}

interface EbayOrder {
  orderId?: string;
  legacyOrderId?: string;
  creationDate?: string;
  lastModifiedDate?: string;
  orderFulfillmentStatus?: string;
  orderPaymentStatus?: string;
  buyer?: { username?: string };
  lineItems?: EbayOrderLineItem[];
  pricingSummary?: { total?: { value?: string | number; currency?: string } };
}

interface EbayGetOrdersResponse {
  total?: number;
  limit?: number;
  offset?: number;
  href?: string;
  next?: string;
  orders?: EbayOrder[];
}

export interface PollResult {
  status:
    | "ok"
    | "no-token"
    | "refresh-token-expired"
    | "fetch-failed";
  ordersFetched: number;
  lineItemsProcessed: number;
  matched: number;
  deduped: number;
  noMatchingHolding: number;
  markFailures: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  cursorAdvanced: boolean;
  error?: string;
}

function tsMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function maxIso(a: string | null, b: string | null): string | null {
  const ta = tsMs(a);
  const tb = tsMs(b);
  if (ta === 0 && tb === 0) return null;
  return ta >= tb ? a : b;
}

/**
 * Default page-fetch impl — exposed via __ebayOrderPollInternals for tests.
 */
async function defaultFetchPage(url: string, accessToken: string): Promise<EbayGetOrdersResponse> {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`getOrders ${r.status}: ${body.slice(0, 200)}`);
  }
  return (await r.json()) as EbayGetOrdersResponse;
}

let _fetchPageImpl = defaultFetchPage;

export async function pollEbayOrdersForUser(userId: string): Promise<PollResult> {
  const empty: PollResult = {
    status: "ok",
    ordersFetched: 0,
    lineItemsProcessed: 0,
    matched: 0,
    deduped: 0,
    noMatchingHolding: 0,
    markFailures: 0,
    cursorBefore: null,
    cursorAfter: null,
    cursorAdvanced: false,
  };

  const record = await readTokenRecord(userId);
  if (!record) {
    return { ...empty, status: "no-token" };
  }
  const cursorBefore = record.lastPolledAt ?? record.connectedAt ?? null;
  empty.cursorBefore = cursorBefore;
  empty.cursorAfter = cursorBefore;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("refresh token expired")) {
      return { ...empty, status: "refresh-token-expired", error: msg };
    }
    return { ...empty, status: "fetch-failed", error: msg };
  }

  // Query window: [cursor - 1h .. now). The back-walk is QUERY-only and
  // never written back. Idempotency on (holdingId, ebayOrderId) makes the
  // overlap safe (re-seen orders return marked-sold-deduped).
  const sinceMs = Math.max(0, tsMs(cursorBefore) - OVERLAP_BACK_WALK_MS);
  const sinceIso = sinceMs > 0 ? new Date(sinceMs).toISOString() : "1970-01-01T00:00:00.000Z";
  const filter = `lastmodifieddate:[${sinceIso}..]`;
  let url =
    `${EBAY_API_BASE}/sell/fulfillment/v1/order` +
    `?filter=${encodeURIComponent(filter)}` +
    `&limit=${PAGE_LIMIT}`;

  const orders: EbayOrder[] = [];
  let pages = 0;
  try {
    while (url && pages < MAX_PAGES) {
      const page = await _fetchPageImpl(url, accessToken);
      const pageOrders = Array.isArray(page.orders) ? page.orders : [];
      orders.push(...pageOrders);
      pages++;
      url = page.next ?? "";
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    console.warn(JSON.stringify({
      event: "ebay_poll_fetch_failed",
      source: "ebayOrderPoll.service",
      userId,
      cursorBefore,
      error: msg.slice(0, 300),
      pagesFetched: pages,
      ordersFetchedBeforeFail: orders.length,
    }));
    return { ...empty, status: "fetch-failed", error: msg, ordersFetched: orders.length };
  }

  // Process orders. Per-order failures do NOT halt the loop; they ALSO
  // don't advance the cursor past that order's lastModifiedDate (max
  // computed only over successfully-processed orders).
  let matched = 0;
  let deduped = 0;
  let noMatchingHolding = 0;
  let markFailures = 0;
  let lineItemsProcessed = 0;
  let maxLastModifiedProcessed: string | null = null;

  for (const order of orders) {
    const orderId = String(order.orderId ?? order.legacyOrderId ?? "").trim();
    if (!orderId) continue;
    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
    let orderHadFailure = false;

    for (const line of lineItems) {
      lineItemsProcessed++;
      const listingId = String(
        line.legacyItemId ?? line.listingId ?? "",
      ).trim();
      if (!listingId) {
        console.warn(JSON.stringify({
          event: "ebay_poll_no_matching_holding",
          source: "ebayOrderPoll.service",
          userId,
          orderId,
          reason: "line item missing legacyItemId and listingId",
        }));
        noMatchingHolding++;
        orderHadFailure = true;
        continue;
      }

      const match = await findHoldingByEbayListingIdAcrossUsers(listingId);
      if (!match) {
        console.warn(JSON.stringify({
          event: "ebay_poll_no_matching_holding",
          source: "ebayOrderPoll.service",
          userId,
          orderId,
          listingId,
        }));
        noMatchingHolding++;
        orderHadFailure = true;
        continue;
      }

      const qty = Math.max(1, Number(line.quantity ?? 1));
      const unitSalePrice = Number(line.lineItemCost?.value ?? 0);
      const saleConfirmedAt =
        order.creationDate ?? order.lastModifiedDate ?? new Date().toISOString();

      try {
        const result = await markHoldingSoldFromEbay(match.userId, match.holdingId, {
          ebayOrderId: orderId,
          ebayOfferId: match.holding.ebayOfferId ?? null,
          ebayListingId: listingId,
          ebayBuyerUsername: order.buyer?.username ?? null,
          saleConfirmedAt,
          quantitySold: qty,
          unitSalePrice,
          // Fee fields pending Finances enrichment — null-not-zero per
          // markHoldingSoldFromEbay's contract; needsReconciliation is
          // computed downstream.
          finalValueFee: null,
          paymentProcessingFee: null,
          promotedListingFee: null,
          adFee: null,
          otherFees: null,
          netPayout: null,
          actualShippingCost: null,
          suppliesCost: null,
          gradingCost: null,
        });
        if (result.status === "marked-sold-deduped") {
          deduped++;
        } else if (result.status === "marked-sold") {
          matched++;
        } else {
          console.warn(JSON.stringify({
            event: "ebay_poll_mark_failed",
            source: "ebayOrderPoll.service",
            userId, orderId, listingId,
            markStatus: result.status,
            reason: result.status === "invalid-input" ? result.reason : undefined,
          }));
          markFailures++;
          orderHadFailure = true;
        }
      } catch (e: any) {
        console.warn(JSON.stringify({
          event: "ebay_poll_mark_failed",
          source: "ebayOrderPoll.service",
          userId, orderId, listingId,
          error: String(e?.message ?? e).slice(0, 200),
        }));
        markFailures++;
        orderHadFailure = true;
      }
    }

    if (!orderHadFailure && order.lastModifiedDate) {
      maxLastModifiedProcessed = maxIso(maxLastModifiedProcessed, order.lastModifiedDate);
    }
  }

  // Monotonic cursor advance: never below the previous value.
  let cursorAfter = cursorBefore;
  let cursorAdvanced = false;
  if (maxLastModifiedProcessed) {
    const candidate = maxIso(cursorBefore, maxLastModifiedProcessed);
    if (candidate && tsMs(candidate) > tsMs(cursorBefore)) {
      cursorAfter = candidate;
      cursorAdvanced = true;
      // Persist (only when actually advancing, to avoid unnecessary writes).
      const updated: EbayTokenRecord = { ...record, lastPolledAt: cursorAfter };
      try {
        await writeTokenRecord(updated);
      } catch (e: any) {
        console.warn(JSON.stringify({
          event: "ebay_poll_cursor_persist_failed",
          source: "ebayOrderPoll.service",
          userId,
          error: String(e?.message ?? e).slice(0, 200),
        }));
        // Don't claim cursor advanced if persistence failed.
        cursorAfter = cursorBefore;
        cursorAdvanced = false;
      }
    }
  }

  const result: PollResult = {
    status: "ok",
    ordersFetched: orders.length,
    lineItemsProcessed,
    matched,
    deduped,
    noMatchingHolding,
    markFailures,
    cursorBefore,
    cursorAfter,
    cursorAdvanced,
  };

  console.log(JSON.stringify({
    event: "ebay_poll_summary",
    source: "ebayOrderPoll.service",
    userId,
    ...result,
  }));

  return result;
}

/**
 * Test-only internals. Allows the test file to swap the page-fetch
 * implementation without stubbing global fetch (cleaner with vi.mock
 * boundaries).
 */
export const __ebayOrderPollInternals = {
  setFetchPageImpl(fn: typeof defaultFetchPage): void {
    _fetchPageImpl = fn;
  },
  resetFetchPageImpl(): void {
    _fetchPageImpl = defaultFetchPage;
  },
};
