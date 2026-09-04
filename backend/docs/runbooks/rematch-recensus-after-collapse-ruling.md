# Re-census after the collapse + coverage rulings (V1, V6)

Drew ruled on 2026-09-03 that product-family **collapse is forbidden** (V1) and
that UNSUPPORTED setKeys are added **by row count, largest first** (V6). Both
change what the derivation reads out of a title, so the 32-slot census measured
on 2026-09-01..03 no longer describes the pool the classifier now sees.

This runbook says **which slots to re-run first**, and why.

---

## What changed, and how many rows it can reach

Aggregated across all 32 census artifacts (16,513,790 rows classified):

| population | rows | what this PR does to it |
| --- | ---: | --- |
| `UNDERIVABLE setkey-unknown-unsupported` | 4,202,405 | 20 new supported keys can now be minted from the title |
| `UNDERIVABLE setkey-bowman-default-unsupported` | 60,810 | now counts as BLANK, so a title-named product is a FILL |
| `CONFLICT changed:setKey` | 1,461,057 | ruled collapses are refused **by name**; title-named refinements become IMPROVE |
| **total reclassifiable** | **5,724,272** | |

**Not all of it is this PR's to move.** 1,733,135 of the `unknown` rows sit in
the four Pokemon-bearing slots (0, 7, 8, 22) and are TCG cards, not sports
products — the vertical refactor is their blocker, not this ruling. Excluding
them:

> **sports-reclassifiable population: 3,991,137 rows**

---

## Which slots carry them

80% of the sports-reclassifiable rows live in **20 of the 32 slots**:

```
1, 2, 5, 9, 10, 11, 14, 15, 16, 18, 19, 20, 23, 25, 26, 27, 28, 29, 30, 31
```

The top of that list, by rows this PR can reclassify:

| slot | reclassifiable | `changed:setKey` | `unknown` (non-Pokemon) | `bowman` default | units |
| ---: | ---: | ---: | ---: | ---: | --- |
| 30 | 250,347 | 14,881 | 235,315 | 151 | 2016, 2017, 1972, 2005, 1950 |
| 11 | 238,388 | 125,817 | 112,250 | 321 | 2024/basketball, 2006, 1948 |
| 26 | 234,392 | 53,693 | 180,638 | 61 | 1997, 1986, 2015, 2013, 1931, 1911 … |
| 18 | 224,050 | 20,519 | 202,170 | 1,361 | 2019, 2024/other, 1984, 1933 |
| 25 | 199,834 | 36,317 | 163,509 | 8 | 1999, 1993, 1973, 1957 |
| 20 | 193,071 | 41,659 | 150,416 | 996 | 2022/h=1of2, 1994, 1983, 2009 |
| 28 | 190,478 | 18,027 | 172,440 | 11 | 2000, 1991, 1969, 1974, 2010 |
| 27 | 180,846 | 52,341 | 120,393 | 8,112 | 1996, 2003, 1961, 1985, 2011 |
| 29 | 179,945 | 14,941 | 163,985 | 1,019 | 2002, 1990, 1970, 1955, 2026/other |
| 2 | 156,937 | 112,671 | 40,851 | 3,415 | 2023/baseball, 2008 |

### Read the two columns separately — they answer different questions

* **`changed:setKey`-heavy slots** (11, 2, 10, 23, 1, 14, 9, 12, 13, 17) are
  where the **collapse refusals** land. These slots are the modern-era shards
  (2023–2026 baseball/football/basketball), which is where Topps Chrome Update,
  Chrome Platinum, Prizm Draft Picks and Donruss Elite actually sell. Run these
  to measure how much of the 1,461,057 `changed:setKey` pile the ruling now
  **names** — and to confirm none of it became writable.
* **`unknown`-heavy slots** (30, 26, 18, 28, 29, 25, 15, 16) are where the **new
  supported keys** land. These are the vintage and mid-era shards, and the keys
  that reclaim them are the ones with the largest UNDERIVABLE counts: `leaf`,
  `flair`, `donruss-studio`, `panini-hoops`, `pacific`.

### Suggested order

1. **Slot 11 and slot 2 first.** They are the two densest `changed:setKey`
   shards (125,817 and 112,671) and they are modern-era, so they exercise every
   ruled Topps Chrome / Prizm / Donruss pair at once. If the ruling is wrong
   anywhere, it is visible here in one run.
2. **Slot 30, 26, 18** next — the three densest `unknown` shards. They measure
   V6: how many of the 4.2M UNDERIVABLE rows the 20 new keys actually reclaim.
3. **The remaining 15 of the 80% list**, in the table's order.
4. **Slots 0, 7, 8, 22 last, and expect little.** Their `unknown` mass is
   Pokemon; this ruling does not touch it, and re-running them early would make
   the reclassification rate look far worse than it is.

---

## What to check in the output

* `CONFLICT changed:setKey` should now carry
  `conflict-setkey-collapses-distinct-product:<from>-><to>` on the ruled pairs.
  **The count of `changed:setKey` should not fall** — a collapse is still a
  CONFLICT. What changes is that it is now named.
* `UNDERIVABLE setkey-unknown-unsupported` should fall by roughly the sum of
  the per-key estimates in the PR body (~1.0M sports rows across the 20 keys).
* `IMPROVE filled:setKey` should rise, and every one of those rows must still
  clear the checklist-backed gate before it is writable. A key with zero
  checklist-backed catalog rows (`panini-hoops`, `panini-rookies-and-stars`,
  `donruss-studio`) must produce **report-only** rows — recognized, not writable.
* **The canary**: no row may become writable on a ruled collapse. The
  classifier pins assert this, and the census banner should show zero writable
  rows carrying a `collapses-distinct-product` reason.

---

## Cost

Census is read-only and shard-parallel; the 32 slots ran in three waves on
2026-09-01..03. Re-running the 20 sports-bearing slots is one wave-and-a-half
at the same budget. Nothing here dispatches a deploy — the census reads
`sold_comps` and writes only its artifact.
