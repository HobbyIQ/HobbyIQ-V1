# Checklist gap: per-product source map + build plan

Synthesis of four source-research lanes into one decision doc, 2026-08-30.
Scope: the 12 priority products behind the scorecard's non-checklist-backed rows.

**Everything below was re-verified by direct probe on 2026-08-30.** Where a lane's
premise did not survive that probe, the correction is called out inline. Read
"Premise corrections" first — three of the four lanes were scoped against a
stale picture of what we already own.

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
| 12 | 2020 Bowman Chrome (CPA-BWJ) | BCP | `/index.php/2020_Bowman_Chrome` | GET | YES | YES | TCDB (**not** cardboardconnection — DNS-dead) |

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

## 3. Two correctness bugs found in the existing scraper

Both were predicted by Lane A on structural grounds and are confirmed here
against live page text. Both are the `right guard, wrong scope` shape, and both
write **confidently wrong** values — the kind that survive a sweep forever.

### 3.1 BLOCKER — print runs are range-scoped; the scraper cross-joins them

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

### 3.2 BLOCKER — the exception block is read as the rule

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

---

## 4. Build order

Ordered by gap closed per unit of work. Items 1–2 are the whole vintage lane.

### Step 1 — Fix the two print-run bugs in `scrape-bcp-ladders.cjs` (BLOCKER)
Nothing vintage should be ingested until §3.1 and §3.2 are fixed. This is a
parser change to one committed file, not a new source.

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
| `cardboardconnection.com` | **DNS-dead** | Health check 2026-08-25; ranks high in search but results are cached ghosts |
| `groupbreakchecklists.com` | dead | 2026-08-25 health check |
| `beckett.com` HTML | **403 bot-block** | Direct probe; only `img.beckett.com` XLSX archive works |
| `tcdb.com` direct GET | **403 bot-block** | Use `backend/scripts/scrape-tcdb.cjs` |
| `https://www.baseballcardpedia.com` | **TLS fail** | `ERR_TLS_CERT_ALTNAME_INVALID` — cert covers bare host only. `https://` bare = 200; `http://www.` = 301 → bare. Existing scraper is safe; do not "upgrade" it to `https://www.` |
| `checklistinsider.com` for vintage | **structurally impossible** | Min year 2022, confirmed 3 ways |
| `checklistcentral.cards` free DB | **unlaunched template** | Emits raw `[[S1_PARALLELS]]` shortcodes; `/pages/2025-topps-series-1` 404s |
| `sportscardchecklist.com` | rejected | Directory pages, no card-level data, no print runs |

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
