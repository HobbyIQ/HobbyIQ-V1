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

export interface FinancesTransaction {
  transactionId: string;
  orderId: string | null;
  amount: FinancesAmount;
  totalFeeBasisAmount?: FinancesAmount;
  fees: FinancesFee[];
  payoutId?: string;
  transactionType: string; // "SALE" | "REFUND" | "SHIPPING_LABEL" | "TRANSFER" | "ADJUSTMENT" | ...
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
  finalValueFee: [/^FINAL_VALUE_FEE$/i],
  paymentProcessing: [/^PAYMENT_PROCESSING_FEE/i],
  promotedListing: [
    /^FINAL_VALUE_FEE_AD_FEE$/i,
    /^AD_FEE$/i,
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
  let finalValueFee = 0;
  let paymentProcessingFee = 0;
  let promotedListingFee = 0;
  let adFee = 0;
  let otherFees = 0;
  let netPayout = 0;
  let actualShippingCost = 0;

  let sawSale = false;
  let sawShipping = false;
  let sawAnyFee = false;

  for (const t of txns) {
    if (t.transactionType?.toUpperCase() === "SALE") {
      sawSale = true;
      netPayout += toNum(t.amount);
    } else if (t.transactionType?.toUpperCase() === "SHIPPING_LABEL") {
      sawShipping = true;
      // SHIPPING_LABEL amounts are negative (debit from seller). Take
      // absolute value so actualShippingCost is a positive cost.
      actualShippingCost += Math.abs(toNum(t.amount));
    }
    const fees = Array.isArray(t.fees) ? t.fees : [];
    for (const f of fees) {
      const v = toNum(f.amount);
      if (v === 0) continue;
      sawAnyFee = true;
      const type = String(f.feeType ?? "").trim();
      if (matchesAny(type, FEE_PATTERNS.finalValueFee)) finalValueFee += v;
      else if (matchesAny(type, FEE_PATTERNS.paymentProcessing)) paymentProcessingFee += v;
      else if (matchesAny(type, FEE_PATTERNS.promotedListing)) promotedListingFee += v;
      else if (matchesAny(type, FEE_PATTERNS.adFee)) adFee += v;
      else otherFees += v;
    }
  }

  // Null-vs-0: if no SALE transaction was found, we don't know netPayout —
  // leave it null so the enrichment helper falls back to derivation
  // instead of writing a misleading 0. Same for the others.
  return {
    finalValueFee: sawAnyFee ? finalValueFee : null,
    paymentProcessingFee: sawAnyFee ? paymentProcessingFee : null,
    promotedListingFee: sawAnyFee ? promotedListingFee : null,
    adFee: sawAnyFee ? adFee : null,
    otherFees: sawAnyFee ? otherFees : null,
    netPayout: sawSale ? netPayout : null,
    actualShippingCost: sawShipping ? actualShippingCost : null,
  };
}
