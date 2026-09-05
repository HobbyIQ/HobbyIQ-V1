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
