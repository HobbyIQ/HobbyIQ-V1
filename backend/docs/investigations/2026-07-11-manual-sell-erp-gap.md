# Manual /sell → /erp/pnl gap — 2026-07-11 investigation

## Reported bug (Drew, 2026-07-11)

Manual "mark holding sold" via `POST /api/portfolio/holdings/{id}/sell`
returns 2xx and the holding row disappears/updates, but the sale never
appears in `GET /api/portfolio/erp/pnl` (totals stay at zero) or in
`GET /api/portfolio/erp/unreconciled` (still "All caught up"). iOS
already tried firing `POST /api/portfolio/erp/refetch` after every
successful `/sell` and it doesn't help.

## Root cause: **the backend is not broken**

Live diagnostic against Drew's own prod portfolio doc
(`user-199fcbc9-58ba-4643-a0c9-f75bcbc90bd4`) shows:

- **6 ledger entries all present in Cosmos**, all `reconciledVia:
  "manual_entry"`, all `needsReconciliation` absent:
  ```
  2026-07-11  Mike Trout       gross $315  realized +$215
  2026-07-11  Eric Hartman     gross $619  realized +$259
  2026-07-11  Clayton Kershaw  gross $794  realized +$669
  2026-07-11  Shohei Ohtani    gross $260  realized +$110
  2026-07-11  Chipper Jones    gross $713  realized +$613
  2026-07-22  Buster Posey     gross $442  realized +$342
  ```

- **Local `aggregatePnl` simulation on Drew's exact Cosmos data returns:**
  ```
  totals.grossProceeds:      $3,143
  totals.feesTotal:          $85
  totals.netProceeds:        $3,058
  totals.costBasisSold:      $850
  totals.realizedProfitLoss: $2,208
  totals.entryCount:         6
  ```

- **`listUnreconciled` correctly returns empty** — manual entries are
  self-reconciled by design.

Same aggregation code is deployed on prod (`GIT_SHA=eaaa11f`, deployed
2026-07-11T18:49:19Z — after all 6 of Drew's sales landed).

The write path works. The read path works. The math is correct. The bug
is **on the iOS client**.

## Design confirmation (Drew's Q4)

**Manual sales are self-reconciled and land directly in `/pnl` totals.**
This is the shipping design, documented at
`portfolioStore.service.ts:462`:

> ```
> // Manual entries OMIT all of these. Readers MUST treat absent
> // `source` as "manual" and absent `needsReconciliation` as false.
> ```

Rationale: the user IS the authoritative source for their own manual
sale. The `/sell` body already carries `salePrice`, `fees`, `soldAt`,
`salesChannel`, `paymentMethod` — every piece of data reconciliation
would otherwise ask for. Requiring a second "Reconcile" step for
manual entries would be busy-work.

## What this PR ships

Not a bug fix — the backend was correct. **Hardening + regression proof**
so future iOS-side confusion can't recur silently:

1. **`/sell` handler now emits `source: "manual"` explicitly** on the
   ledger entry (was relying on absent-means-manual reader defaults).
   Behavior-preserving: readers already defaulted to "manual" for
   absent source. But the explicit field:
   - Makes Cosmos queries filter/group cleanly without OR-null clauses
   - Makes App Insights ledger telemetry human-readable
   - Gives iOS a positive marker to assert on instead of an absence
     (impossible to distinguish from "field dropped by schema decode")

2. **End-to-end regression test** at
   `tests/portfolio.routes.test.ts` — new case locks the full loop:
   `POST /holdings` → `POST /holdings/:id/sell` → `GET /erp/pnl`
   returns non-zero totals matching the sale; `GET /erp/unreconciled`
   stays empty; grouping by source shows the sale under the "manual"
   bucket. If the loop ever regresses, CI fails loudly.

3. **This investigation doc** — durable record so anyone repeating
   this diagnostic in the future finds the reproduction proof.

## iOS-side debugging next steps

Suggested checks Drew can run against his own device/session:

1. **Sanity-check the URL** — capture a network trace or dev console
   log and confirm iOS is hitting exactly
   `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/portfolio/erp/pnl`.
   `/api/portfolioiq/erp/pnl` (note the `iq`) returns 404. If iOS is
   posting to the wrong URL, the response body will be
   `{"error":"Route GET /api/portfolioiq/erp/pnl not found"}` —
   which iOS may be silently treating as "no data".

2. **Curl `/erp/pnl` with Drew's real session cookie/token** — if the
   raw response includes `totals.realizedProfitLoss: 2208`, the backend
   is definitively fine and the bug is in the iOS decoder or view
   state (client-side cache, `@State` not refreshed after `/sell`,
   `ObservableObject` not published, etc.).

3. **Check the decoder** — Drew's iOS `ERPPnLResponse` struct should
   have `totals: ERPPnLTotals` where every numeric field is decodable
   as `Double`. A common bug: decoding as `Int` when server sends
   `2208.5` → decoder fails silently and defaults to zeros.

4. **Check screen state refresh** — many iOS ERP screens cache /pnl
   response in a `@Published` variable. If the `/sell` completion
   handler doesn't invalidate + re-fetch, the view keeps showing the
   pre-sale zero-totals.

## Not touched

- eBay reconciliation flow — verified unaffected. Manual and eBay
  entries use disjoint fields (`source`, `needsReconciliation`,
  `feeSource`).
- `/erp/refetch` semantics — currently touches only unreconciled
  entries by design (line 526 filters via `isReconciled`). Drew's
  post-sell `/refetch` call is a no-op because manual sales are
  self-reconciled — which is correct. If iOS wants a "poke the server
  after a manual sale" hook for other reasons (e.g. bust some future
  server-side cache), we can add one later.
