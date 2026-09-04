# Lane B (vintage sports): every permissive source probed, nothing acquirable

**Probe run 2026-09-03.** Target: the "genuinely absent" vintage cells of
`2026-09-03-checklist-gaps-for-comp-matching.md` (PR #1689) — football `topps`
1948-1989, basketball `topps`/`upper-deck`/`fleer`/`skybox`, hockey
`o-pee-chee` 1933-1989.

**Outcome: 0 checklists staged.** Not a pipeline failure — the sources that
carry these years either forbid automated collection in their terms, or do not
serve the sets. Every claim below is a measurement taken live, with the command
in-line so it can be re-run.

---

## 1. Permissions, quoted before fetching

| Host | robots.txt | Terms | Verdict |
|---|---|---|---|
| `www.beckett.com` | `User-agent: *` with **no `Disallow`** | No terms page exists — `/terms`, `/terms-of-use`, `/terms-of-service`, `/terms-and-conditions`, `/legal`, `/user-agreement` all **404**. Privacy policy references "Terms and Conditions, accessible from beckett.com"; that document is not served. No scraping/robots/data-mining clause found. | **GO** (polite rate, real UA) |
| `www.tcdb.com` | Checklist paths (`/ViewSet.cfm`) not disallowed | **"Robots and Screen Scraping: You may not use data mining, robots, screen scraping, or similar data gathering and extraction tools on this site."** Also: "limited license to access and make personal and **non-commercial** use... may not be reproduced, duplicated, copied... or otherwise exploited for any commercial purpose without express written consent." | **STOP** |
| `www.hobbymonitor.com` | `User-agent: * / Allow: / ... Allow: /releases`; disallows only `/admin/`, `/api/`, `/app`; `Crawl-delay: 1-2` for named bots | `/terms` is a client-rendered SPA shell and serves no terms text to a plain fetch — **could not be quoted** | **GO on robots**, terms unverifiable |
| `baseballcardpedia.com` | no robots.txt (404 => unrestricted) | already an accepted in-repo source (1989 O-Pee-Chee) | GO — but **baseball only** |

> **TCDB is the headline.** The brief said to "fall back to TCDB with its terms
> quoted." Quoted, the terms forbid exactly this use, twice over — automated
> extraction, and commercial use. HobbyIQ is a commercial product, so the
> non-commercial licence is not curable by rate-limiting or attribution. TCDB
> is STOP until someone obtains the "express written consent" the ToU names.

## 2. Beckett does not carry these sports

The scraper's own header documents this; it reproduces exactly.

```
/news/category/baseball/baseball-card-checklists/     -> HTTP 200, 93 set links
/news/category/football/football-card-checklists/     -> HTTP 404
/news/category/basketball/basketball-card-checklists/ -> HTTP 404
/news/category/hockey/hockey-card-checklists/         -> HTTP 404
```

Baseball 200 alongside three 404s is a category gap, not an outage.

**The site search cannot rescue it.** `?s=1972+topps+football+checklist` and
`?s=zzzznonsensequery12345` return a **byte-identical** link set (`diff -q` on
the sorted hrefs: identical). The search returns a static sidebar, not results.

**And the archive has no vintage anyway.** Year histogram over sampled pages
(1, 5, 10, 15, 20, 25, 29) of the baseball archive:

```
1951:3  1981:3  1983:3  1985:6  1991:3  1992:3
2016:30 2017:60 2018:60 2019:156 2020:78 2021:135
2022:144 2023:48 2024:147 2025:60 2026:261
```

All seven pre-1993 slugs are **baseball**, and one ("1951 Topps by Blake
Jamieson") is a modern retro insert, not a 1951 checklist. Beckett's practical
floor is ~2016. Spot-check of a real vintage page
(`/news/1983-topps-traded-baseball-cards/`, HTTP 200, 217 KB): **zero `.xlsx`
links** — vintage pages are prose articles, not checklist workbooks, so the
`convertBeckettChecklistXlsx` lane has nothing to consume.

## 3. HobbyMonitor: sparse, and base-only where present

| Release URL | HTTP | Reported shape |
|---|---|---|
| `/release/1957-topps-football` | 200 | `1 sets - 157 cards - `**`0 parallels`** |
| `/release/1986-topps-football` | 200 | `3 sets - 438 cards - `**`0 parallels`** |
| `/release/1972-topps-football` | 404 | — |
| `/release/1986-fleer-basketball` | 404 | — |
| `/release/1991-92-upper-deck-basketball` | 404 | — |
| `/release/1979-80-o-pee-chee-hockey` | 404 | — |

Two of six probed resolve, and both report **0 parallels**.

`backend/data/ingest-universe.json` already records these same cells under
`unreachable` — *"the source itself does not serve this set (404/403/absent);
not a defect in our pipe"* — including football `topps` 1969/1970/1971/1972 and
basketball `upper-deck` 1992. A prior run reached this conclusion; this probe
confirms it rather than discovering it.

## 4. The acceptance bar is wrong for vintage — measured

The brief (inheriting PR #1689's corpus-wide finding) says a base-only
checklist "does not count as done" because the missing axis is the parallel
ladder + printRun. **That finding does not hold for these cells.** Read-only
`sold_comps` aggregation, `GROUP BY c.parallel`:

| Cell | Pool rows | `Base` | Base share | Rows with a `printRun` |
|---|---:|---:|---:|---:|
| football `topps` 1948-1989 | 294,469 | 293,942 | **99.8%** | **4** |
| hockey `o-pee-chee` 1933-1989 | 41,471 | 39,848 | **96.1%** | **8** |
| basketball `skybox` 1991-2008 | 66,385 | 62,603 | **94.3%** | **39** |
| basketball `upper-deck` 1991-2009 | 109,117 | — | — | **0** |

**51 print-run-bearing rows out of ~520,000.** Vintage cards mostly have no
parallel ladder and no serial numbering; the corpus-wide "1.1M filled:printRun"
signal comes from modern parallel-heavy products. For Lane B, **the base
checklist IS the acquisition** — and the non-`Base` remainder is largely
*subsets and inserts* ("Record Breaker", "In Action", "All-Star", "Star
Rubies"), not serial-numbered parallels.

> Recommend the orchestrator relax the Lane B acceptance bar to
> **base + named subsets/inserts, printRun blank**, and treat a demand for
> print runs on pre-1990 cardboard as a spec error. Blank still means unknown,
> never "Base".

## 5. Pool demand is real and confirmed

Live read-only counts (prod `hobbyiq-comps`) corroborate PR #1689 within
rounding: football topps 1948-89 **294,469** (doc: 289,203); hockey o-pee-chee
1933-89 **41,471** (doc: 41,475); basketball fleer 1990-2009 **118,493**;
basketball skybox **66,385**; basketball upper-deck 1991-2009 **109,117**.
The demand justifies acquisition; only the supply is missing.

*One correction worth recording:* an initial probe reported hockey O-Pee-Chee
at **4 rows** and appeared to contradict the doc. That was a query artifact —
it matched `'o pee chee'` (spaces) while the pool spells it `O-Pee-Chee`
(hyphens). Re-run hyphen-correct, it is 41,471. The doc was right.

## 6. Blockers, and what would unblock them

1. **TCDB ToU** — the only comprehensive vintage multi-sport checklist source
   found. Needs *express written consent* (a licensing conversation), not a
   technical workaround. **Drew's call.**
2. **No permissive vintage football/basketball/hockey source identified.**
   Beckett is baseball + modern; hobbymonitor is sparse and base-only;
   baseballcardpedia is baseball-only (404 on all three non-baseball probes);
   Cardboard Connection is DNS-dead; checklistinsider mints autos UNSIGNED and
   is excluded; Topps/Panini/Upper Deck official sites are STOP.
3. **Nothing was staged, so nothing is queued.** No CSVs, no manifest edits, no
   dispatch. Staging a base-only file scraped from a source that reports "0
   parallels" would have added rows that trace to a page carrying no ladder —
   and inventing the ladder is forbidden ("every row traces to a scraped
   source; no synthetic parallels").

## 7. Caveats

- Beckett's absent terms page is *absence of evidence*: robots.txt is
  permissive and no clause was found, but a ToU may exist behind a path not
  probed. The GO verdict rests on the bare `User-agent: *`.
- HobbyMonitor's terms could not be read at all (SPA). Its robots.txt is
  explicitly permissive for `/releases`, which is the basis for the GO.
- Parallel shares are pool-side demand, not checklist truth: they say what
  buyers' titles name, which is what a comp must match.
- All Cosmos access was read-only `COUNT`/`GROUP BY`. No writes, no dispatches.
