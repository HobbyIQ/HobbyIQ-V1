# Nightly gap digest — measure, persist, triage

CF-GAP-DIGEST-TRIAGE (Drew, 2026-08-31 — approved the nightly measure +
classify).

The `Catalog Gap Digest` workflow now does three things each night instead of
one. Nothing it does writes to the catalog.

1. **Measure + persist.** `checklist-gap-report.cjs --persist` writes
   `backend/data/gap-reports/gap-report-YYYY-MM-DD.json` plus a
   `gap-report-latest.json` pointer (same convention as the multiplier
   artifacts) and prints the night-over-night diff.
2. **Classify.** `emailCatalogGapDigest.cjs` loads the two most recent
   persisted reports, tags every gap, and diffs them.
3. **Commit the artifact.** Without the commit every night is a baseline and
   nothing can ever read as CLOSED.

## The tags

| tag | meaning | route |
|---|---|---|
| `VOCAB-TWIN` | the checklist is already ours under another `setKey` | vocab repair — **do not fetch** |
| `UNRELEASED` | not printed yet; no publisher can have a checklist | wait |
| `IMPOSSIBLE-COMPS` | future release carrying sales — the slug is wrong, not the checklist | slug repair |
| `UNREACHABLE` | real and correctly keyed, but no wired lane covers the era/sport | none |
| `DISPATCHABLE` | real, released, correctly keyed, and a wired lane can reach it | acquire |

Order is doctrine, not convenience. `IMPOSSIBLE-COMPS` is checked before
`UNRELEASED` (same date probe, but comps contradicting the date is the more
actionable finding). `VOCAB-TWIN` is checked before `UNREACHABLE`, so an
owned checklist is never hidden behind a lane excuse.

**Only `DISPATCHABLE` may be handed to an acquisition run**, and that list is
frequently EMPTY. The headline and the subject line both say so plainly — a
subject reading "12 gaps" when all 12 are twins is how a report stops being
read.

## The twin gate

A twin candidate must clear BOTH bars before "we already own it" is allowed
to stop an acquisition:

- `_TWIN_MIN_RATIO = 3` — beat the gap's own checklist count 3x
- `_TWIN_MIN_ROWS = 25` — an absolute floor, so 0-vs-1 cannot clear the ratio

The probe counts **checklist-backed rows only**, the same source filter the
gap report uses. A vendor-row count would resurrect exactly the inflation the
report exists to defeat (`bowman-draft-chrome`: 23,899 rows, ZERO
checklist-backed).

Candidates come from the D23 product vocabulary (`productSetKeyForName` +
`spellForEra`), not a new map, so the Donruss 2009 boundary applies for free:
1998 football `panini-donruss` resolves to `donruss`, and `donruss` in 2015
resolves to `panini-donruss`.

## The lane table

`LANES` in `gapTriage.service.ts`, measured 2026-08-25:

| lane | scope |
|---|---|
| `checklistinsider` | 2022+ |
| `hobbymonitor` | 2024+, ~100 current releases, Panini-heavy |
| `baseballcardpedia` | baseball only |
| `beckett` | XLSX archive; the only vintage candidate |

`cardboardconnection` is **deliberately absent**. The domain stopped resolving
2026-08-17 and was re-confirmed dead 2026-08-22 (HTTP 000). It is still wired
as rung 1 of the acquisition ladder where it costs a timeout and fails
silently; counting it as coverage here would relabel unreachable gaps as work
and send Drew to a dead domain.

## The release-date probe is currently inert

`classifyGap` accepts a `ReleaseDateProbe`, but the digest does not yet pass
one — no wired lane exposes a release DATE. Hobby Monitor's `--list` carries a
`status` field per release, which is captured but consumed nowhere and whose
value vocabulary is unverified.

**Consequence:** `UNRELEASED` and `IMPOSSIBLE-COMPS` cannot currently fire in
production. A future-year gap falls through to `DISPATCHABLE`. That is the
honest outcome — a null date means UNKNOWN, never "released" — but it means
the two date-derived tags are dormant until a lane exposes a date. Wiring one
is a follow-up: confirm the `status` vocabulary from a live `--list`, map it
to dates, and pass `releaseDateProbe` from `emailCatalogGapDigest.cjs`. The
classifier and its tests already cover both tags.

## Running it by hand

Report + persist (read-only against the catalog):

```
node scripts/checklist-gap-report.cjs --min-comps=500 --top=60 --persist
```

Digest, rendering but sending nothing:

```
GAP_DIGEST_DRY_RUN=1 GAP_TRIAGE_HISTORY_DIR=<dir> GAP_TRIAGE_ASOF=YYYY-MM-DD \
  node scripts/emailCatalogGapDigest.cjs
```

The full-pool scan enumerates every `hiq:` slug in `sold_comps` and takes well
over ten minutes; the workflow's timeout is 20 minutes for that reason.

## Tests

- `tests/gapTriageClassifier.test.ts` — every tag, the ordering doctrine, the
  twin gates, the lane table, the honest headline
- `tests/gapHistoryDiff.test.ts` — closed / new / moved, baseline-not-NEW, and
  that a regression is never counted as progress
