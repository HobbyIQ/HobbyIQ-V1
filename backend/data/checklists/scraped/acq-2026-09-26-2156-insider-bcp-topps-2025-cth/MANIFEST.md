# 2025 Topps Baseball -- Call to the Hall (CTH-), 2026-09-26

Source: baseballcardpedia.com, `source=baseballcardpedia-2026-09-26` --
every staged row's card number, player name, rung name and print run was
read directly off that page. checklistinsider.com was consulted only for
reconnaissance (its own overview prose names the insert) but did not
surface this section's card-by-card roster to this session's fetch tooling,
and no staged row's text came from it.

## What this package covers

`CTH-1` through `CTH-25` -- 25 Hall of Fame players, one card each, per the
page's own stated print run ("We estimate 84,325 copies of each Call to the
Hall were produced."). Ladder (the page's own umbrella note, shared with
1990 Topps Baseball / 2024 All-Topps Team / 2024's Greatest Hits / Training
Ground / 2024 First Pitch): blank base + Pink (unnumbered) + Blue /150 +
Green /99 + Gold /50 + Orange /25 + Black /10 + Red /5 + FoilFractor 1/1 (9
rungs x 25 cards = 225 rows scraped).

## Absence result

Point-read against `card_catalog` (pk=/cardId and the None-partition shape,
id via computeHobbyIqCardId + insert-set-key.cjs from backend/dist):

- All 25 blank-parallel base rows already exist at checklist authority
  (`source=baseballcardpedia-ladders-2026-08-29`/`-09-02`). Excluded.
- The remaining 200 rows (8 parallel rungs x 25 cards) are absent, and NONE
  are sibling-rung twins under any other setKey (zero-twin result across
  all 200). All 200 are staged.

## Reconciliation

```
rows scraped (9 rungs x 25 cards)   225
  present, checklist-grade           25
  sibling-rung twin                   0
  genuinely absent, staged          200
  --------------------------------------
  accounted                         225   EXACT
```

## Owner ruling

`CTH-` lives under `topps` (no separate key) -- own letter prefix, no
same-numbered clash with plain Series 1/2 base numbering or any other staged
product (confirmed by the zero-twin result).
