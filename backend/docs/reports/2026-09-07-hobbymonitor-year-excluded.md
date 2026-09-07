# The rows this repair will not touch, and why each one is out

**2026-09-07 — report-only. This document names rows that are DELIBERATELY absent from every list in
`backend/data/catalog-relocations/2026-09-07-hobbymonitor-year-*.json`.**

#1925 ruled H1 for 27 of 28 hobbymonitor products: the rows are the year-N product carrying `year` = N+1,
their `setName` is right and their year field is wrong. The repair moves them to the year their own
checklist says they are. This file is the other half of that repair — the rows where the evidence does not
reach, stated per row class, so that "excluded" is a measured verdict and not a silence.

## The whole census, reconciled

| | rows |
| --- | ---: |
| mislabelled rows measured (27 products) | **139,204** |
| RESLUG — the year-N address is vacant | 37,137 |
| RETIRE — a same-player CHECKLIST twin already holds year N | 90,968 |
| **EXCLUDE — in no list** | **11,099** |

Every excluded row is in exactly one class below, and the four classes sum to 11,099.

| class | rows | sales resting on them |
| --- | ---: | ---: |
| The setKey has no ruled destination | 3,409 | 52 |
| A twin exists, but it is not checklist-backed | 1,079 | 272 |
| The year-N destination names a DIFFERENT player | 5,899 | 129 |
| The year-N destination is held by an UNNAMED row | 712 | 417 |
| **total** | **11,099** | **870** |

---

## The setKey has no ruled destination — 3,409 rows

The corpus and the vocabulary disagree about which setKey is canonical, so there is no destination to reslug to. Choosing one would be minting a ruling, and a relocation lane does not mint rulings — CF-COUNT-BY-SOURCE-NOT-ROW-COUNT decides a canonical key from a census, not from a repair.

| product | rows | sales |
| --- | ---: | ---: |
| `basketball/panini-one-one` | 2,050 | 0 |
| `football/panini-clearly-donruss` | 870 | 0 |
| `football/panini-immaculate` | 489 | 52 |

### The reasons, verbatim

**`basketball/panini-one-one`**

> setKey ambiguous: `panini-one-one` is the canonical PRODUCT_SET_KEYS entry but holds 0 checklist rows; `panini-one-and-one` holds 4,158 (checklistinsider 3,295 + checklistcenter 863) at 2024. normalizeSetKey keeps both as distinct keys and mints `202425-panini-one-and-one` from the split-season name, so neither spelling is a settled destination. Excluded pending a key ruling.

**`football/panini-clearly-donruss`**

> setKey ambiguous: neither `panini-clearly-donruss` nor `clearly-donruss` appears in PRODUCT_SET_KEYS, and normalizeSetKey('panini clearly donruss') collapses to `panini-donruss` — the #1715 flagship swallow. 5,276 checklist rows sit under `clearly-donruss` at 2024 and 0 under the prefixed spelling. Excluded pending a key ruling.

**`football/panini-immaculate`**

> setKey ambiguous: `panini-immaculate` is the canonical PRODUCT_SET_KEYS entry but holds 0 checklist rows; `panini-immaculate-collection` holds 5,722 at 2024 (and 6,443 at 2025). Both are normalizeSetKey fixed points, so the corpus and the vocabulary disagree and neither is a settled destination. Excluded pending a key ruling.

The fourth setKey-mismatch product named in #1925 section 2, `basketball/panini-donruss-optic`, is NOT
here: `donruss-optic` IS ruled. `PRODUCT_SET_KEYS` carries
`S("donruss-optic", { names: ["panini-optic", "panini-donruss-optic"] })`, all three spellings are a
`normalizeSetKey` fixed point at `donruss-optic`, and measured read-only 2026-09-07 that key holds 55,938
checklist rows at 2024 against ZERO under `panini-donruss-optic`. Its 24,384 rows are therefore in the
lists, moving to the ruled key and the true year in one reslug.

---

## A twin exists, but it is not checklist-backed — 1,079 rows

A retire in this lane is a HARD DELETE. Only a CHECKLIST-backed twin earns one: the checklist is the authority, and a same-player row from `ingest-auto-seed` or `bccp` is a derived row that may itself be the defect. Folding onto it would delete a hobbymonitor row in favour of one with less standing.

| product | rows | sales |
| --- | ---: | ---: |
| `football/panini-select` | 537 | 1 |
| `football/topps-chrome` | 359 | 179 |
| `basketball/topps-cosmic-chrome` | 151 | 1 |
| `basketball/topps-inception` | 14 | 0 |
| `football/topps-finest` | 14 | 91 |
| `basketball/panini-national-treasures` | 3 | 0 |
| `basketball/panini-select` | 1 | 0 |

### A sample, with the reason each one carries

- `hiq:basketball:2025:panini-national-treasures:42:base:no-auto`
  - player **LeBron James** #42
  - a same-player twin exists at hiq:basketball:2024:panini-national-treasures:42:base:no-auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2025:panini-national-treasures:129:base:auto`
  - player **Terrence Shannon Jr.** #129
  - a same-player twin exists at hiq:basketball:2024:panini-national-treasures:129:base:auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2025:panini-national-treasures:33:base:no-auto`
  - player **Jalen Johnson** #33
  - a same-player twin exists at hiq:basketball:2024:panini-national-treasures:33:base:no-auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2025:panini-select:215:green-tectonic-prizm:no-auto`
  - player **Paolo Banchero** #215
  - a same-player twin exists at hiq:basketball:2024:panini-select:215:green-tectonic-prizm:no-auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2026:topps-cosmic-chrome:prp-11:refractor:no-auto`
  - player **Kyrie Irving** #PRP-11
  - a same-player twin exists at hiq:basketball:2025:topps-cosmic-chrome:prp-11:refractor:no-auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2026:topps-cosmic-chrome:ess-as:base:auto`
  - player **Alperen Sengun** #ESS-AS
  - a same-player twin exists at hiq:basketball:2025:topps-cosmic-chrome:ess-as:base:auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2026:topps-cosmic-chrome:ss-jto:base:auto`
  - player **John Tonje** #SS-JTO
  - a same-player twin exists at hiq:basketball:2025:topps-cosmic-chrome:ss-jto:base:auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.
- `hiq:basketball:2026:topps-cosmic-chrome:sf-34:pink-refractor:no-auto`
  - player **Kon Knueppel** #SF-34
  - a same-player twin exists at hiq:basketball:2025:topps-cosmic-chrome:sf-34:pink-refractor:no-auto but its source is `ingest-auto-seed`, which is not a checklist source. CF-COUNT-BY-SOURCE-NOT-ROW-COUNT: a retire is a hard DELETE and only a checklist-backed twin earns one. Excluded — a fold onto a derived row is not this lane's call.

_...and 1,071 more of this class._

---

## The year-N destination names a DIFFERENT player — 5,899 rows

Two cards must never share a pricing address. Picking a winner here would be picking one by accident, so these are reported and never routed around — the #1912 precedent that excluded `hiq:hockey:202:upper-deck:1` rather than merging it.

| product | rows | sales |
| --- | ---: | ---: |
| `basketball/panini-select` | 1,088 | 80 |
| `football/panini-select` | 718 | 10 |
| `basketball/panini-donruss-optic` | 714 | 0 |
| `basketball/panini-silhouette` | 659 | 0 |
| `basketball/panini-flawless` | 495 | 0 |
| `basketball/panini-noir` | 438 | 0 |
| `basketball/panini-origins` | 389 | 0 |
| `basketball/panini-revolution` | 363 | 1 |
| `football/panini-phoenix` | 363 | 33 |
| `football/panini-contenders` | 199 | 2 |
| `football/panini-impeccable` | 186 | 2 |
| `basketball/panini-eminence` | 129 | 0 |
| `basketball/panini-prizm-black` | 81 | 0 |
| `basketball/panini-national-treasures` | 25 | 1 |
| `football/topps-chrome` | 19 | 0 |
| `football/topps-finest` | 16 | 0 |
| `basketball/topps-inception` | 8 | 0 |
| `basketball/topps-royalty` | 8 | 0 |
| `basketball/topps-cosmic-chrome` | 1 | 0 |

### A sample, with the reason each one carries

- `hiq:basketball:2025:donruss-optic:25:base:no-auto`
  - player **Zaccharie Risacher** #25
  - the 2024 destination hiq:basketball:2024:donruss-optic:25:base:no-auto is held by "Andrew Nembhard" (source checklistcenter-2026-09-05) while this row names "Zaccharie Risacher". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:18:base:no-auto`
  - player **Zaccharie Risacher** #18
  - the 2024 destination hiq:basketball:2024:donruss-optic:18:base:no-auto is held by "Rui Hachimura" (source checklistcenter-2026-09-05) while this row names "Zaccharie Risacher". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:16:base:no-auto`
  - player **Trae Young** #16
  - the 2024 destination hiq:basketball:2024:donruss-optic:16:base:no-auto is held by "Brandon Miller" (source checklistcenter-2026-09-05) while this row names "Trae Young". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:14:base:auto`
  - player **Anton Watson** #14
  - the 2024 destination hiq:basketball:2024:donruss-optic:14:base:auto is held by "Tony Parker" (source checklistcenter-2026-09-05) while this row names "Anton Watson". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:50:base:auto`
  - player **James Donaldson** #50
  - the 2024 destination hiq:basketball:2024:donruss-optic:50:base:auto is held by "Paolo Banchero" (source checklistcenter-2026-09-05) while this row names "James Donaldson". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:19:purple:no-auto`
  - player **Larry Bird** #19
  - the 2024 destination hiq:basketball:2024:donruss-optic:19:purple:no-auto is held by "Joel Embiid" (source checklistcenter-2026-09-05) while this row names "Larry Bird". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:20:red-international:no-auto`
  - player **Jayson Tatum** #20
  - the 2024 destination hiq:basketball:2024:donruss-optic:20:red-international:no-auto is held by "Naz Reid" (source checklistcenter-2026-09-05) while this row names "Jayson Tatum". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).
- `hiq:basketball:2025:donruss-optic:20:cracked-ice:no-auto:num-25`
  - player **Jayson Tatum** #20
  - the 2024 destination hiq:basketball:2024:donruss-optic:20:cracked-ice:no-auto:num-25 is held by "Naz Reid" (source checklistcenter-2026-09-05) while this row names "Jayson Tatum". Two cards must never share a pricing address, and picking a winner here would be picking one by accident — reported, never routed around (#1912 precedent).

_...and 5,891 more of this class._

---

## The year-N destination is held by an UNNAMED row — 712 rows

Blank is unknown, never "the same". The lane's own `occupiedByDifferentCard` treats an unnamed incumbent as a different card and refuses — the safe direction for a delete-bearing lane — and this list refuses the same way rather than handing the lane an entry it would reject.

| product | rows | sales |
| --- | ---: | ---: |
| `football/topps-chrome` | 712 | 417 |

### A sample, with the reason each one carries

- `hiq:football:2025:topps-chrome:237:prism-refractor:no-auto`
  - player **Joe Alt** #237
  - the 2024 destination hiq:football:2024:topps-chrome:237:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:79:prism-refractor:no-auto`
  - player **George Teague** #79
  - the 2024 destination hiq:football:2024:topps-chrome:79:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:192:prism-refractor:no-auto`
  - player **Jevon Kearse** #192
  - the 2024 destination hiq:football:2024:topps-chrome:192:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:117:prism-refractor:no-auto`
  - player **Daunte Culpepper** #117, 1 sale(s) resting here
  - the 2024 destination hiq:football:2024:topps-chrome:117:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:7:prism-refractor:no-auto`
  - player **Jim Kelly** #7
  - the 2024 destination hiq:football:2024:topps-chrome:7:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:239:prism-refractor:no-auto`
  - player **Jaylen Wright** #239
  - the 2024 destination hiq:football:2024:topps-chrome:239:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:31:prism-refractor:no-auto`
  - player **Ozzie Newsome** #31
  - the 2024 destination hiq:football:2024:topps-chrome:31:prism-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.
- `hiq:football:2025:topps-chrome:109:sepia-refractor:no-auto`
  - player **Zach Thomas** #109
  - the 2024 destination hiq:football:2024:topps-chrome:109:sepia-refractor:no-auto is held by an UNNAMED row (source bccp). Blank is unknown, never "the same" — the lane's own guard refuses an unnamed incumbent, and so does this list.

_...and 704 more of this class._

---

## What happens to the sales, and which of them have somewhere to land

`moveCatalogRow` re-points a row's own sales to its new slug by default. For this repair that default is
wrong, and #1925 measured why: the 7,905 sales resting on these rows' slugs carry titles that are
**7,901-to-0 the year-N+1 product**. They belong to the card that STAYS, not the one that moves. Every list
in this repair therefore carries `"keepSales": true`, and the lane hands `moveCatalogRow` no
`salesContainer` — the row moves and the sales' `hobbyiqCardId` and `cardId` are not touched.

That leaves the sales at their year-N+1 address for the rematch to re-derive. Measured read-only
2026-09-07, asking whether a GENUINE year-N+1 row (one that is not a mislabelled hobbymonitor row) holds
that card number:

| | sales |
| --- | ---: |
| resting on the mislabelled rows | **7,905** |
| a genuine year-N+1 row holds their card number — the rematch can place them | **7,776** |
| NO year-N+1 row holds their card number — these need a checklist ingest first | **129** |

The 129 with no row are the only ones that cannot be resolved by the rematch alone. They are
listed per product below; each needs the year-N+1 product's checklist ingested before anything can place
them.

| product | sales staying | with a genuine row | with none |
| --- | ---: | ---: | ---: |
| `basketball/panini-select` | 83 | 4 | **79** |
| `football/panini-contenders` | 30 | 0 | **30** |
| `football/topps-resurgence` | 1,742 | 1,737 | **5** |
| `basketball/panini-national-treasures` | 3 | 0 | **3** |
| `basketball/topps-cosmic-chrome` | 3 | 0 | **3** |
| `football/panini-select` | 188 | 186 | **2** |
| `football/topps-chrome` | 3,452 | 3,450 | **2** |
| `football/topps-finest` | 1,161 | 1,159 | **2** |
| `basketball/panini-flawless` | 1 | 0 | **1** |
| `basketball/panini-revolution` | 1 | 0 | **1** |
| `football/panini-immaculate` | 52 | 51 | **1** |
| `basketball/topps-finest` | 313 | 313 | 0 |
| `basketball/topps-inception` | 554 | 554 | 0 |
| `football/panini-impeccable` | 9 | 9 | 0 |
| `football/panini-phoenix` | 313 | 313 | 0 |

---

## The 28th product: the checklist was acquired, and the setKey swallowed it

`basketball/panini-haunted-hoops` (2,100 hobbymonitor rows) could not be ruled by #1925, which reported that
"no checklist source holds this product at 2024 or 2025, and no sibling setKey carries it either". Measured
read-only 2026-09-07, that is true of every key anyone would look under — and the checklist is nevertheless
**already in the container**. It is filed under another product's key.

Querying every basketball row whose own `setName` mentions "haunted":

```
panini-haunted-hoops  y2025  hobbymonitor-2026-09-04      = 2,100
nba-hoops             y2024  checklistinsider-2026-08-27  = 1,825
```

and inside `nba-hoops` / 2024, the setNames separate cleanly:

```
26,250  "2024 nba hoops"               <- the real NBA Hoops
 1,825  "2024 panini haunted hoops"    <- a DIFFERENT product, in the wrong pool
```

**The cause is a `normalizeSetKey` flagship swallow.** Run today:

```
normalizeSetKey("2024/25 Panini Haunted Hoops Basketball", "basketball")  ->  nba-hoops
normalizeSetKey("panini haunted hoops",                    "basketball")  ->  panini-haunted-hoops
```

The rule reads "Hoops", matches the `nba-hoops` product (which carries `names: ["panini-hoops", "hoops"]`),
and discards "Haunted" — the #1715 shape, where a bare flagship key swallows a specialization. Only the
year-stripped bare name resolves to the product's own key.

So this product needs **two** things, and they are separate work:

1. **A setKey repair**, not an acquisition: 1,825 checklist rows are already ingested and sitting in the
   NBA Hoops pool. That is a wrong-pool defect of the same family as #1919 and #1922, it is out of scope for
   a year repair, and it must be ruled before those rows can serve as a destination for anything.
2. **An acquisition** for the 2023-24 half, which is genuinely absent: no row anywhere in the container
   carries a "haunted" setName at 2023.

### The acquisition queue already holds the entry, in the format the queue uses

The queue is `backend/data/ingest-universe.json`, and checked against it 2026-09-07 the 2023-24 half is
**already queued and already correct**:

```json
{
  "id": "checklistinsider::https://www.checklistinsider.com/2023-24-panini-haunted-hoops-basketball",
  "lane": "checklistinsider",
  "sourceRef": "https://www.checklistinsider.com/2023-24-panini-haunted-hoops-basketball",
  "sport": "basketball",
  "year": 2023,
  "setName": "panini haunted hoops basketball",
  "estimatedCards": null,
  "seededStatus": "missing",
  "seededNote": "no catalog key for this (sport, year); lastmod=2026-06-26"
}
```

**So this PR adds no queue entry, and that is the correct outcome rather than an omission.** Adding a second
entry for the same `sourceRef` would collide on the queue's own id. And the file is not hand-editable in any
case: `build-ingest-universe-manifest.cjs` MINTS every field of it from the enumeration artifact
(`seededStatus: e.status`, `seededNote: e.note ?? null`), so a note written here by hand would be discarded
on the next rebuild and the edit would read as done while being gone. The finding belongs in this report,
which is where a human working the entry will look.

The 2024-25 entry is also already present and already `ingested` — correctly, because its 1,825 rows really
did land. Its problem is the KEY they landed on, and no queue entry can fix that.

**Until both are settled, none of the 2,100 hobbymonitor rows can be adjudicated**, and they are in no list
in this repair.

## What this document does not claim

It writes nothing, and neither does the PR that carries it. The lists are committed in REPORT-ONLY state:
they retire 90,968 catalog rows by hard delete, and **no apply is authorized without Drew's go**.
