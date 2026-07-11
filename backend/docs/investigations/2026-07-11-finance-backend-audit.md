# Finance backend audit — 2026-07-11

## Scope

"Is the end-to-end buy-to-sell + finances story legit and ready?" Answer:
substantial code shipped, real jobs running, but the *last mile* — actual
user activity flowing through the finance surfaces — hasn't happened yet.

## Legit + working on prod today

### 1. Backend surfaces (21 ERP routes, all responding)

`/api/portfolio/erp/*` (mounted at `app.ts:76`):

- `/pnl` — realized P&L: gross proceeds, fees, shipping, net proceeds,
  cost basis sold, realized profit/loss, grouped by month
- `/analytics` — grouped analytics by player/set/grade/source/salesChannel/
  paymentMethod: entryCount, totalGross, totalCost, totalRealized,
  marginPct, roiPct, avgDaysToSale, sellThroughPct
- `/analytics/timeseries` — same shape over time
- `/valuation` — unrealized: cost basis, snapshot value, unrealized
  gain/loss, unrealized%, plus fullPosition (realized YTD + unrealized + total)
- `/trades` — GET/POST/GET-by-id trade CRUD
- `/expenses` — GET/POST/DELETE expense CRUD
- `/expenses/report` — expense summary
- `/tax/filings/:year` — GET/PUT 1099-K reconciliation across eBay/PayPal/Venmo
- `/tax-export` — export tax data
- `/accounting-export` — general accounting export
- `/unreconciled` — sold entries without matching purchase (ledger gaps)
- `/unreconciled/:id/refetch|override|save-costs` — reconciliation tooling
- `/unreconciled/aging` — aging report on unreconciled entries
- `/refetch` — full refetch trigger

Total: 873 lines of route code + 3,427 lines of finance services (`erp*.ts`
+ `taxFilings.repository.ts` + `ebayFinances.service.ts`).

### 2. Background jobs (running every server boot)

`server.ts` starts on boot:

- `startPortfolioRepriceJob` — every 6h, walks all users, reprices
  holdings, snapshots portfolio value → `portfolio_value_history` container
- `startEbayOrderPollJob` — polls eBay for new orders per user with OAuth
- `startEbayFinancesEnrichmentJob` — enriches ledger entries with fee/net
  data from eBay Finances API
- `startPriceAlertEvaluatorJob` — evaluates price alerts against fresh
  reprices
- `startSubscriptionsSafetyNetJob` — Apple subscription state safety net

### 3. Storage — 2 containers with real data

- `portfolio_value_history`: **100 snapshots**, most recent 7 min ago.
  Reprice job is running end-to-end. Drew's user has recent snapshots.
- `subscription_events`: 8 events, most recent 2026-07-10. Apple S2S
  webhooks are landing and being processed.

## Ready but never exercised (the gap)

Across all 4 real users on prod:

| Surface | Count |
|---|---|
| `holdings.ledger` (sold cards) | 0 |
| `holdings.trades` (buy/sell records) | 0 |
| `holdings.priceHistoryByHolding` | 0 |
| `holdings.alerts` | 0 |
| `portfolio_expenses` container | 0 |
| `tax_filings` container | 0 |

**Root cause pattern:** the ledger is populated by the eBay finance
enrichment job — which requires the user to have completed eBay OAuth
first. If no user has connected eBay, no orders come in, no ledger
entries appear, `/pnl` stays at zero, `/tax/filings` stays empty. The
trades surface (POST /erp/trades) requires client UI that isn't
shipping yet (untracked `SellCardSheet.swift` / `SalesTrackerView.swift`).

## Honest verdict

Finance backend is genuinely substantial and correctly wired. It is NOT
vaporware — the code is real, the jobs run, the routes respond, the
snapshot job persists actual state every 6h. But the "end-to-end
buy-to-sell + finances" story requires the *ingest* side (real trades
+ eBay orders) to actually flow, and that has never happened for any
real user.

## What would move the needle

Ranked by leverage per hour:

1. **Wire iOS to POST /erp/trades on the existing SellCardSheet flow.**
   Instantly unblocks realized P&L, analytics, tax export for anyone
   who manually records a sale. Zero new backend needed.

2. **Verify eBay OAuth actually works for a real user.** The
   `startEbayOrderPollJob` and `startEbayFinancesEnrichmentJob` do
   nothing without a connected eBay account. If OAuth is broken,
   the whole eBay-driven ledger pipeline is broken.

3. **Add a "portfolio-summary" endpoint** for the iOS dashboard —
   combines valuation + realized YTD + unrealized + top-gainers +
   top-losers in one call. iOS home screen would call this on launch.

4. **Fix priceHistoryByHolding population** — the reprice job writes
   `portfolio_value_history` (aggregate) but does NOT populate the
   per-holding `priceHistoryByHolding` map in the user doc. Result:
   users can see total portfolio trend but not "how did THIS card
   perform over 30 days." Real code gap.

5. **Seed a test trade for the harness user** to prove /pnl math
   produces correct numbers. Read/write on prod, so needs greenlight.
   Highest confidence-building move for a single non-launch demo.

## Not audited (out of scope for a server-only pass)

- Whether iOS actually has SellCardSheet UI wired (untracked file
  suggests WIP, not shipped)
- Whether eBay OAuth PKCE flow works on any real user account
- Whether the tax-export produces the correct IRS form format
- End-to-end trade round-trip: iOS → POST /erp/trades → PGL update
  → /pnl reflects the sale

## Related

- Route mount: `backend/src/app.ts:76`
- Service files: `backend/src/services/portfolioiq/erp*.ts`
- Repositories: `backend/src/repositories/taxFilings.repository.ts`
- Jobs: `backend/src/jobs/ebayFinancesEnrichment.job.ts`,
  `portfolioReprice.job.ts`
