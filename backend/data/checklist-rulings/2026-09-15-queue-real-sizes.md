# Queue real sizes — direct reads, 2026-09-15

Every figure here is a **direct read** of `sold_comps` by slug prefix (or by title
where the product has no key of its own yet), paged. No cross-partition COUNT.
These supersede the scaled estimates in `parallel-ladder-plan-2026-09-15.md`,
which are rankings, not sizes.

## 500+ rows — build

| rows | item | cell |
|--:|---|---|
| 27,532 | R53 Select (whole cell) | `basketball/2019/panini-select` |
| 1,938 | R47 A&G minis | `baseball/2025/topps-allen-ginter` |
| 1,496 | R50-52 Greats | `baseball/2001` (539 auto) |
| 1,438 | R50-52 Greats | `baseball/2002` (378 auto) |
| 607 | R50-52 Greats | `baseball/1999` SI (401 auto) |

## Under 500 — recorded, no package for now

| rows | item |
|--:|---|
| 415 | R48 `chicks` — **key registered**, no package |
| 257 | R48 `75-years-of-topps` — **key registered**, no package |
| 203 | R50-52 Greats `baseball/2000` |
| 153 | R47 A&G minis `baseball/2023` |
| 71 | R47 A&G minis `baseball/2024` |
| 67 | R50-52 Greats `baseball/2004` |
| 61 | R50-52 Greats `baseball/2006` (the R51 Upper Deck ruling covers these 61) |
| 54 | R48 `flowers` — **key registered**, no package |
| 30 | R50-52 Greats `baseball/2009` |
| 5 | R50-52 Greats `baseball/2005` — the year the sources say does not exist |
| 1-3 each | Greats strays: 1960, 1961, 2010, 2019, 2023, 2026 |

The 2005 count is worth keeping: baseballcardpedia 404s on
`2005_Greats_of_the_Game` and Fleer went bankrupt that year, yet 5 pool rows
carry a 2005 slug. They are mis-slugged rows, not evidence of a 2005 release.

## R47 — the ruling's premise does not hold

R47 says A&G minis are their own card set. Measured:

- The catalog already holds **40 mini-named rungs** on `topps-allen-ginter`
  2025 from checklist sources, most at 350 cards.
- **The minis reprint the base roster**: of the 350 numeric cards on the plain
  `Mini` rung, **349 name the same player** the base print names at that
  number. The one difference is #327 `Vladimir Guerrero` vs
  `Vladimir Guerrero Sr.` — the same person. (25 further rows differ only by an
  `RC` suffix, folded before the count.)
- So a separate `topps-allen-ginter-mini` key would put the same card at two
  addresses.
- Of the 1,938 mini pool rows, **1,211 already sit on a rung the catalog spells
  the same way**; the other 726 sit on a differently-spelled rung
  (`black-border` 228 vs the catalog's `Mini Black Bordered`, etc.).

Full detail and three questions for Drew:
`backend/data/checklist-rulings/2026-09-15-r47-allen-ginter-minis-finding.json`.

## R53 — 92.6% of the cell names no tier

Of 27,532 rows in `basketball/2019/panini-select`, only **2,038 (7.4%)** name a
tier: Concourse 1,360, Premier 355, Courtside 323. The other **25,494** name
none; their top rungs are `base` (8,637), `tri-color`, `silver`, `red`, `scope`,
`red-disco`.

Registering the three tier keys therefore places 7.4% of the cell.

### The partition test FAILED — no untiered list was written

Run against the pool's own tier-named rows, 2026-09-15:

| tier | rows | number range | distinct numbers |
|---|--:|---|--:|
| Concourse | 1,349 | 1-1225 | 54 |
| Premier | 349 | 8-235 | 41 |
| Courtside | 315 | 4-300 | 39 |

The ranges **overlap**, and so do the numbers themselves: 3 numbers appear in
both Concourse and Premier (8, 10, 193), 4 in both Concourse and Courtside
(4, 56, 94, 261), and 1 in both Premier and Courtside (235).

**A card number therefore cannot say which tier a row belongs to.** Per the
instruction to stop if the tiers do not partition the numbering, no list was
written for the 25,494 untiered rows. Assigning them would need a signal the
pool does not carry — the tier would have to come from a per-tier checklist
matched on (number, player), which is an acquisition, not a re-key.
