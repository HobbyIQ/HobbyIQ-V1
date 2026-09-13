# baseballcardpedia, 2026-09-13 — the variation axis applied

Source tag `baseballcardpedia-2026-09-13`. 28 files, **69,593 rows scraped**,
**63,105 rows staged**.

This directory was re-emitted after #2112's insert-set-key guard refused 19 of
its 28 files. **Every decision below was verified against the live
baseballcardpedia page before it was applied**; where the page does not settle a
case, both rows are withheld and named in the manifest rather than guessed at.

## What the guard was seeing

The guard refuses a file whose rows would land on fewer distinct ids than there
are rows: a later row would overwrite an earlier one inside one run, and the
last writer would decide which card the address holds. The refusal was correct
every time. The cause was **not** an unregistered insert set in most files — it
was three scrape defects and one real registration gap:

| Cause | Rows | What the source actually prints |
|---|---|---|
| Photo variations stamped `category=base` | 4,529 | a section headed *Gimmicks* / *Twinks* listing `100 Clayton Kershaw bubble gum` beside base `100 Clayton Kershaw` |
| A rung's serial number inside the player cell | 1,703 | `DKM-AD Adrian Beltre 25` — `25` is the print run, not part of the name |
| A declared parallel read as a card set | 373 | *"…are also available in a Jersey Number **parallel**"* |
| Cross-joined "Rip Cards" category | 4,600 | 920 player-date strings × one malformed card number |
| Odds prose read as cards | 18 | `HA1 1:216 wax` from the section's odds paragraph |
| A named subset flattened into `base` | 252 | a section headed *Factory Set Rookie Variations* |

## The decisions, and the rule each one applies

**(a) The source prints a distinguishing label → it goes on the parallel axis.**

- **Image variations (4,529 rows).** bcp files photo variations under headings
  it calls *Gimmicks* and *Twinks*. "Gimmick" is not our vocabulary — Beckett's
  term, and ours, is the image variation — so the stored spelling is #1613's:
  `"<Name> Image Variation SP"`, and `"<Name> Image Variation <Rung> SP"` where
  the source prints a ladder rung, because the variation wins but the finish is
  kept. The **photo names the subset**, so each photo's own category carries
  only the product's declared ladder (12 rungs on 2016 Topps, which is exactly
  the manifest's `ladder`). Putting the photo on the parallel axis instead
  multiplies the base ladder by every photo — 528 rungs inside one category on
  2016 Topps — which is indistinguishable from the Rip Cards cross-join, and the
  exploded gate is right to refuse that shape.
- **Declared parallel rungs (373 rows).** 2002 Donruss *Jersey Number* and 2018
  Diamond Kings *Holo Silver / Holo Gold / Holo Blue / Purple / Masterpiece* are
  described as parallels in the page's own prose and sit as subsections of their
  set. A colour rung is never a card set key, so they fold onto their root set
  with the colour on the parallel axis.
- **Trailing print runs (1,703 rows).** Moved out of the player cell into
  `printRun`. This is what lets a rung's roster compare equal to its root's —
  without it the fold cannot see that `Adrian Beltre 25` and `Adrian Beltre` are
  one player.
- **Factory-set checklists (6 rows).** 1988 Donruss: *"since the factory sets
  didn't include the 26 Bonus MVP cards, the checklists are different"*. The six
  checklist cards exist in two printings and the source says which is which.

**(b) Different players, one number, category left as base → restore the
section the source names (252 rows).** 2015 and 2016 Topps print a section
headed *Factory Set Rookie Variations* whose lines repeat the base card's number
without its `RC` designation. They are a named subset, not an unresolvable
clash.

**(c) Duplicates (51 rows).** Byte-identical rows, and repeats of a checklist
line under a **misspelling** of the same player with no descriptor to make it a
distinct card — `Torii Hunger` for `Torii Hunter`, `Neftali Perez` for `Neftali
Feliz`, `Russel Martin` for `Russell Martin`, all in bcp's hand-typed Gimmicks
and Twinks lists. The checklist's own spelling stands.

**(d) Unresolvable → both rows withheld (1,819 rows).** The source prints one
card number twice and prints nothing that distinguishes the printings. 2001
Topps Chrome #470 is the clearest: *"470 Erubiel Durazo"* and *"470 Sidney
Ponson"*, no note, no label. Inventing an axis would be minting from nothing and
letting them through would let the last writer decide the card, so **both** sides
come out. Every held row is listed in its manifest under
`variationAxisApplied.heldRows` with its address, its players and its reason —
that list is the next pass's worklist, not a silent loss.

## The removed category

`2016-topps-baseball.csv [insert-double-play-rip-cards]` — **4,600 rows
removed.** The scrape split `Shin-Soo Choo` on its hyphenated first name, put
`Shin-Soo` in `cardNumber`, and cross-joined 920 player-date strings into the
parallel column: 4,600 rows on one card number. **It was not re-scraped, because
there is no numbered checklist to re-scrape** — the source lists Double Play Rip
Cards as ~1,002 one-of-ones identified by player and date (`Ichiro June 22`),
with no card numbers at all. A set with no card numbers cannot be addressed by
this pipeline; acquiring it needs a ruling on how a dated one-of-one is
identified, which is a separate question from this repair.

## Reconciliation

```
rows scraped        69,593
  staged            63,105
  held (class d)     1,819
  duplicates            51
  odds prose            18
  Rip Cards          4,600
  -------------------------
  accounted         69,593   EXACT
```

## State after the re-emit

**18 of 28 files pass with zero collisions.** The remaining 10 are refused for
`unregistered-set-keys` only — no file in this directory now has a single
colliding id. Those 10 need **7 card set keys** registered in src, each verified
on the source as a separately-numbered named set with its own checklist:

| Key | Rows | Source heading |
|---|---|---|
| `diamond-kings-dk-rookie-signatures` | 282 | *DK Rookie Signatures* |
| `topps-factory-set-rookie-variations` | 252 | *Factory Set Rookie Variations* |
| `diamond-kings-dk-signatures` | 106 | *DK Signatures* |
| `topps-baseball-history` | 30 | *Baseball History* (1A, 1B, 2A…) |
| `topps-baseball-royalty` | 25 | *Baseball Royalty* (BR-1…) |
| `topps-the-babe-ruth-story` | 10 | *The Babe Ruth Story* (BR-1…) |
| `topps-cal-ripken-jr-refractor` | 3 | *Cal Ripken, Jr. Refractor* (1A, 1B, 1C) |

They collide because the sets genuinely share card numbers — `BR-1` is both Babe
Ruth Story's *St. Mary's Industrial School Student* and Baseball Royalty's *Babe
Ruth*; `S-AH` is both DK Signatures' *Aaron Hicks* and DK Rookie Signatures'
*Austin Hays* — which is R30's shape exactly, and registering the keys resolves
every one of those ids. The registration is a src change and ships separately.
