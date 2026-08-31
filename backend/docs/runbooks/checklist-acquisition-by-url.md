# Acquiring one release by URL (Hobby Monitor direct lane)

The ranked lane in `Checklist Acquisition` finds work from
`checklist-gap-report`, then asks `hmSlugFor()` to match each gap onto a slug
in Hobby Monitor's `--list` index. That resolver cannot reach every page:

* the index is thin — `2026-bowman-baseball-checklist` is **not in it at all**;
* and matching is a refusal on ambiguity, by design — brand `bowman` + 2026 +
  baseball matches two OTHER slugs (`2026-bowman-chrome-mega-box-baseball-checklist`,
  `2026-bowman-chrome-baseball`), so it returns null before the missing slug is
  even noticed.

Both behaviours are correct for a ranked crawl (a loose match ingests a
DIFFERENT product's checklist under our setKey). They just leave no way to say
"this exact page, please". The direct lane is that way.

## Dispatch

```
gh workflow run "Checklist Acquisition" \
  -f release_url=https://www.hobbymonitor.com/release/2026-bowman-baseball-checklist \
  -f set_key=bowman \
  -f set_name="2026 Bowman" \
  -f year=2026 \
  -f sport=baseball \
  -f apply=true
```

`release_url` selects the lane. When it is set the ranked steps are skipped
entirely; when it is empty (every cron run) nothing changes.

Watch it: `gh run watch $(gh run list --workflow "Checklist Acquisition" --limit 1 --json databaseId -q '.[0].databaseId')`

## set_key is the load-bearing input

It must be the key the catalog **already uses**, not a prettified page title.
For 2026 Bowman that is `bowman` — every checklist-backed row in all three id
stems (`bowman:` 50,308, `bowman-paper:` 16,805, `bowman-chrome:` 66,103)
carries `setKey: "bowman"`, and the stem is produced by the slug derivation
downstream, not by the manifest. Passing `bowman-paper` or `Bowman` mints a
second, parallel product beside 133,216 existing rows.

The lane refuses a `set_key` that is not a lowercase slug, a non-numeric
`year`, a `release_url` off hobbymonitor.com, and a parse that yields fewer
than 5 rows — all before anything is written.

## Dry run first

`-f apply=false` runs the fetch and the ingest's DRY-RUN, which prints the
proposed rows grouped by parallel. Read that grouping before applying: a rung
filed under the wrong name is obvious there and nowhere else.

## What the fetcher emits

One row per card, plus that card's own subset ladder (CF-HM-LADDER-INTO-ROWS).
2026 Bowman: 1,165 cards -> 16,885 rows, 13,985 of them carrying a print run.
The manifest sets `parallelColumnAuthoritative: true`, so the ingest reads the
rung out of the parallel column instead of re-deriving one from the category
slug.

Check these counters in the log:

```
ladder groups=18 entries=218 -> real rungs=165  DROPPED player-names=53 ...
rows=16885 (base 1165 + ladder 15720)  with printRun=13985
```

`DROPPED player-names` is not noise — it is the guard working. Hobby Monitor
misfiles player names into the `parallels[]` of hit subsets (53 of 2026
Bowman's 218 entries), and minting those would put "Ethan Holliday" in the
parallel column. If that number is ever 0 on a release with autograph subsets,
check the filter before trusting the run.

A `!! REFUSED subset` line means a subset's ladder exceeded PAR_MAX rungs or
its card list exceeded NUM_MAX numbers — the roster-read-as-a-ladder shape.
Only that subset is dropped; the rest of the product still ingests.
