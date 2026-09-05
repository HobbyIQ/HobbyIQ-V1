# Top-50 gap census — baseball / hockey / soccer-wrestling-non-sport

**Date:** 2026-09-05 · **Mode:** READ-ONLY against prod Cosmos; one manifest write in this repo · **Scope:**
the census's baseball, hockey and "other" (soccer / wrestling / non-sport) cells, plus the source
discovery those cells were said to need.

Companion to `checklist-gaps-2026-09-05.md`, which ranked the gaps. This one answers the question that
report deferred: **for each gap, is it truly missing, or is it a key / URL-form miss on a source we
already have?**

## Headline

**Not one gap in this domain needed a new publisher.** Every one is a key miss, a cell-scope miss, or a
lane with an unfetched backlog. Two distinct defects, and neither is an acquisition:

1. **Four vintage baseball products the census called "no permissive source" are served by
   sportscardchecklist.com and always have been** — 11,256 + 3,156 + 6,578 + 4,516 rows, **$10.7M of
   12-month sales**. They were invisible because `discoverSportsCardChecklistSets.cjs` scoped baseball to
   1980-2003. Fixed here: the cells are widened, the manifest carries all four, and the committed parser
   reads every one of them cleanly.
2. **The modern hockey and soccer gaps are a granularity mismatch, not a gap.** Our sales flatten a
   specific product to a bare flagship key while the checklist sits under the specific key. `soccer 2025
   panini-prizm` is **98.8% FIFA by title** and `panini-prizm-fifa` holds **30,773 strict checklist rows**.
   Reported, not fixed — a rekey is a vocabulary ruling, and two of them are contested.

## 1. The vintage baseball cells — FIXED

The census marked these "not-enumerated / source gap — check the sportscardchecklist sitemap". I checked
the sitemap. All four are there.

| Gap | rows 12m | rows all | $ 12m | scc set page | cards parsed |
|---|---:|---:|---:|---|---:|
| baseball 1933 `goudey` | 5,378 | 11,256 | $3,733,108 | `set-51915/1933-goudey-baseball-…` | **241** |
| baseball 1948 `leaf` | 1,556 | 3,156 | $4,432,015 | `set-36586/1948-49-leaf-baseball-…` | **101** |
| baseball 1909 `t206` | 2,471 | 6,578 | $1,389,491 | `set-86884/1909-11-t206-baseball-…` | **524** |
| baseball 1948 `bowman` | 2,672 | 4,516 | $1,129,357 | `set-11583/1948-bowman-baseball-…` | **50** |

Three of those counts are externally checkable facts about the sets rather than numbers this repo chose:
**524** is the canonical T206 "monster" count, **241** is Goudey's 240 plus the #106 Lajoie, and **101** is
Leaf — which is *skip-numbered*, so #2 legitimately does not exist. All four parse with **both page anchors
agreeing and 0 rows skipped**.

### Why they were invisible

`discoverSportsCardChecklistSets.cjs` classifies a set URL against a hand-listed cell table. Baseball
opened at **1980** (Topps/Bowman), **1985** (Fleer) and **1990** (the junk-wax brands), so a 1933 URL
classified as `null` and no manifest entry was ever minted. **"No permissive source" was a statement about
this repo's cell list, not about the web.**

That file already carries three separate notes recording this exact failure — *"the discovery never knew
about it"*, *"the Fleer coated reprints were invisible too"*, *"the 1990s brands the rematch cannot
place"* — each promising the remaining cells are "a later, deliberate widening, and this file is now the
place that widening happens". This is the fourth, and the first driven by a census rather than a hand-grep.

### The split-year trap, again — and this time it bit the brands

Two of the four carry a **split-year slug**: `1948-49-leaf-baseball-` and `1909-11-t206-baseball-`. The
lane's URL regex has accepted both year forms since 2026-09-04, but the *cell year is the first year*
(1948, 1909) — which is how the pool spells them (`hiq:baseball:1909:t206:`). A cell opening at 1949 or
1910 would miss both. Pinned.

### What was changed

- **7 baseball cells** (`topps` 1948-1979, `bowman` 1948-1979, `fleer` 1959-1979, `o-pee-chee` 1960-1979,
  `goudey` 1933-1941, `leaf` 1948-1960, `t206` 1909-1911) and **2 hockey cells**
  (`upper-deck` 2005, `upper-deck` 2015).
- **2 new BRAND_RE patterns** — `goudey` and `t206`. Both are needed or the cell matches nothing silently;
  the script's load-time guard refuses a cell whose brand has no pattern, which is what makes adding one safe.
- **+1,369 manifest entries**, 16,746 → **18,115**. All four gap sets present, each keyed exactly as the
  pool spells it (`goudey`, `leaf`, `bowman`, `t206` — all verified `normalizeSetKey` fixed points, so the
  rows land findable rather than repeating #1614).

Scoped **deliberately**. The source serves 523 pre-1980 baseball sets across a long oddball tail (Kahn's
Wieners, Bazooka, Kellogg's, Hostess, Milton Bradley…) and 7,082 hockey Upper Deck sets across 1990-2018.
Opening all of them mints a queue nobody budgeted — the objection the existing cell notes already record.
These are the brands and years backing the census's own gap rows.

## 2. The modern hockey / soccer gaps — REPORTED, not fixed

These are **not** source gaps. Our sales carry a flat flagship key; the sales titles state the specific
product; the checklist already exists under the specific key. Measured by sampling stored sale titles:

| Gap (flat key) | rows all | What the titles actually say | Where the checklist already is |
|---|---:|---|---|
| hockey 2024 `upper-deck` | 13,907 | Series 1, Series 2 18.6%, Young Guns 14.0% | `upper-deck-series-1` **5,535** · `-series-2` **5,925** · `-extended-series` **4,616** strict |
| hockey 2023 `upper-deck` | 9,633 | Young Guns 37.0%, Series 1 31.2%, Series 2 2.9% | `upper-deck-series-2` **5,121** strict |
| soccer 2025 `panini-prizm` | 2,384 | **98.8% FIFA** | `panini-prizm-fifa` **30,773** strict |
| soccer 2025 `topps-chrome` | 4,744 | UEFA 74%, MLS 14.3%, Premier League 6.2%, Bundesliga 5.2% | `topps-chrome-mls` **28,136** strict |

**A rekey here is a vocabulary ruling, not a script decision**, and two of these are genuinely contested:

- *Young Guns* is a **subset of** UD Series 1/2, not a sibling product — folding it to a flagship would be
  correct, folding it to a product would split the pool.
- *Topps Chrome soccer* is four different competitions (UEFA / MLS / Premier League / Bundesliga) under one
  key. Only MLS has a checklist. Folding all four onto `topps-chrome-mls` would put three competitions'
  sales in the wrong pool — the exact Tiffany-in-the-flagship-pool damage of #1715, in a new costume.

**HALT for a ruling.** Recommended, in order: `soccer 2025 panini-prizm → panini-prizm-fifa` (98.8%
single-destination, cleanest), then the hockey UD series split by stated series word.

### hockey 2025 `bowman` is not a checklist gap at all

2,863 rows, and sampling the titles shows **77% are not Bowman** — they are Flair, SPx, Upper Deck Young
Guns, Panini Stars & Stripes. This is a slug-derivation defect. No checklist can fix it; it belongs with
the `setKey=unknown` / `player-` pseudo-number class the parent census already flags as bigger than any
gap in its own top 20.

## 3. Lanes with an unfetched backlog — zero discovery needed

The census marked hockey 2020-2022 Upper Deck "needs a permissive source; hobbymonitor is the only modern
candidate". **The `clc` lane already enumerates every one of them**, unfetched:

- `clc` hockey 2019-2022: Series 1, Series 2, Extended Series, Artifacts, Allure, MVP, The Cup, Ice,
  Black Diamond, Trilogy, Synergy, Parkhurst, Stature, Credentials, Ultimate Collection… ~100 entries, all
  `missing`.
- `clc` soccer: **2022 Panini Prizm Premier League** — the census's own #9 "other" gap — plus 2020 and 2021.
- `sportscardchecklist` hockey 1969-70 O-Pee-Chee: enumerated; the lane wrote **301 strict rows on
  2026-09-05** while this report was being written. The backlog is being worked.

These need a **dispatch**, not a source.

## 4. Source discovery — 23 candidates evaluated

Required by the task even though the answer turned out to be "we already had it". Robots.txt read first on
every domain; ToS read where one exists. **No site was crawled beyond evaluation.**

### GO — permissive, useful

| Site | robots `*` | ToS | Format | Coverage of this domain |
|---|---|---|---|---|
| **sportscardchecklist.com** | `Disallow: /?*`, `/*.htm$` — checklist paths clear, sitemap advertised | none served (11 paths 404) | `/set-N/slug`, server-rendered, two parse anchors | **All four vintage gaps**; hockey 2005 (308 sets) + 2015 (875); 18,856 hockey pages total |
| **baseballcardpedia.com** | **404 = no restrictions** (apex only; www fails TLS) | none; **no content licence declared** | MediaWiki, numbered list, RC/SP/VAR/UER inline | 1933 Goudey, 1948 Bowman; **1948 Leaf is filed as `1949_Leaf`**; T206 absent |
| **t206resource.com** | **404 = no restrictions** | none found | clean HTML tables, **back variants modelled** | T206 only — but deeply, incl. Piedmont/American Beauty backs |
| **gpkworld.com** | **404 = no restrictions** | none | HTML table, handles GPK a/b twin names natively | GPK OS 1-16 + 2025 40th anniversary |
| **nslists.com** | `User-agent: * / Disallow:` (fully open) | images restricted, **text unrestricted** | fixed-width plain text | legacy non-sport (Star Wars, Trek, Marvel) — **pre-2018 only** |
| **checklistinsider.com** | `Disallow: /cdn-cgi/` only | — | already a strict source | 2025 Topps Chrome UEFA |
| **cartophilic-info-exch.blogspot.com** | `Disallow: /search` only | none | numbered text, **40+ parallels with print runs** | deep soccer archive, 1880s→present |

### STOP — ruled out

| Site | Why |
|---|---|
| **hockeydb.com** | robots permits, but `/copyright.html` states verbatim: *"Access to hockeydb.com by a web crawler or 'bot with the purpose of capturing the content is expressly prohibited."* Invokes unfair-competition misappropriation. **The most obvious hockey source, and it is closed. Recorded so nobody re-proposes it.** |
| **t206cards.com** | `ClaudeBot`, `Claude-Web`, `anthropic-ai` each named with `Disallow: /` |
| **gogts.net** | `ClaudeBot Disallow: /` + EU DSM Art. 4 reservation (`ai-train=no`) |
| **cardlines.com** | explicit `User-agent: ClaudeBot / Disallow: /` |
| **waxpackhero.com** | Squarespace stacked group naming `anthropic-ai` / `ClaudeBot` |
| **checklistcenter.com** | no wildcard block, but ~150 individually named agents each `Disallow: /` — an unambiguous blanket refusal that simply has not been updated. Treat as STOP despite already being a strict source. |

### Flagged for Drew — permissive by the letter, adverse by intent

**cardboardconnection.com is ALIVE.** Memory records it as *"DNS-dead"*; that is **stale**. It resolves,
serves robots.txt, and publishes a 10-part WordPress sitemap. Its wildcard block permits checklist paths,
and it is already on the strict-source allowlist.

**But** it separately sets `Disallow: /` for **CCBot, Google-Extended and GPTBot** — AI crawlers — while
permitting search engines. `ClaudeBot` is not named, so a literal reading permits us. The operator's intent
plainly does not. It has the best coverage of the modern non-sport gaps (Marvel / Disney / Star Wars) and
carries print runs the other sources lack. **I did not build on it. This needs Drew's explicit go, not my
assumption.**

Also flagged: **baseballcardpedia declares no content licence at all** — reuse rests on factual card data
being uncopyrightable, not on a grant. Worth a look before it carries more weight than it already does.

## 5. Still missing — no permissive source found

| Gap | rows 12m | Why |
|---|---:|---|
| non-sport 2026 `topps-chrome` (Marvel) | 8,226 | scc non-sport stops at 2018 (136 pages, all Leaf Pop Century). Only cardboardconnection plausibly covers it — see the intent flag above. |
| non-sport 2025 `topps-chrome` (Disney) | 3,402 | same |
| other 2025/2026 `topps`, `panini-donruss`, `bowman` | ~7,900 | modern non-sport / multi-sport; Beckett 403 since 2026-09-04 is why this class exists |
| wrestling 2024 Panini WWE | — | scc wrestling stops at 2019. `cardsmithsbreaks.com` is technically permissive and has a full 2024 Prizm WWE checklist — **unevaluated for format; worth a follow-up** |

scc soccer likewise stops at **2019**, so the modern soccer gaps are the clc backlog (§3) and the rekeys
(§2), not this source.

## Reproducing

```
# sitemap survey (30 child sitemaps, polite, cached)
node scripts/discoverSportsCardChecklistSets.cjs --cache <dir>          # report only
node scripts/discoverSportsCardChecklistSets.cjs --cache <dir> --apply  # append entries

# the parser, offline, on the committed fixtures
node scripts/fetchSportsCardChecklist.cjs --html tests/fixtures/sportscardchecklist/1909-11-t206-baseball.trimmed.html \
  --out /tmp/t206.csv --url https://www.sportscardchecklist.com/set-86884/1909-11-t206-baseball-trading-card-checklist \
  --year 1909 --set-key t206 --set-name "1909-11 T206 Baseball" --sport baseball

npx vitest run tests/sccVintageBaseballCells.test.ts
```
