## Description
Highly popular modern RCs return live FMV that appears below real market. Paul Skenes 2024 Topps Chrome RC returns `fairMarketValueLive=$12-$13` with 26 comps. Real market is approximately $20-$30+ for the raw base RC. Same pattern for Elly De La Cruz at $3-$4 vs real market $5-$10. Both have live data and many comps, so this is not a data-availability issue.

## Reproduction
Production `engineVersion=99bb447`:
- case 12: `"2024 Topps Chrome Paul Skenes"` -> `fairMarketValueLive=$12-$13`, `compsUsed=26`, `source="live"`
- case 13: `"2023 Topps Update Elly De La Cruz"` -> `fairMarketValueLive=$3-$4`, `compsUsed=6`, `source="live"`

## Hypothesis
The comp pool may be including heavily-played raws, off-condition sales, partial-team-set inclusions, or wrong-parallel sales that drag the FMV down. Possible same family as issue 2 (condition/grade not weighting comps correctly). May also be that Card Hedge comp data is genuinely thin on these specific configurations and the engine selection is correct but the underlying data is biased.

## Impact
Less severe than issue 2 (numbers within an order of magnitude) but still produces noticeably-wrong prices on flagship cards. Users may distrust the engine after seeing these.

## Suggested investigation
Pull the 26 Skenes comps from the response `recentComps` field, check what conditions/parallels they actually represent, identify whether the pool is biased or the FMV calculation is.

## Blocks
Harness FMV magnitude assertion for cases 12-13. Soft assertions until investigation completes.
