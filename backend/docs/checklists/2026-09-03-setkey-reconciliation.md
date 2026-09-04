# A ruled key must be a fixed point — reconciling the catalog with the deriver

Follow-on to **#1689**, which measured the problem: of 6,386,510 pool rows with
no checklist-backed destination, 2,621,638 already have their checklist in
`card_catalog`, filed under a key `normalizeSetKey` no longer emits. **2,646
catalog setKeys are not fixed points of the deriver**, stranding **2,488,691
checklist rows**.

This PR gives every one of those 2,646 keys a verdict, fixes the half that is
mechanically decidable, and — the part worth reading before the rest — reports
honestly that the headline 2.6M is **not** what a `normalizeSetKey` change can
recover.

---

## 1. The reverse problem is the bigger one

The obvious reading of #1689 is "ship an alias table." Doing only that would
have made things worse.

`normalizeSetKey` also **collapses keys that name distinct products**, because
187 of its 188 vocabulary patterns are unanchored and a brand rule swallows
every product whose name contains the brand:

```
topps-triple-threads        -> topps            (81,967 checklist rows)
panini-prizm-premier-league -> panini-prizm     (82,157)
bowman-university-chrome    -> bowman           (47,014)
topps-tier-one              -> topps            (73,359)
```

Drew ruled on 2026-09-03 that product-family collapse is **forbidden**. One
card, one row, one pool: a merge does not split a pool, it *fuses* two, and a
fused pool prices both cards wrong.

**Measured split of the 2,646:**

| Verdict | Keys | Checklist rows | What it means |
|---|---:|---:|---|
| `distinct` | 686 | **2,091,770** | Two products the deriver merges. The key becomes a fixed point. |
| `catalog-key-malformed` | 1,899 | 21,051 | The **catalog** key carries a year prefix or trailing sport word (`bowman-baseball`, `2024-25-panini-prizm`). The deriver is right; the stored key is the defect. Rename-fleet work, left alone here. |
| `alias` | 24 | 229,530 | One product, two spellings. Canonical declared. |
| `needs-ruling` | 29 | 74,038 | No mechanical rule fires. **Report-only — changes nothing.** |
| `era-split` | 1 | 72,302 | `donruss`, one brand across two owners. |
| `malformed` | 7 | 0 | Raw spaced titles, no checklist behind them. |

**84% of the stranded rows are the collapse, not the aliases.**

---

## 2. What the fix actually recovers — and what it does not

The re-match measurement is read-only and compares the same question asked
twice: *is there a checklist-backed `card_catalog` row at this (sport, year,
setKey)?* — once with a dist built from the pre-change commit, once with this
one.

```
pool rows with no checklist-backed destination   6,386,802
  gained by the key rewrite                        140,319
  gained additionally by the year-aware era rule     21,571
  TOTAL                                            161,890
```

**161,890, not 2.6M.** That gap is a finding, and it is the most important
thing in this PR:

- **The 2.03M Pokemon rows are not in the 2,646 at all.** The stale spelling is
  on the **pool** side, not the catalog side. The catalog files Pokemon under
  **zero-padded official codes** — `sv08`, `sv02`, `me02-5` — while the pool
  asks for `pokemon-scarlet-violet-surging-sparks`. #1689 assumed the catalog
  key was `sv8-surging-sparks`; it is not. **Both spellings are already
  `normalizeSetKey` fixed points**, so no rewrite in this function can join
  them. It needs a code↔name map, which is its own piece of work and its own
  ruling (Drew's bare-code ruling settles which side wins: the code).

- **1,823,853 rows are "same key, wrong year"** — the key *is* checklist-backed
  for that sport, just not for that `cardYear`. That is a genuinely missing
  checklist (#1689's class E, acquisition), not vocabulary.

`nowBacked` is a **ceiling, not a promise**: a checklist unblocks a comp only if
that comp's cardNumber and parallel appear on it.

### Top cells, quoted per cell

| Cell | Pool rows | Now backed | Lands on |
|---|---:|---:|---|
| `baseball\|1987\|panini-donruss` | 21,826 | **16,306** | `donruss`, `donruss-opening-day` |
| `baseball\|1983\|panini-donruss` | 14,750 | 12,058 | `donruss`, `donruss-hof-heroes` |
| `basketball\|2025\|panini-select` | 15,749 | 10,465 | `panini-select-wnba`, `-euroleague` |
| `baseball\|1984\|panini-donruss` | 13,087 | 10,296 | `donruss`, `donruss-action-all-stars` |
| `baseball\|1985\|panini-donruss` | 9,737 | 8,618 | `donruss` |
| `baseball\|1981\|panini-donruss` | 9,772 | 8,036 | `donruss` |
| `baseball\|1986\|panini-donruss` | 15,419 | 7,976 | `donruss` |
| `baseball\|1982\|panini-donruss` | 9,283 | 7,858 | `donruss` |
| `baseball\|1991\|panini-donruss` | 6,799 | 6,279 | `donruss`, `donruss-the-rookies` |
| `baseball\|1960\|fleer` | 6,574 | 5,347 | `fleer-baseball-greats` |
| `baseball\|1997\|pinnacle` | 5,490 | 2,366 | `pinnacle-inside`, `pinnacle-certified` |
| `baseball\|1995\|donruss-studio` | 2,294 | 2,176 | `studio` |
| `baseball\|1996\|score-select` | 1,455 | 1,451 | `select-certified` |

Full 30 in `data/gap-reports/2026-09-03-setkey-rematch-measurement.json`.

---

## 3. ASSUMPTIONS — Drew has not ruled these

### Era-split dates

| Brand | Rule | Basis |
|---|---|---|
| `donruss` | bare before **2009**, `panini-donruss` from 2009 | Panini acquired Donruss-Playoff in 2009. `baseball\|1987\|donruss` holds 1,450 checklist rows; `panini-donruss` holds 0. |
| `fleer` | bare in **every** year | Upper Deck bought Fleer in 2005. Panini never owned it. |
| `skybox` | bare in **every** year | Went to Upper Deck with Fleer in 2005. |
| `score` | bare in **every** year | Panini did acquire Score in 2009 — but `panini-score` holds **zero checklist rows** against 45,061 on `score`. |
| `leaf` | bare in **every** year | Same: `panini-leaf` holds **zero rows of any kind** against 12,521 on `leaf`. |

Score and Leaf deliberately get **no** era boundary despite the same ownership
story as Donruss. Encoding one would invent a destination no checklist has ever
written, and **no synthetic products** is the stronger rule. Donruss is the only
brand where both spellings genuinely exist in the catalog (72,302 and 194,915
checklist rows), so it is the only one where a year has anything to choose
between.

### Series-as-product for Upper Deck

**Not implemented.** #1689 flagged hockey 2022-2024 `upper-deck` pool rows
against catalog `upper-deck-series-1` / `-series-2` / `-artifacts` (57,216
rows). `upper-deck-series-1` is **already a fixed point** and already spelled by
`productSetKeys.ts`, so nothing here collapses it. What remains is a *resolver*
question — does a bare `upper-deck` sale belong to Series 1, Series 2, or
neither — and that cannot be answered by a key rewrite. Left for a resolver
ruling.

---

## 4. Questions for Drew — 20 keys, 8 families, 74,038 checklist rows

`needs-ruling` is **report-only**: these keys keep today's behaviour until they
are answered. Refusing to merge sounds like the safe direction, but
`bowman-sapphire` shows why it is not — the vocabulary already carries an
explicit ruling on it ("vendors write Bowman Sapphire as shorthand for Bowman
Chrome Sapphire, so the collapse is intended, not a bug"), and a verdict that
says "I could not decide this mechanically" has no authority to overturn a
decision someone made deliberately.

| # | Family | Keys | Checklist rows | The question |
|---:|---|---|---:|---|
| 1 | **Bowman Mega Box** | `bowman-mega-box`, `bowman-mega-box-chrome`, `bowman-mega` | 39,908 | Is a Bowman Mega Box its own product, or shorthand for `bowman-chrome-mega-box`? |
| 2 | **Sapphire spelling** | `bowman-sapphire`, `bowman-sapphire-edition`, `bowman-sapphire-chrome`, `topps-sapphire-chrome`, `topps-sapphire-chrome-factory-set` | 24,199 | The vocabulary says there is no standalone Bowman Sapphire product. But 24k checklist rows are filed under these spellings — is the *catalog* wrong, or the rule? |
| 3 | **Black Diamond** | `black-diamond`, `black-diamond-rookie-edition` | 2,870 | Is 1999-2000 `black-diamond` the same product as `upper-deck-black-diamond`, and is Rookie Edition a separate set? |
| 4 | **Allen & Ginter subsets** | `topps-allen-and-ginter-chrome`, `topps-allen-and-ginters-national-die-cuts` | 1,836 | Chrome and the National die-cuts — subsets of Allen & Ginter, or products of their own? |
| 5 | **NSCC** | `bowman-nscc`, `topps-nscc-bowman-national-convention` | 1,075 | #1612 ruled Bowman NSCC its own product. Do these two spellings both mean `bowman-chrome-nscc`? |
| 6 | **Prizm draft** | `panini-prizm-perennial-draft-picks` | 3,748 | Is 2013-14 "Perennial Draft Picks" the same product as `panini-prizm-draft-picks`? |
| 7 | **eTopps** | `etopps`, `etopps-cards-that-never-were` | 204 | eTopps was a separate digital-delivery product line. Own key, or `topps`? |
| 8 | **Score family** | `scoreboard-mantle`, `scoremasters` | 197 | 1997 Scoreboard Mantle and 1989 Scoremasters — own keys, or `score`? |

The other 9 `needs-ruling` keys carry **zero** checklist rows and are listed in
the data file for completeness.

---

## 5. The mis-sported class is a sport-field defect, not a setKey one

#1689 named 90,462 rows of 2023 `panini-obsidian` / `zenith` / `origins` tagged
`sport=pokemon`. Re-measured here: **100,138 pool rows**.

They produce **no verdict**, and the reason matters: every one of those keys is
*already* a `normalizeSetKey` fixed point, and the catalog rows carrying them
hold **zero checklist rows**. The defect is the **sport field**. Drew's ruling —
a stored `pokemon` with no pokemon token counts as blank — lands on the
`tca-ebay` pokemon-default writer and a pool repair, not on the vocabulary. The
number ships in the data file so it travels with the finding.

---

## 6. A decision beats a derivation

The mechanical rules call a checklist-backed key `distinct`, which would make it
a fixed point. **Eleven of those collapses are deliberate** — somebody decided
them, wrote the rule, and pinned it with a test that states the reasoning. The
census can see that two spellings exist; it cannot see that a human already
chose between them.

```
bowman-sapphire                -> bowman-chrome-sapphire    "vendors write Bowman
bowman-mega-box                -> bowman-chrome-mega-box     Sapphire as shorthand;
bowman-mega-box-chrome         -> bowman-chrome-mega-box     there is no standalone
bowman-chrome-sapphire-edition -> bowman-chrome-sapphire     product"
bowman-draft-sapphire-edition  -> bowman-draft-sapphire
bowman-draft-sapphire-chrome   -> bowman-draft-sapphire
topps-chrome-sapphire-edition  -> topps-chrome-sapphire
flair-showcase                 -> flair                     marked DELIBERATE
panini-contenders-optic        -> panini-contenders         opticIsOneProduct
donruss-champions              -> panini-donruss            parent brand, pinned
fleer-ultra                    -> ultra                     CF-ULTRA-IS-NOT-FLEER
```

The list is **derived, not guessed**: it is every key for which a test in this
repo asserts a destination our verdict would forbid, extracted by grepping the
suite for the assertion form.

**Two keys are deliberately absent, and they are the interesting ones.**
`select-certified` and `studio` also had tests asserting a collapse, and the
evidence overturned both — 1,376 and 7,867 checklist rows against **zero** on
their destinations, in disjoint eras. A pin is evidence that a decision was
made, not proof it was right. Each of the eleven was read; each states a reason
the census cannot see. Several are also live `needs-ruling` questions — Drew
answering one moves it out of this list.

### The era key is not a fixed point either

`donruss` is stale *because* `normalizeSetKey` rewrites it, and the instinct is
to stop that. But `normalizeSetKey` has no year, and with no year the modern
spelling is the right default —
`resolveSetKeyForSlug("baseball", "Donruss", 1987)` already answers `donruss`
correctly because **it** has the year. The era split is resolved by
`spellSetKeyForEra` at the call sites that know the year; pinning the bare key
would break the year-less default without fixing anything.

## 7. Pins

- **Fixed-point test over the real catalog** — every checklist-backed catalog
  setKey falls in exactly one bucket. Measured across all 1,950: **1,882** fixed
  points, **20** declared aliases, **11** ruled collapses, **1** era key, **19**
  catalog-malformed, **17** open questions — **0 unexplained**. A key in none of
  them is a collapse nobody declared, which is what the test catches.
- **No cycles, no chains** — every alias target is itself a fixed point; no key
  is both an alias and a fixed point.
- **No distinct-product merges** — no two checklist-backed `distinct` keys land
  on one canonical.
- **The mutation** — `alias bowmans-best -> bowman` is **red**. It has the same
  shape as the aliases we accept, which is why the rule that separates them is
  "does the destination *add a maker prefix*", never "is one a prefix of the
  other".
- **Era table** — both directions, refuses to guess without a year, and every
  rule is labelled ASSUMPTION.
- **Pokemon codes** — `sv2a`/`sv8a`/`s12a` fixed points; `japanese-*` and
  `swsh12a` still fold; `swsh12`/`swsh12tg` (English Silver Tempest) untouched.
- **Throughput** — baseline 15,525 calls/s, reconciled **37,270** (2.4× faster:
  an exact map hit returns before the 188-pattern regex scan).

## 8. Two tests changed, and why

Both pinned a real pool fusion, and in both the destination holds **zero**
checklist rows.

**1. `hobbyIqCardId.test.ts`** asserted
`normalizeSetKey("Select Certified") === "score-select"`. Measured:
`select-certified` holds 1,376 checklist rows (baseballcardpedia, 1995-1996),
`score-select` holds **zero** — and the two names never share a year:

```
1995/1996 Select Certified   baseball 1,246 + 1,447   football 962 + 37
1993/1994/2007 Score Select  baseball   956 +    51   football   6 +  5
```

Two products, disjoint eras, one destination. The test's original concern — that
a careless bare-`certified` rule would steal the key — is still pinned; only the
destination changed.

**2. `idCarriesTheProduct.test.ts`** asserted
`resolveSetKeyForSlug("baseball", "1995 Studio", 1995) === "donruss-studio"`.
The 1991-2005 Studio checklists live under **`studio`** (7,867 checklist rows,
baseballcardpedia); `donruss-studio` holds **zero** checklist rows against 1,191
derived/vendor ones. The pool agrees — the sales are titled "1992 Studio
Baseball", and "Donruss Studio" only from 2003. Same rule as Select Certified:
a destination no checklist has ever written cannot be the canonical spelling of
one that is checklist-backed.

---

*All figures are read-only measurements taken 2026-09-03 against prod
`hobbyiq-comps`. No writes, no dispatches.*
