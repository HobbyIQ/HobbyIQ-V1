# 2026 Topps Series 1 Baseball — Silver Crackle Foil

- **setKey**: `topps`
- **year**: 2026
- **source**: checklistinsider.com/2026-topps-series-1-baseball (HTTP 200, fetched 2026-09-25)
- **sport**: baseball

## Verbatim sentence

From the "2026 Topps Series 1 Baseball Base Parallels List" section:

> Silver Crackle Foil (Super Box exclusive)

No numeric print run is stated for this rung — it is minted unnumbered
(`printRun: null`), consistent with the page's own listing (no `/N` given,
unlike the surrounding rungs which all carry one).

## Point-read census (computeHobbyIqCardId from built dist)

- Base-row existence check across all 350 card numbers: **350/350 present**,
  all checklist-grade (`baseballcardpedia-ladders-2026-09-02`). The task's
  originating diagnosis (~48 zero-row base cards) did NOT reproduce — re-run
  against the current catalog, every base card number 1–350 already has a
  checklist row. No base-row gap exists to stage.
- Silver Crackle Foil rung, all 350 card numbers, exact id
  `hiq:baseball:2026:topps:{n}:silver-crackle-foil:no-auto`:
  - **333 / 350 absent** (404 on card_catalog) — staged below.
  - **17 / 350 present, but DERIVED ONLY** (`ingest-auto-seed` /
    `catalog-explode-actuals-2026-08-12`) — NOT staged; a checklist row here
    would supersede the derived one, but this package only stages genuine
    absences. Card numbers: 5, 15, 35, and 14 others (see census script
    output).
  - **0 / 350 already checklist-grade present.**
- Sibling-setKey check (`topps-chrome`, `topps-heritage`, `bowman`) for the
  Silver Crackle Foil id shape across all 350 numbers: **0 hits**. No
  checklist-grade row for this (year, cardNumber, parallel, isAuto, printRun)
  exists anywhere else in the catalog.

## Rung verification (other named rungs in the task's motivating list)

Also censused (all 350 card numbers) to confirm they do NOT need staging —
every one is already 350/350 checklist-grade present, contrary to the
originating diagnosis:

- Blue Rainbow Foil /150 — 350/350 present-checklist
- Blue Holo Foil /150 — 350/350 present-checklist
- Gold Rainbow Foil /50 — 350/350 present-checklist
- Rainbow Foil (no print run stated as its own rung; page's plain "Rainbow
  Foil (limited)" line) — 350/350 present-checklist
- Gold /2,026 — 350/350 present-checklist
- "Red Foil" and "Koi Fish" do not appear verbatim anywhere on the source
  page at all (searched full raw HTML) — not staged; the task's cited names
  do not match this checklist's actual vocabulary.

## Rows checked / present / staged

- Rows checked: 350 (base) + 350 (Silver Crackle Foil) + 5×350 (other named
  rungs, verification only) = 2,450 point reads.
- Already present (checklist-grade): 350 base + 5×350 other rungs = 2,100.
- Already present (derived only, not counted as present under the rule): 17.
- **Staged: 333** (Silver Crackle Foil, unnumbered, card numbers per CSV).
- 0 exact-duplicate CSV lines (verified).
