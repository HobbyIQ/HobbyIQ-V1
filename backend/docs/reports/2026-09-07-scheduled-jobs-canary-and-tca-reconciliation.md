# The two owed items from the TCA flow check

**2026-09-07.** Both items from `2026-09-07-tca-flow-check.md`'s "left as
findings, not fixed here". Read-only against prod throughout; no prod writes,
no live config changes, no new `workflow_dispatch` inputs on
`backfill-runner.yml`. Every banner below is real output.

---

## 1. A run-success canary — the freshness canary reads rows, and rows were fine

The TCA firehose was red on **eight consecutive scheduled runs** and nothing
noticed, because the live writer for `sold_comps` is the 30-minute webhook, not
the cron. Rows kept landing at 20–27k/day, the freshness canary stayed green
through the entire outage, and `match-enricher` — which `needs: ingest` — was
skipped eight times in silence.

A row canary was never going to catch that. It measures the pool, and the pool
was fine. What broke was a **job**, and a job's only evidence is its own run
history. `scheduled-jobs-canary` reads conclusions.

### What it found on its first run

Not the one dead cron the flow check knew about. **Thirteen.**

```
[scheduled-jobs-canary] source of truth: GitHub Actions run conclusions, event=schedule
[scheduled-jobs-canary] 62 cron workflow(s) enumerated from .github/workflows; breach = last 2 scheduled runs all failed; 0 exempt

axis        measured                          threshold        verdict
---------   -------------------------------   --------------   -------
breaches    13 of 62 cron workflows           == 0             BREACH
unmeasured  0 workflow(s) had no answer       == 0             ok

[scheduled-jobs-canary] BREACHING —
  Cascade Alerts Nightly Detect      (cascade-detect.yml)
  Catalog cardYear Backfill          (catalog-cardyear-backfill.yml)
  Catalog Gap Digest                 (catalog-gap-digest.yml)
  Catalog Token Coverage Canary      (catalog-token-coverage-canary.yml)
  CH Historical Backfill             (ch-historical-backfill.yml)
  Daily Listings Snapshot            (daily-listings-snapshot.yml)
  Era-Baselines Refresh (weekly)     (era-baselines-refresh.yml)
  Grade-Worthy Push                  (grade-worthy-push.yml)
  Marketplace Listings Refresh       (marketplace-listings-refresh.yml)
  Nightly Cleanliness Maintenance    (nightly-cleanliness.yml)
  Nightly Slug Backfill              (nightly-slug-backfill.yml)
  TCA Firehose Ingest                (tca-firehose-ingest.yml)
  Watchlist Digest Push              (watchlist-digest.yml)

[scheduled-jobs-canary] 4 workflow(s) have fewer than 2 scheduled runs — not enough history to judge
[scheduled-jobs-canary] reconcile: 62 enumerated = 45 ok + 13 breach + 0 exempt-breach + 4 insufficient + 0 unmeasured  RECONCILES
```

These are **not one shared cause**. Sampled exit codes across six of them come
back `1`, `1`, `22`, `1`, `1`, `28` — distinct failures in distinct jobs. Some
carry #1954's fixes and have not run since; others do not. They are reported as
data, not fixed here: naming them is this canary's job, and a thirteen-workflow
repair is not one PR.

### The design decisions worth arguing with

**Two consecutive, not one.** A single red is a transient — an upstream 500, a
runner hiccup, a 429. Alarming on those teaches the reader to mute the canary
before there is anything worth protecting. Two in a row is a pattern: whatever
broke is still broken and the next run will not fix it either.

**Only `schedule` runs count, filtered server-side.** A `workflow_dispatch` run
is somebody testing, often deliberately against a broken input, and says nothing
about whether the cron is healthy. Mixing them in lets a green manual probe mask
a dead cron *and* lets a red one manufacture a breach that is not real. Both
directions are pinned. The filter is applied in the API query rather than
client-side so the `per_page` window is spent entirely on scheduled runs — a
burst of dispatches must not push the crons out of the page.

**The enumeration is derived and pinned.** A hand-kept list goes stale on the
first cron somebody adds, and the workflow it misses is invisible in exactly the
way this canary exists to prevent. The list is computed from
`.github/workflows/*.yml` on every run, and a test asserts the count — adding or
retiring a cron updates a number on purpose rather than drifting silently.

Parsing is structural, not `grep schedule`, because both false answers are real:
a **commented-out** cron (`# schedule removed 2026-08-29`) is a job deliberately
taken off the clock and would otherwise alarm forever — #1954 records two in
exactly that state — and the **word** "schedule" appears in a comment in
`deal-scanner-canary.yml` and inside a step body in `verdict-flip-push-fanout.yml`.
All three are pinned as exclusions.

**One parser, not two.** The first cut re-implemented the enumeration in `awk`
inside the workflow. The two disagreed immediately: an `exit 0` inside an awk
rule still runs `END`, which exited 1 and overrode it, so the awk matched
**nothing** — every workflow would have gone unqueried, been reported
`unmeasured`, and the canary would have failed with 61 phantom findings on its
first run. The workflow now calls the script's own `--list`. Two parsers that
must agree forever is a defect waiting for its turn.

**A 404 is not a failed query.** A cron added on a branch does not exist to the
API until it lands on the default branch. Verified 2026-09-07: this very file
404s from the branch and returns `[]` once merged. Recorded as "no history", not
as unmeasured — otherwise every PR that adds a cron workflow turns this canary
red on itself.

**Three answers that must not collapse.** `[...]` is judged, `[]` is "registered,
no history", a hard failure is `unmeasured` — and unmeasured is **exit 1**,
because a workflow whose health could not be read is unknown, not good.

### The exemption list is empty, and that is the finding

The brief named two chronic-by-design exemptions to carry over. Both were
checked against the repo and **both are stale**:

- **Tier 1 harness** is a `pull_request` check in `regression.yml`, not a cron.
  It is never enumerated, so it cannot be exempted. Its memory note records the
  401 as **RESOLVED 2026-06-30** (PR #218/#219/#221).
- **Era-baselines** *is* a cron and *is* chronically red — but **not on a
  timeout**. Verified on run `34020643605`: it dies in 33 s with
  `Cannot find dist output — run npm run build first`, the same missing-build
  class #1954 fixed elsewhere. The timeout memory describes pre-2026-07-16
  behaviour and is marked RESOLVED. Exempting it would hide a live, fixable
  defect behind a stale reason.

So `backend/data/scheduled-jobs-canary-exemptions.json` ships **empty**, with
the reasoning recorded in the file. Silencing an alarm is the
highest-consequence edit a canary carries, so it happens in reviewable data with
a reason and an exit condition per entry — never in a script's source. An exempt
breach is still **measured and printed**; the exemption hides the alarm, never
the evidence.

---

## 2. The 1.11% shortfall was a missing term, not a dropped write

`tca-firehose-ingest` fetched 19,109 rows, wrote 9,177, and exited 4 with 213
rows (1.11%) unaccounted.

**Cause.** The script read **four** of the outcome counters
`persistVendorSalesToPool` returns, and the service returns **six**.
`twinAddressRefused` and `twinFolded` are terminal — the row leaves the pipeline
at the twin check and reaches none of the other four — so every refused row fell
out of the ledger and `reportWrites` correctly called the difference vanished
work.

**The measurement that settles it**, from run `34071480616`:

```
fetched 19,109   written 9,177   skipped 9,719   ->  UNACCOUNTED 213 (1.11%)
twin_address_refused events in that run's log:                     213
```

Exactly the shortfall, to the row.

The staging promoter hit the identical bug and fixed it the identical way in
**#1953** (`UNACCOUNTED 6,557 (100.00%)`). The firehose was the one caller that
never got that fix; this change brings it into line and pins the promoter's
version so the precedent cannot regress.

### What changed

`WriteReconciliation` gains a **`refused`** bucket, so every fetched row lands
in exactly one of `written` / `skipped` / `refused` / `failed`, with
`skipped-duplicate` and `parked` carried inside `skipped` and `refused` as the
service reports them. Arithmetically `refused` is a skip and a caller folding
them together still reconciles — the separate term buys a different **question**:
`skipped` is "we could not use this row", `refused` is "we understood this row
and declined to write it". A climbing refusal count is a guard doing its job or
a guard mis-scoped; a climbing skip count is a parser going blind. One number
loses that.

`identityParked` is deliberately **not** added: those rows are still written
("parked, not dropped") and are already inside `inserted`. Counting them again
would over-account — which the reconciler now catches as loudly as a shortfall.

The ingest also prints the equation in full, the way the promoter does, because
the failure being fixed was not a wrong number but a **missing term**, and only
a written-out identity shows a term to be missing:

```
[tca-firehose] reconcile — fetched=19109 = written=9177 + skipped=9719 + catalogUnmatched=0
                          + twinFolded=0 + twinRefused=213 + errors=0  (unaccounted=0)
```

If a seventh terminal outcome ever appears in the service, that line stops
balancing and says so at runtime.

---

## Verification

- `npx tsc --noEmit` — clean.
- **62 new pins** across `scheduledJobsCanary.test.ts` (36) and
  `tcaFirehoseReconciliation.test.ts` (13), plus the existing
  `writeReconciliation` / `workflowAlertGates` / `twinAddressRule` suites:
  **101 passed** together.
- **Mutation-checked.** 10 of 13 reconciliation pins fail against `origin/main`.
  Lowering the breach rule to 1 and counting `workflow_dispatch` runs each turn
  the two masking pins red — the exact tests that protect the canary's purpose.
- The required fixture — **a parked row and a duplicate both counted in one
  run** — is pinned, along with the real 19,109-row run reconciling to zero.
- The workflow's collect step was **extracted from the YAML and executed** with
  a stubbed `gh` (the #1980 standard: parsing is not running), and the 404 /
  red-cron / healthy branches were each probed against the live API.
- Full suite: **19,227 passed / 1 skipped**, with one local 30-second timeout in
  `splitIdentitySportSegmentTranche2.test.ts` that CI does not reproduce — box
  load, and a file this PR does not touch.

### One pin caught this PR, which is the system working

#1967's canary-map pin enumerates `.github/workflows/*-canary.yml` and goes red
the moment a canary exists that `canary-map.md` does not name. Adding
`scheduled-jobs-canary.yml` turned it red — in CI and locally, on the same
assertion — and the fix was to write the row it was asking for. Worth recording
because it is the same shape as everything else here: the pin did not know about
this canary in advance, it knew that the map must not fall behind, and that was
enough to catch a real omission on the first run.

**Deploy: OWED.** `writeReconciliation.ts` is under `backend/src`, and the first
draft of this report claimed no in-process consumer. That was wrong, and checking
it rather than asserting it is the only reason it is right now:
`backend/src/jobs/ebayOrderPoll.job.ts:30` imports `reportWrites`, and
`server.ts:100` arms that job in the App Service process. The change is additive
— `refused` defaults to 0, so `ebayOrderPoll`'s arithmetic is byte-identical
until it declares one — but the module ships to prod either way, so dispatch
**"Daily 5AM ET Refresh & Deploy"** after merge and verify with the `/api/health`
sha.

The rest is a workflow, two scripts, a data file, two test files and this report.
