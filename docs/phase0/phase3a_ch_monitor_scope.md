# Phase 0 / Phase 3a — CH access tripwire monitor scope

**Captured:** 2026-05-21 PM
**Scope:** Read-only investigation. Output is a recommendation; no monitor deployed in this doc.
**Purpose:** Operational tripwire that fires when `fn-cardhedge-comps` stops producing Card Hedge comp data — the prerequisite to any Phase 3 cleanup work (CH code removal).
**Time budget:** 30 min.

**Headline:** Recommend **Option D (GitHub Action workflow)**. Options A (App Insights query alert) and B (Azure Monitor metric alert) **cannot catch the load-bearing signal** — `comp_count` is a per-blob content value, not an emitted telemetry metric or a storage-metric exposure. Option C (new Azure Function) would deepen the source-on-branch anomaly from Workstream C / Finding 10. Per the Phase 3a spec's conditional gate, this recommendation means **Step 2 does NOT run tonight** — Phase 3a monitor ships in a separate focused session that builds the GitHub Action.

## Contradiction with brief — player list

**Brief said:** "5 players (Skenes, Chourio, Ohtani, Trout, Soto per W6.3 inventory)."
**Actual deployed list per `compiq-signals/{slug}/cardhedge.json` blob inventory:** Aaron Judge, Mike Trout, Shohei Ohtani, Juan Soto, Ronald Acuna Jr.

| Brief player | In actual list? |
|---|---|
| Skenes | **NO** — replaced by Aaron Judge |
| Chourio | **NO** — replaced by Ronald Acuna Jr |
| Ohtani | yes |
| Trout | yes |
| Soto | yes |

3 of 5 match. Brief was wrong on Skenes/Chourio (those names appear elsewhere in this session's docs as augmented synthetic-soak corpus entries — likely how the confusion arose). W6.3 blob inventory (commit `672ffd8`) lists the correct 5; verified again here against live blob state.

Plus one stale player blob: **`caleb-bonemer/cardhedge.json`** last-modified `2026-05-10T15:04:21Z` (11 days stale). Per W6.3 this was dropped from `_DEFAULT_PLAYERS` ~11 days ago — not in scope for the monitor.

## 1. Existing alert infrastructure inventory

### Action Groups in `rg-hobbyiq-dev`

| Name | Short | Enabled | Emails | Webhooks |
|---|---|:-:|---|---|
| `Application Insights Smart Detection` | `SmartDetect` | true | (none) | (none) |

**Only one Action Group, functionally unwired.** Created automatically by App Insights, no notification targets configured. **A monitor that ships in any of options A–D needs either this Action Group wired with a real target OR a new Action Group created.**

### Scheduled-query alert rules (App Insights query alerts)

`az monitor scheduled-query list -g rg-hobbyiq-dev` → **0 rules.** No App Insights query alerts exist. (`scheduled-query` CLI extension was not installed; installed during this scoping pass — preview-only extension, may be a slight maintenance signal.)

### Metric alert rules

`az monitor metrics alert list -g rg-hobbyiq-dev` → **0 rules.** No metric alerts exist.

### Notification infrastructure in code

`grep -lriE "smtp|sendgrid|webhook" backend/src/services` returns: `ebay/ebayTokenStore.service.ts`, `ebay/ebayWebhookEvents.service.ts`, `portfolioiq/portfolioStore.service.ts`. **eBay-specific webhook handlers exist** but no general-purpose notification layer (SMTP/SendGrid/Pushover etc.) is wired into the backend. Any monitor that needs to send a human-readable notification has to wire it from scratch.

**Net:** alert infrastructure is essentially greenfield. Whatever ships will create the first real notification path in `rg-hobbyiq-dev`.

## 2. Player list and signal characterization

### Verified active players (live blob state, 2026-05-21 PM)

| Player slug | `comp_count` | `signal` | `updated_at` |
|---|---:|---|---|
| `aaron-judge` | 27 | stable | 2026-05-21T02:00:13.526Z |
| `mike-trout` | 27 | rising | 2026-05-21T02:00:05.984Z |
| `shohei-ohtani` | 27 | falling | 2026-05-21T02:00:07.491Z |
| `juan-soto` | 27 | stable | 2026-05-21T02:00:22.963Z |
| `ronald-acuna-jr` | 27 | rising | 2026-05-21T02:00:18.433Z |

All 5 active blobs written within an 18-second window after the cron's 02:00 UTC fire (the function's full run takes ~18 s for 5 players against the CH API). All 5 carry `comp_count = 27` — per Workstream A (commit `7d336ab`) this is the Card Hedge API's default `/cards/comps` page size, not a freshness signal.

### Write path

`compiq-signals/{player_slug}/cardhedge.json` in storage account `stcompiqfnotgm2` (eastus, `/subscriptions/ce160cf3-.../providers/Microsoft.Storage/storageAccounts/stcompiqfnotgm2`). Written by `fn-cardhedge-comps` via `shared/__init__.py:save_signal()` using `AZURE_BLOB_CONNECTION_STRING` env var.

### Historical baseline — limited

**Blob versioning is NOT enabled** on `stcompiqfnotgm2` (`isVersioningEnabled: null`). Each nightly run overwrites the previous blob. **Cannot sample "last 7 nights" from storage** — only today's snapshot is available.

What we know about expected behavior (from Workstream A source analysis + the live data above):
- **CH access alive + cards have comps:** `comp_count = 27, signal = "rising|stable|falling", raw_sales = [27 real eBay-sourced sales]`
- **CH access alive + no comps for a player:** `comp_count = 0, signal = "no_data"` (per `build_comps_payload` in `shared/cardhedge.py`)
- **CH `search_cards` returns no match:** `comp_count = 0, signal = "no_match"` (per `function.py`)
- **CH key revoked / API 401:** `search_cards` logs warning and returns `[]` → flow continues to no_match payload → `comp_count = 0`
- **Function crashes mid-player:** that player's blob is NOT updated (stays at prior day's value); other players continue

### Proposed threshold

Two complementary signals:

1. **`comp_count < 10` on any active player blob** — catches CH-access-revoked (all players go to 0) AND CH-degradation (one or two players failing).
2. **Blob `lastModified` older than 25 hours on any active player blob** — catches function-not-running OR per-player-write-failed.

`< 10` chosen because:
- Healthy state is consistently 27 (CH API default page size, observed today)
- A drop from 27 → ~20 could be a natural CH-side data-availability dip; not necessarily an alert
- A drop to single digits or 0 is the signal we care about (CH is dead or the player isn't being found)
- Tunable; could tighten to `< 20` after observing baseline variance over a week

### Caveat about `caleb-bonemer` schema gap

`caleb-bonemer/cardhedge.json` (2026-05-10) returned **no `comp_count` field at all** when grep'd — either the schema evolved after 2026-05-10 to add `comp_count`, or the blob was written by a different code path. The 5 active blobs all have the field. Worth noting for the monitor's tolerance — if the schema changes again, the monitor must handle missing-field gracefully (treat as `null` / unknown, not as `0`).

## 3. Implementation options

| Option | Catches `comp_count < 10`? | Catches function-not-running? | Effort | False positive risk | Maintenance |
|---|:-:|:-:|---|---|---|
| **A — App Insights scheduled query alert** | **NO** | Partial | Med (alert rule low, but requires wiring telemetry first) | Low | Low |
| **B — Azure Monitor metric alert (storage)** | **NO** | Yes (blob LastModified staleness via Transaction metric or LastWriteTime) | Low | Medium (storage metrics noisy) | Low |
| **C — New `fn-ch-monitor` Azure Function** | YES | YES | Medium-High (new function, deploy-pipeline gap per Finding 10) | Low | Medium |
| **D — GitHub Action workflow** | YES | YES | Low-Medium (one workflow yaml + SP/MI for storage read) | Low | Low |

### Option A — App Insights scheduled query alert

**Cannot catch `comp_count < 10`.** `fn-cardhedge-comps` does NOT emit application traces to App Insights component `hobbyiq-insights` (per W6 close-out capture #7 + Workstream A re-verification: only host-level traces fire — function discovery, schedule, listener stop/start; no `logging.info` from inside the function reaches AI). `comp_count` is a value computed inside the function and written to blob; it never appears as a telemetry metric. To make Option A viable, `fn-cardhedge-comps` would first need an Application Insights wire-up emitting `comp_count` per player per run — that's a separate, larger workstream (the broader observability bifurcation from W6 capture #1).

Could partially fire on "no `fn-cardhedge-comps` host trace in last 25 h" — but that catches function-not-running, not CH-access-dead-but-function-still-running.

### Option B — Azure Monitor metric alert on storage

**Cannot catch `comp_count < 10`.** Standard storage account metrics (`Transactions`, `Ingress`, `Egress`, `BlobCount`) operate at the container/account level, not the per-blob content level. `comp_count` is a value INSIDE the blob JSON, invisible to storage metrics.

Can fire on:
- `Transactions` filter `ApiName='PutBlob'` for container `compiq-signals` being `0` in last 25 h → catches function-not-running.
- Blob count change rate — noisy proxy, not directly useful.

A blob-level "LastModified" alert is technically possible via a custom log query against `StorageBlobLogs` (requires diagnostic settings → Log Analytics workspace), but that's effectively Option A with extra plumbing.

**Misses the load-bearing case:** if CH revokes and the function STILL writes blobs (with `comp_count: 0`), storage metrics see normal write activity. The tripwire fails to fire.

### Option C — New `fn-ch-monitor` Azure Function

Daily timer-triggered function (e.g., cron `0 30 2 * * *` — fires 30 min after `fn-cardhedge-comps`). Reads each of the 5 active player blobs, parses `comp_count`, evaluates threshold, sends notification via Action Group webhook or direct SendGrid/SMTP.

**Pros:** correct fidelity for the actual signal. **Cons:** adds a 15th deployed function. **Deepens the Finding 10 source-on-branch anomaly** — adding a new function makes the gap between `main` and deployed wwwroot wider, since `main` doesn't carry any `fn-*` source today. New function would either land on the snapshot branches (perpetuating the split) or force the canonical-branch decision now (out of scope per Finding 10's own framing).

Also: would need its own COSMOS_KEY / blob-read auth, which per Workstream B's secondary concern may share the same `COSMOS_KEY`-mismatch defect as `fn-nightly-comp-prefetch` — could ship and silently fail.

### Option D — GitHub Action workflow

A `.github/workflows/ch-monitor.yml` that runs on a schedule (e.g., `cron: '30 2 * * *'`). Reads each player blob via `az storage blob download` using a federated identity or stored connection string secret, parses `comp_count`, fails the workflow run if any player < threshold. Notification via:
- GitHub Issues (`gh issue create` from inside the action when threshold breached) — already authenticated, no extra infra
- Slack webhook to a configured URL (one secret to set)
- Email via GitHub's built-in notification on workflow failure (existing default for repo admins)

**Pros:**
- Correct fidelity for `comp_count < 10` signal
- Uses already-deployed infrastructure (8 GitHub Action workflows already in `.github/workflows/` per Workstream C)
- One file to ship + one secret/SP credential — no new function, no AI wiring, no Action Group creation needed if GitHub-native notification is acceptable
- **Does NOT deepen the Finding 10 source-on-branch anomaly** — `.github/workflows/` is fully on `main` today; adding a workflow doesn't touch `compiq-functions/`
- Workflow run history is visible in GitHub UI for ops audit

**Cons:**
- Auth: needs a service principal or managed identity with `Storage Blob Data Reader` on `stcompiqfnotgm2`. Modest setup.
- Slightly outside the Azure-native monitoring story (some teams prefer all monitoring inside Azure Monitor; this team has no such standard documented in `copilot-instructions.md`).
- Workflow availability tied to GitHub Actions runner availability — usually fine, occasional service-side delays.

## 4. Recommendation — Option D (GitHub Action), deferred to next focused session

**Recommended option:** D.

**Concrete parameters for the build session:**
- **File:** `.github/workflows/ch-monitor.yml`
- **Schedule:** `cron: '30 2 * * *'` (30 min after `fn-cardhedge-comps`'s 02:00 UTC nightly run completes)
- **Monitored players (5):** `aaron-judge`, `mike-trout`, `shohei-ohtani`, `juan-soto`, `ronald-acuna-jr`
- **Trigger condition (per player):** `comp_count < 10` OR blob `lastModified` older than `25 h`
- **Auth:** federated managed-identity SP with `Storage Blob Data Reader` role on `stcompiqfnotgm2`. Configure via `azure/login@v2` action.
- **Notification target:** open a GitHub Issue with title `[CH-MONITOR] comp_count below threshold for {player}` and label `incident`. Secondary (optional): post to a Slack webhook stored as a repo secret.
- **Tolerance for `caleb-bonemer`-style schema gap:** treat missing `comp_count` field as `null` (unknown), surface separately as a warning rather than failing the workflow.
- **Test mode:** workflow_dispatch input `dry_run=true` that runs the read + evaluation but skips notification, for safe testing before going live.

**Why Step 2 does NOT run tonight (per spec):**
The Phase 3a spec Step 2 conditional: "This step runs ONLY if Step 1 recommends Option A or B — both deployable in-session. If Step 1 recommends Option C or D: Capture as a follow-up issue. HALT, do not start the build. Monitor ships in a separate focused session."

Option D is recommended → Step 2 does not run tonight. Captured as follow-up.

**Follow-up issue to file for the build session:**
- Title: `Phase 3a — ship CH access tripwire monitor as GitHub Action`
- Scope: implement `.github/workflows/ch-monitor.yml` per the concrete parameters above, configure SP + storage role, test in `workflow_dispatch dry_run` mode, then enable schedule and verify first scheduled fire.
- Effort estimate: 1–2 h focused session.
- Dependencies: none blocking (Action Groups infra greenfield, but Option D doesn't need them).

## Anti-drift note

This document characterizes options and recommends one. It does not deploy a monitor, create Action Groups, edit alert rules, or touch the GitHub Actions configuration. All of that is the follow-up build session's work. The recommendation is a starting input to that session, not a binding decision.
