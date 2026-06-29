# Volume Test #2 — 2026-06-29 (post 15-PR shipping)

Test inventory designed to exercise **every engine surface shipped today**
(2026-06-29) plus catch bug classes Volume Test #1 didn't hit. Each card
is chosen for a specific reason — comments call out which surface it
validates.

## How to run

Assume cost basis = $100 per card. Import via the same flow as Vol Test #1.
Compare engine FMV vs CardHedge FMV. Specifically watch:

1. **Vintage HOFs that PR #180 unblocked** — should re-populate from null
2. **Modern PSA 10 base graded** — values jump when `MULTIPLIER_BASE_TABLE_ENABLED=true` (PR #194)
3. **Newly-calibrated parallels** (Reptilian, Mini-Diamond, etc.) — should hit empirical ratios, not fallback
4. **Class B prospect-autos** — PR #178 + #181 + #186 should resolve them correctly
5. **Auto-vs-base disambiguation** for same parallel name — PR #186's filter fix
6. **App Insights `engine_vs_ch_fmv_audit`** events — should fire on every priced holding (PR #183)

## 70-card list

### Class A — Vintage HOFs (validate PR #180 vintage table)

These were null'd in Vol Test #1 by PR #177's sanity gate. With PR #180's vintage table they should now populate with realistic Raw FMVs.

| # | Card | Why |
|---|---|---|
| 1 | 1952 Topps Mickey Mantle #311 | The canonical Mantle case (was $2.28M bug). Should land ~$90-100K Raw via vintage 1948-1969 PSA 8 / 5000+ tier 19.3× |
| 2 | 1953 Topps Mickey Mantle #82 | Same era; verify PSA 8 anchor → Raw multiplier |
| 3 | 1954 Topps Hank Aaron RC #128 | 1948-1969 PSA 8 row coverage |
| 4 | 1955 Topps Roberto Clemente RC #164 | Vintage RC validation |
| 5 | 1959 Topps Bob Gibson RC #514 | Was 11.01× drift in V1 — should improve |
| 6 | 1962 Topps Willie Mays #300 | Mid-vintage Mays |
| 7 | 1968 Topps Nolan Ryan RC #177 | 1948-1969 boundary case |
| 8 | 1973 Topps Mike Schmidt RC #615 | 1970-1989 PSA 9 row |
| 9 | 1975 Topps George Brett RC #228 | 1970-1989 high-volume RC |
| 10 | 1989 Upper Deck Ken Griffey Jr. RC #1 | Boundary year (1989 = last vintage) |

### Class B — Modern PSA 10 base graded (validate PR #194 flag flip)

Pick before AND after flipping `MULTIPLIER_BASE_TABLE_ENABLED=true`. Compare values. The <$25 raw tier should see ~127% increase post-flip.

| # | Card | Raw band | Why |
|---|---|---|---|
| 11 | 2024 Topps Chrome Trout #1 | <$25 | Big delta tier |
| 12 | 2024 Topps Chrome Ohtani #1 | 25-50 | Small delta tier (sanity check) |
| 13 | 2024 Topps Chrome Judge #1 | 50-100 | ~10% delta |
| 14 | 2023 Topps Update Bobby Witt Jr. PSA 10 | <$25 | Mid-volume star |
| 15 | 2022 Topps Chrome Adley Rutschman RC PSA 10 | <$25 | Recent rookie |
| 16 | 2021 Topps Chrome Wander Franco RC PSA 10 | 100-250 | +43% delta tier |
| 17 | 2018 Topps Chrome Acuna RC PSA 10 | 100-250 | Established star tier |
| 18 | 2017 Topps Chrome Aaron Judge RC PSA 10 | 250-500 | +20% delta tier |
| 19 | 2011 Topps Update Mike Trout RC PSA 10 | 1000+ | +41% delta tier |
| 20 | 2018 Topps Chrome Ohtani RC PSA 10 | 250-500 | Star validation |

### Class C — Newly-calibrated parallels (validate PR #192 + v2 re-cal)

These parallels were EMPIRICALLY CALIBRATED for the first time in PR #192. Pre-PR they hit the worksheet fallback. Now they should use the discovery-driven ratios.

| # | Card | Variant | Why |
|---|---|---|---|
| 21 | 2025 Bowman Chrome Prospects Reptilian Refractor (any player) | Reptilian Refractor base | Highest-volume new variant (96 cards, 2,645 sales) |
| 22 | 2025 BCP Speckle Refractor /299 (any player) | Speckle Refractor base | Was no_parallel_cards_found pre-CF |
| 23 | 2025 BCP Pearl Refractor (any player) | Pearl Refractor | 12.9× empirical — never had a ratio before |
| 24 | 2025 BCP Mini-Diamond Refractor (any player) | Mini-Diamond | 538 sales, new variant |
| 25 | 2025 BCP Fuchsia Geometric Refractor (any player) | Fuchsia Geometric | Color-subvariant validation |
| 26 | 2025 Bowman Draft Chrome Green Refractor (any player) | BDC Green base | PR #186 fix — was 0 pre-CF |
| 27 | 2025 BDC Gold Refractor (any player) | BDC Gold base | 14.5× empirical |
| 28 | 2025 BDC Orange Refractor (any player) | BDC Orange base | 27.2× empirical |
| 29 | 2025 BDC Aqua Wave Refractor (any player) | Aqua Wave | v2 new entry |
| 30 | 2025 BDC Bowman Logofractor (any player) | Logofractor | Niche variant |

### Class D — Auto vs base disambiguation (validate PR #186 + #194 paths)

Same set + same parallel name, but one is AUTO (CPA-XX) and one is BASE (BCP-XX). The engine must resolve to the correct variant.

| # | Card | Resolves to |
|---|---|---|
| 31 | 2024 Bowman Chrome Prospects Refractor Bryce Eldridge AUTO (CPA-BE) | Auto path |
| 32 | 2024 Bowman Chrome Prospects Refractor Bryce Eldridge BASE (BCP-XX) | Base path |
| 33 | 2025 BCP Green Lava /150 AUTO (CPA-XX) | Auto Green Lava (32.5× empirical) |
| 34 | 2025 BCP Speckle /299 BASE (BCP-XX) | Base Speckle Refractor (2.84× empirical) |
| 35 | 2024 BCP Caleb Bonemer Blue Wave AUTO | Auto BCP class |

### Class E — Prospect-auto resolution (validate PRs #178 + #181)

Volume Test #1's 5 broken cases (Harper $11/$424, Tatis, Acuña, Dominguez, Mayer). Should now resolve correctly with the search-filter + matcher-rejection layers.

| # | Card | V1 outcome | Expected V2 |
|---|---|---|---|
| 36 | 2011 Bowman Chrome Bryce Harper Prospect AUTO | $11 (matched BCP111 base) | Auto-tier price ($400+) |
| 37 | 2016 Bowman Chrome Tatis Jr. 1st Bowman AUTO | $9 | Auto-tier |
| 38 | 2017 Bowman Chrome Acuña Jr. 1st Bowman AUTO | $6 | Auto-tier |
| 39 | 2020 Bowman Chrome Dominguez 1st Bowman AUTO | $3 | Auto-tier |
| 40 | 2021 Bowman Chrome Marcelo Mayer 1st Bowman AUTO | $3.50 | Auto-tier |

### Class F — Non-baseball (Volume Test #1 didn't cover)

Should hit `unsupportedSport` graceful response OR (if CH supports) calibrate against CH's basketball/football data.

| # | Card | Sport | Why |
|---|---|---|---|
| 41 | 2018 Panini Prizm Luka Doncic RC | Basketball | Verify cross-sport handling |
| 42 | 2019 Panini Prizm Zion Williamson RC | Basketball | |
| 43 | 2020 Panini Prizm Justin Herbert RC | Football | |
| 44 | 2017 Panini Prizm Patrick Mahomes RC | Football | Established QB |
| 45 | 2003-04 Upper Deck LeBron James RC | Basketball | Vintage modern |

### Class G — Year-mismatch (validate PR #182 telemetry)

Cards where the user vocabulary doesn't match CH's catalog. Should emit `year_mismatch_resolved` events.

| # | User typed | CH catalog likely says |
|---|---|---|
| 46 | "2000 Bowman Chrome Miguel Cabrera" | 2003 Bowman Draft Picks & Prospects (3yr drift) |
| 47 | "2001 Bowman Chrome Joe Mauer" | 2003 BDPP (2yr drift) |
| 48 | "2015 Bowman Chrome Vlad Jr." | 2026 Bowman Mega Box (11yr drift) |
| 49 | "2021 Bowman Chrome Elly De La Cruz" | 2026 Bowman Mega Box (5yr drift) |

### Class H — Per-card FMV drift validation (PR #183)

Cards where we'd expect engine vs CH FMV to disagree by >30%. The `engine_vs_ch_fmv_audit` event should fire with `isDrift: true`.

| # | Card | Why expect drift |
|---|---|---|
| 50 | 2015 Topps Chrome Kris Bryant RC PSA 10 | V1 showed engine 2× CH — drift bug suspect |
| 51 | 2013 Topps Chrome Nolan Arenado RC PSA 10 | V1 showed engine 1.57× CH |
| 52 | 2009 Bowman Chrome Mike Trout 1st Auto BGS 9.5 | High-end auto, thin comps |
| 53 | 2018 Topps Update Soto RC US300 | V1 showed engine $5 vs CH $26 (5×) |
| 54 | 2006 Topps Update Kershaw RC | V1 showed engine $10 vs CH $608 (60×) |

### Class I — Vendor-naming gaps (still need your input)

These 3 combos still return `no_parallel_cards_found` because we don't know the CH-canonical variant name. Volume test data may help us identify them.

| # | Card | Question |
|---|---|---|
| 55 | 2025 BCP Yellow Lava /75 | What does CH call this? |
| 56 | 2025 BCP Orange Lava /25 | What does CH call this? |
| 57 | 2025 BCP Aqua /125 | What does CH call this? (we tried Geometric + Pulsar — those are real but different print runs) |

### Class J — Newly-discovered v2 entries (validate v2 re-cal in flight)

When v2 lands (next reprice cycle after merge), these should hit empirical not fallback:

| # | Card | Was | V2 expected |
|---|---|---|---|
| 58 | 2024 Bowman Chrome Prospects Refractor (any prospect) | Static | Empirical (2024-specific) |
| 59 | 2024 Bowman Draft Chrome Aqua Wave | Static | 11.6× empirical |
| 60 | 2025 Topps Chrome Update Pearl Refractor | Static | Empirical |
| 61 | 2024 Topps Chrome Update Refractor | Static | Empirical |
| 62 | 2024 BDC Sky Blue Refractor /125 | Static fallback | New empirical |

### Class K — Audit + monotonicity validation (PRs #185 + #188)

| # | Card | Why |
|---|---|---|
| 63 | 1969 Topps Mike Schmidt PSA 10 (1970-1989 era, n=1 in calibration) | Hit a low-sample combo — should fall to fallback gracefully |
| 64 | 1976 Topps Brett Jr. RC PSA 9 | Mid-tier vintage |
| 65 | 1982 Topps Traded Cal Ripken RC PSA 10 | 1970-1989 PSA 10 row |

### Class L — Free-text edge cases (validate dispatcher resolution)

| # | Query | Why |
|---|---|---|
| 66 | "Trout 2011" | Year + player only, no set |
| 67 | "Bryce Harper" | Player only — many cards |
| 68 | "PSA 10 Kobe Bryant rookie" | Multi-sport, grade in query |
| 69 | "1986 Donruss Jose Canseco RC" | Established but non-Bowman/Topps |
| 70 | "Garbage Pail Kids 1985" | Sport-unknown handling |

## What to look for after the test

After the 70-card import + reprice cycle:

1. **Class A**: All 10 vintage HOFs have a real Raw FMV (not null, not insanely high). Sanity check Mantle ≤ $200K, Aaron ≤ $50K, etc.
2. **Class B before flag flip**: Modern PSA 10 base values match the static table (PSA 10 / $20 raw → ~$98).
3. **Class B after flag flip**: Same cards should jump to empirical (PSA 10 / $20 raw → ~$222, +127%).
4. **Class C**: Empirical parallel ratios surface in compsUsed / fairMarketValue. Reptilian Refractor at ~2.1× base.
5. **Class D**: Auto and base variants get correctly disambiguated — auto comes back at autograph-tier prices, base at insert-tier prices.
6. **Class E**: All 5 prospect-autos resolve to autograph-tier ($200+), not base-insert ($3-11).
7. **Class F**: Cross-sport queries either return a CH-calibrated price OR a graceful "unsupported sport" response.
8. **Class G**: Each query emits a `year_mismatch_resolved` event with the user-typed year, resolved year, and matched cardId.
9. **Class H**: Each card emits an `engine_vs_ch_fmv_audit` event. The flagged drift cases (V1 known) should still drift unless we shipped a fix for them.
10. **Classes I, J, K, L**: Various — see specific notes per class.

## KQL queries for post-test analysis

```kusto
// Year mismatches surfaced
traces
| where customDimensions.event == "year_mismatch_resolved"
| where ago(1d) < timestamp
| project query=tostring(customDimensions.query),
          userYear=toint(customDimensions.userYear),
          resolvedYear=toint(customDimensions.resolvedYear),
          yearDelta=toint(customDimensions.yearDelta),
          matchSource=tostring(customDimensions.matchSource)

// Engine vs CH drift events
traces
| where customDimensions.event == "engine_vs_ch_fmv_audit"
| where customDimensions.isDrift == "true"
| where ago(1d) < timestamp
| project chCardId=tostring(customDimensions.chCardId),
          grade=tostring(customDimensions.grade),
          engineFmv=todouble(customDimensions.engineFmv),
          chFmv=todouble(customDimensions.chFmv),
          ratio=todouble(customDimensions.ratio)
| order by abs(1 - ratio) desc

// Ladder fallback firings (which holdings the ladder rescued)
traces
| where customDimensions.event == "autoprice_grade_ladder_fallback_applied"
| where ago(1d) < timestamp
| summarize n=count() by source=tostring(customDimensions.source),
                          anchorGrade=tostring(customDimensions.anchorGrade)
| order by n desc
```
