# Catalog Integrity Program

**Goal:** one uniform catalog where every row is addressable by its own slug, and
15.7M sold comps each attached to the right card — or named as a gap worth filling.

All figures measured against production 2026-08-26. Nothing here is estimated
unless labelled. Update the numbers in place as phases complete.

---

## Where it stands

| | |
|---|---|
| `card_catalog` | **31.4M** (from 48.5M — 17.1M retired) |
| `sold_comps` carrying a slug | 15,673,468 (98.45%) |
| Sales landing on **evidence** | **39.42%** (was 37.83%) |
| Sales landing on derived rows | 31.55% (was 33.99%) |
| Sales orphaned | **22.07%** (was 21.79%) |
| Unknown source | 6.96% |

A naive "did it land on any row" check reports **78.21%**. Roughly half of that
is the catalog agreeing with rows the sales themselves seeded. Only the evidence
number is worth quoting.

---

## The programme

Ordered by **dependency**, not priority. Each phase is blocked by the one above
it. That ordering is the lesson of 2026-08-22 → 26, when repairs kept being
undone by a generator nobody had stopped.

### 01 — Stop the catalog re-breaking itself · COMPLETE

A nightly grade explosion wrote 19,043,573 rows in 16 hours — 11,441,770 into
vendor partitions, including 1,462,513 PSA 9.5 rows for a grade PSA does not
issue. It undid repairs roughly ten times faster than they could be applied.

Separately `getCatalogEntry` partitioned on **sport** and returned `null` for
every row in the container, so the live sales firehose had been told nothing
exists.

- [x] `Catalog Grade Explosion` workflow disabled
- [x] explode rewritten to the contract (#1278)
- [x] `getCatalogEntry` fixed and deployed (#1277)
- [x] write-contract guard merged (#1279)

**Verified:** lookup proved against live rows — old path `null`, new path found.

### 02 — Retire the rows nothing references · COMPLETE

16,273,427 graded rows sit under a vendor partition key — a third of the
container. No matcher lookup builds a graded slug, pricing derives grades as
`raw anchor × multiplier`, and of 15.7M slugged sales only ~1,284 reference a
graded slug. Those 1,284 are loaded at startup and skipped.

- [x] bounded 50k pass verified
- [x] sharded by gradeTier, not setKey (#1286)
- [x] tier discovery retries; slots staggered (#1287)
- [x] 2,000-row pages — the job is scan-bound, not RU-bound (#1288)
- [x] exits at a 140-min budget so the relaunch survives the ceiling (#1289)
- [x] full retire (11 slots) — **16,273,427 → 1,018**

**Verified:** every one of the 1,018 survivors is referenced by a sale, and
the guard protects exactly those. Unprotected leftovers: **0**. The residual
is the protection working, not a stall.

**Throughput, measured this evening.** setKey ranges put 89% of the work on
one of four slots and could not reach 66,711 rows with no setKey at all:

| fleet | rows/min |
|---|---:|
| 4 slots, setKey | ~1 slot's worth |
| 4 slots, gradeTier | 18,675 |
| 8 slots, 2,000-row pages | 27,522 |
| 11 slots | **50,429** |

**Verified:** bounded pass — total dropped 50,046, target dropped 50,049. Equal
deltas prove only target rows were removed.

### 03 — Retire the grades that cannot exist · COMPLETE

1,462,513 rows assert PSA 9.5. PSA's scale runs 8, 8.5, 9, 10 — the jump is the
reason a PSA 10 carries its premium.

- [x] merge #1270
- [x] dispatch `retire-impossible-grade-rows`

**Verified:** 1,462,513 → **0**. Every PSA 9.5 row is gone, and the guard
re-counted referencing sales as zero on every run before deleting.

**Guard:** re-counts referencing sales on every run and refuses if non-zero
(`:psa-9-5 → 0 sales`). The predicate can only condemn a scale the ladder
asserts, so an unknown grader is skipped, never deleted.

### 04 — Re-measure landing · COMPLETE

The single number that says whether any of this worked. Every slug decision made
during ingest until 2026-08-26 was taken while the catalog lookup returned
`null` — so the current 37.83% was produced half-blind.

This tells us how much of the 21.79% orphan slice was the broken lookup versus
genuine missing checklists, and that decides phase 05 vs 06.

- [x] run `audit-sales-landing-by-authority.cjs`

| | baseline | now | Δ |
|---|---:|---:|---:|
| **evidence** | 37.83% | **39.42%** | +1.6 |
| derived | 33.99% | 31.55% | −2.4 |
| orphan | 21.79% | 22.07% | +0.3 |

n=2,501 distinct slugs, so ±1–2 points is sampling noise.

**The cleanup barely moved matching, and that is the expected result.** The
17.1M rows retired were unreachable graded rows that no lookup ever built a
slug for, so removing them could not improve landing. Phase 02's value is
that the catalog stopped re-breaking itself and now has one addressing
scheme at a third of the size — not a better match rate.

**This decides 05 vs 06:** orphan did not fall, so the 22% is not mostly our
malformed slugs being fixed by a working lookup. Re-slug first (05), then
split what remains into repair vs acquisition (06).

**Baseline to beat:** 37.83% evidence · 21.79% orphan.

### 05 — Re-derive sale slugs against the clean catalog · BLOCKED BY 04

Nothing in `sold_comps` gets deleted — it is 8 years of observed transactions and
is not reproducible. The work is re-derivation: recompute each sale's slug now
that the catalog is addressable and the lookup answers.

Sales slug to the **base card** and keep the grade in `gradeCompany` /
`gradeValue`, so retiring graded rows cannot orphan one.

- [ ] re-slug pass
- [ ] 295 sales claiming PSA 9.5
- [ ] 564 slugs containing `:null:`
- [ ] 243,230 rows with no slug at all

### 06 — Split the orphans, then acquire · BLOCKED BY 05

An orphan is either our malformed slug (a repair) or a checklist we genuinely do
not hold (an acquisition). `audit-orphan-causes.cjs` already separates them.
Only then is fetching worthwhile — past evidence is that most "missing"
checklists were already held under a different key.

Source health, tested 2026-08-25:

| source | status | covers |
|---|---|---|
| cardboardconnection | **dead (HTTP 000)** | was the broad first stop |
| hobbymonitor | live | modern only — "will never hold 1995 Fleer" |
| beckett | live | XLSX; the only surviving vintage path |
| checklistcentral.cards | live, not wired | supplied 2026-08-25 |
| keymancollectibles.com | live, not wired | supplied 2026-08-25 |
| tcdb.com | HTTP 403 on direct GET | use `scrape-tcdb.cjs` |

Any new fetcher emits the canonical CSV format — that is a rule, not a
preference. See `feedback_every_ingest_uses_the_one_checklist_format`.

### 07 — Pay down the writer debt · OPEN (59 of 61)

Two of 61 catalog writers build rows through `deriveCatalogEntry`. The other 59
hand-roll their own shape, which is where every defect in this programme
originated. The guard stops writer #62 adding a fourth addressing scheme; it does
not convert the 59. **Until they are converted, this programme can recur.**

- [ ] convert writers, shrinking `BYPASSING` in `oneWayToBuildACatalogRow.test.ts`

---

## What the shape report says — 2026-08-26 night

Run it rather than re-deriving any of this:

```
COSMOS_CONNECTION_STRING=... node backend/scripts/audit-catalog-shape.cjs
```

### The catalog is not "in one place" yet

```
at its own address    26,277,904   83.2%
wrong partition key    2,779,314    8.8%
NO partition key       2,528,735    8.0%
UNREACHABLE            5,308,049   16.8%
```

**Two sweeps ran to completion over this population while blind to it.** Phase
02's retire required `IS_DEFINED(c.gradeTier)`, so of 2,835,432 mis-partitioned
rows it saw exactly **1,018**. `rehome-catalog-rows-to-own-partition` requires
`STARTSWITH(c.id,'hiq:')`, and these ids are vendor-shaped
(`cardhedge::1775832219776x807179689237410600::2be9b853`), so it saw none.
Both reported success. `canonicalize-vendor-shaped-rows` (#1297) is the pass
that actually reaches them.

### "Duplicate" is still a conclusion, not an observation

```
identity rows          19,758,271
distinct slugs         19,703,623
TRUE duplicates            54,648   0.3%
sitting at a vendor id  2,455,003
```

Baseball reads as ~2.4M duplicate rows. **Only 54,648 have a canonical twin.**
The other ~2.4M are the ONLY record of that card, sitting at a vendor id — a
dedup keyed on `hobbyiqCardId` deletes them and destroys 2.4M real cards. Same
shape as the 3.1x grade-ladder bloat. Re-home, never delete.

*Also retired: an earlier "79% are redundant" figure. It came from `SELECT TOP`
in index order, which is not a sample. Measured properly it is ~3%.*

### The gap is COVERAGE, not matching

```
sport         catalog   share |     sales   share | sales per row
baseball   29,523,607   93.5% | 7,745,367   48.6% |  0.26
pokemon       230,490    0.7% | 3,015,971   18.9% | 13.09
football    1,048,397    3.3% | 2,465,949   15.5% |  2.35
basketball    403,874    1.3% | 2,126,568   13.4% |  5.27
```

We do not have 31M cards. We have **29.5M baseball rows** — 28% of them grade
variants — and almost nothing for the half of the market that is Pokemon,
football and basketball. **No amount of re-slugging fixes a coverage hole.**

### Baseball's own gap is MODERN, not vintage

Full set difference, every card, not sampled:

```
2025  orphanSales= 197,018  of 1,221,513  (16%)
2026  orphanSales= 110,786  of   839,112  (13%)
2024  orphanSales= 109,261  of   834,897  (13%)
2023  orphanSales=  70,074  of   464,849  (15%)

top sets: 2023 bowman-chrome (7,954) · 2026 bowman (7,885)
          2026 topps-finest (7,791) · 2026 bowman-chrome-mega-box (7,137)
```

This matters because it says which source to reach for. Vintage acquisition
does not move this number.

### Checklist sources, tested 2026-08-26

| source | state | covers |
|---|---|---|
| cardboardconnection | **dead** | was the broad first stop |
| hobbymonitor | live | modern only |
| checklistinsider | live, **wired + converter** | modern; 603 products, 2,394,639 rows |
| checklistcentral | live, **not worth wiring** | 2024-25 only, several "Coming Soon" |
| keymancollectibles | live, **wired** (#1298) | 1921-2029, but yields 14 of 397 pages |
| beckett | live | XLSX, the only other vintage path |

`keymancollectibles` was over-estimated: it indexes 397 vintage sets but the
site uses a different layout per era and the parser reads one of them. It is
also aimed at vintage, which the measurement above says is not where baseball's
orphans are.

**Still open: 2023.** checklistinsider has only 8 products for 2023, so the
single largest set gap (`2023 bowman-chrome`) has no source yet.

### The canonical type could not express a real row

`CardCatalogEntry.source` was a five-value union admitting **45 rows out of
31,444,200** — 100.0% of the catalog carried a source the type forbade. It also
omitted `searchTokens` (99.0%), `setName` (98.9%) and `displayName` (89.6%).

A writer routing through `upsertCatalogEntry` had to lie about provenance AND
would silently drop the fields search discriminates on. **That is why 59 of 61
writers bypass it — self-preservation, not laziness.** Widened in #1296;
`ensureCatalogRow` converted; BYPASSING 59 -> 58.

---

## Decisions outstanding

Each changes what gets built. Recommendations given; none should be Claude's call.

**1. Do grade rows come back at all?**
A full explode is 18,172,721 eligible identities × 11 tiers = **199,899,931
rows**. Pricing does not read them; the matcher does not look them up. The
current 25.8M was only 13% of a completed run.
→ *Recommend: do not regenerate. Price grades from base × calibration multiplier,
as `canonicalFmv` already does.*

**2. What happens to the 3.4M derived rows?**
Rows the catalog built from sales (`ingest-auto-seed`, `sold-comps-stub`,
`sales-attested`). They make a sale match a row it created itself — but for some
cards they are the only row that exists.
→ *Recommend: keep, exclude from the match numerator. Deleting trades a
measurement problem for a coverage hole.*

**3. Is `attest-unnumbered-by-player` a sanctioned exception?**
Creates catalog rows from corroborated sales (N independent sales must agree).
Still sales→catalog, but the least bad version.
→ *Recommend: keep, tagged derived, never allowed to outvote a checklist.*
→ *Retired 2026-08-29 (D5 PR 5): the script is deleted — sales never mint a
catalog row (#1353). Its existing `sales-attested` rows fall under item 2.*

**4. When does RU come back down?**
`card_catalog` at 400,000 (floor ~40,000 RU/s) for the retire; peak observed
usage was ~10,855 RU/s. `sold_comps` at 100,000; backlog says 8,000.
→ *Recommend: card_catalog → 40,000 once phase 02 completes. Review sold_comps
separately.*

---

## Definition of done

| Surface | Condition | Now |
|---|---|---|
| card_catalog | every row `id === cardId === slug` | **done** (1,018 protected) |
| card_catalog | no grade a company does not issue | **done** |
| card_catalog | one format — setName, parallel, displayName, searchTokens | **done** |
| checklists | one CSV convention, parallel column authoritative | **25 / 25** |
| sold_comps | every slug resolves, or the gap is named | 22.07% orphan |
| sold_comps | landing measured against evidence, not derived rows | 39.42% |
| writers | all catalog writes through the canonical builder | 2 / 61 |

---

## The contract

`id === cardId === the hiq slug.` Every row is its own single-document
partition, which is what makes the ~1 RU point read work. `deriveCatalogEntry`
builds it; `upsertCatalogEntry` writes it.

Before 2026-08-26 three live paths each believed something different:

```
catalogMatcher.service.ts   item(slug, slug)          canonical
explodeCatalogGrades.cjs    cardId = parent.cardId    co-located ladder
cardCatalog.service.ts      item(slug, SPORT)         stale; null for every row
```

Every repair was correct under one belief and wrong under another. That — not
any single bug — is what cost four days.

---

## Shipped toward this

Merged 2026-08-25 → 26. Each is a property now defended by a test, not a fix
that can quietly regress.

| PR | |
|---|---|
| #1256 | A job that dropped half its writes turns red instead of green |
| #1257 | A checklist variation is a rung on a card, not a new card |
| #1262 | One checklist format — 5,207 rewrites, every one slug-identical |
| #1259 #1263 | One Piece is not a Bowman card — ingest fixed, 2,433 rows repaired |
| #1260 | Dedupe counters that did not add up; a keyless row is not stuck |
| #1271 #1272 #1273 #1274 #1275 #1276 | Re-home: scan retry, year splitting, self-relaunch, termination |
| #1277 | `getCatalogEntry` returned null for every row in a 48M container |
| #1278 | The grade explode writes to the contract, with full checklist fields |
| #1279 | The write contract is guarded — debt may shrink, never grow |
| #1280 #1281 #1282 | Retire unreferenced graded rows, self-relaunching, split across slots |
| #1285 | The retire relaunch forgot which slot it was, and re-dispatched as slot 0 of 16 |
| #1286 | Shard by grade tier — setKey put 89% on one worker and could not reach 66,711 rows |
| #1287 | The one query left unretried took a 429 and exited 3 |
| #1288 | Bigger pages: the job is scan-bound, not RU-bound (2,500 RU/s of 400,000) |
| #1289 | Stop on our own clock, or the whole fleet dies silently at the 150-min ceiling |

---

## The parallel field is not uniform — measured 2026-08-27

Found chasing a live report: a Marconi German BCP-100 Gold showing BASE comps.
Three separate defects, all in `parallel`, all breaking the match.

### 1. The subset is folded into the parallel name

```
catalog:  parallel="Chrome Prospects Lava Refractor"  subsetName="Base"
sale:     parallel="Lava Refractor"
```

A sale computes `...:lava-refractor:...`; the catalog only holds
`...:chrome-prospects-lava-refractor:...`. No row exists at the sale's slug, so
pricing falls back to base comps — the reported symptom.

**Safe to collapse**, because the stripped form already dominates:

```
"Chrome Prospects Blue Refractor"    410   vs  "Blue Refractor"  103,561
"Chrome Prospects Gold Refractor"    443   vs  "Gold Refractor"  118,877
```

The folded form is a splinter, so collapsing REUNITES one card's pool. This is
the opposite of the BCP case below, where merging would destroy distinct cards.
The difference: here the two names denote the same card.

Scope: `Chrome Prospects ` 30,422 · `Chrome Prospect ` 637 · `Paper Prospects `
4,170 · `Prospects ` 3,762. Sources: checklistcenter 12,397, baseballcardpedia
8,220, plus their `-graded` twins.

### 2. The print run is glued into the parallel name

```
Chrome Prospects Sunflower Seed Refractor: Ten Copie
Chrome Prospects X Fractor: 725 Copie
Chrome Prospects Reptillian Refractor: 8125 Copie
```

A parser swallowed "Ten Copies" / "725 Copies" into the name and truncated the
plural. Every one is a unique parallel no sale can match, and it ate the one
field a sale title cannot yield. Strip the suffix AND recover `printRun` from it.

### 3. `Base ` is a DIFFERENT problem — do not strip it

```
Base Cards       12,493
Base Autograph   10,969
Base Refractor    3,064
Base Sapphire       608
```

`Base Cards` and `Base Autograph` are not parallels at all; they are category
names sitting in the parallel field. `Base Refractor` and `Base Sapphire` may be
legitimate. The same prefix rule would corrupt 47,332 rows. Needs its own
analysis before anything is written.

---

## BCP- is not only Bowman Chrome — 2026-08-27

`CHROME_PREFIX_OVERRIDES` rests on "BCP- only ever = Bowman Chrome". The
checklists say otherwise, and the numbering RUNS ON from flagship into Chrome:

```
year   bowman      bowman-chrome   overlap
2021   BCP-1..150  BCP-151..250    0
2023   BCP-1..150  BCP-151..253    0
2024   BCP-1..152  BCP-153..254    0
2026   BCP-1..150  BCP-151..252    0
```

Zero overlap every year, but the boundary MOVES (150 / 152). The blanket
override sends **64,059 sales** to the wrong product — 30,016 of them say
"2026 Bowman Baseball" in their own setName, and 1,446 are basketball.

**Do not fix this with another rule.** A boundary table was written and
discarded: it is the same shape as the rule that caused the bug, and it will
drift the same way. `resolveSetKeyFromCatalog` already exists, is
index-friendly, respects authority — and NOTHING CALLS IT. Given the vendor's
set text it answers correctly:

```
BCP-100 + "2026 Bowman Baseball"  ->  bowman  (narrowed-by-text)
```

Without that text it returns `ambiguous`, because BCP-100 legitimately exists in
six products. Critically, every `bowman-chrome` candidate for it is DERIVED
(`ingest-auto-seed`, `sold-comps-stub`) — rows the mis-slugged sales created
themselves. The loop manufactured its own ambiguity. Filtering candidates to
checklist authority is what makes the resolver decisive.

**Next:** wire `resolveSetKeyFromCatalog` into the sale-slugging path, passing
the vendor set text, and have it ignore derived rows when adjudicating.
