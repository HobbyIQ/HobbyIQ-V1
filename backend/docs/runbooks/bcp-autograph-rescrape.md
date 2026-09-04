# BCP autograph re-scrape — the plan (REPORT ONLY, nothing dispatched)

**Status:** report-first. No dispatch has been run and none is authorized by this
document. The numbers below are a *measurement plus an extrapolation*; the
dispatch section is the exact command to run **after** Drew rules.

## Why there is anything to re-scrape

`scrape-bcp-ladders.cjs` anchored on `Base_Set` + `Parallels` and never read the
`Autographs` section, so every row it has ever emitted carries `isAuto=false`.
For a product whose autographs share the BASE card numbers, that means the
signed card has **no catalog row at all** — 2011 Topps Chrome has 5,026 rows,
all `isAuto=false`, and none of them is the #173 Freddie Freeman autograph that
actually sells.

The scraper now reads those sections (`parseAutographs`), so the pages have to be
**re-acquired** to gain the rows. This is a re-scrape of pages we already hold,
not a new acquisition — which is why it runs under `SCOPE=recheck`.

## What the probe measured

A **stratified, bounded sample of 63 of the 3,156 bcp universe entries**
(evenly spaced, ~6 per decade), fetched once each at a 1.2s delay with a real UA.
No BCP HTML cache exists in the repo, so this is a live sample rather than a
cache replay. Raw results: `C:/tmp/bcp-auto-probe.json` (not committed — a
measurement, not an artifact).

| decade | universe | sampled | has autograph heading | auto rows in sample |
|-------:|---------:|--------:|----------------------:|--------------------:|
| 1880s–1980s | 519 | 38 | **0 (0%)** | 0 |
| 1990s | 642 | 6 | 1 (17%) | 0 |
| 2000s | 866 | 6 | 6 (100%) | 567 |
| 2010s | 560 | 6 | 5 (83%) | 3,275 |
| 2020s | 569 | 6 | 4 (67%) | 4,763 |

**Sample totals:** 63 sampled, 63 reachable, 16 (25%) carry an autograph
heading, 12 (19%) yield actual auto rows, 8,605 auto rows in the sample alone.

Extrapolated across the lane — **~1,819 pages carrying an autograph section,
~839,000 auto catalog rows currently missing.** Treat the row figure as an
order of magnitude, not a target: it is 12 pages' row counts scaled by decade
population, and page sizes vary by two orders of magnitude (2020 Topps 582
Montgomery Club yields 29 rows; 2025 Topps Inception yields 2,965).

### The era boundary is real, and it is the scope

**Zero autograph sections before 1990** across 38 sampled pages spanning
1886–1989. Certified autographs are a 1990s-onward product feature, so the 519
pre-1990 entries are not merely low-yield — they are *out of scope*. Restrict the
dispatch to `YEARS` from 1990 and the work halves for no loss.

### The parser generalizes, and it refuses honestly

Across the sample it read layouts it was never written against — `Rookie
Autographs`, `Prospect Autographs`, `Legendary Signatures`, `Material
Signatures`, `Break Out Autographs`, `Autographed Chrome Draft Picks`,
`Transformation Autographs`, `Nickname Autographs`. It found subsets hanging off
`Inserts` as well as off an `Autographs` h2.

Four sampled pages (1993 Ultra, 2000 Aurora, 2004 Bowman's Best, 2020 Topps X)
have an autograph **heading** but list **no cards** — the page cross-references
another checklist. Those emit **nothing**, per `no synthetic parallels — actuals
only`. The 25% → 19% drop between "has a heading" and "yields rows" is that
refusal working, not a parser gap.

## The dispatch (DO NOT RUN without Drew's go)

The bcp lane already re-acquires through `ingest-universe-driver.cjs`, whose
`bcp` case calls this very scraper with `--titles=<page>`. Nothing new is needed;
the run is scoped with the existing env contract.

**Step 1 — report only, confirm the queue.** `APPLY` unset means no acquisition
and no writes; read the banner and confirm the eligible count before anything else.

```
SOURCES=bcp SCOPE=recheck YEARS=1990,...,2026 \
  MANIFEST_PATH=backend/data/ingest-universe.json \
  node backend/scripts/ingest-universe-driver.cjs
```

**Step 2 — a bounded canary.** `LIMIT` overrides the budget-derived N. Twenty
pages, then diff the staged CSVs: auto rows present, base rows still
`isAuto=false`, print runs matching the page's *auto* ladder and not the base one.

```
SOURCES=bcp SCOPE=recheck YEARS=... LIMIT=20 BACKFILL_APPLY=true \
  node backend/scripts/ingest-universe-driver.cjs
```

**Step 3 — the lane, in budgeted shards.** `RUN_MINUTES` sizes N; the driver
records per-entry verdicts in `crawl_state` so a relaunch continues rather than
re-doing the head of the list.

Notes that decide whether this run is honest:

- **`SCOPE=recheck` is required.** Without it the driver skips every entry with a
  terminal verdict — which is all of them — and the run does nothing while
  reporting success.
- **`BACKFILL_APPLY=true`, not `APPLY=true`**, is the variable the runner exports
  (memory: *Runner exports BACKFILL_APPLY, not APPLY*). Read the banner: it says
  `APPLY` or `REPORT ONLY`. Verify the write by a Cosmos count, never by a green run.
- **Scope formats are per-script.** `YEARS` here is a comma list, not a range.
  A `years=1990-2026` would bind as a single literal and silently widen or empty
  the run (memory: *Scope formats are per-script*). The banner prints the parsed
  scope; read it before APPLY.
- **Dispatch one lane per run.** The driver refuses more than one `SOURCES` value
  on purpose, so each lane gets its own budget and its own reconciliation.
- **Measure throughput before sharding** (memory: *Fleet scripts measure
  throughput before dispatch*): rows/s and a verdict diff from the canary decide
  the shard count, not an assumption.

## What this re-scrape does NOT do

- It does not fix the two data defects found while diagnosing (`#175 "Micahel
  Crotta"`, the football DeMarco Murray auto sitting in the baseball #173 pool).
  Those are filed in the PR body and are separate work.
- It does not resolve cross-referenced autograph checklists (the USA Baseball and
  60th Anniversary subsets on the 2011 page). Those name another page; following
  the reference is its own acquisition.
- It mints nothing. Every emitted row traces to card lines the page itself lists.
