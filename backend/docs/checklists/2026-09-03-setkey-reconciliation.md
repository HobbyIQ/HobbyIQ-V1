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

## 4. The open questions, answered from evidence — 15 ruled, 5 left for Drew

The first cut sent all 20 `needs-ruling` keys to Drew. Reading the evidence
already in this repo answered **15 of them**, and a question whose answer is
written down is not an open question. Each verdict cites what settled it: a
`productSetKeys.ts` entry, a standing CF ruling in the vocabulary, a sibling
service that already disagrees, or checklist counts and sample titles that only
fit one reading.

Two kinds of answer, and Drew's standing rule decides which applies. **ALIAS** —
one product, two spellings; the key folds onto the canonical. **DISTINCT** — a
real separate product; it becomes a fixed point and the deriver stops collapsing
it. Distinct products are **never** collapsed, because a fused pool prices both
cards wrong. The tie-break, where the census is ambiguous, is the one Drew has
used every time: *does the collapse put different cards in one pool?*

### Ruled ALIAS — 7 keys, one product spelled more than one way

| Key | Folds onto | What settled it |
|---|---|---|
| `bowman-sapphire-edition` (11,079) | `bowman-chrome-sapphire` | CF-SAPPHIRE-ONE-NAME: "there is no standalone Bowman Sapphire product". "Edition" is a marketing suffix. |
| `bowman-sapphire-chrome` (3,681) | `bowman-chrome-sapphire` | Word order only — `sapphireOneName.test.ts:34` already pins the title form. |
| `bowman-nscc` (854) | `bowman-chrome-nscc` | `bowmanNsccIsItsOwnProduct.test.ts` already pins "Bowman NSCC" here, with Drew's 2026-08-31 reasoning. #1612 rules **the product** distinct — and `bowman-chrome-nscc` **is** that product. This is its shorthand, not a second one. |
| `topps-sapphire-chrome` (673) | `topps-chrome-sapphire` | The vocabulary already carries both spellings as ONE rule. |
| `topps-sapphire-chrome-factory-set` (1,044) | `topps-chrome-sapphire` | 2016 Chrome Sapphire was *sold* as a factory set. A box configuration is not an identity. |
| `black-diamond` (2,676) | `upper-deck-black-diamond` | CF-UD-INSERT-LINES anchors the bare spelling **on purpose**; every sample title is "Upper Deck Black Diamond". |
| `topps-allen-and-ginter-chrome` (1,690) | `topps-allen-ginter-chrome` | Spelling only ("and" vs the elided form). The Chrome subset itself was **already** distinct (21,442 checklist rows) — this stops its pool splitting across two spellings. |

### Ruled DISTINCT — 8 keys the deriver must stop collapsing

| Key | Was collapsing to | What settled it |
|---|---|---|
| `etopps` (187) | `topps` | **`parseTitleIdentity.service.ts` already rules it distinct** — `if (/\betopps\b/i.test(t)) return "eTopps"`, with a comment saying it must precede `/topps/`. Two services disagreeing is a defect; the one that ruled deliberately wins. Collapsing into the 3.49M-row `topps` pool is the largest fuse in the table. |
| `etopps-cards-that-never-were` (17) | `topps` | Same line, a named 2007 subset. |
| `panini-prizm-perennial-draft-picks` (3,748) | `panini-prizm-draft-picks` | 2013-14 **baseball**; the destination is a 2019-2025 football/basketball line. Different sport, different decade. |
| `scoreboard-mantle` (153) | `score` | 1997 Scoreboard Mickey Mantle — a Classic/Scoreboard tribute set. Reaches `score` only because "score" is a **prefix of "scoreboard"**. |
| `scoremasters` (44) | `score` | 1989 Scoremasters, same prefix accident. A prefix match is not an identity — which is the whole point of this file. |
| `topps-allen-and-ginters-national-die-cuts` (146) | `topps-allen-ginter` | A National-convention die-cut release. Convention exclusives price on their own scarcity (CF-BOWMAN-NSCC-DISTINCT reasoning). |
| `bowman-mega` (412) | `bowman-chrome-mega-box` | CF-BOWMAN-MEGA-BOX-DISTINCT: "Mega box is different from 2026 bowman." The 2026 short spelling of that distinct line. |
| `topps-update-japan` (1) | `topps-update-series` | A Japan-market release. Small — but a small number is never dismissed as noise, and the market's own key wins. |

### Still open — 5 keys Drew decides

**3 already carry a ruling and keep collapsing** (47,218 rows). They stay
consistent with the standing rulings; the catalog's disagreement is the reason
they are worth re-asking, not a reason anything changes today:

| Key | Rows | Ruled destination | The disagreement |
|---|---:|---|---|
| `bowman-mega-box` | 33,137 | `bowman-chrome-mega-box` | CF-BOWMAN-MEGA-BOX-DISTINCT names `bowman-chrome-mega-box` the one product; 33,137 checklist rows are filed under the short key. |
| `bowman-sapphire` | 7,722 | `bowman-chrome-sapphire` | The rule says "no standalone product", but 7,722 rows from **four independent Beckett scrapes** are filed here, and "2025 Bowman Sapphire Baseball" (8,962) outnumbers "2025 Bowman Chrome Sapphire Baseball" (2,805) better than 3:1. |
| `bowman-mega-box-chrome` | 6,359 | `bowman-chrome-mega-box` | Third spelling, same question. |

**2 are genuinely split** — the evidence points both ways:

| Key | Rows | Option A | Option B |
|---|---:|---|---|
| `topps-nscc-bowman-national-convention` | 221 | **alias** onto `bowman-chrome-nscc` — a 2021 Bowman National release whose key picked up a stray "topps" | **distinct** — the vocabulary's NSCC rule is deliberately Bowman-scoped "so it cannot capture a Topps National promo", and it is capturing this key on the `bowman-national-convention` substring, which is exactly the leak the comment warns about |
| `black-diamond-rookie-edition` | 194 | **alias** onto `upper-deck-black-diamond` — "Rookie Edition" is a subset name, and CF-UD-INSERT-LINES already folds the bare key | **distinct** — Black Diamond Rookie Edition is a separately-released product (the census's own titles show a 1998 football Rookie Edition alongside the 1999 base sets), and folding it fuses a rookie-only pool into the base one |

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
