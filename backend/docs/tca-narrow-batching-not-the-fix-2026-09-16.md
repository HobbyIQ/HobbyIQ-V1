# Batching the TCA catalog narrow: built, measured, reverted

Follow-up to `cosmos-60s-callsites-2026-09-16.md`. The batching change was
implemented as briefed, then **reverted before PR** because measurement showed
it would not move the number. Recording it so the next person does not build it
again.

## What was built

A batch scope (`withNarrowBatch`) around the webhook's per-row loop that
memoised `checklistNarrow`'s two `card_catalog` queries per distinct
`(playerName, year)` — lazily, because a TCA row carries a `title` and the
identity is derived per row deep inside `persistVendorSalesToPool` by title
parsing and sometimes an LLM call, so the keys cannot be known at the route.

It worked. Tests showed two sales for one player issuing one query instead of
two, and twelve concurrent sales collapsing to one.

## Why it was reverted

**`checklistNarrow` already has a process-wide cache.**
`persistVendorSalesToPool.service.ts:59`:

```ts
const CATALOG_CACHE = new Map<string, Array<...>>();
const CATALOG_CACHE_MAX = 5000;
```

keyed on `(player, year, setKey, sport)` at `:200-202`, written at `:433` —
**including empty results**, and `if (hit) return hit` is truthy for `[]`, so
cached misses short-circuit too.

Two of the new tests failed for exactly that reason: the pre-existing cache had
already de-duplicated the second call, so the batch scope's counters read zero.
A test that failed because the work was *already not being done* is the clearest
possible signal that the change is redundant.

Within one webhook batch, a repeated `(player, year)` is served from
`CATALOG_CACHE` on the second and subsequent sales regardless. Batching adds a
second layer of the same de-duplication.

## What the numbers actually say

Measured over 7 days, `POST /api/tca/webhook` against `card_catalog`:

| | |
|---|---:|
| total calls (un-sampled) | **16,975,370** |
| failing at ≈60 s | 1,399,640 (**8.2%**) |
| p50 | 805 ms |
| p95 | 60,079 ms |
| webhook calls in the period | **890** |
| **catalog queries per webhook call** | **≈19,073** |

**19,073 queries per webhook call is the finding.** A 1,000-row batch running
one narrow per sale would be ~1,000–2,000. Nineteen thousand is an order of
magnitude beyond that, and it is *already* net of `CATALOG_CACHE`.

So the per-sale narrow is not the multiplier. Something on this path issues
roughly 19 catalog queries per sale, or the batches are far larger than 1,000
rows, or a retry loop is re-running rows. **That is unidentified**, and
batching the narrow would not have touched it — which is why no PR was raised.

## What to investigate next

1. **Find the 19×.** Instrument or trace one webhook call end to end and count
   `card_catalog` queries per sale. Candidates: the TCA catalog fallback at
   `:427-445`, `ensureCatalogRow`, the staging shim, or a retry wrapper.
2. **Check batch sizes.** 890 webhook calls in 7 days is ~5/hour, which is far
   below TCA's documented cadence — so either batches are very large, or most
   deliveries are not reaching the request table (sampling) and the per-call
   figure is inflated by a denominator that is too small. **Resolve this before
   trusting the 19,073.**
3. **Only then** decide whether any query-count fix is worth making.

## What was kept

Nothing. `tcaWebhook.routes.ts` and `persistVendorSalesToPool.service.ts` are
untouched on this branch.

---

## Denominator resolved, and the 19,073 explained (2026-09-16)

**The denominator is sound.** `POST /api/tca/webhook` over 7 days: 89 sampled
rows × itemCount 10 = **890 un-sampled requests**, ~5.3/hour. Sampling is
already accounted for, so the ratio is not a sampling artifact.

**But the average was the wrong statistic.** The load is extremely bursty:

```
2026-09-09      30,440        2026-09-13   3,671,790
2026-09-10   2,146,660        2026-09-14   8,182,650
2026-09-11     373,050        2026-09-15   2,555,370
2026-09-12      15,410
```

and per individual request it is worse — the top eight requests account for
~10M of the ~17M calls. The single worst:

| one webhook request | |
|---|---:|
| `card_catalog` calls | **3,820,650** |
| wall-clock window | 19:05:59 → 01:15:03 (**370 min**) |
| p50 duration | **35,019 ms** |
| failed | **3,521,410** (92%) |
| rate | ~10,326 calls/minute |

**One HTTP request ran for six hours and issued 3.8M catalog calls, 92% of them
failing.** That is not a per-sale narrow on a 1,000-row batch under any
arithmetic. It is a runaway: a retry or reprocessing loop inside
`processBatchAsync`, which is detached from the response (the route acks in
<100 ms by design, per CF-TCA-WEBHOOK-ACK-FIRST) and therefore has nothing
bounding its lifetime.

The p50 of 35 s and the 92% failure rate are consistent with the loop retrying
against a container it is itself saturating — each retry making the next one
likelier to fail.

### What this means for the 60 s timeouts

The 1.4M 60 s failures attributed to this webhook are **overwhelmingly one
pathological request at a time**, not a broad per-sale cost. Fixing the narrow —
by batching or otherwise — would not have touched it. The loop is the defect.

### Next step

Find what re-enters inside `processBatchAsync`. Candidates, in order of
suspicion:
1. a retry wrapper around the per-row persist with no attempt ceiling;
2. the TCA catalog fallback (`persistVendorSalesToPool.service.ts:427-445`)
   re-driving rows;
3. a queue/cursor that re-reads the same batch after a partial failure.

This wants a code read rather than more KQL: the telemetry has said what it can.
