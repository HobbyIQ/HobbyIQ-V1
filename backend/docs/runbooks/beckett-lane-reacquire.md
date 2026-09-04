# Beckett lane re-acquire — report-first plan

**Status: REPORT ONLY. Nothing dispatched. Nothing written.**
Produced 2026-09-04 alongside the converter fix in
`backend/scripts/convertBeckettChecklistXlsx.cjs`.

The fix does not change what the Beckett lane *fetches*. It changes what the
converter *reads out of workbooks already fetched*. So realising it needs a
re-acquire of the lane's own manifest entries — the pages have not moved.

---

## 1. Which manifest entries carry the newly-read sections

Bounded probe, 60 of the 455 `lane: "beckett"` entries in
`backend/data/ingest-universe.json`, spread deterministically across the lane
(every *n*th entry, not the first 60, so one publisher's era cannot dominate).
Each workbook was fetched once, politely (real UA, serial, 1.4 s between
requests) and analysed against the pre-fix predicates *verbatim*, so "new" means
new rather than merely present.

| | probed (60) | extrapolated (455) |
|---|---:|---:|
| entries the fix changes | **55 (92%)** | **~417** |
| superset card lines removed | 19,364 | ~146,844 |
| signed cards recovered (isAuto false→true) | 745 | ~5,650 |
| sections rescued from a count-line name | 907 | ~6,878 |
| bare `Parallels` headers now opening a ladder | 79 | ~599 |
| ladder rungs recovered | 1,533 | ~11,625 |
| …of those **carrying a print run** | 1,239 | ~9,396 |

Raw per-entry results: `reacquire-probe.json` (not committed — regenerate with
the probe described in the PR).

Highest-impact entries in the probe:

| entry | superset lines removed | signed recovered | rungs recovered | count-line sections |
|---|---:|---:|---:|---:|
| 2025 Panini Prospect Edition | 13,353 | 0 | 69 | 0 |
| 2025 Panini Impeccable | 2,971 | 0 | 42 | 0 |
| 2025 Topps Sterling | 1,151 | **675** | 29 | 0 |
| 2026 Leaf Metal Draft | 1,021 | 23 | 0 | 0 |
| 2022 Panini National Treasures | 0 | 0 | **157** | 51 |
| 2021 Panini Contenders | 0 | 0 | 152 | 32 |
| 2021 Panini Flawless | 0 | 0 | 106 | **89** |

Two shapes of harm, and they sit in different eras. Modern Leaf/Panini
releases carry the **superset matrix sheets** and the **signed-sheet
misfiling**; 2020-2022 Panini carries the **count-line and ladder** damage.
A re-acquire scoped to one era therefore fixes only half the lane.

## 2. Pool rows this unblocks

`sold_comps`, read-only, keyed on `normalizedSetKey` + `cardYear` (there is no
top-level `setKey` field on a comp row — the first sizing pass queried one and
read zero everywhere, which is worth saying because the zero looked like a real
answer).

Six (setKey, year) pairs sized, four of which have a pool at all:

| setKey / year | pool rows | flagged isAuto | auto-titled | auto-titled NOT flagged | serial in title |
|---|---:|---:|---:|---:|---:|
| panini-prospect-edition 2025 | 3,136 | 1,241 | 1,454 | **213** | 1,229 |
| bowman-chrome-sapphire 2025 | 4,850 | 345 | 254 | 0 | 1,026 |
| panini-impeccable 2025 | 430 | 21 | 23 | 2 | 378 |
| topps-sterling 2025 | 3 | 1 | 3 | 2 | 3 |
| **total** | **8,419** | 1,608 | 1,734 | **217** | **2,636** |

Extrapolating the observed pool hit-rate (4 of 6 pairs) and per-entry averages
across the ~417 changed entries:

- **~585,000** pool rows sit behind entries this fix changes
- **~183,000** of those carry a `/` in the title — rows a recovered print-run
  rung can now key. This is the largest number in the plan and it is the one
  that matters: 9,396 recovered rungs carry a print run, and printRun is the one
  field a sale title can never reconstruct.
- **~15,000** auto-titled rows are not flagged `isAuto` — the orphan signal the
  487 wrongly-unsigned checklist cards feed.

These are **sizings, not promises.** A recovered rung unblocks a pool row only
where the matcher can join it; the honest number to hold this work to is the
on-page count (1,594 rungs, 487 signed cards, 907 sections) and the *measured
diff* after a re-acquire, not this extrapolation.

## 3. The dispatch — NOT RUN

The lane runs through `backfill-runner.yml`, script
`ingest-checklists-end-to-end`. Report-first, so the first dispatch must be
`apply=false`:

```
# STEP 1 — report only. Confirms the diff before anything writes.
gh workflow run backfill-runner.yml --ref main \
  -f script=ingest-checklists-end-to-end \
  -f apply=false \
  -f phases=beckett \
  -f mode=force-acquire
```

`mode=force-acquire` is load-bearing: the runner caches `WORKDIR` across
relaunches, and this change re-reads workbooks that are **already staged**. A
run without it re-ingests the pre-fix CSVs and measures nothing.

Read the run's own banner before believing the scope — per
`feedback_scope_formats_are_per_script`, a scope that does not bind reads as
ALL. Confirm the log says `PHASES=beckett` and `FORCE_ACQUIRE=true`.

```
# STEP 2 — only after a human reads step 1's diff and says go.
gh workflow run backfill-runner.yml --ref main \
  -f script=ingest-checklists-end-to-end \
  -f apply=true \
  -f phases=beckett \
  -f mode=force-acquire
```

Sharding, if step 1 shows the lane will not finish inside `RUN_MINUTES`: pass
`-f slot=<i> -f slots=<n>` **explicitly** on every shard. Measure rows/s from
step 1's own output before choosing `n` — a shard axis that is not guaranteed
and measured is how a fleet run produces a slice that looks like a sibling
counter.

**Not part of this plan:** any Cosmos control-plane change, any RU scaling, any
dispatch of another lane. The bcp lane is being taught its Autographs sections
by a concurrent round; the two do not touch the same file.

## 4. What this plan deliberately does not claim

- It does not claim the relic residual the census measured is closed. Relics
  ride as `insert-<subset>`; that was already right. What changed is that the
  subset now has its real name instead of `insert-15-cards`.
- It does not claim every recovered rung is a card someone sells.
- The insert-folds-onto-base behaviour in `classifySections` (2026 Donruss
  Elite files Kaboom! as a base parallel because its numbers 1-10 are a subset
  of base 1-100) is **pre-existing and untouched here**. It is visible in the
  fixtures and deserves its own ticket; changing the classifier would move every
  lane that shares it, which is not this change.
