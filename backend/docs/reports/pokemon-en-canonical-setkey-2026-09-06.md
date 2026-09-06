# The English Pokemon setKey is the tcgdex code — census + rekey plan

**Ruling (Drew, 2026-09-06).** For an English Pokemon product the canonical
`setKey` is the tcgdex set CODE (`sv08-5` for Prismatic Evolutions), and the
normalized English NAME (`prismatic-evolutions`,
`pokemon-scarlet-violet-prismatic-evolutions`) is an ALIAS of that code. This
is the English half of CF-THE-JAPANESE-CODE-IS-THE-KEY (2026-09-01), which
ruled the same way for the bare Japanese codes `sv2a` / `sv8a` / `s12a`, and it
carries the same standing doctrine: **a ruled key must be a `normalizeSetKey`
fixed point.**

Read-only throughout. Nothing in this document was written to Cosmos.

---

## 1. What was wrong, measured on this branch before the fix

### One product, two spellings, both fixed points

`pokemonSetAliases.ts` has carried the full English vocabulary since 2026-08-16
— 1,497 aliases over 214 sets, generated from tcgdex and already the spelling
`card_catalog` is keyed by. Three call sites read it. **`normalizeSetKey` was
not one of them**, and `normalizeSetKey` is the function every stored key is
re-derived through, the one the slug guard asks, and the one the Great Rematch
asks.

The consequence measured directly: **832 of the 1,497 alias keys survived
`normalizeSetKey` unchanged.** Both halves of the pool could name themselves
and neither could name the other:

| input | vendor path (`resolveSetKeyForSlug`) | title path (`inferSetKeyFromTitle`) | `normalizeSetKey` |
|---|---|---|---|
| Prismatic Evolutions | `sv08-5` | `sv08-5` | `prismatic-evolutions` |
| Surging Sparks | `2025-pokemon-surging-sparks` | `sv08` | `surging-sparks` |
| Base Set | `2025-pokemon-base-set` | `base1` | `base-set` |

One card, two rows, a split pool, a wrong FMV — CF-ONE-CARD-ONE-ROW-ONE-POOL.

### 35 of those names were not merely split — they were wrong

187 of the 188 patterns in the sports vocabulary are unanchored, and a bare
colour or theme word was enough for a Panini rule to claim a Pokemon set
outright:

```
obsidian-flames    -> panini-obsidian    (should be sv03)
crown-zenith       -> panini-zenith      (should be swsh12-5)
ancient-origins    -> panini-origins     (should be xy7)
firered-leafgreen  -> leaf               (should be ex6)
```

The same defect existed one layer up, in the TITLE deriver, and it was worse
there because it fired on titles that say the word "Pokemon" in so many words:
`inferSetKeyFromTitle("2023 Pokemon Obsidian Flames Charizard ex 125/197")`
returned **"Panini Obsidian"**. The TCG guard that would have resolved it sat
*below* forty-odd sports product rules, several of which read a bare word with
no brand beside it (`\bobsidian\b`, `\bzenith\b`, `\borigins\b`).

A wrong key is worse than no key: it passes the slug guard and fuses a Pokemon
sale into another brand's pool.

### The gate the fix needed, and the test that found it

The first cut put the English vocabulary into `normalizeSetKey` unconditionally
and `pokemonSetAliases.test.ts` went red on its own standing guard —
"aliases do NOT leak into other sports":

```
slugFor("151", { sport: "baseball" })
  expected  hiq:baseball:2023:151:199:base:no-auto
  received  hiq:baseball:2023:sv03-5:199:base:no-auto
```

That guard is right and the fix was wrong. The English table contains keys that
are ordinary words in a sports set name — `151`, `jungle`, `dragon`,
`base-set` — so applying it to a baseball row is the mirror image of the
cross-vertical damage it repairs. `normalizeSetKey` therefore takes an
**optional `sport`**: its absence means "no vertical asserted", never
"Pokemon", and only `sport === "pokemon"` consults the NAME side of the ruling.

The CODE side stays unconditional, and that asymmetry is deliberate: a stored
pool key of `sv08-5` must survive a sport-blind re-derivation, which is what
makes the ruled key a fixed point in the sense the doctrine means.

---

## 2. The census (read-only, `sport=pokemon`)

| population | rows |
|---|---|
| `card_catalog` rows under NAME keys | **50,269** in 281 cells |
| `sold_comps` rows under NAME keys | **3,866** in 26 cells |
| `sold_comps` rows under `unknown` | **415,221** |
| …of which the TITLE names an EN expansion | **~242,302** (58.4% of a 40,000-row sample) |

The `unknown` bucket is by far the largest population and it is **not** a rekey
problem: those rows name no product to rename. They need the title deriver,
which is exactly what section 4 hands them.

### Top catalog cells (name key → code)

| rows | year | name key | code |
|---|---|---|---|
| 715 | 2023 | `151` | `sv03-5` |
| 630 | 2002 | `2002-pokemon-legendary-collection` | `lc` |
| 576 | 2026 | `ascended-heroes` | `me02-5` |
| 568 | 2025 | `prismatic-evolutions` | `sv08-5` |
| 532 | 2023 | `paldea-evolved` | `sv02` |
| 519 | 2024 | `paldean-fates` | `sv04-5` |
| 511 | 2025 | `white-flare` | `sv10-5w` |
| 504 | 2023 | `paradox-rift` | `sv04` |
| 503 | 2025 | `2025-pokemon-scarlet-violet-prismatic-evolutions` | `sv08-5` |
| 499 | 2025 | `black-bolt` | `sv10-5b` |
| 496 | 2023 | `scarlet-violet` | `sv01` |
| 495 | 2002 | `2002-pokemon-expedition-base-set` | `ecard1` |
| 488 | 1999 | `1999-pokemon-jungle` | `base2` |
| 488 | 2021 | `fusion-strike` | `swsh8` |
| 485 | 2025 | `mega-evolution` | `me01` |
| 483 | 2024 | `surging-sparks` | `sv08` |
| 466 | 2025 | `destined-rivals` | `sv10` |
| 462 | 2000 | `2000-pokemon-team-rocket` | `base5` |
| 461 | 2003 | `aquapolis` | `ecard2` |
| 456 | 2002 | `expedition-base-set` | `ecard1` |

### Every pool cell (26)

The pool's largest cells are the **cross-vertical wrong keys** — Pokemon sales
sitting in Panini and Leaf pools today.

| rows | year | stored key | code |
|---|---|---|---|
| 1,798 | 2023 | `panini-obsidian` | `sv03` |
| 955 | 2017 | `xy` | `xy1` |
| 563 | 2023 | `panini-zenith` | **ambiguous** |
| 230 | 2015 | `panini-origins` | `xy7` |
| 83 | 2026 | `2026-pokemon-mega-evolution-pitch-black` | `me05` |
| 76 | 2026 | `2026-pokemon-mega-evolution-chaos-rising` | `me04` |
| 46 | 2025 | `2025-pokemon-mega-evolution-phantasmal-flames` | `me02` |
| 36 | 2004 | `leaf` | `ex6` |
| 19 | 2026 | `2026-pokemon-mega-evolution-perfect-order` | `me03` |
| 13 | 2022 | `panini-zenith` | **ambiguous** |
| 9 | 2021 | `panini-zenith` | **ambiguous** |
| 7 | 2016 | `xy` | `xy1` |
| 6 | 2016 | `panini-origins` | `xy7` |
| 4 | 1999 | `1999-pokemon-base-set` | `base1` |
| 4 | 1999 | `1999-pokemon-jungle` | `base2` |
| 3 | 2026 | `2026-pokemon-mega-evolution-ascended-heroes` | `me02-5` |
| 3 | 2025 | `panini-obsidian` | `sv03` |
| 2 | 1999 | `1999-pokemon-fossil` | `base3` |
| 2 | 2016 | `2016-pokemon-xy-evolutions` | `xy12` |
| 1 | 2013 | `xy` | `xy1` |
| 1 | 2024 | `panini-obsidian` | `sv03` |
| 1 | 2023 | `2023-pokemon-scarlet-violet-151` | `sv03-5` |
| 1 | 2014 | `xy` | `xy1` |
| 1 | 2019 | `panini-obsidian` | `sv03` |
| 1 | 2015 | `panini-origins` | `xy7` |
| 1 | 2014 | `panini-origins` | `xy7` |

**`panini-zenith` is the one ambiguous destination in the whole table.** Both
Crown Zenith (`swsh12-5`) and its Galarian Gallery subset (`swsh12-5gg`)
collapse onto it, so a stored `panini-zenith` row cannot say which of the two
products it is. It is therefore a REMATCH cell, not a rename — see §4.

### Top `unknown` cells (title names an EN expansion)

| rows | year | code |
|---|---|---|
| 3,169 | 2026 | `me05` |
| 1,631 | 2026 | `me04` |
| 1,417 | 2025 | `sv08-5` |
| 1,282 | 2026 | `me03` |
| 755 | 2019 | `sm12` |
| 669 | 2025 | `me02` |
| 665 | 2000 | `neo1` |
| 427 | 2016 | `xy12` |
| 416 | 2016 | `xy1` |
| 403 | 2020 | `swsh3` |

---

## 3. The rekey plan (catalog first, then pool)

`rekey-product-setkey` is **report-first**: without `BACKFILL_APPLY=true`
nothing is written. Each cell is dispatched twice — `mode=catalog`, then
`mode=pool` — because the catalog row must exist at the destination before the
pool is pointed at it.

`mode=pool` **requires** a year: `1997/base4` is the Japanese Rocket Gang set
and `2000/base4` is English Base Set 2, so a pool sweep with no year axis would
take both.

**Canary order — smallest cell first, then the largest.** The smallest cell
proves the lane end to end at a blast radius of one row; the largest is the one
worth the proof.

| # | year | from | to | pool rows |
|---|---|---|---|---|
| 1 (canary) | 2013 | `xy` | `xy1` | 1 |
| 2 (largest) | 2023 | `panini-obsidian` | `sv03` | 1,798 |
| 3 | 2017 | `xy` | `xy1` | 955 |
| 4 | 2015 | `panini-origins` | `xy7` | 230 |
| 5 | 2026 | `2026-pokemon-mega-evolution-pitch-black` | `me05` | 83 |
| 6 | 2026 | `2026-pokemon-mega-evolution-chaos-rising` | `me04` | 76 |
| … | | remaining 17 cells, descending | | |

Every dispatch carries `sources` EMPTY and `parents_only=false`.

```
# 1. CANARY — smallest cell, 1 row. Catalog first, then pool.
gh workflow run "Backfill Runner" \
  -f script=rekey-product-setkey -f mode=catalog \
  -f sport=pokemon -f setkey_like=xy -f titles=xy1 \
  -f years=2013 -f sources= -f parents_only=false -f apply=false

gh workflow run "Backfill Runner" \
  -f script=rekey-product-setkey -f mode=pool \
  -f sport=pokemon -f setkey_like=xy -f titles=xy1 \
  -f years=2013 -f sources= -f parents_only=false -f apply=false

# 2. LARGEST — 1,798 rows, the cross-vertical Panini pool.
gh workflow run "Backfill Runner" \
  -f script=rekey-product-setkey -f mode=catalog \
  -f sport=pokemon -f setkey_like=panini-obsidian -f titles=sv03 \
  -f years=2023 -f sources= -f parents_only=false -f apply=false

gh workflow run "Backfill Runner" \
  -f script=rekey-product-setkey -f mode=pool \
  -f sport=pokemon -f setkey_like=panini-obsidian -f titles=sv03 \
  -f years=2023 -f sources= -f parents_only=false -f apply=false
```

Re-run each with `apply=true` only after reading the report and confirming the
row count matches this census.

> **Why these cells need the rekey lane and cannot be fixed by re-derivation
> alone.** `panini-obsidian`, `panini-origins`, `leaf` and `xy` are not
> misspellings of a Pokemon set — they are the sports vocabulary's own real
> keys, which the old collapse happened to send Pokemon rows into. The ruling
> deliberately does NOT rewrite them even under `sport=pokemon`
> (`normalizeSetKey("panini-obsidian", "pokemon") === "panini-obsidian"`),
> because they are genuine Panini and Leaf products and rewriting them would
> be the cross-vertical damage running in reverse. The code fix stops NEW rows
> landing there; these stored rows need the explicit, scoped rename below.
>
> That is also why the scope is `sport=pokemon` plus a single `years=` value,
> and why the report must be read before the apply: a Panini football row
> appearing in the report means the scope is wrong, not that the rename is.
>
> `xy` is the one cell that re-derivation WOULD move
> (`normalizeSetKey("xy", "pokemon") === "xy1"`), so its rows may also be
> carried by a rematch pass; the rekey lane is the deterministic route.

---

## 4. The `unknown` cells are a REMATCH scope, not a rename

~242,302 pool rows carry `setKey: unknown` and a title that names an English
expansion. A rename cannot move them: `unknown` names no product, so there is
no `setkey_like` that selects the right rows and no single destination.

They need the **title deriver** — which this PR fixes — and the Great Rematch's
own `scope=improve` arm, where `unknown -> a real product` is a FILL rather
than a lateral change and therefore classifies IMPROVE. The rows become fleet
fixes with no new lane, on the next rematch pass over `sport=pokemon`, in
descending cell order (`me05`, `me04`, `sv08-5`, `me03`, `sm12`, …).

The three `panini-zenith` cells (585 rows) join this scope for the same reason:
their destination is ambiguous between `swsh12-5` and `swsh12-5gg`, and only
the title can say which.

---

## 5. Sources

- Name → code aliases: `backend/src/services/catalog/pokemonSetAliases.ts` —
  generated by `scripts/fetchPokemonChecklists.cjs` from api.tcgdex.net (MIT),
  read 2026-08-16, 1,497 aliases over 214 sets.
- Code → name: `backend/src/services/catalog/pokemonSetCodes.ts` — generated by
  `scripts/fetchPokemonSetCodes.cjs` from api.tcgdex.net, read 2026-09-05,
  205 English sets + 13 English promo + 184 Japanese.

No set name is invented here. This PR decides which of the already-committed
pairs `normalizeSetKey` is allowed to act on; it adds no vocabulary
(CF-NO-SYNTHETIC-PARALLELS is not in play).
