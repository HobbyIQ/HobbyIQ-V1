# 2025 Topps Baseball -- 2024 First Pitch (FP-/FP2-), 2026-09-26

Source: baseballcardpedia.com, `source=baseballcardpedia-2026-09-26` --
every staged row's text was read directly off that page (same reconnaissance
note as the CTH package in this PR: checklistinsider.com named the insert
but did not surface its roster).

## What this package covers

`FP-1` through `FP-10` (Series One, 10 cards) and `FP2-1` through `FP2-5`
(Series Two, 5 cards) -- ceremonial first-pitch celebrities/notables, 15
distinct cards. Ladder (the CTH package's own shared umbrella note): blank
base + Pink (unnumbered) + Blue /150 + Green /99 + Gold /50 + Orange /25 +
Black /10 + Red /5 + FoilFractor 1/1 (9 rungs x 15 cards = 135 rows
scraped).

## Absence result

Same method as CTH in this PR, plus a per-cardNumber sibling-rung-twin
query:

- All 15 blank-parallel base rows already exist at checklist authority
  (`source=baseballcardpedia-ladders-2026-08-29` for FP-, mixed
  `checklistinsider-2026-08-27`/`baseballcardpedia-ladders-2026-09-02` for
  FP2-). Excluded.
- **5 sibling-rung twins**: the FoilFractor rung for all 5 `FP2-` (Series
  Two) cards already exists at checklist authority under
  `setKey=topps-series-2`, `source=checklistinsider-2026-08-27`, same card
  number, rung and player (ids like
  `hiq:baseball:2025:topps-series-2:fp2-1:foilfractor:no-auto:num-1`).
  Excluded.
- The remaining 115 rows (all other rungs for FP- and FP2-) are absent with
  no sibling twin, and are staged.

## Reconciliation

```
rows scraped (9 rungs x 15 cards)   135
  present, checklist-grade           15
  sibling-rung twin (FP2- FoilFractor only)   5
  genuinely absent, staged          115
  --------------------------------------
  accounted                         135   EXACT
```

## Owner ruling

`FP-`/`FP2-` lives under `topps` (no separate key). The FP2- FoilFractor rung
is excluded because it is already addressable under `topps-series-2`; every
other FP2- rung (and all of FP-) has no sibling-key presence and is staged.
