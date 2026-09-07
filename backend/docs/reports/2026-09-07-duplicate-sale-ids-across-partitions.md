# One sale, two documents — sale ids resident in more than one partition

**2026-09-07 · READ ONLY · nothing was written to Cosmos by this work.**

#1936 found 1,444 `sold_comps` sale ids existing as MULTIPLE documents under
different `cardId` partition keys. This asks the same question of the pool,
finds the writer that makes them, and ships the repair lists.

**This report is HONEST ABOUT ITS COVERAGE.** The whole-corpus number is NOT
measured here — see §1. What IS measured is a complete, reconciled 3,001,765-row
sample; a live validation of the repair list against prod; and a root cause
proven from the source, not inferred from the sample.

---

## 1. What was measured, and what was not

| Measurement | Value |
|---|---|
| Corpus (bounded `_ts` range count) | **16,906,714 rows** |
| Throughput probe before the scan | **10,149 rows/s, 41.5 RU per 1,000 rows** |
| Rows scanned (this report's sample) | **3,001,765** — slot 0 of 64 by id hash |
| Reconciled | `dupDocs 512 = dupIds 255 + excess 257` ✅ |

A bare cross-partition `SELECT VALUE COUNT(1)` was never issued; the corpus
count is bounded by the indexed `_ts` range, as #1924/#1936 established.

### Why the whole-corpus sweep is not in this report

Two full-corpus passes (32 id-slots each) **completed their 16.5M-row scans**
and were then killed during the catalog-resolution phase, producing **no
artifact at all**. That is a defect in this lane, and it is FIXED here rather
than worked around:

- the scan result is now **checkpointed to disk BEFORE** the expensive catalog
  phase, so a killed run leaves a usable census naming every duplicate;
- the catalog phase is **bounded by the same budget** as the walk and reports
  `TRUNCATED` rather than dying with nothing;
- the cost that made it expensive is now **measured and documented**: one
  100-address `IN` batch against `card_catalog` costs **504 RU and ~2.2s** at
  the RU floor, so the phase is minutes per thousand distinct addresses and
  dominates the lane.

The lane is wired into `backfill-runner.yml` (READ ONLY, APPLY refused, budget
relaunch) so the whole-corpus sweep runs there across all 64 slots. **Do not
quote a whole-pool total until that fan-out lands.** Scaling the sample would
give roughly 45k ids, but that is an extrapolation and is deliberately not
stated as a finding.

---

## 2. The sample, measured

> **255 of 1,492,330 distinct ids in the sample are resident in more than one
> partition** — 512 documents where there should be 255, an excess of **257**.

| | |
|---|---:|
| ids in >1 partition | **255** |
| ids in >2 partitions | **2** |
| duplicate DOCUMENTS | **512** |
| excess documents | **257** |

### By source

| Source | dup ids |
|---|---:|
| tca-ebay | 225 |
| cardsight | 30 |

**Every duplicate is vendor-sourced.** No `ebay-user-*` or `manual-user-entry`
id appears — which is the finding's own explanation (§4).

### By sport pair of the two partitions

| Rows | Pair (older → newer) |
|---:|---|
| 117 | baseball → baseball |
| 47 | pokemon → pokemon |
| 22 | football → football |
| 16 | baseball → soccer |
| 15 | hockey → hockey |
| 15 | basketball → basketball |
| 5 | hockey → baseball |

**222 of 255 (87%) are same-sport.** This is NOT the #1924 sport-mismatch
class wearing a different hat; it is a product-identity change within one
sport, which is what §3 predicts.

### By `_ts` of the newer copy — is an emitter still writing?

| Day | ids |
|---|---:|
| 2026-08-10 | 86 |
| 2026-08-11 | 33 |
| 2026-08-15 | 15 |
| 2026-08-16 | 55 |
| 2026-08-17 | 55 |
| 2026-08-18 | 1 |

> **STILL LIVE: NO.** The newest duplicate copy in the sample was written
> **2026-08-18**, and **0 ids** have a copy written in the last 7 days. The
> population is a bounded historical episode (2026-08-10 → 08-18), not an
> ongoing bleed.

That does **not** make the writer safe — the code path that produced them is
still reachable, and §5 pins it shut.

### Does the newer copy carry a different `hobbyiqCardId`?

| | ids |
|---|---:|
| newer `hobbyiqCardId` DIFFERS from older | 178 |
| newer SAME as older | 77 |
| newer copy is address-coherent | 133 |
| older copy is address-coherent | 131 |

---

## 3. Root cause — and it is `makeId`, not a relocate lane

`soldCompsStore.service.ts:581`:

```ts
function makeId(source, externalId, cardId, soldAt) {
  if (externalId && externalId.trim().length > 0) {
    return `${source}::${externalId.trim()}`;     // <- cardId NOT in the id
  }
  return `${source}::${cardId}::${soldAt}`;
}
```

**When the source provides an external id — and every vendor source does — the
id does not contain `cardId`.** `sold_comps` is partitioned on `/cardId`, so:

1. a vendor listing is ingested; the parser cannot place the product and files
   it under `…:unknown:…`;
2. the parser later learns the setKey (the #1911/#1914/#1918/#1922 work did
   exactly this, in this window);
3. the same listing is re-ingested. `makeId` mints the **same id**; the derived
   slug now names a **different partition**;
4. `items.upsert` **creates** rather than replaces — a partitioned upsert only
   replaces within a partition — and nothing deletes the old document.

**The measured signature confirms it: 97 of 255 (38.0%) have an older copy on
`setKey=unknown` and a newer copy on a real setKey.** Example, from the census:

```
tca-ebay::267679692186
  2026-08-06  hiq:hockey:2024:unknown:97:base:no-auto
  2026-08-10  hiq:hockey:2024:bowman:97:base:no-auto
```

### The lanes that were suspected, and why they are NOT the cause

- **`relocate-pool-rows-by-list` / `rematch-sold-comps`** use `relocateSoldComp`
  (write-new → verify → delete-old). That helper CAN leave two documents — on a
  verify mismatch or a failed delete — but it **reports them** as
  `duplicatesLeft`, and both lanes print `duplicates left in pool` in their
  banner. It is instrumented, bounded, and not the shape of this population.
- **`tca-match-enricher`** re-keys delete-then-create. That shape **loses** a
  row (D18); it cannot duplicate one.
- **`backfill-hobbyiq-cardid.mjs`** patches `hobbyiqCardId` in place only. A
  partition key is immutable, so it cannot create a second document.
- **`labeler.service.ts`** was already fixed for #1924 and now refuses
  cross-product rows rather than rewriting one half.

### Why nothing already in the store catches it

- the **partition-scoped contentHash probe** hashes `cardId`, so the two copies
  cannot collide by construction;
- the **cross-partition probe** keys on `hobbyiqCardId` — the very field that
  just changed — and was gated to user-scoped sources;
- **`dedupeSoldComps`** clusters within ONE array; the copies are never in the
  same array.

---

## 4. Why this is worse than a split row, and invisible to every audit

`exactPoolReader` builds `WHERE … AND (c.cardId = @cid OR c.hobbyiqCardId = @hiq)`.

A split **ROW** satisfies both disjuncts and is still returned **once** —
#1924 §4 measured it and `exactPoolNeverCountsARowTwice.test.ts` pins it.

Two **DOCUMENTS** are two rows. Each pool's read finds exactly one of them, so:

- every per-pool audit reconciles — one row, counted once;
- the reader's identity-union guard never holds both halves;
- the sale is nevertheless priced into **two pools**.

**A guard already existed for exactly this** — `CF-ONE-TRANSACTION-ONE-ROW`
(D9), which queries `c.id = @id AND c.cardId != @cardId`. It was gated
`isUserScoped &&`, and the population is **100% vendor-sourced**. The guard was
built for this defect and pointed away from where it happens.

---

## 5. The fix

`recordSoldComp` — the gate becomes the **id shape**, which is what actually
determines the hazard:

```ts
- if (isUserScoped && input.sourceExternalId && …)
+ if (input.sourceExternalId && …)
```

**The remedy stays per source, because the doctrine differs:**

- a **user transaction** is one row by definition — the id IS the order — so a
  copy under another slug is a stale filing and the D9 **delete** is unchanged;
- a **vendor sale** is a real observation of a real price, so
  CF-A-RETIRE-IS-A-MARKER-NEVER-A-DELETE governs: the older copy is
  **`flaggedWrong: true`** with `flaggedReason: "duplicate-partition-copy"` and
  `dedupSupersededBy` naming the id's new home. Marked, never deleted, and
  reversible.

**Measured cost:** the probe is cross-partition at **28.25 RU and ~1.0s** per
call. It is one point-shaped probe (`c.id = @id`) per written row, flat in
corpus size, and it runs only where an externalId keys the id. The alternative
is a sale resident in two pools that no reader-side guard can see. If it ever
becomes the ingest bottleneck, the real fix is putting `cardId` back into
`makeId` for vendor sources — which makes the collision impossible rather than
detected — but that re-keys stored rows and belongs in its own audited lane.

### Pinned

`backend/tests/oneSaleOneDocumentAcrossPartitions.test.ts` (5 tests) drives the
REAL `recordSoldComp` against a fake container that keys on `(cardId, id)`
exactly as Cosmos does, so the same id under a new partition genuinely creates a
second document:

- a re-ingest under a new setKey leaves **one live row**, the older copy flagged;
- a vendor copy is **never hard-deleted**;
- a **user** transaction keeps the D9 delete;
- a re-ingest at the **same** address is a replacement, not a duplicate;
- the guard is keyed on the **externalId**, not on the source being user-scoped.

**Mutation-checked:** restoring `isUserScoped &&` turns **3 of 5 red**.

`backend/tests/duplicateSaleIdsRule.test.ts` (15 tests) pins the census rules —
most importantly the **shard axis**: a duplicate's copies were written at
different times, so a `_ts`-sharded slot would see one copy, call the id unique,
and **report zero while reconciling honestly**. Sharding is on `hashId(id)`.

---

## 6. The repair — PARK, never delete

**Canonicity is evidence, not convention.** #1924 §6 measured
"`hobbyiqCardId` is canonical" and found it false about a third of the time. The
rule here is **address coherence** (the partition matches the copy's own
`hobbyiqCardId`) **AND** a `card_catalog`-backed destination:

| Verdict | ids | Meaning |
|---|---:|---|
| `CANONICAL` | 87 | exactly one copy qualifies — the extra is parked |
| `PARK-NEITHER-QUALIFIES` | 168 | no evidence promotes either — all extras parked |

Catalog check: **166 of 510** distinct duplicate addresses resolve to a
`card_catalog` row (batched `IN`, read-only).

`identityUnverified` keeps a copy out of **every** pool without asserting which
card it belongs to. It ends the double-count without guessing, and it is
reversible.

**List:** `backend/data/pool-relocations/2026-09-07-duplicate-partition-copies-01.json`
— 257 entries, each addressing ONE document by `(id, fromCardId)`, which is the
granularity this defect needs and the key #1936's tranche 2 used.

### REPORT ONLY run against prod — the reconciliation

```
scope file              data/pool-relocations/2026-09-07-duplicate-partition-copies-01.json
entries in scope        257
excluded by the audit   0   <- deliberately NOT moved

REPORT ONLY — nothing written
  entries in scope        257
  RELOCATED (partition)   0
  REPOINTED (hiqCardId)   0
  RETIRED (flaggedWrong)  0   <- marked, never deleted
  PARKED (identityUnver.) 238   <- no pool, no guess
  already at the target   19
  not found at fromCardId 0
  failed                  0
  duplicates left in pool 0   <- must be 0
  third-slug hobbyiqCardId 0   <- overwritten to the target, listed above
```

**Zero not-found and zero failed:** every one of the 257 documents resolved live
at its stated `fromCardId`. The 19 "already at the target" are copies a prior
lane had already parked. The list is accurate against the live container.

---

## 7. Next steps

1. **Run the whole-corpus census** through `backfill-runner.yml`
   (`census-duplicate-sale-ids`, all 64 slots, `apply=false`) and publish the
   real total. The checkpointing in §1 means a killed shard now leaves evidence.
2. **Apply the PARK list** once reviewed — report-first, one dispatch.
3. **Consider putting `cardId` back into `makeId`** for vendor sources, in its
   own lane: it makes the collision impossible rather than merely detected.
4. **Re-measure liveness after the fix ships.** The population stopped on
   2026-08-18; the guard should keep it at zero.
