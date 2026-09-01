# eBay Finances fixtures (D34)

What each file is, and — important — how much of it is measured versus
reconstructed. A fixture that quietly mixes the two is how a wrong
assumption gets pinned as a fact, which is exactly the failure D34 exists
to undo (the Phase-A mocks pinned a `fees[]` shape eBay never sends, and
the green suite hid five null fee fields for months).

## Provenance

| file | source | trust |
|---|---|---|
| `ohtani-17-15031-43259.observed.json` | Cosmos ledger read, prod, 2026-08-31 | **measured** — these are the stored numbers |
| `ohtani-17-15031-43259.reconstructed.json` | eBay's documented response shape, populated so the fee total matches the measured $603.14 | **shape measured, per-fee split INFERRED** |
| `griffey-11-15096-50302.pending.json` | the order that has never been fetched | **measured absence** — all seven null |
| `taxonomy.json` | fee types and their buckets | documented enum |

### The one thing not yet captured

The raw `/sell/finances/v1/transaction` payload has **never been logged**
for any order. The shadow-mode job emits `shadow_enrichment` but no
`raw_transactions` line existed before D34, and a 30-day App Insights
query over `traces` returns only `[...] done` heartbeats. So the
per-fee split below is a reconstruction consistent with the measured
totals, not a transcript.

Capture the real thing with a REPORT ONLY dispatch:

```
gh workflow run ebay-finances-enrichment.yml -f apply=false
# with EBAY_FINANCES_DUMP_TRANSACTIONS=true on the runner
```

then replace `.reconstructed.json` with the observed payload and drop the
`reconstructed` suffix. The tests that assert **totals** will keep
passing unchanged if the reconstruction was right; the test that asserts
the **split** is the one that will tell you it wasn't.

## The measured facts these fixtures encode

Ohtani (17-15031-43259), reconciled 2026-08-30, from the prod ledger:

```
grossProceeds      2999.99
netPayout          2396.85   <- eBay's authoritative payout
actualShippingCost    5.97
finalValueFee       null  }
paymentProcessingFee null }  all five null: the mapper read fees[],
promotedListingFee  null  }  eBay sends orderLineItems[].marketplaceFees[]
adFee               null  }
otherFees           null  }
```

`2999.99 - 2396.85 = 603.14` — 20.1% of gross — withheld by eBay and
itemized in no field. That $603.14 is the number the seven fields have to
account for, and the invariant the tests pin.

## R2 (2026-09-01): what a null in `expectedFeeMap` means

`paymentProcessingFee`, `adFee` and `otherFees` are **null** in
`ohtani-...reconstructed.json`. In R1 they were `0`, and that was the
fixture pinning a fabrication: this payload carries no line of those
types, so those numbers are *unknown*. Under managed payments eBay
generally folds processing into the final value fee and sends no separate
line — "no line" is not "zero dollars", and the difference matters in a
tax export.

Three rules the fixtures now encode, and the tests enforce:

- **Absent line → null.** Sighting is per bucket. One fee line does not
  populate the other four.
- **Stated `0.00` → 0.** eBay saying zero is a fact, and a fact is never
  dropped. If the captured payload turns out to carry explicit `0.00`
  lines for these types, those become `0` here — legitimately.
- **No fabricated shipping.** A payload with no `SHIPPING_LABEL` leaves
  `actualShippingCost` null; the *fact* that the fetch completed without
  one is carried separately (`shippingAbsentFromEbay`), and that is what
  lets the row close.

When you replace this file with the real capture, read the split
assertion's failure rather than re-greening it — and check whether the
three nulls are genuinely absent lines or explicit zeros. Either answer is
fine; guessing is not.
