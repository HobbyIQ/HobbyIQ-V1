# 2025 Bowman's Best Baseball — Target C: NOT staged

- **Task's premise**: cardnumber lane refused 244 sales as
  "destination-not-on-checklist" at ids like
  `…:b25-bb:base:auto:num-50`, `…:b25-qm:base:auto:num-99`, described as
  "Quad Autographs" cards (B25-BB, B25-QM), asking for the relevant
  autograph sections' ladders from
  checklistinsider.com/2025-bowmans-best-baseball.

## What the source page actually says (verbatim, fetched 2026-09-25, HTTP 200)

`B25-BB` ("B25-BB Brody Brecht - Colorado Rockies") and `B25-QM` ("B25-QM
Quinn Mathews - St. Louis Cardinals") both belong to the **"Best of 2025
Autographs Checklist"** section — 131 cards, single-signer, pack odds 1:7 —
NOT the "Quad Autographs Checklist" section (13 cards, 4-signer, prefix
`QA-`, e.g. `QA-ADGS`). The two sections use entirely different card-number
prefixes and the task's cited ids describe a section/card mapping that does
not exist on the source: no `B25-` code belongs to Quad Autographs anywhere
on the page, and no `QA-` code matches `B25-BB` or `B25-QM`.

The "Best of 2025 Autographs" ladder (verbatim) tops out at Gold Refractor
/50 and Gold Mini-Diamond Refractor /50 — /99 does not appear as a print run
on this ladder at all, so the task's cited
`…:b25-qm:base:auto:num-99` id shape describes a print run this ladder never
produces (that id is for the BASE row anyway, which carries no printRun).

## Point-read census (computeHobbyIqCardId from built dist), corrected id shapes

Using the real "Best of 2025 Autographs" section (131 `B25-` codes, matching
the page's stated "131 cards" exactly — 131 distinct codes, no dedup needed):

- **Base row**: 130/131 already checklist-grade present. **1 absent:
  B25-JP** (JoJo Parker) — BUT sibling check found this exact (year,
  cardNumber=B25-JP, parallel=Base, isAuto=true, printRun=null) tuple already
  checklist-grade present under setKey `bowman`
  (`baseballcardpedia-ladders-2026-09-04`), i.e. a pre-existing row filed
  under the WRONG sibling product. Per the absence rule this BLOCKS
  staging — not absent, mis-keyed. NOT staged (the mis-key itself is a
  separate repair, out of scope for an acquisition PR with no writes).
- **14 of 15 named ladder rungs** (Refractor, Blue/Green/Purple/Gold
  Mini-Diamond/Gold/Orange/Orange X-Fractor/Teal/Black/Black X-Fractor/
  Red/Red X-Fractor/SuperFractor): 131/131 already checklist-grade present
  for every card. NOT staged.
- **Printing Plates 1/1**: 131/131 absent at the exact `bowmans-best` id —
  BUT sibling check found **all 131** already checklist-grade present under
  setKey `bowman` (same `baseballcardpedia-ladders-2026-09-04` source) —
  the identical mis-keying pattern as the base row above, applied uniformly
  across the whole section. Per the absence rule this BLOCKS staging for
  every one of the 131 cards. NOT staged.

## Conclusion

Target C is **NOT absent** under the rule. Every candidate row this census
could construct from the verbatim source — base for 130/131 cards, all 15
ladder rungs for all cards, and the one apparent base gap (B25-JP) — already
has a checklist-grade row in the catalog, either under `bowmans-best`
directly or under the sibling setKey `bowman`. Nothing sourced, nothing
staged, 0 rows in this package.

This also means the task's motivating incident (244 sales refused at
`b25-bb`/`b25-qm` ids) is not explained by a missing raw checklist row —
those exact ids already resolve to present, checklist-grade catalog rows.
The refusal has a different cause (possibly the `bowman`/`bowmans-best`
setKey mismatch itself misdirecting the cardnumber lane's lookup) that is
outside this acquisition task's scope (no writes, sourcing only).

## Rows checked / present / staged

- Rows checked: 131 (base) + 131×15 (ladder) + 131 (Printing Plates sibling
  recheck) = 2,227.
- Already present (checklist-grade, direct): 130 base + 131×14 ladder rungs.
- Already present under a SIBLING checklist-grade source (blocks staging):
  1 (B25-JP base) + 131 (Printing Plates, all cards).
- **Staged: 0.**
- Unsourceable / not stageable, with reason: the task's target itself
  (Quad Autographs at `b25-bb`/`b25-qm`) does not exist — those codes belong
  to a different, already-covered section. The two real absences found by
  re-deriving the target from the actual page both turn out to be mis-keyed
  presence under a sibling setKey, not genuine absence.
