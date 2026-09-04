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
| `distinct` | 687 | **2,091,964** | Two products the deriver merges. The key becomes a fixed point. |
| `catalog-key-malformed` | 1,899 | 21,051 | The **catalog** key carries a year prefix or trailing sport word (`bowman-baseball`, `2024-25-panini-prizm`). The deriver is right; the stored key is the defect. Rename-fleet work, left alone here. |
| `alias` | 24 | 229,530 | One product, two spellings. Canonical declared. |
| `needs-ruling` | 28 | 73,844 | No mechanical rule fires. **Report-only — changes nothing.** Since 2026-09-04 every one of these holds **zero** checklist rows. |
| `era-split` | 1 | 72,302 | `donruss`, one brand across two owners. |
| `malformed` | 7 | 0 | Raw spaced titles, no checklist behind them. |

**84% of the stranded rows are the collapse, not the aliases.**

> **Re-generated 2026-09-04.** `distinct` moved 686 -> 687 and `needs-ruling`
> 29 -> 28: giving `black-diamond-rookie-edition` a `productSetKeys.ts` entry
> (which Drew's DISTINCT ruling requires anyway — a vocabulary destination must
> have a family) made rule (2b) fire, so the ruling is now **derived
> mechanically from the product table** instead of resting only on a
> hand-maintained list. That is the direction this file is supposed to move:
> the census re-derives the verdict on its own. Nothing else in the file
> changed — the regeneration is byte-identical apart from this one entry.

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

## 4. The open questions, answered from evidence — all 20 now ruled

The first cut sent all 20 `needs-ruling` keys to Drew. Reading the evidence
already in this repo answered **15 of them**, and a question whose answer is
written down is not an open question. **Drew ruled the remaining 5 on
2026-09-04** (section 4a), so no checklist-backed key is open. Each verdict cites what settled it: a
`productSetKeys.ts` entry, a standing CF ruling in the vocabulary, a sibling
service that already disagrees, or checklist counts and sample titles that only
fit one reading.

Two kinds of answer, and Drew's standing rule decides which applies. **ALIAS** —
one product, two spellings; the key folds onto the canonical. **DISTINCT** — a
real separate product; it becomes a fixed point and the deriver stops collapsing
it. Distinct products are **never** collapsed, because a fused pool prices both
cards wrong. The tie-break, where the census is ambiguous, is the one Drew has
used every time: *does the collapse put different cards in one pool?*

### Ruled ALIAS — 11 keys, one product spelled more than one way

| Key | Folds onto | What settled it |
|---|---|---|
| `bowman-sapphire-edition` (11,079) | `bowman-chrome-sapphire` | CF-SAPPHIRE-ONE-NAME: "there is no standalone Bowman Sapphire product". "Edition" is a marketing suffix. |
| `bowman-sapphire-chrome` (3,681) | `bowman-chrome-sapphire` | Word order only — `sapphireOneName.test.ts:34` already pins the title form. |
| `bowman-nscc` (854) | `bowman-chrome-nscc` | `bowmanNsccIsItsOwnProduct.test.ts` already pins "Bowman NSCC" here, with Drew's 2026-08-31 reasoning. #1612 rules **the product** distinct — and `bowman-chrome-nscc` **is** that product. This is its shorthand, not a second one. |
| `topps-sapphire-chrome` (673) | `topps-chrome-sapphire` | The vocabulary already carries both spellings as ONE rule. |
| `topps-sapphire-chrome-factory-set` (1,044) | `topps-chrome-sapphire` | 2016 Chrome Sapphire was *sold* as a factory set. A box configuration is not an identity. |
| `black-diamond` (2,676) | `upper-deck-black-diamond` | CF-UD-INSERT-LINES anchors the bare spelling **on purpose**; every sample title is "Upper Deck Black Diamond". |
| `topps-allen-and-ginter-chrome` (1,690) | `topps-allen-ginter-chrome` | Spelling only ("and" vs the elided form). The Chrome subset itself was **already** distinct (21,442 checklist rows) — this stops its pool splitting across two spellings. |
| `bowman-mega-box` (33,137) | `bowman-chrome-mega-box` | **Drew 2026-09-04 — KEEP THE COLLAPSE.** A spelling, not a product. CF-BOWMAN-MEGA-BOX-DISTINCT still separates the mega-box *line* from `bowman-chrome`; within the line the short key names the same cards. |
| `bowman-sapphire` (7,722) | `bowman-chrome-sapphire` | **Drew 2026-09-04 — KEEP THE COLLAPSE**, re-affirming CF-SAPPHIRE-ONE-NAME against the corpus that disagreed (four Beckett scrapes, and the short 2025 title outnumbering the long one 3:1). |
| `bowman-mega-box-chrome` (6,359) | `bowman-chrome-mega-box` | **Drew 2026-09-04 — KEEP THE COLLAPSE.** The third word order of one release. |
| `topps-nscc-bowman-national-convention` (221) | `bowman-chrome-nscc` | **Drew 2026-09-04.** The 2021 **Bowman** National release; the "topps" is the parent company, not a second maker. Every census sample title is "&lt;year&gt; Bowman Chrome National Convention Baseball". |

### Ruled DISTINCT — 9 keys the deriver must stop collapsing

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
| `black-diamond-rookie-edition` (194) | `upper-deck-black-diamond` | **Drew 2026-09-04 — its own product, never the base line.** A rookie-only release (all 2000, baseballcardpedia) against a destination pool holding the base sets ("1999 Upper Deck Black Diamond Baseball", 857 rows). A rookie-only checklist fused into a full veteran one drags a rookie card's FMV toward veteran comps and back. CF-UD-INSERT-LINES is **pinned off it** in both spellings. |

### 4a. Still open — none: Drew ruled the last five (2026-09-04)

**Drew ruled all five on 2026-09-04.** The checklist-backed `needs-ruling` list
is now **empty**; `needsRulingQuestions()` is pinned to return nothing with a
checklist row behind it.

| Key | Rows | Ruling | Effect on the deriver |
|---|---:|---|---|
| `bowman-mega-box` | 33,137 | **alias** -> `bowman-chrome-mega-box` | none — it already collapsed; the collapse is now *declared* |
| `bowman-sapphire` | 7,722 | **alias** -> `bowman-chrome-sapphire` | none — same |
| `bowman-mega-box-chrome` | 6,359 | **alias** -> `bowman-chrome-mega-box` | none — same |
| `topps-nscc-bowman-national-convention` | 221 | **alias** -> `bowman-chrome-nscc` | none to the output; the fold is now by **declaration** rather than by a substring match |
| `black-diamond-rookie-edition` | 194 | **distinct** — a fixed point | **changed**: it no longer folds into `upper-deck-black-diamond` |

The other 9 `needs-ruling` keys carry **zero** checklist rows and remain in the
data file for completeness. With no checklist behind them there is no pool to
fuse or split, so they are a listing, not a question.

#### The three "keep the collapse" rulings changed the EXPLANATION, not the output

`bowman-mega-box`, `bowman-sapphire` and `bowman-mega-box-chrome` already
collapsed, via `ALREADY_RULED_COLLAPSES` — the list meaning *"a decision
somebody made that a derivation may not overturn"*. #1699 could not close them
because the **catalog disagreed**: 47,218 checklist rows are filed under the
short keys, and for 2025 Sapphire the short spelling (8,962 pool rows)
outnumbers the long one (2,805) better than 3:1. A collapse that survives only
because an old test pins it, while the corpus votes the other way, is a
collapse nobody has actually re-affirmed.

Drew re-affirmed it. So the three **move out of** `ALREADY_RULED_COLLAPSES`
and **into** `RULED_ALIASES`, where the canonical is stated and the evidence
travels with it. They are deliberately **not** in both lists: one truth in one
place, and "an un-re-affirmed prior decision" is exactly what they are no
longer. `normalizeSetKey` emits the same key it did before.

#### Why the NSCC ruling also re-anchored the vocabulary rule

The NSCC pattern's Bowman scope was **real but incidental**: it was unanchored,
so "bowman" only had to appear *somewhere* in the key.
`topps-nscc-bowman-national-convention` matched on the trailing
`bowman-national-convention` substring, and the reconciliation could not tell
whether that was the rule working or the leak its own comment warns about.

Drew ruled it a Bowman release, so the rule **was** working. But a scope you
cannot read off the pattern gets re-litigated the next time a key carries two
makers, so the pattern is now `(?:^|-)bowman-...`: "bowman" must start the key
or start a segment of it. Every real spelling still matches. What it now
refuses is a mid-word accident like `superbowman-nscc` — the same
prefix-match-is-not-an-identity defect that put `scoremasters` in the `score`
pool.

The key itself no longer depends on that pattern at all: an alias declaration
is an exact-token map hit that returns from `reconcileSetKey` **before** the
regex vocabulary is consulted.

#### Why the Black Diamond ruling needed a pin in two places

`black-diamond-rookie-edition` is the one ruling that **changes the deriver's
output**, so it is guarded twice, and the redundancy is deliberate:

1. `productSetKeys.ts` spells it as its own product, which makes the census's
   own rule (2b) derive `distinct` **mechanically** — the verdict no longer
   rests on a hand-maintained list. (`RULED_DISTINCT` still names it, and both
   agree; the table is now the authority.) Either way it is a fixed point,
   returning from `reconcileSetKey` before the vocabulary runs.
2. CF-UD-INSERT-LINES is re-anchored to
   `(?:^|-)(?:upper-deck-)?black-diamond(?!-rookie-edition)`, with the Rookie
   Edition given its own rule **above** it — a longer product name always
   precedes the family pattern it contains, exactly as Mega Box and NSCC
   precede `/bowman-chrome/`.

The product-table entry is not optional bookkeeping: `productFamilyIsATable`
asserts that **every key the regex vocabulary can emit has a family entry**, and
adding the Rookie Edition rule made it a new destination. It gets its **own
family** and no `refines` — the table's own note says "1st Edition is another
set, not a refinement", and a rookie-only release is another set by the same
reasoning, so the matcher must not widen from it into the base pool.

Guard (2) is what holds if the reconciliation table is ever absent, which is a
state that really occurs: the loader degrades to an **EMPTY doc** by design
(CF-RECONCILIATION-DEFENSIVE-LOAD), and on the empty doc there are no fixed
points at all. Both spellings are covered — bare and `upper-deck-` prefixed —
because the ruling is about the product, not about one way of writing it.

---
## 4b. What the catalog-key reconciliation must re-key

Read-only count from the same 2026-09-03 census. **No writes were made.**

| Key | Catalog rows | Checklist rows | Re-key to |
|---|---:|---:|---|
| `bowman-mega-box` | 33,219 | 33,137 | `bowman-chrome-mega-box` |
| `bowman-sapphire` | 7,865 | 7,722 | `bowman-chrome-sapphire` |
| `bowman-mega-box-chrome` | 6,370 | 6,359 | `bowman-chrome-mega-box` |
| `topps-nscc-bowman-national-convention` | 221 | 221 | `bowman-chrome-nscc` |
| **Total to re-key** | **47,675** | **47,439** | |

`black-diamond-rookie-edition` (195 catalog rows, 194 checklist) is **excluded
on purpose**: it was ruled DISTINCT, so it becomes a fixed point and its rows
**stay where they are**. A distinct ruling is the one verdict that creates no
re-keying work — the catalog was already right.

Every alias above has **zero pool rows at the key** and its demand at the
destination, which is the shape that makes re-keying safe: the catalog writes
the short spelling, the market writes the long one, and nothing is currently
pooled under the key being retired.

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
a fixed point. **Eight of those collapses are deliberate** — somebody decided
them, wrote the rule, and pinned it with a test that states the reasoning. The
census can see that two spellings exist; it cannot see that a human already
chose between them.

```
bowman-chrome-sapphire-edition -> bowman-chrome-sapphire    "vendors write Bowman
bowman-draft-sapphire-edition  -> bowman-draft-sapphire      Sapphire as shorthand;
bowman-draft-sapphire-chrome   -> bowman-draft-sapphire      there is no standalone
topps-chrome-sapphire-edition  -> topps-chrome-sapphire      product"
flair-showcase                 -> flair                     marked DELIBERATE
panini-contenders-optic        -> panini-contenders         opticIsOneProduct
donruss-champions              -> panini-donruss            parent brand, pinned
fleer-ultra                    -> ultra                     CF-ULTRA-IS-NOT-FLEER
```

The list is **derived, not guessed**: it is every key for which a test in this
repo asserts a destination our verdict would forbid, extracted by grepping the
suite for the assertion form.

**It was eleven until 2026-09-04.** `bowman-sapphire`, `bowman-mega-box` and
`bowman-mega-box-chrome` were on this list precisely *because* nobody had
re-affirmed them — the catalog's 47,218 rows disagreed and the list held the
line by default. Drew re-affirmed all three, so they graduated to
`RULED_ALIASES` with a stated canonical and the evidence attached. That is the
intended direction of travel for this list: it should shrink as questions get
answered, never grow. A key belongs here only while it is a decision **nobody
has revisited**.

**Two keys are deliberately absent, and they are the interesting ones.**
`select-certified` and `studio` also had tests asserting a collapse, and the
evidence overturned both — 1,376 and 7,867 checklist rows against **zero** on
their destinations, in disjoint eras. A pin is evidence that a decision was
made, not proof it was right. Each was read; each states a reason the census
cannot see. Drew answering a question moves the key out of this list — which is
exactly what happened to the three Bowman spellings on 2026-09-04.

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
  setKey falls in exactly one bucket. Re-measured after the 2026-09-04 rulings,
  across all 1,950: **1,891** fixed points, **31** declared aliases, **8** ruled
  collapses, **1** era key, **19** catalog-malformed, **0** open questions —
  **0 unexplained**. A key in none of them is a collapse nobody declared, which
  is what the test catches. (Was 1,882 / 20 / 11 / 1 / 19 / 17 before the
  rulings: three Bowman keys moved from *ruled collapse* to *declared alias*,
  `topps-nscc-bowman-national-convention` from *open* to *declared alias*, and
  `black-diamond-rookie-edition` from *open* to *fixed point*.)
- **No checklist-backed key is still open** — `needsRulingQuestions()` returns
  nothing with a checklist row behind it, asserted as an empty list so a
  regeneration that re-opens one fails loudly. The 9 remaining entries hold
  zero checklist rows and are a listing, not a question.
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
  an exact map hit returns before the 188-pattern regex scan). The floor is
  re-asserted after the 2026-09-04 rulings, which add four exact-token map
  entries and two anchors — both changes make the fast path shorter, not longer.
- **The 2026-09-04 rulings** — the three Bowman spellings still fold *and* are
  declared aliases *and* are no longer double-listed in
  `ALREADY_RULED_COLLAPSES`; `topps-nscc-bowman-national-convention` folds onto
  `bowman-chrome-nscc`; the NSCC pattern keeps every real spelling and refuses
  `superbowman-nscc`; `black-diamond-rookie-edition` is a fixed point in **both**
  spellings while the Black Diamond base line still folds.

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
