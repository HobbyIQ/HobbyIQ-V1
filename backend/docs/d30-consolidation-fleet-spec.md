# D30 — one card, one row, one pool: the consolidation fleet

Drew, 2026-08-30 09:50Z: "we need to find any duplicate cards in the card
catalog and consolidate all sales onto it. This will be a big big big issue
for us if sales are split across different cards in the card catalog of the
same card." Rulings 12:50Z: **one fleet, all kinds in parallel**; where two
checklist sources spell one card two ways, **the majority of checklist sources
for that product wins, tie → the longer form**; builders resume when
subagent credits are bought.

## Measured (8 slices, 2026-08-30 09:05–10:30Z, snapshot under three running fleets)

| | |
|---|---|
| un-graded catalog rows | 20,518,726 |
| multi-row groups (same card, >1 row) | **1,102,131** (2,485,267 rows) |
| groups whose SALES are split across rows | **17,762** |
| sales in those groups | **684,571** |
| holdings on a non-winner row | 11 |

By kind (groups): id-setkey-drift 300,221 (the D23 rename mid-flight. NOTE,
CORRECTED 2026-08-30 20:00Z: this originally said `bowman-paper` is "a spelling
the fleet emits that is not in `productSetKeys.ts` — fix the fleet, not the
rows". That is WRONG. `bowman-paper` IS in the table at productSetKeys.ts:159,
`P("bowman-paper", { family: "bowman", parent: "bowman" })`. bowman vs
bowman-paper are two legitimate products, so those groups need a product
RULING, not a rename) · numbered-vs-unnumbered 290,400 · colour-vs-colour-
refractor 201,034 (measured under the rule retracted in D31 — re-measure with the
D31 key) · printrun-conflict 81,987 (NOT duplicates unless one source is wrong) ·
setkey-spelling 31,161 · superfractor-spelling 26,854 · hyphen-spelling 26,736 ·
base-glue 23,006 · refractor-spelling 21,279 · cross-product-cpa 13,869 ·
no-auto-ghost 13,816 · player-differs 12,490 (NOT duplicates) · printing-plate-
spelling 10,596 · true-colour 758 · other small kinds.

Slice JSONs (with top examples and per-group rows/sales/holdings) sit under the
session scratchpad `d30/`; the measure scripts beside them are read-only and
re-runnable — **re-run them before dispatch** (three fleets have moved the
catalog since).

> **STALE NUMBERS.** The by-kind table above predates the purge (81,749 rows),
> D28's repairs and D31. Both measured slices were re-measured under the D31 key
> on 2026-08-30 19:31Z and those numbers supersede these — see the D30 paragraphs
> in `catalog-rebuild-plan.md`. Baseball's colour-vs-colour-refractor fell
> 49,460 → 36,320 under the D31 key (the retracted rule was over-merging) and
> id-setkey-drift 146,196 → 57,088 as the D23 rename lands. The other six slices
> are still UNMEASURED under the D31 key; do not extrapolate the per-kind mix.

## The equivalence key (what "the same card" means) — after D31

`sport | year | product (setKey as the checklist names it; the CPA exception:
bowman/bowman-chrome collapse only for auto-prefixed CPA-style numbers, then the
dedicated-checklist rule decides) | number (hyphen- and case-insensitive,
`sameCardNumber`) | parallel (cleaned: base-/base-cards- glue stripped;
superfractor/superfractors/superfractor-1-refractor one; plural/dup suffixes
one; **a bare colour and `<colour>-refractor` are the SAME card only when no
checklist source names both forms for it** — D31) | auto (a CPA-style prefix is
auto)`. Print run is not in the key (a numbered and an un-numbered twin are one
card when the checklist numbers it); image variations are their own card;
graded children are never duplicates of their parent; a group whose rows name
different players is not a group.

## Winner rules (which row survives), per kind

1. **A checklist-authority row beats every sale-/vendor-minted row**
   (`catalogAuthorityOf`). Two sale-minted rows and no checklist row → the row
   with the most sales survives, flagged `winnerBy: "sales"` — and the card
   joins the acquisition list.
2. **Numbered beats un-numbered** when the checklist numbers the parallel
   (Drew 09:40Z). Two numbered checklist rows with different print runs =
   two cards unless one source is wrong → AMBIGUOUS, listed for Drew.
3. **Spelling between checklist sources:** the majority spelling among the
   checklist sources for that product; tie → the longer form (Drew 12:50Z).
   Compute the majority per (product, parallel family) once, not per card.
4. **CPA product:** the dedicated checklist names the product; bcp-family rows
   fold onto it; two dedicated products listing the number → both stay and
   sales split by the title's product words (Drew 09:40Z). Contradictions with
   `holding-identity-rulings.json` are reported, never silently resolved.
5. **Colour vs colour-refractor (D31):** the checklist row in whichever form
   it names; the twin the retracted rule minted (`ingest-auto-seed`,
   `catalog-explode-actuals`, `sold-comps-stub-*`, `pool`) folds onto it.
   Where checklist sources disagree → rule 3. Where ONE source lists both →
   two cards, not a group.
6. **No-auto ghost at an auto-by-definition prefix** folds onto the auto row.
7. **Hyphen / superfractor / plural / base-glue spellings** fold onto the
   canonical spelling (D23 `sameCardNumber`; D28 base-cards clean).

## The fleet (one script, all kinds, sharded by partition key)

`consolidate-catalog-duplicates.cjs` — MODE=all (kinds in parallel; each kind
also dispatchable alone for a targeted re-run), SLOT/SLOTS by hash of the
group key, CONCURRENCY (runner passes BACKFILL_CONCURRENCY), RUN_MINUTES budget
with the exact marker `stopped at the ${RUN_MS / 60000}-minute budget — the
relaunch continues from here`, `reportWrites` with disjoint counters (groups
scanned = consolidated + ambiguous + not-a-group + failed + not-reached; sales
re-pointed / holdings re-pointed / graded children retired on their own lines),
a banner naming the scope, exit 1 without an explicit scope. Per group: pick
the winner → `catalogRowOps.moveCatalogRow` / fold (vendorIds union, survivor
written first) → `scripts/lib/relocate-sold-comp.cjs` for every sale under a
loser (one identity per row; cardId AND hobbyiqCardId; the pool-only strays
`<winner>:num-M` with no row included) → holdings re-pointed by walking
`Object.values(doc.holdings)` (never a JOIN) → graded children retired
(`isGradedChildOf`, numbered-sibling-safe) → the loser deleted last. Runner
whitelist + marker-keyed relaunch step forwarding slot/slots/mode/scope.
REPORT ONLY first on slot 0/16 with counters by kind; APPLY is Drew's dispatch.

Then: the after-measure (same scripts) — the target is 0 sales-split groups
outside the AMBIGUOUS list — and a nightly `catalog_duplicates` canary axis
(groups by kind, sales split) so a split pool cannot return silently.

## Ambiguous → Drew

The fleet writes `data/catalog-duplicates-ambiguous.json` (group, rows,
sales, why) and the plan doc's NEEDS DREW lists the counts by reason: no
checklist row; two checklist rows of one product with different print runs;
two dedicated products both listing a CPA number where the titles do not say
which; contradictions with the rulings file.

## Guardrails

Never run the write path locally; the runner only; REPORT ONLY first; gate on
exit codes; mutation-check the winner rules; measure before and after; the
catalog is moving under the D23 rename ×16 until it finishes — sequence the
fleet after it, or shard by product family and skip families the rename still
owns.
