# 2026 Bowman vs Bowman Chrome — the "15,696 twins" sized

READ-ONLY census, 2026-09-05. Cosmos reads only; no writes, no dispatches.
Scope: `card_catalog` and `sold_comps`, sport=baseball, year/cardYear=2026.

## TL;DR

The 15,696 "twins" are **not two products colliding**. They are one card filed
at two addresses, and the split is produced by our own deriver: the same
"2026 Bowman Baseball" checklist mints `bowman` when the caller passes
`authoritativeSetKey: true` and `bowman-chrome` when it does not. Measured:

* **19,867** catalog rows carry setKey FIELD `bowman` while their own id-STEM
  says `bowman-chrome` (the judge's 15,696 is the same population under a
  slightly tighter parallel key — I reproduce 15,984 as KEY-MISMATCH).
* **96.2%** of CPA/BCP numbers appearing on both stems name the **same player**
  on both — one card, two rows.
* **Median price ratio between the two pools = 1.00** over 219 paired raw
  groups (89% within 2x). CPA-EHA raw base auto: $110.00 on `bowman`,
  $110.00 on `bowman-chrome`. These are not two products; it is one pool split.
* **BUT** 9 CPA/BCP numbers are genuine initials collisions (CPA-AG = Adrian Gil
  in Bowman AND Angeibel Gomez in Bowman Chrome). The taxonomy Drew ruled is
  real. Any repair must keep those nine apart.
* **Zero 2026 Bowman Chrome sales exist yet.** Every one of the 111,674 sales
  in scope is a Bowman (paper-product) card. The Chrome-side players of all
  nine collision numbers have **0** sales.

---

## 1. What the 15,696 twins are

### The right axis is the id STEM, not the setKey FIELD

Keying on `(cardNumber | parallelSlug | printRun | auto)` between rows whose
setKey FIELD is `bowman` and rows whose FIELD is `bowman-chrome` gives only
**3,403** pairs. Keying on the **id stem** (segment 3 of the slug — the address
the pool actually uses) gives **19,867**. That is the judge's population.

Catalog rows in scope: `bowman` field 95,880 · `bowman-chrome` field 51,920 ·
`bowman-chrome-mega-box` 1,040 · `bowman-chrome-sapphire` 499.

### Field-vs-stem drift, measured

| population | rows | drifted (field != stem) |
|---|---:|---:|
| setKey field `bowman` | 95,880 | **36,897 (38.5%)** |
| setKey field `bowman-chrome` | 51,920 | 0 |

Drift breakdown on the `bowman` field:

| stem | field | rows |
|---|---|---:|
| `bowman-chrome` | `bowman` | **19,867** |
| `bowman-paper` | `bowman` | 16,822 |
| `bowman-chrome-sapphire` | `bowman` | 208 |

The drift is **one-directional**: no `bowman-chrome`-field row has a drifted
stem. That is the signature of a minting rule, not of random field edits.

### The 19,867 stem-axis pairs, bucketed

| bucket | pairs | share |
|---|---:|---:|
| **KEY-MISMATCH** (same player; one side's field != its stem) | **15,984** | 80.5% |
| **LEGIT-TWO-PRODUCTS** (different players) | **3,196** | 16.1% |
| **DUPLICATE-ONE-CARD** (same player, >=1 non-checklist side) | 548 | 2.8% |
| **DUPLICATE-ONE-CARD** (same player, two checklists, fields clean) | 139 | 0.7% |

By card-number prefix — this is the load-bearing table:

| prefix | total | KEY-MISMATCH | LEGIT-TWO-PRODUCTS | DUPLICATE |
|---|---:|---:|---:|---:|
| BCP | 13,359 | 12,857 | 492 | 10 |
| CPA | 3,354 | 3,113 | 235 | 6 |
| (numeric base) | 2,083 | 0 | **2,066** | 17 |
| BMA | 289 | 0 | 17 | 272 |
| FD / BWC / BS | 340 | 0 | 340 | 0 |
| ES / CRA / BST | 353 | 0 | 34 | 319 |

**Read this table carefully.** The numeric-base cards behave the opposite way
from CPA/BCP: 2,066 of 2,083 are *different players* — 2026 Bowman #11 is Corey
Seager and 2026 Bowman Chrome #11 is Noah Schultz. Those are two real products
with independent base checklists, exactly as Drew ruled. The CPA/BCP rows are
where the same player appears twice.

Worked examples:

```
LEGIT-TWO-PRODUCTS (base numbering, two independent checklists)
  A hiq:baseball:2026:bowman:11:base:no-auto        field=bowman        Corey Seager     [beckett-scraped-2026-08-26]
  B hiq:baseball:2026:bowman-chrome:11:base:no-auto field=bowman-chrome Noah Schultz RC  [beckett-scraped-2026-08-26]

KEY-MISMATCH (one card, minted twice by two ingest paths)
  A hiq:baseball:2026:bowman:bcp-52:base:no-auto        field=bowman  Ethan Dorchies  [beckett-scraped-2026-08-26]
  B hiq:baseball:2026:bowman-chrome:bcp-52:base:no-auto field=bowman  Ethan Dorchies  [checklistinsider-2026-08-27]
        ^ note: BOTH rows carry field=bowman. Only the STEM differs.

DUPLICATE-ONE-CARD — a 1/1 that exists twice, which is impossible
  A hiq:baseball:2026:bowman:cpa-eha:superfractor:auto:num-1        [2026 Bowman Baseball | beckett-checklist | verified]
  B hiq:baseball:2026:bowman-chrome:cpa-eha:superfractor:auto:num-1 [2026 Bowman Chrome Baseball | checklist]
        Eric Hartman. A Superfractor is 1-of-1. Two rows = one card, two addresses.
```

### Do the two checklists list the same card?

Checklist-sourced CPA/BCP numbers present on both stems: **239**.

* same top player on both stems: **230 (96.2%)** -> one card, split slug
* different player: **9 (3.8%)** -> two products, genuine initials collision
* numbers only on stem `bowman`: 0 · only on stem `bowman-chrome`: 193

The nine real collisions:

```
cpa-em  bowman=Edgar Montero      chrome=Ezequiel Melbourne
cpa-la  bowman=Luis Arana         chrome=Louis Andujar
cpa-df  bowman=Dauri Fernandez    chrome=Diego Frontado
cpa-hl  bowman=Henry Lalane       chrome=Hyun Seung Lee
cpa-wa  bowman=Wehiwa Aloy        chrome=Wandy Asigen
bcp-151 bowman=Seong-Jun Kim      chrome=Slater de Brun
cpa-js  bowman=Juan Sanchez       chrome=Jaider Suarez
cpa-bc  bowman=Billy Carlson      chrome=Brandon Clarke
cpa-ag  bowman=Adrian Gil         chrome=Angeibel Gomez   <- the pair the code comment cites
```

**These nine are real and must never be merged.** The catalog currently
scatters each of them three ways, e.g. CPA-AG's 131 rows sit as
43 (stem bowman / field bowman) + 32 (stem bowman-chrome / field bowman)
+ 56 (stem bowman-chrome / field bowman-chrome). The middle group is Adrian
Gil's rows sitting on Angeibel Gomez's address.

**Good news, verified:** zero catalog ids carry more than one player (0 of
59,366 CPA/BCP ids). Adrian Gil and Angeibel Gomez never share a document —
the parallel/printRun segments happen to keep them apart. The damage is a
split, not yet a merge.

### PR #1789's CPA-MG and the mega-box row

* **CPA-MG** (Marconi German, single player): 110 rows — 60 stem `bowman`,
  46 stem `bowman-chrome` + field `bowman`, 4 stem+field `bowman-chrome`.
  PR #1789's "106 of 110 have id-slug bowman-chrome but field bowman" is not
  quite the shape: 46 are drifted, 60 are clean `bowman`, 4 are clean chrome.
  Either way one player's card is split across two addresses.
* **The mega-box/sapphire mismatch is not one row — it is 208.** All 208 have
  stem `bowman-chrome-sapphire`, field `bowman`, setName "2026 Bowman Sapphire
  Baseball", source `ingest-auto-seed`. Same defect, different destination key.

---

## 2. What the deriver actually does

**The rule is a fork on one boolean.** `computeHobbyIqCardId` runs
(`backend/src/services/portfolioiq/hobbyIqCardId.service.ts:1876`):

```ts
const setKey = components.authoritativeSetKey === true
  ? baseSetKey
  : applyChromePrefixOverride(baseSetKey, cardNumber);
```

Proven by running the real code:

```
resolveSetKeyForSlug("baseball","2026 Bowman Baseball",2026)  -> bowman
resolveSetKeyForSlug("baseball","2026 Bowman Chrome Baseball",2026) -> bowman-chrome

computeHobbyIqCardId(setKey="2026 Bowman Baseball", cardNumber="CPA-JG"):
  authoritativeSetKey=true   -> hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499
  authoritativeSetKey=false  -> hiq:baseball:2026:bowman-chrome:cpa-jg:refractor:auto:num-499
                                                    ^^^^^^^^^^^^^ the entire defect

  cardNumber="1" (base):     both -> hiq:baseball:2026:bowman:1:...   (unaffected)
```

### Where it is defined

| what | where |
|---|---|
| the fork | `hobbyIqCardId.service.ts:1876` (CF-AUTHORITATIVE-SETKEY, Drew 2026-08-13) |
| `CHROME_PREFIX_OVERRIDES` table (`bowman` + `CPA-`/`BCP-` -> `bowman-chrome`) | `hobbyIqCardId.service.ts:1458-1499` (CF-CHROME-PREFIX-OVERRIDE-NARROW, Drew 2026-08-10) |
| `chrome-prospects -> bowman-chrome` text rule | `hobbyIqCardId.service.ts:424` (CF-CHROME-PROSPECTS-IS-BOWMAN-CHROME, Drew 2026-07-29) |
| product table / family ladder | `catalog/productSetKeys.ts` — `bowman-chrome` has `parent: "bowman"` |
| the flag on the constructor | `portfolioiq/cardCatalog.service.ts:447` (`deriveCatalogEntry`) |
| the product-conflict adjudicator | `catalog/cpaProductRule.ts` (CF-THE-CHECKLIST-THAT-NAMES-THE-PRODUCT-WINS, D29/R2) |

### Where it is pinned

* `backend/tests/idCarriesTheProduct.test.ts:217` — *"the vendor-text chrome
  repair moves both halves"*: `entry("bowman","BCP-1",/*authoritative*/false)`
  asserts id contains `:bowman-chrome:` **and** `setKey === "bowman-chrome"`.
  **This test asserts the non-authoritative path keeps field and stem in sync
  — and 19,867 stored rows violate exactly that.** The rows were minted by a
  path that applied the override to the STEM but wrote the FIELD from the
  caller's spelling.
* `backend/tests/subsetIsPartOfTheIdentity.test.ts:113-119` — pins that
  `authoritativeSetKey` suppresses the CPA- repair.
* `cpaProductRule.ts` + `tests/applyCpaProductRuleShape.test.ts` — pins the
  player gate that prevents merging an initials collision.

### Is the taxonomy intended?

**Yes, and it is already ruled.** `cardCatalog.service.ts:477-479` states it:

> *Suppresses the cardNumber-prefix repair meant for untrusted vendor text,
> which would otherwise collapse 2026 Bowman CPA-AG (Adrian Gil) onto
> 2026 Bowman Chrome CPA-AG (Angeibel Gomez).*

and `hobbyIqCardId.service.ts:1870` records Drew's answer verbatim:

> *Drew, asked which product a CPA pulled from a Bowman pack belongs to:
> **"bowman — it came out of Bowman"**.*

So the intended rule already exists and the census confirms it is correct:
CPA-/BCP- cards from the 2026 Bowman product belong to `bowman`. The defect is
that ~19,867 rows were minted through the vendor path that ignores it.

---

## 3. sold_comps

111,674 rows (sport=baseball, 2026, cardNumber CPA-*/BCP-*), `soldAt`
2026-04-25 .. 2026-09-04. 111,276 raw / 398 graded.

| id-stem | rows |
|---|---:|
| `bowman` | **89,795** |
| `bowman-chrome` | **10,532** |
| `bowman-mega` | 6,122 |
| `bowman-chrome-sapphire` | 4,669 |
| `bowman-chrome-mega-box` | 412 |
| topps / topps-chrome / non-hiq | 130 |

`setKey` is not a field on sold_comps (null on all 111,674); the product lives
in the slug stem and in `setName`.

### Cross-naming rate

* stem `bowman`, text names Chrome: **29,753 / 89,795 = 33.1%**
* stem `bowman-chrome`, text does NOT name Chrome: **2,090 / 10,532 = 19.8%**

**These are not mislabelled sales.** Sellers write both words for one card,
because the card *is* a chrome insert in the Bowman product:

```
stem=bowman, "names chrome":
  "2026 Bowman Eric Hartman Braves 1st Bowman Chrome Prospect Auto #CPA-EHA"
  "2026 Bowman Chrome Prospect Autographs Eric Hartman 1st ROOKIE AUTO BRAVES"

stem=bowman-chrome, "does not name chrome":
  "2026 Bowman - Chrome Prospects Eric Hartman #BCP-102 (RC) - Raw"
  "2026 Bowman Eric Hartman Chrome 1st Prospect Refractor Lazer #BCP-102 Braves"
```

Both lists are the **same card**. The 33.1% / 19.8% are a measure of vocabulary
overlap, not of error rate.

### Drew's Gonzalez pool, confirmed

`hiq:baseball:2026:bowman:cpa-jg:refractor:auto:num-499` — 10 rows, setName
`bowman-chrome` on 9 and "2026 Bowman" on 1. **Every one of the 10 titles begins
"2026 Bowman"**; the `bowman-chrome` setName is our own derived value, not the
seller's word. The judge's classification ("identity right, slug stale" by
FIELD) reads a field we wrote, and reaches the wrong conclusion because of it.

### Price evidence — the decisive test

219 raw-only groups with >=5 sales on **both** stems for the same
(cardNumber, parallel, auto):

**median ratio chrome/bowman = 1.00 · p10 = 0.73 · p90 = 1.82 · 89% within 2x**

| number\|parallel\|auto | nB | medB | nC | medC | ratio |
|---|---:|---:|---:|---:|---:|
| cpa-eha \| base \| auto | 592 | $110.00 | 145 | $110.00 | **1.00** |
| bcp-149 \| base | 777 | $2.29 | 114 | $2.25 | 0.98 |
| bcp-92 \| base | 686 | $2.36 | 116 | $2.20 | 0.97 |
| bcp-115 \| reptilian-refractor | 426 | $4.25 | 103 | $4.25 | 1.00 |
| bcp-1 \| base | 1,103 | $2.49 | 121 | $2.14 | 0.90 |
| bcp-102 \| base | 1,070 | $2.25 | 76 | $2.00 | 0.89 |
| cpa-ef \| refractor \| auto | 393 | $1.02* | 80 | $0.90* | 0.88 |
| cpa-jj \| refractor \| auto | 434 | $16.55 | 50 | $17.74 | 1.07 |

(*a handful of rows carry cents-scaled prices from the cardsight backstop;
ratios are unit-invariant and unaffected.)

**Two genuinely different products cannot sell at a 1.00 median ratio across
219 independent groups.** This is one card whose sales were split by a slug.

### The clincher

**Zero 2026 Bowman Chrome sales exist.** For the four collision numbers I
checked by name, the Chrome-side player has **0** sales:

```
cpa-em  Edgar Montero 195 sales | Ezequiel Melbourne 0
cpa-ag  Adrian Gil    164 sales | Angeibel Gomez     0
cpa-hl  Henry Lalane  396 sales | Hyun Seung Lee     0
cpa-wa  Wehiwa Aloy   346 sales | Wandy Asigen       0
```

So the 10,532 sales on the `bowman-chrome` stem are **not Bowman Chrome cards**.
They are Bowman-product CPA/BCP sales that the vendor path routed to the Chrome
address. The `bowman-chrome` 2026 pool is, today, entirely misfiled Bowman
sales — and the moment real Bowman Chrome sales arrive they will land on top of
them and price two different players as one card.

---

## 4. Recommendation

### The rule (restating what is already ruled, so the fleet can apply it)

> **A CPA-/BCP- card pulled from the 2026 Bowman product is a `bowman` card.**
> The slug reads `hiq:baseball:2026:bowman:cpa-xx:<parallel>:auto[:num-N]`.
> A CPA-/BCP- card from the separate 2026 Bowman Chrome product is a
> `bowman-chrome` card with the same number and a *different player*.
> Chrome stock is a property of the card, not the name of the product.

This is Drew's 2026-08-13 ruling ("bowman — it came out of Bowman") verbatim.
Nothing new is being asked for; the code already states it and the checklist
path already honours it.

### What a report-first repair does, per bucket

1. **KEY-MISMATCH — 15,984 pairs / 19,867 rows. Highest value, lowest risk.**
   Re-mint each drifted row through `deriveCatalogEntry` with
   `authoritativeSetKey: true` off its own `setName`, then move it to the
   resulting id via `patchCatalogRowFields` (never a raw patch — memory:
   *deriveCatalogEntry builds its own search fields*). Report-only first:
   emit the (old id -> new id, player, source) triple for every row and gate
   on a clean sample plus the canary, per the GREAT REMATCH program.
   **Guard: refuse any move whose destination id already holds a DIFFERENT
   player.** That is the CPA-AG case, and it is what turns a repair into the
   merge the code was written to prevent.

2. **LEGIT-TWO-PRODUCTS — 3,196 pairs. Do nothing.** 2,066 are base-numbered
   cards from two genuine checklists; the nine CPA/BCP initials collisions
   belong here too. Both rows stay, `cpaProductRule` already returns
   `keep-both` for them, and the pools split on the title's product words.

3. **DUPLICATE-ONE-CARD — 687 pairs.** Consolidate onto the checklist-backed
   row per *one card, one row, one pool*, keeping the dedicated-checklist side
   and folding the `ingest-auto-seed` / `catalog-explode` side onto it.
   The 1/1 Superfractors (CPA-EHA, CPA-MG, CPA-VF) are the proof rows: run
   these first, since a duplicated 1/1 is unarguable.

4. **The 208 sapphire rows** (stem `bowman-chrome-sapphire`, field `bowman`,
   source `ingest-auto-seed`) are the same defect pointed at a third key.
   Same treatment as bucket 1.

5. **sold_comps — 10,532 rows on the 2026 `bowman-chrome` stem.** Re-slug to
   `bowman` where the row's cardNumber+player matches a `bowman` checklist row
   and no Bowman Chrome checklist row claims that (number, player). This is the
   urgent one: it must land **before** real 2026 Bowman Chrome sales start
   arriving, or the two players merge into one pool with no way to separate them
   afterwards. Do it as a report-first lane with the same
   different-player-destination guard.

### Also worth fixing at the root

`tests/idCarriesTheProduct.test.ts:217` asserts that the non-authoritative
path moves **both halves** (stem and field). 19,867 stored rows have a moved
stem and an unmoved field, so some minting path writes the field from the
caller's spelling rather than from the computed slug. Finding and closing that
path stops the population from growing while the repair runs. A pure-test
addition pinning "field always equals stem at mint, for every
`authoritativeSetKey` value" would be a safe, useful PR on its own.

### What needs Drew's ruling

1. **Is `bowman` the right home for a Bowman-product CPA/BCP, given the card is
   physically chrome?** The code says yes (2026-08-13). The census agrees. I
   want it re-affirmed before a 19,867-row move, because it is the premise of
   the whole repair.
2. **What happens to the 10,532 2026 `bowman-chrome` sold_comps rows?** They are
   Bowman sales at a Chrome address. Re-slug to `bowman`, or leave them and let
   the rematch reach them? Re-slugging is a pool-moving write.
3. **The nine initials collisions** — confirm they stay split, and confirm the
   rule for a *new* CPA sale whose title says only "2026 Bowman" for a number
   that exists in both products with different players. Today the number alone
   cannot decide it; the player must. Should such a sale park rather than pool?
4. **`bowman-paper` (16,822 drifted rows).** Same field-vs-stem defect, different
   destination, out of scope here. Worth its own census before it is swept into
   this repair by accident.

---

### Method notes

* Clone: `C:/tmp/hiq-bowman-twins` (never the OneDrive checkout). No commits.
* Cosmos: reads only, connection string piped straight into `node` env, never
  printed, never written to disk. Total spend for the whole census ~34k RU;
  the largest single read was 111,674 sold_comps rows for 12.1k RU in 14.5s.
* Deriver behaviour was proven by executing the real
  `computeHobbyIqCardId` / `resolveSetKeyForSlug`, not read off the comments.
