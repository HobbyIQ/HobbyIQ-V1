# 2025 Topps Baseball -- Major League Material single-signer relics (MLM-/MLM2-), 2026-09-26

Source: baseballcardpedia.com, `source=baseballcardpedia-2026-09-26` --
every staged row's card number, player name, rung name and print run was
read directly off that page (same reconnaissance note as the T90R package
in this PR: checklistinsider.com named the insert but did not surface its
roster).

## What this package covers

`MLM-` (Series One, 82 cards) and `MLM2-` (Series Two, 88 cards) --
single-signer relics, distinct from the already-staged `MLMD2-` (Series Two
DUAL relic, wave 2 of PR #2388's follow-up). Ladder ("All Relics, unless
otherwise noted, are available in the following parallels" -- the page's own
umbrella note immediately preceding this section): blank base + Blue /150 +
Gold /50 + Orange /25 + Black /10 + Red /5 + Platinum 1/1 (7 rungs x 170 cards
= 1,190 rows scraped).

## Absence result

Same method as T90R in this PR (point-read via computeHobbyIqCardId +
insert-set-key.cjs from backend/dist), plus a per-cardNumber sibling-rung-twin
query:

- 82 of 1,190 rows are the blank-parallel base row and already exist at
  checklist authority (`source=beckett-s3-2026-09-20`). Excluded.
- 75 rows are present but DERIVED (`ingest-auto-seed`) -- not counted as
  present per the absence rule, not staged over either (74 of these are
  MLM- Series One base-adjacent derived rows; 1 is MLM2-PS Blue, Paul
  Skenes, the lone Series Two row that is present-but-derived rather than a
  twin).
- **615 sibling-rung twins**, ALL of them `MLM2-` (Series Two): that
  product's full ladder -- base + all 6 parallel rungs, for 87 of its 88
  cards -- already exists at checklist authority under
  `setKey=topps-series-2`, `source=beckett-scraped-2026-08-26`, same card
  number, rung and player. Combined with the 1 derived-present MLM2-PS row
  above, all 616 `MLM2-` rows are accounted for and NONE are staged.
- **418 rows are genuinely absent with no sibling twin -- all of them
  `MLM-` (Series One).** Reconciliation: 574 MLM- rows = 82 present + 74
  derived + 418 staged + 0 twins (exact); 616 MLM2- rows = 615 twins + 1
  derived-present + 0 present-checklist + 0 staged (exact); 574+616=1,190.

## Owner ruling

`MLM-`/`MLM2-` lives under `topps` (no separate key) -- own letter prefix,
disjoint from `MLMD2-` (dual) already staged and from plain Series 1/2 base
numbering. Series Two rows that already carry a checklist-grade twin under a
sibling setKey are excluded rather than restaged, per the same
one-card-one-row-one-pool reasoning as the T90R package.
