# 2026-topps-chrome-oneshot — a single-package scope directory

**This directory is disposable. It exists only to scope one ingest, and may be
deleted once that APPLY has landed.**

## Why it exists

2026-09-19 diagnosis (bounded, read-only Cosmos point-reads + equality-filter
queries against 25 not-backed sale ids sampled from the sales-volume ranking)
found that `backend/data/checklists/scraped/2026-topps-chrome-baseball.csv`
(1,570 rows, 52 sections, staged 2026-09-01) contains the exact card numbers
the ranking flagged as missing (`RA-CDE`, `RA-STU`, `BCP-58`-style prefixes,
etc.) as real text rows — but **card_catalog has zero rows for those numbers
under any key**, and zero rows anywhere carry a source tag tracing to this
file's own scrape date. 17 of 25 (68%) of the sampled not-backed sales
classified NEVER_INGESTED this way. **The checklist was staged; it was never
actually run through the ingest lane.**

`ingest-checklist-csv-to-catalog.cjs` takes a whole **directory**, not a file
list (`fs.readdirSync(DIR)` plus shard maths, no per-file filter). The shared
`backend/data/checklists/scraped/` directory holds hundreds of other staged
files, so pointing an ingest `scope` at it to land this ONE file would sweep
every other file in it too — the same re-upsert/lastSeenAt/ETag churn risk
already written up for the 2026-09-14 Bush/Mantle incident and the
`tcgdex-ja-sv10` precedent (PR #2263) below.

## Why a copy and not a move

The original stays in `scraped/2026-topps-chrome-baseball.csv` unchanged —
other tooling and manifests may already reference that path. This directory
started as a byte-identical copy of it (original sha256
`8620899792bb065ec3c8c10ad7e95e56da52fdbbe55fd46ef39c79ad0cfc85d8`) so an
ingest scoped here touches only this one product.

**Not byte-identical after trimming.** `planStagedDirectory` refused the raw
copy (reason=unregistered-set-keys, 3 id collisions) on 8 rows across two
Cooperstown Calls subsets (2025's induction class vs 2026's) that share the
same `CC-N` numbering but name different players per class — an R67
different-players-same-number collision, the same trap class as the known
Bowman UAC-1/CPA- traps. Those 8 rows are left out here; see the manifest's
`trimmedFromOriginal` for the full accounting. This package's own sha256 is
`a2fcf25cc67acb61561b2511cd3e3788f57433462e5e1c47be9bd760fa0f6062`.

## How it is dispatched

```
script  ingest-checklist-csv-to-catalog
scope   backend/data/checklists/2026-topps-chrome-oneshot
sources beckett-scraped-2026-09-01
gate    BACKFILL_APPLY=true   (omit for REPORT)
```

`planStagedDirectory` (offline) verdict for this directory: see the PR
description for this package's run output.

## Deleting it

After the APPLY lands and a spot-check confirms `RA-CDE` / `RA-STU` /
`BCP-58`-style rows now resolve under `card_catalog` at
`source=beckett-scraped-2026-09-01`, delete this directory.
