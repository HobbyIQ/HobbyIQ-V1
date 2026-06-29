# Volume Test 2026-06-29 — Engine vs CardHedge Findings

100 cards spanning 1951-2024 imported as test inventory. 83 passed HIGH match-quality (year + player verified) and were repriced. Side-by-side engine FMV vs CH `card-fmv` Raw revealed three bug classes and four follow-up CFs.

## Headline numbers

| Metric | Value |
|---|---|
| Cards in test | 100 |
| Resolved cleanly (year + player match) | 83 |
| Year-mismatched (matcher picked wrong year) | 9 |
| No match | 8 |
| Both priced (engine + CH) | 82 |
| Engine/CH median ratio | **1.00** |
| Engine/CH mean ratio | 430× (skewed by outliers) |
| Engine/CH range | [0.016, 34659] |

Half the cards land at parity with CH (median 1.0×). The tails are the bugs.

## Bug classes surfaced

### Class A — Inverse-multiplier breakdown on high-end vintage Raw

**Symptom:** engine returns absurd high values for vintage HOFs.

| Card | Engine | CH | Ratio |
|---|---|---|---|
| 1952 Topps Mantle #311 | $2,287,500 | $66 | 34,659× |
| 1953 Topps Mantle #82 | $1,481 | $5 | 296× |
| 1959 Topps Bob Gibson RC | $6,786 | $616 | 11.01× |
| 1956 Topps Mantle | $15,893 | $633 | 25.12× |
| 1963 Topps Pete Rose RC | $18,500 | $760 | 24.34× |
| 1954 Topps Al Kaline RC | $5,250 | $229 | 22.98× |

**Root cause:** the static `GRADER_PREMIUMS` table is calibrated for prospect-base MiLB pitcher data. For vintage HOFs, PSA grade multipliers are 10-100× higher than Raw — the table's inverse (e.g., PSA 8 / Raw = 0.80 at "100+" tier → Raw = PSA 8 × 1.25) produces nonsense.

**Shipped fix:** PR #177 CF-LADDER-INVERSE-SANITY-GATE — when downgrading from a graded anchor to Raw produces `derivedFmv > anchorPrice × maxRatio` (maxRatio 1.10 for autos, 1.00 for everything else), reject the ladder result. Engine returns null instead of $2.28M.

**Follow-up:** **CF-VINTAGE-GRADER-PREMIUMS** — separate multiplier table calibrated from CardHedge vintage data. PSA 8/9/10 → Raw ratios for pre-1980 HOF cards. Once shipped, the sanity gate's null cases become real derived values again.

### Class B — Engine picks BASE parallel for prospect AUTO holdings

**Symptom:** engine returns base-insert prices when user wants the autograph.

| Card | Engine | CH | Note |
|---|---|---|---|
| 2011 Bowman Chrome Bryce Harper Prospect Auto | $11 | $424 | Matched BCP111 (base insert) instead of CPA-BH (auto) |
| 2016 Bowman Chrome Tatis Jr. 1st Bowman Auto | $9 | $240 | Matched correctly but engine pool issue |
| 2017 Bowman Chrome Acuña Jr. 1st Bowman Auto | $6 | $12 | Matched BCP127 base |
| 2020 Bowman Chrome Dominguez 1st Bowman Auto | $3 | $47 | — |
| 2021 Bowman Chrome Mayer 1st Bowman Auto | $3.50 | $88 | Matched C21-MM Base |

**Root cause:** CardHedge's match_card AI returns the highest-volume traded card for a player+set, which is the BASE INSERT (BCP-XX) not the AUTOGRAPH (CPA-XX). Even when the query includes "auto", the matcher's confidence prefers the higher-volume variant.

**Shipped fix:** PR #178 CF-AI-MATCH-INTENT-VALIDATION — post-validate match_card results. When user query has auto intent AND match.number has a non-auto prefix (no CPA/BCPA/etc), reject the boost and let the rerank surface the actual autograph card from search results.

**Follow-up:** **CF-AUTO-INTENT-SEARCH-FILTER** — when dispatcher detects auto intent, pass a `subset` or `isAuto` hint to CH's search to bias the search-result pool toward autographs in the first place. Reduces reliance on the rerank to catch matcher misses.

### Class C — Wrong-year matches (~9 cases)

**Symptom:** user says "2000 Bowman Chrome", matcher returns "2003 Bowman Draft Picks & Prospects".

| Card | Resolved To |
|---|---|
| #63 Miguel Cabrera 2000 Bowman Chrome | 2003 Bowman Draft Picks & Prospects |
| #64 Joe Mauer 2001 Bowman Chrome | 2003 Bowman Draft Picks & Prospects |
| #65 David Wright 2002 Topps Chrome Traded | 2024 Topps Stadium Club |
| #82 Vlad Jr. 2015 Bowman Chrome | 2026 Bowman Mega Box |
| #95 Elly De La Cruz 2021 Bowman Chrome | 2026 Bowman Mega Box |

**Root cause:** CH catalog naming differs from common collector vocabulary. "Bowman Chrome" in 2000-2001 was actually the "Bowman Draft Picks & Prospects" set. Some cards in CH's catalog use "Bowman Mega Box" suffix where the standard form is "Bowman".

**Mitigation today:** these were filtered out of the import by the HIGH/LOW categorization (year-strict gate). They didn't pollute the comparison. But they ALSO didn't get priced.

**Follow-up:** **CF-SET-ALIAS-DICTIONARY** — backend-side dictionary mapping common collector vocabulary to CH's canonical set names. "Bowman Chrome 2001 prospect" → search "Bowman Draft Picks & Prospects 2003". User intent → matcher input bridge.

### Class D — Underpriced engine vs CH on modern cards

**Symptom:** engine returns small numbers for modern cards with real CH prices.

| Card | Engine | CH | Note |
|---|---|---|---|
| 2006 Kershaw Prospect | $10 | $608 | Likely wrong card |
| 2018 Soto US300 RC | $5 | $26 | Wrong card |
| 2015 Kris Bryant RC | $6 | $3 | Engine actually 2× CH here |
| 2013 Nolan Arenado RC | $11 | $7 | Engine actually 1.57× CH |

**Root cause:** mixed. Some are matcher errors (Kershaw, Soto). Some are engine emitting from a different comp pool than CH (Bryant, Arenado where engine ≈ CH ± 50%).

**Follow-up:** **CF-PER-CARD-COMP-POOL-AUDIT** — telemetry that compares the engine's compsUsed pool against CH's prices-by-card series for the same cardId. When the engine's pool differs substantially from CH's, log a drift event.

## CF queue (ordered by impact)

1. **CF-VINTAGE-GRADER-PREMIUMS** — eliminates Class A nulls. Empirical calibration scan against CH for pre-1980 HOF cards, same pattern as CF-AUTO-AWARE-MULTIPLIERS.
2. **CF-AUTO-INTENT-SEARCH-FILTER** — eliminates Class B at the search level (currently only caught at rerank).
3. **CF-SET-ALIAS-DICTIONARY** — eliminates Class C year-mismatches via vocabulary bridge.
4. **CF-PER-CARD-COMP-POOL-AUDIT** — surfaces Class D drift cases for individual investigation.

## What's working

- **Median ratio 1.00**: the engine is in calibration with CH on the easy half of the catalog.
- **Vintage parity examples**: 1954 Hank Aaron RC ($5,376 = $5,376), 1955 Clemente RC ($1,500 = $1,500), 1989 Griffey Jr Upper Deck RC (similar parity).
- **Modern parity examples**: 2017 Aaron Judge Topps Chrome RC ($115 vs $99, 1.16×), 2018 Ohtani RC ($249 vs $223, 1.12×), 2011 Mike Trout Topps Update US175 ($318 vs $281, 1.13×).
- **Ladder rescues working**: Drew's 41 ladder-derived `estimatedValue` holdings (volume test + previous portfolio) surface honest estimates with nearestGradedAnchor disclosure.

## Test artifacts

- Resolved data: `scratchpad/volume-test-resolved.json` (100 cards)
- Categorization: `scratchpad/volume-test-categorized.json` (HIGH/YEAR_MISMATCH/POOR/NO_MATCH buckets)
- Comparison report: `scratchpad/volume-test-comparison.md` (83 HIGH rows, full table)
- Source data: spreadsheet shared by Drew 2026-06-29 (Top 100 baseball cards 1951-2024)
