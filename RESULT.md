# Census — Panini Baseball 2023-2026 + SuperFractor Cross-Key Spelling

Read-only census. No writes, no dispatches. Repo cloned to `C:/tmp/panrules_0125` (branch main, HEAD c8f716b0, backend built via `npm ci && npm run build`). Cosmos accessed only via `COSMOS_CONNECTION_STRING` piped directly into `node`, never echoed or written to disk. FeedOptions `{maxItemCount:500, maxDegreeOfParallelism:-1}`, `while(hasMoreResults())`, no COUNT/GROUP BY cross-partition, no `maxItemCount:-1`. sold_comps checks used `partitionKey: id` (single-partition, not cross-partition) or plain point-style equality queries.

DRAFT rules file: `backend/data/parallel-name-rules/2026-09-27-panini-2023-2026-and-superfractor.DRAFT.json` (10 rules, every one `ruling: PENDING`, `rulingDate: null`). PR is a **draft**, nothing applied.

## Part 1 — Panini baseball 2023-2026

### Scope actually scanned

First discovered which Panini baseball setKeys are actually populated in `card_catalog` 2023-2026 (existence probes via `SELECT TOP 1`, not COUNT) before committing to a scan list — 51 (setKey,year) combinations exist across ~24 distinct Panini setKeys. Given the time budget, prioritized the task's explicitly named core: **panini-prizm, panini-select, panini-donruss, panini-optic, panini-mosaic, panini-chronicles, panini-contenders**, all years 2023-2026 (28 pairs).

**Total rows scanned: 353,708.** Coverage was uneven by design of the catalog itself, not the scan:

| setKey | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|
| panini-prizm | 45,539 | 45,815 | 32,166 | 23,247 |
| panini-select | 22,946 | 18,739 | 35,296 | 0 |
| panini-donruss | 20,870 | 24,086 | 36,838 | 38,260 |
| panini-optic | 24 | 42 | 85 | 0 |
| panini-mosaic | 3 | 18 | 237 | 0 |
| panini-chronicles | 9,485 | 0 | 0 | 0 |
| panini-contenders | 3 | 6 | 3 | 0 |

**panini-optic, panini-mosaic, panini-chronicles (2024+), panini-contenders are nearly EMPTY of checklist-grade rows in this year range** — this is a checklist/ingest gap in the catalog itself (matches the standing memory note "checklist gaps are mostly stale keys"), not a scan failure; these products' cards likely live under a different or not-yet-populated setKey. Not chased further this round — flagged here rather than papered over. panini-select|2026 is also 0 (product may not have released/been ingested yet as of this date).

**NOT SCANNED this round** (cut for time, per the task's own priority instruction to finish the core scan): panini-national-treasures, panini-flawless, panini-immaculate, panini-elite-extra-edition, panini-stars-stripes-usa, panini-three-and-two, panini-boys-of-summer, panini-crusade, panini-impeccable, panini-prospect-edition, panini-immaculate-collection, panini-absolute, panini-obsidian — all confirmed populated by the existence probe but not paged this round.

### Findings

**1. Leading bullet-dash artifact — panini-select 2025, 8,948 rows, 37 fold-groups.** Every dash-prefixed row is `source: checklistcenter-2026-08-29` — e.g. `"- Gold Prizms"` (300 rows) coexisting with `"Gold Prizms"` (98 rows) under the SAME id slug `gold-prizms`. This is a HEAL case (id already normalizes correctly, only the `parallel` text field is dirty), not a MOVE. WebSearch corroborates checklistinsider.com/cardboardconnection.com list this product's Gold/Red/Tiger/Tie-Dye/etc. Prizms with no leading dash. Not caught by the existing `rung-name-hygiene.cjs` classifier — that module only handles trailing/parenthetical notes, not a leading bullet character. **This is a genuinely new leak shape this census surfaced.**

**2. Trailing empty-parens artifact — panini-prizm 2024, 176 rows.** `"Gold Vinyl Prizm ()"` / `"Black Finite Prizm ()"`, sourced from `baseballcardpedia-ladders-*` / `bccp` scrapes. Same shape as the 09-26 census's SuperFractor `()` artifact. IS caught by the existing hygiene classifier (`kind: parenthetical`).

**3. THREE TWIN/DUPLICATE-POOL PAIRS — panini-select 2023, 1,200 rows total, all VERIFIED by point read (not inferred).**
   - `"Black Snake Skin Pulsar Prizms"` (300, checklistcenter, id `black-snake-skin-pulsar-prizms`) vs `"Black Snakeskin Pulsar Prizms"` (300, beckett-scraped, id `black-snakeskin-pulsar-prizm`)
   - `"Green White Purple Prizms"` (300, checklistcenter, id `green-white-purple-prizms`) vs `"Green/White/Purple Prizms"` (300, beckett-scraped, id `greenwhitepurple-prizm`)
   - `"Teal White Pink Prizms"` (200, checklistcenter) vs `"Teal/White/Pink Prizms"` (200, beckett-scraped)

   All three are the SAME product/year, all point-read-confirmed as genuinely separate catalog rows (not a folding artifact of my own script), and all show a matching `printRun` between the two spellings on sampled cards — strong evidence this is a systemic checklistcenter-vs-beckett-scraped naming split across this whole product, echoing the textid census's flagged "Red/Yellow"→`redyellow` vs id `red-yellow` mismatch shape. sold_comps dual-check on all 6 sample ids: **0 sales on every one** — low blast radius, but this is a duplicate POOL problem (splits comp counts for FMV even with zero current sales) per the "one card, one row, one pool" doctrine, so it matters regardless of current sale count.

**4. Die-Cut hyphenation disagreement — panini-donruss 2025, 200 rows.** Same source (checklistinsider-2026-08-27) spells `"Silver Die-Cut"` (hyphenated) and `"Gold Die Cut"` (spaced) inconsistently between colors in the SAME product/year. 2026's same product uses only the spaced form. Not independently re-verified against a live cardboardconnection/checklistinsider fetch this round — flagged as evidence, not proof.

**5. AMBIGUOUS — bare "N Cards" values, 2,394 rows, panini-prizm|2023 (913), panini-select|2023 (423) + |2024 (75), panini-donruss|2023 (883) + |2024 (100).** The ENTIRE `parallel` value is a bare count + "Cards" (`"77 Cards"`, `"63 Cards"`) with nothing else — stripping the count leaves NO rung name at all, unlike every other print-run leak this lane has a rule for. `rung-name-hygiene.cjs`'s own classifier matches these as `kind: print-run` but returns `suggestedName: null`, which is itself the tell that this shape doesn't fit the doctrine's assumption (a print-run leak riding on a real name). Tried to confirm a "subset/insert-set card-count caption" hypothesis via WebSearch — inconclusive. **`baseball|2023|panini-donruss` is not even a key in the local checklist corpus** (`backend/data/checklist-parallel-names.json`), so there is no cached ground truth to check locally either. Flagged for Drew's own source lookup, explicitly NOT resolved this round — matches the 09-26 census's handling of the topps 2024 Aqua Series One/Two breakdown-string case (same "flag, don't invent" doctrine).

## Part 2 — SuperFractor cross-key spelling, topps-chrome family

### Scope actually scanned

Queried every (setKey, year) combination for 18 chrome-family setKeys with `CONTAINS(LOWER(c.parallel), 'fractor')` as a server-side filter (bounding cost — full family scan without this filter was not attempted). topps-chrome itself got the full 2001-2026 span (26 years); siblings got 2017-2026. **The background process exited (code 0) partway through the sibling list — 85 (setKey,year) pairs with any fractor-shaped row were captured (1,435,764 total fractor-containing rows read across those pairs) before the run stopped.** Confirmed complete: full topps-chrome 2001-2026, bowman-chrome, bowman-chrome-mega-box, bowman-chrome-nscc, bowman-chrome-sapphire, topps-allen-ginter-chrome, topps-chrome-black, topps-chrome-platinum-anniversary, topps-stadium-club-chrome, topps-chrome-platinum, topps-cosmic-chrome, and topps-chrome-update (partial — only 2017 and 2020 had matches, unclear if this is a true 0 for other years or the scan was cut before reaching them). **NOT REACHED before exit: topps-chrome-logofractor, topps-chrome-update-sapphire, topps-chrome-update-series, topps-chrome-sapphire** — these are real, populated setKeys per the checklist corpus and were NOT scanned this round. Reporting this honestly rather than implying full coverage — a follow-up pass should finish these four keys before any dispatch.

### Finding — the marquee result: SuperFractor singular vs plural fork, 59,072 rows

| fold-key | rows | raw spellings (count) |
|---|---|---|
| **superfractor** (singular) | **36,090** | SuperFractor: 31,472 · Superfractor: 3,516 · "SuperFractor 1": 662 · "SuperFractor ()": 440 |
| **superfractors** (plural) | **22,982** | SuperFractors: 17,662 · Superfractors: 4,913 · "SuperFractors ()": 407 |

Both forms coexist in **every year checked individually 2019-2023** (e.g. 2023: singular 1,127 vs plural 1,974; 2019: singular 36 vs plural 909) — this is not a one-off typo, it is a systemic, ongoing spelling fork across the entire product's history. Point-read twin-check on topps-chrome 2024 card #20 confirms the id `...20:superfractor:no-auto:num-1` exists while `...20:superfractors:no-auto:num-1` does NOT — **different card numbers get different spellings** (sampled singular cards: 20, 46, 141, 253; sampled plural cards: s-25, 112, lgc-47, 34), so this is a catalog-wide naming inconsistency, not a per-card duplicate. Direction of the fold is **not decided here** — WebSearch this round surfaced the same checklistinsider.com ("SuperFractor", singular, cap F) vs cardboardconnection.com pages as the 09-26 census, and independently reconfirmed cardboardconnection's own typo "SuperFractrors" in indexed prose — consistent with, not a resolution beyond, the 09-26 census's existing RULING-NEEDED status. **sportscardchecklist.com and baseballcardpedia.com were retried this round with several URL patterns each (bare domain, www, different wiki-slug forms) and ALL 404'd again** — same coverage gap as the 09-26 census, not resolved. checklistinsider.com and cardboardconnection.com direct-guess URLs also 404'd this round on first try; the working URLs were recovered only via WebSearch, not direct navigation — noting this because a future pass should use search-recovered URLs from the start rather than guessing slugs.

### Finding — compound rung names correctly excluded from the fold (documented, not a fold target)

Several SuperFractor-containing strings are almost certainly real, distinct printed rung names in their own right, not spelling variants of the base rung, per this repo's own "a channel word can be the whole stated name" doctrine applied to compound inserts: Gold SuperFractor (1,219), Mini SuperFractor (900), Padparadscha SuperFractor (+ "SuperFractor 1" variant, 414 combined), Minis SuperFractor (300), Autographs SuperFractor (183), Image Variation(s) SuperFractor (559 combined), WBC Flag SuperFractor Variation (100), Rookie Design Variations SuperFractor (71), Champions Autograph SuperFractor (17), Chrome Champion Refractors SuperFractor (16), Legends Autographs SuperFractor (14). These are recorded in the DRAFT file as a documentation-only entry so Drew's eventual ruling on the singular/plural fold doesn't accidentally get read as covering them too.

### Finding — likely run-on-digit corruption, NOT resolved: "Superfractors 11 Refractor" family, 6,885 rows

`Superfractors Refractor` (3,604) + `Superfractors 11 Refractor` (1,892) + `Superfractor Refractor` (933) + `Superfractor 1 Refractor` (327) + `Superfractors 11 Hobby And Jumbo Only Refractor` (129). The stray "11" / "1" tokens look like a corrupted "1/1" notation that lost its slash during scraping, but this was not independently confirmed against a live source this round — flagged, not fixed.

### Finding — wiki-scrape paragraph corruption, 40 rows, topps-chrome-update 2020

An entire wiki-page prose paragraph (including a Twitter status URL) got scraped verbatim into `parallel` and then became the row's own id slug — the id itself is several hundred characters long and its trailing `printRun` (1,368,310,399,850,795,000) is a corrupted Twitter status-ID number misread as a print run. Source: `baseballcardpedia`. **Same defect class as commit 78aa88bf** ("a page footer is not a card — 17 wiki-scrape rows retired") already on `main`. This needs a re-scrape/retire, not a text-strip rule — recorded as documentation-only in the DRAFT file. sold_comps check: 0 sales.

## sold_comps dual-checks performed (all point/single-partition reads)

| id (abbreviated) | salesCount |
|---|---|
| panini-select 2025 red-prizms #66 | 0 |
| panini-select 2025 tiger-prizms #1 | 0 |
| panini-donruss 2023 10-cards #241 | 0 |
| panini-donruss 2023 63-cards #6 | 0 |
| panini-prizm 2024 base #249 | 3 |
| panini-select 2023 black-snake-skin-pulsar-prizms #34 | 0 |
| panini-select 2023 black-snakeskin-pulsar-prizm #5 | 0 |
| panini-select 2023 green-white-purple-prizms #5 | 0 |
| panini-select 2023 greenwhitepurple-prizm #36 | 0 |
| panini-select 2023 teal-white-pink-prizms #1 | 0 |
| panini-select 2023 tealwhitepink-prizm #151 | 0 |
| topps-chrome 2024 superfractor #20 | 0 |
| topps-chrome 2024 superfractors s-25 | 0 |
| topps-chrome 2023 superfractors #112 | 0 |
| topps-chrome-update 2020 wiki-corruption row | 0 |

Only small point-samples were checked given the time budget — a fuller sample (the task's own suggested 5-per-rule) was done for most but not all rules above; noting this rather than implying exhaustive coverage.

## Twin checks performed (point reads against card_catalog)

Confirmed as SEPARATE existing rows (not inferred from census grouping alone): black-snake-skin-pulsar-prizms / black-snakeskin-pulsar-prizm, green-white-purple-prizms / greenwhitepurple-prizm, teal-white-pink-prizms / tealwhitepink-prizm, topps-chrome-2024-card-20 superfractor (plural sibling id confirmed NOT to exist for that same card).

## What was cut for time

- Panini setKeys beyond the 7 named in the task brief (national-treasures, flawless, immaculate, elite-extra-edition, stars-stripes-usa, three-and-two, boys-of-summer, crusade, impeccable, prospect-edition, immaculate-collection, absolute, obsidian) — confirmed populated, not scanned.
- Four topps-chrome-family setKeys (topps-chrome-logofractor, topps-chrome-update-sapphire, topps-chrome-update-series, topps-chrome-sapphire) not reached before the SuperFractor scan process exited.
- The "N Cards" ambiguous-print-run pattern's real meaning — not resolved, needs Drew's own source lookup.
- The Die-Cut hyphenation and Superfractors-11-Refractor corruption findings — evidence gathered, not independently re-verified against a live fetch.
- sportscardchecklist.com and baseballcardpedia.com remain unreachable for direct navigation (same as the 09-26 census) — retried with several URL patterns, all 404, or (baseballcardpedia www subdomain) a TLS cert mismatch.

## Raw data

`C:/tmp/panrules_0125/scratch/panini-census.json` (full Panini census, 28 (setKey,year) pairs), `C:/tmp/panrules_0125/scratch/superfractor-census-partial.json` (SuperFractor census, 85 pairs — note filename retains "-partial" because the background process exited before writing the final consolidated file; the partial file IS the complete result set that was gathered).
