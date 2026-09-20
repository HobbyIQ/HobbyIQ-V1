# 2026-09-20 CENSUS BATCH — I9 re-baseline + catalog backing count

CF-VERIFY-EACH-SLOT-BY-ITS-BANNER-NEVER-BY-RUN-CONCLUSION (see
`wave2-fleet-and-i9-rebaseline.md` for the general shape this batch reuses).

Owner's go, 2026-09-19: run ONE 32-slot census of `sold_comps` that (1)
re-baselines the I9 derivation stamp for a batch of held stamp-moving PRs, and
(2) at the same time produces the full-population catalog **backing** count
for sports and Pokémon sales, using the `SOURCES=backing` flag added by
`backend/scripts/rematch-sold-comps.cjs` + `backend/scripts/merge-census-backing.cjs`
in this PR. This is CATALOG BACKING ONLY — does a sale's `card_catalog` row
exist and is it strict-checklist-sourced. It is **not** the title-contradiction
"strict clean" check I9's sample audit runs; that stays a sample measure and is
untouched by this batch.

---

## 0. Preconditions — read before dispatching anything

- [ ] The two PRs below (#2348, #2323) are merged into `main` — **order does
      not matter between them**, they touch disjoint files and both are
      independently mergeable against current `main` (re-verified 2026-09-19
      23:14 ET, after #2309 merged and #2310 was superseded — see UPDATE
      below).
- [ ] `data/rematch-census-shares.json` is **not yet re-baselined** — do that
      AFTER this census, never before (a reference recorded before the census
      would describe last week's derivation, not the one the census walks
      under).
- [ ] This PR (the backing-count addition, #2346) is merged BEFORE the census
      dispatch — `SOURCES=backing` does not exist on `main` until it lands.
- [ ] `sold_comps` autoscale max is still 40,000 RU/s (the 09-07 wave-elevated
      ceiling; see `project_cosmos_ru_state_2026_09_07`) — confirm with
      `az cosmosdb sql container throughput show --account-name hobbyiq-comps
      --resource-group rg-hobbyiq-dev --database-name hobbyiq --name
      sold_comps`. If it has already rolled back to 10,000, HALT and get
      owner confirmation before dispatching — 32 concurrent slots at 10k RU
      is the throttled regime this batch's own throughput note warns against.
- [ ] `card_catalog` is at 100,000+ RU/s (per `cosmos-ru-rollback.md`,
      `cosmos-60s-failures-2026-09-15.md`) — this is the container the new
      backing preload reads from, not `sold_comps`.

> **UPDATE 2026-09-19 23:14 ET.** #2309 merged to `main` (squash,
> `eace4042`) earlier today. #2310, stacked on #2309's branch, was retargeted
> to `main` and went CONFLICTING — its diff re-carried #2309's own already-
> merged changes. Replaced by **#2348** ("HELD for census: strict
> checklist-source list (replaces #2310)"): a fresh branch off current
> `main` carrying only #2310's own commit, cherry-picked cleanly (`git diff
> origin/main --stat` shows exactly #2310's original 3 files, nothing from
> #2309 re-applied or reverted). #2310 is closed with a pointer to #2348.
> The section below is updated for #2348 in #2310's place; #2309 is dropped
> from the merge-order table because it is already on `main`.

---

## 0b. INCIDENT 2026-09-20: all 32 backing slots hung 150 minutes, zero output — FIXED

The first 32-slot dispatch of this batch (this section's own step 2, before
the fix below) hung every slot for the full 150-minute step ceiling and was
killed with **no banner, no heartbeat, nothing past `CENSUS CURSOR: no usable
prior checkpoint`**. A read-only probe against prod (bounded, 60s-capped
queries, never against `sold_comps`, never a write) found the cause and it is
**not** what this runbook's step 0's "Added cost of `sources=backing`"
section assumed.

### Root cause: not slow — non-terminating

`backingCellPreloadRaw`'s query (`SELECT DISTINCT c.id, c.source,
c.sourceSystem, c.sources, c.sport FROM c WHERE STARTSWITH(c.id, @prefix)`)
was issued with `{ maxItemCount: -1 }` and no `maxDegreeOfParallelism`. On
`card_catalog` (40 physical partitions), that combination does not run
slow — it **spins**: `iterator.hasMoreResults()` stays `true` forever while
`fetchNext()` resolves *immediately* with **0 RU and 0 rows on every single
page**. Measured directly: 5,000+ empty pages in under 500ms of wall clock,
repeated identically on the **smallest** measured cell (hockey:2023:
upper-deck, 1,446 rows) and the **largest** (baseball:2025:topps, 203,058
rows) — proving it is a client-side `@azure/cosmos` (v4.9.3) defect
independent of result size, never network latency. Because nothing ever
*threw*, neither `retry()`'s own 8-try backoff nor the SDK's own
30-try/120s-per-try throttle retry (`maxRetryAttemptsOnThrottledRequests: 30,
maxWaitTimeInSeconds: 120`, `main()`'s `CosmosClient` connection policy) ever
engaged — the promise kept resolving, it just never made progress. That is
why 32 slots hung 150 minutes and printed nothing: the "150-minute budget"
check itself was never reached, because the query it was waiting on inside
the per-row classify loop never returned.

The fix (shipped in this PR): the SAME query text, with **`maxItemCount:
500` (or any bounded page size) and `maxDegreeOfParallelism: -1` set
explicitly**. Isolated by measurement: `maxDegreeOfParallelism: -1` alone,
with `maxItemCount` still `-1`, does **not** fix it (still spins) — the
bounded `maxItemCount` is the load-bearing half of the fix;
`maxDegreeOfParallelism: -1` is what makes the bounded-page version fast
(parallel partition fan-out) rather than merely correct.

### MEASURED RU/latency/rows — the OLD shape vs the FIXED shape, 5 real cells

Read-only against prod `card_catalog` (`hobbyiq-comps`/`hobbyiq`), 2026-09-20.
"OLD" is capped at 8s per cell (proven non-terminating; no point re-proving
it burns the full budget on every cell) — its true behavior is unbounded
empty-page spinning, 0 RU, 0 rows, forever.

| cell | OLD shape (`maxItemCount:-1`, no MDOP) | FIXED shape (`maxItemCount:500`, `MDOP:-1`) |
|---|---|---|
| baseball:1989:topps | spins (0 RU, 0 rows, capped at 8s) | **1.3s, 243 RU, 3,310 rows** |
| baseball:2025:topps | spins (0 RU, 0 rows, capped at 8s) | **3.8s, 21,933 RU, 203,058 rows** |
| basketball:2023:panini-prizm | spins (0 RU, 0 rows, capped at 8s) | **1.7s, 4,775 RU, 95,701 rows** |
| football:2024:panini-donruss | spins (0 RU, 0 rows, capped at 8s) | **0.5s, 1,179 RU, 23,424 rows** |
| hockey:2023:upper-deck | spins (0 RU, 0 rows, capped at 8s) | **0.2s, 197 RU, 1,446 rows** |

### What differed from the "flat 112 RU, fast" ad-hoc measurement

This runbook's own step 0 ("Added cost of `sources=backing`") cited
`catalogIdentityResolver.ts`'s ad-hoc, pre-existing measurement of a
`STARTSWITH`+`DISTINCT` query at "a flat 112 RU, whatever the predicate" and
concluded the backing preload would cost the same. **That number was real,
but it was measured on a different query, answering a different question,
over a different-sized result set — and the difference is exactly what this
census's cells hit:**

1. **Result-set size, not query shape.** The ad-hoc measurement's
   `STEM_QUERY` (`src/services/catalog/catalogIdentityResolver.ts`) prefixes
   on **one card's own stem** (`<sport>:<year>:<setKey>:<number>...`) — a
   handful of graded/parallel twins, at most. This census's prefix
   (`backingCellIdPrefix`) is a **whole PRODUCT** (`<sport>:<year>:<setKey>:`
   with no card number) — every card, every parallel, every graded child of
   an entire set. `baseball:2025:topps` alone matched **203,058 rows**. RU is
   not flat at 112 once the match count leaves "a few twins" — it scales
   with rows actually read off disk, 21,933 RU for that cell alone. The
   original "flat 112 RU" framing (`card_catalog is partitioned... so ANY
   cross-partition query pays the per-partition floor... whatever the
   predicate`) is true only when the MATCHED set is small; it does not hold
   once the predicate is product-wide.
2. **Projection width, secondarily.** The ad-hoc query selected `c.id,
   c.source` (2 fields); this census's selects `c.id, c.source,
   c.sourceSystem, c.sources, c.sport` (5 fields, one an array) — measured
   ~10% more RU for the same rows on the largest cell, real but a minor
   factor next to (1).
3. **The one that actually caused the hang: `maxItemCount`.** The ad-hoc
   measurement's own comment ("`maxDegreeOfParallelism` did not change it")
   never tested `maxItemCount`, because its own result sets were always a
   handful of rows — under ANY page size, `maxItemCount:-1` never spun
   because the first page always exhausted the (tiny) result set before the
   defect's shape could manifest. A product-wide prefix is the first shape
   in this codebase's history to put enough matched rows through this exact
   code path to expose it.

**Revised RU model.** Not a flat 112 RU/query — RU scales with the cell's
matched-row count, from ~200 RU (a small vintage set) to ~22,000 RU (a large
modern flagship). A conservative per-slot estimate: ~1,374 distinct cells
(this runbook's own coupon-collector estimate, unchanged) × an assumed
worse-than-median per-cell cost — at the high end (`baseball:2025:topps`
scale, 21,933 RU) that is **~30,000,000 RU per slot**, not ~154,000 RU. Real
per-slot RU is reported in each slot's own artifact
(`backing.preload.catalogRowsRead` and the new heartbeat's running RU
total) and should be read from the FIRST slot's actual run (see the canary
below) before trusting any estimate for the full 32-slot dispatch.

### One-slot canary — REQUIRED before a 32-slot dispatch

Dispatch **slot 0 alone** first and watch its own log for a **heartbeat
line within 5 minutes** of the `CENSUS CURSOR` startup line:

```bash
gh workflow run backfill-runner.yml --ref main \
  -f script=rematch-sold-comps -f mode=census -f slot=0 -f slots=32 \
  -f scope=improve -f apply=false -f sources=backing
```

Expect, within the first page:

```
  heartbeat: 0m elapsed, <N> row(s) classified, <M> page(s) warmed, backing: <C> cell(s) preloaded, 0 permanently failed, 0 timed out, <RU> RU spent on backing, ...m of budget left
```

**If no heartbeat line appears within 5 minutes, CANCEL the run** (`gh run
cancel <run-id>`) — do not let it run to the budget or the step ceiling. No
heartbeat within 5 minutes means either the fix did not actually land on the
dispatched commit (check `SLOTS`/the confirmed script path in the log) or a
NEW stall shape this PR's fix does not cover; either way, 31 more slots
hung the same way is not information worth 150 minutes to re-learn. Only
dispatch the remaining 31 slots after the canary's heartbeat confirms real
progress (rows climbing, RU climbing, no repeated `permanently failed`
climbing unboundedly).

### Recommended max concurrent slots for `sources=backing`

`card_catalog` is provisioned at 100,000+ RU/s. Using the REVISED model
above (worst-case ~22,000 RU per large cell, not a flat 112 RU), a slot
warming several large cells concurrently inside one page's
`CLASSIFY_CONCURRENCY`-bounded warm phase (default 8) could burst up to
`8 × 22,000 ≈ 176,000 RU` for that one page's warm phase alone if every
concurrent cell happened to be topps-2025-scale — briefly over the
container's ceiling for slots that unluckily co-warm several large cells at
once (the SDK's own 429 retry absorbs this, at the cost of latency, not
correctness). Spread across **32 concurrent slots**, a simultaneous
worst-case burst is not realistic (cells are drawn from each slot's OWN
shard unit, and large modern flagship products cluster in a minority of
units per `data/rematch-shard-table.json`), but the REVISED model means the
prior "small fraction of one second of headroom" conclusion no longer holds
without qualification.

**Recommendation: dispatch in two waves of 16, not all 32 at once**, watching
`card_catalog`'s 429 rate (App Insights `hobbyiq-insights`) between waves —
this is a scheduling choice for THIS dispatch, not a config change, so it
does not require the live-config HALT. If the first wave's 429 rate stays at
baseline, the second wave can follow immediately; if it climbs materially,
pause and let the first wave finish before starting the second. This
supersedes step 3's prior abort criterion of watching for a 429 climb only
AFTER a full 32-slot dispatch — watch it after EACH wave now.

---

## 1. Merge order and expected stamp

Computed locally (fresh clone, no push) by merging/diffing each branch
against current `main` and running `derivation-version.cjs`'s
`currentStamp()`:

| PR | Branch | Touches (DERIVATION_INPUTS) | Base | State (2026-09-19 23:14 ET) |
|---|---|---|---|---|
| ~~#2309~~ | `fix/catalog-authority-official-checklist-source-...` | `catalogAuthority.service.ts` (loose classifier — **not** a DERIVATION_INPUT) | — | **MERGED** to `main` (squash `eace4042`), no longer part of this batch's dispatch |
| **#2348** (replaces #2310) | `held/rematch-classify-strict-checklist-source-20260919-231449` | `scripts/lib/rematch-classify.cjs` | `main` | OPEN, MERGEABLE, no conflicts (fresh branch, #2310's own commit cherry-picked cleanly) |
| #2323 | `r75-year-aware-routing-20260919-161500` | `src/services/portfolioiq/hobbyIqCardId.service.ts` | `main` | OPEN, MERGEABLE, re-verified against current `main` — still no conflicts (touches `productSetKeys.ts`/`hobbyIqCardId.service.ts`/`setKeyReconciliation.test.ts`, disjoint from #2348's files) |

#2348 and #2323 touch disjoint files and can merge in either order.

```
main (current, post-#2309) stamp:  dcb4008caa05d+2026-09-06.a   (#2309 touched no DERIVATION_INPUTS file, so this is unchanged from before #2309 merged)
+ #2348 alone on main:             daf5d3f8cdb17+2026-09-06.a   (identical to #2310's original stated stamp — same net change, correctly rebased)
+ #2323 alone on main:             d2e3edcb791c7+2026-09-06.a   (unchanged from #2323's own PR body — #2309/#2348 never touched its files)
+ #2348 + #2323 together:          d89719f819430+2026-09-06.a   (unchanged from the original inventory's combined figure — same final tree either way)
```

Verified 2026-09-19 23:14 ET, fresh clone off current `main` (`349c233c`):
`git cherry-pick c404db10` (2310's own commit) applied with zero conflicts;
`git diff origin/main --stat` showed exactly 2310's original 3 files and diff
stat. Separately test-merged #2323's branch on top with `git merge --no-commit
--no-ff` — clean, only `productSetKeys.ts` needed auto-merging (no manual
resolution). Ran the affected pin tests on #2348 alone
(`tests/i9ReferenceStamp.test.ts`, `tests/derivationStampNarrowedToIdentity.test.ts`,
`tests/manufacturerOfficialChecklistSourceIsAuthoritative.test.ts`): **55 pass,
2 fail** — exactly the two stamp-drift alarms
(`"and that stamp IS this tree's — the re-baseline re-armed the alarm"` and
`"PROPERTY 3 — the six v2 inputs on disk hash to the recorded reference"`). No
other test in any of the three files regresses. `npx tsc --noEmit` clean;
byte-checked (0x08/0x00) clean on all three changed files.

**This backing-count PR (#2346) does NOT move the stamp.** `rematch-sold-comps.cjs` is
**not** a `DERIVATION_INPUTS` entry (v2 dropped it — see
`derivation-version.cjs`'s own v1→v2 history) — only
`scripts/lib/rematch-derive-identity.cjs` and `scripts/lib/rematch-classify.cjs`
are hashed from this file's neighbourhood, and this PR touches neither. Confirm
before dispatch:

```bash
node -e "console.log(require('./backend/scripts/lib/derivation-version.cjs').currentStamp())"
# must read d89719f819430+2026-09-06.a on the dispatch commit, after #2348 + #2323 are merged
```

The census can run "from main" after merge regardless: `mode=census` **never
refuses on a stamp mismatch** — `stampsAgree()` only gates
`rebaseline-i9-reference.cjs`'s writer, and the census script itself has no
stamp check in its own refusal path (`refuse("mode"...)`, `refuse("slot-range"...)`,
`refuse("shard-table"...)` are the only pre-flight refusals; none reads
`derivation-version.cjs`). A stamp mismatch is exactly the state this whole
batch exists to close, not a blocker to running it.

---

## 2. Dispatch — ONE-SLOT CANARY FIRST, then two waves of 16

**Run the one-slot canary in step 0b before dispatching any of the 32
slots below.** The 2026-09-20 incident (all 32 slots hung 150 minutes, zero
output — see step 0b) was caused by a non-terminating query inside the
backing preload that is now fixed and covered by tests, but the canary is
what proves the FIX actually landed on the dispatched commit, not just that
the PR merged.

`rematch-sold-comps` dispatches through **`backfill-runner.yml`** (registered
workflow name: "Backfill Runner (sold_comps re-slug / verify_queue batch)"),
**not** "Daily 5AM ET Refresh & Deploy" (a separate, unrelated workflow, id
272081148, that deploys `backend/src` to the App Service). CLAUDE.md's golden
rule about dispatching "Daily 5AM ET Refresh & Deploy" after every
`backend/src` merge does not apply to this batch: this PR touches
`backend/scripts/` and `.github/workflows/`, never `backend/src/`, so no
deploy dispatch is needed at all — the runner checks out the branch fresh and
runs the script directly, it is not part of the deployed App Service bundle.

Per step 0b's revised RU model and recommended concurrency, dispatch in
**two waves of 16 slots**, not all 32 at once:

```bash
# WAVE 1: slots 0-15
for SLOT in $(seq 0 15); do
  gh workflow run backfill-runner.yml --ref main \
    -f script=rematch-sold-comps \
    -f mode=census \
    -f slot=$SLOT \
    -f slots=32 \
    -f scope=improve \
    -f apply=false \
    -f sources=backing
  sleep 5   # stay well under GitHub's dispatch rate limit
done
# Watch card_catalog's 429 rate (App Insights hobbyiq-insights) before wave 2.
# If it is at baseline, proceed immediately; if it climbs materially, wait
# for wave 1 to finish before dispatching wave 2.
# WAVE 2: slots 16-31
for SLOT in $(seq 16 31); do
  gh workflow run backfill-runner.yml --ref main \
    -f script=rematch-sold-comps \
    -f mode=census \
    -f slot=$SLOT \
    -f slots=32 \
    -f scope=improve \
    -f apply=false \
    -f sources=backing
  sleep 5
done
```

`scope=improve` is inherited-but-ignored: `MODE=census` counts every class
regardless of `scope` (see the script's own banner line, `"MODE=census counts
every class; the apply class scope does not apply"`) — it is passed only
because the workflow's `SCOPE` env always forwards `inputs.scope` and an empty
value would print as the ambiguous runner-wide default. `apply=false` is
likewise inert under `mode=census` (there is no write path in this mode at
all) but kept explicit so the dispatch reads the same as every other
report-only run in this repo's history.

**Alternative, if `wave2-fleet.sh`'s dispatch/follow machinery is preferred
over a bare loop:** that driver does not currently forward a `sources=`
value (checked: no reference to `SOURCES`/`sources` in
`backend/scripts/wave2/wave2-fleet.sh` as of this PR). Extending it is
explicitly OUT OF SCOPE for this batch — it would be a second PR, and the bare
loop above is sufficient for a one-time batch. Do not add `sources` support to
`wave2-fleet.sh` under this runbook.

### Expected duration

Per the script's own measured throughput note: ~150-200 in-slot rows/s at
`sold_comps`'s fixed baseline RU tier, ~52 min/slot per the owner's go
(matching slot 0's own measured 484,940+39,000 = 523,940 rows at that rate).
32 slots run **in parallel** (each is an independent `workflow_dispatch`), so
wall-clock for the whole census is ~1 slot's worth (~52-90 min, some slots own
more rows — see `data/rematch-shard-table.json` for the per-slot row counts,
1.07x spread) plus GitHub Actions queue time, NOT 32× that.

### Added cost of `sources=backing`

**SUPERSEDED 2026-09-20 — see step 0b above for the corrected RU model.**
The "flat 112 RU per query" framing below held only for the ad-hoc
measurement it was borrowed from (a single card's stem, a handful of
matched rows); this census's prefix is a whole PRODUCT and its real RU
scales with the cell's matched-row count (measured 197-21,933 RU per cell
across 5 real cells, not a flat 112). The design (one query per distinct
cell, never a point read per sale) is UNCHANGED and correct; only the
per-query RU estimate below is stale. Kept for its still-correct point read
comparison and design rationale.

See `CENSUS_BACKING`'s own comment block in `rematch-sold-comps.cjs` for the
full design. Summary: a **projected** `card_catalog` query per distinct
(sport, year, setKey) cell a slot's rows fall into, never a point read per
sale or per distinct id — a point read was measured at ~49 RU on this
container's real documents (523,104 RU / 10,664 ids in a real re-score),
which would be tens of millions of RU across 16.3M sales even folded down to
distinct ids.

**CORRECTED 2026-09-19 per independent review — the query loads by ID PREFIX,
not by the setKey FIELD.** The metric's actual question is "does a catalog
row exist whose `id` EQUALS this sale's hobbyiqCardId" — a row's `id` and its
`setKey` FIELD are not the same fact and can disagree (this repo's own
`catalogIdentityResolver.ts` documents exactly this: "the …:cpa-bm:
red-refractor:auto twin carries setKey \"bowman\" while its id says
bowman-chrome... rows disagree with their own fields"). The query is now:

```sql
SELECT DISTINCT c.id, c.source, c.sourceSystem, c.sources
FROM c WHERE STARTSWITH(c.id, @prefix)
-- @prefix = "hiq:<sport>:<year>:<setKey>:", the same prefix the sale's
-- own hobbyiqCardId carries under this cell
```

**This is CHEAPER than the field-equality version it replaces, not more
expensive.** `catalogIdentityResolver.ts`'s own measured history (read-only
against prod, 2026-08-30): `card_catalog` is cross-partition (40 physical
partitions), so ANY cross-partition query pays the per-partition floor —
`STARTSWITH(c.id, @stem)` measured a **flat 112 RU, whatever the predicate**,
while equality on indexed fields (sport, year, setKey, ...) measured
**184–274 RU** for the SAME question, and additionally returned MORE rows
(every graded child) and could be WRONG (the field/id disagreement above).
`SELECT DISTINCT` on the id-prefix predicate additionally cuts wall-clock
(150–340ms vs 1.7–2.4s in that same measurement) for the identical RU, by
letting the SDK fan the 40 partitions out in parallel instead of walking them
serially — the shipped query uses `SELECT DISTINCT` for exactly this reason.

Re-estimated cost table (same coupon-collector model as before, corrected RU
per query from 5+3×matched-rows to the measured flat **112 RU per query**,
independent of how many rows match):

| | per-slot avg | total (32 slots) |
|---|---|---|
| distinct-cell queries | ~1,374 | ~44,000 |
| est. RU (flat 112 RU/query, cross-partition floor) | ~154,000 RU | ~4,930,000 RU |

**This does not change the conclusion materially** — ~154,000 RU/slot vs the
prior estimate's ~188,000 RU/slot, both a small fraction of `card_catalog`'s
100,000+ RU/s ceiling spread across a ~50-90 minute slot walk. The flat-RU
model is if anything a tighter, more defensible bound than the prior
matched-rows-dependent one, since it does not depend on guessing how many
catalog rows a typical product carries.

**The cache is bounded in SIZE (`BACKING_PRELOAD_CELL_CAP`, default 500,
LRU), not in QUERY COUNT.** Under an adversarial ordering (sales that
round-robin across more distinct cells than the cap, faster than the cache
can hold them) the pathological upper bound is one query per sale — the same
as no cache at all. What actually keeps this cheap is PRODUCT LOCALITY:
`sold_comps` ingest writes in per-product bursts (one CH/eBay pull = many
consecutive same-cardId rows), the same locality the classify loop's own
pre-existing, UNCAPPED `checklistCells`/`flagshipNumbers`/`checklistNames`/
`checklistAutos` product caches already rely on and have never needed a cap
for.

`card_catalog` is provisioned at 100,000+ RU/s (per `cosmos-ru-rollback.md`).
~154,000 RU spread across one slot's ~50-90 minute walk is a small fraction
of even ONE SECOND of that ceiling — the real constraint this batch is
designed around is `sold_comps`'s 40,000 RU cap (see step 0), which this
backing addition never touches: it reads `card_catalog` exclusively. It hits
**`card_catalog`'s RU, never `sold_comps`'s.**

**The census should not throttle itself further for this.** The ordinary
classify loop already issues its own unconditional per-row `card_catalog`
query (`clashSubsetsFor`, pre-existing, unrelated to this PR) plus several
more gated ones (`checklistCells`, `flagshipNumbers`, `checklistNames`,
`checklistAutos`, `checklistBacked`/`checklistBackedStrict` point reads) —
the backing preload's ~1,374 extra queries per slot is additive to, not a
multiplier of, that existing cost, and `card_catalog`'s headroom (100k RU vs
an estimated few hundred thousand RU total added) does not warrant a new
throttle. Each slot's own artifact reports `backing.preload
.distinctCellQueries` and `.catalogRowsRead`, so the REAL number is measured
after every run, not just estimated beforehand — if a live slot's count is
wildly above this estimate (evidence the locality assumption broke down for
that slot's row ordering), that is visible in the collected artifacts before
the merge step runs, and is worth a second look before trusting that slot's
backing numbers.

### A cell's card_catalog load can fail — corrected 2026-09-19

The FIRST version of this design wrapped the query in `catch { out = [] }` —
so a load that failed for ANY reason (an outage, auth, a syntax error) was
silently treated as "the catalog has no rows here" and CACHED as if it were a
real answer, permanently bucketing every sale of that cell `noRow` with no
signal anything went wrong. **Fixed**: a failed load returns a sentinel that
is never cached as a value. The NEXT sale of that cell tries again (up to
`BACKING_PRELOAD_CELL_FAIL_RETRIES`, default 3, attempts — one per SALE of the
cell, never a tight retry loop inside the preload itself); every sale that
sees a failure is bucketed **`unknown`**, never `noRow`; once the retry budget
is spent the cell is marked permanently failed for the rest of the slot and
every remaining sale of it is `unknown` with no further queries issued.
`backing.preload.failedCells` and `.failedCellSamples` (cell key, attempt
number, error message, up to 50 entries) report this per slot; `merge-census
-backing.cjs` sums `failedCells` across slots and prints the samples loudly
(never buried) if any are non-zero.

### Buckets, corrected/added 2026-09-19

Seven buckets now, not five: `backedStrict`, `rowExistsNonStrict`, `noRow`,
`unparseable` (the U class), `parked` (identityUnverified), **`notPricedFlagged`**
(`flaggedWrong===true` or `excludedFromFmv===true` — NEW, its own bucket, same
reasoning as parked: a sale nothing prices is not a "coverage gap" in the same
sense a live sale's missing catalog row is), and **`unknown`** (NEW — a
FAILED load, see above). **The headline denominator excludes parked,
notPricedFlagged AND unknown** — every share `merge-census-backing.cjs`
prints states both the included-in-denominator total and the excluded total
by name, never a single unlabelled percentage.

### Comparison against the 15,418-sale sample

The sample measured 49.9% backed, with the unbacked 50.1% split V 19% / N+R
35% / P 28% / U 11%. Since we walk every sale anyway, the merge script now
also prints the full-population class split (backed / rowExistsNonStrict /
noRow / U(unparseable) / parked / notPricedFlagged / unknown) per sport and
overall, over the same denominator convention, so the two numbers can be set
side by side. The sample's V/N/R/P vocabulary does not map one-to-one onto
this run's buckets — this census has no per-sale title-contradiction check,
so it cannot itself distinguish V (title contradicts a real catalog row) from
N/R/P the way the sample did — the comparison is stated as "this run's U vs
the sample's U", never claimed as a full V/N/R/P reproduction. See
`merge-census-backing.cjs`'s own printed section and `distinctCellsTouched`
in its output for the two population-scale figures (class split, distinct
products actually touched) the sample could not measure at this scale.

---

## 3. Watch

Each slot is an independent workflow run. Watch with:

```bash
gh run list --workflow=backfill-runner.yml --limit 40
```

A slot's own log states its identity on two lines (same check
`wave2-fleet.sh` uses to avoid attributing a foreign run's log to a census
slot):

```
Script confirmed: backend/scripts/rematch-sold-comps.cjs
rematch-sold-comps  MODE=census  READ ONLY  slot <N>/32 ...
```

A FAILED slot looks like one of:

- **`stopped at the <N>-minute budget`** with `this slot did NOT reach its
  whole shard` — not a failure, a checkpoint. The runner's own self-relaunch
  fires on this line automatically (no new dispatch needed) and resumes from
  the saved cursor. Confirm the relaunch actually happened
  (`gh run list` shows a follow-up run for the same slot) rather than assuming
  it did.
- **`refuse("...")` + exit 2** in the log, before the `CENSUS` banner ever
  prints — a startup refusal (bad env, missing shard table, wrong `SLOTS`).
  Fix the dispatch inputs and re-run that slot alone; nothing was read or
  written, so there is nothing to undo.
- **A run that ends with no banner and no refusal at all** (KILLED at the
  GitHub Actions step timeout, not this script's own budget) — re-run that
  slot alone; the shard axis guarantees no other slot needs re-running because
  of it (slots never overlap).

**Re-running just one slot**: re-dispatch with the SAME `slot=<N> slots=32
scope=improve apply=false sources=backing` — never change `slots` (that
re-shards the whole corpus) and never omit `sources=backing` (that slot's
artifact would then lack the `backing` block the merge step needs).

### Abort criteria

- `SLOTS` in a slot's own banner does not read `32` — the shard table changed
  underneath the dispatch (re-measure before continuing, per the script's own
  `refuse("shard-table"...)`).
- More than a handful of slots refuse at startup with the same message — a
  systemic env/input problem, not a per-slot fluke; fix it and re-dispatch all
  32 rather than patching slots one at a time.
- `card_catalog` 429 rate climbs materially above baseline during the run
  (App Insights `hobbyiq-insights`) — HALT the remaining un-dispatched slots,
  this is the live-config-adjacent signal the RU estimate above was meant to
  keep this batch clear of.
- **A slot's log has no heartbeat line for more than ~2x `CENSUS_HEARTBEAT_MS`
  (default 60s, so >2 minutes silent) while its own run is still `in_progress`**
  — per step 0b, the fix guarantees a heartbeat inside page processing at
  least every `CENSUS_HEARTBEAT_MS`; a gap that large with the process still
  running is a NEW stall shape this PR's fix does not cover, not the
  incident this PR closes. Cancel that slot and investigate before
  re-dispatching it — do not assume it will recover on its own.

---

## 4. Collect artifacts

```bash
mkdir -p /tmp/census-2026-09-20
for SLOT in $(seq 0 31); do
  RUN_ID=$(gh run list --workflow=backfill-runner.yml --json databaseId,displayTitle -q \
    '.[] | select(.displayTitle | test("slot='"$SLOT"'\\b")) | .databaseId' | head -1)
  gh run download "$RUN_ID" -n "rematch-census-slot-${SLOT}-${RUN_ID}" -D /tmp/census-2026-09-20
done
ls /tmp/census-2026-09-20   # expect census-slot-0.json .. census-slot-31.json
```

(The artifact name pattern `rematch-census-slot-<slot>-<run_id>` is fixed by
the workflow's "Upload the shard census" step, `if: always()` — a slot that
stopped at budget and relaunched uploads once per link in the chain; take the
LAST link's artifact for each slot, since it carries the merged, cumulative
counts.)

---

## 5. Re-baseline I9

```bash
node backend/scripts/rebaseline-i9-reference.cjs --from /tmp/census-2026-09-20   # report first
APPLY=true node backend/scripts/rebaseline-i9-reference.cjs --from /tmp/census-2026-09-20
```

Refuses (exit 3) if the stamp already matches — should not happen here, since
this batch's whole premise is a stamp that has already moved. Refuses (exit 4)
under `MIN_ROWS` (default 20,000) — will not happen at a full 32-slot walk
(~16.3M rows). Writes `backend/data/rematch-census-shares.json` only.

---

## 6. Merge the backing count

```bash
node backend/scripts/merge-census-backing.cjs --from /tmp/census-2026-09-20 --top 300 --out /tmp/census-2026-09-20/backing-report.json
```

Prints, always FIRST, whether any cell's card_catalog load failed this
census (`backing.preload.failedCells`, summed across slots) — loudly, even
at zero, so a non-zero count is impossible to miss before reading any share.
Then the overall strict-clean share (explicitly labelled with its
denominator — backedStrict+rowExistsNonStrict+noRow+unparseable — and the
excluded total — parked+notPricedFlagged+unknown — printed by name, never a
bare percentage), per-sport breakdown, the full-population class split for
comparison against the 15,418-sale sample, and the top 300 unbacked (sport,
year, setKey) cells (P0 = no product rows at all, P1 = product rows exist
but none strict; N/R need a per-sale card number this merge step does not
carry — see the script's own header "NOTE ON N vs R" — so by default they
print `unknown`). To also compute a best-effort N/R split for just the top
cells (one extra `card_catalog` COUNT query per flagged cell, never per
sale):

```bash
CATALOG_CHECK=true COSMOS_CONNECTION_STRING=$(az webapp config appsettings list \
  --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv) \
  node backend/scripts/merge-census-backing.cjs --from /tmp/census-2026-09-20 --top 300
```

(Per CLAUDE.md: pipe the connection string directly into the env, never to
disk, never echoed to stdout.)

**This is CATALOG BACKING ONLY.** The output's strict-clean number here
measures "does the sale's own catalog row exist and cite a strict source" —
it is a different, larger-sample number than I9's sample-based
title-contradiction "strict clean" check, and the two must not be quoted
interchangeably. Say so explicitly in whatever the merged number is reported
as (Slack, a PR description, a follow-up issue).

**Check `loadFailures.totalFailedCells` in the written report before trusting
the headline share.** A non-zero count means some cells could not be
answered this run (transient Cosmos issues, etc.) — their sales are correctly
excluded from the denominator as `unknown`, so the SHARE itself is still
honest, but a large `totalFailedCells` relative to `distinctCellsTouched`
is worth a look (a systemic issue during the run, e.g. a card_catalog outage
window) before publishing the number as the batch's headline figure. Re-run
just the affected slots (see step 3, "Re-running just one slot") if the
failure rate looks abnormal, rather than accepting a headline share that
silently excludes more sales than expected.

---

## 7. Second PR

Commit `backend/data/rematch-census-shares.json` (the re-baseline) and, if
useful going forward, the merged `backing-report.json` (or a summary of it) in
one PR onto `main`. This PR does NOT need the "Daily 5AM ET Refresh & Deploy"
dispatch either — it touches `backend/data/` and possibly `backend/docs/`,
not `backend/src/`.

---

## 8. Post-census: `sold_comps` autoscale back down

**OWNER-APPROVED LIVE CONFIG; orchestrator runs it, not a builder agent.**
Per CLAUDE.md's golden rule, live prod config changes (Cosmos indexing
policy, autoscale RU, App Service settings, KeyVault) HALT for explicit user
confirmation even when provably safe — this step is that HALT, not an
instruction to execute unattended.

```bash
# OWNER CONFIRM REQUIRED BEFORE RUNNING:
az cosmosdb sql container throughput update \
  --account-name hobbyiq-comps --resource-group rg-hobbyiq-dev \
  --database-name hobbyiq --name sold_comps \
  --max-throughput 10000
```

Only after: (a) every slot's chain outcome is `finished` (not still
mid-relaunch), (b) the re-baseline PR (step 5-7) is merged, and (c) no other
rematch/repair fleet is currently mid-run against `sold_comps` (check
`gh run list --workflow=backfill-runner.yml` for anything still `in_progress`
— per `project_baseline_pool_snapshot_runaway_stack`, concurrent chains
against this container have caused real incidents before).
