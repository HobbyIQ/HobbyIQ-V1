$repo = "HobbyIQ/HobbyIQ-V1"

$issues = @(
    @{
        title = 'compiq: PSA-grade tokens in query trigger variant-mismatch on some cards but not others'
        labels = 'bug,compiq,parser'
        body = @'
## Description
When `"PSA 10"` (and likely other grade tokens) appears in the `/api/compiq/search` query string, the parser/parallel-matcher returns `source="variant-mismatch"` and `compsUsed=0` on some cards. The same query without grade tokens returns live comps. The behavior is non-deterministic across cards -- some cards with PSA tokens parse fine.

## Reproduction
All on production `engineVersion=99bb447`:

**Reproduces:**
- case 01: `"2023 Bowman Draft Green Refractor Auto Jacob Wilson PSA 10"` -> `source="variant-mismatch"`
- case 04b: `"2024 Bowman Draft Chrome Refractor Auto Nick Kurtz PSA 10"` -> `source="variant-mismatch"`
- case 19b: `"2025 Bowman Draft Chrome Green Refractor Auto Eli Willits PSA 10"` -> `source="variant-mismatch"` via `/search`, `source="no-recent-comps"` via `/price-by-id` (cross-endpoint inconsistency tracked separately in issue 4)

**Does NOT reproduce:**
- case 16: `"1989 Upper Deck RC Ken Griffey Jr PSA 9"` -> `source="live"`, `compsUsed=26`
- case 11: `"2017 Topps Chrome Catching RC Aaron Judge PSA 10"` -> `source="no-recent-comps"` but without variant-mismatch flag

## Hypothesis
Grade tokens are bleeding into parallel parsing. The parser may be matching `"PSA 10"` against a parallel-name dictionary in some code paths and not others. Investigation point: `parseCardQuery` in `backend/src/services/compiq/queryParser` (or equivalent).

## Impact
User queries that include grade context return zero comps even when comps exist for the underlying card. PSA-graded card pricing is a core use case.

## Blocks
Harness assertions for cases 01, 04b, 19b. These cases will get soft assertions (well-formed response) until this issue is fixed.
'@
    },
    @{
        title = 'compiq: vintage card grade tier not propagating to comp filtering - 1986 Fleer Jordan PSA 8 returns ~$46 (real market $1000+)'
        labels = 'bug,compiq,grade-handling,vintage'
        body = @'
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
'@
    },
    @{
        title = 'compiq: Skenes/De La Cruz live FMV appears under-anchored vs market - comp inclusion may be too broad'
        labels = 'bug-suspected,compiq,comp-filtering,needs-investigation'
        body = @'
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
'@
    },
    @{
        title = 'compiq: /search and /price-by-id return different verdicts for the same card on case 19b (Eli Willits PSA 10)'
        labels = 'bug,compiq,endpoint-consistency,similar-to-pr-4-hotfix'
        body = @'
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
'@
    }
)

Add-Type -AssemblyName System.Web
$lines = @()
for ($i = 0; $i -lt $issues.Count; $i++) {
    $it = $issues[$i]
    $t = [System.Web.HttpUtility]::UrlEncode($it.title)
    $b = [System.Web.HttpUtility]::UrlEncode($it.body)
    $l = [System.Web.HttpUtility]::UrlEncode($it.labels)
    $url = "https://github.com/$repo/issues/new?title=$t&body=$b&labels=$l"
    $lines += "Issue $($i+1): $($it.title)"
    $lines += $url
    $lines += ""
}
$out = $lines -join "`n"
$out | Out-File -FilePath "backend\harness\tier1\issue-links.txt" -Encoding ascii
Write-Host "Wrote backend\harness\tier1\issue-links.txt"
