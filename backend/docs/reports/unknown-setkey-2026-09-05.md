# `setKey=unknown` — what the fleet fixes, what needs vocabulary, what is stuck

**Date:** 2026-09-05  ·  **Mode:** READ-ONLY (no writes, no dispatches)
**Script:** `backend/scripts/census-unknown-setkey.cjs` — no write path, no `--apply`, and the runner refuses an `apply=true` dispatch of it outright.

## The population, and why it is its own lane

889,860 `sold_comps` rows carry a slug whose product segment is the literal string `unknown`:
`hiq:<sport>:<year>:unknown:<cardNumber>:…`. The checklist-gap census
(`checklist-gaps-2026-09-05.md`) measured that number on a full scan and named these rows the largest
single identity defect in the pool — larger than any checklist gap.

They are a separate lane for one reason: **no checklist can ever reach them.** A checklist is keyed by
`(sport, year, setKey)`. A row whose `setKey` is `unknown` names no product to look one up by, so
acquiring every checklist on earth moves none of them. This is a **parser** problem wearing a catalog
problem's clothes, and the fix — where there is one — is a vocabulary entry, not a scrape.

## Method

Every row is re-derived through **the Great Rematch's own code**: `deriveIdentity` and `storedIdentity`
imported from `rematch-sold-comps.cjs`, and `classifyRow` from `lib/rematch-classify.cjs`. They are
imported rather than re-implemented on purpose — a census that models the classifier measures the
model, not the pool. The destination's checklist backing is the same point read the fleet does before
it writes.

| Quantity | Value |
|---|---|
| Population (measured, full scan, 2026-09-05) | **889,860** |
| Rows sampled by this census | **60,000** (6.74%) |
| Scan rate | 436 rows/s, 138 s wall |
| Rows matching the filter but rejected by the segment re-check | 0 |
| Distinct proposed keys in the vocabulary bucket | 15,501 (over 16,852 raw spellings) |

Sampling is by page order over the whole container, not by year or sport, so the per-cell numbers below
are the sample's own and the ± is a binomial 95% half-width scaled to the full population. **Every
extrapolated number in this report is labelled as one.**

## Headline

**The running IMPROVE fleet fixes about 8% of these rows. It is not the answer to this population.**

| Bucket | sampled | share | extrapolated (95% CI) | what it needs |
|---|---:|---:|---:|---|
| **fleet fixes** (IMPROVE + checklist-backed) | 4,789 | 8.0% | **71,026 ± 1,930** | nothing — already in flight |
| **reads the product, no checklist** | 12,564 | 20.9% | **186,337 ± 2,897** | a checklist (acquisition) |
| **needs vocabulary** | 33,724 | 56.2% | **500,161 ± 3,533** | a parser rule |
| **underivable** | 2,009 | 3.3% | **29,795 ± 1,281** | see the reasons below |
| CONFLICT (a rival reading, not a fill) | 6,895 | 11.5% | 102,260 ± 2,271 | Drew, row by row |
| AGREE | 19 | 0.0% | 282 ± 127 | nothing |
| PROTECTED | 0 | 0.0% | 0 | report-only forever |

Three findings follow from that table.

**1. The fleet covers 8%, and that is the whole of what is already in flight.** 71k rows is real and
needs no new code — but anyone reading "the Great Rematch is re-deriving the pool" as an answer to the
890k should not. The other 92% is blocked on something the fleet does not do.

**2. The single largest bucket is a PARSER vocabulary gap, and it is 500k rows.** These titles have
words and a year; `inferSetKeyFromTitle` simply has no rule for the product they name, returns
`"Unknown"`, and the deriver refuses rather than mint a guess (CF-UNKNOWN-IS-ALSO-A-GUESS). This is
the same class the V6 ruling (CF-SUPPORTED-SETKEYS-BY-ROW-COUNT, Drew 2026-09-03) is already working
through largest-first — and this census is the next input to it.

**3. A fifth of the population — 186k rows — is a vocabulary win that already happened.** The parser
reads the product correctly (the diff carries `filled:setKey`), and the row still does not move because
the destination has no checklist-backed catalog row. These are the checklist-gap program's population,
reached from the other side. They become fleet fixes the day the checklist lands, **with no code change
at all**.

### A correction this census made to itself

A first pass over 1,200 rows reported **48% CONFLICT** and 0 rows in "reads the product, no checklist".
Both numbers were wrong, and the same mistake caused both: `classifyRow` applies the checklist gate
*inside* the class decision. A row that is strictly more specific on every axis but whose destination is
unbacked does not come back `IMPROVE`-and-unbacked — it comes back **`CONFLICT` carrying
`filled:setKey` and `not-checklist-backed`**. Bucketing on `klass === IMPROVE && !backed` therefore
matched nothing, and eleven of every twelve "conflicts" were in fact vocabulary successes waiting on a
checklist. The census now reads the classifier's **reason**, which is where the answer actually is.
The measured CONFLICT share fell from 48% to 11.5%.

## Rows the running IMPROVE fleet will fix — ~71,026 (± 1,930)

The derivation resolves a product, the destination slug is checklist-backed, and `classifyRow` returns
`IMPROVE` with `filled:setKey` among its axes. The stored `unknown` counts as **blank** under
`GENERIC_SETKEYS`, so `unknown → a real product` is a **fill, not a lateral change** — which is exactly
the ruling that puts these in IMPROVE rather than CONFLICT. Representative rows:

```
hiq:hockey:2023:unknown:cr-kk:… -> hiq:hockey:2023:upper-deck:cr-kk:…   "2023-24 Upper Deck Synergy - Cranked Up Kirill Kaprizov"
hiq:basketball:2000:unknown:189:… -> hiq:basketball:2000:upper-deck:189  "2000-01 Upper Deck - Y3K Kobe Bryant #189"
hiq:baseball:2006:unknown:50:…   -> hiq:baseball:2006:topps-finest:50    "2006 FINEST #50 ALEX RODRIGUEZ YANKEES PSA 9"
hiq:hockey:2024:unknown:dp-11:…  -> hiq:hockey:2024:o-pee-chee:dp-11     "2024-25 O-Pee-Chee LUKE HUGHES New Jersey Devils"
```

**No action.** The fleet writes these under the existing canary gate. Nothing in this PR touches them.

## Rows that need a CHECKLIST, not a rule — ~186,337 (± 2,897)

The parser reads the product; the catalog has no checklist-backed row at the destination. Ranked by
rows, which is the order they are worth acquiring in. This is a **handoff to the checklist-gap
program**, not new work — and it is the same `upper-deck` / `leaf` story that census already told,
arrived at from the opposite direction.

| product (year / setKey) | rows sampled | ~total rows |
|---|---:|---:|
| `2026|leaf` | 827 | 12,265 |
| `2025|upper-deck` | 788 | 11,687 |
| `2025|leaf` | 631 | 9,358 |
| `2024|upper-deck` | 442 | 6,555 |
| `2026|upper-deck` | 247 | 3,663 |
| `2024|leaf` | 246 | 3,648 |
| `2023|upper-deck` | 244 | 3,619 |
| `2022|upper-deck` | 224 | 3,322 |
| `2021|upper-deck` | 220 | 3,263 |
| `2026|leaf-metal` | 193 | 2,862 |
| `2009|upper-deck` | 176 | 2,610 |
| `2021|cel25cc` | 167 | 2,477 |
| `2023|swsh12-5` | 161 | 2,388 |
| `2025|panini-rookies-and-stars` | 155 | 2,299 |
| `2005|upper-deck` | 152 | 2,254 |
| `2003|upper-deck` | 150 | 2,225 |
| `2023|leaf` | 147 | 2,180 |
| `2021|cel25` | 146 | 2,165 |
| `2025|o-pee-chee` | 142 | 2,106 |
| `2008|upper-deck` | 137 | 2,032 |
| `2025|sp-authentic` | 120 | 1,780 |
| `2007|upper-deck` | 117 | 1,735 |
| `2025|panini-origins` | 115 | 1,706 |
| `2025|panini-hoops` | 106 | 1,572 |
| `2004|upper-deck` | 105 | 1,557 |
`2021|cel25cc` and `2023|swsh12-5` are Pokémon set codes, already the spelling `card_catalog` uses —
they belong to the code↔name work, not to a scrape.

## Rows that need VOCABULARY — ~500,161 (± 3,533)

The largest bucket, and the one this census exists to size. Below are the **top 50 products by row
count**, folded by proposed key.

**How to read this table, and its three caveats.**

- **`proposedKey` is `normalizeSetKey`'s own answer for the spelling** — the single source consulted,
  never a key this script invented. CF-NO-SYNTHETIC-PARALLELS and "the parser vocabulary is the single
  source" both forbid a second vocabulary, so nothing here is authored.
- **The rows are folded by that key, not by raw spelling.** "UD Exquisite Collection *Limited* / *Dual*
  / *Emblems* / *Number*" are four spellings of one product; ranking them separately would bury a
  420-row product under eight 40-row lines and ask for eight rules where one will do.
- **`probe` is a probe, and is named as one.** It is `hits/tried` over up to 12 **real card numbers
  taken from those rows' own titles**, point-read against `card_catalog`. It answers "would a row
  landing on this key be checklist-backed today?" — a sample, never the product's row count. The
  product-level query that would answer it properly (`WHERE c.setKey=@sk AND c.cardYear=@y`) is a
  cross-partition scan of a 20M-row container: measured 2026-09-05, it did not return in four minutes,
  and an `AbortSignal` on it did not release the event loop either.

> **A collapse warning, and it is load-bearing.** `normalizeSetKey` maps some of these spellings onto
> keys for **unrelated products**: `one piece op12-legacy of` → `panini-legacy`, `uno elite alt jerseys`
> → `donruss-elite`, `cgc pristine mega gengar` → `topps-pristine`. That is the known
> `normalizeSetKey collapses products` defect, visible here because this census reports what the
> function actually returns rather than what one wishes it returned. **Rows 2, 4, 14 and 15 of the table
> below must not be ruled on as written** — they are three or four distinct products sharing one
> proposed key, and adding a rule for them as-is would pool One Piece sales into Panini Legacy. The
> single-spelling rows (3, 5, 7, 9, 12, 16, 17, 18 …) carry no such risk.

| # | proposedKey | rows | ~total | probe | sport/year | representative spelling |
|---:|---|---:|---:|:---:|---|---|
| 1 | `upper-deck-exquisite` | 420 | 6,229 | 0/12 | basketball/2004 | ud "exquisite collection" limited (+7) |
| 2 | `topps-pristine` | 339 | 5,028 | 3/12 | baseball/2026 | 1x pristine 1x chrome (+7) |
| 3 | `simplified-chinese-cbb3-c-gem` | 316 | 4,687 | 0/2 | pokemon/2025 | simplified chinese cbb3 c-gem |
| 4 | `upper-deck` | 312 | 4,627 | 0/12 | non-sport/2024 | upper deck marvel masterpieces (+7) |
| 5 | `mep-first-partner-illustration` | 302 | 4,479 | 0/4 | pokemon/2026 | mep first partner illustration |
| 6 | `cracker-jack` | 279 | 4,138 | 0/12 | baseball/2020 | e145 cracker jack joe (+7) |
| 7 | `bo-jackson-battle-arena` | 222 | 3,292 | 0/12 | baseball/2026 | bo jackson battle arena |
| 8 | `japanese-m-p-promo-mcdonalds` | 215 | 3,189 | 0/1 | pokemon/2025 | japanese m-p promo mcdonald\'s (+1) |
| 9 | `mep-en-me-black-star` | 194 | 2,877 | 0/6 | pokemon/2026 | mep en-me black star |
| 10 | `panini-chronicles` | 174 | 2,581 | 0/12 | baseball/2025 | panini caitlin clark chronicled (+7) |
| 11 | `panini-playoff` | 171 | 2,536 | 7/12 | baseball/2004 | playoff prestige tom brady (+7) |
| 12 | `one-piece-japanese-promos` | 168 | 2,492 | 0/12 | pokemon/2024 | one piece japanese promos |
| 13 | `play-ball` | 157 | 2,328 | 0/12 | baseball/2023 | r336 play ball joe (+7) |
| 14 | `donruss-elite` | 149 | 2,210 | 0/12 | baseball/2025 | uno elite alt jerseys (+7) |
| 15 | `panini-legacy` | 141 | 2,091 | 0/12 | baseball/2025 | one piece op12-legacy of (+7) |
| 16 | `sv-black-star-promos` | 127 | 1,884 | 0/7 | pokemon/2023 | sv black star promos |
| 17 | `japanese-m3-nullifying-zero-art` | 120 | 1,780 | 0/2 | pokemon/2026 | japanese m3-nullifying zero art |
| 18 | `one-piece-op13-carrying-on` | 116 | 1,720 | 0/3 | anime-tcg/2025 | one piece op13-carrying on |
| 19 | `japanese-m5-abyss-eye-special` | 112 | 1,661 | 0/1 | pokemon/2026 | japanese m5-abyss eye special |
| 20 | `swsh-black-star-promo` | 110 | 1,631 | 0/7 | pokemon/2022 | swsh black star promo |
| 21 | `japanese-mega-dream-ex` | 110 | 1,631 | 0/9 | pokemon/2025 | japanese mega dream ex |
| 22 | `panini-elite-extra-edition` | 109 | 1,617 | 12/12 | baseball/2021 | panini elite extra edition (+7) |
| 23 | `sm-black-star-promo` | 100 | 1,483 | 0/4 | pokemon/2019 | sm black star promo |
| 24 | `svp-en-sv-black-star` | 82 | 1,216 | 0/11 | pokemon/2025 | svp en-sv black star |
| 25 | `japanese-promo-center-fukuoka` | 81 | 1,201 | 0/1 | pokemon/2025 | japanese promo center fukuoka |
| 26 | `mew-en-151-special-illustration` | 81 | 1,201 | 0/2 | pokemon/2023 | mew en-151 special illustration |
| 27 | `marvel-masterpieces-92-platinum` | 79 | 1,172 | 0/12 | non-sport/2024 | marvel masterpieces \'92 platinum (+4) |
| 28 | `one-piece-japanese-premium` | 79 | 1,172 | 0/8 | anime-tcg/2024 | one piece japanese premium |
| 29 | `panini-crusade` | 78 | 1,157 | 12/12 | baseball/2025 | panini crusade insert green (+7) |
| 30 | `one-piece-monkey-d` | 77 | 1,142 | 0/12 | anime-tcg/2025 | one piece monkey d. |
| 31 | `japanese-m2a-mega-dream-ex` | 77 | 1,142 | 0/5 | pokemon/2025 | japanese m2a-mega dream ex |
| 32 | `one-piece-japanese-promotional` | 72 | 1,068 | 0/3 | anime-tcg/2025 | one piece japanese promotional |
| 33 | `cenese-disney-winnie-the` | 70 | 1,038 | 0/12 | baseball/2026 | cenese disney winnie the |
| 34 | `one-piece-college-us` | 69 | 1,023 | 0/1 | pokemon/2026 | one piece college us |
| 35 | `one-piece-adventure-on` | 67 | 994 | 0/9 | pokemon/2026 | one piece adventure on |
| 36 | `japanese-promo-corocoro-comics` | 66 | 979 | 0/2 | pokemon/2001 | japanese promo corocoro comics |
| 37 | `kakawow-joy-edition-disney` | 65 | 964 | 0/2 | baseball/2024 | kakawow joy edition disney |
| 38 | `mcdonalds-promo-jp-pikachu` | 63 | 934 | 0/1 | pokemon/2025 | mcdonald\'s promo jp pikachu (+1) |
| 39 | `panini-decades-90s-pop` | 63 | 934 | 0/12 | baseball/2026 | panini decades 90s pop (+3) |
| 40 | `one-piece-championship-event` | 62 | 920 | 0/8 | anime-tcg/2025 | one piece championship event |
| 41 | `one-piece-english-version` | 61 | 905 | 0/5 | anime-tcg/2024 | one piece english version |
| 42 | `panini-classics` | 60 | 890 | 0/12 | baseball/2018 | panini classics lebron james (+7) |
| 43 | `one-piece-promos-convention` | 59 | 875 | 0/1 | anime-tcg/2024 | one piece promos convention |
| 44 | `one-piece-en-premium` | 59 | 875 | 0/6 | anime-tcg/2025 | one piece en premium |
| 45 | `one-piece-promos-monkey` | 57 | 845 | 0/6 | anime-tcg/2024 | one piece promos monkey |
| 46 | `skybox` | 57 | 845 | 0/12 | non-sport/2022 | skybox marvel masterpieces variant (+7) |
| 47 | `one-piece-promos-tin` | 57 | 845 | 0/1 | anime-tcg/2026 | one piece promos tin |
| 48 | `panini-fifa-world-cup` | 55 | 816 | 0/12 | soccer/2026 | panini fifa world cup |
| 49 | `first-partner-illustration-collection` | 55 | 816 | 0/5 | pokemon/2026 | first partner illustration collection |
| 50 | `japanese-sv-p-promo-detective` | 53 | 786 | 0/1 | pokemon/2023 | japanese sv-p promo detective |

### The shape of the tail, which is the actual finding

The top 50 products cover **6,113 of 33,724 sampled vocabulary rows — 18.2%**. The remaining 82% is
spread over **15,451 further proposed keys**. This population does **not** have a Pareto head the way
the V6 sports ruling did (`topps-finest` 192,725; `panini-hoops` 127,431). By vertical, over the top 50:

| vertical | rows | distinct keys |
|---|---:|---:|
| pokemon | 2,753 | 22 |
| baseball | 1,738 | 13 |
| anime-tcg | 699 | 10 |
| non-sport | 448 | 3 |
| basketball | 420 | 1 |
| soccer | 55 | 1 |

Read the representative spellings and the reason is plain: **this is overwhelmingly TCG promo and
special-set vocabulary** — `mep-first-partner-illustration`, `sv-black-star-promos`,
`japanese-m3-nullifying-zero-art`, `one-piece-op13-carrying-on`, `japanese-m-p-promo-mcdonalds`. These
are not products anyone forgot to add; they are the promo long tail of Pokémon and One Piece, where
nearly every set has its own promo line and each one is a handful of hundred rows.

**That is a ruling for Drew, not a rule to write.** Adding fifty Pokémon promo keys buys ~6k rows of
the 500k, and CF-POKEMON-TCG-EXPANSION-PARKED says the sport→vertical refactor is the blocker for that
whole vertical anyway.

### Per (sport, year), with sample sizes

| sport | year | sampled | fleet fixes | needs vocab | underivable |
|---|---:|---:|---:|---:|---:|
| pokemon | 2025 | 5,369 | 151 | 4,201 | 40 |
| baseball | 2025 | 4,324 | 24 | 2,282 | 47 |
| pokemon | 2026 | 3,836 | 603 | 2,419 | 22 |
| pokemon | 2023 | 3,598 | 171 | 2,705 | 112 |
| baseball | 2026 | 3,245 | 31 | 1,897 | 49 |
| pokemon | 2000 | 1,982 | 407 | 788 | 172 |
| pokemon | 2024 | 1,979 | 6 | 1,279 | 270 |
| pokemon | 2021 | 1,841 | 320 | 654 | 133 |
| baseball | 2024 | 1,708 | 9 | 803 | 20 |
| baseball | 2023 | 1,347 | 2 | 685 | 20 |
| pokemon | 2022 | 1,342 | 59 | 925 | 89 |
| pokemon | 2019 | 1,203 | 135 | 553 | 94 |
| baseball | 2022 | 1,147 | 13 | 568 | 20 |
| baseball | 2021 | 1,102 | 8 | 489 | 5 |
| anime-tcg | 2025 | 983 | 0 | 983 | 0 |
| pokemon | 2016 | 856 | 227 | 228 | 70 |
| anime-tcg | 2024 | 759 | 0 | 758 | 1 |
| pokemon | 2002 | 727 | 149 | 361 | 30 |
| hockey | 2025 | 686 | 24 | 276 | 3 |
| football | 2025 | 656 | 30 | 313 | 22 |
| baseball | 2000 | 583 | 191 | 221 | 2 |
| pokemon | 2001 | 530 | 163 | 258 | 22 |
| baseball | 2020 | 492 | 18 | 299 | 1 |
| hockey | 2024 | 472 | 100 | 152 | 3 |
| baseball | 2003 | 446 | 79 | 181 | 2 |
## Rows that are truly underivable — ~29,795 (± 1,281)

Bucketed by reason, because a lump is not actionable.

| reason | sampled | ~total | why no vocabulary entry helps |
|---|---:|---:|---|
| `guard:cardnumber-unparsed` | 1,536 | ~22,780 | the slug guard refuses: no card number could be read |
| `non-card-format` | 329 | ~4,879 | the title names a sticker, coin, pin or pog — not a card |
| `lot-or-range` | 141 | ~2,091 | a multi-card lot; one sale, many cards, no one identity |
| `guard:sport-uncanonical` | 3 | ~44 | the sport does not normalise to a canonical vertical |

**`guard:cardnumber-unparsed` is 76% of this bucket and it is NOT really underivable.** The samples say
so plainly:

```
hiq:pokemon:2022:unknown:player-duraludon:…  "PSA 10 Full Art Duraludon VMAX TG30 2022 Pokemon SWSH…"
hiq:pokemon:2003:unknown:player-seedot:…     "2003 Pokemon EX Sandstorm 76 Seedot CGC 10 GEM MINT"
hiq:pokemon:1997:unknown:player-pinsir:…     "Pinsir Holo 127 1997 Jungle Pokemon PSA 9 MINT"
hiq:pokemon:2017:unknown:player-golisopod:…  "Golisopod GX 148 Pokemon 2017 Sun Moon Burning Shadows"
```

Every one of those titles **states its card number** — `TG30`, `76`, `127`, `148` — and every one is
sitting on a `player-<name>` pseudo-number because the parser reads a card number only when it is
written `#N`. Pokémon titles overwhelmingly write it bare, or as `148/147`. This is the same
`player-` pseudo-number population CF-UNPARSED-IS-NOT-UNNUMBERED already named (89,138 rows pool-wide);
here it accounts for ~22,780 unknown-key rows on its own.

So the honest count of rows **nothing can derive** is closer to **~7,000** (non-card + lot + sport),
which is 0.8% of the population. The report keeps them separate rather than merging the number, because
the fix for the other ~22,780 is a *cardNumber* reader change and not a *setKey* one, and conflating
two lanes into one estimate is how a work list stops being actionable.

## The lane this census proposes

**Nothing in this PR writes.** What follows is a spec and a ruling request, in the order the rows argue
for. No lane below is started here.

### Lane A — the Pokémon bare card number (~22,780 unknown-key rows, ~89k pool-wide)

The largest single *mechanical* win in this census, and it is not a setKey change at all. The parser
reads `#N`; Pokémon writes `TG30`, `148/147`, `076`. Every one of these rows is already sitting on a
`player-<name>` pseudo-number that CF-UNPARSED-IS-NOT-UNNUMBERED ruled is blank on the stored side —
so a re-derivation that reads the real number classifies **IMPROVE**, not `changed:cardNumber`, and the
**running fleet writes it with no new lane**. This is a parser change plus a fleet pass, not a lane.

*Spec only. Needs: a ruling that `<letters><digits>` and `N/M` are card numbers in the Pokémon
vertical, and fixed-point tests that `148/147 → 148` does not collide with a serial `/147`.*

### Lane B — hand the 186k to the checklist-gap program (no new lane at all)

The "reads the product, no checklist" bucket is already that program's population; this census just
supplies it from the other side, ranked. `2026|leaf`, `2025|upper-deck`, `2025|leaf`, `2024|upper-deck`
are the top four and they are all products the parser **already reads correctly**. No code, no ruling
— an acquisition priority.

### Lane C — vocabulary, and the ruling it needs first

The 500k vocabulary bucket has **no head worth a largest-first pass**: the top 50 keys buy 18.2% of the
sample and are ~55% Pokémon/One Piece promo lines. Before any key is added, two rulings:

1. **The collapse.** `normalizeSetKey` folds `one piece op12-legacy` onto `panini-legacy` and
   `uno elite` onto `donruss-elite`. Adding rules on top of a function that already collapses unrelated
   products would pool One Piece sales into Panini pools. **This is a HALT** — the collapse is a
   pre-existing defect (`normalizeSetKey collapses products`) and it must be ruled on before, not
   during, a vocabulary pass.
2. **The vertical.** ~55% of the tail is Pokémon/One Piece promos, and
   CF-POKEMON-TCG-EXPANSION-PARKED parks that vertical behind the sport→vertical refactor.

**No vocabulary entries are added in this PR.** The task permitted adding them if the change were pure
vocabulary; it is not — it is blocked behind a collapse defect and a parked vertical, and adding keys
under those two conditions would be writing rules onto a function that mis-files them.

## What this PR contains

- `backend/scripts/census-unknown-setkey.cjs` — the census. Read-only, runner-dispatchable with
  `apply=false`, budget-bound, sharding **opt-in** via `lib/runner-shard-scope.cjs` so an inherited
  `slot=0 slots=16` sweeps every row instead of silently censusing a sixteenth (#1756).
- `backend/tests/censusUnknownSetKey.test.ts` — 23 pins on the population predicate, the refusal
  refinements, the spelling extractor and the shard function.
- `.github/workflows/backfill-runner.yml` — whitelist entry, a gate that **refuses `apply=true`**, its
  own `CENSUS_OUT` directory and its own artifact upload.
- this report.

## Reproducing this

```bash
COSMOS_CONNECTION_STRING="$(az webapp config appsettings list --name HobbyIQ3 \
  --resource-group rg-hobbyiq-dev \
  --query "[?name=='COSMOS_CONNECTION_STRING'].value" -o tsv)" \
node backend/scripts/census-unknown-setkey.cjs --limit=60000 --minutes=25 --top=50 \
  --json=/tmp/unknown-setkey-census/census.json
```

Or through the runner: `script=census-unknown-setkey`, **`apply=false`** (any other value is refused
by a gate). Sharding is opt-in — pass `SHARD=true` with `slot=0` to fan out, or the run sweeps
everything.

The script stops on `--limit` or its time box, whichever comes first, and says which in its banner. It
deliberately does **not** print the fleet relaunch marker: a sampling census that stops early has not
left work undone, and re-dispatching it would draw a second sample rather than finish a first.
