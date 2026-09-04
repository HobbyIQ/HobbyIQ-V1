# Tiffany-as-a-rung, and the phantom product keys — a report-only census

**2026-09-04. READ-ONLY. This document retires nothing.** The rematch / catalog
repair owns every write named here; what follows is the measurement it should be
pointed at, taken against prod `card_catalog` and `sold_comps` on 2026-09-04.

Two findings, measured separately because they have different causes and
different blast radii, and one shared shape: **a row filed under an identity that
is not the card's own splits its pool.**

---

## 1. Tiffany is a PRODUCT, never a rung

**Doctrine.** Tiffany is its own product — its own `setKey`, `parallel` blank. It
is never a parallel of the paper product it shares a checklist with. Drew ruled
this for 1987 Topps Tiffany on 2026-09-01, and #1737 fixed the 1991 case
forward. A Tiffany row filed as `parallel: "Tiffany"` on the paper product's
`setKey` is a **split pool**: the same physical card priced twice, from two
partial comp pools, under two identities.

### The 1991 shape that started this

`scrape-bcp-ladders.cjs` derived the key from the page title
(`1991_Topps_Traded` → `topps-traded`) and returned Tiffany as a *rung* of that
product. Measured today, 1991 `topps-traded` still carries the cross-join:

| parallel | rows |
|---|---:|
| `Topps Traded Tiffany` | 132 |
| `Grey Backs` | 132 |
| `Limited Edition Tiffany` | 1 |

396 = 132 × 3 — one 132-card checklist multiplied across three rung names. The
real product `topps-traded-tiffany` holds **8** rows for 1991, against the 132 the
staged checklist carries.

### Every (year, setKey, parallel, source) carrying a Tiffany rung

42 groups, **2,151 catalog rows**, **447 sold_comps rows** keyed to those rung
identities. `poolRows` is the split-pool cost: comps that today price a rung
identity instead of the Tiffany product.

| year | setKey | parallel | source | rows | poolRows | Tiffany sibling product |
| ---: | --- | --- | --- | ---: | ---: | --- |
| 2002 | `fleer` | `Tiffany` | `bccp` | 850 | 0 | fleer-tiffany ABSENT (0 rows) |
| 1990 | `bowman` | `Tiffany` | `baseballcardpedia-ladders-2026-09-04` | 528 | 88 | bowman-tiffany (86 rows, 86/528 cardNumbers covered) |
| 1997 | `fleer` | `Tiffany` | `ingest-auto-seed` | 134 | 2 | fleer-tiffany ABSENT (0 rows) |
| 1991 | `topps-traded` | `Topps Traded Tiffany` | `baseballcardpedia-ladders-2026-09-04` | 132 | 0 | topps-traded-tiffany (8 rows, 8/132 cardNumbers covered) |
| 1996 | `fleer` | `Tiffany` | `ingest-auto-seed` | 97 | 2 | fleer-tiffany ABSENT (0 rows) |
| 1997 | `fleer` | `Tiffany` | `sales-attested` | 72 | 4 | fleer-tiffany ABSENT (0 rows) |
| 1987 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 71 | 0 | topps-tiffany (792 rows, 11/12 cardNumbers covered) |
| 1997 | `fleer` | `Tiffany` | `ingest-auto-seed-graded` | 59 | 1 | fleer-tiffany ABSENT (0 rows) |
| 1987 | `topps` | `Tiffany` | `sales-attested` | 22 | 41 | topps-tiffany (792 rows, 22/22 cardNumbers covered) |
| 1996 | `fleer` | `Tiffany` | `sales-attested` | 22 | 0 | fleer-tiffany ABSENT (0 rows) |
| 1985 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 19 | 0 | topps-tiffany (78 rows, 1/4 cardNumbers covered) |
| 1986 | `topps-traded-tiffany` | `Tiffany` | `ingest-auto-seed-graded` | 14 | 0 | n/a — setKey is already the Tiffany product |
| 1990 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 14 | 0 | topps-tiffany (83 rows, 2/5 cardNumbers covered) |
| 1987 | `topps` | `Tiffany` | `ingest-auto-seed` | 13 | 71 | topps-tiffany (792 rows, 11/12 cardNumbers covered) |
| 1988 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 10 | 0 | topps-tiffany (71 rows, 2/2 cardNumbers covered) |
| 1984 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 9 | 0 | topps-tiffany (792 rows, 1/1 cardNumbers covered) |
| 1987 | `topps-traded` | `Tiffany` | `ingest-auto-seed-graded` | 9 | 0 | topps-traded-tiffany (133 rows, 1/1 cardNumbers covered) |
| 2002 | `fleer` | `Tiffany` | `sales-attested` | 8 | 0 | fleer-tiffany ABSENT (0 rows) |
| 1987 | `topps` | `Tiffany` | `sales-attested-graded` | 6 | 0 | topps-tiffany (792 rows, 5/5 cardNumbers covered) |
| 1989 | `topps-tiffany` | `Tiffany` | `ingest-auto-seed-graded` | 6 | 0 | n/a — setKey is already the Tiffany product |
| 1990 | `bowman` | `Tiffany` | `sales-attested-graded` | 6 | 0 | bowman-tiffany (86 rows, 5/5 cardNumbers covered) |
| 1996 | `fleer` | `Tiffany` | `ingest-auto-seed-graded` | 6 | 0 | fleer-tiffany ABSENT (0 rows) |
| 2002 | `fleer` | `Tiffany` | `ingest-auto-seed-graded` | 6 | 0 | fleer-tiffany ABSENT (0 rows) |
| 1985 | `topps` | `Tiffany` | `ingest-auto-seed` | 4 | 233 | topps-tiffany (78 rows, 1/4 cardNumbers covered) |
| 1989 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 4 | 0 | topps-tiffany (66 rows, 1/1 cardNumbers covered) |
| 1990 | `topps` | `Tiffany` | `ingest-auto-seed` | 4 | 0 | topps-tiffany (83 rows, 1/3 cardNumbers covered) |
| 1991 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 4 | 0 | topps-tiffany (65 rows, 1/2 cardNumbers covered) |
| 1984 | `topps` | `Tiffany` | `ingest-auto-seed` | 3 | 0 | topps-tiffany (792 rows, 3/3 cardNumbers covered) |
| 1985 | `topps-tiffany` | `Tiffany` | `ingest-auto-seed-graded` | 2 | 0 | n/a — setKey is already the Tiffany product |
| 1986 | `topps` | `Tiffany` | `ingest-auto-seed-graded` | 2 | 0 | topps-tiffany (80 rows, 1/1 cardNumbers covered) |
| 1988 | `topps` | `Tiffany` | `ingest-auto-seed` | 2 | 1 | topps-tiffany (71 rows, 2/2 cardNumbers covered) |
| 1989 | `topps-tiffany` | `Tiffany` | `ingest-auto-seed` | 2 | 0 | n/a — setKey is already the Tiffany product |
| 1991 | `topps` | `Tiffany` | `ingest-auto-seed` | 2 | 0 | topps-tiffany (65 rows, 1/2 cardNumbers covered) |
| 1985 | `topps` | `Tiffany` | `sales-attested` | 1 | 0 | topps-tiffany (78 rows, 1/1 cardNumbers covered) |
| 1986 | `topps-traded-tiffany` | `Tiffany` | `ingest-auto-seed` | 1 | 0 | n/a — setKey is already the Tiffany product |
| 1987 | `topps` | `Limited Edition Tiffany` | `sales-attested` | 1 | 4 | topps-tiffany (792 rows, 0/1 cardNumbers covered) |
| 1987 | `topps-traded` | `Tiffany` | `ingest-auto-seed` | 1 | 0 | topps-traded-tiffany (133 rows, 1/1 cardNumbers covered) |
| 1989 | `topps` | `Tiffany` | `ingest-auto-seed` | 1 | 0 | topps-tiffany (66 rows, 1/1 cardNumbers covered) |
| 1989 | `topps` | `Tiffany` | `sales-attested` | 1 | 0 | topps-tiffany (66 rows, 1/1 cardNumbers covered) |
| 1990 | `bowman` | `Tiffany` | `ingest-auto-seed-graded` | 1 | 0 | bowman-tiffany (86 rows, 0/1 cardNumbers covered) |
| 1991 | `topps-traded` | `Limited Edition Tiffany` | `sales-attested` | 1 | 0 | topps-traded-tiffany (8 rows, 1/1 cardNumbers covered) |
| 2002 | `fleer` | `Tiffany` | `bccp-graded` | 1 | 0 | fleer-tiffany ABSENT (0 rows) |

### Reading it

- **`fleer` 2002/1996/1997 is the largest block and has NO Tiffany product at
  all.** 1,215 rows across four sources, and `fleer-tiffany` holds zero rows in
  the catalog. These rungs are not split from a sibling — the sibling was never
  minted. Retiring them without first acquiring a Fleer Tiffany checklist would
  delete the only rows that exist for those cards. **Acquire before retire.**
- **`bowman` 1990 (528 rows, 88 pool rows)** has a real sibling: `bowman-tiffany`
  carries 86 rows and every one of its card numbers is covered by the rung. This
  is a clean rekey candidate — and the 528 is itself a cross-join against 86
  distinct cards.
- **`topps` 1984-1991** is the long tail: many small `ingest-auto-seed*` and
  `sales-attested*` groups against a well-populated `topps-tiffany` sibling. 1987
  is the worst by pool: 22 `sales-attested` rows carry **41** comps and 13
  `ingest-auto-seed` rows carry **71**, all of which belong to the 792-row
  `topps-tiffany` product.
- **1985 `topps` / `ingest-auto-seed` is 4 rows carrying 233 pool rows** — the
  single densest split in the census. Small row counts are not small problems;
  never dismiss them by row count alone.
- Three groups are already on a Tiffany `setKey` and merely carry a redundant
  `parallel: "Tiffany"` (`topps-traded-tiffany` 1986, `topps-tiffany` 1985/1989,
  23 rows). Those are a parallel-blanking, not a rekey.

`sales-attested` rows are the ones to treat most carefully: they were minted
because a real sale said so, so the retire must move them onto the Tiffany
product, never drop them.

---

## 2. 35 phantom product keys from the sportscardchecklist lane

**Cause.** `setKeyFor()` emitted display-name keys and the ingest child used the
manifest `setKey` verbatim, so a subset or parallel name became a product of its
own. #1741 fixes this going forward (parent `setKey` `topps-chrome` + the
subset/parallel carried in its own field); these are the rows earlier runs left
behind.

**Criterion.** Every catalog `setKey` that is **not** a `normalizeSetKey` fixed
point **and** whose `normalizeSetKey` target is a real product. A ruled key must
be a fixed point — that is the invariant these rows violate.

**35 keys, 882 rows, 118 sold_comps rows**, every one targeting `topps-chrome`.

| phantom setKey | normalizeSetKey target | rows | poolRows |
| --- | --- | ---: | ---: |
| `topps-chrome-press-plates-cyan` | `topps-chrome` | 240 | 0 |
| `topps-chrome-autographs` | `topps-chrome` | 128 | 0 |
| `topps-chrome-town-heroes` | `topps-chrome` | 25 | 0 |
| `topps-chrome-slice-of-success` | `topps-chrome` | 25 | 0 |
| `topps-chrome-chosen-one-relics` | `topps-chrome` | 24 | 0 |
| `topps-chrome-final-piece-game-jerseys` | `topps-chrome` | 23 | 0 |
| `topps-chrome-bonus-coverage-relics` | `topps-chrome` | 23 | 0 |
| `topps-chrome-cuts-relics` | `topps-chrome` | 23 | 0 |
| `topps-chrome-coast-to-coast` | `topps-chrome` | 20 | 26 |
| `topps-chrome-combos` | `topps-chrome` | 20 | 6 |
| `topps-chrome-no-limit` | `topps-chrome` | 20 | 10 |
| `topps-chrome-previews` | `topps-chrome` | 20 | 0 |
| `topps-chrome-the-move` | `topps-chrome` | 20 | 4 |
| `topps-chrome-gametime-gear-relics` | `topps-chrome` | 20 | 0 |
| `topps-chrome-second-unit` | `topps-chrome` | 20 | 0 |
| `topps-chrome-1957-58-variations-autographs` | `topps-chrome` | 20 | 0 |
| `topps-chrome-hardwood-heroics` | `topps-chrome` | 19 | 0 |
| `topps-chrome-zone-busters` | `topps-chrome` | 15 | 34 |
| `topps-chrome-fast-and-furious` | `topps-chrome` | 14 | 0 |
| `topps-chrome-lacing-up` | `topps-chrome` | 14 | 0 |
| `topps-chrome-premium-performers` | `topps-chrome` | 14 | 0 |
| `topps-chrome-franchise-fabric-relics` | `topps-chrome` | 13 | 0 |
| `topps-chrome-team-topps` | `topps-chrome` | 12 | 7 |
| `topps-chrome-destination-relics` | `topps-chrome` | 12 | 0 |
| `topps-chrome-refined-remnants` | `topps-chrome` | 12 | 0 |
| `topps-chrome-team-topps-jerseys` | `topps-chrome` | 11 | 0 |
| `topps-chrome-hobby-masters` | `topps-chrome` | 10 | 4 |
| `topps-chrome-in-the-paint` | `topps-chrome` | 10 | 3 |
| `topps-chrome-aptitude-for-altitude` | `topps-chrome` | 10 | 3 |
| `topps-chrome-cards-that-never-were` | `topps-chrome` | 10 | 3 |
| `topps-chrome-mad-game` | `topps-chrome` | 10 | 17 |
| `topps-chrome-shorts-illustrated` | `topps-chrome` | 10 | 0 |
| `topps-chrome-total-recall` | `topps-chrome` | 9 | 0 |
| `topps-chrome-shaq-attack-relics` | `topps-chrome` | 5 | 1 |
| `topps-chrome-declaration-of-independence` | `topps-chrome` | 1 | 0 |

Twelve of the 35 carry pool rows. `topps-chrome-zone-busters` (34),
`topps-chrome-coast-to-coast` (26) and `topps-chrome-mad-game` (17) are the
densest — comps priced against a product that does not exist.

The rekey target is uniform (`topps-chrome`), so this is one report-first lane,
not 35. But the *subset* each phantom key names is real information — the key
`topps-chrome-zone-busters` is the only record that those 15 cards are the Zone
Busters insert. A rekey that drops the name to `topps-chrome` and writes nothing
into the subset/parallel field would collapse distinct inserts into one pool,
which is the same defect in the other direction. **The subset name must land
somewhere before the key is retired.**

### Adjacent, same criterion, different lane

The same scan surfaced 7 keys from other lanes. They are **not** part of the
#1741 phantom set and are listed only so the retire lane does not sweep them up
by pattern:

| setKey | target | rows | poolRows | source(s) |
| --- | --- | ---: | ---: | --- |
| `fleer-ultra` | `ultra` | 3672 | 14 | `cardhedge-graded, checklistinsider-2026-08-27, checklistinsider-2026-08-28` |
| `upper-deck-exquisite` | `upper-deck` | 705 | 1794 | `hobbymonitor-2026-09-04` |
| `topps-bazooka` | `topps` | 1 | 0 | `cardhedge` |
| `upper-deck-ultimate-collection` | `upper-deck` | 1 | 0 | `cardhedge` |
| `upper-deck-exquisite-collection` | `upper-deck` | 1 | 0 | `cardhedge` |
| `fleer-e-x` | `fleer` | 1 | 2 | `cardhedge` |
| `fleer-greats-of-the-game` | `fleer` | 1 | 0 | `cardhedge` |

`fleer-ultra` (3,672 rows) and `upper-deck-exquisite` (705 rows, **1,794 pool
rows**) are large and long-established. `Ultra` and `Exquisite` are arguably real
product families rather than phantoms — `normalizeSetKey` collapsing them to
`ultra` / `upper-deck` may be the *vocabulary* defect rather than the rows being
wrong. **These need a Drew ruling before any rekey**; they are out of scope for
the #1741 cleanup.

---

## What this census does not do

It does not retire, rekey, blank a parallel, or move a comp. Every number above
is a read. The write lane owns:

1. **Acquire first** where the sibling product is absent (`fleer-tiffany`).
2. **Rekey, never drop**, for `sales-attested` rows and anything carrying pool
   rows — a split pool is fixed by consolidation onto the checklist row, with the
   canary at zero (memory: *one card, one row, one pool*).
3. **Preserve the subset name** before retiring a phantom key.
4. **Rule on `fleer-ultra` / `upper-deck-exquisite`** before touching them.
