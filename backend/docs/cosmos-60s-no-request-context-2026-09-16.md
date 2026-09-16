# The second 60 s class: failures with no request context

Read-only attribution of the ~289,365 dependency failures per 7 days that carry
no `operation_Name`. Companion to `cosmos-60s-callsites-2026-09-16.md` (the TCA
webhook class) and `tca-narrow-batching-not-the-fix-2026-09-16.md`.

**Status** diagnosed, not fixed. Bounds proposed below, none built.

## What "no request context" means

These rows have an empty `operation_Name` because **no HTTP request was in
scope when the call was made**. That is the signature of an in-process
scheduler: a `setInterval` cycle is not a request, so App Insights has no
operation to attribute the dependency to. It is a useful filter — this class is
*by construction* the background jobs.

## Attribution (7 d, un-sampled = rows × itemCount)

| role | container | verb | est. |
|---|---|---|---:|
| **`hobbyiq3-worker`** | **card_catalog** | `POST …/docs` (query) | **210,780** |
| `HobbyIQ3` | card_catalog | `POST …/docs` | 38,010 |
| `HobbyIQ3` | daily_price_series | `POST …/docs` | 13,230 |
| `hobbyiq3-worker` | comps_staging | `POST …/docs` | 12,870 |
| `hobbyiq3-worker` | sold_comps | `POST …/docs` | 6,280 |
| `HobbyIQ3` | sold_comps | `POST …/docs` | 3,110 |
| `hobbyiq3-worker` | daily_price_series | `POST …/docs` | 2,110 |
| everything else | | | < 1,500 |

**The worker against `card_catalog` is 73%.** Every significant row is query
execution (`POST …/docs`), not a point read.

### Hour of day — continuous, not a cron

Worker `card_catalog`, by UTC hour: a 2,650–5,860 floor in *every* hour, with
spikes at 11:00 (52,950), 12:00 (24,780), 01:00 (20,490), 06:00 (13,750),
21:00 (13,500).

**No hour is zero.** A nightly job would leave most hours empty. A floor in all
24 hours is an always-on loop, and the spikes are load, not schedule.

## The issuing path

`hobbyiq3-worker` has `STAGING_DRAINER_ENABLED=true` and
`STAGING_DRAINER_WORKERS=16` (read from App Service settings). That is the only
always-on in-process loop, and it matches the 24-hour floor exactly.

The chain to `card_catalog`:

```
stagingDrainer.service.ts:109   startStagingDrainer()   — 16 concurrent loops
  -> promotionJob.service.ts (runPromotionBatch)
     -> soldCompsStore.service.ts  recordSoldComp()
        -> :1675  items.query  (dedup by id)
        -> :1795  items.query  CROSS-PARTITION dedup
                  SELECT * FROM c WHERE c.hobbyiqCardId = @slug
                    AND c.source = @src AND c.contributorUserId = @u
                    AND c.price = @p ...
        -> :1992  items.query  (same-id sweep)
        -> :2170  ensureCatalogRow()  -> card_catalog
  -> dataCleanJob.service.ts (runDataCleanBatch)
     -> :223 :281 :299  comps_staging queries
     -> :338            sold_comps query
```

`ensureCatalogRow.service.ts:80` is a **point read** (`container.item(slug,
slug).read()`) and is not the problem. The cost is the **cross-partition dedup
queries in `soldCompsStore`**, multiplied by 16 concurrent drainer loops.

### Which carry no bound

Measured by grep, `soldCompsStore.service.ts`:

| | count |
|---|---:|
| `items.query` call sites | **10** |
| carrying `abortSignal` | **0** |
| carrying `maxItemCount` | 1 |

So **every one of the ten rides the SDK's 60 s default `requestTimeout` plus
its internal retries**, at 16-way concurrency, continuously. Same shape as the
TCA webhook class, different caller.

Also unbounded, and matching the smaller rows above:

- `persistDailyPriceSeries.service.ts` — 1 query, 0 abortSignal (the 13,230
  `daily_price_series` failures on `HobbyIQ3`)
- `marketIndex.service.ts` — 1 query, 0 abortSignal

## Relation to the 12 `HIQ_SLOT_ROLE`-gated jobs

The gate added in #2199 disables all twelve on a **staging slot**. It does
nothing here: these run on **production** and on the **worker**, where the gate
is correctly inactive. The slot gate was never intended to bound them — it
prevents double-running during a swap, which is a different problem.

Worth noting for the slot work: the worker is a **separate deployment**
("Deploy Worker" only, per the runbook), so a HobbyIQ3 slot swap does not
recycle it and its drainer keeps running throughout.

## Relation to the nightly reprice

Not implicated. The reprice runs as a **workflow job** (`reprice-holdings`,
`needs: deploy-and-refresh`), not in-process, so its Cosmos calls would carry
its own operation context or none from a different role. The 24-hour floor also
rules out a once-daily job.

## Proposed bounds — described, not built

Same doctrine as #2221, and for the same reason: these are **background**
callers, so the failure mode of a bound is a delayed row, never a wrong one.

1. **`soldCompsStore.service.ts`, the three dedup queries (:1675, :1795,
   :1992)** — an explicit `abortSignal` per query. 10–15 s is defensible: these
   are dedup lookups whose miss is already handled (the row is written as new).
   Waiting 60 s on a container the drainer is itself saturating buys nothing.
   The cross-partition one at :1795 additionally wants `maxItemCount`, since it
   is `SELECT *` with no TOP.

2. **A drainer-scoped circuit breaker**, mirroring `withNarrowBreaker`: after N
   consecutive 60 s failures, pause the cycle rather than continuing to issue.
   16 loops each retrying into a throttled container is the amplifier; one loop
   discovering the container is unavailable should stop the other fifteen.

3. **`persistDailyPriceSeries` and `marketIndex`** — one `abortSignal` each.
   Low volume, trivial change, and it removes the remaining unbounded
   background writers.

4. **Not a global default.** #2164 already established the pattern (gated to
   the web process, opt-in) precisely so batch lanes keep SDK defaults. The
   right bound here is per-site, because the correct timeout for a dedup lookup
   is not the correct timeout for a backfill scan.

## Caveat

`STAGING_DRAINER_WORKERS=16` is a live config value. Reducing it would also
reduce this load and is arguably the cheapest mitigation — but it is a
production config change and therefore Drew's call, not a code fix. Noted, not
recommended, because the unbounded queries are the defect regardless of how
many loops issue them.
