# Split-identity pool rows — the whole-corpus census (#1919)

**2026-09-07 · READ ONLY · nothing was written to Cosmos by this work.**

The #1919 Crown Zenith finding was 489 rows. This is the same question asked of
the whole pool: how many `sold_comps` rows carry a `cardId` (the partition key)
whose **sport** segment disagrees with their `hobbyiqCardId` (the canonical
slug), how did they get that way, and what can actually repair them.

---

## 1. Method, cost, and reconciliation

The natural query — `WHERE c.cardId != c.hobbyiqCardId` — is not index-served:
a field-to-field comparison falls back to a full scan of a 16.9M-row container
and dies before returning. Every pattern that works has the same shape: an
**indexed range server-side, the field compare client-side**. So the corpus was
walked in `_ts` windows (indexed, present on every row), bisected until each
window held ≤120k rows, sharded 64 ways at concurrency 8.

The classifier is the committed one — `backend/scripts/lib/split-identity.cjs`,
the same predicate the existing census, the rematch classifier and the invariant
auditor decide with. It was not reimplemented for this report.

| Measurement | Value |
|---|---|
| Corpus (bounded `_ts` range count) | **16,901,461 rows** — 209 RU, 714 ms |
| Rows classified | **16,596,692** |
| Rows planned | 16,598,354 (delta 1,662 = **0.0100%**, live ingest during the walk) |
| Throughput probe before the scan | **1,497 rows/s, 44 RU per 1,000 rows** |
| Shards | 64, all completed; **no shard hit a budget stop** |
| Reconciliation | class counts sum to **16,596,692 = rows scanned** ✅ |

A bare cross-partition `SELECT VALUE COUNT(1)` was never issued; the corpus
count above is bounded by the indexed `_ts` range.

### Classes over the whole corpus

| Class | Rows | Share |
|---|---:|---:|
| `VENDOR-DESIGN` (designed vendor partition, **not** damage) | 12,960,841 | 78.09% |
| `COHERENT` | 2,567,129 | 15.47% |
| `HIQ-SPLIT` (**the damage class**) | 1,068,722 | 6.44% |

`VENDOR-DESIGN` is load-bearing and exempt: a vendor ingest partitions under the
vendor's own product id (12,959,497 Bubble ids) and carries our slug beside it.
The fields disagree **by construction**. Counting those as damage would drown
the real finding, exactly as #1650 established.

---

## 2. The sport-mismatch class

> **94,275 rows** carry a `cardId` whose sport segment differs from their
> `hobbyiqCardId` — 0.57% of the corpus, 8.82% of all HIQ-SPLIT rows.

### By sport pair (`sport(cardId)` → `sport(hobbyiqCardId)`), top 20

| Rows | Pair |
|---:|---|
| 26,499 | baseball → pokemon |
| 19,432 | baseball → soccer |
| 10,105 | baseball → football |
| 9,547 | baseball → basketball |
| 5,901 | basketball → baseball |
| 5,827 | football → baseball |
| 3,826 | baseball → wrestling |
| 3,291 | hockey → baseball |
| 2,612 | baseball → mma |
| 1,267 | baseball → hockey |
| 802 | hockey → pokemon |
| 743 | hockey → football |
| 525 | basketball → football |
| 427 | basketball → pokemon |
| 369 | hockey → basketball |
| 347 | non-sport → baseball |
| 335 | soccer → baseball |
| 300 | pokemon → baseball |
| 270 | sight → soccer |
| 176 | hedge → soccer |

`baseball` is the origin of 78,153 of the 94,275 (82.9%). That is the signature
of a **default**, not a mistake spread evenly across verticals — see §4.

Two pairs name no sport at all: `sight → soccer` (270) and `hedge → soccer`
(176). Those `cardId`s are truncated vendor prefixes (`hiq:sight:…`,
`hiq:hedge:…`) — a separate malformation worth its own look.

### By source

| Source | Rows |
|---|---:|
| tca-ebay | 88,165 |
| cardhedge | 4,218 |
| cardsight | 1,891 |
| ebay-user-sale | 1 |

The single `ebay-user-sale` row is user-sourced and therefore **PROTECTED** —
report-only forever, whatever its shape.

---

## 3. The broader split: same sport, different setKey or year

> **483,671 rows** agree on sport but disagree on `setKey` or `cardYear`.

This is five times the sport class and is dominated by the product-family ladder
rather than by verticals.

### Top 20 `fromKey → toKey` pairs

| Rows | sport: fromKey → toKey |
|---:|---|
| 49,026 | baseball: topps-chrome → topps |
| 45,568 | baseball: bowman-chrome → bowman |
| 41,209 | baseball: topps → topps-series-1 |
| 24,984 | baseball: panini-donruss → donruss |
| 22,314 | baseball: topps → topps-series-2 |
| 16,420 | baseball: bowman → bowmans-best |
| 16,298 | baseball: topps-update → topps |
| 14,520 | baseball: finest → topps-finest |
| 10,612 | baseball: topps-update → topps-update-series |
| 9,737 | baseball: topps-chrome → topps-chrome-update-series |
| 8,664 | baseball: bowman → bowman-chrome |
| 8,498 | baseball: topps-finest → topps |
| 8,243 | baseball: topps-chrome → topps-chrome-platinum |
| 7,163 | basketball: topps-chrome → topps |
| 6,191 | basketball: topps-chrome → topps-chrome-update-series |
| 5,199 | baseball: topps-chrome-update → topps-chrome-update-series |
| 4,759 | baseball: topps-chrome-update → topps-chrome |
| 4,728 | football: topps-chrome → topps |
| 4,369 | baseball: bowman → bowman-platinum |
| 4,258 | baseball: upper-deck → unknown |

Most of these are the **flagship catch-all** swallowing a specialization
(`topps-chrome → topps`, `bowman-chrome → bowman`) or a naming-convention drift
(`topps → topps-series-1`, `finest → topps-finest`). Per the Bowman setKey
taxonomy ruling, `bowman` and `bowman-chrome` are **different cards** — so these
are genuine split pools, not cosmetic key drift. They are out of scope for this
repair and want their own ruling; the vocabulary decision has to come first.

Year disagreements are rare (1,058 rows on the `cardYear` segment) and look like
genuine data errors (`baseball:2023 → 1951`, `baseball:1991 → 2026`).

`sameSport` splits by source: tca-ebay 270,182 · cardsight 122,606 · cardhedge
90,814 · ebay-user-purchase 49 · ebay-account 11 · ebay-user-sale 7 ·
manual-user-entry 2.

---

## 4. What a split row does to the two pools

`backend/src/services/compiq/exactPoolReader.ts` builds one predicate:

```
WHERE … AND (c.cardId = @cid OR c.hobbyiqCardId = @hiq)
```

**Within one pool read, a split row is returned exactly once.** `OR` is a
predicate over documents, not a join: a document satisfying both disjuncts still
satisfies the `WHERE` clause once. There is no self-join and no `UNION ALL`, so
no in-process dedupe by `id` is needed to make a single pool correct — and none
is *possible*, because the projection does not select `c.id` at all.

**Across two pool reads, the same document is counted in both.** A read for the
baseball card matches on `cardId`; a read for the pokemon card matches the *same
document* on `hobbyiqCardId`. Each pool is internally consistent — one row,
counted once — which is precisely why no per-pool audit can see this. One sale
prices two cards, and in one of the two pools it is the wrong sport entirely.

`dedupeSoldComps` cannot help: it clusters on *(grade, price-to-the-cent, within
60 min)* to collapse the same sale ingested by several vendors. The two copies
here are never in the same array, so there is nothing for it to collapse.

### A guard already exists, and it is not enough

`identityUnionGuard.mayUnionIdentities` compares `sport:year:setKey` and the
reader calls it. Measured while writing the pin: for a caller naming
`cardId=hiq:baseball:2023:crown-zenith:…` and
`hobbyiqCardId=hiq:pokemon:2023:crown-zenith:…`, the guard **refuses** the union
and the query goes out **single-sided** on `cardId` alone.

That is real protection, and it is why the damage is not worse. But it only
fires when one caller hands both halves to one read. The cross-pool double-count
happens in **two separate reads**, each naming one identity, where no guard ever
has both halves in front of it. **The defect is in the stored row, so the repair
belongs in the data — not in the reader.**

---

## 5. Root cause, and it is still live

`recordSoldComp` (`backend/src/services/portfolioiq/soldCompsStore.service.ts`)
takes the caller's `cardId` **verbatim** and derives `hobbyiqCardId` **itself**:

```ts
1372:    cardId: input.cardId.trim(),          // caller's, never re-derived
 906:    const sportForSlug = input.sport ?? inferSportFromContext(input.setName, input.title, input.cardYear);
1416:    hobbyiqCardId,                        // derived here, independently
```

Nothing in the derivation reads `input.cardId`, and **no write-time guard
compares the two fields**. `identityUnionGuard` is imported by exactly three
call sites, all read-side.

`inferSportFromContext` is where `baseball` comes from. It is a text heuristic
over `setName + title` with baseball-favouring rules (`/\bbowman\b/ →
baseball`, `topps chrome → baseball`, plus a vintage-flagship fallback). A
Pokémon sale whose title the *old* heuristic did not recognise got `baseball`;
later Pokémon vocabulary work taught the derivation to answer `pokemon` — but
only `hobbyiqCardId` was ever rewritten.

`backend/scripts/backfill-hobbyiq-cardid.mjs` is where that asymmetry became
2.4M rows wide. It patches one field:

```js
80:        { op: "add", path: "/hobbyiqCardId", value: hobbyiqCardId },
```

It **cannot** fix `cardId` — a Cosmos partition key is immutable, so changing it
means writing a new document and deleting the old one. It also calls
`inferSportFromContext(row.setName, row.title)` with **two** arguments where the
ingest path passes three (no `year`), so the backfill and the ingest can infer
*different sports for the same row*.

`labeler.service.ts:354` does the same thing at runtime (`row.hobbyiqCardId =
newSlug` with `cardId` untouched), so it is a continuing generator, not only a
historical one.

**Still live: yes.** 3,398 rows carrying a sport mismatch were written in the 7
days before the census, the most recent on 2026-09-04. Examples:

```
2026-09-04  tca-ebay   hiq:gaming:2022:na:nno:base:no-auto
                    || hiq:pokemon:2022:na:player-pokemon-swsh-bs-promo:base:no-auto
2026-09-04  cardhedge  hiq:pokemon:2000:2000-pokemon-game-movie:nno:base:no-auto
                    || hiq:basketball:2000:unknown:player-pokemon-ancient-mew-promo:base:no-auto
2026-09-04  tca-ebay   hiq:baseball:2025:topps-chrome:rpa-ac:gold-refractor:auto:num-50
                    || hiq:football:2025:topps-chrome:rpa-ac:gold-refractor:auto:num-50
```

Note the second: here `cardId` is right and `hobbyiqCardId` is wrong. The defect
runs in **both directions**.

---

## 6. The repair vehicle

### Not the rematch

`rematch-sold-comps.cjs` *can* move partitions (it imports `relocateSoldComp`),
so the mechanism is not the obstacle — the **classifier** is. A re-derived
identity that is *different but not more specific* is `CONFLICT`, and CONFLICT
is listed under "WHAT NEVER WRITES, EVER" (only the BASE-EVICTION subclass is
exempt, and that is about parallels). A changed **sport** segment is `changed`
→ CONFLICT → report-only. The rematch would look at all 94,275 rows and write
none of them.

### Lists — but PARK, not RELOCATE

`relocate-pool-rows-by-list.cjs` is the right lane: the list *is* the scope, it
supports RELOCATE (new doc + verified delete, since the partition key is
immutable), REPOINT, RETIRE and PARK, and it is report-first.

Two measurements decided the **shape**, and both argue against moving anything:

**(a) `hobbyiqCardId` is not automatically the winner.** On same-setKey sport
splits where the setKey itself is an unambiguous tell:

| Verdict | Rows |
|---|---:|
| `hobbyiqCardId` correct | 2,330 |
| `cardId` correct | 1,203 |
| neither matches the tell | 395 |

A blanket REPOINT toward `hobbyiqCardId` would corrupt roughly a third of the
class. "hobbyiqCardId is canonical" is true as a *convention* and false as a
*fact about these rows*.

**(b) The destinations do not exist.** For the narrowest, cleanest sub-class —
sport-only splits where every other segment already agrees and the setKey is an
unambiguous Pokémon TCG set — the pokemon destinations were checked live against
`card_catalog` (batched `IN` queries, read-only):

> **0 of 1,218** distinct destinations are present. Not one.

Relocating 7,996 sales onto slugs no checklist names would mint 1,218 identities
whose only evidence is the sales themselves — precisely what
CF-CATALOG-MATCH-IS-SELF-CONFIRMING forbids, and what the 2026-09-06 non-sport
Topps lane already ruled on. The catalog is contaminated with the same defect
(`hiq:hockey:2023:swsh09-brilliant-stars:…`, source `ingest-auto-seed`), so it
cannot be used to justify a destination either.

**Therefore: PARK.** `identityUnverified` keeps the row out of *every* pool
without asserting which card it belongs to — it ends the double-count without
guessing. The pools stay wrong on purpose until a Pokémon checklist can name
these cards.

### The lists

`backend/data/pool-relocations/2026-09-07-split-identity-sport-segment-{01..04}.json`
— 7,996 entries total (2,000 / 2,000 / 2,000 / 1,996), split only to keep each
diff reviewable; each file is an independent scope.

Scope: sport-only splits, `hobbyiqCardId` sport = `pokemon`, unambiguous Pokémon
setKey, every other segment already identical, source `tca-ebay`. Origin sports:
baseball 2,311 · hockey 96 · basketball 37 · gaming 1 (of the sampled subset).

**Deliberately excluded** and left for a ruling: the 86,279 sport-mismatch rows
outside this sub-class (ambiguous direction), all 483,671 same-sport
setKey/year splits (needs the product-family vocabulary decision first), the one
`ebay-user-sale` row (PROTECTED), and every `VENDOR-DESIGN` row (by design).

### REPORT ONLY run against prod — the reconciliation

```
scope file              data/pool-relocations/2026-09-07-split-identity-sport-segment-04.json
entries in scope        1,996
excluded by the audit   0   <- deliberately NOT moved

REPORT ONLY — nothing written
  entries in scope        1,996
  RELOCATED (partition)   0
  REPOINTED (hiqCardId)   0
  RETIRED (flaggedWrong)  0   <- marked, never deleted
  PARKED (identityUnver.) 1,996   <- no pool, no guess
  already at the target   0
  not found at fromCardId 0
  failed                  0
  duplicates left in pool 0   <- must be 0
  third-slug hobbyiqCardId 0   <- overwritten to the target, listed above
```

Every one of the 1,996 rows resolved live at its stated `fromCardId`: zero
not-found, zero failed, zero already-parked. The list is accurate against the
live container.

---

## 7. What is pinned

`backend/tests/exactPoolNeverCountsARowTwice.test.ts` (7 tests) pins the
reader's behaviour so §4 cannot silently stop being true:

- a row matching **both** disjuncts is returned **once**;
- the query has one `FROM`, no `JOIN`, no `UNION`;
- the projection does **not** select `c.id` — so the "no dedupe by id exists"
  reasoning fails loudly if a future change adds it;
- duplicate union keys are collapsed before they are bound;
- a **cross-sport** caller union is refused and the query goes **single-sided**;
- the same document reaches **both** pools across two reads (the damage), and a
  **coherent** row reaches only its own (the control that shows the data repair
  is the fix).

Mutation-checked: neutralising the guard call in `exactPoolReader.ts` turns the
file red.

---

## 8. Recommended next steps

1. **Stop the bleed.** Add the write-time guard `recordSoldComp` never had —
   `mayUnionIdentities(doc.cardId, doc.hobbyiqCardId)` between the doc literal
   and the upsert. It already fails open for vendor ids
   (`productIdentityOf` → null for non-`hiq:` strings), so the designed
   CardHedge partition is unaffected. Refuse or log; do not guess.
2. **Fix the backfill's inference drift** — `backfill-hobbyiq-cardid.mjs:153`
   passes two args to `inferSportFromContext` where ingest passes three.
3. **Apply the PARK lists** once reviewed (four dispatches, report-first).
4. **Rule on direction** for the remaining 86,279 sport-mismatch rows — they
   need a per-row tell, not a convention.
5. **Rule on the product-family ladder** before touching the 483,671 same-sport
   splits.
6. **Clean the catalog seeds** — `ingest-auto-seed` rows carry the same wrong
   sport, so the catalog cannot currently arbitrate these repairs.
7. Look at `hiq:sight:…` / `hiq:hedge:…` truncated-prefix cardIds (446 rows).
