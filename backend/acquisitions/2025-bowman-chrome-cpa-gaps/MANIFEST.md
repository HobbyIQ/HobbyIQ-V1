# 2025 Bowman Chrome Baseball — Chrome Prospect Autographs (CPA-) ladder gaps

- **setKey**: `bowman-chrome`
- **year**: 2025
- **source**: checklistinsider.com/2025-bowman-chrome-baseball (HTTP 200,
  fetched 2026-09-25, read via direct HTML fetch to get the full page rather
  than a partial-verbatim/AI-summarized read)
- **sport**: baseball
- **isAuto**: true (Chrome Prospect Autographs section)

## Card list

108 distinct `CPA-` codes, extracted from the page's plain checklist list
(`CPA-CODE Name - Team`) and deduped exactly by code. The page's prose states
"109 cards," but only 108 distinct codes appear anywhere on the page —
verbatim or in the page's own "Chrome Prospect Auto -" /
"International Refractor Auto -" annotation block, which flags the SAME 108
codes for whether they also carry an International Refractor Auto parallel
(not a second card list). No 109th code exists anywhere to source. Used 108,
not the stated 109, per "count by source, not row count" — a stated count is
not itself a source.

Raw scrape produced up to 3 repeated lines per code from that annotation
block (the nested-list-scraper artifact the doctrine warns about); deduped by
cardNumber, 108 distinct codes confirmed.

## Verbatim "2025 Bowman Chrome Baseball Chrome Prospect Autograph Parallels" sentence

Full ladder transcribed verbatim from the page: Black & White Shimmer
Refractor, Refractor /499, Speckle Refractor /299, Purple Refractor /250,
Blue Refractor /150, Reptilian Blue Refractor /150, Blue RayWave Refractor
/150, **HTA Choice /150**, Mini-Diamond Refractor /100, Reptilian Green
Refractor /99, Green Refractor /99, Green Lava Refractor /99, Yellow
Refractor /75, Gold Refractor /50, Gold Mini-Diamond Refractor /50, Gold
Shimmer Refractor /50, Orange Refractor /25, Orange Shimmer Refractor /25,
Orange Wave Refractor /25, Reptilian Black Refractor /10, Black Refractor
/10, Gum Ball Refractor /5, Peanuts Refractor /5, Popcorn Refractor /5, Red
Refractor /5, Red Shimmer Refractor /5, Red Wave Refractor /5, **Reptilian
Red Refractor /5**, Sunflower Seeds Refractor /5, SuperFractor 1/1.

(Two rungs bolded above — HTA Choice and Reptilian Red Refractor — were
initially miscensused unnumbered in an earlier pass of this work; re-read of
the raw page confirmed both carry explicit print runs, and the census below
was redone against the correct ids.)

## Point-read census (computeHobbyIqCardId from built dist)

Base row: **108/108 present, checklist-grade.** The raw CPA base checklist
row is NOT absent for any card — target B's premise does not hold for base.

Full 30-rung ladder censused for all 108 cards (3,240 point reads against the
correct ids, redone once after the print-run correction above):

- 28 of 30 rungs (everything except HTA Choice and Sunflower Seeds
  Refractor, see below): already checklist-grade present for all 108, or
  106/108 with the other 2 present as `catalog-explode-actuals-2026-08-12` /
  `ingest-auto-seed` derived rows (CPA-ABR, CPA-JWR only, on some rungs).
  NOT staged.
- **Reptilian Red Refractor /5 — 108/108 already checklist-grade present.**
  An earlier pass of this census used the wrong (unnumbered) id and reported
  this as fully absent; re-run at the correct `/5` id shows zero gap. NOT
  staged — corrected finding.
- **HTA Choice /150 — 108/108 genuinely absent** at the correct id
  (`…:hta-choice:auto:num-150`). Sibling check (`bowman`,
  `bowman-chrome-draft`, `bowman-chrome-sapphire`) at the correct id: 0
  hits. **Staged, /150, all 108.**
- **Sunflower Seeds Refractor /5 — 108/108 absent at the exact
  `bowman-chrome` id**, but sibling check against `bowman-chrome-draft`
  found **22/108 already checklist-grade present** there
  (`checklistcenter-2026-08-29`) under the identical (year, cardNumber,
  parallel, isAuto, printRun) tuple — a mis-keyed pre-existing row. Those 22
  are NOT staged. **Staged: the remaining 86** (CPA-AG, CPA-AJ, CPA-BC,
  CPA-CS, CPA-DL, CPA-DM, CPA-DT, CPA-EP, CPA-JA, CPA-JC, CPA-JD, CPA-JG,
  CPA-JS, CPA-JT, CPA-KA, CPA-KK, CPA-MG, CPA-MM, CPA-RM, CPA-SG, CPA-SH,
  CPA-TS excluded).
- **Peanuts Refractor /5 — absent for exactly 2 of 108 cards** (CPA-ABR,
  CPA-JWR); the other 106 are already present (checklist-grade or derived).
  Sibling check: 0 hits for these 2. **Staged, both.**

## Prospects (BCP-) raw base row

Task also named `Prospects BCP-` raw rows as a target. Card range
BCP-153..BCP-252 (100 cards, matching the page's stated "100 cards" exactly;
BCP-253/254 excluded — those two codes belong to a SEPARATE 2-card "Chrome
RetroFractor Checklist" insert, a different product, not the Bowman Chrome
Prospects base set). Point-read census: **100/100 base rows already
checklist-grade present.** BCP raw base is NOT absent — nothing staged for
BCP.

## Rows checked / present / staged

- Rows checked: 108 (base) + 108×30 (CPA ladder, re-run after print-run
  correction) + 100 (BCP base) = 3,448.
- Already present (checklist-grade, including the 2 corrected-to-present
  Reptilian Red Refractor... actually all 108 for that rung): the
  overwhelming majority of the 3,240 ladder cells.
- Already present under a SIBLING checklist-grade source (blocks staging):
  22 (Sunflower Seeds Refractor, under `bowman-chrome-draft`).
- **Staged: 196** = 108 (HTA Choice /150) + 86 (Sunflower Seeds Refractor
  /5) + 2 (Peanuts Refractor /5).
- Expected sales backed: not sampled in this pass — the absence census
  above (THE ONE RULE THAT MATTERS) took priority over the 300-sale sample
  given how much the print-run correction moved the result; a follow-up pass
  can sample sales against these 196 ids.
- 0 exact-duplicate CSV lines (verified: `sort | uniq -d` on the data rows
  returns empty).
- 0 bytes of 0x00/0x08 in the CSV (verified).
