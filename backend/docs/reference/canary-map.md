# The canary map

Every scheduled canary in this repo, what it reads, what turns it red, and
what to do when it does. A canary here means: a cron workflow that runs a
read-only script, prints a banner with a measured number against a floor or
ceiling, exits non-zero on breach, and files a GitHub issue on the way out.

The house rule they all share: **a green workflow is not data flow**
(`feedback_green_workflow_is_not_data_flow`). Every one of these exists
because some job reported success while writing nothing, or wrote nothing
while nobody was watching.

## The seven canaries

| Canary | Workflow | Cron | Source of truth | Red when |
|---|---|---|---|---|
| Sold Comps Freshness | `sold-comps-freshness-canary.yml` | `30 */6 * * *` | Cosmos `sold_comps` | newest `observedAt` > 25h old; a source's trailing-24h rows under its floor; a source's last full day under 0.5x its 14-day median |
| Sold Comps Cleanliness | `cleanliness-canary.yml` | `17 */6 * * *` | Cosmos `sold_comps` | garbage-prefix playerName > 1%; slug fragmentation > 2%; missing `hobbyiqCardId` > 5%; card-number integrity over its ceiling |
| Catalog Duplicates | `catalog-duplicates-canary.yml` | `43 11 * * *` | Cosmos `card_catalog` | more than 250 identities have sales split across rows (one card, two pools -> FMV from half its comps), or split groups exceed 5% of the population |
| Catalog Token Coverage | `catalog-token-coverage-canary.yml` | `45 */6 * * *` | Cosmos `card_catalog` | rows missing `searchTokens` exceed the threshold |
| **Deal Scanner** | `deal-scanner-canary.yml` | `15 */6 * * *` | App Insights `traces`, event `buyeriq_deal_scan_summary` | no completed scan in 2h (= 2x the job's 60-min interval); or errors/targets-scanned > 50% |
| **Storefront Visibility** | `storefront-visibility-canary.yml` | `0 */6 * * *` | Cosmos `marketplace_listings` (+ `users` for the seller set) | zero visible listings; an eligible seller with no listings; a refresh cohort losing >50% of the prior one; newest `lastUpdatedAt` > 48h |
| **Scheduled Jobs** | `scheduled-jobs-canary.yml` | `5 */6 * * *` | GitHub Actions run conclusions, `event=schedule` | any cron workflow whose last 2 **scheduled** runs both `failure`/`timed_out`; or a workflow whose run history could not be read at all |

The six SIX-HOURLY canaries take deliberately distinct minutes (`:00`,
`:05`, `:15`, `:17`, `:30`, `:45`) so no two Cosmos-reading jobs land on the
same minute; Catalog Duplicates runs once daily on its own offset. A pin in
`backend/tests/dealScannerAndStorefrontCanaries.test.ts` enumerates the
workflow directory and fails if any `*-canary.yml` is missing from the table
above, or if two six-hourly canaries share a minute.

**Scheduled Jobs is the odd one out, deliberately.** Every other canary here
reads DATA — a container, a trace stream — and the house rule is that a green
workflow is not data flow. This one reads the workflows themselves, because
the inverse turned out to be just as true: **green data is not a live job**.
The TCA firehose was red on eight consecutive scheduled runs while
`sold_comps` kept filling from the webhook, so the freshness canary two rows
above stayed green through the entire outage and `match-enricher` was skipped
eight times in silence. It also watches itself — a dead canary is worth
alarming about — and its exemption list lives in
`backend/data/scheduled-jobs-canary-exemptions.json`, which ships empty.
See `backend/docs/reports/2026-09-07-scheduled-jobs-canary-and-tca-reconciliation.md`.

---

## Deal Scanner Canary

**Checklist item:** §Alerts 3 — "Deal-scanner job failure —
`buyerIqDealScanner.job` runs in-process on App Service; a crash today is
silent." (GO-LIVE P2-4.)

**Why it needed a canary and not a workflow fix.** The scanner is not a
workflow. It is a `setInterval` armed from `backend/src/server.ts:111`, so
there is no run history to go red and no step conclusion to read. Three
things compound the silence:

1. No Actions run means no red X on the surface everyone watches.
2. `tick()` swallows every throw into a `console.error` and the run summary
   still prints, so "it ran" is not "it worked".
3. Every Cosmos accessor in the service returns `null` on failure and
   `listAllWantedTargets` returns `[]` on any query error — so a total
   Cosmos outage yields a fully-zeroed, error-free summary that is
   byte-for-byte identical to a quiet night.

**Why traces and not a container.** The scanner's only Cosmos write,
`buyeriq_deals_sent`, is conditional on a deal clearing the threshold *and*
a push delivering (`if (push.sent > 0)` →
`recordSent`, `buyerIqDealScanner.service.ts:330`). On a small target
corpus the normal outcome writes nothing at all, so a row count reads a
healthy quiet hour and a three-day-dead process as the same zero. The one
unconditional per-run artifact is the summary line at
`buyerIqDealScanner.service.ts:342`, which reaches App Insights because
`server.ts:39` arms `setAutoCollectConsole`.

**Threshold arithmetic.** `BUYERIQ_DEAL_SCANNER_INTERVAL_MIN` defaults to
60 minutes, so the heartbeat ceiling is schedule x 2 = **2h**: one missed
cycle is tolerated, two is not. The canary's own 6h cron is deliberately
coarser than the ceiling it enforces — the ceiling describes the scanner's
silence, not this workflow's cadence.

**Why `targetsScanned == 0` does not fire.** Zero wanted targets is a
legitimate product state, and the corpus was 4 targets on 2026-09-07.
Alarming on it would train the reader to ignore the canary before there is
anything to protect. The count is printed on every run so a shrinking
corpus is visible; revisit when the corpus is reliably non-trivial.

**Measured 2026-09-07 (read-only).** The 7-day window held 3 summary
traces, all on 09-07 between 15:17Z and 15:45Z, clustered around an App
Service restart (two "scheduler armed" lines, two workers, one taking the
single-flight lock). The six days before carry nothing. That is exactly the
shape this canary exists to name.

**When it goes red:**

1. Is the App Service up? A restart loop stops the timer with no other symptom.
2. Is `BUYERIQ_DEAL_SCANNER_DISABLE` set to `true` on HobbyIQ3?
3. Did a deploy land that throws before `startBuyerIqDealScannerJob()`?
   `server.ts:113` only `console.error`s it.

```bash
az monitor app-insights query --app 468bd437-5d16-47b4-90fb-5ee5d41726ae \
  --analytics-query "traces | where timestamp > ago(24h) | where message has 'buyeriq_deal_scan' | project timestamp, message | order by timestamp desc"
```

**Exit codes.** `1` = the scanner is silent or erroring (a real verdict).
`2` = the App Insights query did not answer, so the scanner was **not
measured**. These are deliberately different: "the job is dead" and "we
could not tell" must not share an error message.

---

## Storefront Visibility Canary

**Checklist item:** §Alerts 4 — "Storefront visibility drops to 0 — sanity
canary for the `marketplace_listings` pool." (GO-LIVE P2-4.)

**What visibility means here.** There is no `status`, `visible`, `active`,
`published`, `deletedAt` or `expiresAt` field on a listing row. Visibility
**is row presence**: a row exists iff, at write time, its seller passed
`isEligibleSeller()` and its holding carried `showOnStorefront === true`
with a photo and an identity. `searchListings` applies no visibility
predicate, so anything in the container is served publicly by
`GET /api/marketplace/search`, and `COUNT(rows)` is the visibility number.

**Why not just trust the refresh's own count.** The nightly refresh already
prints a post-run row count — but from *inside* the run that just wrote the
rows. It cannot see the refresh failing to run at all, and its report step
was red for nine consecutive nights (2026-08-30 → 09-07) while the refresh
itself stayed green. A canary on a separate cron, reading the pool from
outside, catches "the writer stopped" rather than "the writer wrote".

**The active sellers set is derived, not stored.** There is no sellers
container and no `isSeller` flag. The canary recomputes the set from
`users` with the same four gates the refresh uses — effective plan in
`pro_seller`/`investor`, `publicShareEnabled === true`,
`emailVerification.verifiedAt` present, and a username. The predicate is
deliberately a *copy* of the writer's rather than an import, pinned by a
test asserting both files gate on the same four things, so a drift becomes
a red test instead of a canary quietly measuring a different population.

**Day-over-day without stored state.** The refresh stamps `lastUpdatedAt`
on every row it writes, so the pool carries its own history: rows sharing
the newest stamp are that run's survivors, and the cohort before them is
the previous run. Comparing the two gives a real delta with no cache, no
artifact and no baseline file to drift. Stamps are bucketed to the minute
so a rebuild straddling a second boundary is one cohort, not many. The axis
is **skipped, loudly** when only one cohort exists — "could not measure the
drop" is not "the drop was 0%".

**Measured 2026-09-07 (read-only):** 19 listings, 2 distinct sellers, 2
eligible sellers (2/2 covered), the whole pool stamped `07:42:56.483Z` by
that morning's 07:30 UTC cron.

**When it goes red:**

1. Did last night's refresh run, and succeed *past* its write step?
2. Did the eligible-seller set change? A plan downgrade, an unverified
   email or a `publicShareEnabled` flip legitimately removes a seller — the
   banner names who is uncovered.
3. Was a `FRESH` rebuild dispatched? It cascades a full delete before
   rebuilding, so a run that died mid-rebuild leaves the pool genuinely empty.

**Known adjacent defect (not this canary's job to fix).** The nightly
refresh is the container's *only* writer — `syncListingForHolding` and
`deleteAllListingsForSeller` exist but have no call site in `backend/src` —
so a card toggled off keeps serving from the public search route until the
next successful run. The `refresh age` axis is what would catch the cron
dying entirely; per-row staleness is not measured.

---

## The alert path

All canaries file through the same lane established by #1954's
deploy-failure alert: **`github.token` only, no `azure/login`** in the alert
step. This is deliberate — the repo's mail lane goes through ACS and must
authenticate to Azure first, so an Azure outage or an expired OIDC
credential would take out the monitored system and the alert about it
together. `github.token` survives exactly the failures these canaries report.

Each files one issue per UTC day, threading a comment onto an already-open
issue rather than filing duplicates on a retry, labelled `ops` + `canary`.
The alert step is gated on `steps.canary.outcome == 'failure'` so a checkout
or `npm ci` hiccup does not page anyone about the storefront.

**The labels do not exist yet, and that is handled.** Verified 2026-09-07
against the live repo: neither `ops` nor `canary` is among its 34 labels
(both `GET /labels/:name` → 404). This matters more than it looks, because
`gh issue create` **fails outright** on an unknown label — a labelled-only
create would file nothing and leave behind only a `::warning::`, i.e. the
alert would be silently absent in exactly the incident it exists for. So
both canaries try the labelled create, fall back to an unlabelled one, and
only then warn; and the dedup lookup deliberately does **not** filter by
label, since a filter matching nothing would miss every time and file a
fresh issue every six hours. Creating the two labels is a repo-config
change and is left to Drew; when they exist, the first branch simply starts
succeeding and nothing else changes.

Worth noting the same shape applies to #1954's deploy-failure alert, which
uses `--label ops --label deploy` with no fallback — it would hit this on
its first real firing.

## Adding a canary

1. A read-only script under `backend/scripts/`, budgeted via
   `scripts/lib/runner-budget.cjs` and exiting through `finishLane` — a
   killed step reports nothing at all, so the lane's own clock must stop,
   print and reconcile under the workflow's `timeout-minutes`.
2. A banner printing **measured vs threshold vs verdict**, plus a
   reconciliation line naming every row it looked at
   (`checked = fired + passed + exempt`, `RECONCILES`/`MISMATCH`).
3. A cron workflow every 6h on a minute no other canary uses.
4. A failure issue on `github.token`, threading by title.
5. Pins covering banner shape, threshold arithmetic at the boundary, and
   **mutation → red**: show each axis flipping a real verdict, so a pin that
   would pass against a gutted implementation is caught in CI.
6. A row in the table at the top of this file.
