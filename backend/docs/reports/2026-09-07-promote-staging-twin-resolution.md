# Promote Staging Pending: a parked twin is not a twin

**2026-09-07 · #1953 · P0-2 from the go-live audit (PR #1952)**

The hourly staging promoter had been writing nothing for hours. Five of eight
runs in 24 h failed with `WORK VANISHED — UNACCOUNTED 6,557 (100.00% of
intended)`, and every single row was refused by the twin-address guard.

The audit read this as "the guard is right, the upstream write is wrong: these
sales were first written to a base address they do not belong to, and nothing
moves them." Measuring it against the live pool says something different, and
better: **the guard was wrong, in two independent ways, and 87.6% of the
backlog needs no ruling at all.**

## What the numbers actually were

Run `34133391955` (14:31Z): `scanned=6557 tried=6557 inserted=0 deduped=0
skipped=0 catalogUnmatched=0 errored=0`. Every counter zero — which is itself
the tell, because 6,557 rows had to go *somewhere*.

| | |
|---|---:|
| persist calls refused | 6,557 |
| **distinct sale ids** | **461** |
| re-tries per id | ~14 |
| ids also refused in the 13:31Z run | **461 of 461 (100%)** |

The backlog is **permanent, not flowing**. The 461 ids refused at 14:31Z are a
100% subset of the 503 refused at 13:31Z. The same rows, every hour, forever,
because nothing about them could change — a refused row was never flipped off
`pending`, so it was re-scanned on the next run and refused again.

## The two defects, both in one line

```js
const twin = elsewhere.find((r) => r.cardId !== doc.cardId);
if (twin) { ...refuse... }
```

**1. It skipped past the row's own address.** The query returns *every* copy of
the id, including one already at `doc.cardId`. `.find(r => r.cardId !==
doc.cardId)` steps over it and refuses on the first row it finds elsewhere. But
that write is an upsert into a partition that already holds this id — Cosmos
scopes id uniqueness per partition, so it **replaces**. It cannot mint a second
document, which is the only thing the guard exists to prevent.

**2. It counted parked copies as rivals.** #1942's repair lane parks the losing
copy of a duplicate with `flaggedWrong: true`, `flaggedReason:
"duplicate-partition-copy"` and `dedupSupersededBy` **naming the winning
address**. A parked row is out of every pool: it cannot split a pool and it
cannot double-count. That is the entire purpose of parking it.

### Measured, 200 of the 461 ids probed live against `sold_comps`

| what the pool actually holds | n | correct action |
|---|---:|---|
| resident AT the staged address, every other copy already PARKED | 110 | **fold** |
| resident AT the staged address, a live twin elsewhere | 14 | **fold** (+ report the twin) |
| NOT resident, a live twin elsewhere | 76 | **refuse** — a real ruling is owed |

**131 of the 139 parked copies carried `dedupSupersededBy` equal to exactly the
address the promoter was trying to write.** The guard was using the repair
lane's own ruling as a permanent block on the write that ruling authorized.

## The third defect: the ledger had no word for it

`twinAddressRefused` was a counter `persistVendorSalesToPool` incremented and
**nothing read**. The promoter reconciled `intended = written + skipped +
failed`, and a refused row moved none of those — so it fell straight out of the
equation. `UNACCOUNTED 6,557 (100.00%)` was not a lost write. It was an
**unnamed outcome**. A guard that refuses correctly still has to be counted.

This is also why the 20.17% UNACCOUNTED on run `34116917696` (62,632 scanned)
went unexplained: same cause, smaller share.

## The fix

**`backend/src/services/portfolioiq/twinAddressRule.ts`** — the rule extracted
to its own module, because the predicate lived inline in a 1,300-line write
loop where no test could reach it. Three verdicts, exhaustive:

- **`fold`** — already resident here; the upsert is a replace. Enters no new
  sale, so it is not an insert; the write was correct, so it is not a refusal.
  Reported as `twinFolded`.
- **`refuse`** — a live copy holds a different address and this row is not
  resident. Writing would be the split-pool defect. Unchanged behaviour, now
  counted.
- **`write`** — every other copy is parked, so the sale has no live home.

**`promote-staging-pending.cjs`** — counts both outcomes, flips them off
`pending` (a folded row is done; a refused row cannot change on a re-run), and
prints the ledger as an equation it checks itself:

```
tried = inserted + deduped + skipped + catalogUnmatched + twinFolded + twinRefused + errored
```

A folded row flips to `already-in-pool`; a refused row flips to
`twin-address-refused`, which hands it to the dedup lane instead of the
promoter's next budget. Neither is `promoted`: neither inserted a sale.

## The refusals that remain — report only

`report-staging-twin-resolution.cjs` resolves the genuinely-refused ids against
the live pool and the catalog, applies **#1942's `decideCanonical` unchanged**,
and emits a `relocate-pool-rows-by-list` file. It writes nothing to Cosmos.

Run against the full 461 on 2026-09-07:

```
[twin-report] catalog: 157 of 994 distinct addresses are checklist-backed
    404  ALREADY RESOLVED (<=1 live copy) — no action
     36  PARK-NEITHER-QUALIFIES
     16  CANONICAL
      5  PARK-BOTH-QUALIFY
     71  PARK entries
```

**404 of 461 (87.6%) needed no ruling at all** — only the guard fix. The
remaining 57 get 71 park entries, awaiting Drew's APPLY.

## I5 ONE-SALE-ONE-ADDRESS — the 7 sales

`data/pool-relocations/2026-09-07-i5-one-sale-one-address.json`, same rule:

```
      4  PARK-NEITHER-QUALIFIES
      3  ALREADY RESOLVED (<=1 live copy) — no action
      7  PARK entries
[twin-report] catalog: 0 of 17 distinct addresses are checklist-backed
```

**Not one of the 17 addresses is checklist-backed**, so #1942's rule promotes
nothing and parks every extra — a sale never mints an identity from itself
(CF-CATALOG-MATCH-IS-SELF-CONFIRMING). The audit's read that this sits in the
2024 football Optic fold is confirmed: `donruss-optic` / `panini-optic` /
`panini-donruss` rival readings of one card, plus `player-…` and `pf-…`
catch-all buckets.

`tca-ebay::168438810461` in 4 partitions is the worst:

```
  hiq:football:2024:donruss-optic:201:ssp:no-auto
  hiq:football:2024:donruss-optic:201:image-variation-ssp:no-auto
  hiq:football:2024:panini-optic:201:base:no-auto
  hiq:football:2024:panini-donruss:201:image-variation-ssp:no-auto
```

Apply (Drew's go, not this session's):

```
SCOPE=data/pool-relocations/2026-09-07-i5-one-sale-one-address.json \
  BACKFILL_APPLY=true node scripts/relocate-pool-rows-by-list.cjs
```

## The mirror-image trap, caught on review

A `fold` deliberately falls **through** to the upsert — the replace is the
point — and the write door ends with `result.inserted++`. So a folded row moved
*both* counters, and the new ledger would have **over-accounted** by exactly the
fold count: 124 of every 200 rows on the measured backlog.

`reportWrites` treats over-accounting as loudly as a shortfall, and rightly —
it means a counter is being incremented on a path it does not own, so none of
the other numbers can be trusted. The fix for `UNACCOUNTED` would have shipped
its own mirror image. `inserted` now means what its name says: a **new** sale
entered the pool. The write still happens; only the counter moves.

## Verification

- `npx tsc --noEmit` clean.
- `twinAddressRule.test.ts` — 11 tests, **mutation-checked three ways**:
  restoring the original one-line predicate turns **6 red**; dropping only the
  parked-is-not-a-twin half turns **3 red**; dropping only the residency half
  turns **3 red**. Each branch is pinned independently.
- Affected suites green: `everyWriteJobReconciles`,
  `oneSaleOneDocumentAcrossPartitions`, `oneSaleOneAddress`,
  `persistVendorSalesToPool`, `duplicateSaleIdsRule`.
- **CI green on the head sha** (`Backend Unit Tests` + `Web Unit Tests`). The
  local full-suite run shows 15 unrelated files red — ingest-driver, pokemon,
  scc, ebay and portfolio lanes, none of them in this diff and none of them
  reachable from it; CI is green on the same commit, which is the reference.

## What this does NOT do

It does not adjudicate the 57 ids with genuine rival addresses — that is a
ruling, it is report-only here, and it needs Drew's APPLY. It does not touch
the Optic fold's product-naming ambiguity, which is the shared root of P0-2 and
P1-1 and outlives both. And it writes nothing to prod: this session ran the
report lane read-only.
