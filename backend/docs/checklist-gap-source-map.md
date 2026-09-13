# Checklist gap: per-product source map + build plan

Synthesis of four source-research lanes into one decision doc, 2026-08-30.
Scope: the 12 priority products behind the scorecard's non-checklist-backed rows.

**Everything below was re-verified by direct probe on 2026-08-30.** Where a lane's
premise did not survive that probe, the correction is called out inline. Read
"Premise corrections" first — three of the four lanes were scoped against a
stale picture of what we already own.

> **This document is dated. Read source verdicts against the later docs.** Its
> probes are a snapshot of 2026-08-30 and **two of them have since been overturned
> outright**, both from §5's "do not re-probe" table:
>
> - `sportscardchecklist.com`, listed as a dead end, is **GO** — see the retirement
>   notice in §5 and
>   [`docs/checklists/2026-09-04-vintage-checklist-sources.md`](checklists/2026-09-04-vintage-checklist-sources.md),
>   which is the authority for vintage source permissions.
> - `cardboardconnection.com`, listed as **DNS-dead**, is **live** and publishes a
>   full card-level checklist per release — see the retirement notice in §5. 68,329
>   rows were acquired from it on 2026-09-13 (PR #2114).
>
> A "do not re-probe" verdict here is evidence about one day's probe, not a standing
> rule — and in both cases the probe itself was the defect, not the host.

---

## 0. Premise corrections (read before planning work)

### 0.1 The scrapers already exist. This is not a build-a-fetcher problem.

Every source the lanes recommend already has a committed, tracked scraper:

| script | lines | last touched |
|---|---|---|
| `backend/scripts/scrape-bcp-ladders.cjs` | 693 | `f3faffab` 2026-08-30 |
| `backend/scripts/scrape-baseballcardpedia.cjs` | 283 | `0f5108c3` 2026-08-30 |
| `backend/scripts/scrape-checklistinsider.cjs` | 566 | `c5029803` 2026-08-27 |
| `backend/scripts/scrape-keymancollectibles.cjs` | 282 | `cde7359d` 2026-08-26 |
| `backend/scripts/scrape-beckett-checklists.cjs` | 181 | `8ef0b23b` 2026-08-26 |
| `backend/scripts/convertBeckettChecklistXlsx.cjs` | 570 | `a2eac017` 2026-08-26 |
| `backend/scripts/scrape-tcdb.cjs` | 257 | `d9e2817e` 2026-08-17 |
| `backend/scripts/scrape-checklistcenter-products.cjs` | 78 | `5612f008` 2026-08-29 |

The gap is **run + fix**, not **build**. Lane C was dispatched to evaluate
keymancollectibles as a candidate; it shipped four days ago as "the first
automated vintage source" (#1298). No lane should be re-scoped to build these.

### 0.2 The vintage products are already staged — and are staged EMPTY.

`backend/data/checklists/scraped/` already holds `1998-spx-finite.csv` (370
rows) and `1999-black-diamond.csv` (180 rows), scraped 2026-08-11. Both were
produced by the **old** `scrape-baseballcardpedia.cjs`, which skipped parallel
sections by design ("they're metadata" — see the header comment on
`scrape-bcp-ladders.cjs`).

Measured: **0 parallel rungs, 0 print runs in both files.** The files exist,
so a presence check passes; the ladder — the entire reason these products are
priorities — is absent. This is the `only-improve hides well-formed wrong rows`
shape: a file that looks acquired and is empty of the thing we needed.

### 0.3 checklistinsider is built AND harvested (Lane B, confirmed)

Lane B's correction stands: the "we hold only 5,810 rows" figure in
`slug-integrity-backlog.md:290` predates the build. `checklistinsider-2026-08-27`
is a live catalog source; the 2026-08-29 reingest wrote 559,400 rows / 529,490
kept-by-authority. Crawl artifact `C:/tmp/ci-final.jsonl` (370MB, 599 products).

**checklistinsider is structurally modern-only: min year 2022.** Confirmed three
independent ways (599-product crawl, live sitemap, site search). It cannot close
any 1987–2017 product on this list. Do not re-probe it for vintage.

---

## 1. Per-product source map

Fetch method legend: **GET** = plain `fetch`, no bot-block, works today.

| # | Product | Chosen source | URL | Fetch | Parallels | Print runs | Second choice |
|---|---|---|---|---|---|---|---|
| 1 | 2017 Topps Gold Label (Judge #86 Cl.1 Blue) | BCP | `baseballcardpedia.com/index.php/2017_Topps_Gold_Label` | GET | YES | **page-text only** (see 3.2) | TCDB via `scrape-tcdb.cjs` |
| 2 | 1997 Topps Finest (#238 Griffey) | BCP | `/index.php/1997_Finest` | GET | YES | **NO — pre-serial era** | Beckett XLSX |
| 3 | 1999 Topps Finest (Aaron Award HA1–HA9) | BCP | `/index.php/1999_Finest` | GET | YES (Refractor only) | **NO — pre-serial era** | TCDB |
| 4 | 1987 Bellingham Mariners (Griffey Jr) | *none clean* | — | needs scraper | NO (none exist) | NO (none exist) | PSA pop / Beckett XLSX |
| 5 | 1987 Topps Traded Tiffany (70T) | BCP | `/index.php/1987_Topps_Traded` | GET | YES (Tiffany) | **set-level 30,000, NOT per-card** | TCDB |
| 6 | 1992 Donruss Studio (#232) | BCP | `/index.php/1992_Studio` | GET | **NO — product has none** | NO | TCDB |
| 7 | 1999 UD Black Diamond (Double/Triple/Quad) | BCP | `/index.php/1999_Black_Diamond` | GET | YES | YES — **but range-scoped, see 3.1** | TCDB |
| 8 | 1998 SPx Finite (Radiance/SPectrum) | BCP | `/index.php/1998_SPx_Finite` | GET | YES | YES — **but range-scoped, see 3.1** | TCDB |
| 9 | 2024 Bowman **(not Chrome)** CPA-TSY | checklistinsider | `checklistinsider.com/2024-bowman-baseball` | GET | YES | YES | BCP `2024_Bowman` |
| 10 | 2025 Bowman's Best (B25-KM) | checklistinsider | `checklistinsider.com/2025-bowmans-best-baseball` | GET | YES | YES | BCP `2025-26_Bowman's_Best` |
| 11 | 1996 Fleer Metal Universe | BCP | `/index.php/1996_Metal_Universe` | GET | YES (Platinum Ed.) | **NO — pre-serial era** | TCDB |
| 12 | 2020 Bowman Chrome (CPA-BWJ) | BCP | `/index.php/2020_Bowman_Chrome` | GET | YES | YES | TCDB, or cardboardconnection (~~DNS-dead~~ — **live**, see §5) |

**Structural verification (probed 2026-08-30):** all BCP pages above return
HTTP 200 and carry the exact `<h2 id="Base_Set">` + `<h2 id="Parallels">`
skeleton `scrape-bcp-ladders.cjs` requires. The vintage pages are the same
MediaWiki shape as the 2023 flagship page the scraper was written against.
**No new parser is needed for any of them.**

---

## 2. What a live run actually produces (measured, not projected)

Real dry run, existing scraper, zero code changes:

```
node backend/scripts/scrape-bcp-ladders.cjs --titlesOnly=1 \
  --titles=1999_Black_Diamond,1998_SPx_Finite,2017_Topps_Gold_Label,1987_Topps_Traded \
  --outDir=C:/tmp/gapprobe
```

```
1999_Black_Diamond:  540 rows  (black-diamond 120x4=540 +60 insert)
1998_SPx_Finite:   3,240 rows  (spx-finite 360x4=1,440 | 360x5=1,800)
2017_Topps_Gold_Label: 300 rows (topps-gold-label 100x3=300)
1987_Topps_Traded:   264 rows  (topps-traded 132x2=264)
pages 4 | staged 5 (4,344 rows) | no ladder 0 | no base cards 0 | unreachable 0
```

Four priority products go from zero rungs to a full ladder with one command.
**But the print runs it writes are wrong — see §3. Do not ingest this output as-is.**

---

## 3. Correctness bugs found in the scrapers and the sources

Originally two (§3.1, §3.2, both BCP, both fixed in #1576). Later acquisitions
added more, and they are kept together because they are **one failure class**:
a value that is well-formed, plausible, and wrong. §3.3 says why that class
matters more than a missing row. §3.4 is TCDB; §3.5–§3.8 are defects in the
publisher workbooks themselves, found on cardboardconnection but not specific
to it — any acquirer reading a publisher `.xlsx` should expect them.

**Fixed in PR #1576** (2026-08-30, `3a27ee8a`) — both §3.1 and §3.2 below.
Range-scoping (`parseCardRange` / `cardInRange`) and the EXCEPT-block split
(`splitAtException` / `exceptionPlayers`) shipped in that PR along with 23
fixture-based tests (`backend/tests/bcpPrintRunIsScoped.test.ts`) pinned
against the real `1998_SPx_Finite` and `1999_Black_Diamond` pages fetched
2026-08-30 (`backend/tests/fixtures/bcp/1998-spx-finite.trimmed.html`,
`1999-black-diamond.trimmed.html`). Re-verified 2026-09-13 (this doc-correction
PR): all 29 tests in that file still pass on `main`, and a fixture parse-only
run confirms no rung width equals the full card count (no cross-join) — this
section is left in place as a record of the original defects, not as an open
item. This doc simply went un-updated after #1576 landed; nothing further to
fix here.

Both were predicted by Lane A on structural grounds and are confirmed here
against live page text. Both are the `right guard, wrong scope` shape, and both
write **confidently wrong** values — the kind that survive a sweep forever.

### 3.1 FIXED (PR #1576) — print runs are range-scoped; the scraper cross-joins them

BCP states SPx Finite print runs per card-number range:

```
Radiance Youth Movement (cards 1-30 and 181-210; serial-numbered to 2500)
Radiance Power Explosion (cards 31-50;            serial-numbered to 1000)
Radiance commons (cards 51-140 and 241-330;       serial-numbered to 4500)
Radiance Heroes of the Game (cards 171-180;       serial-numbered to 100)
```

The scraper emits `360 cards x 4 rungs = 1,440` rows — every rung applied to
every card. So card #1 is emitted as `Radiance Heroes of the Game /100` when
Heroes is cards 171–180 only. `printRun` is a function of
**(card range, parallel)**, never the parallel alone.

`360x4` and `360x5` are the cross-join signature — the same shape as the
retired exploded spine (#1371). Ingesting this manufactures ~3,200 false rows
for SPx Finite alone.

**Fix:** parse the `(cards A-B and C-D; serial-numbered to N)` range clause and
scope each rung to its card numbers. Rungs whose range does not parse must be
emitted with a blank `printRun`, never the set-level default.

### 3.2 FIXED (PR #1576) — the exception block is read as the rule

Black Diamond page text:

```
Each is serial-numbered to the following production figures EXCEPT the cards of
Sammy Sosa, Ken Griffey, Jr., and Mark McGwire.
  Double (Red foil):     short set, 3000; Debuts, 2500
  Triple (Yellow foil):  short set, 1500; Debuts, 1000
  Quadruple (Green foil):short set,  150; Debuts,  100
For Sosa, Griffey, and McGwire ... Double (serial-numbered to 1998)
  Triple (Sosa: 273 copies, Griffey: 350, McGwire: 457)
```

Extracted ladder: `Double /1998, Triple /273, Quadruple /66` — the scraper took
the **three-player exception** and applied it to all 120 cards. Triple /273 is
Sammy Sosa's career HR total now stamped on every player in the set.

The correct base values (Double /3000 short set, /2500 Debuts) were never
emitted. `printRunFilled=360` reads like success and is 360 wrong numbers.

**Fix:** stop at the "EXCEPT"/"For X, Y, and Z" boundary the way the parser
already stops at `id="Inserts"`. The per-player figures are a real ladder but
belong to those three players' rows only.

### 3.3 Why this matters more than the missing rows

A missing rung is visible and gets re-acquired. A well-formed wrong `printRun`
is invisible to every sweep and silently splits or merges a comp pool. Per
`verify output, not process`: the acceptance test for this work is **the emitted
numbers matched against page text**, not the staged row count.

### 3.4 FIXED (2026-09-13) — `scrape-tcdb.cjs`: pagination clipped at 100, and two row shapes read as zero cards

Found building the 2014 Panini Prizm FIFA World Cup file (PR #2105). Both are
the "looks acquired, empty of the thing we needed" shape, this time in the
TCDB backup scraper rather than BCP.

**Pagination.** TCDB checklist pages list 100 rows per page
(`?PageIndex=N`). The shipped pagination loop was reachable only from behind
an empty-rows guard that ran after a `<td>` grid-walk assuming
`<td>{number}</td><td>{player}</td>` — a shape TCDB's current markup never
produces (no `<th>` cells anywhere on the page, so that walk always returns
0 rows and always fell through). That made the real page-walking logic
fragile rather than load-bearing: any future page shape that let the grid-walk
match even a handful of decoy rows would have skipped pagination entirely and
silently clipped at whatever page 1 produced. A single-page read gave 100 of
the 201-card base set and clipped every 100+ parallel rung at the same
boundary. Fixed by making the page walk unconditional and the only extraction
path — the dead grid-walk fallback is removed rather than kept as a no-op.

**Name extraction.** The row reader pulled player names ONLY from
`Person.cfm` anchors. Two real row shapes on this product carry no
`Person.cfm` anchor at all:

- **Team cards** (Team Photos rung): the name cell is plain text ("Algerie
  TC"); the `Team.cfm` link is in a *later* cell, not the name cell.
- **Multi-player cards** (Combo Signatures rung): the name cell is plain
  text with a `/` separator ("Bobby Charlton / Steven Gerrard AU, SN10") —
  no anchor of any kind.

15 of 136 rungs on this product extracted **zero** rows. Fixed by reading the
row's own cells: Person.cfm anchors first (the common case), falling back to
the name cell's plain text when there is none. Splitting on `/` recovers both
names on a multi-player card rather than dropping one.

**Attribute tokens.** Reading the name cell as text also recovers the
trailing `AU` / `SNnnn` tokens TCDB states inline on signature/serial rungs
("... AU, SN10"). Parsed into `isAuto` / `printRun`, scoped to the rung that
actually states them — Team Photos never says AU or SN and is emitted
unsigned with a blank print run; a print run stated on one rung is never
carried onto another. Per doctrine: every row traces to the page, blank means
unknown, and autos are never minted unsigned.

**Fixed in this PR** (`fix/tcdb-scraper-pagination-names-0913-*`, 2026-09-13):
`backend/scripts/scrape-tcdb.cjs` rewritten (`extractRowsFromPage`,
`parseNameAttributes`, `splitPlayers`, unconditional `fetchAllPages`); 5
fixture-based tests in `backend/tests/tcdbPaginationAndNames.test.ts` pinned
against the real 2014 Prizm World Cup base set (3 pages, 100+100+1=201,
TCDB's own stated count) and its Team Photos (32 rows) and Combo Signatures
(10 rows, AU/SN10) rungs, fetched 2026-09-13
(`backend/tests/fixtures/tcdb/`). The env-read-at-module-load defect
(`TCDB_URL` missing called `process.exit(2)` before any test could `require`
the file — the #1985 shape) is fixed alongside it, since it blocked writing
these tests at all.

### 3.5 (2026-09-13) — publisher workbooks shift their own columns

Found across four Upper Deck hockey workbooks on cardboardconnection (PR
#2114). The header row and the data rows do not line up: the `Rookie` column
holds either the literal `"Rookie"` or a junk internal id, and **when it holds
`"Rookie"` every later value moves one column right**. Read by header position,
`Auto` returns the print run, `Serial #'d` returns the pack odds, and so on
down the row.

**3,588 rows across the four workbooks** carry the flag and therefore shift
(589 on 2024-25 Series 1 alone). Fix: detect the flag per row and offset the
column index for that row only. Never trust a header index for a whole sheet
without checking a flag column for a value that is not a flag.

### 3.6 (2026-09-13) — internal set ids leak into the serial column

The same workbooks put `1572` in the serial column on all 200 Clear Cut cards
and `1594` on all 200 Outburst Silver. These are the publisher's internal set
ids, not print runs — they also appear in the `Rookie` and `Auto` columns as
the junk values above, in a tight 1,5xx–1,6xx band.

The page settles it: it states **pack odds** for both rungs (`1:180 packs`),
and the sibling 2023-24 page names the whole ladder as *"Outburst Silver,
Deluxe (#/250), Outburst Red (#/25), Outburst Gold (1/1)"* — Silver named with
**no serial at all**. 400 false print runs blanked.

This is §3.3's shape exactly, from a second source. A print run must be
corroborated against the page's own words before it is written; **odds are
never coerced into `printRun`**, and blank stays unknown.

### 3.7 (2026-09-13) — the rung is not always a suffix, so siblings never fold

`classifySections` folds a section onto an anchor only when the candidate's
name **contains** every token of the anchor's ("X - Image Variations" extends
"X"). Three real naming shapes defeat that, and each one leaves every sibling
its own anchor emitting a **blank parallel** — so N different cards collapse
onto one slug:

| shape | example | effect |
|---|---|---|
| rung in the MIDDLE | `Clear Cut Parallel - Young Guns` vs the anchor `Base Set - Young Guns` | 9 cards on `…:201:base:no-auto` |
| rung on the ANCHOR | `Dazzlers Blue` (the plain card) vs `Dazzlers Black Parallel` | 6 cards on `…:dz-1:base:no-auto` |
| anchor only on the PAGE | `Optic Rated Rookies Preview Holo / Green Mojo / …`, with no bare "Optic Rated Rookies Preview" in the workbook | 5 cards on `…:301:base:no-auto` |

Measured on one package: **1,819 rows collapsed onto 395 slugs.**

Fix at the staging boundary, not in the classifier: rename each sibling as an
extension of the run **the source itself names** — the page's own set-checklist
heading for the third shape, a published sibling for the first two — and only
when the members list **exactly the same card numbers**. A family is never
rewritten on a colour word alone. The tiered variant is page-attested too:
*"The 30-card set again offers tiered print runs of 1,000 copies or less"* is
one 30-card set with seven Population Count tiers, not seven sets.

### 3.8 (2026-09-13) — the auto flag comes from the page's Autograph heading

The word-boundary test on the section name (#2106's discipline, and still
required) is **necessary but not sufficient**. The hobby names autograph sets
without saying "auto" or "signature":

```
Hoops Ink · Rookie Ink · Great SIGnificance · Private Signings · College Penmanship
```

None of those match any `/auto|sign/` test, and all of them are signed.
**1,131 rows across two NBA Hoops products** would have minted UNSIGNED.

cardboardconnection pages group their checklists under explicit class headings
— `<Product> Autograph Checklist`, then `<Set> Set Checklist` for each signed
set, until the next class heading (Insert / Memorabilia / Parallel). **That
heading is the attestation**: read `isAuto` from which class a set is filed
under, and keep the word-boundary test as the fallback for sets the page does
not classify.

Keep the boundary for the other direction. An unanchored `/auto|ink/` reads
"Dazzlers **P**ink Parallel" and "Base Prizms **P**ink Circles" as autographs.
Both errors are one-way harmful and both must be guarded: never mint a signed
card unsigned, never mint an unsigned card signed.

A related trap when merging a page checklist with a workbook: **an autograph
subset can reuse the base cards' numbers AND players** ("Base Snow Spray
Autographs"). A duplicate test keyed on `cardNumber + player` deletes it as a
duplicate of the base card. Key on `cardNumber + signedness`, and not on the
player string — one source folds an RC flag into the name ("Josiah Gray RC")
and the other does not, which made 377 of 500 identical cards read as new.

---

## 4. Build order

Ordered by gap closed per unit of work. Items 1–2 are the whole vintage lane.

### Step 1 — Fix the two print-run bugs in `scrape-bcp-ladders.cjs` (DONE — PR #1576)
§3.1 and §3.2 are fixed; nothing here still blocks vintage ingest on print-run
correctness. This was a parser change to one committed file, not a new source.

*Parse recipe:* keep the existing structural approach (`<h2 id="Base_Set">`,
`<h2 id="Parallels">`, stop at `id="Inserts"`). Add (a) a card-range clause
parser `\(cards ([\d\-,\s and]+);\s*serial-numbered to ([\d,]+)\)` that scopes
the rung to those numbers; (b) an exception-boundary stop on
`/\bEXCEPT\b|^For .*,? and .* their\b/`. Blank print run when either fails —
blank means unknown, never a guessed default.

*Acceptance:* SPx `Radiance Heroes of the Game /100` appears on cards 171–180
and nowhere else; Black Diamond `Double` reads /3000 (cards 1–90) and /2500
(cards 91–120), with /1998 only on Sosa/Griffey/McGwire.

### Step 2 — Re-run BCP ladders across the 9 BCP products, re-stage, ingest
Closes products 1, 2, 3, 5, 6, 7, 8, 11, 12 in one dispatch. Overwrites the
empty 2026-08-11 artifacts from §0.2.

```
--titlesOnly=1 --titles=2017_Topps_Gold_Label,1997_Finest,1999_Finest,
  1987_Topps_Traded,1992_Studio,1999_Black_Diamond,1998_SPx_Finite,
  1996_Metal_Universe,2020_Bowman_Chrome
```

*Note:* the scraper fetches `http://www.baseballcardpedia.com` — this is correct
and must not be "modernized" to `https://www.` (see §5, TLS trap).

### Step 3 — checklistinsider delta refresh (products 9, 10)
Crawl is 2026-08-20; sitemap moved 2026-08-29. Re-run scoped to
`lastmod > 2026-08-20`. Picks up 2026 Bowman's Best (no page at crawl time) and
2026-27 UD Black Diamond (published-empty at crawl).

*Parse recipe (as implemented, unchanged):* `sitemap_index.xml` → `/post-sitemap/`
children → `<loc>`. Ladder from `<ul>` whose nearest preceding heading matches
`/parallels?\b/i`, per `<li>`
`/^(.{1,60}?)\s*[-–—]?\s*\/\s*([0-9][0-9,]{0,6})\b(.*)$/` — **commas are
load-bearing** (`/2,026` = 2026, not 2). Card-level runs from the linked
`.xlsx`; four layouts, detected not assumed. Structure-only, never line-shape:
line-shape matching produced 1,494 false parallels on 2023-24 National Treasures.

### Step 4 — Product 4 (Bellingham) — identity first, do not mint
No clean source. Blocked on a card-number conflict, not on acquisition (§6.1).

### Not scheduled
`keymancollectibles` (built, base-only, adds no ladder to these 12),
`checklistcentral` (paid, no ladder), `cardboardchecklist` MCP (card-level only).

---

## 5. Dead ends — do not re-probe

| Source | Status | Evidence |
|---|---|---|
| `groupbreakchecklists.com` | dead | 2026-08-25 health check |
| `beckett.com` HTML | **403 bot-block** | Direct probe; only `img.beckett.com` XLSX archive works |
| `tcdb.com` direct GET | **403 bot-block** | Use `backend/scripts/scrape-tcdb.cjs` |
| `https://www.baseballcardpedia.com` | **TLS fail** | `ERR_TLS_CERT_ALTNAME_INVALID` — cert covers bare host only. `https://` bare = 200; `http://www.` = 301 → bare. Existing scraper is safe; do not "upgrade" it to `https://www.` |
| `checklistinsider.com` for vintage | **structurally impossible** | Min year 2022, confirmed 3 ways |
| `checklistcentral.cards` free DB | **unlaunched template** | Emits raw `[[S1_PARALLELS]]` shortcodes; `/pages/2025-topps-series-1` 404s |

> ### RETIRED 2026-09-13 — `sportscardchecklist.com` was listed here and is **GO**
>
> This table carried the row
> `` | `sportscardchecklist.com` | rejected | Directory pages, no card-level data, no print runs | ``
> from this document's 2026-08-30 synthesis. **It is withdrawn.** The verdict was
> superseded five days later by
> [`docs/checklists/2026-09-04-vintage-checklist-sources.md`](checklists/2026-09-04-vintage-checklist-sources.md),
> which probed the host directly and ruled it **GO — rank 1**: *"covers every target
> cell, serves real card-by-card checklists, and its robots.txt permits the paths we
> need"*, ~709,773 unblockable pool rows, *"Build the lane against
> sportscardchecklist.com and nothing else."*
>
> The three original claims, re-checked against the `/set-<id>/` pages:
>
> | claim | verdict |
> |---|---|
> | "Directory pages" | **false** — card rows are server-rendered, with two independent anchors per card (the `<h5 class="h4">` header and the `ebay_search` hidden input) |
> | "No card-level data" | **false** — T206 524 rows, 1933 Goudey 241, 1972 Topps Football 351; the 2026-09-13 package A acquisition parsed 11,666 rows from 37 pages |
> | "No print runs" | **true, and not disqualifying** — pre-serial vintage has none to acquire. The lane emits `printRun` blank by design, which is the ruling, not a gap |
>
> **How the wrong verdict happened, so it is not repeated.** The 2026-08-30 pass
> almost certainly probed `/search/?search_terms=…` — which is `Disallow`ed by the
> host's robots.txt *and* is a documented false-negative machine: querying
> "1972 topps football" returns 18 results, none of them the set, which lives at
> `set-11959`. Discovery here is the robots-advertised **sitemap**, always.
>
> Leaving the row in a section titled "do not re-probe" was the expensive part: it
> instructed every later agent to skip the repo's highest-yield checklist source. The
> lane has shipped catalog rows since 2026-09-04 (`sportscardchecklist-<date>`), owns
> two committed scripts (`fetchSportsCardChecklist.cjs`,
> `discoverSportsCardChecklistSets.cjs`), 10,359 manifest entries, 18 test files and
> 19 page fixtures.
>
> Anything genuinely dead about this host would be recorded in the vintage-sources
> doc above, which is now the authority for it.

> ### RETIRED 2026-09-13 — `cardboardconnection.com` was listed here as DNS-dead and is **LIVE**
>
> This table carried the row
> `` | `cardboardconnection.com` | **DNS-dead** | Health check 2026-08-25; ranks high in search but results are cached ghosts | ``
> and §1 told product 12 to prefer TCDB "(**not** cardboardconnection — DNS-dead)".
> **Both are withdrawn.** The host resolves and serves.
>
> Re-probed 2026-09-13, directly, twice (the acquisition run and a confirmation
> pass before writing this note):
>
> | fact | measured |
> |---|---|
> | DNS | `www.cardboardconnection.com` **and** the bare host both resolve to `45.56.220.159` |
> | HTML | product pages return **200** `text/html`; the sitemap index, `robots.txt` and the year indexes all 200 |
> | checklist file | each product page links a **real `.xlsx`** on `cconnect.s3.amazonaws.com` — verified by `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and a `PK\x03\x04` zip header, not by the link existing |
> | inline HTML | the page ALSO carries a full card-level checklist (`<h3 class="hot-title">X Set Checklist</h3>` + `.tablechecklist` blocks), which on Upper Deck holds autograph sets the workbook omits |
> | coverage | year indexes run **2018–2024 only** for baseball/football/basketball/hockey/soccer. 2025 and 2026 products have no page — a real ceiling, and the main reason 30 of the 39 checklistinsider queue ranks stayed unsourced |
>
> Acquired against it the same day: **10 products, 68,329 rows, 9,781 signed,
> 37,290 print runs** (PR #2114), including queue ranks 1, 13 and 26 — the three
> highest-ranked entries no other source could reach.
>
> **How the wrong verdict happened, so it is not repeated.** "Ranks high in search
> but results are cached ghosts" is what a *search-result* probe sees when the host
> is rate-limiting: this server answers bursts with a **503 `Service Unavailable`
> page that is served with an HTTP 200-shaped body**, so a fast unthrottled sweep
> reads every page as junk and concludes the domain is gone. A probe must
> distinguish "no host" from "host says slow down" — check DNS separately from
> HTTP, and back off rather than concluding. One request per ~4s with retry got
> 793 product pages without a single failure.
>
> **Discovery here is the year index, never a constructed URL.** The site's own
> indexes live at `/sports-cards-sets/<sport-slug>/<year>-<sport>-cards`
> (`mlb-baseball-cards`, `nfl-football-cards`, `nba-basketball-cards`,
> `nhl-hockey-cards`, `soccer-card-sets`), with basketball and hockey on season
> slugs (`2022-2023-basketball-cards`) that switch form for newer years
> (`2024-25-hockey-cards`). The paged `post-sitemap2..10.xml` children of the
> sitemap index return a **WordPress error page**, so the sitemap alone is not a
> product index — only `post-sitemap.xml` works and it holds 2009-era news.
> Product URL shape also changed over time (`2022-donruss-football-nfl-cards`
> vs `2024-25-upper-deck-series-1-hockey-cards-review-and-checklist`), so
> constructing URLs by rule fails; resolve every target against the index and
> confirm by page title.
>
> `robots.txt` permits the product paths (it disallows only `/images/e/*`,
> `/sports-collectibles-*`, `/partners/*`, query strings and `*.htm`, and blocks
> `CCBot` / `GPTBot` / `Google-Extended` by name — not a general crawler).

**Products with no print runs to acquire — a product fact, not a source gap.**
1997 Finest, 1999 Finest, 1996 Metal Universe predate serial numbering; they
publish **pack odds** (1:12, 1:288). Odds must map to a rarity field and must
never be coerced into `printRun`. 1992 Studio has **no parallels at all**. No
source acquisition will change these four; stop looking.

---

## 6. Open questions for Drew

### 6.1 1987 Bellingham Griffey — which card number? (blocks minting)
Sources genuinely disagree: Beckett/CardLadder/PSA say **#15**;
SportsCardInvestor's page is titled **#3**. Griffey also appears on #33
(Team Checklist). A wrong `cardNumber` here is a wrong identity and Drew's
holding sits on it. Recommend settling against a primary scan (PSA pop page)
before minting. **Do not mint on the majority vote.**

### 6.2 CPA-TSY is filed to the wrong product — confirm the reattribution
Verified on BCP 2026-08-30: `CPA-TSY` / "Sykora" present on **2024 Bowman**,
absent from **2024 Bowman Chrome**. Both products ship a "Chrome Prospect
Autographs" insert using the same `CPA-` prefix with different checklists
(2024 Bowman 87 cards; Bowman Chrome 142). If Drew's holding is filed under
Bowman Chrome it sits on a wrong product row — the likely root cause of that
non-checklist row. Moving it changes the comp pool: confirm before the move.

### 6.3 Set-level production figures — blank, or a new field?
1987 Topps Traded Tiffany has a real figure (~30,000 **sets**) that is not a
per-card serial number. Writing 30000 into `printRun` claims serial numbering
that does not exist. Recommend blank + a distinct set-level field later.
Same question for pre-serial pack odds (§5).

### 6.4 Channel-scoped ladders — is `channel` carried on the row?
2020/2024 Bowman ladders are channel-scoped: Hobby `Green /99` and HTA
`Green Atomic /99` are **different cards at the same print run**. Without a
channel axis on the row key they collide. Per `one card, one row, one pool`
this needs a schema answer before Bowman ingest, not after.

### 6.5 Paid source — worth $41?
`checklistcentral.cards` sells 41 baseball checklists at $1–2 (1952–2020).
Titles show plain base counts (407, 587, 908) = **base checklists, no ladder**.
Recommend **no** — it buys card lists we can get free and closes none of the
parallel gap. Flagged only because Drew surfaced the candidate.

---

## 7. Lane coverage note

Lane C's output arrived truncated mid-sentence (cut off inside the
keymancollectibles coverage span). Its checklistcentral and keyman verdicts are
captured above; if that lane probed a fourth source after keyman, it is not
represented here. A fourth lane's results were not delivered to this synthesis.
