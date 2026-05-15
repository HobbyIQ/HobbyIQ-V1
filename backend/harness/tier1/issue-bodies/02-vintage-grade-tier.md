## Description
Querying for a graded vintage card returns a `fairMarketValueLive` that appears to ignore the grade tier. 1986 Fleer Michael Jordan PSA 8 returns `fairMarketValueLive=$46`. Real PSA 8 market is approximately $1,000-$1,400. The engine appears to be pricing as if raw, or against a comp pool that includes wrong-grade sales.

## Reproduction
Production `engineVersion=99bb447`:
- case 15: `"1986 Fleer Michael Jordan PSA 8"` -> `fairMarketValueLive=$46`, `compsUsed=27`, `source="live"`
- Compare case 16: `"1989 Upper Deck RC Ken Griffey Jr PSA 9"` -> `fairMarketValueLive=$427-$449`, `compsUsed=26`, `source="live"` -- this case appears correct, so grade-aware comp filtering works on some vintage cards.

## Hypothesis
The comp pool for the Jordan query is including raw and lower-grade sales without weighting by grade tier. May be a comp-filter logic issue specific to certain vintage cards. The difference between this card and the Griffey case is worth investigating -- similar profiles (vintage RC, graded) but wildly different correctness.

## Impact
Dangerous user-facing outcome. A user trusting this number would underprice a valuable card by ~95%. The bug is invisible to popular-modern-card testing.

## Blocks
Harness FMV assertion for case 15. Soft assertions (well-formed, has comps) until fixed.
