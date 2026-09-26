# 2025 Topps Baseball -- 1990 Topps Baseball Relics (T90R-/90R2-), 2026-09-26

Source: baseballcardpedia.com, `source=baseballcardpedia-2026-09-26` --
every staged row's card number, player name, rung name and print run was
read directly off that page. checklistinsider.com was consulted only for
reconnaissance (its own overview prose names the insert) but did not
surface this section's card-by-card roster, and no staged row's text came
from it.

## What this package covers

`T90R-` (Series One, 98 single-signer relic cards) and `90R2-` (Series Two, 47
cards) -- the relic counterpart to the 1990 Topps Baseball 35th-anniversary
insert. Ladder ("All Relics, unless otherwise noted, are available in the
following parallels" -- the page's own umbrella note immediately preceding
this section): blank base + Blue /150 + Gold /50 + Orange /25 + Black /10 +
Red /5 + Platinum 1/1 (7 rungs x 145 cards = 1,015 rows scraped).

## Absence result

Point-read against `card_catalog` (pk=/cardId and the None-partition shape,
id computed via `computeHobbyIqCardId` + `insert-set-key.cjs` from
`backend/dist`, never a hand-rolled slug):

- 98 of 1,015 rows are the blank-parallel base row and already exist at
  checklist authority (`source=beckett-s3-2026-09-20`). Excluded.
- 60 rows are present but DERIVED (`ingest-auto-seed`) -- not checklist-grade,
  so they do not count as present per the task's absence rule, but they are
  also not staged over (this package adds the checklist-grade row at the same
  address; the ingest write path's own authority ranking handles the
  supersession, this package does not need to).
- **329 rows are sibling-rung twins**: almost every `90R2-` (Series Two) card's
  full ladder -- base + all 6 parallel rungs -- already exists at checklist
  authority under `setKey=topps-series-2`, `source=beckett-scraped-2026-08-26`,
  same card number, same rung, same player. These are NOT staged.
- **528 rows are genuinely absent with no sibling twin.** All 528 are `T90R-`
  (Series One) rows: the Series One relic ladder was not covered by the prior
  `beckett-scraped-2026-08-26` pass the way Series Two was.

## Reconciliation

```
rows scraped (7 rungs x 145 cards)   1,015
  present, checklist-grade               98
  present, derived (not counted)         60
  sibling-rung twin (topps-series-2)    329
  genuinely absent, staged              528
  --------------------------------------------
  accounted                           1,015   EXACT (528+98+60+329=1015)
```

## Owner ruling

`T90R-`/`90R2-` lives under `topps` (no separate key) -- own letter prefix, no
same-numbered clash with plain Series 1/2 base numbering. The Series Two
rows are excluded here specifically because they are ALREADY ADDRESSABLE
under `topps-series-2`; re-staging them under `topps` would be the exact
split-pool defect (`one card, one row, one pool`) this pipeline exists to
prevent, even though the two ids differ only in setKey.
