# WAVE 2 — the population-wide IMPROVE apply, and the I9 re-baseline it produces

CF-VERIFY-EACH-SLOT-BY-ITS-BANNER-NEVER-BY-RUN-CONCLUSION.

Driver: `backend/scripts/wave2/wave2-fleet.sh`
Pins: `backend/tests/wave2FleetGates.test.ts`

WAVE 2 is the population-wide IMPROVE apply of the GREAT REMATCH — the ~44k
writable `unknown`-keyed rows, the soccer competition rows (263+), the Hoops
3,057, the Bowman Chrome Draft rows, the Pokémon finish/era rows. It runs in two
phases over the same 32-slot shard table, and the census is not merely a
rehearsal for the apply: **it is the artifact that becomes the new I9 reference,
and it is the number every apply slot is gated against.**

---

## 0. What already existed, and what this adds

Almost the whole mechanism was already in the repo. It is worth saying exactly
what, because the temptation is to build a second one:

| Piece | Where it already lives |
|---|---|
| The dispatch surface | `.github/workflows/backfill-runner.yml`, `workflow_dispatch` |
| The census JSON | `rematch-sold-comps.cjs` writes `${CENSUS_OUT}/census-slot-<N>.json` |
| `CENSUS_OUT` for this lane | `/tmp/rematch-census` (workflow `env:`) |
| The artifact upload | step **Upload the shard census**, `if: always() && script=='rematch-sold-comps'` — **both modes**, 90-day retention |
| The re-baseline | `backend/scripts/rebaseline-i9-reference.cjs --from <dir>` |
| The reference file | `backend/data/rematch-census-shares.json` |
| The per-slot canary | `rematch-canary-check.cjs`, before/apply/after inside the apply job |
| The write ledger | `/tmp/rematch-write-ledger.json`, uploaded per apply slot |

**No new workflow input was added, and no `--emit-shares` was needed.** The
census already emits exactly the shape `rebaseline-i9-reference.cjs` consumes
(`slot`, `classified`, `counts.*`), and the workflow already uploads it for
every rematch run including `mode=census`. What this PR adds is the *driver* —
the thing that dispatches 32 slots, follows each one's relaunch chain, and reads
its banner rather than its conclusion — plus the pins that keep those banner
regexes honest.

---

## 1. The seven inputs, and the two that bite

```
script=rematch-sold-comps
mode=census | apply-improve
apply=false | true
scope=improve            # REQUIRED for apply-improve; census ignores it
slot=<0..31>
slots=32
concurrency=16
```

Two of these are traps:

- **`slots` defaults to `16` in the workflow, and rematch needs `32`.** The
  script refuses at `phase=shard-table` if `SLOTS` does not equal the measured
  shard table's length, so a dropped `slots` is a refusal, not a silent
  half-fleet. Always pass it.
- **`scope` defaults to `refractor`, which `mode=apply-improve` REFUSES (exit
  2).** This is not hypothetical: eighteen slots of the 2026-09-07 fleet died in
  55–70 seconds each on exactly this, because the self-relaunch did not forward
  `scope` (#1963, fixed). The driver never emits `-f scope=refractor`, and a pin
  asserts it.

---

## 2. Phase 1 — the census

```bash
WAVE2_DISPATCH=true backend/scripts/wave2/wave2-fleet.sh census
```

32 slots, `mode=census apply=false`. Report-only by construction: the census has
no write path at all and says so (`READ ONLY -- the census writes nothing to the
pool.`).

**#1950's scoped-apply prefilter does NOT apply to a census.** It is gated on
`MODE === "apply-improve"` and additionally requires a single-kind scope, so
`mode=census` never gets one. That matters for the re-baseline: a census
classifies **every in-slot row**, so its `classified` is a whole-shard number
and therefore a legitimate corpus reference. A scoped *apply*'s census would
not be — which is why the script stamps a non-null `applyPrefilter` block into
the artifact when one was active, so an auditor cannot compare the two by
accident.

Gate per slot: chain outcome `finished`, plus a readable
`CENSUS  slot N/32  rows classified <n>` banner. Anything else is HELD.

---

## 3. Phase 2 — collect, and re-baseline I9

```bash
backend/scripts/wave2/wave2-fleet.sh collect /tmp/wave2/census-artifacts
node backend/scripts/rebaseline-i9-reference.cjs --from /tmp/wave2/census-artifacts   # report
APPLY=true node backend/scripts/rebaseline-i9-reference.cjs --from /tmp/wave2/census-artifacts
```

`collect` downloads `rematch-census-slot-<N>-*` for every slot into one
directory; `--from` accepts a directory and expands it.

The re-baseline writes **`backend/data/rematch-census-shares.json` only** — a
repo file, in a PR, reviewed like any other diff. It never writes Cosmos. It
refuses in three ways worth knowing before you run it:

- **exit 3 — the reference is already at the current derivation stamp.** This is
  the refusal that keeps the fix from becoming a silencer: if nothing changed
  the derivation, a drift against the reference is a *real corpus finding*, and
  re-recording it would launder that finding into the baseline. Only a
  deliberate re-measure of the same code (`--force-stamp`) gets past it.
- **exit 4 — below `MIN_ROWS` (default 20,000).** A sample is not a corpus
  reference.
- **exit 2 — a declared derivation input is missing.**

So the ordering is load-bearing: **re-baseline from the census, before the
apply.** After the apply the corpus has moved, and a reference recorded then
describes a population that no longer exists.

The PR carrying the new `rematch-census-shares.json` is the deliverable of this
phase. `measuredUnder.stamp` records the derivation the census was measured
under, and `supersedes` carries the old→new per-class delta — which is the
finding, stated in the same units the I9 alarm uses.

---

## 4. Phase 3 — the apply, canary first, then waves of 4

```bash
export WAVE2_CENSUS_DIR=/tmp/wave2/census-artifacts
WAVE2_DISPATCH=true backend/scripts/wave2/wave2-fleet.sh canary   # slot 0 alone
WAVE2_DISPATCH=true backend/scripts/wave2/wave2-fleet.sh apply    # slots 1..31
```

Both phases **refuse without `WAVE2_CENSUS_DIR`**: an apply with no census has
no expected writable count, and therefore no gate.

Four gates per slot, in order, and a slot that fails any of them is HELD — which
stops the fleet rather than merely skipping the slot:

1. **Chain outcome is `finished`.** The driver follows the self-relaunch: a slot
   that stopped at its budget re-dispatches itself, so one slot is a *chain* of
   runs. `startup-refused` is called out by name, because it means the slot is
   UNSTARTED rather than half-done — nothing was written, and the fix is to
   re-dispatch with the inputs the refusal names.
2. **The apply summary is readable and reconciles.**
   `intended N = written N + skipped N + failed N + not reached N` must be
   present *and* balance. A missing line is not a balanced one.
3. **The shard's own canary verdict is `hold`.** This is read, not re-derived —
   the in-job canary reads the write ledger on the same runner, so its verdict
   is ATTRIBUTED (#1711/#1727): a canary pool this shard never wrote in cannot
   be blamed on it. An **absent** verdict is a hold, never a pass; a shard with
   no canary did not pass one.
4. **Verdict equality: `written` within ±5% of the census's writable count.**
   Slot 0 is the exception — as the canary it is judged by a **ceiling**
   (`written ≤ census writable`), because nothing has been proven yet and the
   only claim it must satisfy is that it did not out-write its own census. An
   expected of 0 admits only a written of 0: there is no percentage band around
   zero, and writing into a class the census found empty is the shape of a scope
   failure.

---

## 5. The one defect this driver was nearly born with

`gh run view --log` prefixes **every line** with `<job>\t<step>\t<ISO
timestamp> `. A `^`-anchored grep against a captured log therefore matches
nothing and returns a **silent zero** — which is how a whole night's
classification once reported all-zeros (#1868,
CF-CLASSIFY-READS-THE-REPORT-NOT-THE-LINE-SHAPE).

Every reader in the driver runs its log through `normalize` first, which strips
that prefix and any ANSI and leaves a raw capture untouched. The pins feed each
reader the **same fixture twice** — once raw, once wearing the gh prefix — and
require the same number from both. A reader that passes only the raw form is the
defect dressed as a pass.

Note also that the rematch lane does **not** upload `/tmp/backfill.log`, so an
external driver has no raw capture available: `gh run view --log` is the only
source, and normalizing is not optional.

---

## 6. Throughput, and the thing that actually governs the schedule

Census throughput is I/O-bound, not classifier-bound. The classifier itself is
pinned at 0.12–0.28 ms/row (3,500–8,500 rows/s, `rematchCensusThroughput`);
what dominates the wall clock is the per-row `checklistBacked` catalog point
read plus the per-product map reads behind the clash and flagship gates.

**Do not size this from #1950's 49 rows/s.** That figure is a *scoped apply*
walking rows it could not write, and its prefilter — which does not apply to a
census — is what fixed it. The honest number is the last full census itself.
Measured from the 2026-09-05/06 window (run durations against each slot's
recorded `classified`, first ten slots):

| slot | classified | minutes | rows/s |
|---|---|---|---|
| 0 | 514,583 | 10.4 | 822 |
| 1 | 543,045 | 83.0 | 109 |
| 2 | 528,979 | 104.6 | 84 |
| 3 | 511,439 | 39.7 | 215 |
| 5 | 522,236 | 83.4 | 104 |
| 9 | 500,532 | 15.6 | 534 |

**Average ≈ 267 rows/s, ≈ 52 minutes per slot**, spread 84–822. The spread is
real and is mostly catalog cache warmth and sport mix, not noise.

Two consequences worth planning around:

- **A census slot normally completes in ONE run.** Every slot in the sample
  finished `success` inside the 140-minute budget; even the slowest (104.6 min)
  cleared it. So the census is not usually a relaunch chain — but the driver
  follows one anyway, because the slowest observed slot has only ~35 minutes of
  headroom and a colder cache would spend it.
- **Sequential total ≈ 32 × 52 min ≈ 28 h; fully parallel ≈ 1.7 h.** The real
  figure sits between and is decided by runner concurrency, not by the rate.

**The binding constraint is the Actions queue, not the classifier.** At the time
of writing, 29 `backfill-runner` runs were queued with the oldest waiting over
an hour, and a freshly dispatched census slot sat queued for 25+ minutes without
starting. Plan the census as an overnight run, dispatch it when the queue is
shallow, and treat "queued" as the expected state rather than a fault. The
driver polls rather than assuming, and `WAVE2_MAX_CHAIN_MINUTES` (default 600)
bounds how long it will follow one slot's chain.

---

## 7. Safety posture

- `WAVE2_DISPATCH` defaults to **false**: every phase prints the
  `gh workflow run` lines it would issue and dispatches nothing. An apply is
  armed by hand.
- The driver never dispatches `apply=true` for `mode=census`.
- A held slot **stops the fleet** (`die`), rather than continuing to the next
  wave. The GREAT REMATCH rule stands: PROTECTED, CONFLICT and UNDERIVABLE are
  report-only forever; only AUTO-tier IMPROVE is writable here.
- Launch the driver **from its file path**, never by piping it into a shell —
  a heredoc-launched wrapper carries the chain's own grep pattern in its
  cmdline and deadlocks idle gates.
