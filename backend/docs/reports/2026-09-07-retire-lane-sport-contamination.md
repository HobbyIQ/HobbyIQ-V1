# The retire lane now reads a wrong sport as a wrong sport, not a missing checklist

**2026-09-07 · The lane change is REPORT-verified against prod; the queue audit is READ ONLY.
Nothing in this work wrote to Cosmos.**

The #1929 census measured 32,044 `card_catalog` rows from `ingest-auto-seed` /
`ingest-auto-seed-graded` carrying a sport with ZERO checklist backing in their
product-year, and closed on a recommendation it did not implement:

> Give the retire lane a cross-sport probe. Before writing `identityUnverified`
> with "no checklist at all", ask whether a checklist twin exists in **another**
> sport. When one does, the reason is not "unacquired" — and the row belongs on
> a repair list, not the acquisition queue.

This is that probe, plus the hygiene measurement of the damage already on the
queue.

---

## 1. The defect, restated in one line

`retire-self-derived-identities.cjs` runs `SPORT=<one sport>` and compares twins
within `(sport, year, setKey)`. **A row whose SPORT ITSELF is wrong is compared
against the checklists of the wrong sport, where by construction no twin
exists.** It falls to lane (b), `identityUnverified`, and its cell lands on the
ACQUISITION QUEUE — a work list of checklists to go and buy.

So 1,145 rows ask for 1948–1955 Bowman **football** checklists. Those products
are baseball by the Bowman setKey taxonomy ruling; the checklist cannot exist
and no publisher will ever serve the cell. The acquisition queue is a work list,
and a bad entry on it is wasted acquisition effort.

## 2. The probe, and the four answers it can give

`backend/scripts/lib/sport-contamination.cjs` — pure, no I/O, so the lane, the
queue audit and the pins all decide the same way (the `split-identity.cjs` /
`withheld-acquisition-cells.cjs` precedent: a classification rule in a lib is
pinned; the same rule inline is not).

It asks ONE question of the PRODUCT, per **ruling 6** (the product's sport is
the card's sport):

| for this `(year, setKey)`, which sports hold STRICT checklist rows? | verdict | what the lane does |
|---|---|---|
| the asking sport is among them | `agree` | nothing — the in-sport comparison is sound |
| exactly ONE other sport | `contaminated` | that sport is the row's TRUE sport |
| several other sports | `ambiguous` | park, never guess |
| no sport at all | `no-attestation` | nothing — the honest acquisition case |

**Absence of checklist coverage is not absence of the product.** The probe never
fires on an unattested product-year, and that is deliberate: `setSportAuthority`'s
first version read "we have no 2024 Donruss BASEBALL checklist" as "2024 Donruss
is not a baseball product" and moved 1.24M comps backwards. The fourth row of
that table is what keeps the acquisition queue doing its real job.

**No dominance ratio.** `setSportAuthority` weighs sport against sport because it
adjudicates a comp whose slug is evidence. Here the asking sport has ZERO
checklist rows — there is nothing to weigh. The question is presence, not
plurality. `MIN_CHECKLIST_ROWS = 3` guards the other direction only: one stray
foreign row is a misfiling, not an attestation, and it is absolute rather than a
ratio for `setSportAuthority`'s own reason (dominance over a single-sport sample
is always 1.0).

## 3. The three branches

| probe says | twin under the TRUE sport? | verdict | reason written | enqueued? |
|---|---|---|---|---|
| `contaminated` | YES | **RETIRE** | `sport-contaminated:twin-in-<sport>` | no |
| `contaminated` | no | `identityUnverified` | `sport-contaminated:no-twin` | **no** |
| `ambiguous` | — | `identityUnverified` | `sport-ambiguous` | **no** |

**Why `no-twin` enqueues nothing in EITHER direction.** Its own sport names a
product no publisher serves. Its true sport's cell demonstrably HAS a checklist —
that is the very fact that identified the contamination — so there is nothing to
acquire there either. The enqueue gate is one function, `mayEnqueueAcquisition`,
so there is exactly one place that decides which verdicts may cost a publisher
request.

**Nothing is deleted.** `sold_comps` rows reference these ids; a delete orphans
the pool with no way back. Mark, never purge — the reasoning the lane already
carried, and §4.3 of the #1929 report.

## 4. Three things the change had to fix to be safe

1. **The verify would have turned a healthy APPLY run red.** It compared every
   retire against the plain `superseded-by-checklist` marker; a cross-sport
   retire carries `sport-contaminated:twin-in-baseball`. The write ledger now
   records what each write meant to leave and the verify checks *that* — the
   same class of defect the `pkOf` mirror already guards against.
2. **The already-marked shortcut would have swallowed the whole population.**
   Every one of the 32,044 rows was parked `identityUnverified` by a PRE-PROBE
   run, so a re-run would have skipped each of them as settled and the fix would
   never have reached the rows it exists for. On a contaminated product the
   shortcut now fires only when the row already carries *this* probe's verdict.
3. **The probe had to be a probe, not a second pass.** It fires only on a
   product that holds self-derived rows AND zero in-sport checklist rows —
   where the lane is about to write a verdict it cannot justify. On a healthy
   product nothing extra is read. The query is a projection across one
   `(year, setKey)`, never a `COUNT(1)`/`GROUP BY`, which this lane's own
   enumeration comment records as not returning on `card_catalog` at 19.63M rows.

## 5. The pins, and the mutation

`backend/tests/retireSelfDerivedSportContamination.test.ts` — 11 tests: one per
branch, both non-firing cases, the `MIN_CHECKLIST_ROWS` floor, the blank-sport
rule, the wiring, and the two safety fixes above.

**The mutation is the enqueue**, because that is the harm the change exists to
prevent. Section 5 drops the detection exactly as a regression would and asserts
that `football|1952|bowman` reappears on the acquisition queue — while a real
gap on the same run (`football|1995|collectors-edge`) survives untouched in both
directions. Verified red: dropping the detection fails 5 of 11, the MUTATION
test among them.

## 6. Queue hygiene: what is on the queue today

`backend/scripts/audit-seed-queue-sport-hygiene.cjs` — REPORT ONLY, with no
apply path and no flag that makes one. It reads `catalog_seed_queue` (small by
construction: the doc id `seed:{sport}:{year}:{setKey}` collapses a thousand
users missing one release into ONE row) and asks the shipped probe about each
entry's cell.

**The queue is not small.** Its header argues that the deterministic doc id
collapses a thousand users missing one release into ONE row; it does, and the
queue is still **9,988 entries over 5,569 distinct `(year, setKey)` cells**.
Measured read-only 2026-09-07, ~12 cells/s, one two-column projection per cell.

| verdict | entries | share |
|---|---:|---:|
| `no-attestation` — a real gap, the queue's actual job | 6,131 | 61.4% |
| `agree` — already covered in the asking sport | 1,777 | 17.8% |
| **`contaminated`** — the checklist is under ONE other sport | **1,083** | **10.8%** |
| **`ambiguous`** — several other sports attest it | **997** | **10.0%** |
| **POLLUTED (contaminated + ambiguous)** | **2,080** | **20.8%** |

**One entry in five on the acquisition queue names a cell no source can serve.**
2,012 of the 2,080 are still `pending` — live work orders — and 68 have already
been marked `unavailable` by the drainer, which is the queue discovering the
same fact the expensive way, one failed fetch at a time.

### The contaminated pairs mirror the catalog census exactly

| entries | pair (queue cell's sport -> the sport whose checklist owns the product) |
|---:|---|
| 173 | football → baseball |
| 160 | basketball → baseball |
| 142 | hockey → baseball |
| 88 | pokemon → baseball |
| 80 | baseball → pokemon |
| 71 | soccer → baseball |
| 45 | baseball → basketball |
| 45 | baseball → hockey |
| 34 | baseball → football |
| 28 | wrestling → baseball |

The #1929 catalog census found the damage flowing **into** baseball
(basketball → baseball 5,945, football → baseball 5,452, soccer → baseball
5,249, hockey → baseball 3,905). The queue shows the same four pairs in the
same order. These are one defect seen at two ends: a wrong-sport catalog row
finds no twin, parks, and its cell becomes a work order.

The 997 `ambiguous` entries are led by `hockey` (196), `pokemon` (152) and
`soccer` (114) — sports asking for cells on genuinely cross-sport products.
They are on the list because they cannot be served as asked, not because we
know where they belong.

The largest single entry is `seed:non-sport:2026:topps-chrome` at
**requestCount 2,310** — 2,310 verify misses asking for a "non-sport" 2026
Topps Chrome checklist, against a product whose checklists are baseball and
basketball. It is already marked `unavailable`, so the queue had learned it;
nothing had told the retire lane.

Full list: `backend/docs/reports/2026-09-07-seed-queue-sport-purge-list.json`
(2,080 entries, `reportOnly: true`).

The `--purge-list=<path>` output is shaped for the drainer's OWN maintenance
vocabulary — `markSeedStatus(id, "unavailable", { reason })`. `drainCatalogSeedQueue`
marks a seed it cannot acquire `unavailable` with a reason and leaves it visible
as real demand; it does not delete. A wrong-sport cell is a stronger statement
than `unavailable` — the demand itself is misfiled — so each entry carries its
`trueSport` alongside, and the decision to act on the list is Drew's.

## 7. The lane's REPORT run against prod

Two REPORT runs (`apply=false`), local against prod, read-only. The branch code
cannot be dispatched to the runner, so the lane was run in its own REPORT mode.

### 7a. `SPORT=football`, 60 products — the lane end-to-end

```
  elapsed            123s   (24.7 sd-rows/s)
  catalog rows read  328,481
  self-derived seen  3,039
  retired (twin)     50   + 8 graded children
  card-level twins   416   (untouched: rule off)
  identityUnverified 2,573
  write failures     0

  CROSS-SPORT PROBE  12 products probed
  sport-contaminated 3 rows
          3  sport-contaminated:no-twin
  by sport pair: 3  football->baseball

  RECONCILE  seen 3,039 = ... => 3,039 BALANCES
finishLane: exiting code 0
```

The products sort year-descending, so the first 60 are 2025–2026 — modern,
well-covered, and only 12 needed a probe at all. That is the probe's cost
control working: on a healthy product nothing extra is read.

### 7b. `SPORT=football YEARS=1948..1955` — the population the census named

```
  22 (year, setKey) products in football
  self-derived seen  1,617
  retired (twin)     0
  card-level twins   153   (untouched: rule off)
  identityUnverified 1,464

  CROSS-SPORT PROBE  19 products probed
  sport-contaminated 1,351 rows
      1,175  sport-contaminated:no-twin
        176  sport-ambiguous
  by sport pair: 1,175  football->baseball

  RECONCILE  seen 1,617 = ... => 1,617 BALANCES
finishLane: exiting code 0
```

**This is the 1,145-row class from the #1929 report, found by the lane itself**
(1,175 here — the census counted `bowman` alone; this sweeps every vintage
football product). Both runs balance and exit 0, and the verify path is
exercised.

**What changed for the acquisition queue.** Before this fix all 1,464 unverified
rows fed the queue, including every one of the 1,175 asking for a vintage
football checklist of a baseball product. After it, 113 rows do — and the
top of the remaining queue is `1948|unknown`, `1955|topps`, `1952|unknown`:
real gaps, and honest ones.

`sport-contaminated:twin-in-<sport>` did not fire in either sample. That is
expected and not a gap in the evidence: a twin requires the checklist to carry
the same `(cardNumber, playerName)`, and these vintage rows are auto-seeds whose
player names came off sale titles. The branch is pinned by fixture instead,
which is what fixtures are for.

## 8. Not done here

- **No APPLY.** This PR ships the detection and its pins. The fleet that acts on
  it is a separate dispatch, after the ruling in §2 is confirmed.
- **The queue is not purged.** The list is data; marking those seeds
  `unavailable` is a write, and it waits.
- **`ambiguous` rows stay ambiguous.** A genuinely cross-sport product cannot be
  arbitrated by row counts, and guessing which of three sports a row belongs to
  is exactly the guessed address #1929 removed from the ingest.
