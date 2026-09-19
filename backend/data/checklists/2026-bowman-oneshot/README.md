# 2026-bowman-oneshot — a single-package scope directory

**This directory is disposable. It exists only to scope one ingest, and may be
deleted once that APPLY has landed.**

## Why it exists

2026-09-19 diagnosis (bounded, read-only Cosmos point-reads + equality-filter
queries against 25 not-backed sale ids sampled from the sales-volume ranking)
found that `backend/data/checklists/scraped/2026-bowman-full.csv` (1,211
rows, staged 2026-08-13, migrated 2026-08-25) contains the exact card numbers
the ranking flagged as missing (`BCP-58`, `BP-41`, etc.) as real text rows —
but **card_catalog has zero rows for those numbers under `bowman` or any
sibling key**, and zero rows anywhere carry a source tag tracing to this
file's own scrape/migration dates under `setKey=bowman` (the one
`beckett-scraped-2026-08-13` row found in the bounded sample belongs to a
DIFFERENT sibling product, `bowman-chrome-mega-box`, not this file). 22 of 25
(88%) of the sampled not-backed sales classified NEVER_INGESTED this way.
**The checklist was staged; it was never actually run through the ingest
lane.**

`ingest-checklist-csv-to-catalog.cjs` takes a whole **directory**, not a file
list (`fs.readdirSync(DIR)` plus shard maths, no per-file filter). The shared
`backend/data/checklists/scraped/` directory holds hundreds of other staged
files, so pointing an ingest `scope` at it to land this ONE file would sweep
every other file in it too — the same re-upsert/lastSeenAt/ETag churn risk
already written up for the 2026-09-14 Bush/Mantle incident and the
`tcgdex-ja-sv10` precedent (PR #2263) below.

## Why a copy and not a move

The original stays in `scraped/2026-bowman-full.csv` unchanged — other
tooling and manifests may already reference that path. This directory started
as a byte-identical copy of it (original sha256
`6506fe2fff169810c28b20cd54f6f8d9caa6ba8dd9bbb4cb737b576e45a8fbc4`) so an
ingest scoped here touches only this one product.

**Not byte-identical after trimming.** `planStagedDirectory` refused the raw
copy (reason=id-collisions) on 24 rows all sharing card number `UAC-1` — the
"2026 Bowman Ultimate Autograph Booklet", the exact 24-signer trap the task
brief named (24 different prospects, one number, not a multi-player card).
Those 24 rows are left out here; see the manifest's `trimmedFromOriginal` for
the full player list. This package's own sha256 is
`ee8651d070253ccf1dbc110748c9e73b9b95825c621d3c01ece8046b1b5d857e`.

## How it is dispatched

```
script  ingest-checklist-csv-to-catalog
scope   backend/data/checklists/2026-bowman-oneshot
sources beckett-scraped-2026-08-13
gate    BACKFILL_APPLY=true   (omit for REPORT)
```

`planStagedDirectory` (offline) verdict for this directory: see the PR
description for this package's run output.

## One number NOT covered by this file

Sample id `hiq:baseball:2026:bowman:0725:base:auto` (cardNumber `0725`) did
not match this CSV in any form (plain, upper, folded, hyphenated) either —
likely a redemption/one-off numbering outside the normal ladder. Not part of
the never-ingested majority this package addresses; flagged separately, no
action taken here.

## Deleting it

After the APPLY lands and a spot-check confirms `BCP-58` / `BP-41`-style rows
now resolve under `card_catalog` at `source=beckett-scraped-2026-08-13`,
delete this directory.
