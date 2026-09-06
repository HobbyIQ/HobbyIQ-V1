# The publication year is not the product year

**2026-09-06 — report-only. No catalog row was written.**

A hobbymonitor release URL can end in the year the *page* was published rather
than the year the *product* was issued:

```
/release/2024-topps-finest-football2025     ->  setName "2024 Topps Finest Football"
/release/2024-panini-select-baseball-2025   ->  setName "2024 Panini Select Baseball"
```

The enumeration that mints `backend/data/ingest-universe.json` read that
trailing number as the product `year`, and `fetchHobbyMonitorChecklist.cjs`
writes both `--year` and `--set-name` into one manifest — so every catalog row
those entries minted inherited a `year` that contradicts its own `setName`.

This PR fixes the **source**. It writes no catalog row, and the census below
says why a relocation lane is the wrong instrument for the stored rows.

---

## 1. What was fixed

`productYearsOf(setName)` (new, `backend/scripts/lib/product-year-from-set-name.cjs`)
states which years a set name legitimately admits, and the universe builder
corrects a queued year that is not one of them.

**21 queue entries corrected** — 20 hobbymonitor + 1 clc. Every entry is kept:
a correction is never a drop, because the entry is real and wanted and only its
year was wrong.

### The 17 that were NOT corrected, and why that is the load-bearing half

Of the 38 entries whose `year` disagrees with their setName's leading year,
**17 are split-season labels** — `2024/25 Panini Select Basketball` queued as
2025. Per #1852 (CF-A-SPLIT-YEAR-IS-STILL-A-YEAR) the second season year is a
season year *of that label*, and #1912 measured the corpus convention:

| where split-season rows sit | rows |
| --- | ---: |
| second season year (`2024/25` -> 2025) | 75,896 |
| first season year (`2024/25` -> 2024) | 0 |

Consistency — not which end is chosen — is what keeps a product's cards in one
pool. "Correcting" those 17 to the leading year would have moved them off the
year the entire rest of the corpus uses and **manufactured** the pool split the
rule exists to prevent. They are pinned by name as negatives in
`backend/tests/productYearFromSetName.test.ts`.

The remaining case is a different defect again: the clc entry's URL names *two*
seasons (`/2021-22-2022-23-upper-deck-clear-cut-hockey-card-checklist/`) and the
year was taken from the first pair while the setName came from the second.

---

## 2. Why no relocation list is shipped

The task this work came from assumed the ~69,325 affected `card_catalog` rows
sit on **wrong-year slugs** that a relocation lane should retire or reslug.
Measured read-only, they do not.

### The full-corpus census (44 products, read-only)

One cross-partition sweep of `card_catalog`, server-side narrowed to rows
whose setName leads with a year that differs from the row's own `year`:

| | rows |
| --- | ---: |
| hits (setName year != row year) | 143,625 |
| slug year segment == the row's own `year` | **143,069** |
| slug year segment == the setName's year | **0** |
| slug year segment == neither (truncated / malformed) | 556 |

By source:

| source | rows |
| --- | ---: |
| `hobbymonitor-2026-09-04` | 142,849 |
| `cardsight` | 556 |
| `cardhedge` | 200 |
| `ingest-auto-seed-graded` | 9 |
| `sales-attested-unnumbered` | 9 |
| `cardhedge-graded` | 1 |
| `ingest-auto-seed` | 1 |

### Per product: the three counts the relocation plan asked for are all zero

For all 28 hobbymonitor-only products, `slug year == row year` holds for
**every single row** (142,849 of 142,849). A relocation lane moves a row from a
wrong address to a right one; here there is no wrong address, so RETIRE,
RESLUG and COLLISION are each zero for every product:

| product | rows | setName year | row year | slug == row year | retire | reslug | collision |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `basketball/panini-donruss-optic` | 24,384 | 2024 | 2025 | 24,384 | 0 | 0 | 0 |
| `football/topps-chrome` | 14,035 | 2024 | 2025 | 14,035 | 0 | 0 | 0 |
| `basketball/panini-select` | 13,470 | 2024 | 2025 | 13,470 | 0 | 0 | 0 |
| `football/panini-phoenix` | 10,884 | 2024 | 2025 | 10,884 | 0 | 0 | 0 |
| `football/panini-select` | 8,890 | 2024 | 2025 | 8,890 | 0 | 0 | 0 |
| `football/topps-resurgence` | 8,115 | 2024 | 2025 | 8,115 | 0 | 0 | 0 |
| `basketball/topps-royalty` | 7,491 | 2023 | 2025 | 7,491 | 0 | 0 | 0 |
| `football/topps-finest` | 7,476 | 2024 | 2025 | 7,476 | 0 | 0 | 0 |
| `basketball/topps-cosmic-chrome` | 7,133 | 2025 | 2026 | 7,133 | 0 | 0 | 0 |
| `basketball/panini-revolution` | 5,999 | 2024 | 2025 | 5,999 | 0 | 0 | 0 |
| `basketball/topps-finest` | 4,648 | 2024 | 2025 | 4,648 | 0 | 0 | 0 |
| `basketball/panini-noir` | 3,103 | 2024 | 2025 | 3,103 | 0 | 0 | 0 |
| `basketball/panini-immaculate` | 3,053 | 2023, 2024 | 2025 | 3,053 | 0 | 0 | 0 |
| `football/panini-contenders` | 3,006 | 2024 | 2025 | 3,006 | 0 | 0 | 0 |
| `basketball/panini-silhouette` | 2,804 | 2024 | 2025 | 2,804 | 0 | 0 | 0 |
| `basketball/topps-inception` | 2,707 | 2024 | 2025 | 2,707 | 0 | 0 | 0 |
| `basketball/topps-three` | 2,479 | 2023 | 2025 | 2,479 | 0 | 0 | 0 |
| `basketball/panini-haunted-hoops` | 2,100 | 2024 | 2025 | 2,100 | 0 | 0 | 0 |
| `basketball/panini-one-one` | 2,050 | 2024 | 2025 | 2,050 | 0 | 0 | 0 |
| `basketball/panini-prizm-black` | 1,747 | 2024 | 2025 | 1,747 | 0 | 0 | 0 |
| `basketball/panini-origins` | 1,626 | 2024 | 2025 | 1,626 | 0 | 0 | 0 |
| `basketball/panini-flawless` | 1,584 | 2023 | 2025 | 1,584 | 0 | 0 | 0 |
| `basketball/panini-national-treasures` | 1,123 | 2024 | 2025 | 1,123 | 0 | 0 | 0 |
| `football/panini-impeccable` | 984 | 2024 | 2025 | 984 | 0 | 0 | 0 |
| `football/panini-clearly-donruss` | 870 | 2024 | 2025 | 870 | 0 | 0 | 0 |
| `football/panini-immaculate` | 489 | 2024 | 2025 | 489 | 0 | 0 | 0 |
| `basketball/panini-eminence` | 301 | 2024 | 2025 | 301 | 0 | 0 | 0 |
| `basketball/topps-chrome` | 298 | 2024 | 2025 | 298 | 0 | 0 | 0 |
| **28 products** | **142,849** | | | **142,849** | **0** | **0** | **0** |

The 16 remaining products (776 rows) are other sources and a different defect:
19 rows carry a TRUNCATED year segment (`198`, `197`, `202`) — those are the
only genuinely wrong slugs in the class, and #1912 already lists all 17 that are
safely movable, excluding the one different-player collision it found.

### The slug is not wrong — the sample that led to the sweep

Over a 4,000-row sample of `source = hobbymonitor-2026-09-04`, of the rows whose
setName year disagrees with their year field:

| where the slug's year segment points | rows |
| --- | ---: |
| equals the row's own `year` field | 266 |
| equals the setName's leading year | 0 |
| equals neither | 0 |

This reproduces #1912's ruling over the full corpus (144,822 of 144,822). The
row, its slug, and its pool address all agree with each other. **Only the label
disagrees.** There is no split pool to merge, so there is nothing for a
relocation lane to move.

### And the routing rule in the task would have been wrong in both directions

Point-reading 150 destinations at the setName year:

| destination at the setName year | count |
| --- | ---: |
| vacant (no twin) | 36 |
| twin holding the SAME player | 77 |
| twin holding a DIFFERENT player | 11 |
| one side unnamed (not adjudicable) | 26 |

Two findings make a blanket routing rule unsafe:

**A different-player destination is usually a real card, not a collision to
route around.** `hiq:football:2025:panini-select:17:...` is Cedric Tillman;
`hiq:football:2024:panini-select:17:...` is Brian Thomas Jr. 2024 Panini Select
#17 genuinely *is* Brian Thomas Jr. Neither row is defective as an address.

**A same-player twin is not automatically a retire.** Of 80 same-player pairs
point-read, **54 destinations carry the same disagreement themselves** — both
rows came from the same defective ingest, so neither is a checklist-authority
anchor to fold onto. Only 26 had a destination whose own setName agrees with its
own year. Retiring the hobbymonitor row is a **hard delete** in this lane
(`retire = delete`, and `retireCatalogRow` re-points nothing), so a "same player
-> RETIRE" rule would delete real ladder rows and hand their sales to the
rematch on the strength of a player-name match against a row that is equally
mislabelled.

### The pool

Sales on these slugs, measured both ways over 60 slugs:

| key | sales |
| --- | ---: |
| `hobbyiqCardId` | 239 |
| `cardId` | 76 |
| slugs carrying > 0 sales | 20 of 60 |

These sales are **correctly placed**: they sit on an address where the slug, the
`year` field and the pool all agree. They are not on a wrong-year slug, so there
is no pool relocation to make. No pool list is shipped, and that is a
measurement rather than an omission.

---

## 3. What the stored rows still need

The stored-row repair remains open and is **not** a relocation. Per #1912's
deferred plan the candidate write is `patchCatalogRowFields` on `setName` only —
the label is what disagrees, and keeping the year, slug and pool address fixed
holds the repair off the identity axis entirely.

That still needs a ruling before anything is written, because the evidence
above shows the two sides are not symmetric: for these 44 products the checklist
corpus says the setName is right and the year is wrong (topps-finest/football:
40,092 checklist rows at 2024 against 13,655 hobbymonitor rows at 2025), which
argues the opposite repair — moving the row — and that one is per-card, needs a
checklist-verified destination each, and has a measured 21% different-player
rate at the naive destination.

Fixing the 38 queue entries stops the next ingest minting more. It moves no
stored row, and this PR claims nothing else.

---

## 4. Lane report run

Because this PR ships no new list, the lane was exercised report-only
(`apply=false`) against the largest committed list to confirm it is healthy —
run [34065241329](https://github.com/HobbyIQ/HobbyIQ-V1/actions/runs/34065241329),
`scope=data/catalog-relocations/2026-09-06-bbp-preview-basketball.json`:

```
REPORT ONLY — nothing written
  entries in scope        60
  RETIRED (deleted)       0
  RESLUGGED (moved)       60
  refused — occupied      0
  already gone            0
  not found               0
  failed                  0
  sales made UNPLACED     0
  sales re-pointed        0
  graded children retired 0
  reconciled: intended 60 = written 60 + skipped 0 + refused 0 + failed 0
```

`failed 0`, `refused — occupied 0`, and the reconciliation balances.
