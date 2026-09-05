# Alias reslug — the 2026-09-05 sales-side spellings

**Date:** 2026-09-05 · **Mode of every measurement below:** READ-ONLY against prod
(`card_catalog`, `sold_comps`) · **Writes performed:** none

Drew's 2026-09-05 ruling asked for the 172 "safe rekey" pairs from the checklist-gap census
(`docs/reports/checklist-gaps-2026-09-05.md`) to be declared as `RULED_ALIASES`, with the 31
contested `bowman-*`↔`topps-*` pairs kept DISTINCT.

**The Bowman/Topps half of the ruling is implemented exactly as stated: all 31 stay distinct, and a
test now refuses them.** The other half did not survive verification, and this runbook records why,
because the refusals are the larger and more useful half of the finding.

## Headline: 172 candidates, 4 aliases

| Bucket | Pairs | Rows | What it is |
|---|---:|---:|---|
| **RULE** (declared) | **4** | **20,457** | Alias key has ZERO strict checklist rows; destination is checklist-backed. |
| ALREADY RESOLVED | 11 | 306,807 | The deriver *already* lands both spellings on one key. No vocabulary edit exists to make. |
| SPLIT | 58 | 30,067 | The alias key has strict checklist rows **of its own** — a different product or a split. |
| CROSS-MANUFACTURER | 6 | 776 | Two makers sharing a product word. Never one product. |
| RULING CONFLICT | 4 | 86 | Both keys already declared fixed points, or a standing test pins the alias key as its own. |
| CONTESTED (Bowman/Topps) | 31 | 12,109 | Refused, per the ruling. |

The census's 172/358,230 figure counted 306,807 rows that need **no vocabulary change at all**.

### Why the census over-counted

`rekey.cjs` compared the **stored** `setKey` segment of a slug against the strict-covered keys in the
same sport+year. It never ran either side through `normalizeSetKey`. So a pair whose two spellings
the deriver *already* folds together looks exactly like an undeclared split.

The headline example is the report's own #1. `panini-optic` (201,862 rows, presented as the single
biggest rekey) **is already an alias of `donruss-optic`** in the live table:

```
normalizeSetKey("panini-optic")  ->  donruss-optic     (already)
normalizeSetKey("finest")        ->  topps-finest      (already — and note the census
                                                        proposed the OPPOSITE direction)
normalizeSetKey("stadium-club")  ->  topps-stadium-club (already)
```

`panini-donruss`↔`donruss` (61,541 rows across both directions) is not an alias in either direction:
it is an **era split**, already encoded in `ERA_SPLIT_TABLE` and resolved by `spellForEra` at the
call sites that know the year (`spellForEra("panini-donruss", 1987) === "donruss"`). Declaring a flat
alias would break whichever era it did not name.

The census also proposed several pairs that contradict themselves — five aliases pointing at two
targets each (`chrome` → both `topps-chrome` and `bowman-chrome`), and three **cycles**
(`donruss-optic`↔`panini-optic`, `donruss`↔`panini-donruss`, `panini-select`↔`select`). Declaring the
list verbatim would have broken the no-cycles invariant.

## The 4 ruled aliases

Verified against prod `card_catalog` **by source** (the standing rule: checklist-backed rows decide
the canonical key, never row count).

| Alias | → Ruled key | Sport / years | Pool rows | Evidence |
|---|---|---|---:|---|
| `panini-hoops` | `nba-hoops` | basketball 2024 | 20,203 | dest 26,355 rows **all checklistinsider**; alias 2,680 rows, **0 strict** (auto-seed + sales-attested) |
| `chrome` | `topps-chrome` | baseball/basketball 2008–2025 | 143 | alias holds **8 rows total**, 0 strict (ebay/user); dest 159,897 strict |
| `panini-leather-lumber` | `leather-lumber` | baseball 2019 | 98 | alias holds **ZERO catalog rows of any kind**; dest 5,931 baseballcardpedia |
| `ud` | `upper-deck` | baseball 1992–2002 | 13 | an abbreviation, not a product; 0 strict rows |

`nba-hoops` is the one that mattered. **This file's own header had already ruled it** — "`nba-hoops`
holds 26,355 checklistinsider rows and `panini-hoops` holds ZERO, so `nba-hoops` is the key" — but
the alias was never *declared*, so the vocabulary went on deriving the prefixed spelling. The split
was provable end to end:

```
before:  normalizeSetKey("2024 Panini NBA Hoops Basketball") -> panini-hoops
         normalizeSetKey("2024 NBA Hoops")                   -> nba-hoops
after:   both -> nba-hoops
```

One product in two pools, decided by whether the seller typed the maker. That is
`CF-ONE-CARD-ONE-ROW-ONE-POOL` stated as damage, and it is why
`hobbyIqCardId.service.ts` now emits the ruled key directly rather than relying on the alias to clean
up after the vocabulary.

## The refusals worth naming

**SPLIT — the alias key is checklist-backed itself** (top 5 of 58):

| Pair | Rows | Why it is NOT an alias |
|---|---:|---|
| `donruss-studio` → `studio` | 11,296 | alias carries `bccp-product-structure` rows |
| `panini-score` → `score` | 7,455 | **3,300 `hobbymonitor` rows on the alias** — hobbymonitor is a strict source |
| `panini-diamond-kings` → `diamond-kings` | 4,988 | 13,355 checklistcenter + 1,074 beckett on the alias |
| `score-select` → `select` | 3,707 | unverified by source; not ruled |
| `panini-select` → `select` | 1,976 | **alias holds 367,220 rows** vs dest 45,850 — the census had the direction backwards |

**RULING CONFLICT** — `topps-triple-threads` → `triple-threads` (21 rows) would fold a pair where
*both* keys are declared fixed points (81,967 and 23,053 checklist rows), directly contradicting the
2026-09-03 distinct rulings. Same for `donruss-elite` → `panini-elite`.

`upper-deck-choice` → `ud-choice` (22 rows) was **declared and then WITHDRAWN**. The source count
favoured it (dest 1,702 baseballcardpedia rows; alias 108 rows, 0 strict), but
`exquisiteIsItsOwnProduct.test.ts:87` pins `normalizeSetKey("upper-deck-choice") === "upper-deck-choice"`
as part of the CF-UD-INSERT-LINES ruling. A standing ruling outranks a source count, so the alias came
back out rather than the pin being edited — and the pair is now pinned in the REFUSED list instead.
This is the rule working: the tests caught a ruling conflict the census could not see.

**CROSS-MANUFACTURER** — `panini` → `upper-deck` (656 rows), `fleer-stickers` → `topps-stickers`,
`ud-series-1` → `topps-series-1`. The census's `maker-words-differ` heuristic matched on shared
generic words ("series-1", "stickers"); a shared product word across two makers is not one product.

**CONTESTED (31 pairs, 12,109 rows)** — kept DISTINCT per the ruling. Largest:
`bowman-chrome-sapphire` → `topps-chrome-sapphire` (6,194) and `bowman-chrome` → `topps-chrome`
(5,788). Note the census's own Bowman/Topps filter **missed four** bare-key folds that are the same
merge in disguise — `draft` → `bowman-draft`, `chrome` → `bowman-chrome`, `sapphire` →
`bowman-sapphire`, `1st-edition` → `bowman-1st-edition`. All are refused, and pinned by a test.

## Dispatch plan

### The lane cannot reach the ruled keys yet — and that is the finding

`reslug-ruled-alias.cjs` sweeps by **ruled destination**, reading `ruledAliases()`. Run in REPORT
mode against prod for the census's largest key it **refuses at the scope gate**:

```
$ SCOPE=donruss-optic SPORTS=football YEARS=2024 node scripts/reslug-ruled-alias.cjs
FATAL: "donruss-optic" is not a ruled alias destination -- no declared alias resolves to it.
  Ruled destinations (9): bellingham-mariners, bowman-chrome-mega-box, bowman-chrome-nscc,
  bowman-chrome-sapphire, topps-allen-ginter-chrome, topps-chrome-sapphire, ultra,
  upper-deck-black-diamond, upper-deck-exquisite
```

This is correct behaviour, and it exposes a real gap. `panini-optic` → `donruss-optic` is a
**mechanically derived** alias (from the census data file's `verdict: "alias"`), not a *ruled* one.
So those 220,362 stored rows are unreachable by both halves of the machinery:

- the **Great Rematch census** classifies them `AGREE` (stored slug and re-derived identity both
  reduce to `donruss-optic` once the alias applies) — and AGREE is never written;
- the **reslug lane** refuses the scope, because no *ruled* alias resolves to it.

That is the split-pool the lane was built for, sitting in the one blind spot between the two tools.
**It needs Drew's decision** (see Open questions) — it is not something to fix by quietly widening
the lane's scope gate, which exists precisely so a whole-scope write names its ruling.

### Dispatch commands, largest first

Ordered by pool rows. All are `apply=false` (REPORT). Only `nba-hoops` carries meaningful volume;
the rest are tiny and are listed for completeness.

```bash
# 1. nba-hoops — 20,203 rows, basketball 2024
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=nba-hoops -f sports=basketball -f years=2024

# 2. topps-chrome — 143 rows, two sports, 2008-2025
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=topps-chrome -f sports=baseball -f years=2023,2024,2025
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=topps-chrome -f sports=basketball -f years=2008

# 3. leather-lumber — 98 rows, baseball 2019
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=leather-lumber -f sports=baseball -f years=2019

# 4. upper-deck — 13 rows, baseball 1992-2002
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=upper-deck -f sports=baseball -f years=1992,1993,1997,1999,2002
```

### The catalog side, and the order

A ruled alias has **two** stores to resolve, not one. The `sold_comps` reslug above moves the sales;
catalog rows still keyed on the alias slug must move onto the ruled slug through
`catalogRowOps.moveCatalogRow` — which is exactly what `rekey-product-setkey MODE=catalog` does.

**ORDER: catalog move FIRST, pool reslug SECOND. Always.**

Reasoned from the mint path rather than from preference. `ensureCatalogRow` (
`src/services/catalog/ensureCatalogRow.service.ts`) does a **point read at the sale's slug** and, on a
miss, upserts a fresh row with `source: "ingest-auto-seed"`:

```
const { resource } = await container.item(input.slug, input.slug).read();
if (resource) { markKnown(input.slug); return; }
// ...404 falls through to create, source: "ingest-auto-seed"
```

So if the **pool** moves first, sales land on the ruled slug while the catalog row is still at the
alias slug. The point read misses, and the next ingest **mints a self-derived `ingest-auto-seed` row
at the ruled slug** — a catalog row minted from our own sales, which is the defect
`project_self_comp_publish_labeled` and the "catalog rows are not checklist rows" finding both warn
about. Catalog-first never mints: the row is already at the ruled slug when the first resluged sale
arrives, so the point read HITS and `ensureCatalogRow` no-ops.

Two supporting facts, both checked rather than assumed:

- `moveCatalogRow` handles a populated destination through `chooseSurvivor`, so moving onto a ruled
  slug that already holds checklist rows **merges**; it does not clobber the checklist row.
- `supersededBy` is **inert** for this purpose — written by `dedupe-catalog-rows.cjs`, and
  `grep -rn "supersededBy" backend/src` returns nothing. Marking a loser superseded would NOT hide it
  from `ensureCatalogRow`'s point read, so the rows have to genuinely move.

### Catalog dispatches (report-first), in order

`rekey-product-setkey` takes FROM/TO explicitly, so there is one dispatch **per alias**, not per ruled
key. Runner inputs: `setkey_like` = FROM, `titles` = TO, `mode`, `sports`.

```bash
# 0. bellingham-mariners — the catalog half of #1786, still open.
#    MEASURED read-only 2026-09-05, and the count is NOT where you would guess:
#      bellingham                       0 catalog rows
#      bellingham-mariners-team-issue   0 catalog rows
#      1987-bellingham-baseball         4 rows  <- ALL of them live here
#                                       (3 ingest-auto-seed-graded + 1 sales-attested-unnumbered)
#    So the FROM scope is the UNSTRIPPED catalog spelling. Dispatching on
#    `bellingham` would sweep nothing and report success — the exact failure the
#    lane's scope gate exists to prevent. Only this one dispatch is needed.
#
#    The pool reslug already applied (167 rows moved, verified), so this runs in
#    the WRONG order by necessity — the sales are already on the ruled slug.
#    Expect ensureCatalogRow to have minted at the destination; the move's
#    chooseSurvivor is what reconciles it. Verify the survivor is the CHECKLIST row
#    (source drew-ruling-checklist-2026-08-30), not an auto-seed.
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=baseball -f setkey_like=1987-bellingham-baseball -f titles=bellingham-mariners

# 1. nba-hoops <- panini-hoops   (2,680 catalog rows: 2,086 ingest-auto-seed-graded,
#    396 sales-attested, 194 sales-attested-graded, 4 auto-seed-graded-graded)
#    NOTE: every one is self-derived. None is a checklist row, so this move adds no
#    checklist coverage — it exists to stop the point read missing and re-minting.
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=basketball -f setkey_like=panini-hoops -f titles=nba-hoops

# 2. topps-chrome <- chrome   (8 catalog rows: 2 auto-seed-graded, 2 ebay-user-purchase,
#    2 ebay-browse, 1 user-verified, 1 auto-seed-graded-graded)
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=baseball -f setkey_like=chrome -f titles=topps-chrome
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=basketball -f setkey_like=chrome -f titles=topps-chrome

# 3. leather-lumber <- panini-leather-lumber
#    NOT NEEDED — measured read-only 2026-09-05: panini-leather-lumber holds ZERO
#    card_catalog rows of any kind. Nothing to move. The pool reslug is the whole job.

# 4. upper-deck <- ud   (12 catalog rows: 7 sales-attested + 5 sales-attested-graded
#    — all self-derived, zero strict. See the caution below on a two-letter FROM.)
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=baseball -f setkey_like=ud -f titles=upper-deck
```

**Per-key summary of whether the catalog step is needed:**

| Ruled key | Alias | Catalog rows on the alias | Catalog step? |
|---|---|---:|---|
| `bellingham-mariners` | `1987-bellingham-baseball` | 4 (3 auto-seed-graded + 1 sales-attested-unnumbered); `bellingham` and `…-team-issue` hold **0** | **YES** — first in the queue, FROM the unstripped spelling |
| `nba-hoops` | `panini-hoops` | 2,680, all self-derived | **YES** |
| `topps-chrome` | `chrome` | 8, all self-derived/user | **YES** (tiny) |
| `leather-lumber` | `panini-leather-lumber` | **0** | **NO** — nothing to move |
| `upper-deck` | `ud` | 12, all self-derived | **YES** (tiny) |

**A caution on `ud` as a FROM scope.** `setkey_like` is a *like* match in some lanes; a two-letter
FROM is the kind of scope that can match more than it names. Read the lane's banner and its
before/after counts in REPORT mode before ever considering APPLY, and if the banner shows it matching
anything other than the bare `ud` key, do not proceed — split it by year instead.

**Runner budget.** No ruled key here approaches the ceiling — the largest sweep is 20,203 rows in one
sport-year, well inside a single run, so **no sharding opt-in and no year splits are needed**. For
contrast, `donruss-optic` at 220,362 rows across four sport-years *would* want year splits if it ever
becomes a ruled destination; the four cells are football 2023/2024/2025 and basketball 2022/2023/2024.

**Order of operations.** `scope` must be a ruled destination *and* a `normalizeSetKey` fixed point;
the lane refuses otherwise. Both hold for all five only **after this PR merges and deploys** — so the
dispatches above are valid only post-deploy. Backend `src` changed, so the
"Daily 5AM ET Refresh & Deploy" workflow must be dispatched after merge; verify with
`curl /api/health` and check `build.shaShort`.

## Open questions for Drew

1. **The 306,807 already-resolved rows** (`panini-optic`, `finest`, `stadium-club`, …) sit on stale
   stored slugs that neither the census nor the reslug lane can move. Options: promote the derived
   aliases to *ruled* ones so the lane's scope gate accepts them (a vocabulary no-op that unlocks the
   sweep), or widen the lane to accept any declared alias destination. The first keeps "a ruled key
   is a human decision with evidence" intact; **recommended**.
2. **`panini-select` (367,220 catalog rows, 291k+ strict) vs `select` (45,850).** The census proposed
   folding the *larger, better-backed* key into the smaller. Counting by source says the opposite
   direction, if either. Unruled here — it needs a decision, not a derivation.
3. **`panini-score` → `score`**: hobbymonitor wrote 3,300 strict rows under `panini-score`, while
   `ERA_SPLIT_TABLE` says `panini-score` should never exist ("no synthetic products"). A strict source
   is now writing a key the era table calls invented. Worth a look as an ingest defect.

## Reproducing

Read-only. Clone at `C:/tmp/hiq-aliases`, census artefacts under `C:/tmp/`.

```
scratch/classify203.ts   203 census pairs -> live normalizeSetKey + spellForEra
scratch/buckets.ts       the six-bucket classification -> C:/tmp/buckets.json
scratch/srccount2.cjs    card_catalog rows BY SOURCE for a key list
scratch/verify5.ts       the five gates, per ruled pair
```
---

# Update, 2026-09-05 (later the same day): the lane now reaches them — #1793

**Drew's ruling on open question 1: DERIVER-RESOLVED aliases qualify as scope.** Not by widening the
gate quietly, but by naming a second admission rule alongside the ruled one and making every refusal
say which rule refused it. `reslug-ruled-alias.cjs` implements it; everything below was measured
READ-ONLY against prod on 2026-09-05, with the lane itself in REPORT mode.

## The admission rule

The alias set for a scope key `K` is the union of two rules:

| Rule | Admits | Authority |
|---|---|---|
| **RULED** | a `RULED_ALIASES` entry whose `canonical` is `K` | a human decision, with its evidence |
| **DERIVER** | a spelling the live vocabulary already folds onto `K` (`normalizeSetKey(alias) === K`) **and that the pool actually stores** | a derivation the deriver already performs on every write |

The deriver-resolved spellings are **discovered, never typed** — the lane reads segment 3 of the ids
under `hiq:sport:year:` and asks the live `normalizeSetKey` about each distinct value. A typed list
would be a second copy of the vocabulary: it drifts when the vocabulary changes, it can name a
spelling that does not exist (sweeping nothing and reporting success), and it can miss one that does.
The banner prints the admitted set as `deriver-resolved: a, b, c` and labels every entry `[RULED]` or
`[DERIVER]`.

### Four gates, and every refusal exits 2

1. **The scope key must be a `normalizeSetKey` fixed point.** This is what permanently refuses
   `donruss` — the census's #2 by volume — because `normalizeSetKey("donruss") === "panini-donruss"`,
   an era split `spellForEra` resolves per year.
2. **A candidate alias must not be a fixed point of its own.** A key the deriver leaves alone is a key
   the vocabulary calls a product. This refuses #1792's whole 58-pair SPLIT bucket by mechanism
   rather than by a list anyone maintains — `select`, `score`, `studio`, `diamond-kings` are all
   fixed points.
3. **A candidate holding strict checklist rows of its own must prove it names the same cards.**
   See below — this gate was rewritten by its own first REPORT run.
4. **A ruling-conflict deny-list**, from this runbook's own refusals, checked ahead of *both* rules so
   a table edited into conflict with a standing test refuses rather than sweeps.

## Gate 3 was wrong on its first run, and prod said so

The gate began as "an alias holding any strict checklist-backed catalog row is a product, refuse" —
the standing count-by-source rule, applied directly. Run in REPORT mode against prod it refused
**`panini-optic`**, the 235,186-row headline case of the very ruling that asked for this lane, on
15,995 strict `checklistinsider` rows in football/2024 alone.

That refusal was measured, not guessed, and it was wrong:

```
MEASURED READ-ONLY 2026-09-05, basketball/2023
  panini-optic   20,651 catalog rows  (20,221 distinct cardNumber|parallel)
  donruss-optic  20,132 catalog rows  (19,970 distinct)
  shared         19,490 of 19,970  =  97.6%
  panini-optic's own setName field:  "2023 donruss optic"
football/2023: 82.2%.   football/2024: 74.7%.
```

Both keys are strict. They are **also the same product**: `checklistinsider` was ingested twice under
two spellings of one release, and the alias's own `setName` spells the destination. A gate that stops
at "strict rows exist" cannot see that, and refuses a fold that is exactly
`CF-ONE-CARD-ONE-ROW-ONE-POOL`.

The contrast is what makes the measurement a discriminator rather than an excuse — a genuine SPLIT
pair from this runbook's own bucket:

```
MEASURED READ-ONLY 2026-09-05, baseball
  panini-diamond-kings vs diamond-kings, in their two SHARED years
    2020:  54 vs 47 distinct cards,  shared 0  ->  0.0%
    2022:   2 vs  8 distinct cards,  shared 0  ->  0.0%
```

Zero. Row counts and strict-source presence are identical in *shape* across both pairs; only the
CARDS tell them apart. So gate 3 is now: **an alias holding strict rows of its own is admitted only
when its checklist names ≥60% of the destination's distinct `cardNumber|parallel` in the shared
sport/year cells.** Below that it is a product and it refuses; with **no shared cell at all** it also
refuses, because silence is not proof of sameness. The floor sits in a gap two orders of magnitude
wide (0.0% vs 74.7%+), so its exact value is not load-bearing.

An incidental defect found and fixed while measuring this: the overlap scan first read the *cell*
prefix `hiq:football:2024:` and filtered by segment, exhausting its page bound on unrelated products
before reaching the two being compared — it scored `panini-optic` at 12.1% off 1,977 of 17,003 rows
it had actually seen. It now scans each key's own narrow prefix. A bound that silently truncates the
evidence turns a discriminator into a coin flip.

## Corrections to the measurements above

Three numbers in the earlier half of this runbook do not survive re-measurement. They are corrected
here rather than edited away, because the correction is the useful part.

| Earlier claim | Measured 2026-09-05 | Consequence |
|---|---|---|
| `finest` → `topps-finest`, 306,807 already-resolved rows include it | **`finest` holds 0 pool rows** across baseball 2020-25, basketball 2021-23, football 2021-23 (`topps-finest` holds 61,720) | nothing to dispatch; the discovery finds no alias and the lane refuses rather than sweeping nothing |
| `stadium-club` → `topps-stadium-club`, likewise | **`stadium-club` holds 0 pool rows** (`topps-stadium-club` holds 59,337) | same — already consolidated |
| `panini-hoops` catalog: "2,680 rows, every one self-derived, none is a checklist row" | **43,822 rows, 43,332 STRICT** (`checklistinsider-2026-08-27` = 43,014) | the catalog move carries real checklist coverage, not just a point-read fix |
| `nba-hoops` catalog: "26,355 checklistinsider rows" | **0 rows in every dispatched cell** (basketball 2021-25) | the catalog move is a clean relocation — no destination twin, so `chooseSurvivor` never has to arbitrate |

The `finest`/`stadium-club` correction is the discovery rule earning its place: a typed alias list
would have dispatched two sweeps that could only have reported success over an empty population.

## The population, measured

```
### panini-optic -> donruss-optic          POOL rows        CATALOG rows (strict)
  football/2022      alias   8,669   dest     189       187        (0)
  football/2023      alias  54,370   dest     768    18,324   (17,496)
  football/2024      alias 100,471   dest   2,057    17,003   (15,995)
  football/2025      alias  25,072   dest   3,382    19,706   (19,472)
  basketball/2021    alias   6,030   dest     112       164        (0)
  basketball/2022    alias   7,380   dest      82       175        (0)
  basketball/2023    alias  11,120   dest     242    20,651   (20,503)
  basketball/2024    alias  21,785   dest     950    31,271   (31,023)
  basketball/2025    alias     289   dest       8         1        (0)
  TOTAL              alias 235,186   dest   7,790   107,482   (104,489)

### panini-hoops -> nba-hoops   [RULED]
  basketball/2021    alias   2,759   dest       0        40        (0)
  basketball/2022    alias   3,107   dest       0        72        (0)
  basketball/2023    alias  17,372   dest       0    15,382   (15,134)
  basketball/2024    alias  20,192   dest       0    28,328   (28,198)
  basketball/2025    alias      22   dest       0         0        (0)
  TOTAL              alias  43,452   dest       0    43,822   (43,332)
```

`nba-hoops` is the starkest split in the set: **20,192 sales on the alias and zero at the
destination** in 2024 alone. One product, and every sale of it in the wrong pool.

## Throughput, and why NO sharding is dispatched

Measured in REPORT mode against prod, `donruss-optic` / football / 2024:

```
25,010 rows scanned in 35s wall  (~18s of that fixed: discovery + gate + BEFORE counts)
=> ~1,470 rows/s sustained scan
   reconciled: intended 25,010 = written 25,010 + skipped 0
```

APPLY is slower than a scan — upsert, verify-read, delete per row. Sizing the largest cell against a
deliberately pessimistic APPLY floor:

| APPLY rate | football/2024 (100,471) | whole panini-optic (235,186) |
|---|---|---|
| 90 rows/s | 19 min | 44 min |
| 60 rows/s | 28 min | 65 min |
| 40 rows/s | 42 min | 98 min |

**Every cell fits one slot inside the 140-minute budget, and so does the whole population.** The
task that commissioned this work assumed 220k rows would not fit; the measurement says otherwise, so
**no sharding opt-in is dispatched** — `runner-shard-scope.cjs` remains wired (`SHARD=true` with
`slot`/`slots`) and the #1791 relaunch step still resumes a run that hits the budget marker, but
dispatching a fan-out nobody needs is an un-evidenced complication. Dispatch **per cell**, largest
first, so a stall is bounded by one sport-year rather than by the whole product.

## Dispatch plan — catalog FIRST, pool SECOND, per cell, largest first

The ordering argument from the first half of this runbook is unchanged and is the reason for it:
`ensureCatalogRow` point-reads the sale's slug and mints a self-derived `ingest-auto-seed` row on a
miss, so a pool-first move manufactures exactly the rows `project_self_comp_publish_labeled` warns
about. Catalog-first never mints.

`rekey-product-setkey` MODE=catalog resolves by **exact id-stem segment** (`parts[3] !== FROM` →
left, counted), not by a LIKE — verified by reading the lane. That retires the earlier caution about
a two-letter FROM such as `ud`: it cannot over-match. It takes `SPORT`, `SETKEY`(FROM),
`TO_SETKEY`(carried in `titles`); `YEARS` is optional for catalog and enforced on the slug when given.

### Step 0 — bellingham-mariners, the catalog half of #1786 (still open)

4 rows, and **not on the key you would guess**: `bellingham` and `bellingham-mariners-team-issue`
hold **0** catalog rows; all 4 live on `1987-bellingham-baseball` (3 `ingest-auto-seed-graded` + 1
`sales-attested-unnumbered`). The pool reslug already applied (167 rows, verified), so this one runs
in the wrong order by necessity — verify the survivor is the CHECKLIST row
(`drew-ruling-checklist-2026-08-30`), not an auto-seed.

```bash
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=baseball -f years=1987 \
  -f setkey_like=1987-bellingham-baseball -f titles=bellingham-mariners
```

### Step 1 — nba-hoops ← panini-hoops  [RULED]

Catalog first (43,822 rows, 43,332 strict; destination empty, so no survivor arbitration), then the
pool (43,452 rows). Largest cells first.

```bash
# 1a. catalog
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=basketball -f years=2024 \
  -f setkey_like=panini-hoops -f titles=nba-hoops
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=basketball -f years=2023 \
  -f setkey_like=panini-hoops -f titles=nba-hoops
gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
  -f mode=catalog -f sports=basketball -f years=2021,2022,2025 \
  -f setkey_like=panini-hoops -f titles=nba-hoops

# 1b. pool — only after 1a has APPLIED and been verified by read
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=nba-hoops -f sports=basketball -f years=2024
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=nba-hoops -f sports=basketball -f years=2023
gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
  -f scope=nba-hoops -f sports=basketball -f years=2021,2022,2025
```

### Step 2 — donruss-optic ← panini-optic  [DERIVER]

The largest move in the set: 107,482 catalog rows and 235,186 pool rows. Catalog first, per cell,
largest first. Unlike `nba-hoops`, the destination is populated in every strict cell, so
`moveCatalogRow`'s `chooseSurvivor` **will** arbitrate — checklist beats vendor beats derived, so a
derived stub can never overwrite a checklist row, but the survivor should be spot-checked on the
first cell before the rest are applied.

```bash
# 2a. catalog, largest first
for Y in 2024 2023 2025 2022; do
  gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
    -f mode=catalog -f sports=football -f years=$Y \
    -f setkey_like=panini-optic -f titles=donruss-optic
done
for Y in 2024 2023 2022 2021 2025; do
  gh workflow run backfill-runner.yml -f script=rekey-product-setkey -f apply=false \
    -f mode=catalog -f sports=basketball -f years=$Y \
    -f setkey_like=panini-optic -f titles=donruss-optic
done

# 2b. pool — only after 2a has APPLIED and been verified by read
for Y in 2024 2023 2025 2022; do
  gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
    -f scope=donruss-optic -f sports=football -f years=$Y
done
for Y in 2024 2023 2022 2021 2025; do
  gh workflow run backfill-runner.yml -f script=reslug-ruled-alias -f apply=false \
    -f scope=donruss-optic -f sports=basketball -f years=$Y
done
```

### Not dispatched, and why

| Key | Reason |
|---|---|
| `topps-finest` ← `finest` | **0 pool rows on the alias.** Already consolidated; the lane refuses rather than sweeping nothing |
| `topps-stadium-club` ← `stadium-club` | **0 pool rows on the alias.** Same |
| `select`, `score`, `studio`, `diamond-kings`, … (58 SPLIT pairs) | refused by gate 2 — each alias is a `normalizeSetKey` fixed point, i.e. a product |
| `ud-choice`, `triple-threads`, `panini-elite`, `panini-select`, `panini-score` | on the ruling-conflict deny-list; a standing ruling outranks a derivation |
| `donruss` | refused by gate 1 — not a fixed point (→ `panini-donruss`, an era split) |
| 31 Bowman/Topps CONTESTED pairs | ruled DISTINCT; refused by gate 2 and pinned by a standing test |

**All dispatches above are `apply=false`.** Read each banner — the admitted alias set, the rule that
admitted each, the BEFORE/AFTER counts and the reconciliation — before any of them is repeated with
`apply=true`. Backend `src` did not change in #1793 (the lane is a script and its dist/ dependencies
are unchanged), but the **catalog** lane's behaviour depends on the deployed vocabulary, so confirm
`/api/health` `build.shaShort` matches main before applying.

## Open question 1 — answered

Drew chose the recommended option's *spirit* (a ruled key stays a human decision) while widening the
gate mechanically: a deriver-resolved alias is admitted **as such**, labelled `[DERIVER]` in the
banner, and made to pass three gates a ruled alias is not asked to pass. Nothing was promoted into
`RULED_ALIASES` to unlock a sweep, so "a ruled key is a human decision with evidence" is intact — and
the 306,807 rows are reachable. Questions 2 (`panini-select` direction) and 3 (`panini-score`
hobbymonitor ingest) remain open and are now enforced as deny-list entries so neither can be swept by
accident in the meantime.
