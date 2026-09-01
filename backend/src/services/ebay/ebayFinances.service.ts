// CF-EBAY-FINANCES-ENRICHMENT (2026-06-04 — Group D Phase A):
// eBay Sell Finances API client + pure response-to-fee mapper.
//
// Reuses the existing OAuth token store (getAccessToken) and mirrors the
// auth header / error shape from ebayOrderPoll.service.ts so the two
// eBay-side surfaces stay consistent.
//
// PHASE A = SHADOW MODE: built with mocked Finances responses; first
// real-sale verification rides the eventual first ITEM_SOLD that lands.
// The mapFinancesToFees() function below is THE load-bearing assumption
// to verify against the first real Finances payload — if the bucketing
// turns out to need adjustment, change it here in one place and the
// enrichment helper / scheduled job pick up the fix transparently.

import { getAccessToken } from "./ebayAuth.service.js";

// CF-EBAY-FINANCES-HOSTNAME (2026-07-12, Drew — live E2E on prod).
// The Sell Finances API lives on apiz.ebay.com, NOT api.ebay.com. Same
// pattern as Commerce Identity (see ebayAuth.service.ts:41). Verified
// live 2026-07-12:
//   api.ebay.com/sell/finances/v1/transaction  → 404 with empty body
//   apiz.ebay.com/sell/finances/v1/transaction → 200 with real data
// The 404 was not a scope failure — sell.finances IS granted — it was
// pure routing: eBay's edge returns 404 for any /sell/finances path
// hitting the api.ebay.com hostname. Sandbox mirrors this: api.sandbox.
// ebay.com/sell/finances also 404s; apiz.sandbox.ebay.com/sell/finances
// serves. See eBay docs "Base URL" section on the Sell Finances API.
const FINANCES_BASE_URL_PROD = "https://apiz.ebay.com/sell/finances/v1";
const FINANCES_BASE_URL_SANDBOX = "https://apiz.sandbox.ebay.com/sell/finances/v1";
const FINANCES_BASE_URL =
  (process.env.EBAY_ENV ?? "sandbox") === "production"
    ? FINANCES_BASE_URL_PROD
    : FINANCES_BASE_URL_SANDBOX;
const MARKETPLACE_HEADER = "EBAY_US";
const MAX_PAGES = 10; // safety cap; Finances rarely returns more than 1-2 pages per order
const PAGE_LIMIT = 50;

// ─── Public types ──────────────────────────────────────────────────────────

export interface FinancesAmount {
  value: string;
  currency: string;
}

export interface FinancesFee {
  feeType: string;
  amount: FinancesAmount;
  feeMemo?: string;
}

// D34 (2026-08-31): eBay carries the per-fee breakdown on the SALE
// transaction under `orderLineItems[].marketplaceFees[]` — NOT in a
// top-level `fees[]`. The Phase-A shape assumed `fees[]` (see the mapper
// note below); every unit test built its fixtures that way, so the suite
// stayed green while the five fee fields came back null on real orders.
// Both shapes are read now: `fees[]` stays supported because REFUND /
// NON_SALE_CHARGE transactions do carry fees at the top level, and
// dropping it would trade one blind spot for another.
export interface FinancesOrderLineItem {
  lineItemId?: string;
  feeBasisAmount?: FinancesAmount;
  marketplaceFees?: FinancesFee[];
}

export interface FinancesTransaction {
  transactionId: string;
  orderId: string | null;
  amount: FinancesAmount;
  totalFeeBasisAmount?: FinancesAmount;
  /** Total selling fees for the order. When present on a SALE, `amount` is
   *  gross and the seller's credit is `amount - totalFeeAmount`. */
  totalFeeAmount?: FinancesAmount;
  fees?: FinancesFee[];
  orderLineItems?: FinancesOrderLineItem[];
  payoutId?: string;
  transactionType: string; // "SALE" | "REFUND" | "SHIPPING_LABEL" | "TRANSFER" | "ADJUSTMENT" | "NON_SALE_CHARGE" | ...
  transactionStatus: string;
  transactionDate: string;
  references?: Array<{ referenceId: string; referenceType: string }>;
}

interface FinancesTransactionsPage {
  transactions?: FinancesTransaction[];
  next?: string | null;
  total?: number;
}

export interface FinancesFeeMap {
  finalValueFee: number | null;
  paymentProcessingFee: number | null;
  promotedListingFee: number | null;
  adFee: number | null;
  otherFees: number | null;
  netPayout: number | null;
  actualShippingCost: number | null;
}

/**
 * D34 R2: how netPayout was arrived at.
 *   "none"                    — no SALE transaction; netPayout is null.
 *   "amount_minus_total_fees" — EVERY SALE carried totalFeeAmount; each one's
 *                               fees were subtracted from its own gross.
 *   "amount_as_net"           — NO SALE carried totalFeeAmount; each amount was
 *                               taken as already-net (the pre-D34 assumption).
 *   "mixed_per_line_item"     — some SALEs carried totalFeeAmount and some did
 *                               not. The sum is still correct (attribution is
 *                               per transaction), but the basis is compound and
 *                               says so rather than reporting a clean one.
 *   "sale_minus_refunds"      — as above, with REFUND transactions netted in.
 *                               Suffix, not a replacement: see netPayoutBasis.
 */
export type NetPayoutBasis =
  | "none"
  | "amount_minus_total_fees"
  | "amount_as_net"
  | "mixed_per_line_item";

/**
 * D34: the fee-type strings that landed in `otherFees` because no bucket
 * claimed them. Surfaced (not persisted) so an unrecognized eBay fee type
 * shows up in the enrichment log as a named string instead of silently
 * inflating a catch-all. Empty on a fully-recognized payload.
 */
export interface FinancesFeeMapDiagnostics {
  unknownFeeTypes: string[];
  /** true when the breakdown came from orderLineItems[].marketplaceFees[]. */
  sawLineItemFees: boolean;
  /** true when a top-level fees[] contributed (REFUND / NON_SALE_CHARGE). */
  sawTopLevelFees: boolean;
  /** SALE `amount` summed as eBay returned it, before any fee subtraction. */
  saleAmountTotal: number | null;
  /** `totalFeeAmount` summed across SALE transactions, when eBay sent it. */
  totalFeeAmountTotal: number | null;
  /** How netPayout was arrived at — see NetPayoutBasis. */
  netPayoutBasis: NetPayoutBasis;
  /** D34 R2: SALE transactions seen. */
  saleTransactionCount: number;
  /** D34 R2: how many of those carried a totalFeeAmount. */
  saleTransactionsWithTotalFee: number;
  /** D34 R2: REFUND amounts netted out of the payout (positive = refunded). */
  refundTotal: number | null;
  /**
   * D34 R2: TRUE when this payload is a complete fee fetch — eBay answered
   * with at least one SALE transaction, so what it did NOT send is a real
   * absence rather than a question never asked. The reconciliation surface
   * keys "is this row still waiting on eBay" on this, NOT on netPayout.
   */
  feeFetchComplete: boolean;
  /**
   * D34 R2: TRUE when the fetch was complete AND eBay sent no SHIPPING_LABEL.
   * That is a fact about eBay ("no label was bought through us"), not a
   * measurement of what the seller paid — so actualShippingCost stays NULL
   * and this flag is what lets the row close. Never write a 0 here.
   */
  shippingAbsentFromEbay: boolean;
}

// ─── Auth + fetch primitive (mirrors ebayOrderPoll.service.ts:120-134) ────

async function fetchFinancesPage(
  url: string,
  accessToken: string,
): Promise<FinancesTransactionsPage> {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "X-EBAY-C-MARKETPLACE-ID": MARKETPLACE_HEADER,
    },
  });
  if (r.status === 404) return { transactions: [] };
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`[ebay][finances] getTransactions ${r.status}: ${body.slice(0, 200)}`);
  }
  return (await r.json()) as FinancesTransactionsPage;
}

// Test seam — vi.mock can replace _fetchPageImpl without intercepting fetch.
export let _fetchPageImpl = fetchFinancesPage;
export function __setFetchPageImplForTests(impl: typeof fetchFinancesPage): void {
  _fetchPageImpl = impl;
}
export function __resetFetchPageImplForTests(): void {
  _fetchPageImpl = fetchFinancesPage;
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Fetch every Finances transaction for one eBay orderId. Returns:
 *   - non-empty array: transactions found within the 90-day Finances window
 *   - empty array:     order is in the window but has no matching transactions
 *                      (rare; usually means payout still processing)
 *   - null:            access-token failure / network failure / aborted before
 *                      first page; caller treats as "skip this order, retry
 *                      next sweep"
 *
 * Filter format documented at developer.ebay.com/api-docs/sell/finances/
 * resources/transaction/methods/getTransactions — uses the eBay-specific
 * filter syntax `filter=orderId:{<id>}` and `filter=transactionStatus:{...}`.
 */
export async function getTransactionsForOrder(
  userId: string,
  orderId: string,
): Promise<FinancesTransaction[] | null> {
  if (!userId || !orderId) return null;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId);
  } catch (err: any) {
    console.warn(
      "[ebay][finances] getAccessToken failed:",
      err?.message ?? err,
    );
    return null;
  }

  const baseFilter = `filter=orderId:{${encodeURIComponent(orderId)}}`;
  let offset = 0;
  const all: FinancesTransaction[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${FINANCES_BASE_URL}/transaction?${baseFilter}&limit=${PAGE_LIMIT}&offset=${offset}`;
    let body: FinancesTransactionsPage;
    try {
      body = await _fetchPageImpl(url, accessToken);
    } catch (err: any) {
      console.warn(
        "[ebay][finances] page fetch failed:",
        err?.message ?? err,
        "page=", page,
        "orderId=", orderId,
      );
      return all.length > 0 ? all : null;
    }
    const txns = Array.isArray(body.transactions) ? body.transactions : [];
    all.push(...txns);
    if (!body.next || txns.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  return all;
}

// ─── Pure mapper ──────────────────────────────────────────────────────────
//
// THIS IS THE LOAD-BEARING ASSUMPTION TO VERIFY AGAINST THE FIRST REAL
// FINANCES RESPONSE. The Phase-A mocks exercise the SHAPE we expect from
// eBay's docs; the first real-sale Finances payload will either confirm
// or correct this bucketing. When that real-sale data lands:
//   1. Log the full payload (the shadow-mode job emits this — see
//      ebayFinancesEnrichment.job.ts).
//   2. Adjust the feeType pattern lists below if eBay's actual feeType
//      values differ from documented strings.
//   3. The enrichment helper / scheduled job pick up the fix without
//      further changes.
//
// Bucketing rules (from the approved design):
//   - FINAL_VALUE_FEE                                     → finalValueFee
//   - PAYMENT_PROCESSING_FEE* (incl. INTERNATIONAL)       → paymentProcessingFee
//   - FINAL_VALUE_FEE_AD_FEE / AD_FEE (Promoted Standard) → promotedListingFee
//   - AD_FEE_ADV* / PROMOTED_DISPLAY*                     → adFee
//   - everything else                                      → otherFees
//   - SALE transaction's amount.value (= seller's net credit)
//                                                          → netPayout
//   - SHIPPING_LABEL transaction's amount.value
//                                                          → actualShippingCost
//
// NOTHING is dropped. Every fee on every txn lands in exactly one of the
// five buckets — preserves total-fee invariants under unit test.

const FEE_PATTERNS = {
  // D34: eBay bills the per-order fixed component as its own line
  // (FINAL_VALUE_FEE_FIXED_PER_ORDER). It IS the final value fee and
  // belongs with it, not in otherFees.
  finalValueFee: [
    /^FINAL_VALUE_FEE$/i,
    /^FINAL_VALUE_FEE_FIXED_PER_ORDER$/i,
  ],
  paymentProcessing: [/^PAYMENT_PROCESSING_FEE/i],
  promotedListing: [
    /^FINAL_VALUE_FEE_AD_FEE$/i,
    /^AD_FEE$/i,
    /^PROMOTED_LISTING_FEE$/i,
  ],
  adFee: [
    /^AD_FEE_ADV/i,
    /^PROMOTED_DISPLAY/i,
  ],
} as const;

function matchesAny(feeType: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((p) => p.test(feeType));
}

function toNum(amount: FinancesAmount | undefined): number {
  if (!amount) return 0;
  const n = Number(amount.value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Currency sums accumulate binary-float noise ($46.84999999999991 is
 * already sitting in the prod ledger). These are money fields headed for a
 * tax export, so settle them at 2dp at the boundary.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Pure map from a Finances response array to our seven fee fields.
 * Returns nulls (NOT zeros) when no source signal exists for a field —
 * keeps the "unknown vs 0" distinction the rest of the ledger surface
 * depends on (computeLedgerFinancials respects null vs 0).
 *
 * Multi-transaction handling: aggregates fees across all SALE / SHIPPING
 * transactions for the order. netPayout = sum of SALE transaction
 * amounts (handles multi-line orders that split into multiple SALE txns
 * sharing the same orderId).
 */
export function mapFinancesToFees(
  txns: ReadonlyArray<FinancesTransaction>,
): FinancesFeeMap {
  return mapFinancesToFeesWithDiagnostics(txns).feeMap;
}

/**
 * D34: the mapper proper. Same contract as mapFinancesToFees, plus the
 * diagnostics the enrichment log needs to explain itself.
 *
 * netPayout, and why it has a `basis`: eBay's SALE `amount` is the GROSS
 * order amount and `totalFeeAmount` is what it withholds, so the seller's
 * credit is `amount - totalFeeAmount`. Older payloads (and our Phase-A
 * mocks) omit totalFeeAmount; there, `amount` is taken as already-net,
 * which is what the pre-D34 mapper always assumed. Recording which branch
 * fired keeps a silent 20%-of-gross error from ever looking like a payout
 * again — the Ohtani order withheld $603.14 on $2,999.99 and no field
 * said so.
 */
export function mapFinancesToFeesWithDiagnostics(
  txns: ReadonlyArray<FinancesTransaction>,
): { feeMap: FinancesFeeMap; diagnostics: FinancesFeeMapDiagnostics } {
  // D34 R2 — PER-BUCKET SIGHTING.
  //
  // The R1 mapper carried ONE global `sawAnyFee`: if any fee line existed,
  // all five fields were written as numbers. An order with only a
  // FINAL_VALUE_FEE therefore reported paymentProcessingFee=0 — a number
  // eBay never sent, headed for a tax export. And the inverse held too:
  // an explicit "0.00" line was thrown away by a `v === 0` early-out, so a
  // stated zero came back as null. The mapper reported zero when it did
  // not know, and unknown when it had been told zero.
  //
  // Now each bucket carries its own sighting. A bucket that no line touched
  // stays NULL (unknown). A bucket touched by a line — including a line
  // whose value is 0.00 — is a number, because eBay saying "0.00" is a
  // fact. Blank means unknown; a stated zero is never dropped.
  const totals = {
    finalValueFee: 0,
    paymentProcessingFee: 0,
    promotedListingFee: 0,
    adFee: 0,
    otherFees: 0,
  };
  const seen = {
    finalValueFee: false,
    paymentProcessingFee: false,
    promotedListingFee: false,
    adFee: false,
    otherFees: false,
  };
  type Bucket = keyof typeof totals;

  let actualShippingCost = 0;
  let saleAmountTotal = 0;
  let totalFeeAmountTotal = 0;
  let netPayoutAccum = 0;
  let refundTotal = 0;

  let saleTransactionCount = 0;
  let saleTransactionsWithTotalFee = 0;
  let sawShipping = false;
  let sawRefund = false;
  let sawLineItemFees = false;
  let sawTopLevelFees = false;
  const unknownFeeTypes = new Set<string>();

  const bucketFor = (type: string): Bucket => {
    if (matchesAny(type, FEE_PATTERNS.finalValueFee)) return "finalValueFee";
    if (matchesAny(type, FEE_PATTERNS.paymentProcessing)) return "paymentProcessingFee";
    if (matchesAny(type, FEE_PATTERNS.promotedListing)) return "promotedListingFee";
    if (matchesAny(type, FEE_PATTERNS.adFee)) return "adFee";
    return "otherFees";
  };

  const bucket = (f: FinancesFee): void => {
    const type = String(f.feeType ?? "").trim();
    const target = bucketFor(type);
    // D34 R2 SECONDARY: name the unknown type on SIGHTING, not on a
    // non-zero parse. A type we don't recognize is MOST likely malformed
    // exactly when its amount is 0.00 or unparseable — dropping the name
    // there defeats the whole "nothing is dropped, everything is named"
    // guarantee at the moment it matters most.
    if (target === "otherFees" && type) unknownFeeTypes.add(type);
    // The line exists, so the bucket is now KNOWN even if the amount is
    // zero or unparseable. toNum() yields 0 for a non-numeric amount; the
    // sighting is what turns null into a number, not the value.
    seen[target] = true;
    totals[target] += toNum(f.amount);
  };

  // D34 R2 — PER-LINE-ITEM PAYOUT ATTRIBUTION.
  //
  // R1 kept one global sawTotalFeeAmount and subtracted the summed
  // totalFeeAmount from the summed gross. On a multi-SALE order where only
  // one transaction carried totalFeeAmount, that subtracted ONE line's fees
  // from BOTH lines' gross: two $100 SALEs, fees 13.25 each but sent on
  // only one, yielded 186.75 instead of 173.50 — and reported the
  // reassuring basis "amount_minus_total_fees" while doing it.
  //
  // Attribution is now per SALE transaction: each one's own totalFeeAmount
  // is subtracted from its own amount, and a transaction that omits it
  // contributes its amount as already-net. The basis reports "mixed_per_
  // line_item" when the two branches were both used, so a compound
  // derivation can never present itself as a clean one.
  for (const t of txns) {
    const type = t.transactionType?.toUpperCase();
    if (type === "SALE") {
      saleTransactionCount += 1;
      const gross = toNum(t.amount);
      saleAmountTotal += gross;
      if (t.totalFeeAmount) {
        saleTransactionsWithTotalFee += 1;
        const fee = toNum(t.totalFeeAmount);
        totalFeeAmountTotal += fee;
        netPayoutAccum += gross - fee;
      } else {
        netPayoutAccum += gross;
      }
    } else if (type === "SHIPPING_LABEL") {
      sawShipping = true;
      // SHIPPING_LABEL amounts are negative (debit from seller). Take
      // absolute value so actualShippingCost is a positive cost.
      actualShippingCost += Math.abs(toNum(t.amount));
    } else if (type === "REFUND") {
      // D34 R2 SECONDARY: money returned to the buyer is money the seller
      // was NOT paid. Before this, a fully refunded $100 order still
      // reported the seller was paid 86.75. eBay sends REFUND amounts as
      // negatives; take the magnitude and subtract, so the sign convention
      // in the payload cannot flip the direction of the correction.
      sawRefund = true;
      const refunded = Math.abs(toNum(t.amount));
      refundTotal += refunded;
      netPayoutAccum -= refunded;
    }

    // The real breakdown: orderLineItems[].marketplaceFees[].
    for (const li of Array.isArray(t.orderLineItems) ? t.orderLineItems : []) {
      const mf = Array.isArray(li?.marketplaceFees) ? li.marketplaceFees : [];
      if (mf.length > 0) sawLineItemFees = true;
      for (const f of mf) bucket(f);
    }
    // Top-level fees[]: REFUND / NON_SALE_CHARGE (promoted-listing fees
    // billed off-payout arrive this way). A REFUND's fee CREDITS arrive
    // here as negatives and correctly net down the bucket they belong to.
    const top = Array.isArray(t.fees) ? t.fees : [];
    if (top.length > 0) sawTopLevelFees = true;
    for (const f of top) bucket(f);
  }

  const sawSale = saleTransactionCount > 0;
  const netPayout = sawSale ? round2(netPayoutAccum) : null;

  const netPayoutBasis: NetPayoutBasis = !sawSale
    ? "none"
    : saleTransactionsWithTotalFee === 0
      ? "amount_as_net"
      : saleTransactionsWithTotalFee === saleTransactionCount
        ? "amount_minus_total_fees"
        : "mixed_per_line_item";

  // D34 R2 — NO FABRICATED SHIPPING ZERO.
  //
  // R1 wrote actualShippingCost = 0 whenever a SALE posted with no
  // SHIPPING_LABEL. eBay commonly posts the label AFTER the sale, so an
  // order fetched inside that window got a written 0 — a measurement we
  // invented — and feesAxisSatisfied then closed the row permanently on it.
  //
  // The row-closing problem was real; the fix belongs in feesAxisSatisfied,
  // not here. A blank stays blank; `shippingAbsentFromEbay` carries the
  // FACT (the fetch was complete and eBay sent no label) that lets the row
  // close honestly, and leaves the field revisitable by refill.
  const feeFetchComplete = sawSale;
  return {
    feeMap: {
      finalValueFee: seen.finalValueFee ? round2(totals.finalValueFee) : null,
      paymentProcessingFee: seen.paymentProcessingFee ? round2(totals.paymentProcessingFee) : null,
      promotedListingFee: seen.promotedListingFee ? round2(totals.promotedListingFee) : null,
      adFee: seen.adFee ? round2(totals.adFee) : null,
      otherFees: seen.otherFees ? round2(totals.otherFees) : null,
      netPayout,
      actualShippingCost: sawShipping ? round2(actualShippingCost) : null,
    },
    diagnostics: {
      unknownFeeTypes: [...unknownFeeTypes].sort(),
      sawLineItemFees,
      sawTopLevelFees,
      saleAmountTotal: sawSale ? round2(saleAmountTotal) : null,
      totalFeeAmountTotal:
        saleTransactionsWithTotalFee > 0 ? round2(totalFeeAmountTotal) : null,
      netPayoutBasis,
      saleTransactionCount,
      saleTransactionsWithTotalFee,
      refundTotal: sawRefund ? round2(refundTotal) : null,
      feeFetchComplete,
      shippingAbsentFromEbay: feeFetchComplete && !sawShipping,
    },
  };
}
