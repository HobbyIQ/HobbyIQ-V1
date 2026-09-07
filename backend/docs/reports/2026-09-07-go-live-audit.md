# Go-Live Audit — 2026-09-07

One week to go-live (~2026-09-14). Every item below was verified against
**live prod** and **origin/main** on 2026-09-07 ~15:00Z. Read-only audit:
nothing was changed, dispatched, or reconfigured.

- **Prod sha:** `24546c6` (`24546c6853a2ad0e4a88b84d036286e3dd228d81`)
- **origin/main HEAD:** `24546c6` — **identical**, distance 0 commits
- **Deployed at:** 2026-09-07T10:16:09Z (run 34110284080)

---

## Verification table

| # | Item | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | `/api/health` sha == origin/main ancestry | **DONE** | `/api/health` → `shaShort: 24546c6`; `git merge-base --is-ancestor` passes; `git rev-list --count 24546c6..origin/main` = **0** (not merely an ancestor — the exact tip). `shaFromCode` matches `sha`, so the running code is the deployed code. |
| 2 | Last 3 "Daily 5AM ET Refresh & Deploy" runs + smoke conclusions | **DONE** | Runs `34110284080` (10:13Z), `34105575603` (09:21Z), `34096770060` (07:42Z) — all `success`. Gating on **conclusion** (not sha) per the case-#4-null memory rule: step 21 "Smoke test pricing tiers" = `success` and step 22 "Smoke test verdict" = `success` on **all three**. The 09-04 null-smoke episode has not recurred. |
| 3 | Nightly reprice / reprice-all ran in the last 2 days | **DONE** | Job "Reprice All Holdings (post-refresh)" = `success` on all three runs above; step 8 "Reprice every user's holdings" = `success` each time. Most recent 2026-09-07T10:16Z — well inside 48 h. |
| 4 | Freshness canary per source; CardHedge subscription restored; volume floor | **DONE** | Run `34123689563` (12:46Z) = `success`, verdict `OK`. Staleness: tca-ebay 0.0 h, cardhedge 0.0 h (threshold 25 h). Row floor: tca-ebay 36,591 ≥ 25,000 `ok`. **Volume floor: cardhedge 408,480 rows on the last full day vs a 67,902 baseline — the subscription lapse is fully recovered and running ~6x baseline** (catch-up backfill). tca-ebay 26,469 vs 16,262 baseline `ok`. Axis reconciles: 4 checked = 0 collapsed + 2 ok + 2 exempt. |
| 5 | pricing-invariant-audit: which of I1–I10 alarm | **OPEN** | Latest run `34095881940` (07:31Z) = `success` (auditor healthy; findings are data, exit 0 by design). **2 breaches → issue [#1946](https://github.com/HobbyIQ/HobbyIQ-V1/issues/1946), OPEN.** Clean: I1, I2, I4, I7, I8, I10. Under threshold: I3 (6/4,000), I6 (2/1,500). **BREACH: I5 ONE-SALE-ONE-ADDRESS 7/2,000 (threshold 0); I9 SHADOW-REDERIVATION 906/1,754.** See OPEN list P1-1, P1-2. |
| 6 | I7 DEPLOY-HEALTH (independent corroboration of #2/#3) | **DONE** | I7 asserts "the last Daily 5AM concluded green, its smoke passed, and Reprice All Holdings actually ran" — sampled 1, breaches 0, `clean`. An independent check agreeing with the manual one above. |
| 7 | APNs pushes alive — is the live `APNS_KEY_P8` corrected? | **DONE (no config change needed)** | **Reported, not changed.** The live App Service value is still the **base64-of-PEM** shape (344 chars) — i.e. the original #1739 shape, *not* re-stored. **This is fine and requires no action**: `loadApnsKey` in `backend/src/services/notification.service.ts` (L88–147) explicitly accepts it as "Shape 3 — the base64 of the whole .p8 file", returning `shape: "base64-pem"`. The fix landed in **code**, so the setting needs no edit. All five settings present: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_KEY_P8`, `APNS_PRODUCTION`. Caveat in P2-3: no push telemetry in 7 days, so delivery is *unproven*. |
| 8 | Payments tiers / product IDs present in config | **DONE** | `backend/src/services/subscriptions/productMap.ts` freezes all three: `com.hobbyiq.collector.monthly` → collector, `com.hobbyiq.investor.monthly` → investor, `com.hobbyiq.proseller.monthly` → pro_seller. iOS `HobbyIQ/SubscriptionManager.swift` L350+ carries the **same** identifiers — backend and client agree. `backend/src/config/entitlements.ts` defines all four plan rungs (free/collector/investor/pro_seller) with per-tier caps. Unknown productId → 422, never a silent downgrade. |
| 9 | Web dashboard (Azure SWA) last deploy green | **DONE** | `deploy-web.yml` runs `34057238051` and `34057237650` (2026-09-06T20:12Z) both `success`. The immediately-prior `34056846202` (20:04Z) failed but was superseded 8 min later by the two greens. Latest state is green. |
| 10 | iOS PR #1909 open for Drew to build | **DONE** | [#1909](https://github.com/HobbyIQ/HobbyIQ-V1/pull/1909) "fix(ios): the engine names the card — three views stop composing their own title", opened 2026-09-06T20:59Z, **not a draft**, both checks green (Web Unit Tests SUCCESS, Backend Unit Tests SUCCESS). Awaiting Drew's Xcode build — correctly left unmerged. |
| 11 | Any open PR older than 24 h | **OPEN** | **9 of 13** open PRs are older than 24 h. See P1-4 / P2-1. |
| 12 | Runner runs failing (KILLED branch) in the last 24 h, and which lanes | **OPEN** | **19 failures / 121 Backfill Runner runs (15.7%)** since 2026-09-06T15:00Z. Sampled failures are all the **same lane**: step "Run backfill (DRY-RUN)" → "Self-relaunch **rematch-sold-comps** until the shard is finished", erroring `KILLED before finish — the lane never reached finishLane`. Diagnostic: `budget marker: absent`, `finishLane line: 0`, **and `/tmp/backfill.log` is empty** — the lane died before writing a line, so this is a *start* failure, not budget exhaustion. Re-dispatch is correctly withheld. See P1-3. |
| 13 | Azure Monitor alerts + destination (checklist §Alerts) | **OPEN — P0** | All 6 metric alerts exist and are `enabled: true` in `rg-hobbyiq-dev`. **But the `hobbyiq-ops-alerts` action group itself is `enabled: false`** — every alert fires into a disabled group, so **no alert can reach anyone today**. The lone email receiver is still `drew@justtheboysandcards.com` (the old JTBAC address; checklist calls for `drew@hobby-iq.com`). Test-fire never performed. See P0-1. |
| 14 | Alert coverage gaps (checklist §Alerts, 4 sub-items) | **OPEN** | (a) **Deploy failure alert — still absent**: no workflow or alert rule fires on a failed "Daily 5AM ET Refresh & Deploy"; a failed deploy remains silent. (b) **CH freshness canary — DONE**: `sold-comps-freshness-canary.yml` is on cron and green (item 4). (c) **Deal-scanner job failure — still silent** (in-process on App Service). (d) **Storefront visibility→0 canary — not built**. See P1-5, P2-4. |
| 15 | Azure Storage: `card-images` = blob-level public read | **DONE (verified as-parked)** | `az storage container show` → `publicAccess: blob`. Matches the documented intent exactly (anonymous blob GET, no container enumeration). The parked trade-off still holds — no sensitive-content trigger has occurred. |
| 16 | Azure Storage: `stghobbyiqdev` blob CORS = `*` | **DONE (verified as-parked)** | `az storage cors list` → one blob rule: origins `*`, methods `PUT, GET, HEAD, OPTIONS, DELETE`, headers `*`, MaxAge 3600. Matches the doc. SAS tokens remain the real write authorization, so the wildcard does not widen the security model. Revisit trigger (signed reads / hotlink protection) has not fired. |
| 17 | Cosmos `sold_comps` autoscale 8K → 40K rollback | **STALE (as written) / OPEN (as intent)** | Still at **40,000 RU/s max**. The doc's four rollback preconditions are **obsolete**: they name the Aug-10 normalizer, CH-fanout run `31414515858`, cross-source dedupe, and re-slug rev 2 — all long finished. But the container is *not* idle: the GREAT REMATCH program drives 121 Backfill Runner runs/day plus hourly staging promotion against it. The item should be **re-scoped**, not executed: the trigger is now "rematch program quiesces", not the four dead runs. `card_catalog` sits at **400,000 RU/s**, which memory says drops to 40K once spine passes finish — a real cost item the checklist never captured. See P1-6, P2-2. |
| 18 | Marketplace listings freshness cadence | **STALE (as written) + OPEN (new defect)** | The *parked* item — bump cron or add a write hook — is **STALE**: it presumes nightly refresh works and only debates latency, and its trigger (≥5 sellers / buyer complaint) has not fired. The live fact is different: **`marketplace-listings-refresh.yml` has failed 9 consecutive nights (2026-08-30 → 2026-09-07)**. Crucially the failure is in step 9 "Report post-run listings count", *after* step 8 "Run marketplace listings refresh" = `success` — so **inventory does refresh; only the observability tail is broken**. Cause: the step's inline `node -e` requires `@azure/cosmos` from the repo root while deps install under `backend/` — it lacks `working-directory: backend`. See P2-5. |
| 19 | Other canaries + scheduled jobs (24 h sweep) | **OPEN** | Green: Catalog Duplicates, Sold Comps Freshness, Daily Market Signals, Parallel Premiums, Personal Prospect Breakout, Publish Market Snapshot, Sub-Raw Inversion Scan, Sell-Side Notify, Grade Arbitrage Notify, Waitlist Daily Digest, eBay order poll (7/7), eBay finances, Staging Pipeline Cron (27/27), Checklist Acquisition, Sold Comps Daily Delta + Rollup. **Failing:** Sold Comps Cleanliness Canary, Catalog Token Coverage Canary, Catalog Gap Digest, Catalog cardYear Backfill, Nightly Slug Backfill, TCA Firehose Ingest, CH Historical Backfill (1 each). See P1-7. |
| 20 | Promote Staging Pending — hourly staging promotion | **OPEN — P0** | **5 of 8 runs failing** in 24 h, and the failures are structural, not flaky. Run `34133391955` (14:31Z): `scanned=6557 tried=6557 inserted=0` → `WORK VANISHED — UNACCOUNTED 6,557 (100.00% of intended)`, exit 4. **Every** row is refused by the twin-address guard (`twin_address_refused`), each wanting to write a *parallel* address where a *base* address already holds the sale. See P0-2. |

**Totals: DONE 11 · OPEN 7 · STALE 2** (items 17 and 18 are counted STALE; each also carries a live OPEN consequence tracked below).

---

## Prioritized OPEN list

### P0 — blockers, must clear before opening the doors

**P0-1 — The ops alert action group is disabled; nothing can page anyone.**
All 6 metric alerts in `rg-hobbyiq-dev` are enabled, but `hobbyiq-ops-alerts`
has `enabled: false`, so every one of them fires into a void. On top of that
its only receiver is the retired `drew@justtheboysandcards.com`. Today a 5xx
storm, a health-degraded App Service, or a Cosmos 429 flood is **completely
silent**. This is the single highest-leverage item on the list: it is the
difference between a bad launch hour and a bad launch day.
*Owner:* **Drew** (live config write — HALT rule: this session did not touch it).
*Size:* S — enable the group, add `drew@hobby-iq.com`, remove the old address,
then test-fire per the checklist and confirm the mail lands.

**P0-2 — Promote Staging Pending is 100% stuck: 6,557 rows, every hour, zero written.**
Five of eight hourly runs failed in 24 h with `WORK VANISHED / UNACCOUNTED
6,557 (100.00%)`. Every row trips `twin_address_refused` — the promoter wants
to file a sale at a *parallel* address (`…:blue-foil:…`, `…:prizm-green-scope:…`,
`…:yellow-diamond:…`) while the same sale id already sits at the `…:base:…`
address. The guard is behaving correctly (it is refusing to duplicate a sale
across two pools — exactly the I5 defect below). The defect is upstream: these
sales were **first written to a base address they do not belong to**, and
nothing moves them. Consequence: a permanently frozen staging backlog, growing
hourly, and real parallel sales never reaching their pools — so those pools
price off missing comps. Needs a lane that *moves* the sale to the correct
parallel address rather than refusing the write.
*Owner:* **Claude** (analysis + repair lane); **Drew** approves the APPLY.
*Size:* M — root-cause why the base address wins first, then a ruled,
row-naming move lane with a canary.

### P1 — before launch

**P1-1 — I5 ONE-SALE-ONE-ADDRESS breached: sales resident in up to 4 pools at once.**
7 of the 2,000 most recently rekeyed rows are double-filed; a rekey copied
instead of moved. Worst cases: `tca-ebay::168438810461` in **4** partitions,
two more in 3. **This directly inflates FMV in every pool that holds a copy** —
a duplicated sale is counted twice in the trend that projects the next sale.
Heavily concentrated in 2024 football `donruss-optic` / `panini-optic`
(the Optic fold), which ties it to the same product-naming ambiguity as P0-2.
*Owner:* **Claude** (report-first per GREAT REMATCH doctrine), Drew approves APPLY.
*Size:* M.

**P1-2 — I9 SHADOW-REDERIVATION: CONFLICT drifted well above its census reference.**
Two classes breached: vintage **62.2% vs census 31.9% (+30.3pp, n≈491)** and
modern **59.3% vs census 41.8% (+17.5pp, n≈1,087)**. A shadow re-derivation
disagreeing with stored rows on ~60% of a sample means the matcher and the
corpus have drifted apart since the census baseline. Either the census
reference is stale (recent parser fixes moved the truth) or a recent change
regressed matching. Must be *diagnosed* before launch even if the repair lands
after — right now we cannot tell which.
*Owner:* **Claude**. *Size:* M — re-run the census to re-baseline, then diff.

**P1-3 — rematch-sold-comps lane dies before it starts: 15.7% of runner runs fail.**
19 of 121 Backfill Runner runs failed in 24 h, all the same lane, all with an
**empty `/tmp/backfill.log`**, `budget marker: absent`, `finishLane line: 0`.
An empty log means the process never got far enough to print — this is a
launch/startup failure, not a budget kill, so the "own clock under ceiling"
convention is not at fault. Re-dispatch is correctly withheld, which means
those shards are simply **not progressing**. Burns ~16% of runner capacity
during the final week of catalog work.
*Owner:* **Claude**. *Size:* S–M — reproduce one shard locally and read the
first failing line.

**P1-4 — PR #1909 is ready and waiting on Drew.**
Not a defect — a handoff. Opened 2026-09-06T20:59Z, non-draft, both checks
green, iOS-only. It needs an Xcode build and Drew's merge decision before the
build that ships at launch.
*Owner:* **Drew**. *Size:* S.

**P1-5 — A failed deploy is still silent.**
Checklist coverage gap (a), unbuilt. Given that item #2 shows deploys are the
mechanism by which *every* backend fix reaches prod, a silent deploy failure
during launch week means shipping a fix and never learning it did not land —
precisely the "green workflow ≠ data flow" trap. Cheapest fix: a
`workflow_run`-triggered job on the failure conclusion that opens an issue or
mails the (newly enabled) action group.
*Owner:* **Claude** (workflow), **Drew** (if it routes to the action group).
*Size:* S.

**P1-6 — `card_catalog` sits at 400,000 RU/s.**
Not in the checklist at all; found while verifying item 17. Memory records
400K as a temporary bump "until spine passes finish, then 40K". At 10x the
intended steady state this is the largest silent cost line going into launch.
Verify consumption has actually fallen before dropping — but it must at least
be *looked at* this week.
*Owner:* **Drew** (live Cosmos config — HALT), with Claude supplying the
consumption evidence. *Size:* S.

**P1-7 — Seven scheduled jobs each failed once in 24 h.**
Sold Comps Cleanliness Canary, Catalog Token Coverage Canary, Catalog Gap
Digest, Catalog cardYear Backfill, Nightly Slug Backfill, TCA Firehose Ingest,
CH Historical Backfill. Individually small; collectively they mean **the canary
layer that is supposed to detect launch-week regressions is itself partly red**,
so a genuine regression could hide in the noise. Triage each to
"expected / chronic / real" before launch, so a red canary during launch week
carries a signal.
*Owner:* **Claude**. *Size:* M (7 short investigations).

### P2 — after launch

**P2-1 — 8 stale open PRs (excluding #1909), oldest 52 days.**
#1951, #1950, #1949 were opened today and are actively in flight — fine. The
genuinely stale: #1707, #1698, #1240, #1176, #1174, #1111, #1108, #835, #509.
Several are superseded by later work. Close or rebase after launch so the PR
list stays a real queue.
*Owner:* **Drew** decides; **Claude** can triage-and-recommend. *Size:* M.

**P2-2 — Re-scope the `sold_comps` 40K→8K rollback item (checklist is STALE).**
Rewrite the parked item's trigger. Its four named preconditions are dead runs
from August; the honest trigger is "the GREAT REMATCH program quiesces".
Do not execute the rollback now — 121 runner runs/day hit this container and
throttling it mid-program would stall catalog work.
*Owner:* **Claude** (doc edit). *Size:* S.

**P2-3 — APNs delivery is configured but unproven.**
Zero push/APNs traces or exceptions in App Insights over 7 days. Consistent
with "no notification-worthy events fired" (there is ~1 active user), not with
breakage — and the key shape is provably accepted by `loadApnsKey`. But the
08-20 → 09-04 outage was silent for 15 days precisely because nobody looked.
Send one real push to a device and confirm arrival end-to-end.
*Owner:* **Drew** (needs a device). *Size:* S.

**P2-4 — Two canary coverage gaps remain unbuilt.**
Deal-scanner job failure (in-process, silent today) and storefront-visibility-
drops-to-0. Both are checklist items (c) and (d). Low urgency at current
volume; they matter once there are sellers to disappoint.
*Owner:* **Claude**. *Size:* M.

**P2-5 — Marketplace refresh report step: add `working-directory: backend`.**
Nine consecutive red nights, but the refresh itself succeeds — only the
post-run count report fails, because the inline `node -e` at
`.github/workflows/marketplace-listings-refresh.yml` L81–84 requires
`@azure/cosmos` from the repo root while deps install under `backend/`.
One line. The reason it is P2 and not P0: **listings are refreshing normally**;
what is lost is the nightly row count. Worth fixing promptly anyway, because a
permanently-red workflow trains everyone to ignore it.
*Owner:* **Claude**. *Size:* S.

---

## Notes on method

- Every prod read was read-only. No dispatch, no config write, no APPLY.
- The APNs App Service value was **classified by shape** (PEM vs base64-of-PEM)
  without printing it; the secret never entered the transcript.
- Deploy health was gated on **step conclusions**, not on the presence of a sha,
  per the 09-04 smoke-case-#4-null incident.
- Item 18's severity was downgraded from "storefront broken" to P2 only after
  reading the per-step outcomes: the refresh step is green and only the report
  step is red. The workflow-level red was misleading.
