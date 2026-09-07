# The label was right and the year was wrong — and the year put the row on another card's address

**2026-09-07 — report-only. No catalog row, no queue entry and no sale was written.**

#1917 fixed the ingest source: a hobbymonitor release URL can end in the year the
*page* was published rather than the year the *product* was issued
(`/release/2024-topps-finest-football2025`), so 21 queue entries carried a `year`
that contradicted their own `setName`. It deferred the stored rows, because
point-reading 150 destinations at the setName year found that **21% held a
different player** — which left open whether those rows are the year-N product
mislabelled (H1) or a genuine year-N+1 release that hobbymonitor labelled with the
prior year (H2).

This census answers that with the number-to-player map, per product, for all 28.

## Verdict

**H1, for 27 of 28 products.** The hobbymonitor rows are the year-N product. Their
`setName` is right and their `year` field is wrong.

| | numbers |
| --- | ---: |
| card numbers compared (numeric, all 28 products) | **5,381** |
| agree with the year-N checklist | **5,351 (99.4%)** |
| agree with the year-N+1 checklist | 444 (8.3%) |
| agree with N+1 but **NOT** with N | **0** |
| agree with neither | 30 (0.6%) |

The last two lines are the finding. Every single number that matches the year-N+1
checklist *also* matches year-N — there is not one card number anywhere in the
corpus that the year-N+1 release explains and the year-N release does not. H2
predicts a systematic block of exactly those, and the corpus holds zero.

**And the 21% different-player rate in #1917 was not a checklist disagreement at
all — it was a second card.**

The year-N+1 **card number** is not vacant. For 8 products the same crawl also
minted the genuine year-N+1 card, correctly labelled, under that same number — so
the number carries two players. Card number 88 of `football:2025:topps-chrome`
holds 113 slugs naming Bo Nix (2025 Topps Chrome #88) and 23 naming Dallas Clark
(2024 Topps Chrome #88). #1917 point-read the destination, found the *other year's*
player, and correctly recorded it as a different player — but the reading that a
blanket rewrite would "drive one in five rows onto another card's address" has the
direction backwards. **The rows are already on the wrong year's address. The
rewrite is what would take them off it.**

| | numbers |
| --- | ---: |
| card numbers holding both a year-N and a year-N+1 card at the N+1 address | **2,067** |
| ... of those, naming a different player | **2,038 (98.6%)** |
| sales resident on the mislabelled rows' own slugs | 7,905 |
| whose title states year N | **0** |
| whose title states year N+1 | **7,901 (99.9%)** |

To be precise about the shape, because it decides the repair: **no single slug
holds two players.** The two cards occupy *sibling parallel slugs* under one
number — `...:88:x-fractor:no-auto` was minted for Dallas Clark from the
mislabelled 2024 rows, while `...:88:neon-pulse-refractor:no-auto` is Bo Nix from
the correct 2025 rows. The pools are not merged; they are interleaved.

Which is why the sales matter so much. Those 7,905 sales sit on the *mislabelled*
rows' own slugs, and their titles are unanimous — not one of them states the
setName's year:

```
hiq:football:2025:topps-chrome:88:x-fractor:no-auto            <- row says Dallas Clark, 2024
   sale: Topps Chrome 2025 Bo Nix Denver Broncos X-Fractor Parallel #88 NFL Card

hiq:football:2025:topps-chrome:88:yellow-geometric-refractor:no-auto
   sale: 2025 Topps Chrome Topps BO NIX #88 Yellow Geometric Refractor Broncos
```

The market found the 2025 address, priced the 2025 card, and landed on a catalog
row that names the 2024 player. **This is a live mispricing, not a cosmetic label
defect** — every one of those 7,905 sales is currently attached to an identity that
is not the card that sold. That is the cost of leaving these rows where they are,
and it is the strongest argument for repairing them rather than relabelling them.

## Recommendation

Rule H1 and repair on the **identity axis, not the label axis**. #1912's deferred
plan was `patchCatalogRowFields` on `setName` only — rewriting the label to match
the wrong year. That would launder the defect rather than fix it: it would rename
2024 Topps Chrome #88 (Dallas Clark) into "2025 Topps Chrome Football", leaving a
row that claims to be a 2025 card, sits at a 2025 address, and names the 2024
player — with the 2025 sales still on it. The one field that currently tells the
truth would be overwritten with the one that does not, and the census's entire
evidence base for the row's real identity would be erased from the container.

The correct repair moves the row to the year its own checklist says it is, which is
a `relocate-catalog-rows-by-list` reslug, per card, with a checklist-verified
destination. Because the two cards sit on sibling parallel slugs rather than one
shared slug, moving the mislabelled row is a clean reslug in most cases and does
not require merging anything — but it must still be built collision-aware, because
a sampled 4,200 destinations split three ways:

- **1,788 vacant (42.6%)** — a clean reslug.
- **2,021 occupied by the same player (48.1%)** — a fold; the destination is the
  same card, already correctly addressed by a checklist source.
- **377 occupied by a different player (9.0%)** — must be reported, never routed
  around, per the #1912 precedent that excluded `hiq:hockey:202:upper-deck:1`.

The 7,905 sales need their own decision, and it is not "leave them". They are
2025 sales resting on rows that name the 2024 player, so when the row moves to
2024 they must **not** move with it — they must be re-pointed to, or re-matched
against, the year-N+1 identity that actually sold. `moveCatalogRow` re-points a
row's own sales by default, which is the wrong behaviour here and is the single
most important thing for the repair lane to get right. Sizing it: 7,905 sales
across 2,454 slugs, listed per product in section 4.

One product cannot be ruled: `basketball/panini-haunted-hoops` needs checklist
acquisition before anything can be said about it.

---

## Method

READ-ONLY throughout. `card_catalog` queries are per product, narrowed on
`sport` + `setKey` and projected to the identity fields only; `sold_comps` is read
by `STARTSWITH(c.hobbyiqCardId, ...)` prefix and by point-bounded reads — never a
cross-partition `SELECT VALUE COUNT(1)`. Identity rows only
(`NOT IS_DEFINED(c.gradeTier)`); grade rows are per-tier children and would
double-count. Roughly 150k RU total.

Two decisions in the comparison are load-bearing:

**The label has two shapes, and only one of them is the defect.** 8 football
products carry a plain leading year (`2024 Topps Finest Football`); 20 basketball
products carry a split season (`2024/25 Panini Donruss Optic Basketball`). Per
#1852/#1912 a split-season row sitting on the *second* season year is the corpus
convention and not a defect in itself — which is why those 20 are read on the
number-to-player evidence rather than on the label, and why the shape is named in
the table.

**Numbers are compared across all parallels, not base-only.** A card number names
the same player in every parallel of that number. Intersecting on
"parallel is blank AND cardNumber is numeric" returns **zero rows** for
football/topps-finest (of 7,476) — that product's base-parallel rows all carry
alphanumeric insert numbers while its numeric-numbered rows are all parallels. A
base-only comparison would have measured nothing and reported it as agreement.

Player names are matched on last name plus first initial, with generational
suffixes stripped, so "Marvin Harrison Jr." and "Marvin Harrison" agree.



---

## 1. Per product: number to player, against year N and year N+1

Rows marked `*` were compared against a sibling setKey (named in the verdict below)
because the product carries no checklist rows under its own key at either year.

| product | shape | N | N+1 | hm rows | numbers compared | agree N | agree N+1 | disagree both | no checklist | verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `basketball/panini-donruss-optic` * | split | 2024 | 2025 | 24,384 | 350 | 350 | 0 | 0 | 0 | **H1** |
| `football/topps-chrome` | plain | 2024 | 2025 | 14,035 | 300 | 300 | 0 | 0 | 0 | **H1** |
| `basketball/panini-select` | split | 2024 | 2025 | 13,470 | 400 | 400 | 0 | 0 | 0 | **H1** |
| `football/panini-phoenix` | plain | 2024 | 2025 | 10,884 | 250 | 250 | 9 | 0 | 0 | **H1** |
| `football/panini-select` | plain | 2024 | 2025 | 8,890 | 525 | 520 | 2 | 5 | 0 | **H1** |
| `football/topps-resurgence` | plain | 2024 | 2025 | 8,115 | 102 | 102 | 0 | 0 | 0 | **H1** |
| `basketball/topps-royalty` | split | 2023 | 2025 | 7,491 | 125 | 125 | 0 | 0 | 0 | **H1** |
| `football/topps-finest` | plain | 2024 | 2025 | 7,476 | 300 | 300 | 3 | 0 | 0 | **H1** |
| `basketball/topps-cosmic-chrome` | split | 2025 | 2026 | 7,133 | 199 | 198 | 0 | 1 | 1 | **H1** |
| `basketball/panini-revolution` | split | 2024 | 2025 | 5,999 | 175 | 175 | 0 | 0 | 0 | **H1** |
| `basketball/topps-finest` | split | 2024 | 2025 | 4,648 | 300 | 300 | 300 | 0 | 0 | **H1** |
| `basketball/panini-noir` | split | 2024 | 2025 | 3,103 | 388 | 388 | 0 | 0 | 0 | **H1** |
| `basketball/panini-immaculate` | split | 2024 | 2025 | 1,508 | 13 | 12 | 0 | 1 | 140 | **H1** |
| `football/panini-contenders` | plain | 2024 | 2025 | 3,006 | 268 | 268 | 0 | 0 | 0 | **H1** |
| `basketball/panini-silhouette` | split | 2024 | 2025 | 2,804 | 100 | 100 | 0 | 0 | 0 | **H1** |
| `basketball/topps-inception` | split | 2024 | 2025 | 2,707 | 100 | 99 | 99 | 1 | 0 | **H1** |
| `basketball/topps-three` | split | 2023 | 2025 | 2,479 | 127 | 127 | 1 | 0 | 0 | **H1** |
| `basketball/panini-haunted-hoops` | split | 2024 | 2025 | 2,100 | 0 | 0 | 0 | 0 | 300 | **needs-checklist** |
| `basketball/panini-one-one` * | split | 2024 | 2025 | 2,050 | 180 | 180 | 0 | 0 | 0 | **H1** |
| `basketball/panini-prizm-black` | split | 2024 | 2025 | 1,747 | 300 | 300 | 0 | 0 | 0 | **H1** |
| `basketball/panini-origins` | split | 2024 | 2025 | 1,626 | 100 | 100 | 0 | 0 | 0 | **H1** |
| `basketball/panini-flawless` | split | 2023 | 2025 | 1,584 | 200 | 185 | 0 | 15 | 0 | **H1** |
| `basketball/panini-national-treasures` | split | 2024 | 2025 | 1,123 | 191 | 191 | 0 | 0 | 0 | **H1** |
| `football/panini-impeccable` | plain | 2024 | 2025 | 984 | 100 | 100 | 11 | 0 | 0 | **H1** |
| `football/panini-clearly-donruss` * | plain | 2024 | 2025 | 870 | 76 | 76 | 0 | 0 | 0 | **H1** |
| `football/panini-immaculate` * | plain | 2024 | 2025 | 489 | 142 | 142 | 19 | 0 | 0 | **H1** |
| `basketball/panini-eminence` | split | 2024 | 2025 | 301 | 70 | 63 | 0 | 7 | 0 | **H1** |
| `basketball/topps-chrome` | split | 2024 | 2025 | 298 | 0 | 0 | 0 | 0 | 0 | **H1** |
| **28 products** | | | | **141,304** | **5,381** | **5,351** | **444** | **30** | **441** | **27 H1 / 1 needs-checklist** |

"no checklist" counts card numbers the hobbymonitor rows claim that no checklist
source holds at EITHER year. The 441 total is concentrated in the one product that
needs acquisition (300) and in `basketball/panini-immaculate` (140), whose own key
holds only 13 seed rows.


### The alphanumeric (insert / auto) numbers, measured separately

Insert and autograph numbers carry their own prefixed numbering (`MYST-32`,
`RFA-MH`, `FG-1`) and are the likeliest place for a cross-year collision, so they
are reported apart from the flagship base run rather than mixed into it.

| product | alpha numbers | compared | agree N | agree N+1 | disagree both | no checklist |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `football/topps-chrome` | 627 | 627 | 627 | 13 | 0 | 0 |
| `football/topps-resurgence` | 526 | 526 | 526 | 2 | 0 | 0 |
| `basketball/topps-royalty` | 871 | 835 | 833 | 0 | 2 | 36 |
| `football/topps-finest` | 417 | 416 | 400 | 4 | 16 | 1 |
| `basketball/topps-cosmic-chrome` | 577 | 576 | 576 | 0 | 0 | 1 |
| `basketball/topps-finest` | 248 | 248 | 248 | 248 | 0 | 0 |
| `basketball/topps-inception` | 267 | 267 | 267 | 267 | 0 | 0 |
| `basketball/topps-three` | 432 | 402 | 402 | 14 | 0 | 30 |
| `basketball/panini-origins` | 1 | 0 | 0 | 0 | 0 | 1 |
| `basketball/topps-chrome` | 199 | 199 | 199 | 199 | 0 | 0 |
| **total** | **4,165** | **4,096** | **4,078** | **747** | **18** | **69** |

The same verdict, independently: 4,078 of 4,096 agree with year N (99.6%), and the
18 that agree with neither are subset-prefix collisions, shown in section 3.


---

## 2. The products with no checklist under their own setKey

Five products returned no checklist rows at either year on a first pass. Four of
the five are **not** acquisition gaps — the checklist exists under a sibling
setKey, and re-running the comparison against it resolves them cleanly:

| product | sibling setKey holding the checklist | compared | agree N | agree N+1 | disagree |
| --- | --- | ---: | ---: | ---: | ---: |
| `basketball/panini-donruss-optic` | `donruss-optic` | 350 | 350 | 0 | 0 |
| `basketball/panini-one-one` | `panini-one-and-one` | 180 | 180 | 0 | 0 |
| `football/panini-clearly-donruss` | `clearly-donruss` | 76 | 76 | 0 | 0 |
| `football/panini-immaculate` | `panini-immaculate-collection` | 142 | 142 | 19 | 0 |
| `basketball/panini-haunted-hoops` | **none found** | — | — | — | — |


All four resolve to 100% agreement with year N — the strongest H1 evidence in the
census, and it was hidden behind a setKey mismatch. Those four also carry a second
defect worth its own lane: the hobbymonitor crawl mints `panini-donruss-optic`
where the corpus says `donruss-optic`, so 24,384 rows sit off the pool their own
checklist occupies. That is a setKey question, not a year question, and is not
ruled here.


**`basketball/panini-haunted-hoops` (2,100 rows) needs checklist acquisition.**
No checklist source holds it at 2024 or 2025, and no sibling key carries it: the
only rows in the container are the hobbymonitor rows themselves. Its year cannot be
adjudicated from the corpus, and this product needs a checklist, not a ruling.


---

## 3. The 30 numbers that agree with neither year, shown verbatim

Every one is a checklist artefact or a name-format difference. None is a year
disagreement, and none supports H2.

#### `football/panini-select` — 5 numbers agree with neither year

```
#524
  hobbymonitor  Tyler Shough — "2024 Panini Select Football" (y2025, Tie-Dye Prizm) [hobbymonitor-2026-09-04]
  hobbymonitor  Tyler Shough — "2024 Panini Select Football" (y2025, Gold Prizm) [hobbymonitor-2026-09-04]
  checklist 2024  XRCAUTO4 — "panini select football" (y2024, Mystery Autograph Prizm Redemption) [checklistcenter-2026-09-05]
  checklist 2024  XRCAUTO4 — "2024 panini select" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  XRCAUTO4 — "2024 panini select" (y2024) [checklistinsider-2026-08-28]
#525
  hobbymonitor  Shedeur Sanders — "2024 Panini Select Football" (y2025) [hobbymonitor-2026-09-04]
  hobbymonitor  Shedeur Sanders — "2024 Panini Select Football" (y2025, Black Prizm) [hobbymonitor-2026-09-04]
  checklist 2024  XRCAUTO5 — "2024 panini select" (y2024, Tie-Dye) [checklistinsider-2026-08-27]
  checklist 2024  XRCAUTO5 — "panini select football" (y2024, Mystery Autograph Tie-Dye Prizm Redemption) [checklistcenter-2026-09-05]
  checklist 2024  XRCAUTO5 — "2024 panini select" (y2024) [checklistinsider-2026-08-28]
#523
  hobbymonitor  Tetairoa McMillan — "2024 Panini Select Football" (y2025) [hobbymonitor-2026-09-04]
  hobbymonitor  Tetairoa McMillan — "2024 Panini Select Football" (y2025, Gold Prizm) [hobbymonitor-2026-09-04]
  checklist 2024  XRCAUTO3 — "2024 panini select" (y2024, Tie-Dye) [checklistinsider-2026-08-27]
  checklist 2024  XRCAUTO3 — "panini select football" (y2024, Mystery Autograph Prizm Redemption) [checklistcenter-2026-09-05]
  checklist 2024  XRCAUTO3 — "panini select football" (y2024, Mystery Autograph Tie-Dye Prizm Redemption) [checklistcenter-2026-09-05]
#521
  hobbymonitor  Travis Hunter — "2024 Panini Select Football" (y2025) [hobbymonitor-2026-09-04]
  hobbymonitor  Travis Hunter — "2024 Panini Select Football" (y2025, Black Prizm) [hobbymonitor-2026-09-04]
  checklist 2024  XRCAUTO1 — "panini select football" (y2024, Mystery Autograph Tie-Dye Prizm Redemption) [checklistcenter-2026-09-05]
  checklist 2024  XRCAUTO1 — "2024 panini select" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  XRCAUTO1 — "panini select football" (y2024, Mystery Autograph Prizm Redemption) [checklistcenter-2026-09-05]
#522
  hobbymonitor  Ashton Jeanty — "2024 Panini Select Football" (y2025, Black Prizm) [hobbymonitor-2026-09-04]
  hobbymonitor  Ashton Jeanty — "2024 Panini Select Football" (y2025, Tie-Dye Prizm) [hobbymonitor-2026-09-04]
  checklist 2024  XRCAUTO2 — "2024 panini select" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  XRCAUTO2 — "panini select football" (y2024, Mystery Autograph Tie-Dye Prizm Redemption) [checklistcenter-2026-09-05]
  checklist 2024  XRCAUTO2 — "panini select football" (y2024, Mystery Autograph Black Prizm Redemption) [checklistcenter-2026-09-05]
```

#### `basketball/topps-cosmic-chrome` — 1 numbers agree with neither year

```
#101
  hobbymonitor  Darius Garland — "2025/26 Topps Cosmic Chrome Basketball" (y2026, Nucleus Refractor) [hobbymonitor-2026-09-04]
  hobbymonitor  Darius Garland — "2025/26 Topps Cosmic Chrome Basketball" (y2026, White Hole Refractor) [hobbymonitor-2026-09-04]
  checklist 2025  Nikola Jović — "2025 topps cosmic chrome" (y2025, Blue Moon Refractor) [checklistinsider-2026-08-27]
  checklist 2025  Nikola Jović — "2025 topps cosmic chrome" (y2025, Nucleus Refractor 120 Packs) [checklistinsider-2026-08-27]
  checklist 2025  Nikola Jović — "2025 topps cosmic chrome" (y2025, Refractor 110 Packs) [checklistinsider-2026-08-27]
```

#### `basketball/panini-immaculate` — 1 numbers agree with neither year

```
#2
  hobbymonitor  Bub Carrington — "2024/25 Panini Immaculate Basketball" (y2025, International Red) [hobbymonitor-2026-09-04]
  hobbymonitor  Damian Lillard — "2024/25 Panini Immaculate Basketball" (y2025, Red) [hobbymonitor-2026-09-04]
  checklist 2024  Stephen Curry — "2024 Panini Immaculate Collection Basketball" (y2024, Base) [ingest-auto-seed]
```

#### `basketball/topps-inception` — 1 numbers agree with neither year

```
#90
  hobbymonitor  Dirk Nowitzki — "2024/25 Topps Inception Basketball" (y2025, Inception) [hobbymonitor-2026-09-04]
  hobbymonitor  Dirk Nowitzki — "2024/25 Topps Inception Basketball" (y2025, Pink) [hobbymonitor-2026-09-04]
  checklist 2024  Dirk Nowitzski — "2024 topps inception" (y2024, Inception) [checklistinsider-2026-08-27]
  checklist 2024  Dirk Nowitzski — "2024 topps inception" (y2024, Camo) [checklistinsider-2026-08-27]
  checklist 2024  Dirk Nowitzski — "2024 topps inception" (y2024, Holo Gold) [checklistinsider-2026-08-27]
  checklist 2025  Dirk Nowitzski — "2025 Topps Inception Basketball" (y2025, Base) [cardboardchecklist-scraped-2026-08-14]
```

#### `basketball/panini-flawless` — 15 numbers agree with neither year

```
#146
  hobbymonitor  Jalen Williams — "2023/24 Panini Flawless Basketball" (y2025, Platinum) [hobbymonitor-2026-09-04]
  hobbymonitor  Paolo Banchero — "2023/24 Panini Flawless Basketball" (y2025, Bronze) [hobbymonitor-2026-09-04]
  checklist 2023  Paolo Banchero /Jalen Williams — "2023 panini flawless" (y2023) [checklistinsider-2026-08-28]
  checklist 2023  Jalen Williams/Paolo Banchero — "2023 panini flawless" (y2023, Platinum) [checklistinsider-2026-08-27]
  checklist 2023  Paolo Banchero /Jalen Williams — "2023 panini flawless" (y2023, Bronze) [checklistinsider-2026-08-27]
#144
  hobbymonitor  Shai Gilgeous-Alexander — "2023/24 Panini Flawless Basketball" (y2025, Platinum) [hobbymonitor-2026-09-04]
  hobbymonitor  Shai Gilgeous-Alexander — "2023/24 Panini Flawless Basketball" (y2025, Bronze) [hobbymonitor-2026-09-04]
  checklist 2023  Shai Gilgeous-Alexander/Trae Young — "2023 panini flawless" (y2023) [checklistinsider-2026-08-28]
  checklist 2023  Shai Gilgeous-Alexander/Trae Young — "2023 panini flawless" (y2023, Platinum) [checklistinsider-2026-08-27]
  checklist 2023  Shai Gilgeous-Alexander/Trae Young — "2023 panini flawless" (y2023, Bronze) [checklistinsider-2026-08-27]
#169
  hobbymonitor  Dwyane Wade — "2023/24 Panini Flawless Basketball" (y2025, Platinum) [hobbymonitor-2026-09-04]
  hobbymonitor  Dwyane Wade — "2023/24 Panini Flawless Basketball" (y2025, Bronze) [hobbymonitor-2026-09-04]
  checklist 2023  Dwyane Wade/LeBron James — "2023 panini flawless" (y2023, Bronze) [checklistinsider-2026-08-27]
  checklist 2023  Dwyane Wade/LeBron James — "2023 panini flawless" (y2023) [checklistinsider-2026-08-28]
  checklist 2023  Dwyane Wade/LeBron James — "2023 panini flawless" (y2023, Platinum) [checklistinsider-2026-08-27]
#142
  hobbymonitor  Victor Wembanyama — "2023/24 Panini Flawless Basketball" (y2025, Bronze) [hobbymonitor-2026-09-04]
  hobbymonitor  Brandon Miller — "2023/24 Panini Flawless Basketball" (y2025) [hobbymonitor-2026-09-04]
  checklist 2023  Victor Wembanyama/Brandon Miller — "2023 panini flawless" (y2023, Platinum) [checklistinsider-2026-08-27]
  checklist 2023  Brandon Miller/Victor Wembanyama — "2023 panini flawless" (y2023) [checklistinsider-2026-08-28]
  checklist 2023  Victor Wembanyama/Brandon Miller — "2023 panini flawless" (y2023, Bronze) [checklistinsider-2026-08-27]
#172
  hobbymonitor  David Robinson — "2023/24 Panini Flawless Basketball" (y2025, Bronze) [hobbymonitor-2026-09-04]
  hobbymonitor  David Robinson — "2023/24 Panini Flawless Basketball" (y2025) [hobbymonitor-2026-09-04]
  checklist 2023  Tim Duncan/David Robinson — "2023 panini flawless" (y2023) [checklistinsider-2026-08-28]
  checklist 2023  Tim Duncan/David Robinson — "2023 panini flawless" (y2023, Bronze) [checklistinsider-2026-08-27]
  checklist 2023  Tim Duncan/David Robinson — "2023 panini flawless" (y2023, Platinum) [checklistinsider-2026-08-27]
```

#### `basketball/panini-eminence` — 7 numbers agree with neither year

```
#15
  hobbymonitor  Bob Cousy — "2024/25 Panini Eminence Basketball" (y2025, Platinum) [hobbymonitor-2026-09-04]
  hobbymonitor  Larry Bird — "2024/25 Panini Eminence Basketball" (y2025, Gold) [hobbymonitor-2026-09-04]
  checklist 2024  Shaquille O'Neal — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  Anthony Edwards — "panini eminence basketball" (y2024, Platinum) [checklistcenter-2026-09-06]
  checklist 2024  Anthony Edwards — "panini eminence basketball" (y2024, Gold) [checklistcenter-2026-09-06]
#48
  hobbymonitor  Jordan Poole — "2024/25 Panini Eminence Basketball" (y2025) [hobbymonitor-2026-09-04]
  checklist 2024  OG Anunoby — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
#11
  hobbymonitor  Trae Young — "2024/25 Panini Eminence Basketball" (y2025, Platinum) [hobbymonitor-2026-09-04]
  hobbymonitor  Trae Young — "2024/25 Panini Eminence Basketball" (y2025, Gold) [hobbymonitor-2026-09-04]
  checklist 2024  Clyde Drexler — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  Derrick Rose — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  LeBron James — "2024 panini eminence" (y2024, Eminence) [checklistinsider-2026-08-27]
#42
  hobbymonitor  Bronny James Jr. — "2024/25 Panini Eminence Basketball" (y2025) [hobbymonitor-2026-09-04]
  checklist 2024  JJ Redick — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  Karl-Anthony Towns — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
#6
  hobbymonitor  Larry Bird — "2024/25 Panini Eminence Basketball" (y2025, Gold) [hobbymonitor-2026-09-04]
  hobbymonitor  Trae Young — "2024/25 Panini Eminence Basketball" (y2025) [hobbymonitor-2026-09-04]
  checklist 2024  Tim Duncan — "2024 panini eminence" (y2024) [checklistinsider-2026-08-28]
  checklist 2024  Cade Cunningham — "panini eminence basketball" (y2024, Platinum) [checklistcenter-2026-09-06]
  checklist 2024  Karl-Anthony Towns — "panini eminence basketball" (y2024) [checklistcenter-2026-09-06]
```


Reading them: `panini-select` #521-525 are unfilled **redemption placeholders** —
the checklist literally stores `XRCAUTO1`..`XRCAUTO5` as the player name while
hobbymonitor carries the redeemed player. `panini-flawless` is **dual-player
cards** — the checklist stores "Wembanyama/Miller" in one field, hobbymonitor
splits it into a row per name. `topps-inception` #90 is a **checklist typo**
("Nowitzski" for Nowitzki). `panini-eminence` is the one product whose own two
checklist sources disagree with each other. In no case does the year-N+1 checklist
explain the row.


### And the alphanumeric disagreements are subset-prefix collisions

```
football/topps-finest #MYST-32
  hobbymonitor  Ray Lewis — "2024 Topps Finest Football"
  checklist 2024  Bruce Smith — "2024 topps finest" (Common Blue Refractor)

football/topps-finest #DA-SM
  hobbymonitor  Warren Moon — "2024 Topps Finest Football"
  checklist 2024  CJ Stroud — "2024 topps finest" (Common Purple Refractor)

basketball/topps-royalty #RA-JWA
  hobbymonitor  Jordan Walsh — "2023/24 Topps Royalty Basketball"
  checklist 2023  Jarace Walker — "2023 topps royalty"
```

Two different inserts inside one product share a numeric tail once the prefix is
read loosely (`MYST-` Mystery vs another subset at 32; `RA-JWA` Jordan Walsh read
onto Jarace Walker). This is the collision shape #1917 hypothesised, confirmed —
and it is confined to 18 of 4,096 alphanumeric numbers.


---

## 4. The collision: two cards, one card number

This is the finding that reinterprets #1917's 21%. For 8 products the same crawl
also minted the genuine year-N+1 card, correctly labelled, under the same card
number — so the number carries two players on sibling parallel slugs, and the
mislabelled year-N row is sitting inside the year-N+1 product's numbering.

| product | card numbers carrying BOTH a year-N and a year-N+1 card | of those, different player | sales resident on the mislabelled slugs | title says N | title says N+1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `football/topps-chrome` | 300 | 300 | 3,452 | 0 | 3,452 |
| `basketball/panini-select` | 0 | 0 | 83 | 0 | 83 |
| `football/panini-phoenix` | 250 | 245 | 313 | 0 | 313 |
| `football/panini-select` | 500 | 488 | 188 | 0 | 187 |
| `football/topps-resurgence` | 100 | 100 | 1,742 | 0 | 1,742 |
| `football/topps-finest` | 300 | 296 | 1,161 | 0 | 1,161 |
| `basketball/topps-cosmic-chrome` | 0 | 0 | 3 | 0 | 3 |
| `basketball/panini-revolution` | 0 | 0 | 1 | 0 | 1 |
| `basketball/topps-finest` | 300 | 300 | 313 | 0 | 312 |
| `football/panini-contenders` | 0 | 0 | 30 | 0 | 29 |
| `basketball/topps-inception` | 100 | 99 | 554 | 0 | 553 |
| `basketball/panini-origins` | 46 | 46 | 0 | 0 | 0 |
| `basketball/panini-flawless` | 0 | 0 | 1 | 0 | 1 |
| `basketball/panini-national-treasures` | 0 | 0 | 3 | 0 | 3 |
| `football/panini-impeccable` | 37 | 35 | 9 | 0 | 9 |
| `football/panini-immaculate` | 134 | 129 | 52 | 0 | 52 |
| **total** | **2,067** | **2,038** | **7,905** | **0** | **7,901** |

### Shown verbatim, with the sales that live there

#### `football/topps-chrome` (N=2024, N+1=2025)

```
#198   year-2024 row names: rypien   |   year-2025 row names: ginkel
    sale on that slug: 2025 Topps Chrome Football #198 Team Camo Variation
    sale on that slug: 2025 Topps Chrome Football #198 Team Camo Variation
    sale on that slug: 2025 Topps Chrome Football #198 Team Camo Variation
#149   year-2024 row names: chrebet   |   year-2025 row names: pacheco
    sale on that slug: 2025 Topps Chrome Football #149 Black Lava Refractor
    sale on that slug: 2025 Topps Chrome Football #149 RayWave Refractor
    sale on that slug: 2025 Topps Chrome Isiah Pacheco #149 Kansas City Chiefs Yellow Wave /275 - Raw
#163   year-2024 row names: harrison   |   year-2025 row names: tuipulotu
    sale on that slug: 2025 Topps Chrome Football #163 Pink Refractor
    sale on that slug: 2025 Topps Chrome #163 Tuli Tuipulotu Purple Lava #/75 - Raw
    sale on that slug: 2025 Topps Chrome Football Tuli Tuipulotu /275 Yellow Wave Refractor #163 - Raw
```

#### `football/panini-phoenix` (N=2024, N+1=2025)

```
#18   year-2024 row names: mahomes, purdy, robinson   |   year-2025 row names: harrison, fouts, harris
    sale on that slug: 2025 Panini Phoenix Football #18 Wave
    sale on that slug: 2025 Panini Phoenix Football #18 Silver Winter
    sale on that slug: Panini Phoenix Thunderbirds Jordan Love Green Bay Packers #18 Serial /49 2025
#10   year-2024 row names: coleman, ekeler, nix   |   year-2025 row names: burrow, henry, warren
    sale on that slug: 2025 Panini Phoenix - Paragon Ashton Jeanty #10 (RC)
    sale on that slug: Panini 2025 Phoenix Football Thunderbirds Joe Burrow Bengals #10 /99
    sale on that slug: ASHTON JEANTY 2025 PHOENIX PARAGON SILVER SEISMIC ROOKIE RC /99 #10 Q5939
#31   year-2024 row names: rattler, prescott, bell   |   year-2025 row names: adams, myers, gabriel
    sale on that slug: 2025 Phoenix Contours Blue Cam Ward /199 RC Color Match #31 Tennessee Titans
    sale on that slug: 2025 Panini Phoenix Football #31 Orange Lazer
    sale on that slug: 2025 Panini Phoenix Football #31 Bronze Pandora
```

#### `football/panini-select` (N=2024, N+1=2025)

```
#193   year-2024 row names: higgins   |   year-2025 row names: dart
    sale on that slug: 2025 Panini Select Football #193 Black and Gold Shock
    sale on that slug: 2025 Panini Select Football #193 Black and Gold Shock
    sale on that slug: 2025 Panini Select Football #193 Black and Gold Shock
#289   year-2024 row names: mccloud   |   year-2025 row names: daniels
    sale on that slug: JAYDEN DANIELS 2025 SELECT CLUB LEVEL #289 COMMANDERS Q5939
    sale on that slug: 2025 Panini Select Jayden Daniels Club Level Red and Blue Prizm Shock #289
    sale on that slug: Panini 2025 Select Jayden Daniels Washington Commanders #289 Prizm Club Level
#37   year-2024 row names: purdy, stafford, hendrickson   |   year-2025 row names: burns, waddle, egbuka
    sale on that slug: 2025 Panini Select Football #37 Pink Shock
    sale on that slug: 2025 Panini Select Football #37 Pink Shock
    sale on that slug: 2025 Panini Select Football #37 Pink Shock
```

#### `football/topps-resurgence` (N=2024, N+1=2025)

```
#16   year-2024 row names: dent   |   year-2025 row names: williams
    sale on that slug: Caleb Williams .. BLUE & PINK SHOCK .. Bears .. 2025 Topps Resurgence Card 16
    sale on that slug: 2025 Topps Resurgence Caleb Williams Magenta Surge /299 #16
    sale on that slug: Topps Resurgence 2025 Caleb Williams Chicago Bears Black White Surge #16 374/399
#19   year-2024 row names: esiason   |   year-2025 row names: burrow
    sale on that slug: 2025 Topps Resurgence Joe Burrow Refractor #19 Cincinnati Bengals - Raw
    sale on that slug: 2025 Topps Resurgence #19 Joe Burrow Refractor - Raw
    sale on that slug: JOE BURROW 2025 TOPPS RESURGENCE FOOTBALL REFRACTOR #19 CINCINNATI BENGALS Q2277 - Raw
#69   year-2024 row names: brees   |   year-2025 row names: olave
    sale on that slug: CHRIS OLAVE 2025 Topps Resurgence #69 Silver Static Refractor
    sale on that slug: 2025 Topps Resurgence #69 Chris Olave Aqua Surge Refractor #/250 Saints - Raw
    sale on that slug: 2025 Topps Resurgence #69 Chris Olave Refractor New Orleans Saints - Raw
```

#### `football/topps-finest` (N=2024, N+1=2025)

```
#227   year-2024 row names: cunningham   |   year-2025 row names: young
    sale on that slug: 2025 TOPPS FINEST FOOTBALL Bryce Young Carolina Panthers #227 RARE SP
    sale on that slug: 2025 Finest #227 Bryce Young Purple X-Fractor #/75 - Raw
    sale on that slug: 2025 Topps Finest Bryce Young #227 Rare Purple X-Fractor 47/75 Carolina Panthers - Raw
#154   year-2024 row names: dejean   |   year-2025 row names: taylor
    sale on that slug: 2025 Finest #154 Jonathan Taylor Green Refractor #/35 - Raw
    sale on that slug: 2025 Topps Finest Football #154 Oil Spill Refractor
    sale on that slug: 2025 Topps Finest Football #154 Oil Spill Refractor
#184   year-2024 row names: stover   |   year-2025 row names: kittle
    sale on that slug: 2025 Topps Chrome Jeremy Chinn Refractor Hot Pink X-Fractor #184 Raiders NICE 9
    sale on that slug: 2025 Topps Finest - Uncommon George Kittle #184 Purple Refractor /200
    sale on that slug: 2025 Topps Finest Football #184 Base
```

#### `basketball/topps-finest` (N=2024, N+1=2025)

```
#210   year-2024 row names: n   |   year-2025 row names: maluach
    sale on that slug: 2025-26 Topps Finest Khaman Maluach RC #210 Mint Sp
    sale on that slug: Khaman Maluach 2025-26 Topps Finest Rare Blue X-Fractor Base RC /49 #210 - Raw
    sale on that slug: 2025-26 Topps Finest Khaman Maluach Rare #210 RC & #10 Common & F-10 First Base - Raw
#201   year-2024 row names: young   |   year-2025 row names: flagg
    sale on that slug: 2025-26 Topps Finest Basketball Cooper Flagg #201 Rare Rookie RC Mavericks READ
    sale on that slug: 2025-26 Topps Finest Basketball Cooper Flagg #201 Rare Rookie RC Mavericks
    sale on that slug: 2025-26 Topps Finest Cooper Flagg Rare RC Rookie #201 Mavericks
#4   year-2024 row names: risacher   |   year-2025 row names: knueppel
    sale on that slug: 2025-26 Topps Finest Kon Knueppel #4 Common RC Rookie Blue Refractor /200 - Raw
    sale on that slug: 2025 Topps Finest Basketball #4 Blue Geometric Refractor
    sale on that slug: 2025 Topps Finest Basketball #4 Gold Geometric Refractor
```

#### `basketball/topps-inception` (N=2024, N+1=2025)

```
#63   year-2024 row names: tatum   |   year-2025 row names: reaves
    sale on that slug: 2025 Topps Inception Basketball #63 Green
    sale on that slug: Austin Reaves 2025-26 Topps Inception Green Card No 63 Los Angeles Lakers - Raw
    sale on that slug: AUSTIN REAVES 2025-26 TOPPS INCEPTION GOLD ELECTRICITY /50 #63 LAKERS Q1829
#92   year-2024 row names: bird   |   year-2025 row names: martin
    sale on that slug: 2025 Topps Inception Basketball #92 Sky Blue
    sale on that slug: ALIJAH MARTIN 2025-26 TOPPS INCEPTION SKY BLUE ROOKIE RC 1/5 #92 RAPTORS Q2161 - Raw
    sale on that slug: Alijah Martin 2025-26 Topps Inception 10/10 Camo RC Raptors #92 - Raw
#23   year-2024 row names: scheierman   |   year-2025 row names: irving
    sale on that slug: Kyrie Irving 2025 Topps Inception #23 Red /75 - Raw
    sale on that slug: 2025 Topps Inception Basketball #23 Red
    sale on that slug: 2025-26 Topps Inception Kyrie Irving Red /75 Mavericks #23 - Raw
```

#### `basketball/panini-origins` (N=2024, N+1=2025)

```
#3   year-2024 row names: doncic, anthony, walter   |   year-2025 row names: cunningham, fears, quaintance
    sale on that slug: VICTOR WEMBANYAMA 2025-26 Panini Origins Euroleague Case H2 20xBoxBreak#3
    sale on that slug: LUKA DONCIC 2025-26 Panini Origins Euroleague Case H2 20xBoxBreak#3
    sale on that slug: DEVIN BOOKER 2025-26 Panini Origins Euroleague Case H2 20xBoxBreak#3
#10   year-2024 row names: anthony, salaun, wells   |   year-2025 row names: gonzalez, yang, lendeborg
    sale on that slug: 2025-26 Panini Origins Euroleague Victor Wembanyama #10 Catapults
```

#### `football/panini-impeccable` (N=2024, N+1=2025)

```
#8   year-2024 row names: penix, kincaid, tucker   |   year-2025 row names: blue, warner, barron
    sale on that slug: 2025 Impeccable Silver NFL Shield #8 Tyler Warren RC ROOKIE 1 TROY OUNCE 03/35
    sale on that slug: 2025 Panini Impeccable NFL Shields Silver /35 Tyler Warren #8 Rookie RC
    sale on that slug: 2025 Panini Impeccable NFL Shields Silver /35 Tyler Warren #8 Rookie RC - Raw
#18   year-2024 row names: sanders, polk, brooks   |   year-2025 row names: singletary, page, shakir
    sale on that slug: 2025 Panini Impeccable - CeeDee Lamb #18 Silver /60 - Raw
    sale on that slug: CEEDEE LAMB 2025 IMPECCABLE SILVER #18 /80 COWBOYS Q3539
#14   year-2024 row names: flowers, brooks, allen   |   year-2025 row names: thomas, hunter, mcnabb
    sale on that slug: 2025 Panini Impeccable - Ja'Marr Chase #14 /80 - Raw
```

#### `football/panini-immaculate` (N=2024, N+1=2025)

```
#95   year-2024 row names: pickens   |   year-2025 row names: bosa
    sale on that slug: Panini Immaculate 2025 Nick Bosa Serial Numbered Red /75 Memorabilia 49ers #95
#7   year-2024 row names: legette, stenerud, robinson   |   year-2025 row names: lewis, cobb, manning
    sale on that slug: MYLES GARRETT 2025 IMMACULATE FOTL EMERALD /26 #7 FOOTBALL BROWNS Q0072
    sale on that slug: 2025 Immaculate Collection Michael Penix Jr. Drake Maye Gold Dual #7/10
#47   year-2024 row names: watt, robinson   |   year-2025 row names: latu, nacua
    sale on that slug: 2025 Panini Immaculate Puka Nacua #47  50 AND 51/99 Los Angeles Rams + Kyren
```


The pattern is exact and repeats across every product: the year-N row names the
year-N player, the year-N+1 row names the year-N+1 player, and **every sale title
names the year-N+1 player**. Attributing sales on the colliding numbers by the
player their title names: 7,187 name the year-N+1 player against 42 naming the
year-N player, with 5,428 titles naming no player at all (a bare
"2025 Topps Chrome Football #58 Prism Refractor" states the year and the number
but not the name).


So the sales are year-N+1 sales, and they are resting on rows that name the year-N
player. Moving those rows to their own year is what separates the two products; the
sales must stay with the year-N+1 identity rather than travel with the row, which
is the one thing `moveCatalogRow` does NOT do by default — it re-points a row's own
sales to the new slug (`catalogRowOps.service.ts`, the `/hobbyiqCardId` patch), and
here that would carry 7,905 genuine 2025 sales back to 2024.


---

## 5. Where a mislabelled row would go

150 rows sampled per product, destination = the same slug with its year segment
rewritten from N+1 to N, read as a point read on `/cardId`:

| product | sampled | year-N destination vacant | occupied, same player | occupied, DIFFERENT player |
| --- | ---: | ---: | ---: | ---: |
| `basketball/panini-donruss-optic` | 150 | 5 | 131 | 14 |
| `football/topps-chrome` | 150 | 30 | 105 | 1 |
| `basketball/panini-select` | 150 | 3 | 125 | 22 |
| `football/panini-phoenix` | 150 | 4 | 138 | 8 |
| `football/panini-select` | 150 | 79 | 56 | 15 |
| `football/topps-resurgence` | 150 | 0 | 150 | 0 |
| `basketball/topps-royalty` | 150 | 63 | 87 | 0 |
| `football/topps-finest` | 150 | 145 | 4 | 1 |
| `basketball/topps-cosmic-chrome` | 150 | 128 | 22 | 0 |
| `basketball/panini-revolution` | 150 | 0 | 134 | 16 |
| `basketball/topps-finest` | 150 | 40 | 110 | 0 |
| `basketball/panini-noir` | 150 | 43 | 90 | 17 |
| `basketball/panini-immaculate` | 150 | 100 | 48 | 2 |
| `football/panini-contenders` | 150 | 116 | 15 | 19 |
| `basketball/panini-silhouette` | 150 | 35 | 76 | 39 |
| `basketball/topps-inception` | 150 | 17 | 133 | 0 |
| `basketball/topps-three` | 150 | 40 | 104 | 6 |
| `basketball/panini-haunted-hoops` | 150 | 150 | 0 | 0 |
| `basketball/panini-one-one` | 150 | 150 | 0 | 0 |
| `basketball/panini-prizm-black` | 150 | 111 | 31 | 8 |
| `basketball/panini-origins` | 150 | 12 | 98 | 40 |
| `basketball/panini-flawless` | 150 | 47 | 52 | 51 |
| `basketball/panini-national-treasures` | 150 | 37 | 109 | 4 |
| `football/panini-impeccable` | 150 | 51 | 70 | 29 |
| `football/panini-clearly-donruss` | 150 | 131 | 0 | 19 |
| `football/panini-immaculate` | 150 | 140 | 8 | 2 |
| `basketball/panini-eminence` | 150 | 69 | 17 | 64 |
| `basketball/topps-chrome` | 150 | 42 | 108 | 0 |
| **total** | **4,200** | **1,788** | **2,021** | **377** |

A relocation lane is therefore viable but must be collision-aware. 42.6% of
destinations are vacant and 48.1% hold the same player and fold; the 9.0% holding a
different player must be reported and excluded, exactly as #1912 excluded
`hiq:hockey:202:upper-deck:1` rather than routing around it. Retire is a hard
delete in this lane, so no entry should be a retire.


---

## 6. Verdict per product

#### `basketball/panini-donruss-optic` — **H1**

Of 350 card numbers compared, 350 agree with the 2024 checklist and 0 with the 2025 one. The comparison runs against the sibling setKey `donruss-optic` — this product has no checklist rows under its own `panini-donruss-optic` key at either year, which is a setKey mismatch and not an acquisition gap. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `football/topps-chrome` — **H1**

Of 300 card numbers compared, 300 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 300 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 3,452 sales resident there name the year-2025 player.

#### `basketball/panini-select` — **H1**

Of 400 card numbers compared, 400 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. 83 sales sit on these slugs.

#### `football/panini-phoenix` — **H1**

Of 250 card numbers compared, 250 agree with the 2024 checklist and 9 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 245 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 313 sales resident there name the year-2025 player.

#### `football/panini-select` — **H1**

Of 525 card numbers compared, 520 agree with the 2024 checklist and 2 with the 2025 one, with 5 agreeing with neither. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 488 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 188 sales resident there name the year-2025 player.

#### `football/topps-resurgence` — **H1**

Of 102 card numbers compared, 102 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 100 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 1,742 sales resident there name the year-2025 player.

#### `basketball/topps-royalty` — **H1**

Of 125 card numbers compared, 125 agree with the 2023 checklist and 0 with the 2025 one. The number-to-player map is the year-2023 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `football/topps-finest` — **H1**

Of 300 card numbers compared, 300 agree with the 2024 checklist and 3 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 296 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 1,161 sales resident there name the year-2025 player.

#### `basketball/topps-cosmic-chrome` — **H1**

Of 199 card numbers compared, 198 agree with the 2025 checklist and 0 with the 2026 one, with 1 agreeing with neither. The number-to-player map is the year-2025 product, so the setName is right and the `year` field is wrong. 3 sales sit on these slugs.

#### `basketball/panini-revolution` — **H1**

Of 175 card numbers compared, 175 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. 1 sales sit on these slugs.

#### `basketball/topps-finest` — **H1**

Of 300 card numbers compared, 300 agree with the 2024 checklist and 300 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 300 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 313 sales resident there name the year-2025 player.

#### `basketball/panini-noir` — **H1**

Of 388 card numbers compared, 388 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `basketball/panini-immaculate` — **H1**

Of 13 card numbers compared, 12 agree with the 2024 checklist and 0 with the 2025 one, with 1 agreeing with neither. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `football/panini-contenders` — **H1**

Of 268 card numbers compared, 268 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. 30 sales sit on these slugs.

#### `basketball/panini-silhouette` — **H1**

Of 100 card numbers compared, 100 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `basketball/topps-inception` — **H1**

Of 100 card numbers compared, 99 agree with the 2024 checklist and 99 with the 2025 one, with 1 agreeing with neither. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 99 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 554 sales resident there name the year-2025 player.

#### `basketball/topps-three` — **H1**

Of 127 card numbers compared, 127 agree with the 2023 checklist and 1 with the 2025 one. The number-to-player map is the year-2023 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `basketball/panini-haunted-hoops` — **needs-checklist**

No checklist source holds this product at 2024 or 2025, and no sibling setKey carries it either — the only rows in the container under `basketball/panini-haunted-hoops` are the 2,100 hobbymonitor rows themselves. All 300 numeric card numbers are unbacked, so the year cannot be adjudicated from the corpus. This product needs checklist acquisition, not a ruling.

#### `basketball/panini-one-one` — **H1**

Of 180 card numbers compared, 180 agree with the 2024 checklist and 0 with the 2025 one. The comparison runs against the sibling setKey `panini-one-and-one` — this product has no checklist rows under its own `panini-one-one` key at either year, which is a setKey mismatch and not an acquisition gap. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `basketball/panini-prizm-black` — **H1**

Of 300 card numbers compared, 300 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `basketball/panini-origins` — **H1**

Of 100 card numbers compared, 100 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 46 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 0 sales resident there name the year-2025 player.

#### `basketball/panini-flawless` — **H1**

Of 200 card numbers compared, 185 agree with the 2023 checklist and 0 with the 2025 one, with 15 agreeing with neither. The number-to-player map is the year-2023 product, so the setName is right and the `year` field is wrong. 1 sales sit on these slugs.

#### `basketball/panini-national-treasures` — **H1**

Of 191 card numbers compared, 191 agree with the 2024 checklist and 0 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. 3 sales sit on these slugs.

#### `football/panini-impeccable` — **H1**

Of 100 card numbers compared, 100 agree with the 2024 checklist and 11 with the 2025 one. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 35 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 9 sales resident there name the year-2025 player.

#### `football/panini-clearly-donruss` — **H1**

Of 76 card numbers compared, 76 agree with the 2024 checklist and 0 with the 2025 one. The comparison runs against the sibling setKey `clearly-donruss` — this product has no checklist rows under its own `panini-clearly-donruss` key at either year, which is a setKey mismatch and not an acquisition gap. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `football/panini-immaculate` — **H1**

Of 142 card numbers compared, 142 agree with the 2024 checklist and 19 with the 2025 one. The comparison runs against the sibling setKey `panini-immaculate-collection` — this product has no checklist rows under its own `panini-immaculate` key at either year, which is a setKey mismatch and not an acquisition gap. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. The year-2025 address is however shared: 129 card numbers carry BOTH a mislabelled year-2024 card and a correctly-labelled year-2025 card naming a different player, on sibling parallel slugs, and the 52 sales resident there name the year-2025 player.

#### `basketball/panini-eminence` — **H1**

Of 70 card numbers compared, 63 agree with the 2024 checklist and 0 with the 2025 one, with 7 agreeing with neither. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.

#### `basketball/topps-chrome` — **H1**

Its 298 rows carry only alphanumeric insert numbers; the alpha pass compared 199 of them and 199 agree with 2024. The number-to-player map is the year-2024 product, so the setName is right and the `year` field is wrong. No sales are resident on these slugs.


---

## What this report does not claim

It writes nothing. The reslug lane it recommends needs its list built and reviewed
separately, and the per-card destination check has been sampled (4,200 rows) rather
than run to completion across all 141,304. The setKey defect named in section 2
(`panini-donruss-optic` vs `donruss-optic` and its three siblings) is reported
because the census tripped over it, and is not ruled here.
