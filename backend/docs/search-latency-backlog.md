# Search latency backlog — 2026-08-20

Everything here is measured. Where a number came from a probe rather than the
production query shape, that is called out, because that distinction is exactly
what sank the previous attempt at this work.

Deployed and verified at time of writing: `9539c2e` (2026-08-20T23:48:41Z).

---

## The finding

`/api/compiq/search` returns HTTP 200 in anywhere from 0.1s to 57.9s. Stage
timing (#1161, `compiq_search_stage_timing`) attributes it:

| cache | n | avg engine (`cacheMs`) | avg catalog (`catalogMs`) | avg other |
|---|---|---|---|---|
| hit | 23 | **6ms** | **31,214ms** | 1ms |
| miss | 7 | **969ms** | **133,157ms** | 234ms |

Slowest single request: 378s total, **376.5s of it in `searchCatalog`**, 0.9s in
the engine.

**The pricing engine is not the problem.** `computeEstimate` costs under a second
even on a cache miss. The cost is `searchCatalog`, which runs outside the cache on
every request — including cache hits, which is why hits still averaged 31s.

> Caveat on the absolute numbers: these were captured while
> `measure-enrichment-value.cjs` was scanning `card_catalog` and getting
> throttled — the same container. Before that contention the observed max was
> 57.9s. The *ratio* (catalog ≈ 99% of wall time) is unaffected. Re-baseline on a
> quiet account.

### Four hypotheses that were wrong

Recorded so nobody re-derives them:

| hypothesis | killed by |
|---|---|
| staging contention | slowest searches fall in a window with **zero** staging activity; three *concurrent* searches finished in 11–13s each |
| Cosmos I/O | no dependency exceeds 0.6s; deps are 3–39% of wall time, and the 57.9s request spent 3.2s (6%) on I/O |
| CardHedge | instrumented and correlated (957 deps/6h, 100% with `operation_Id`); slow searches make no CH calls at all |
| the CH delta poll | searches at 21:45:54, 21:47:36, 21:48:12 were already slow *before* the 21:49:37 poll |

---

## Why this is a regression, not a new problem

`CF-SEARCH-ANCHOR-INDEXED-FAST-PATH` (2026-08-15) already diagnosed this:
`CONTAINS` on a scalar cannot use an index, so every search scans
`card_catalog` — 35.7M rows.

A token-prefix fix was attempted on 2026-08-15 and **reverted**: several queries
timed out at 20s returning zero. The cause is known — the probe selected only
`c.id` while the production query projects ~18 fields *including the full
`searchTokens` array*. **The probe measured a query the app never runs.**

The revert left **no regression guard**. #1161's stage timing is now that guard.

---

## Work items

### 1. Narrow the fallback projections — PARTIAL FIX, ready

The anchor arms were already narrowed (`anchorSelectFields`, 11 fields, no
`searchTokens`). The **fallback** queries were not:

- `catalogSearch.service.ts:424` — `SELECT TOP 500 … c.searchTokens …`
- `catalogSearch.service.ts:432` — `SELECT TOP 100 … c.searchTokens …`

These run when the anchor arms return nothing, which is the obscure-prospect case
the Tier 1 harness exercises. Measured effect of projection width on the same
query shape: **453ms selecting `c.id` alone vs ~15s selecting seventeen fields.**

Gate: `backend/scripts/probe-catalog-projection.cjs` runs both projections
**interleaved** so background load inflates both arms equally. Ship only if the
ratio holds **and** row counts are identical across arms.

Consumption check, done: `r.searchTokens` is read at line 617 but guarded
`?? []`, and anchor-sourced rows already arrive without it. `r.imageUrl` is read
back at line 686 — **leave `imageUrl` in place**, dropping it is a visible
response change.

### 2. Replace the `searchOr` disjunction — THE REAL FIX

40 branches, 8 field predicates per token, 6 of them `CONTAINS`. Measured:
"2018 topps chrome update ohtani" **15.5s**, versus **~1.9s** for the anchor
alone.

Item 1 narrows what each row costs to materialise. This is what stops the scan
happening at all. It carries genuine correctness risk and must be gated on the
documented fuzzy set:

| case | current |
|---|---|
| `justin gonzalez` | **FAILS** — returns Josuar/Jacob/Gabriel Gonzalez, 14.9s ("gonzalez" is a real token owned by other players) |
| `erik hartman` | passes |
| `owen cary` | passes |
| `justin gonzales` | passes |

The primitive is already measured:
`EXISTS(SELECT VALUE t FROM t IN c.searchTokens WHERE STARTSWITH(t, @prefix))`
— "gonzal" 1,555ms, "ohtan" 528ms, "care" 453ms. It is simultaneously the fast
arm and the fuzzy arm, so no exact-match arm can short-circuit a misspelling.

Note the range is wider than it looks: exact "carey" 1.5s vs prefix "care" 16.6s,
because "care" also pulls Careaga, Carela and every other token starting that way.

### 2b. ROOT CAUSE: the searchTokens backfill cannot reach most rows

The seven `CONTAINS` branches in item 2 exist for a documented reason:

> tree-built card nodes (~182K docs) do not have searchTokens populated — only
> legacy vendor rows do

So the fix is not only SQL. If `searchTokens` were populated everywhere, the
seven unindexed branches could be dropped and the query would be fully indexed.

There IS a `Nightly searchTokens backfill` workflow. It has run **green every
night** (verified: successive successes through 2026-08-20). Its query:

```sql
WHERE c.source = cardsight AND c.sport = @sp
      AND (NOT IS_DEFINED(c.searchTokens) OR c.searchTokens = null)
```

Two hard filters that the workflow name does not suggest:

1. **`c.source = cardsight` only.** Cardsight was RETIRED from matching on
   2026-08-16 (`project_cardsight_status_deprecated_but_active_backup`). The
   nightly job backfills a dead source and touches nothing else — not
   tree-built nodes, not checklist-scraped rows, not CH-derived rows.
2. **`c.sport = @sp`, default baseball**, and the workflow invokes it as
   `--sport baseball`. Football, basketball, hockey and Pokemon get nothing.

It is green because it does exactly what it was scoped to do. It is not the job
its name implies. See `feedback_green_workflow_is_not_data_flow` — verify the
write, not the run.

**Sizing query (run on a quiet account — this is a scan):**

```sql
SELECT c.source, COUNT(1) AS n FROM c
WHERE STARTSWITH(c.id, hiq:)
  AND (NOT IS_DEFINED(c.searchTokens) OR ARRAY_LENGTH(c.searchTokens) = 0)
GROUP BY c.source
```

**Order of work, once sized:**

1. Widen the backfill to every source and every sport (drop both filters, or
   parameterise and fan out). Re-tokenising is idempotent.
2. Only THEN drop the `CONTAINS` branches. Dropping them while rows still lack
   tokens would make those cards unfindable — strictly worse than slow.

Do not reverse that order.

### 3. Product decisions — not engineering calls

- **`catalogOptions` freshness vs speed.** Uncached *by design* so a
  newly-ingested checklist row appears immediately rather than after the TTL.
  Measured cost of that guarantee: **31s on a cache hit.** Cache briefly
  (30–60s), or keep instant freshness?
- **`CF-SEARCH-CACHE-SKIP-SYNTHETIC`.** Low-confidence answers are deliberately
  never cached, so hard queries recompute in full on every request. Sound in
  principle; it is also why the Tier 1 cases never hit cache.

### 4. Tier 1

- `#1154` raises `CASE_BUDGET_MS` 30s → 60s and took the harness from 4 failed
  files to 1. It does **not** make Tier 1 green — prod search legitimately
  reaches 57.9s against a 59s abort. Merge as partial progress or hold until
  items 1–2 land.
- **`price-by-id` coverage is dead.** `hitPriceById` sends `cardHedgeCardId`;
  the route accepts `cardId` (or legacy `cardsightCardId`). Every call returns
  400 in 0–2ms, `beforeAll` swallows it into `ctx.notes`, and the assertion does
  `if (!ctx.priceById) return;` — passing without ever seeing a response. A
  one-line rename wakes ~11 dormant assertions against live prod; do it when
  someone can triage the results.

---

## Verification queries

Stage split, once traffic has accumulated:

```kql
traces
| where timestamp > ago(2h)
| where message has 'compiq_search_stage_timing'
| extend d = parse_json(message)
| summarize n=count(),
            p50=round(percentile(toint(d.totalMs),50)),
            avg_cache=round(avg(toint(d.cacheMs))),
            avg_catalog=round(avg(toint(d.catalogMs))),
            avg_other=round(avg(toint(d.otherMs)))
  by hit=tostring(d.cacheHit)
```

Projection A/B:

```
COSMOS_CONNECTION_STRING="…" node backend/scripts/probe-catalog-projection.cjs --top=500 --reps=2
```

---

## Method notes

Three assumptions cost real time on 2026-08-20. Recorded so they are not repeated:

1. **A probe is not the query.** The 2026-08-15 revert happened because
   `SELECT c.id` was measured while production projects 18 fields.
2. **Absolute timings are worthless under contention; ratios survive it.** Run
   A/B arms interleaved rather than trusting a single before/after.
3. **Measure before believing.** Four separate latency hypotheses were formed
   from plausible reasoning and all four died against telemetry. See
   `feedback_never_dismiss_small_numbers_as_noise`.
