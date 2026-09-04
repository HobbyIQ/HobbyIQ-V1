# Re-acquiring the bcp lane after CF-A-SECTION-CLASS-IS-A-CARD-TYPE

**Status: REPORT ONLY. Nothing here has been dispatched.**

The scraper change makes pages we have *already fetched* yield rows they never
yielded before. No new checklist is being acquired — the data was always on the
page. This runbook says which manifest entries are affected, what they unblock,
and the exact dispatch, so the run is a decision rather than a discovery.

## What changed, in one line each

| change | effect on emitted rows |
|---|---|
| §Autographs / §Autographed Rookies / §Autographed Relics / §Autographs & Game-Used read | signed cards exist in this lane for the first time |
| §Relics / §Game-Used / §Memorabilia read | memorabilia cards get their own rows, `isAuto=false` |
| `insert:` → `insert-` | **every insert row this lane has ever staged** starts reaching the catalog |
| manifest gains `parallelColumnAuthoritative: true` | the page's own rung name survives ingest instead of being re-derived from the category slug |
| `Printing Plates (four-for-each)` → `printRun=1` | plates stop reading as unknown |

The colon fix is the quiet one and probably the largest. `ingest-scraped-checklist.cjs`
accepts `base`, `insert-*` and `auto-*` and does `else { skipped++; continue; }`
for everything else. This lane wrote `insert:<slug>`, so every insert row it has
ever produced was read from the page, written to the CSV, counted in the run
summary — and dropped at the ingest door.

## Bounded probe — what the manifest actually carries

65 of the lane's 3,156 entries were fetched (stratified by decade, 2.5s apart,
real UA). This is a **sample**, and the projections below are extrapolations from
it, not measurements of the whole lane.

| decade | probed | carry a newly-read section | auto rows | relic rows | insert rows unblocked |
|---|---|---|---|---|---|
| 1880s–1990s | 27 | **0** | 0 | 0 | 80 |
| 2000s | 16 | 10 | 1,546 | 3,753 | 753 |
| 2010s | 11 | 8 | 3,935 | 1,573 | 1,033 |
| 2020s | 11 | 8 | 11,347 | 6,020 | 1,702 |

**The finding that shapes the dispatch: the effect is entirely year ≥ 2000.**
Zero of the 27 pre-2000 pages probed carry an Autographs, Relics or Game-Used
h2 — those products largely did not have insert autograph sets, and the pages
reflect that. Re-acquiring 1,161 pre-2000 entries would spend the budget to
change nothing.

### Scope and projection

- bcp entries with `year >= 2000`: **1,995** of 3,156
- share of probed modern pages carrying a newly-read section: **26/38 = 68%**
- entries expected to gain rows: **~1,365**
- projected new auto rows: **~880,000**
- projected new relic rows: **~600,000**
- projected insert rows unblocked by the colon fix: **~180,000**

These projections carry the sample's error bars and are dominated by a few very
large pages (2023 Donruss alone contributes 4,003 auto rows; 2024 Triple Threads
3,341). Treat them as an order of magnitude, not a target. The honest sizing of
the *harm* is the census's own on-page count — 3,173 unread card lines across 25
pages, 2,124 of them auto or game-used — not the extrapolated row count.

### Pool rows this unblocks

The census measured the orphan signal directly and its caveat stands: of the 470
orphaned bcp rows it found, **469 were the `AutographDen` seller-handle false
positive** (PR #1698), leaving 18 rows / $129 of real in-sample orphan signal.
So the row count is *not* the case for this work. The case is the one card the
finding named: 2011 Topps Chrome Freddie Freeman #173 is an autograph with a
nine-rung ladder printed on the page, every sale of it lands in a `:auto` pool
with no ladder to price against, and until now the lane could not mint that row
even in principle. That is true of every signed card in every page in the table
above.

**A Cosmos-side count of the affected pools is still owed.** Cross-partition
aggregates over `sold_comps` did not return inside a sane timeout during this
work, and a number nobody measured is worse than no number. Measure it before
the apply run, not after.

## The dispatch (do not run without a go)

`ingest-universe-driver.cjs` is the right driver: it drives the manifest one
entry at a time and records a per-entry verdict, rather than re-scraping a whole
source. It runs on the **backfill-runner** workflow.

The workflow takes **typed inputs**, not an env blob; it exports them as
`SOURCES` / `YEARS` / `SCOPE` / `LIMIT` / `BACKFILL_APPLY` itself
(`backfill-runner.yml:863,915,924,930,970`). `script` is a `choice`, and the
option is `ingest-universe-driver` — no `.cjs`.

```
gh workflow run "backfill-runner" \
  -f script=ingest-universe-driver \
  -f sources=bcp \
  -f scope=recheck \
  -f years=2000,2001,2002,2003,2004,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015,2016,2017,2018,2019,2020,2021,2022,2023,2024,2025,2026 \
  -f limit=25 \
  -f apply=false
```

Four things about that input are load-bearing:

1. **`scope=recheck` is required.** These entries are already verdicted. The
   driver takes *pending* entries by default, so without `recheck` this run
   selects nothing and reports success having done nothing.

2. **`scope` must be passed explicitly anyway.** Its workflow default is
   `refractor` — inherited from `repair-refractor-mislabel`, not chosen for this
   script. Leaving it unset hands the driver a `SCOPE` it will not read as
   `recheck`, which lands back in case 1.

3. **`years` is an exact-match comma list, not a range.** `ingest-universe-driver.cjs:491`
   does `years.includes(String(e.year))`. `years=2000-2026` matches **no** entry,
   and an empty year filter is not an error — it falls through to the whole lane,
   all 3,156 entries including the 1,161 that provably gain nothing. This is
   `feedback_scope_formats_are_per_script` exactly: read the banner the run
   prints and confirm the candidate count is ~1,995 before letting it apply.

4. **`apply=false` first.** The workflow exports it as `BACKFILL_APPLY`, not
   `APPLY` (`feedback_runner_exports_backfill_apply`). Dry-run a `limit=25`
   slice, read the per-parallel breakdown `ingest-scraped-checklist.cjs` prints,
   and confirm by eye that:
   - signed rows appear only under `auto-*` categories
   - `insert-*` rows are arriving at all (they never have before)
   - rung names are the page's own ("Refractor", "Gold Refractor"), not the
     subset name ("Autographed Rookies") repeated

   Only then raise `LIMIT` and set `BACKFILL_APPLY=true`.

### Suggested order

| wave | scope | why |
|---|---|---|
| 1 | `LIMIT=25`, `BACKFILL_APPLY=false` | prove the shape before writing anything |
| 2 | `YEARS=2020,...,2026`, apply | densest sections, largest pages, fastest signal |
| 3 | `YEARS=2010,...,2019`, apply | |
| 4 | `YEARS=2000,...,2009`, apply | thinnest of the three, mostly relics |
| — | pre-2000 | **not scheduled** — 0/27 probed pages carry a section |

Backend `src` is untouched by this change, so no
"Daily 5AM ET Refresh & Deploy" dispatch is required for the scraper itself.

## Known adjacent defect, not fixed here

2021 Topps Chrome emits **624 duplicate base rows**: two scopes of that page
share a stem and both write the paper card list. It is present identically
before and after this change (the golden pin proves base output is byte-identical),
so it is not this PR's to fix — but it is a real split-pool risk and wants its
own ticket.
