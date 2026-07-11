# Auto-flag soft matches — 2026-07-11 investigation

## Context

The reference-catalog stress test v2 (2026-07-11) flagged 4 "soft matches"
where the workbook indicates a parallel has an auto variant but the shipped
Cosmos ParallelDocs only have base variants:

| Bucket | Workbook auto | Cosmos autos |
|---|---|---|
| bowman-chrome/2024 Green Refractor | true | [false, false] |
| bowman-chrome/2024 Yellow Refractor | true | [false, false] |
| bowman-chrome/2024 Red Refractor | true | [false, false] |
| bowman-draft/2022 Purple Refractor | true | [false] |

## Probe

`backend/scripts/probe-auto-flag-gaps.cjs` calls CH `identifyCard` with
concrete player + card-number queries per bucket. If CH resolves the
specific auto SKU with high confidence, the variant exists and should be
added to Cosmos. If not, the workbook flag is likely wrong.

Two players probed per bucket to guard against player-specific gaps:

- 2024 BCP: Kristian Campbell (BCP-25) + Chase DeLauter
- 2022 Bowman Draft: Elly De La Cruz (CDA-EDLC) + Druw Jones

## Results

| Bucket | identifyCard |
|---|---|
| 2024 BCP Green Refractor Auto | ✗ no match on either player |
| 2024 BCP Yellow Refractor Auto | ✗ no match on either player |
| 2024 BCP Red Refractor Auto | ✗ no match on either player |
| 2022 Bowman Draft Purple Refractor Auto | ✗ Elly matched to plain "Base" variant (0.85 confidence), Druw no match — CH knows the card exists but not the Purple Refractor Auto specifically |

## Decision

**Do not add auto ParallelDocs for these 4 buckets.** Writing them to
Cosmos would tell the engine that SKUs exist which CH cannot confirm,
routing users into the tier 4/5 fallback stack with bad print-run
assumptions on cards that may not exist. Better to have `unavailable`
than to synthesize a wrong-shape floor price.

## Workbook follow-up

The Bowman_2022_2026_Stress_Test_v2.xlsx workbook likely has these 4
flagged incorrectly OR is documenting theoretical parallels that were
never printed. Either way, the stress test will keep re-surfacing them
until the workbook is corrected. Options for a future workbook pass:

1. Remove the auto flag from these 4 rows (if confirmed not printed)
2. Add a "confidence: Low" or "notes: unverified" column so the stress
   test can classify these as known-unverified rather than soft-match
3. Cross-check against Beckett OPG or BaseballCardPedia before workbook
   edits

Deferred; not a launch blocker. The 6 other stress-test drifts (3 fixed
in PR #368, 3 where Cosmos was correct and no action was needed) are
higher-signal.

## Cost of leaving these unmerged

Zero visible impact. Users searching for these specific SKUs hit
`unavailable` today; adding the ParallelDocs would flip them to a
Tier 4/5 projected price that may not correspond to any real card.
The `unavailable` outcome is more honest.
