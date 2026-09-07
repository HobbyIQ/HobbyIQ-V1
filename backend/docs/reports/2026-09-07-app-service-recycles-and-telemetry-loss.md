# App Service recycles + "telemetry loss" — diagnosis (#1973)

**Date:** 2026-09-07 · **App:** HobbyIQ3 (rg-hobbyiq-dev, Central US) · **Go-live:** ~2026-09-14
**Status:** both causes identified. Neither is a crash. Neither is data loss.

---

## TL;DR

| # | Reported | Actual cause | Severity |
|---|---|---|---|
| 1 | Both workers recycle every 8–19 min | **Self-inflicted: ~23 manual `Daily 5AM ET Refresh & Deploy` dispatches in one day**, each restarting the app **twice** | Behavioural, not a defect. Real impact on in-process jobs. |
| 2 | App Insights holds only ~65 min | **False. 7 full days are retained.** The *query API* times out because `AppDependencies` holds **215.7M rows/7d** | Real, but it is a telemetry-cost/usability bug, not loss |

Two prior hypotheses are **ruled out with evidence**: it is **not** OOM, and it is **not** a crash on an unhandled rejection.

---

## 1. Recycles — cause class: **platform-initiated, triggered by our own deploy pipeline**

### Evidence

**A. Boots are simultaneous across two independent containers.** From `AppTraces`, 6h:

```
dd3ce8d7  15:21:37     ac866b9c  15:22:56
ac866b9c  16:55:49     dd3ce8d7  16:55:50   <- 1s apart
ac866b9c  16:56:32     dd3ce8d7  16:56:34   <- again, 43s later
ac866b9c  17:15:55     dd3ce8d7  17:15:57
ac866b9c  17:16:40     dd3ce8d7  17:16:43
ac866b9c  17:25:12     dd3ce8d7  17:25:15
ac866b9c  17:25:57     dd3ce8d7  17:25:59
ac866b9c  17:39:33     dd3ce8d7  17:39:52
dd3ce8d7  17:57:05     ac866b9c  17:57:06
ac866b9c  18:55:35     dd3ce8d7  18:55:56
```

10 boots per instance in 3.5h. **Two separate containers cannot crash within 1–3 seconds of each other, ten times.** That excludes every in-process cause and points at a site-level operation.

Note the **pairing**: boots arrive in twos ~45s apart. That is the signature below.

**B. The activity log names the operation and the caller.** 12 events in 8h, all from one principal:

```
15:19:16  Microsoft.Web/sites/publishxml/action   Succeeded  aa4f53c7-...
15:20:12  Microsoft.Web/sites/config/write        Succeeded  aa4f53c7-...
16:54:42  Microsoft.Web/sites/publishxml/action   Succeeded  aa4f53c7-...
16:55:41  Microsoft.Web/sites/config/write        Succeeded  aa4f53c7-...
17:14:50  Microsoft.Web/sites/publishxml/action   Succeeded  aa4f53c7-...
17:15:46  Microsoft.Web/sites/config/write        Succeeded  aa4f53c7-...
```

`aa4f53c7-02e0-43cd-a19c-b5dec1639cb7` = **`oidc-msi-8761`**, a ManagedIdentity — the GitHub Actions OIDC federated identity.

**C. The workflow explains the *pair* of restarts.** `.github/workflows/daily-refresh.yml`:

- step **Deploy to Azure App Service** (`azure/webapps-deploy@v3`) → restart #1 (the `publishxml` event)
- step **Update build metadata App Settings** (`az webapp config appsettings set` for `GIT_SHA`/`GIT_SHA_SHORT`/`GIT_BRANCH`/`DEPLOYED_AT`) → **restart #2**, ~45–60s later (the `config/write` event)

An App Settings write always recycles the app. So **every deploy costs two restarts**, matching the observed pairs exactly.

**D. The deploy ran ~25 times in 20 hours — 23 of them manual dispatches.**

```
18:51:16 -> 19:04:12  workflow_dispatch    17:53:03 -> 18:04:38  workflow_dispatch
17:35:20 -> 17:46:03  workflow_dispatch    17:22:33 -> 17:31:17  workflow_dispatch
17:12:45 -> 17:21:17  workflow_dispatch    16:52:58 -> 17:02:58  workflow_dispatch
15:17:27 -> 15:27:26  workflow_dispatch    10:13:07 -> 10:25:47  schedule
09:21:46 -> 09:34:42  schedule             07:42:15 -> 07:55:51  workflow_dispatch
... 15 more workflow_dispatch runs back through 2026-09-06 23:32
```

Deploy completion times line up with the boot pairs one-for-one (e.g. run ending 17:21:17 ↔ boots 17:15:55/17:16:40; run ending 19:04:12 ↔ boots 18:55:35/18:55:56).

**Why so many dispatches:** `CLAUDE.md` mandates a manual `Daily 5AM ET Refresh & Deploy` dispatch after **every** PR merge touching `backend/src`. On a heavy merge day (~20 merges) that is ~20 deploys → ~40 restarts → **a mean process lifetime of roughly 10 minutes**. The rule is working as written; the cost simply was not visible.

### Ruled out, with evidence

- **OOM — NO.** `MemoryWorkingSet` peaks **~690–900 MB** against **P2v3 = 16 GB** (~4–6%). No sawtooth, no ceiling contact.
  - *Caveat worth noting:* `use32BitWorkerProcess: true` is set on a Linux Node app. It is inert on Linux (`reserved: true`), but it is wrong and should be cleared so it can never cap address space at ~2 GB.
- **Auto-heal — NO.** `autoHealEnabled: false`, `autoHealRules: null`.
- **Crash on unhandled rejection — NO.** Only **11 exceptions in 6h**, all one benign kind: `The operation was aborted due to timeout` (a `DOMException` from an outbound `fetch` abort). Far too few to explain 20 boots, and none at boot times.
- **App's own `process.exit` — NO.** No `process.exit` anywhere in the server path; only in `src/scripts/**` and `writeReconciliation.ts` (which sets `process.exitCode`, never exits).
- **Plan scale / host patch — NO.** No scale events in the activity log; plan `HobbyIqPLan2` P2v3 capacity 2, `Ready` throughout.
- **Slot swaps — NO.** `slotSwapStatus: null`; no deployment slots.
- **Node version change — NO.** `linuxFxVersion: NODE|22-lts`, unchanged. No `--max-old-space-size` flag is set anywhere (`appCommandLine: node dist/server.js`).
- **5xx — NO.** 2 total in 6h.

### The real damage

`src/server.ts` starts **13 in-process timer jobs** inside `app.listen()`. With a ~10-minute process lifetime:

| Job | Cadence | Fires? |
|---|---|---|
| BuyerIQ deal scanner | 60 min (first run +2 min) | only the +2min first-run |
| eBay finances enrichment | 6 h (first run +120 s) | never the interval |
| Advanced alerts evaluator | 4 h | **never** |
| Matched-cohort momentum | nightly | **never** |
| Subscriptions safety net | nightly 05:15 PT | **never** |
| DailyIQ / portfolio reprice / price alerts | daily / 30 min | rarely or never |

Anything on a `setInterval` longer than the process lifetime **has never fired in production from the interval path**. Only the short `setTimeout` first-runs execute, which is why the deal scanner appeared alive while the 4h/6h/nightly jobs were silent.

> Related work already in flight: commit `f23ea39f` *"fix(jobs): an hourly timer never fires on a process that lives ten minutes"* (branch `fix/deal-scanner-lease-expiry-and-scheduler-survival-0907-1802`) — not yet in `main` as of this report.

---

## 2. "Telemetry loss" — cause class: **not loss; query-side timeout from dependency flood**

### The reported symptom is false

Querying the workspace directly (`hobbyiq-logs`, `2a903998-79f4-4549-8042-5af803ab1e54`):

| Table | Oldest | Newest | Rows / 7d |
|---|---|---|---|
| AppRequests | 2026-08-31T18:51 | 2026-09-07T18:48 | 56,212 |
| AppExceptions | 2026-08-31T19:01 | 2026-09-07T18:46 | 518 |
| AppTraces | 2026-08-31T18:50 | 2026-09-07T18:50 | **15,442,568** |
| AppDependencies | 2026-08-31T18:50 | 2026-09-07T18:50 | **215,692,220** |

**A full 7 days is present in every table.** The "~65 minutes" was an artifact of the App Insights query surface timing out and returning only what it could scan.

### Checks — all clean

- Component `hobbyiq-insights`: `retentionInDays: 30`, `ingestionMode: LogAnalytics`, **`samplingPercentage: null` (no ingestion sampling)**.
- Workspace `hobbyiq-logs`: `retentionInDays: 30`, `workspaceCapping.dailyQuotaGb: **-1**` (uncapped), `dataIngestionStatus: RespectQuota`.
- **Table-level retention: no overrides.** Every table reports `RetentionAsDefault: True`; the ten `App*` tables are all at **90 days**.
- No purge activity in the activity log.

### The actual defect: 215.7M dependency rows in 7 days

**~356,000 dependency rows/hour**, overwhelmingly Cosmos gateway chatter:

```
DependencyType: HTTP   Name: "GET /"   Target: hobbyiq-comps.documents.azure.com
DurationMs: 1   ResultCode: 200   SDKVersion: ali_node:2.9.6
```

These are Cosmos SDK metadata/health pings recorded individually. Compounding it, `src/server.ts` calls:

```ts
.setAutoCollectConsole(true, true)   // 2nd arg = send every console.* as a TRACE
```

which is why `AppTraces` carries 15.4M rows — including large volumes of Cosmos SDK first-chance warnings that are explicitly self-described as ignorable:

> `azure:RequestHandler:warning 400 ... The provided cross partition query can not be directly served by the gateway. This is a first chance (internal) exception ... you can safely ignore this message.`

**Consequences:** the AI query API times out on windows as short as 5 minutes; and at PerGB2018 pricing this ingest volume is a material and rising bill ahead of go-live.

---

## 3. Remediation — commands for Drew

> **HALT — none of these were run.** Items A(2), B(2)(3), C and D are live-config changes and are blocked pending explicit confirmation per the project HALT rule.

### A. Stop the double restart per deploy (highest value, zero risk)

The `appsettings set` step exists only to keep `/api/health` build metadata accurate. It doubles the restarts. Two options:

**A1 — preferred: drop the settings write; read build info from the deployed artifact.** `scripts/write-build-info.cjs` already writes `dist/build-info.json` at build time, so the SHA ships *inside* the package. Delete the **"Update build metadata App Settings"** step from `.github/workflows/daily-refresh.yml` and have `/api/health` read `dist/build-info.json`. Removes restart #2 permanently, no Azure config change.

**A2 — if the setting must stay:** set the four keys **before** `webapps-deploy` runs, so the two operations collapse into a single restart window.

### B. Cut the telemetry flood

```bash
# 1) Confirm the dependency source before changing anything
#    (small window; larger ones time out)
az monitor log-analytics query \
  --workspace 2a903998-79f4-4549-8042-5af803ab1e54 \
  --analytics-query "AppDependencies | where TimeGenerated between (ago(10m) .. ago(5m)) | summarize N=count() by DependencyType, Name, Target | top 20 by N desc" \
  -o table

# 2) Enable ingestion sampling on the component.
#    HALT: live config change.
az rest --method patch \
  --url "https://management.azure.com/subscriptions/ce160cf3-ee69-4832-ade2-f0cf57ba2f57/resourceGroups/rg-hobbyiq-dev/providers/microsoft.insights/components/hobbyiq-insights?api-version=2020-02-02" \
  --body '{"properties":{"SamplingPercentage":10}}'

# 3) Optional safety net: a daily cap so a runaway loop cannot produce a
#    surprise bill. HALT: live config change. Pick the GB number deliberately.
az monitor log-analytics workspace update \
  --resource-group rg-hobbyiq-dev --workspace-name hobbyiq-logs \
  --set workspaceCapping.dailyQuotaGb=20
```

**Code-side (ships through a normal PR, no HALT):** change `setAutoCollectConsole(true, true)` → `setAutoCollectConsole(true, false)` in `src/server.ts`. Console output still reaches the App Service log stream; it stops minting a billed `AppTraces` row per `console.log`. This alone should remove most of the 15.4M traces.

### C. Cosmetic but wrong — clear the 32-bit flag

```bash
# HALT: live config change. Inert on Linux today, but it is a loaded gun.
az webapp config set --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --use-32bit-worker-process false
```

### D. Add a health check path so recycles are graceful

`healthCheckPath` is `null`, so App Service cannot tell a warming instance from a ready one and returns instances to rotation without gating on readiness.

```bash
# HALT: live config change.
az webapp config set --name HobbyIQ3 --resource-group rg-hobbyiq-dev \
  --generic-configurations '{"healthCheckPath":"/api/health"}'
```

### E. Move long-cadence jobs off in-process timers

Even after A, deploys legitimately restart the app. Any job with a cadence longer than the deploy interval must not depend on a surviving process. Jobs at 4h/6h/nightly should move to scheduled GitHub Actions (the pattern `daily-refresh.yml` and the other cron workflows already use), or persist a "last run" timestamp and catch up at boot. Tracked by `f23ea39f` for the scanner; the 4h/6h/nightly jobs still need it.

### Verification after A + B

```bash
# Boots per instance should collapse to ~1 per intentional deploy
az monitor log-analytics query --workspace 2a903998-79f4-4549-8042-5af803ab1e54 \
  --analytics-query "AppTraces | where TimeGenerated > ago(6h) | where Message startswith 'HobbyIQ API listening' | summarize Boots=count() by Inst=substring(AppRoleInstance,0,8)" -o table

# And the new attribution event names WHY each one happened
az monitor log-analytics query --workspace 2a903998-79f4-4549-8042-5af803ab1e54 \
  --analytics-query "AppEvents | where TimeGenerated > ago(6h) | where Name == 'worker_shutdown' | project TimeGenerated, Properties" -o table
```

---

## 4. Code fix shipped in this PR

`backend/src/services/ops/workerLifecycle.ts` (+ wired first in `src/server.ts`):

- **`worker_shutdown` custom event** naming the reason — `SIGTERM` (platform recycle: deploy, appsettings write, scale, patch), `SIGINT`, `uncaughtException`, `unhandledRejection` — with `uptimeSeconds`, a `shortLived` flag (<20 min: the recycle signature), and `gitSha`. **The next incident is attributable from telemetry alone**, instead of requiring the activity-log dig this report needed. Emitted to App Insights *and* stdout, since the platform may kill the process before a flush completes.
- **Idempotent**: a worker dies once; the first reason wins, so SIGTERM followed by a teardown exception yields one row, not two.
- **Unhandled-rejection liveness**: rejections are logged, counted and **absorbed**. Node's default is to terminate — on a 2-worker plan one stray promise is a user-visible outage. `uncaughtException` still terminates (process state is genuinely unknown) but reports first.
- Telemetry never throws; all emits wrapped.

Deliberately **not** included: job draining/checkpointing on SIGTERM (needs per-job cooperation — that is item E), and no change to `setAutoCollectConsole` (called out in B, but it is a behavioural telemetry change that deserves its own reviewed PR rather than riding along here).

Tests: `backend/tests/workerLifecycle.test.ts` — 9 cases pinning reason attribution, uptime/shortLived, idempotence, detail truncation at 500 chars, emitter-failure safety, listener non-accumulation, and the decisive one: **absorbing a rejection is not a shutdown**.
