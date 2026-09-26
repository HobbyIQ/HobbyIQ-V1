# 2025 Topps Baseball -- 2024 First Pitch (FP-/FP2-), 2026-09-26

Source: baseballcardpedia.com, `source=baseballcardpedia-2026-09-26` --
every staged row's text was read directly off that page (same
reconnaissance note as the CTH package in this PR: checklistinsider.com
named the insert but did not surface its roster).

## What this package covers

`FP-1` through `FP-10` (Series One, 10 cards) and `FP2-1` through `FP2-5`
(Series Two, 5 cards) -- ceremonial first-pitch celebrities/notables, 15
distinct cards. Ladder (the CTH package's own shared umbrella note): blank
base + Pink (unnumbered) + Blue /150 + Green /99 + Gold /50 + Orange /25 +
Black /10 + Red /5 + FoilFractor 1/1 (9 rungs x 15 cards = 135 rows
scraped).

## CORRECTION (PR #2433 review, 2026-09-26)

Same defect as the CTH package in this PR: the first absence pass hardcoded
`printRun: null` for every row, so every numbered rung (including
FoilFractor/1) was checked at the wrong id and 404'd unconditionally. That
pass wrongly staged all 10 `FP-` (Series One) FoilFractor rows as absent --
they are in fact checklist-present, `source=checklistinsider-2026-08-27`.
The REPORT-mode ingester banner cited as confirmation in the original PR
proves nothing (see the CTH MANIFEST.md in this PR for why).

## Absence result (corrected)

Point-read via `backend/scripts/verify-absent.cjs` (printRun read from the
CSV row, no null fallback):

- 15 blank-parallel base rows already exist at checklist authority
  (`source=baseballcardpedia-ladders-2026-08-29` for FP-,
  `checklistinsider-2026-08-27` for FP-2, `baseballcardpedia-ladders-
  2026-09-02` for FP2-). Excluded.
- **10 `FP-` FoilFractor rows already exist at checklist authority**
  (`source=checklistinsider-2026-08-27`). Excluded -- this is the row set
  the first pass missed.
- **5 sibling-rung twins**: the FoilFractor rung for all 5 `FP2-` (Series
  Two) cards already exists at checklist authority under
  `setKey=topps-series-2`, `source=checklistinsider-2026-08-27`, same card
  number, rung and player (re-verified directly by point-read at the
  corrected id). Excluded.
- The remaining 105 rows are absent under `topps` with no sibling twin, and
  are staged.

### Verifier output (run against the final, already-trimmed 105-row CSV)

```json
{
  "csv": "data/checklists/scraped/acq-2026-09-26-2156-insider-bcp-topps-2025-first-pitch/2025-topps-first-pitch.csv",
  "ranAt": "2026-09-26T03:36:24.951Z",
  "totalRows": 105,
  "presentChecklist": 0,
  "presentDerived": 0,
  "absent": 105,
  "reconciled": true
}
```

## Reconciliation

```
rows scraped (9 rungs x 15 cards)         135
  present, checklist-grade (base)          15
  present, checklist-grade (FP- FoilFractor)  10
  sibling-rung twin (FP2- FoilFractor)      5
  genuinely absent, staged                105
  --------------------------------------------
  accounted                               135   EXACT
```

## Owner ruling

`FP-`/`FP2-` lives under `topps` (no separate key). The FP- FoilFractor rung
is excluded because it is already checklist-present under `topps` itself;
the FP2- FoilFractor rung is excluded because it is already addressable
under `topps-series-2`. Every other rung (and all of FP-/FP2- base) has
neither a present row nor a sibling-key twin and is staged.
