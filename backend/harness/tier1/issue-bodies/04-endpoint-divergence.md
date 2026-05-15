## Description
For the same card identity (cardHedgeCardId resolved), the `/search` endpoint returns `source="variant-mismatch"` while `/price-by-id` returns `source="no-recent-comps"`. Same query string, same card_id, different verdicts.

## Reproduction
Production `engineVersion=99bb447`:
- case 19b: `"2025 Bowman Draft Chrome Green Refractor Auto Eli Willits PSA 10"` + corresponding cardHedgeCardId
- `/search`: `source="variant-mismatch"`, `compsUsed=0`
- `/price-by-id`: `source="no-recent-comps"`, `compsUsed=0`

## Hypothesis
Similar family to the PR #4 hotfix (player-identity guard) -- the `/search` path applies some classification that `/price-by-id` skips, or vice versa. The two endpoints have diverged on how they handle the variant-mismatch case.

## Impact
Same card produces different user-facing messages depending on which screen called the engine. Tracking and user trust both suffer.

## Investigation priority
HIGH -- being investigated as part of the current harness work. If the fix is a one-line condition similar to PR #4, it will be fixed in the harness session. Otherwise it gets full investigation as a separate PR.
