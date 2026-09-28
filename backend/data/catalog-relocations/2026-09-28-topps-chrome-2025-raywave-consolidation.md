# 2025 Topps Chrome baseball — RayWave consolidation (09-28)

Drew's ruling (09-28 12:30Z): canonical rung names for 2025 Topps Chrome
(setKey `topps-chrome`, baseball) are **"RayWave Refractor"** (base) and
**"\<Color\> RayWave Refractor"** (compound RayWave, capital W) for Purple
/250, Aqua /199, Blue /150, Green /99, Gold /50, Orange /25, Black /10, Red
/5. Print runs verified against `backend/data/checklists/hand-fetched/
parallels-2025-topps-chrome-baseball.json` (source: baseballcardpedia,
citing Topps' own printed checklist) — base RayWave Refractor /7800; every
colour rung matches the ruling's stated print run exactly.

Ruling text stamped on every entry: *"Drew 09-28: 'RayWave' compound is
canonical (Topps' sheet, variationVocabulary FINISH_SPELLING, sale
titles)."*

## Method

Read-only census of every `hiq:baseball:2025:topps-chrome:*` card_catalog
row whose `parallel` matches `/ray\s*wave/i` (id-prefix query, paginated
`{maxItemCount:500, maxDegreeOfParallelism:-1}`, drained via
`hasMoreResults()`, None-pk aware). Sales checked with the dual method
(`scripts/lib/sales-at-id.cjs` semantics): a batched cross-partition
`IN`-query (chunks of 50 ids) unioned with a per-id partition-scoped query,
both drained, run against every non-keeper row and every reslug destination.

## Top-line counts

| | count |
|---|---|
| Total rows under `hiq:baseball:2025:topps-chrome:*` | 122,781 |
| RayWave-family rows (`/ray\s*wave/i` on `parallel`) | 20,847 |
| Distinct spellings | 35 |
| `needsRuling` — parallel embeds "1 Per Value Blaster Box…" (non-rung token) | 1,059 |
| Pure-numeric cardNumber rows (genuine 2025 Topps Chrome base set, 1–473) | 9,773 |
| — of which graded children (`:psa-10`, `:raw`, etc.) | 1,366 |
| — of which parent rows | 8,407 |
| Non-numeric cardNumber rows (insert/autograph prefixes, cross-setKey contamination — see below) | 10,015 |

Parent groups (cardNumber, isAuto, colour) within the pure-numeric population: **2,915**.

| Group outcome | groups |
|---|---|
| Already sitting at the canonical address (checklist-grade) | 2,400 |
| Reslugged onto the canonical address (no row there yet) | 300 |
| Held as `needsRuling` (no checklist-grade evidence for this group) | 215 |

## The three lists

1. **`2026-09-28-topps-chrome-2025-raywave-reslug.json`** (lane `relocate-catalog-rows-by-list`, action `reslug`) — 300 entries. For every group with no row at the canonical address, moves the best checklist-grade row (parallel text exactly equal to the canonical spelling preferred first, then a printRun match) onto it, carrying the canonical human-form `parallel` text. All 300 keeper rows resolved to source `baseballcardpedia-ladders-2026-08-29`.
2. **`2026-09-28-topps-chrome-2025-raywave-to-canonical.json`** (lane `repoint-sales-by-list`) — 989 entries, 1,888 sales. Moves every sale sitting on a non-canonical spelling row onto its canonical twin, same cardNumber/colour/rung (no `allowCrossProduct` needed).
3. **`2026-09-28-topps-chrome-2025-raywave-retire.json`** (lane `relocate-catalog-rows-by-list`, action `retire`, every entry `requireTwinId`-gated) — 5,492 entries (989 with sales at census time, repointed first; 4,503 already at zero).

Counts per rung colour (non-keeper rows retired, and how many needed a sales repoint first):

| Rung | Non-keeper rows | Rows with ≥1 sale | Sales moved |
|---|---|---|---|
| Base (RayWave Refractor) | 686 | 7 | 33 |
| Purple /250 | 600 | 154 | 296 |
| Aqua /199 | 600 | 164 | 317 |
| Blue /150 | 600 | 177 | 421 |
| Green /99 | 602 | 164 | 309 |
| Gold /50 | 600 | 138 | 236 |
| Orange /25 | 602 | 101 | 153 |
| Black /10 | 600 | 46 | 55 |
| Red /5 | 602 | 38 | 68 |
| **Total** | **5,492** | **989** | **1,888** |

## `needsRuling` — not touched by this fold

**215 groups (2,915 − 2,400 − 300), all rooted in the same defect**: a
`catalog-explode-actuals-2026-08-12` DERIVED row sitting at (or squatting on)
an otherwise-legitimate 2025 Topps Chrome baseball card number, but naming an
**NFL player** — Tom Brady, Peyton Manning, Randy Moss, Walter Payton,
Tetairoa McMillan, Jaxson Dart, Cam Skattebo, and others sampled. This is
**cross-sport contamination** (a football RayWave-family row minted into the
baseball partition), not a spelling dispute, and there is no checklist-grade
row anywhere in these 215 groups to adjudicate identity against — per
one-card-one-row-one-pool doctrine, no keeper is manufactured. Split:

- 189 groups: no checklist-grade row anywhere in the group.
- 26 groups: the canonical id string already holds a row, but its source is
  `catalog-explode-actuals-2026-08-12` (DERIVED, confirmed via the real
  `catalogAuthorityOf`) or (1 case) `ingest-auto-seed` — never checklist.

**1,059 rows** carry the parallel text `"Ray Wave Refractor 1 Per Value
Blaster Box 2 Per Mega Box Retail Exclusive"` — a non-rung token (retail-SKU
distribution note) embedded in the parallel field, per the task's own
`needsRuling` rule. Held out, not touched.

**10,015 rows carry a non-numeric cardNumber** (`AC-`, `CRDA-`, `CHRU-`,
`CLA-`, `NT-`, `USC`, `90CB-`, `90CU-`, `F15-`, `1975-`, `C90A-`, `U90C-`,
and nine each of bare colour-word cardNumbers such as `"ORANGE"`,
`"GEOMETRIC"`, `"RAYWAVE"` — clearly a parsed-out finish name landing in the
wrong field). The `AC-`/`CRDA-`/`CHRU-`/`CLA-`/`NT-`/`USC` prefixes are a
**documented, already-flagged** wrong-key defect: `backend/data/checklists/
scraped/acq-2026-09-21-checklistinsider-topps-chrome-2025-inserts/
2025-topps-chrome-inserts.manifest.json`'s own `mintedBy` note states these
insert/autograph sets are minted at `setKey topps-chrome-update-series` and
that their appearance under bare `topps-chrome` is a flagged, out-of-scope
defect — not this ruling's fold. The `90CB-`/`F15-`/`1975-` families and the
bare colour-word cardNumbers are a separate, unexplained contamination this
task did not investigate further (no checklist source, no ruling). None of
the 10,015 rows are touched by any of the three lists.

## Why the id already folds every spelling to one segment

`computeHobbyIqCardId`'s `normalizeParallel` already collapses "RayWave",
"Ray Wave" and "Raywave" (with or without "Refractor") to the identical
`ray-wave-refractor`-family id segment regardless of input spelling — the
same fact the 2026-09-27 `topps-chrome-update-series` USC census (PR #2454)
already used. This ruling is about the **human-form `parallel` field text**
Drew wants stored on the canonical row ("RayWave Refractor", compound), not
about the id grammar, which was already correct.

## Verification run

- `classifyEntry` (the real function from each lane's own script) accepts
  every entry in all three files, 0 refusals.
- `computeHobbyIqCardId` reproduces every reslug's `to` from its own `id`
  plus the entry's stated `parallel` text, 0 mismatches.
- 0 duplicate ids within or across the three files.
- 0 overlap between reslug sources and retire targets.
- Every `repoint.fromId` appears in the retire list; every `repoint.toId`
  equals the matching retire entry's `requireTwinId`.
- Every keeper row (reslugged or already-canonical) is checklist-grade by
  the real `catalogAuthorityOf`, 0 exceptions.
