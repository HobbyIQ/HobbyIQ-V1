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
