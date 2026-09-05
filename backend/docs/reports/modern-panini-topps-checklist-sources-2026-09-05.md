# Modern Panini / Topps FB+BK checklist sources — 2026-09-05

**Read-only survey + a measured corroboration run.** Scope: the 111 product cells where
hobbymonitor is the only strict source (`hobbymonitor-corroboration-2026-09-05.md`, 657,574 rows),
narrowed to modern Panini/Topps football and basketball, 2019–2026.

Drew's ask was "let's find other sites to fill the checklists". Thirteen candidates were evaluated.
The answer this survey actually found is not a new site.

## The finding

**A permissive second source for most of these cells is already wired, already permitted, and
already in the manifest — it has simply never been run at them.**

`checklistcenter.com` (lane `clc`) holds **39 of the 111 cells / 419,273 rows (63.8%)** as manifest
entries today. **17 of those cells — 206,758 rows — have never been acquired**: they sit at
`seededStatus: missing` or `partial`, and the seeded note on the `missing` ones is
`"no catalog key for this (sport, year)"`. That is a statement about the catalog on the day the
universe was enumerated, **not** a statement that the source lacks the product. The pages are live
and carry full ladders.

The gap is concentrated exactly where the queue is: **321 of 403 unacquired clc FB/BK entries are
2019–2022**, while 2023–2025 is largely `ingested`.

| clc FB/BK 2019+ entries | count |
|---|---:|
| `ingested` | 256 |
| `missing` | 403 |
| `partial` | 13 |

## What was measured, not assumed

Three cells were fetched (2.5 s delay, one connection), converted through the **existing** pipe
(`scrape-checklistcenter-products.cjs` → `convertChecklistCenterToChecklistCsv.cjs`), and compared
against stored `card_catalog` rows. No writes; no new code was needed to do any of it.

| cell | staged rows | withPrintRun | distinct rungs | driver gate |
|---|---:|---:|---:|---|
| 2022 Panini Select FB | 22,784 | 17,093 | 88 | `ok: true` |
| 2023 Panini Mosaic FB | 21,524 | 13,603 | 74 | `ok: true` |
| 2022-23 Panini Prizm NBA BK | 18,835 | 11,908 | 59 | `ok: true` |
| **total** | **63,143** | **42,604** | | |

`gateStagedCsv` passes all three with `playersAsParallel: 0` and `cardLineParallel: 0`.

### Agreement with the stored hobbymonitor rows

Base-category rows compared on `(cardNumber, parallel, isAuto)` against hobbymonitor rows in the
same cell, both sides naming a player:

| cell | agreement | negative control |
|---|---:|---:|
| 2022 Panini Select FB | 15,559/15,600 = **99.74%** | 0.00% |
| 2023 Panini Mosaic FB | 3,591/3,600 = **99.75%** | 0.00% |
| 2022-23 Panini Prizm BK | 12,690/12,900 = **98.37%** | 0.00% |
| **overall** | **31,840/32,100 = 99.19%** | **0.00%** |

The negative control re-runs the identical comparison with every card number shifted by one. It
returns 0.00%, which is what makes the 99.19% mean something: the test can tell a match from a
mismatch. **Two earlier versions of this measurement were wrong and were thrown away** —

- the first read a field named `player`, which does not exist on these rows (the field is
  `playerName`), so every comparison was vacuously "agree" and reported 100%;
- the second keyed identity without `category`. Insert sets restart numbering at #1, so
  "Audible #1 Daniel Jones" collided onto "Base #1 Kyler Murray" and reported an 80.9% that was
  entirely an artifact of the key.

Neither figure should be quoted from any earlier draft.

### The residual 0.81% is mostly transcription, not contradiction

`Cameron Taylor-Britt` / `Cam Taylor-Britt`; `Byron Young (LB)` / `Byron Young` — one card, two
naming conventions. A name-normalisation pass would close most of it.

**One real contradiction was found, and checklistcenter is the side that is right.**
2022-23 Panini Prizm BK base **#5 is Kyrie Irving** — confirmed on the page itself. The stored
hobbymonitor rows give *two different* names for that one card number (`Jayson Tatum` on some
rungs, `AJ Griffin` on others), which is internally inconsistent regardless of which is meant.
Under CF-A-SECOND-SOURCE-THAT-DISAGREES-IS-THE-ONLY-DISQUALIFIER this is precisely the class of
finding the corroboration program exists to surface.

## A defect found on the way — an autograph set staged unsigned

Staging the three cells surfaced a real converter bug, in exactly the shape the auto mutation check
was written to catch.

`convertChecklistCenterToChecklistCsv.cjs` truncates two section names in 2022 Panini Select, and
both truncations cut the word that decides the autograph flag:

| the page's section | staged category | rows staged `isAuto=false` |
|---|---|---:|
| Jumbo Rookie **Signature** Swatches | `insert:jumbo-rookie` | 449 |
| Prime Selections Prizm **Signatures** | `insert:prime-selections` | 374 |

**823 rows** carry a parallel that reads `Signature Swatches Gold Prizm` and are staged as not-auto.
Those are autographed cards that would mint as unsigned twins of themselves — a split pool on the
one axis no later `only-improve` pass can see, because every other column is well-formed.

It is confined to those two sections: 2023 Mosaic FB and 2022-23 Prizm BK stage **zero** such rows.
So this is a per-section parsing bug, not a lane-wide one.

**Consequence for the dispatch below: hold 2022 Panini Select FB out of the apply run** until the
converter's section-name handling is fixed. The other two sampled cells are clean and can go.

The fix belongs in the converter and changes the category vocabulary for every clc product, so it
is a decision to take against the whole corpus rather than from three cells — it is pinned as a
failing-when-fixed test (`tests/clcModernPaniniLadder.test.ts`) rather than patched here.

## Permission

`https://www.checklistcenter.com/robots.txt`, refetched 2026-09-05. It is a **curated blocklist of
~90 named agents** — GPTBot, AhrefsBot, SemrushBot, Wget, HTTrack, Yandex, Baiduspider and so on.

- There is **no `User-agent: *` block at all**.
- **No Claude agent is named** (no ClaudeBot, Claude-Web, anthropic-ai, CCBot).
- No `Crawl-delay`, no `Sitemap` line.

No ToS document is served (footer carries only wp-login/feeds), so there is no clause forbidding
automated access — and equally no affirmative grant. This is the same posture the repo already
treats as GO for this source, which it has ingested from since D3. **The operator actively curates
that blocklist, so it must be re-read before each campaign** — an appearing `*` block or a named
Claude agent flips this to STOP.

## Candidates evaluated

Thirteen. Verdicts are on robots.txt + ToS as read on 2026-09-05.

| site | robots | ToS | format | covers the 5 sample cells | verdict |
|---|---|---|---|---|---|
| **checklistcenter.com** | no `*` block; no Claude agent named | none served | HTML + **XLSX** | **5/5, full ladders + print runs** | **GO — incumbent, already wired** |
| cardboardconnection.com | `*` allows checklist paths, but CCBot/GPTBot/Google-Extended `Disallow: /` | none served | HTML | 3/5 with ladders; 2024 Prizm FB absent, 2025 Optic BK "TBA" | **STOP** — see below |
| topps.com / fanatics (official PDFs) | topps.com robots 403s; PDFs sit on cdn.shopify.com, path not disallowed | — | PDF, parses cleanly | subject lists only — **zero parallels, zero print runs** | STOP (standing rule; and no print runs) |
| gocollect.com | `/` allowed | **bans "scraper, robot, spider"; bans commercial reuse** | — | — | STOP |
| comc.com | **`ClaudeBot Disallow: /`**; item paths disallowed to all | 403 | — | inventory ≠ checklist | STOP |
| blowoutcards.com | **`ClaudeBot Disallow: /`** under a "BLOCK AI TRAINING BOTS" header | — | — | forums subdomain now DNS-dead | STOP |
| cardladder.com | none served (404) | **bans "scrape", "data mine"** | — | — | STOP (also a pricing competitor) |
| steelcitycollectibles.com | permissive | **bars use "for any public or commercial purpose"** | HTML | — | STOP |
| dacardworld.com | permissive | unverified (site 403s every content fetch) | — | — | STOP (unreachable) |
| keymancollectibles.com | empty/unconfirmed | none found | HTML | **0/5 — baseball only** | STOP (wrong sport) |
| sportscardsetlist.com | — | — | — | — | STOP — domain does not resolve |
| ultimatecardchecklists.com | — | — | — | — | STOP — domain does not resolve |
| cardboardhistory.com | — | — | — | — | STOP — parked domain |

### On cardboardconnection

The memory note `reference_cardboardconnection_unreachable.md` says DNS-dead. **That is stale** —
the apex resolves, robots.txt and `sitemap_index.xml` serve, and pages are current. The note is
worth correcting.

It is still a **STOP**, for two independent reasons:

1. **Every child sitemap returns HTTP 500.** Verified directly: `sitemap_index.xml` serves 200, and
   all four `post-sitemap*.xml` it advertises return 500 — identically under both a HobbyIQ UA and
   a browser UA, so it is neither transient nor UA-gating. Discovery has no working entry point, and
   we do not use site search.
2. The operator disallows CCBot, GPTBot and Google-Extended by name. The generic `*` does permit our
   paths, so this is a judgement call rather than a prohibition — but it is Drew's call, not one to
   infer, and (1) makes it moot for now.

## What to run

No new lane, no new parser, no new manifest. The existing `clc` lane, pointed at cells it has never
been dispatched to.

Report-first, the three sampled cells (report mode is safe for all three — it fetches nothing and
writes nothing):

```
gh workflow run "Backfill Runner" \
  -f script=ingest-universe-driver \
  -f sources=clc \
  -f years=2022,2023 \
  -f sports=football,basketball \
  -f titles="2022 Panini Select Football,2023 Panini Mosaic Football,2022-23 Panini Prizm NBA Basketball" \
  -f apply=false
```

The apply run **drops 2022 Panini Select** until the unsigned-autograph defect above is fixed:

```
gh workflow run "Backfill Runner" \
  -f script=ingest-universe-driver \
  -f sources=clc \
  -f years=2022,2023 \
  -f sports=football,basketball \
  -f titles="2023 Panini Mosaic Football,2022-23 Panini Prizm NBA Basketball" \
  -f apply=true
```

For the full sweep, widen the scope and drop `titles` — but fix the converter first, since the
truncation is a per-section bug and other products will carry it:

```
gh workflow run "Backfill Runner" \
  -f script=ingest-universe-driver \
  -f sources=clc \
  -f years=2019,2020,2021,2022,2023,2024,2025,2026 \
  -f sports=football,basketball \
  -f apply=false
```

`SCOPE=recheck` is required to re-attempt entries that already carry a terminal verdict; `MODE=refetch`
is the only way past a committed staged file. Neither is set above, so this takes `pending` entries only.

Measure rows/s on the report run before any fleet dispatch
(`feedback_fleet_scripts_measure_throughput_before_dispatch`). At the 800 ms default delay the
three sampled pages fetched in well under a minute including their workbooks; the whole 2019–2022
backlog is a single polite crawl, not a fleet.

## The 72 cells this does not reach

39 of 111 have a clc address. The rest are mostly vintage (1948–2009 Topps/Fleer/Bowman basketball
and football), 2025–2026 releases too new for any secondary transcription, and the WNBA/Euroleague
products. `sportscardchecklist` already covers much of the vintage tail and is a separate dispatch.
Nothing in this survey found a permissive source for the newest releases — for those, hobbymonitor
being single-source is an acquisition-backlog fact, exactly as the corroboration ruling says.

## Reproducing

```
CLC_LIST=<work-list.json> node backend/scripts/scrape-checklistcenter-products.cjs \
  --outDir=C:/tmp/clc-pages --delayMs=2500
CLC_LIST=<work-list.json> node backend/scripts/convertChecklistCenterToChecklistCsv.cjs \
  --pagesDir=C:/tmp/clc-pages --outDir=C:/tmp/clc-csv
```

Both scripts read `CLC_LIST` (`{products:[{url,sourceSlug,productName,year,sport}]}`), which is how
one cell is acquired without editing the committed 547-product list. The agreement probe is a
`card_catalog` read keyed on `(cardNumber, parallelSlug, isAuto)` restricted to `category=base`,
comparing `playerName`, with the card-number+1 negative control alongside it.
