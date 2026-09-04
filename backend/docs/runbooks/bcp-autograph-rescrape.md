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

---

## Postmortem: run 33837346045 (2026-09-04) — and what changed

The canary above was dispatched (`sources=bcp scope=recheck years=1990..2026
limit=20 apply=true`) and **aborted on its first entry**:

```
  [1/20] bcp/Baseball Wit — FAILED — bcp scrape produced no CSV
  Process completed with exit code 3
```

2,637 entries were eligible; `universe_entries_done=0`; **zero** control docs
landed. Three separate defects, all now fixed and pinned in
`backend/tests/ingestUniverseDriverLaneContinues.test.ts`.

### 1. The lane died because a control id is not a URL

`entry.id` embeds the whole `sourceRef`, so `controlId()` produced
`ingest_universe::bcp::http://www.baseballcardpedia.com/index.php/1990_Baseball_Wit`
— and the Cosmos SDK rejects that **client-side**:

```
Illegal characters ['/', '\', '#'] cannot be used in Resource ID
```

`writeControl` sat *after* the per-entry `try/catch`, so the throw escaped to the
outer handler and `process.exit(3)` took the lane down with 19 entries unread.

This was never bcp-specific and never new: **all 7,755 manifest entries across
all six lanes** produce an illegal id, so no generation of this driver has ever
written a verdict in APPLY mode. The run simply reached the line first.

Fixed by escaping (not stripping — the mapping must stay injective, or two
entries differing only where a slash sat fold onto one doc and the second
inherits the first's verdict forever).

### 2. A refused entry is a verdict, not a broken lane

`writeControl` is now inside a guard, its failures are counted, and the loop
continues. **"Empty scrape" is the correct refusal for the ENTRY** — it is
recorded as `failed` with its reason, logged, and the run walks on.

A lane-level abort survives, but only for **systemic** failure:
`SYSTEMIC_FAILURE_STREAK` (default 3) **consecutive** failed/unreachable entries,
or 3 failed control writes. Consecutive, never cumulative — a lane where every
other page has no ladder is a *working* lane. A systemic abort exits **5** and
deliberately does **not** print the budget marker, because a relaunch would meet
the same wall.

### 3. "Baseball Wit" is a correct refusal, not a parser regression

Measured live on 2026-09-04:

| check | result |
|---|---|
| page under the manifest's URL form | **exists** (301 → `https://baseballcardpedia.com/...`, HTTP 200, 45,176 bytes) |
| `Base_Set` section | **present** — headings are `h2:Base_Set`, `h3:Unnumbered` |
| `Parallels` section | **absent** |
| scraper output | `1990_Baseball_Wit: base ok (109) but 0 rungs — nothing new to add`, exit **0**, no CSV |

`main` does `const ladderScopes = scopes.filter(s => s.rungs.length); if
(!ladderScopes.length) { noLadder++; ...; continue; }` — a page with base cards
and no ladder writes nothing. **#1700 did not change this**: the line is
byte-identical at `07fe8cc^`, and `parseAutographs` runs *inside* the per-scope
loop that the `continue` never reaches. The manifest itself already said so —
`seededNote: "144 rows, NO parallel ladder (base-only)"`.

Nothing to fix in the scraper: 1990 is the autograph **boundary year**, and the
probe measured 0 autograph sections across 38 pages spanning 1886–1989.

### 4. Report mode was walking — the marker lied

The preceding `apply=false` run printed `entries=0`, which read as "matched
nothing". It had in fact walked its whole queue. `universe_entries_done` was
wired to `written` (control docs upserted), which report mode leaves at 0 **by
design**. It now publishes `inspected` in report mode and `written` in APPLY.
Verified live: a `LIMIT=4` report walked 4 entries, printed each plan and live
catalog count, wrote nothing, and published `universe_entries_done=4`.

### 5. Ordering: a canary should hit the cards that sell

The queue was manifest order — year, then name — so `LIMIT=20` spent all twenty
entries in 1990 beginning with an oddball that has no autographs *by era*.

The driver now orders the eligible queue by value:

- **An explicit list wins.** The **existing** `titles` input (exported as
  `BCP_TITLES` — no new `workflow_dispatch` input; the file is at 24/25) names
  the pages, in order. Entries match on wiki page title, set name, `"<year>
  <name>"`, or sourceRef. **Unmatched titles are reported**, never silently
  ignored.
- **Otherwise, an intrinsic proxy at zero RU.** Product family + era + a
  flagship boost, from fields already in the manifest. A real ranking (pool rows
  per `(year, setKey)`) would need a cross-partition aggregate over 16M
  `sold_comps` rows before the driver acquires anything — which is exactly why
  the explicit list exists.

The flagship boost is load-bearing: family alone ranked *"2020 Topps Chrome Ben
Baller Edition"* and *"Bowman Chrome Mini"* above 2011 Topps Chrome itself. The
flagship carries the pool (memory: *product-family ladder*).

Measured on the real 2,637-entry queue, the proxy's top 20 is now `2010–2026
Topps Chrome` (2011 at **#2**), with `2010–2026 Bowman Chrome` at ranks 22–38.

## The corrected dispatch

**Step 1 — report.** Confirm the queue and read back the order. `YEARS` is a
**comma list**, not a range (memory: *scope formats are per-script*); the failed
run's `1990..2026` is not a form this script parses.

```
gh workflow run backfill-runner.yml -f script=ingest-universe-driver \
  -f sources=bcp -f scope=recheck -f apply=false -f limit=20 \
  -f years=1990,1991,...,2026
```

Read the banner: it prints `order`, the eligible count, and the first five
entries it will take. Confirm `universe_entries_done` matches what it inspected.

**Step 2 — the canary, ordered explicitly.** `titles` is the ordering input.

```
gh workflow run backfill-runner.yml -f script=ingest-universe-driver \
  -f sources=bcp -f scope=recheck -f apply=true -f limit=20 \
  -f years=1990,1991,...,2026 \
  -f titles="2011 Topps Chrome,2015 Bowman Chrome,2019 Topps Chrome,2021 Topps Chrome"
```

Named entries lead in the order given; the value proxy orders the rest, so a
`limit` larger than the list still runs a full canary. Omit `titles` entirely to
take the proxy's own top 20 (2010–2026 Topps Chrome).

**Step 3 — the lane, in budgeted shards.** Unchanged from above, and now the
self-relaunch actually resumes: the control docs it gates on can finally be
written.

Verify the canary by a Cosmos **count**, never a green run:

```
SELECT VALUE COUNT(1) FROM c WHERE c.year = 2011 AND c.setKey = 'topps-chrome' AND c.isAuto = true
```

Measured 2026-09-04, pre-canary: **1** auto row against 5,762 total for 2011
`topps-chrome`. (#1700 reported all 5,762 as `isAuto=false`; the single row is a
later arrival, and it is not the #173 Freeman auto the re-scrape exists for.) A
canary that leaves this count at 1 has not worked, whatever the run says.
