# D34 — the seven fee lines from eBay's Finances transactions

Ruled by Drew 2026-08-30 12:56Z ("Yes — small builder after the current
round"). Small; after the search+comps repair, D29, D30 fleet, D32 unless
Drew moves it.

## Why

The fee enrichment now runs on the runner (#1553) and reconciled Drew's
2018 Bowman Chrome Ohtani #1 sale (order 17-15031-43259) at **net payout
$2,396.85**, realized P&L $46.85 — `needsReconciliation: false`. But the
seven breakdown fields the queue asks for — `finalValueFee`,
`paymentProcessingFee`, `promotedListingFee`, `adFee`, `otherFees`,
`netPayout`, `actualShipping` — came back **null except netPayout**, though
eBay returned two Finances transactions for the order. P&L is right; the tax
export's fee columns are empty.

## Deliverables

1. **Fixtures from real orders**: capture (read-only, on the runner or from
   telemetry — never a user token from a laptop) the raw
   `/sell/finances/v1/transaction` payloads for Drew's reconciled order and
   two others (one with a promoted-listing fee, one with a shipping label),
   redact ids, save under `backend/tests/fixtures/ebay-finances/`.
2. **`mapFinancesToFees`** (`src/services/ebay/ebayFinances.service.ts`):
   map eBay's per-fee lines — `transactionType` SALE with `orderLineItems[].marketplaceFees[]`
   (`feeType`: `FINAL_VALUE_FEE`, `FINAL_VALUE_FEE_FIXED_PER_ORDER`,
   `PAYMENT_PROCESSING_FEE`? (eBay folds it into final value fee since
   managed payments — record 0 with a `feesSource` note, do not invent),
   `AD_FEE` / `PROMOTED_LISTING_FEE` (NON_SALE_CHARGE transactions),
   `SHIPPING_LABEL` (transactionType SHIPPING_LABEL → `actualShipping`),
   `otherFees` = the rest) — into the seven fields; `netPayout` from the
   SALE transaction's `amount` after fees, cross-checked against the payout.
   Pin every fixture; pin that an unknown feeType lands in `otherFees` and is
   logged, never dropped.
3. **Re-run for already-reconciled sales**: a mode on
   `run-ebay-finances-enrichment.cjs` (`MODE=refill-fee-lines`) that
   re-fetches transactions for ledger entries with `netPayout` set and any
   fee field null, fills the seven fields, leaves `netProceeds` /
   `realizedProfitLoss` unchanged when the recomputed value agrees (log the
   disagreement when it does not). REPORT ONLY first; reconciled.
4. **The queue's copy**: "Waiting on 7 fee fields from eBay" — when eBay has
   posted the payout but a breakdown line is legitimately absent (no
   promotion, no label), the card should not say "waiting"; the reconciled
   state is netPayout present. Adjust `missingFields` accordingly and pin.
5. **Tax export**: the fee columns read the seven fields; one fixture-driven
   test over the export.

## Guardrails

No eBay calls from a laptop with a user token; the runner only; REPORT ONLY
first; gate on exit codes; deploy after the backend/src merge and check
`/api/health`; nothing to stdout that is a secret.
