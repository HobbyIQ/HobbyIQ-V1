# What is missing in the checklist so we can match comps?

**Drew's question, 2026-09-03.** Answered from the Great Rematch census (all 32
shards) joined against a read-only census of `card_catalog` and `sold_comps`.

> **The headline: half the gap is not a missing checklist.**
> Of **6,386,510** pool rows that today have no checklist-backed destination,
> **2,621,638 (41%) already have their checklist in `card_catalog`** — filed
> under a key the deriver no longer produces. Add the 633,992 rows whose title
> the parser cannot name at all, and **3,255,630 (51%) of the gap is vocabulary
> work with zero acquisition**. Only **3,233,254 (51%)** need a checklist we do
> not hold. (The two shares sum past 100% by 102,374 rows — Pokemon cells that
> fall in both a wrong-key and a Pokemon class.)

---

## 1. How this was measured

- **Census evidence.** All 32 `rematch-census-slot-<slot>-<runId>` artifacts,
  16,513,790 rows classified, no slot stopped at budget. The two headline
  reasons reproduce exactly: `UNDERIVABLE setkey-unknown-unsupported` =
  **4,202,405** and `CONFLICT not-checklist-backed` = **462,519**.
- **Catalog state.** `card_catalog` aggregated by `(sport, cardYear, setKey,
  source)` — 16,528,062 rows in 12,507 cells, classified with the repo's own
  `catalogAuthorityOf()` (checklist 13,616,332 / derived 2,491,740 / unknown
  305,847 / vendor 114,143).
- **Pool demand.** `sold_comps` aggregated by `(sport, cardYear, setName)` —
  29,563 cells, 16,429,642 rows, each `setName` pushed through the live
  `normalizeSetKey()` so pool demand is expressed in the deriver's own
  vocabulary.
- **Wrong-key check first.** Per the standing rule that *a "missing" checklist is
  usually a wrong key*, every candidate cell was tested for sibling keys and for
  a non-fixed-point key before being called absent.

Both gates were read in source, and they mean different things:

| Reason | Gate | What it actually says |
|---|---|---|
| `setkey-unknown-unsupported` (4.20M) | `slugRederivation.service.ts:183` | `inferSetKeyFromTitle()` could not **name the product**. A *parser/vocabulary* failure — the row never reaches a checklist lookup. |
| `not-checklist-backed` (462k) | `rematch-classify.cjs:836` | The row is IMPROVE-shaped on every axis; the destination slug exists but **no checklist-backed catalog row confirms it**. |

---

## 2. The gap, decomposed

| # | Class | Pool rows | Needs acquisition? |
|---|---|---:|---|
| A | **Pokemon set-code vocabulary** — checklist exists under `sv8-surging-sparks`, pool asks for `pokemon-scarlet-violet-surging-sparks` | **2,028,018** | No — alias table |
| B | **Sports stale-key aliases** — checklist exists under a key `normalizeSetKey` no longer emits | **593,620** | No — alias table |
| C | **Pokemon `unknown` setKey** — parser cannot name the set from the title at all | 633,992 | No — parser vocabulary |
| D | **Pokemon Japanese sets** — genuinely absent | 508,440 | **Yes** (`tcgdexja`) |
| E | **Sports checklist gap** — genuinely absent, 10,976 cells | **2,724,814** | **Yes** |

### 2,646 catalog setKeys are not `normalizeSetKey` fixed points

**2,488,691 checklist rows** sit under keys the deriver can never ask for. A
ruled key MUST be a `normalizeSetKey` fixed point; these are not. Worked
examples:

```
normalizeSetKey("Donruss")         -> panini-donruss           but 1981-1998 Donruss checklists live under `donruss`
normalizeSetKey("Finest")          -> topps-finest             but 25 years of Finest live under `finest`
normalizeSetKey("Bowman Sapphire") -> bowman-chrome-sapphire   but checklists live under `bowman-sapphire`
```

`baseball|1987|donruss` holds **1,450 checklist rows** (cardboardconnection).
`baseball|1987|panini-donruss` — where the deriver looks — holds **0 checklist
rows and 5 vendor rows**. Panini did not own Donruss until 2009, so collapsing
pre-2009 Donruss into `panini-donruss` is a category error, not an alias.

### The missing axis is print run, not the base row

Among the IMPROVE-shaped rows the checklist gate blocks, the axis being filled is
overwhelmingly **printRun (1,105,233)**, then **parallel (165,146)** — setKey
(33,926) and cardNumber (12,616) are minor. This matches the universe manifest:
of its 2,264 `partial` entries, **2,029 are "NO parallel ladder (base-only)"**.

> **A base-only checklist does not unblock these comps.** The acquisition target
> is the **parallel ladder with print runs**, per set-year.

---

## 3. Top 15 — "get this checklist -> N comps become matchable"

Ranked by pool rows unblocked per checklist acquired. Rows 1, 2 and 4 are
vocabulary work with no acquisition at all, and they rank first because they are
the cheapest rows on the board.

| # | Sport | Years | setKey | Rows unblocked | Distinct cards | Catalog state | Missing axis | Source | Lane | Queued |
|---:|---|---|---|---:|---:|---|---|---|---|---|
| 1 | pokemon | 1997-2026 | *(569 cells; e.g. `pokemon-scarlet-violet-surging-sparks`)* | **2,028,018** | ~180k | **present under set code** (`sv8-surging-sparks`, `me2pt5-ascended-heroes`) | setKey alias | none — alias table | vocab ruling | n/a |
| 2 | multi | 1981-2026 | *(200 cells; `finest`, `donruss`, `nba-hoops`, `bowman-sapphire`)* | **593,620** | ~46k | **present under stale key** | setKey alias | none — alias table | vocab ruling | n/a |
| 3 | pokemon | 2010-2026 | *(35 cells, `unknown`)* | **633,992** | n/a | n/a — title unreadable | **parser vocabulary** | none — `inferSetKeyFromTitle` | code fix | n/a |
| 4 | football | 1948-1989 | `topps` | **289,203** | 582 | absent (derived/vendor only) | base + parallel ladder | Beckett / hobbymonitor | ingest-checklists-end-to-end | yes — `hobbymonitor:missing` |
| 5 | pokemon-JA | 2021-2025 | *(210 cells; `terastal-festival-ex`, `vstar-universe`, `vmax-climax`)* | **294,208** | — | absent | base + rarity ladder | tcgdex-ja | universe driver (`tcgdexja`) | **NOT QUEUED** — manifest holds only vintage PMCG titles |
| 6 | basketball | 1991-2009 | `upper-deck` | **108,054** | 2,544 | absent | base + parallel ladder | Beckett / hobbymonitor | ingest-checklists-end-to-end | yes — `hobbymonitor:missing` |
| 7 | basketball | 1948-1988 | `topps` | **89,120** | 397 | absent | base + parallel ladder | Beckett / hobbymonitor | ingest-checklists-end-to-end | yes — `hobbymonitor:missing` |
| 8 | basketball | 1990-2009 | `fleer` | **73,790** | 911 | absent | base + parallel ladder | Beckett | ingest-checklists-end-to-end | **NOT QUEUED** |
| 9 | basketball | 1991-2009 | `topps` | **71,319** | 1,614 | absent | base + parallel ladder | Beckett / hobbymonitor | ingest-checklists-end-to-end | yes — `hobbymonitor:missing` |
| 10 | basketball | 2012-2026 | `panini-prizm` | **64,915** | — | absent (480 vendor rows) | **parallel ladder + print runs** | hobbymonitor / checklistinsider | universe driver | yes — `missing` |
| 11 | football | 2010-2026 | `panini-donruss` | **47,583** | — | partial | **print runs** | hobbymonitor / clc | universe driver | yes — `partial,missing` |
| 12 | basketball | 2011-2026 | `panini-select` | **46,402** | — | absent (624 vendor rows) | **parallel ladder + print runs** | hobbymonitor / clc | universe driver | yes — `missing` |
| 13 | basketball | 2012-2026 | `donruss-optic` | **41,935** | — | absent | **parallel ladder + print runs** | hobbymonitor / clc | universe driver | yes — `missing,ingested` |
| 14 | hockey | 1933-1989 | `o-pee-chee` | **41,475** | 406 | absent | base + parallel ladder | Beckett | ingest-checklists-end-to-end | **NOT QUEUED** |
| 15 | basketball | 1991-2008 | `skybox` | **36,812** | 730 | absent | base + parallel ladder | Beckett | ingest-checklists-end-to-end | **NOT QUEUED** |

**Also large, same shape as 4/6/7/9:** `football/panini-score` 2010-2025 (36,723,
queued), `football/donruss-optic` 2012-2026 (35,493, queued), `hockey/upper-deck`
2010-2021 (35,161, queued), `hockey/topps` pre-1990 (33,514, **NOT QUEUED**),
`basketball/panini-hoops` 1990-2005 (31,439, **NOT QUEUED**),
`basketball/topps-stadium-club` 1991-2007 (30,675, **NOT QUEUED**).

---

## 4. Wrong-key cells — do NOT acquire these

Verified against sibling keys before being called missing. 200 cells,
**593,620 pool rows**, every one already checklist-backed under another key.

| Pool asks for | Checklist actually lives under | Rows | Verdict |
|---|---|---:|---|
| `baseball 1981-1998 panini-donruss` | `donruss` (1,057-2,630/yr, baseballcardpedia + beckett) | 127,022 | **Collapse bug** — Panini did not own Donruss pre-2009 |
| `hockey 2022-2024 upper-deck` | `upper-deck-series-1` / `-series-2` / `-artifacts` | 57,216 | Flagship splits into named series; needs a resolver ruling |
| `basketball 2023-2024 panini-hoops` | `nba-hoops`, `nba-hoops-premium-stock` | 41,592 | True alias |
| `football 2020-2021 donruss-optic` | `panini-optic` | 33,376 | True alias |
| `baseball 1993-1999 topps-finest` | `finest` | 27,460 | True alias |
| `football 2025 panini-rookies-and-stars` | `panini-rookies-stars` | 22,388 | True alias (hyphenation) |
| `baseball/basketball 2025-2026 bowman-chrome-sapphire` | `bowman-sapphire` | 13,280 | True alias |
| `pokemon 2023 panini-obsidian`, `panini-zenith`, `panini-origins` | — | 90,462 | **Mis-sported rows** — Panini basketball products tagged `sport=pokemon` |

Beware the reverse direction too: `normalizeSetKey` collapses **2,445 keys**
that name distinct products (`topps-triple-threads` -> `topps`,
`bowman-university-chrome` -> `bowman`, `panini-prizm-premier-league` ->
`panini-prizm`), stranding **2,064,568 checklist rows**. Fixing the alias table
without ruling on these would merge distinct pools.

---

## 5. Recommended order

1. **Ship the Pokemon set-code alias table** (2.03M rows, no acquisition). Each
   alias target must be a `normalizeSetKey` fixed point.
2. **Ship the sports stale-key alias table** (594k rows, no acquisition), with a
   ruling on pre-2009 `donruss` and on the `upper-deck` series split.
3. **Queue the vintage batch**: football `topps` 1948-1989, basketball `topps`
   pre-1988 plus `upper-deck`/`fleer`/`topps` 1990s, hockey `o-pee-chee`/`topps`
   pre-1990. ~600k rows. Beckett is the only vintage source; six of these
   clusters are **not in `ingest-universe.json` at all**.
4. **Re-run the 2,029 base-only partials for their parallel ladders** — this is
   what the 1.1M `filled:printRun` blocks are actually waiting on.
5. **Add modern Japanese Pokemon to the `tcgdexja` lane** (294k rows); the
   manifest currently holds only vintage PMCG titles.

---

## 6. Caveats

- Class E (2.72M) is a **ceiling, not a promise**: a checklist unblocks a comp
  only if the comp's cardNumber and parallel appear on it. The distinct-shape
  counts above bound the work; matched yield will be lower.
- Classes A/B/C are re-derivation, not acquisition — they land through the
  GREAT REMATCH apply path under its existing canary gate, and ruled/user rows
  stay report-only.
- The pool-side total (6,386,510) is a superset of the census's
  4,202,405 + 462,519 = 4,664,924: it counts every pool row whose
  `(sport, year, setKey)` cell lacks a checklist-backed catalog row, including
  rows the census classified AGREE because their stored slug already matched.
- All figures are read-only measurements taken 2026-09-03 against prod
  `hobbyiq-comps`. No writes, no dispatches.
