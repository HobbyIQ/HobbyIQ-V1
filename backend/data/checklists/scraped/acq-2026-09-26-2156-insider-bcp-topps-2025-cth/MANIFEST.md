# 2025 Topps Baseball -- Call to the Hall (CTH-), 2026-09-26

Source: baseballcardpedia.com, `source=baseballcardpedia-2026-09-26` --
every staged row's card number, player name, rung name and print run was
read directly off that page. checklistinsider.com was consulted only for
reconnaissance (its own overview prose names the insert) but did not
surface this section's card-by-card roster, and no staged row's text came
from it.

## What this package covers

`CTH-1` through `CTH-25` -- 25 Hall of Fame players, one card each, per the
page's own stated print run ("We estimate 84,325 copies of each Call to the
Hall were produced."). Ladder (the page's own umbrella note, shared with
1990 Topps Baseball / 2024 All-Topps Team / 2024's Greatest Hits / Training
Ground / 2024 First Pitch): blank base + Pink (unnumbered) + Blue /150 +
Green /99 + Gold /50 + Orange /25 + Black /10 + Red /5 + FoilFractor 1/1 (9
rungs x 25 cards = 225 rows scraped).

## CORRECTION (PR #2433 review, 2026-09-26)

The first absence pass in this PR hardcoded `printRun: null` when computing
the id to point-read, for EVERY row -- so every numbered parallel rung
(Blue/150, Gold/50, ..., **FoilFractor/1**) was checked at the WRONG id
(missing the `:num-N` segment `computeHobbyIqCardId` appends whenever
`printRun` is a number) and 404'd unconditionally, regardless of what the
catalog actually holds. That pass wrongly staged all 25 FoilFractor rows as
absent. They are in fact checklist-present, `source=checklistinsider-
2026-08-27`, at their correct `:num-1` id. The REPORT-mode ingester banner
this PR originally cited as confirmation proves nothing here either:
`ingest-checklist-csv-to-catalog.cjs` counts `written++` before any Cosmos
read when `!APPLY`, so its "already present"/"rung twin" counters are
structurally zero in REPORT mode.

## Absence result (corrected)

Point-read against `card_catalog` via `backend/scripts/verify-absent.cjs`
(reads `printRun` from the CSV row, no null fallback):

- 25 blank-parallel base rows already exist at checklist authority
  (`source=baseballcardpedia-ladders-2026-08-29`/`-09-02`). Excluded.
- 25 FoilFractor rows already exist at checklist authority
  (`source=checklistinsider-2026-08-27`). Excluded.
- The remaining 175 rows (Pink/Blue/Green/Gold/Orange/Black/Red x 25 cards)
  are genuinely absent, confirmed by no sibling-rung twin under any other
  setKey (sampled CTH-1/CTH-13/CTH-25 directly). All 175 are staged.

### Verifier output (run against the final, already-trimmed 175-row CSV)

```json
{
  "csv": "data/checklists/scraped/acq-2026-09-26-2156-insider-bcp-topps-2025-cth/2025-topps-cth.csv",
  "ranAt": "2026-09-26T03:35:59.691Z",
  "totalRows": 175,
  "presentChecklist": 0,
  "presentDerived": 0,
  "absent": 175,
  "reconciled": true
}
```

## Reconciliation

```
rows scraped (9 rungs x 25 cards)   225
  present, checklist-grade (base)    25
  present, checklist-grade (FoilFractor)  25
  sibling-rung twin                   0
  genuinely absent, staged          175
  --------------------------------------
  accounted                         225   EXACT
```

## Owner ruling

`CTH-` lives under `topps` (no separate key) -- own letter prefix, no
same-numbered clash with plain Series 1/2 base numbering or any other staged
product (confirmed by the zero-twin result).
