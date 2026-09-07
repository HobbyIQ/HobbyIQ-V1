# `ingest-auto-seed` catalog rows carrying a sport their checklist denies

**2026-09-07 · READ ONLY · nothing was written to Cosmos by this work.**

The #1924 census closed on a recommendation it could not act on: *"Clean the
catalog seeds — `ingest-auto-seed` rows carry the same wrong sport, so the
catalog cannot currently arbitrate these repairs."* This measures that class,
and answers whether the retire lane already scheduled for these rows would in
fact reach them.

It is the catalog half of the same defect. The pool half — the write-time
guard and the removal of the `baseball` fallbacks — ships in this PR.

---

## 1. Does the emitter still exist?

Yes, and it is **already correctly gated**. `ensureCatalogRow` mints
`source: "ingest-auto-seed"` rows, but `recordSoldComp` only calls it for
`USER_SEED_SOURCES` — `ebay-user-purchase`, `ebay-user-sale`,
`manual-user-entry`, `user-verified`. That gate is CF-SALES-DO-NOT-MINT-CARDS
(Drew, 2026-08-28) with Drew's own 2026-08-08 carve-out: *a card the user
physically owns is real coverage even before its checklist is acquired.*

So the 447,811 auto-seed rows on disk are overwhelmingly **historical** — minted
before that gate landed, when any vendor sale that matched nothing minted a row
at its own parser slug. No VENDOR sale mints a catalog row today.

This PR narrows the surviving gate by one case: **a row the split-identity
guard just PARKED seeds nothing.** A parked row has no identity we stand behind
— that is what parking means — so seeding from it would mint a card at an
address the guard has already refused to file the sale under.

## 2. The measurement

Method: `card_catalog` grouped by `setKey` for every sport carrying auto-seed
rows (1,581 distinct setKeys), then one `GROUP BY year, sport, source` per
setKey. A product is `(year, setKey)`; its **attested** sport is the sport
holding the most CHECKLIST-backed rows in that product-year, using
`retire-self-derived-identities.cjs`'s own `isChecklist` predicate rather than a
reimplementation.

Cost: **723,947 RU, 78 seconds**, 8-way concurrency. No cross-partition
`COUNT(1)` was issued.

A seed row counts as DISAGREEING only when its product-year holds **zero**
checklist rows in the seed's own sport. A product-year whose top two sports are
within 20% of each other is `ambiguous` — genuinely cross-sport products
(`score`, `donruss-elite`) are not defects.

| Class | Rows | Share |
|---|---:|---:|
| agree (or the seed's sport IS attested in that product-year) | 277,998 | 62.1% |
| **DISAGREE** | **32,044** | **7.2%** |
| no checklist attestation for the product-year | 79,296 | 17.7% |
| ambiguous (product-year genuinely spans sports) | 59,223 | 13.2% |
| total | 447,811 | |

### By sport pair (`autoSeedSport -> checklistAttestedSport`), top 20

| Rows | Pair |
|---:|---|
| 5,945 | basketball → baseball |
| 5,452 | football → baseball |
| 5,249 | soccer → baseball |
| 3,905 | hockey → baseball |
| 2,871 | non-sport → baseball |
| 1,249 | soccer → basketball |
| 1,055 | non-sport → football |
| 893 | hockey → basketball |
| 746 | pokemon → baseball |
| 682 | basketball → football |
| 506 | football → basketball |
| 486 | racing → baseball |
| 425 | pokemon → football |
| 404 | pokemon → basketball |
| 379 | soccer → football |
| 346 | wrestling → baseball |
| 220 | mma → baseball |
| 174 | golf → baseball |
| 160 | baseball → hockey |
| 158 | baseball → football |

**Note the direction.** In the POOL the damage flows *out of* baseball (82.9% of
the 94,275 rows originate there). In the CATALOG it flows *into* baseball:
25,626 of the 32,044 disagreeing rows (80.0%) sit in a product whose checklists
say baseball while the seed row says something else. These are the same defect
seen from two ends — a sale mis-slugged into a product mints a seed row that
carries the sale's wrong sport onto a product the checklist already owns.

The clearest examples are products with only one possible sport:

```
1948-1955 bowman        1,145 auto-seed rows say FOOTBALL; every checklist says baseball
2020-2026 bowman-chrome-sapphire   176 rows spread across non-sport, soccer,
                        basketball, hockey, football, wrestling; checklist: baseball
```

`bowman` is baseball-only by the Bowman setKey taxonomy ruling, and
`bowman-chrome-sapphire` is a baseball product. Nothing about those rows is
ambiguous; they are the `/\bbowman\b/ → baseball` heuristic's inverse — a sale
whose title carried another sport's word, minting a seed row under it.

## 3. Does the retire lane already cover them?

**Partly, and not by sport.** `retire-self-derived-identities.cjs` lists
`ingest-auto-seed` first in `SD_SOURCES`, and `isSelfDerived` strips a
`-graded` suffix, so both `ingest-auto-seed` and `ingest-auto-seed-graded` rows
are in its scope. Every one of the 32,044 rows is therefore **reachable** by
that lane.

But reachable is not the same as *addressed*, for a structural reason:

> The lane runs `SPORT=<one sport>` per run (line 198) and looks for a checklist
> twin within `(sport, year, setKey)` — the same three fields, in the same
> query (line 584). **A row whose SPORT ITSELF is wrong is compared against the
> checklists of the wrong sport**, where by construction no twin exists.

So a `football`-tagged seed row on 1952 `bowman` is compared only against
football checklists for 1952 Bowman. There are none. It falls to lane (b),
`identityUnverified`, and lands on **the acquisition queue** — a list of
checklists to go and buy. It is not wrong to park it (parking is the right
outcome for a row we cannot place), but the reason recorded is *"no checklist
exists for this card"* when the truth is *"this row is in the wrong sport, and
the checklist for its real card is already in hand."*

That misfiling has a cost beyond bookkeeping: 1,145 rows asking for 1948–1955
Bowman **football** checklists that do not exist, because those products are
baseball. The acquisition queue is a work list; a bad entry on it is wasted
acquisition effort.

**Verdict for the JSON line: `retireLaneCoversAutoSeed: true`** — the rows are
in scope and will be marked. The recommendation below is about the *reason*,
not the coverage.

## 4. Recommended, not done here

1. **Give the retire lane a cross-sport probe.** Before writing
   `identityUnverified` with "no checklist at all", ask whether a checklist twin
   exists for the same `(year, setKey, cardNumber, playerName)` in **another**
   sport. When one does, the reason is `sport-contradicted`, not "unacquired" —
   and the row belongs on a repair list, not the acquisition queue.
2. **Rule on the direction, per row.** The pool census established that
   `hobbyiqCardId` is not automatically right (2,330 vs 1,203). The catalog side
   has a stronger tell — a product-year with thousands of checklist rows in one
   sport and zero in another is not a close call — but "the checklist owns the
   product" should be stated as a ruling before anything acts on it.
3. **Do not delete.** `sold_comps` rows reference these ids; a delete orphans
   the pool with no way back, which is the reasoning the retire lane already
   carries. Mark, never purge.

Nothing in §4 is implemented in this PR. This report is the measurement the
brief asked for; the write lane waits on the ruling.
