# A maker-less `draft`/`flagship` never mints — measurement + retire lane

**Drew's ruling, 2026-09-05.** The #1715 catch-all vocabulary keys `draft` and
`flagship` are NOT products and must never be minted as a setKey. When the
deriver can read only "Draft" or "Flagship" from a title — no maker (Bowman /
Topps / Panini / …) — the identity REFUSES: parks as `identityUnverified`, no
pool, prices nothing, until a maker is read.

CF-A-MAKER-LESS-CATCH-ALL-IS-NOT-A-PRODUCT.

---

## 1. Where the keys come from

Neither word is in a vocabulary table. `grep` over `knownSetKeyPatterns()` and
`bareAliasPatterns()` finds no `draft` and no `flagship` destination. They
arrive through the **fall-through** at the end of `normalizeSetKey`, which
returns the slugified text when nothing matched:

```
buildSetName(brand=null, insert="draft")  ->  "Draft"  ->  normalizeSetKey  ->  `draft`
```

`ebayTitleParser.service.ts` builds `setName` from `brand` + `insert`. `draft`
and `prospects` are in `INSERT_TOKENS`; when a title states the insert word with
no `BRAND_TOKENS` word beside it, `buildSetName` returns the insert alone.

`flagship` reaches the same fall-through from the sales-attested minters, which
write the literal word when they can read an era but no maker. The stored rows
spell it in their own `setName`, and one of them shows exactly what went wrong:

```
hiq:ice-hockey:1966:flagship:69:base:no-auto
  setName:    "1966 Flagship Ice Hockey"
  playerName: "TOPPS TED HARRIS"          <- the maker, read as part of a person
```

The maker WAS in the title. The parse put it in the player field and then minted
an identity out of what was left. That card is a 1966 Topps, and `flagship` is
where it went to be unfindable.

## 2. The enumeration — measured, not guessed

Every candidate was checked in `card_catalog` on 2026-09-05 by
`c.setKey = @k`, then broken down by `source`. The decisive number is
**checklist-backed rows** (feedback: count by source, not row count).

| key | catalog rows | sold_comps rows | checklist-backed sources | disposition |
|---|---|---|---|---|
| `flagship` | **61** | not separately countable (see §4) | **0** | REFUSE + retire |
| `prospects` | **16** | " | **0** | REFUSE + retire |
| `chrome` | **8** | " | **0** | REFUSE + retire |
| `draft` | **6** | " | **0** | REFUSE + retire |
| `select` | 45,850 | " | ~99% (`baseballcardpedia*`) | **KEEP — real product** |
| `base` | 182 | " | `pokemon-tcg-data-scraped` | **KEEP — real product** |

Sources behind the four refused keys — no checklist among them:

```
flagship    sales-attested 31, sales-attested-graded 15, ingest-auto-seed 9,
            ingest-auto-seed-graded 3, ebay-browse 2, ebay-user-purchase 1
prospects   sales-attested 13, sales-attested-graded 3
chrome      ingest-auto-seed-graded 3, ebay-user-purchase 2, ebay-browse 2,
            user-verified 1
draft       ebay-browse 2, ebay-user-purchase 1, ebay-user-purchase-graded 1,
            ingest-auto-seed-graded 1, user-verified 1
```

Spread of `flagship` — 9 sports, 1954–2026 — is itself the argument: a real
product does not span ice-hockey 1954, golf 2024 and basketball 2025.

### Why `select` and `base` are NOT on the list

This is the point of enumerating by measurement rather than by which words
"sound generic".

- **`select`** — 45,850 catalog rows. A 400-row sample is 99% checklist sources
  (`baseballcardpedia-ladders-2026-09-04` 286, `baseballcardpedia-graded` 58,
  `baseballcardpedia` 52, `sales-attested` 4), with setNames `"2021 Select"`,
  `"2013 Select Baseball"`. Bare `select` is how a REAL product is spelled by
  the source that scraped its checklist. Refusing it would park 45,850
  checklist-backed cards. (It is also already excluded from the bare-alias tier
  for the opposite reason — the word appears in parallel language — so it
  reaches this key honestly rather than through an alias.)
- **`base`** — Pokémon Base Set. `hiq:pokemon:1999:base:16:holofoil:no-auto` is
  Zapdos, from `pokemon-tcg-data-scraped-2026-08-14`. Refusing it would park the
  most famous checklist in the hobby.

`chrome` sounds like a product and is not one here; `base` sounds like a
catch-all and is a product. Only the source counts decide.

### Keys checked and found absent

`optic`, `prizm`, `refractor`, `insert`, `update`, `series` returned **zero**
catalog rows as bare keys — already aliased to a maker key by
`bareAliasPatterns()` (`optic` → `donruss-optic`, `prizm` → `panini-prizm`) or
never minted at all. Absence from the vocabulary is not a defect; they need no
refusal.

## 3. The refusal

Two seams, matching the existing `cardnumber-unparsed` precedent:

- **`slugGuard.service.ts`** — new `SlugRejectReason` `setkey-makerless-catchall`.
  This is the gate callers SHOULD use. Distinct from
  `setkey-raw-vendor-string`, which means "a real product name in the wrong
  SHAPE"; this one means "a well-shaped key that is not a product at all".
- **`hobbyIqCardId.service.ts` / `computeHobbyIqCardId`** — throws
  `… identity is UNDERIVABLE`, so a caller that skipped the guard fails loudly
  instead of minting. The three ingest paths already wrap this in try/catch and
  skip the row.

Both are **exact-token** (`Set.has`, never a prefix or substring test), because
`bowman-draft`, `topps-chrome` and `bowman-chrome-prospects` are all real
products whose keys contain one of these words. The check runs AFTER
`resolveSetKeyForSlug`, so a resolver able to supply the maker gets its chance
first.

Vocabulary: `src/services/catalog/makerlessCatchAll.ts`.

## 4. Blast radius on the pool, and why it is not a single number

`sold_comps` cannot be counted on this axis cheaply. Both shapes were tried
against prod and **both were abandoned at 10 minutes**:

```
SELECT VALUE COUNT(1) FROM c WHERE CONTAINS(c.cardId, ':draft:')      -- unindexed
SELECT VALUE COUNT(1) FROM c WHERE c.normalizedSetKey = 'draft'       -- unindexed
```

This is the shape recorded in `census-tcg-verticals.cjs` and the one that got
run 33960686247 killed. The pool count is therefore deliberately **UNMEASURED
here, not zero** — the retire lane below measures it per-partition under a
budget, which is the access path that works.

The catalog counts above ARE exact (`c.setKey` is indexed) and are the
authoritative blast radius for the retire.

## 5. The retire/park lane — REPORT-FIRST

**91 catalog rows** (61 + 16 + 8 + 6) become a park list. Every one is
self-derived; none is checklist-backed; none is user-ruled.

Reuse **`retire-self-derived-identities.cjs`**, which already:

- carries the marker pair this needs — `identityUnverified` +
  `identityUnverifiedAt` / `identityUnverifiedBy`, with a `<field>Before` shadow
  on every write;
- treats every source behind these 91 rows as self-derived (`sales-attested`,
  `ingest-auto-seed`, `ebay-user-purchase`, `ebay-browse`, `user-verified` are
  all already in its `SD_SOURCES`);
- refuses a whole-scope write without an explicit scope, and gates its relaunch
  on the budget marker.

The one change it needs is a **scope selector for the catch-all keys** —
`SETKEYS=draft,flagship,chrome,prospects` — so the lane retires exactly the
measured rows rather than a source class. `relocate-pool-rows-by-list.cjs` is
the WRONG tool here: these rows have no correct destination to be relocated ONTO
(that is what makes them unreadable), so they park rather than move.

**Report first, always.** The lane runs `BACKFILL_APPLY` unset, prints the 91
rows grouped by (sport, year, key), and Drew reads the list before any apply.
A parked row prices nothing — which is the correct answer to "we do not know
which card this is" — and stays re-derivable from its title the moment a maker
becomes readable.

## 6. Confirmation — the acquisition cells now report UNREADABLE

Re-ran the #1825 READ+MATCH locally against prod, read-only:

```
MODE=json TOP=40 node backend/scripts/acquire-for-withheld-holdings.cjs
  12 portfolio docs, 131 holdings walked
  15 acquisition cells, 0 unaddressable holdings
  RECONCILED  YES  cells=15 matched=11 needs-source=4 tonight=11
```

The three holdings Drew named now sit in **needsSourceCells** — no manifest
entry can serve them, because no publisher ships a product called "Draft" or
"Flagship":

```
needsSourceCells
  baseball 2025  draft                    holdings=2
  baseball 2026  flagship                 holdings=1
  baseball 1996  fleer-metal-universe     holdings=1   (unrelated, real product)
  baseball 1997  skybox-metal-universe    holdings=1   (unrelated, real product)
```

And the exact-token guarantee is visible in the same run — the maker-qualified
key is served normally rather than parked:

```
tonight
  baseball 2025  bowman-draft             holdings=1
```

That contrast is the whole ruling in two lines of one report: `bowman-draft`
acquires, `draft` parks.

## 7. Pins + mutation checks

`tests/makerlessCatchAll.test.ts`, 17 tests. Both mutation checks were **run and
confirmed red**:

| mutation | result |
|---|---|
| remove the `isMakerlessCatchAllSetKey` branch in `guardSlugInputs` | 2 failed — `draft` and `flagship` mint again |
| remove the throw in `computeHobbyIqCardId` | 2 failed — returns the well-formed, meaningless `hiq:baseball:2025:draft:…` |

Negative pins hold `select` and `base` OUT of the refusal, so a later
"this word reads generic" edit has to argue with a test.
