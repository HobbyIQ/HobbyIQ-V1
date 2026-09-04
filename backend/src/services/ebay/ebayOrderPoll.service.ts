/**
 * EBAY-POLL-INGESTION-C1 (2026-06-01) — sale-detection poller.
 * CF-THE-ACCOUNT-SYNC-RESOLVES-EVERY-SALE (D26, Drew 2026-08-30) — rewritten
 * so that a sale we did not list still lands on a card.
 *
 * WHAT THIS USED TO DO, AND WHY IT DID NOTHING.
 *
 * Each sold line item was looked up by OUR listing id
 * (`findHoldingByEbayListingIdAcrossUsers`). A card the user listed on eBay
 * themselves carries no such id, so it could never match, and a no-match was
 * simply DROPPED. Worse, the cursor advanced only from orders in which every
 * line matched — so with `matched=0` the cursor never moved and the same
 * orders were re-fetched every hour, forever.
 *
 * Measured 2026-08-30 07:46Z (identical to the spec's 03:15Z reading, five
 * hours and five cycles later):
 *
 *   done users=8 orders=29 matched=0 deduped=0 noMatch=29 markFail=0
 *        fetchFail=2 refreshExpired=0 cursorsAdvanced=0
 *
 *   5,849 `ebay_poll_no_matching_holding` in 3 days, 29 distinct listings,
 *   4 users: user-199fcbc9 2,531 (13 listings) · user-7b6cbc92 1,863 (9) ·
 *   user-cfacd098 828 (4) · user-f31442a6 627 (3).
 *   0 occurrences of `cursorAdvanced: true` in the same window, and
 *   `lastPolledAt` is NULL on all 8 connection docs: no user's cursor has
 *   ever advanced, not once, since the poll shipped on 2026-06-01.
 *   `ebay_poll_fetch_failed` never appears either — `fetchFail=2` was
 *   returning from the TOKEN step, above the only line that logs.
 *
 * WHAT IT DOES NOW, per sold line item:
 *
 *   1. RESOLVE the line to a catalog card from its listing title (+ Browse
 *      item specifics when available) through the same identity path the
 *      import uses — `ebayAccountSaleIdentity.service`, which carries D28's
 *      card-number guard and D23's hyphen-insensitive number compare. >= 0.9
 *      auto-links; below that the line PARKS with its best candidate.
 *   2. RECORD the sale. A user's own sale is an observed transaction, so it
 *      goes in the pool exactly once — either through the holding's ledger
 *      emit (which already writes `ebay-user-sale` under the holding's pinned
 *      identity) or, when there is no holding or the holding carries no
 *      identity, directly as `ebay-account`. The two paths are disjoint by
 *      construction; see `poolWrittenBy`.
 *   3. MARK the seller's holding sold when they hold that card: the holding
 *      carrying the listing id, else the exact identity + grade, else the
 *      identity un-graded.
 *   4. ADVANCE THE CURSOR on every PROCESSED order. A no-match, a park and a
 *      sale recorded without a holding are all processed. Only a fetch or a
 *      write failure pins it.
 *   5. SKIP a reconnect-required user instead of failing them every hour.
 *
 * The back-walk overlap stays: the query window is [cursor - 1h .. now), which
 * covers eBay's eventual-consistency window and clock skew. Every write on the
 * path is idempotent, so the overlap costs nothing.
 *
 * Test interface: __ebayOrderPollInternals exposes the fetch helper and the
 * write seams for mockable tests. NOT for prod consumption.
 */

import { getAccessToken } from "./ebayAuth.service.js";
import {
  readTokenRecord,
  writeTokenRecord,
  markReconnectRequired,
  connectionStatusOf,
  type EbayTokenRecord,
} from "./ebayTokenStore.service.js";
import { isTerminalTokenError } from "./ebayAuth.service.js";
import {
  findHoldingByEbayListingIdAcrossUsers,
  markHoldingSoldFromEbay,
  findSellerHoldingForIdentity,
  upsertEbayAccountSale,
  poolIdentityForHolding,
  type EbayAccountSaleEntry,
} from "../portfolioiq/portfolioStore.service.js";
import { recordSoldComp } from "../portfolioiq/soldCompsStore.service.js";
import { normalizeSellerHandle } from "../compiq/sellerIndependence.js";
import {
  resolveEbaySaleIdentity,
  type EbaySaleIdentity,
} from "./ebayAccountSaleIdentity.service.js";

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
    | "reconnect-required"
    | "fetch-failed";
  ordersFetched: number;
  /** Orders whose every line reached a decision. These are the ones the
   *  cursor is allowed to move past. */
  ordersProcessed: number;
  lineItemsProcessed: number;
  /** D26 outcome counters. `lines = resolvedAuto + parked + unresolvable`,
   *  disjoint: every line takes exactly one of the three. */
  resolvedAuto: number;
  parked: number;
  unresolvable: number;
  /** Pool rows this line is accounted for by. `recorded = recordedViaHolding
   *  + recordedViaAccount`, also disjoint — exactly one path owns each sale. */
  recorded: number;
  recordedViaHolding: number;
  recordedViaAccount: number;
  /** Holdings marked sold (new or already-sold replay). */
  holdingsMarked: number;
  /** Legacy names kept so existing dashboards and the job summary keep
   *  reading: `matched` = holdings newly marked sold, `deduped` = replays. */
  matched: number;
  deduped: number;
  noMatchingHolding: number;
  markFailures: number;
  /** Lines that failed a WRITE. These, and only these, pin the cursor. */
  failed: number;
  cursorBefore: string | null;
  cursorAfter: string | null;
  cursorAdvanced: boolean;
  error?: string;
}

/** Options the backfill passes; the hourly poll passes none. */
export interface PollOptions {
  /** Override the query window's start. The backfill replays 90 days. */
  since?: string | null;
  /** REPORT ONLY. Resolve and count; write nothing, advance nothing. The
   *  backfill's default. */
  dryRun?: boolean;
  /** Leave the cursor alone even when writing (the backfill replays history
   *  and must not drag a live cursor backwards or forwards). */
  advanceCursor?: boolean;
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
let _resolveIdentityImpl = resolveEbaySaleIdentity;

function emptyResult(): PollResult {
  return {
    status: "ok",
    ordersFetched: 0,
    ordersProcessed: 0,
    lineItemsProcessed: 0,
    resolvedAuto: 0,
    parked: 0,
    unresolvable: 0,
    recorded: 0,
    recordedViaHolding: 0,
    recordedViaAccount: 0,
    holdingsMarked: 0,
    matched: 0,
    deduped: 0,
    noMatchingHolding: 0,
    markFailures: 0,
    failed: 0,
    cursorBefore: null,
    cursorAfter: null,
    cursorAdvanced: false,
  };
}

export async function pollEbayOrdersForUser(
  userId: string,
  opts: PollOptions = {},
): Promise<PollResult> {
  const dryRun = opts.dryRun === true;
  const mayAdvanceCursor = opts.advanceCursor !== false && !dryRun;
  const empty = emptyResult();

  const record = await readTokenRecord(userId);
  if (!record) {
    return { ...empty, status: "no-token" };
  }
  // The connected account's storefront name, normalized. `ebayAuth` writes
  // the literal "unknown" when eBay's identity call fails; that is an
  // absence, not a seller, and must not become a pool row's seller.
  const rawEbayUser = (record as { ebayUserId?: string | null }).ebayUserId ?? null;
  const sellerHandle =
    rawEbayUser && rawEbayUser !== "unknown" ? normalizeSellerHandle(rawEbayUser) : null;
  const cursorBefore = record.lastPolledAt ?? record.connectedAt ?? null;
  empty.cursorBefore = cursorBefore;
  empty.cursorAfter = cursorBefore;

  // D26 deliverable 5. A connection eBay has already refused is not retried
  // hourly — it is skipped, and the account page asks the user to reconnect.
  // Before this, two users burned a failed token call every cycle for weeks
  // and the only trace was a counter reading 2.
  if (connectionStatusOf(record) === "reconnect-required") {
    console.log(JSON.stringify({
      event: "ebay_poll_skipped_reconnect_required",
      source: "ebayOrderPoll.service",
      userId,
      reason: record.connectionStatusReason ?? null,
      since: record.connectionStatusAt ?? null,
    }));
    return { ...empty, status: "reconnect-required", error: record.connectionStatusReason ?? undefined };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId);
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
    // This branch used to return silently. It is the branch that produced
    // `fetchFail=2` every hour with zero log lines to explain it.
    console.warn(JSON.stringify({
      event: "ebay_poll_token_failed",
      source: "ebayOrderPoll.service",
      userId,
      terminal: isTerminalTokenError(msg),
      error: msg.slice(0, 300),
    }));
    if (msg.includes("refresh token expired")) {
      return { ...empty, status: "refresh-token-expired", error: msg };
    }
    if (isTerminalTokenError(msg)) {
      // getAccessToken already marked it; this is the belt for a path that
      // threw before reaching the mark (and it is idempotent).
      if (!dryRun) await markReconnectRequired(userId, msg.slice(0, 200)).catch(() => false);
      return { ...empty, status: "reconnect-required", error: msg };
    }
    return { ...empty, status: "fetch-failed", error: msg };
  }

  // Query window: [since .. now). The back-walk is QUERY-only and never
  // written back. Idempotency on (holdingId, ebayOrderId) and on
  // (ebayOrderId, lineItemId) makes the overlap free.
  const sinceOverrideMs = tsMs(opts.since ?? null);
  const sinceMs = sinceOverrideMs > 0
    ? sinceOverrideMs
    : Math.max(0, tsMs(cursorBefore) - OVERLAP_BACK_WALK_MS);
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
  } catch (e: unknown) {
    const msg = String((e as Error)?.message ?? e);
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

  const r = emptyResult();
  r.ordersFetched = orders.length;
  r.cursorBefore = cursorBefore;
  r.cursorAfter = cursorBefore;
  let maxLastModifiedProcessed: string | null = null;

  for (const order of orders) {
    const orderId = String(order.orderId ?? order.legacyOrderId ?? "").trim();
    if (!orderId) continue;
    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
    // D26 deliverable 4. `orderHadWriteFailure`, NOT "orderHadFailure". A
    // no-match, a park and a sale recorded without a holding are PROCESSED
    // outcomes; only a write that did not happen pins the cursor.
    let orderHadWriteFailure = false;

    for (const line of lineItems) {
      r.lineItemsProcessed++;
      try {
        const outcome = await processSoldLine(userId, order, orderId, line, dryRun, sellerHandle);
        r.resolvedAuto += outcome.resolvedAuto;
        r.parked += outcome.parked;
        r.unresolvable += outcome.unresolvable;
        r.recordedViaHolding += outcome.recordedViaHolding;
        r.recordedViaAccount += outcome.recordedViaAccount;
        r.holdingsMarked += outcome.holdingsMarked;
        r.matched += outcome.matched;
        r.deduped += outcome.deduped;
        r.noMatchingHolding += outcome.noMatchingHolding;
        r.markFailures += outcome.markFailures;
        if (outcome.writeFailed) {
          r.failed++;
          orderHadWriteFailure = true;
        }
      } catch (e: unknown) {
        console.warn(JSON.stringify({
          event: "ebay_poll_line_failed",
          source: "ebayOrderPoll.service",
          userId,
          orderId,
          lineItemId: String(line.lineItemId ?? ""),
          error: String((e as Error)?.message ?? e).slice(0, 200),
        }));
        r.failed++;
        orderHadWriteFailure = true;
      }
    }

    if (!orderHadWriteFailure) {
      r.ordersProcessed++;
      if (order.lastModifiedDate) {
        maxLastModifiedProcessed = maxIso(maxLastModifiedProcessed, order.lastModifiedDate);
      }
    }
  }
  r.recorded = r.recordedViaHolding + r.recordedViaAccount;

  // Monotonic cursor advance: never below the previous value, and never at all
  // on a dry run.
  if (mayAdvanceCursor && maxLastModifiedProcessed) {
    const candidate = maxIso(cursorBefore, maxLastModifiedProcessed);
    if (candidate && tsMs(candidate) > tsMs(cursorBefore)) {
      const updated: EbayTokenRecord = { ...record, lastPolledAt: candidate };
      try {
        await writeTokenRecord(updated);
        r.cursorAfter = candidate;
        r.cursorAdvanced = true;
      } catch (e: unknown) {
        console.warn(JSON.stringify({
          event: "ebay_poll_cursor_persist_failed",
          source: "ebayOrderPoll.service",
          userId,
          error: String((e as Error)?.message ?? e).slice(0, 200),
        }));
        // Don't claim cursor advanced if persistence failed.
      }
    }
  }

  console.log(JSON.stringify({
    event: "ebay_poll_summary",
    source: "ebayOrderPoll.service",
    userId,
    dryRun,
    ...r,
  }));

  return r;
}

// ─── One sold line ─────────────────────────────────────────────────────────

interface LineOutcome {
  resolvedAuto: number;
  parked: number;
  unresolvable: number;
  recordedViaHolding: number;
  recordedViaAccount: number;
  holdingsMarked: number;
  matched: number;
  deduped: number;
  noMatchingHolding: number;
  markFailures: number;
  writeFailed: boolean;
}

function zeroOutcome(): LineOutcome {
  return {
    resolvedAuto: 0,
    parked: 0,
    unresolvable: 0,
    recordedViaHolding: 0,
    recordedViaAccount: 0,
    holdingsMarked: 0,
    matched: 0,
    deduped: 0,
    noMatchingHolding: 0,
    markFailures: 0,
    writeFailed: false,
  };
}

async function processSoldLine(
  userId: string,
  order: EbayOrder,
  orderId: string,
  line: EbayOrderLineItem,
  dryRun: boolean,
  /** CF-INDEPENDENCE-MUST-NAME-ITS-BASIS (2026-09-04). The connected eBay
   *  account's own storefront name. On THIS path the seller is not a guess:
   *  these are the connected user's own completed orders, so the account
   *  that sold the card is the account we polled. Null when eBay's identity
   *  call never resolved a username (`ebayAuth` stores "unknown"). */
  sellerHandle: string | null,
): Promise<LineOutcome> {
  const out = zeroOutcome();
  const listingId = String(line.legacyItemId ?? line.listingId ?? "").trim() || null;
  // eBay always supplies a lineItemId; when it does not, the listing id (then
  // the order id) keys the line, so the idempotency key is never empty.
  const lineItemId = String(line.lineItemId ?? "").trim() || listingId || orderId;
  const title = String(line.title ?? "").trim() || null;
  const quantity = Math.max(1, Number(line.quantity ?? 1));
  const unitSalePrice = Number(line.lineItemCost?.value ?? 0);
  const currency = String(line.lineItemCost?.currency ?? "") || null;
  const soldAt = order.creationDate ?? order.lastModifiedDate ?? new Date().toISOString();

  // ── 1. Resolve the line to a card ────────────────────────────────────────
  const identity: EbaySaleIdentity = await _resolveIdentityImpl({ title });
  if (identity.resolution === "auto") out.resolvedAuto = 1;
  else if (identity.resolution === "parked") out.parked = 1;
  else out.unresolvable = 1;

  // ── 2. Find the seller's holding ─────────────────────────────────────────
  // Step 0: the holding carrying OUR listing id. Cross-user, because a listing
  // id is globally unique and the seller may not be the connected user in the
  // legacy shared-listing case this lookup was written for.
  let holdingUserId: string | null = null;
  let holdingId: string | null = null;
  let holdingMatchedBy: EbayAccountSaleEntry["holdingMatchedBy"] = null;
  let holdingHadIdentity = false;

  if (listingId) {
    const byListing = await findHoldingByEbayListingIdAcrossUsers(listingId).catch(() => null);
    if (byListing) {
      holdingUserId = byListing.userId;
      holdingId = byListing.holdingId;
      holdingMatchedBy = "listing-id";
      holdingHadIdentity = !!poolIdentityForHolding(byListing.holding).cardId;
    }
  }
  // Steps 1-2: the seller's own inventory, by the identity we just resolved.
  if (!holdingId && identity.resolution === "auto" && identity.slug) {
    const bySlug = await findSellerHoldingForIdentity(userId, identity.slug, {
      gradeCompany: identity.fields.gradeCompany,
      gradeValue: identity.fields.gradeValue,
    }).catch(() => null);
    if (bySlug) {
      holdingUserId = userId;
      holdingId = bySlug.holdingId;
      holdingMatchedBy = bySlug.matchedBy;
      holdingHadIdentity = !!poolIdentityForHolding(bySlug.holding).cardId;
    }
  }
  if (!holdingId) {
    out.noMatchingHolding = 1;
    console.log(JSON.stringify({
      event: "ebay_poll_no_matching_holding",
      source: "ebayOrderPoll.service",
      userId,
      orderId,
      listingId,
      resolution: identity.resolution,
      slug: identity.slug,
      detail: "no holding for this sale; the sale is still recorded when it resolved",
    }));
  }

  // ── 3. Mark the holding sold ─────────────────────────────────────────────
  // `poolOwnedByHolding` decides who writes the pool row. When
  // markHoldingSoldFromEbay succeeds AND the holding carried a pinned hiq
  // slug, its own emit writes the sale as `ebay-user-sale` under that
  // identity. Anything else and this poll writes it as `ebay-account`.
  // Exactly one of the two, never both, never neither.
  let poolOwnedByHolding = false;
  if (holdingId && holdingUserId && !dryRun) {
    if (unitSalePrice <= 0) {
      // markHoldingSoldFromEbay refuses a non-positive price, so do not call
      // it and do not count a mark failure for a decision we made here.
      out.markFailures = 1;
      console.warn(JSON.stringify({
        event: "ebay_poll_mark_skipped_no_price",
        source: "ebayOrderPoll.service",
        userId, orderId, listingId, holdingId,
      }));
    } else {
      const result = await markHoldingSoldFromEbay(holdingUserId, holdingId, {
        ebayOrderId: orderId,
        ebayOfferId: null,
        ebayListingId: listingId,
        ebayBuyerUsername: order.buyer?.username ?? null,
        saleConfirmedAt: soldAt,
        quantitySold: quantity,
        unitSalePrice,
        // Fee fields pending Finances enrichment — null-not-zero per
        // markHoldingSoldFromEbay's contract.
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
      if (result.status === "marked-sold") {
        out.holdingsMarked = 1;
        out.matched = 1;
        poolOwnedByHolding = holdingHadIdentity;
      } else if (result.status === "marked-sold-deduped") {
        out.holdingsMarked = 1;
        out.deduped = 1;
        poolOwnedByHolding = holdingHadIdentity;
      } else {
        out.markFailures = 1;
        console.warn(JSON.stringify({
          event: "ebay_poll_mark_failed",
          source: "ebayOrderPoll.service",
          userId, orderId, listingId, holdingId,
          markStatus: result.status,
          reason: result.status === "invalid-input" ? result.reason : undefined,
        }));
      }
    }
  } else if (holdingId && dryRun) {
    out.holdingsMarked = 1;
    poolOwnedByHolding = holdingHadIdentity;
  }
  if (poolOwnedByHolding) out.recordedViaHolding = 1;

  // ── 4. Record the sale in the pool ───────────────────────────────────────
  let poolRowId: string | null = null;
  let poolWrittenBy: EbayAccountSaleEntry["poolWrittenBy"] = poolOwnedByHolding ? "holding-ledger" : null;
  if (!poolOwnedByHolding && identity.resolution === "auto" && identity.slug && unitSalePrice > 0) {
    if (dryRun) {
      out.recordedViaAccount = 1;
      poolWrittenBy = "ebay-account";
    } else {
      const written = await recordSoldComp({
        cardId: identity.slug,
        playerName: identity.fields.player ?? "",
        cardYear: identity.fields.year,
        setName: identity.fields.setName,
        parallel: identity.fields.parallel,
        cardNumber: identity.fields.cardNumber,
        isAuto: identity.fields.isAuto,
        printRun: identity.fields.printRun,
        sport: identity.fields.sport,
        gradeCompany: identity.fields.gradeCompany,
        gradeValue: identity.fields.gradeValue,
        // GROSS sale price. Fees land on the holding's P&L, never on the comp
        // (a comp is what the card traded for, not what the seller kept).
        price: unitSalePrice,
        soldAt,
        source: "ebay-account",
        // Idempotent on (ebayOrderId, lineItemId): the composite id is
        // `ebay-account::<orderId>::<lineItemId>`, so the hourly back-walk
        // and the 90-day backfill converge on one row.
        sourceExternalId: `${orderId}::${lineItemId}`,
        contributorUserId: userId,
        title,
        imageUrl: identity.fields.imageUrl,
        // The seller of an `ebay-account` row is the connected account
        // itself — see the parameter's note. This is the one vendor-side
        // path where seller identity is known WITHOUT the vendor exposing
        // it, because the sale is the user's own.
        sellerHandle,
        verifiedByUser: true,
        confidence: 1.0,
      });
      if (written.written || written.deduped) {
        out.recordedViaAccount = 1;
        poolRowId = written.id ?? null;
        poolWrittenBy = "ebay-account";
      } else {
        // A pool write that did not happen is a WRITE failure: it pins the
        // cursor so the next cycle tries this order again.
        out.writeFailed = true;
        console.warn(JSON.stringify({
          event: "ebay_poll_pool_write_failed",
          source: "ebayOrderPoll.service",
          userId, orderId, listingId,
          slug: identity.slug,
          reason: written.reason ?? "unknown",
        }));
      }
    }
  }

  // ── 5. The sale record on the user's doc ─────────────────────────────────
  // Written for EVERY line, resolved or not — a parked sale the user has never
  // seen is the thing D26 exists to surface.
  if (!dryRun) {
    await upsertEbayAccountSale(userId, {
      ebayOrderId: orderId,
      lineItemId,
      ebayListingId: listingId,
      soldAt,
      title,
      quantity,
      unitSalePrice,
      currency,
      buyerUsername: order.buyer?.username ?? null,
      status:
        identity.resolution === "auto" ? "resolved"
        : identity.resolution === "parked" ? "parked"
        : "unresolved",
      cardId: identity.resolution === "auto" ? identity.slug : null,
      proposedIdentity:
        identity.resolution === "parked" && identity.slug
          ? { slug: identity.slug, confidence: identity.confidence, matchedBy: identity.matchedBy }
          : null,
      unresolvedReason: identity.resolution === "unresolvable" ? identity.reason : null,
      fields: {
        sport: identity.fields.sport,
        year: identity.fields.year,
        setName: identity.fields.setName,
        player: identity.fields.player,
        cardNumber: identity.fields.cardNumber,
        parallel: identity.fields.parallel,
        isAuto: identity.fields.isAuto,
        printRun: identity.fields.printRun,
        gradeCompany: identity.fields.gradeCompany,
        gradeValue: identity.fields.gradeValue,
      },
      imageUrl: identity.fields.imageUrl,
      holdingId,
      holdingMatchedBy,
      poolRowId,
      poolWrittenBy,
    });
  }

  return out;
}

/**
 * Test-only internals. Allows the test file to swap the page-fetch and the
 * identity resolution without stubbing global fetch or the catalog.
 */
export const __ebayOrderPollInternals = {
  setFetchPageImpl(fn: typeof defaultFetchPage): void {
    _fetchPageImpl = fn;
  },
  resetFetchPageImpl(): void {
    _fetchPageImpl = defaultFetchPage;
  },
  setResolveIdentityImpl(fn: typeof resolveEbaySaleIdentity): void {
    _resolveIdentityImpl = fn;
  },
  resetResolveIdentityImpl(): void {
    _resolveIdentityImpl = resolveEbaySaleIdentity;
  },
};
