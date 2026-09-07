# The `unknown` setKey pool — the defect at the source, 2026-09-07

Follow-on to #1927, which measured the population (664,810 rows) and named it
"an ingest-side defect in two vendor lanes". This report finds the defects,
proves them against the real derivers, and fixes them.

**No prod writes.** Every number is MEASURED (a completed query, stated with
its method) or SAMPLED (stated with its sample size). The repair is to the
CODE; the stock of existing rows is the running rematch's business, not this
PR's.

---

## 0. The headline

Three defects, all at the source, none of them a missing vocabulary entry:

| # | defect | measured blast radius |
|---|---|--:|
| 1 | `normSport` discards the vertical CardHedge STATES in `group` | **1,525,994** ch_daily_sales rows |
| 2 | `normalizeSetKey` called without the sport at 3 sites that have it | Pokemon rows minted into **Panini** pools |
| 3 | the census scaled every extrapolation to a hardcoded `POPULATION_TOTAL` | every `~total` this script ever printed |

And one finding that re-frames the whole program: on the CardHedge lane, once
the product name is read, **the vocabulary bucket is empty**. The binding
constraint is checklists, not parser rules.

---

## 1. Defect 1 — the vendor states the vertical and we threw it away

`ch_daily_sales` GROUP BY `c["group"]`, measured 2026-09-07 (0.9s):

```
Baseball      3,265,744  [mapped]
Pokemon       1,525,994  [normSport -> NULL]
Basketball      984,005  [mapped]
Football        788,735  [mapped]
(undefined)         155  [normSport -> NULL]

mapped = 5,038,484   normSport returns null = 1,526,149  (23.2%)
```

`normSport` (chRowToSoldComp.ts) knew five sports and returned `null` for
`Pokemon`. The doctrine says sport comes from `c["group"]` — and for 23.2% of
the container we read the field, recognised it, and discarded it.

### What `null` costs, traced end to end

`sport: null` reaches `deriveHobbyIqSlug`, which falls back to
`inferSportFromContext` — a bare substring test for the word "pokemon" over
`setName + title`. Measured on the real deriver:

| CH `card_set` | `normSport` | `inferSportFromContext` | slug |
|---|---|---|---|
| `Prismatic Evolutions` | null | null | **NULL** (`sport-uncanonical`) |
| `Obsidian Flames` | null | null | **NULL** (`sport-uncanonical`) |
| `Crown Zenith` | null | null | **NULL** (`sport-uncanonical`) |
| `Pokemon Surging Sparks` | null | pokemon | `hiq:pokemon:2025:sv08:…` |

Only the fourth got an identity, and only because the set's marketing name
happens to contain the word. The sport is also what gates the ruled Pokemon
setKey vocabulary (`resolveSetKeyForSlug`), so no such row could ever reach it.

That is the `pokemon` share of the `unknown` pool — 415,649 rows, 62.5% of it —
arriving unaddressed by construction.

### With the vertical forwarded

Same deriver, same set names, sport passed:

```
Prismatic Evolutions  -> hiq:pokemon:2025:sv08-5:…
Obsidian Flames       -> hiq:pokemon:2023:sv03:…
Crown Zenith          -> hiq:pokemon:2023:swsh12-5:…
Japanese Mega Dream ex-> hiq:pokemon:2025:m2a:…
```

**No alias was added.** The vendor's own `group` is forwarded to a vocabulary
that already exists and is already ruled. `unknown` remains the answer wherever
the vocabulary genuinely has no rule — blank means unknown, never a guess.

Only `pokemon` was added to the map: it is the one non-sport vertical the
container measurably carries. `Wrestling` still returns `null`, and the caller
still decides whether that is a skip.

### The second copy

`bulk-import-ch-daily-to-sold-comps.cjs` carried its **own** literal copy of
`normSport`. A copy is how a fix reaches one ingest lane and not the other, so
the script now imports the one implementation instead of restating it.

---

## 2. Defect 2 — the sports vocabulary answering Pokemon questions

`normalizeSetKey(setName, sport?)` consults the ruled Pokemon English table
ONLY when its caller says the row is Pokemon — `151` is Scarlet & Violet 151
and also an ordinary sports set name, so the gate is deliberate. But 187 of its
188 product patterns are unanchored, so when the sport is NOT passed the sports
vocabulary claims Pokemon names outright. Measured:

| setName | `normalizeSetKey(name)` | `normalizeSetKey(name, "pokemon")` |
|---|---|---|
| `Obsidian Flames` | **`panini-obsidian`** | `sv03` |
| `Crown Zenith` | **`panini-zenith`** | `swsh12-5` |
| `Prismatic Evolutions` | `prismatic-evolutions` | `sv08-5` |
| `Paldea Evolved` | `paldea-evolved` | `sv02` |

This is exactly the damage `CF-NO-CROSS-VERTICAL-FALLBACK` measured at 59,748
rows on 2026-08-17 and fixed **inside `resolveSetKeyForSlug`**. Three call
sites were outside that net, each holding the sport and dropping it:

- `catalogMatcher.service.ts` `buildComponents` — the object it returns has
  `sport` as its FIRST field. `recordSoldComp` reaches it through
  `canonicalize` on every vendor row it reconciles. Measured before the fix:

  ```
  buildComponents({ sport: "pokemon", setName: "Obsidian Flames" })
    -> hiq:pokemon:2023:panini-obsidian:125:base:no-auto
  ```

  A Pokemon card addressed into a Panini basketball pool, by the deriver that
  is supposed to reconcile identities.

- `catalogMatcher.service.ts` `applySetKeyInvariant` — asked the sports
  vocabulary what a Pokemon row wanted, got `panini-obsidian`, then REJECTED
  the correct `sv03` match for disagreeing with it. A right guard measuring the
  wrong question.

- `persistVendorSalesToPool.service.ts` — the variation lookup keyed on
  `panini-obsidian` and never met its own catalog rows.

For every non-Pokemon sport, passing the sport is the identity function; that
is pinned.

---

## 3. Defect 3 — a census that scaled to a constant

`census-unknown-setkey.cjs` hardcoded `POPULATION_TOTAL = 889860` and scaled
every `~total` and every `±` to it. Measured under that constant's OWN
predicate the live count is 269,061; under the predicate that matches the pool
reader (either id field) it is 664,810. The constant was **3.3×** the first and
**1.34×** the second, and no run could reproduce it.

Fixed three ways, all pinned:

1. **The denominator is measured**, by a `COUNT(1)` over the SAME `where` the
   run samples with — including its own `--years`/`--sports` narrowing, so the
   numerator and denominator cannot describe different populations. A census
   that scales a filtered sample to an unfiltered total reports nonsense, and
   that was the constant's second failure.
2. **It may be supplied** (`--population=<n>` / `CENSUS_POPULATION`) when the
   caller already measured it. Never a literal in the file.
3. **A run with neither withholds extrapolation.** `scale()` and `errorBar()`
   return `null`, the banner prints `n/a`, and the buckets stand as sampled
   counts. Absent beats wrong applies to error bars too.

The population predicate now reads **both** id fields, because the pool reader
ORs them and they disagree on 395,749 rows — with the old `cardId`-only reading
being the smaller half (269,061 vs 664,125).

---

## 4. The buckets — what the derivation returns today

Sampled 5,000 rows per source from the live `unknown` pool, weighted to Pokemon,
classified through the same functions the ingest uses.

### 4a. Reading the STORED `setName` (what the row carries today)

| bucket | cardhedge | tca-ebay |
|---|--:|--:|
| (a) stale — derives a ruled key today | 1,863 | 1,239 |
| (b) no vocabulary entry | 1,992 | 2,307 |
| (c) key exists, no checklist | 1,118 | 1,278 |
| (d) unidentifiable | 27 | 176 |

And the finding that explains bucket (b):

> **`literalUnknownSetName`: 5,000 of 5,000 cardhedge rows** (and 4,975 of
> 5,000 tca-ebay rows) store `setName` as the literal string **`"Unknown"`**.

CardHedge does **not** send that: `ch_daily_sales` rows whose `card_set` is
literally `Unknown` number **zero** (measured). The literal is OURS — the
`inferSetKeyFromTitle` sentinel, persisted into the row's `setName`. So the
derivation, which reads `setName` and never the title, is being asked to name a
product from the word "Unknown".

The product name was in the title the whole time:

```
setName="Unknown"  title="1995 SP Championship Basketball #25 Base"
setName="Unknown"  title="1995 SP Championship Basketball #143 Base"
```

### 4b. Reading the product out of the TITLE (what the fixed lane derives)

Same rows, product name recovered from the title:

| bucket | cardhedge | tca-ebay (n=2,500) |
|---|--:|--:|
| (a) stale — derives a ruled key | 1,780 | 343 |
| (b) **no vocabulary entry** | **0** | **9** |
| (c) key exists, no checklist | 3,193 | 2,078 |
| (d) unidentifiable | 27 | 70 |

**The vocabulary bucket collapses from 1,992 to 0 on the CardHedge lane, and
from 2,307 to 9 on tca-ebay.** Every Japanese Pokemon label the first pass
reported as "needs vocabulary" already has a ruled key:

```
Pokemon Japanese Mega Dream ex              -> m2a
Pokemon Japanese Scarlet & Violet Terastal  -> sv8a
Pokemon Japanese Sword & Shield VSTAR Univ. -> s12a
Pokemon Japanese Nihil Zero                 -> m3
Pokemon Japanese Rocket Gang                -> japanese-rocket-gang
```

They were never a vocabulary gap. They were a row whose `setName` said
"Unknown" and a deriver that never looked at the title.

**This re-frames the program.** The census's own reading — 60% of refusals as
`setkey-unknown-unsupported`, i.e. vocabulary work — is an artefact of reading
the stored sentinel. The real constraint is **bucket (c): checklists**, which
grows to 3,193 of 5,000 cardhedge rows once the product is read. A key without
a checklist is a vocabulary win and a pricing no-op, exactly as #1927 said.

### The acquisition list (key derives, no checklist backs it)

cardhedge, by sample rows:

```
1995|nba-hoops   252     2025|m2a          103     2024|sv8a          84
1990|nba-hoops   182     2025|m1l           63     2023|swshp         46
1997|ud3          39     2024|sv7a          36
2023|pokemon-scarlet-violet-black-star-promos   75
2025|pokemon-scarlet-violet-black-star-promos   59
2016|pokemon-xy-black-star-promo                51
2015|pokemon-xy-black-star-promo                44
```

tca-ebay is dominated by `upper-deck` across many years, plus Japanese
McDonald's promo sets.

### What is left in bucket (b) — for a RULING, not a patch

Nine tca-ebay rows, all noisy eBay seller text rather than product names
(`"pokemon 2025 articuno 102/100 full art art rare"`,
`"🔥 2000 pokémon ancient mew promo – degree fai"`). No aliases are proposed
here: per the standing rule a spelling this census surfaces is a candidate for
the alias program to rule on, and this PR authors none.

Note also that a derived key is not automatically a GOOD key: tca-ebay titles
produced keys like `2018|onix-sm-lost-thunder-normal` and
`2025|japanese-m-p-promo-mcdonalds`, which are derived-but-junk and belong in
the same ruling queue. Named, not fixed.

---

## 5. What was NOT done

- **No vocabulary aliases were added.** Both ingest fixes forward an argument
  to an existing ruled vocabulary. The labels above are reported for a ruling.
- **No rows were written.** The stock of 664,810 existing rows is the running
  rematch's business (`scope=improve` already covers `unknown` → key moves per
  #1927 §4). This PR stops the bleeding; it does not pay down the stock.
- **The sport-mismatch finding** (#1924, hockey rows under `sport: baseball`)
  is out of scope and untouched.
- **No new `workflow_dispatch` inputs.** `--population` is a script arg with an
  env fallback, on a script the runner already invokes.

## 6. Deploy

`backend/src` is touched, so a merge of this PR owes a manual
**"Daily 5AM ET Refresh & Deploy"** dispatch. Merging alone does not deploy.
