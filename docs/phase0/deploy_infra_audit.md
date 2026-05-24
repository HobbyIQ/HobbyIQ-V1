# Deploy infrastructure audit — 2026-05-24 incident

**Captured:** 2026-05-24 (post-incident)
**Scope:** Read-only audit of deploy script, App Service settings, Kudu logs, and Oryx interaction. No code or infrastructure changes proposed in this doc — recommendations land in their own focused workstream.
**Time budget:** 60–90 min.

**Headline.** A ~5h14m production outage on hobbyiq3 was triggered by an Oryx + zip-contents interaction under `SCM_DO_BUILD_DURING_DEPLOYMENT=true`. The pre-baked `node_modules` in the zip collided with Oryx's `compress_node_modules=tar-gz` post-build step; rsync to `/home/site/wwwroot` lost the modules tree, container crash-looped with `Cannot find module 'express'`, and two consecutive deploy attempts failed identically. Recovery: disabled `SCM_DO_BUILD_DURING_DEPLOYMENT` and `ENABLE_ORYX_BUILD`, redeployed the rollback SHA. The deploy script (`scripts/deploy-with-build-info.ps1`) is **invariant-blind** — it sets env-vars and pushes zip without verifying that the env-var state matches the zip's structure. This audit characterizes the failure and proposes hardening for a follow-up workstream.

## 1. Today's incident timeline

| Time (UTC) | Event | Source |
|---|---|---|
| 02:34:32 | Phase 1 deploy attempt 1 (SHA `b6ec8a3`, Kudu id `3239fe3e`) received | Kudu /api/deployments |
| 02:34:33 | "Preparing deployment for commit id '3239fe3e-e'" | Kudu log |
| 02:34:35 | Oryx build starts (`oryx build /tmp/zipdeploy/extracted ... -p compress_node_modules=tar-gz`) | Kudu log |
| 02:34:51 | `npm install` succeeded (424 packages, 16s) | Kudu log |
| 02:34:55 | `npm run build` → `tsc` → printed help text (no `tsconfig.json` or `src/` in zip) | Kudu log |
| 02:34:59 | Build Summary: Errors (0), Warnings (0) | Kudu log |
| 02:34:59.8 | "Deployment Failed. deployer = OneDeploy" — no rsync entries in log | Kudu log |
| ~02:35 | Container restart triggered by deploy script's [1/5] env-var change | inferred |
| 02:35–07:46 | Container crash-loop: `Cannot find module 'express'` from `/home/site/wwwroot/dist/app.js` → exit code 1 → restart, repeat | LogFiles/StartupLogs/2026_05_24_*_failure.log |
| 03:03:23 | Rollback deploy attempt (SHA `190604b`, Kudu id `cb17b384`) — identical failure pattern | Kudu /api/deployments |
| 03:15 | `az webapp stop` + `start` — production still 503 (wwwroot unchanged, container still crash-loops) | direct probe |
| 07:46 | Root cause identified via StartupLogs/2026_05_24_pl1sdlwk000IEX_failure.log: `Cannot find module 'express'` | startup log |
| 07:46 | Set `SCM_DO_BUILD_DURING_DEPLOYMENT=false` and `ENABLE_ORYX_BUILD=false` on hobbyiq3 | az webapp config |
| 07:47:52 | Rollback redeploy (Kudu id `b9bcf9d3`) — succeeded in 19s | Kudu /api/deployments |
| 07:48:13 | Deploy complete, status=4, active=true | Kudu |
| 07:49:12 | /api/health returns `{ok:true, build.sha:"190604b...", build.deployedAt:"2026-05-24T07:46:09Z"}` | direct probe |

**Total downtime: 5h 14m** (02:35 → 07:49).

**Severity classification:** High (production outage, all endpoints 503 for the full window). No data loss (Cosmos + Redis state unchanged; only the App Service container was affected). No customer-impacting calls observed in App Insights during the window — pre-launch iOS traffic is sparse.

## 2. Oryx + SCM_DO_BUILD + zip interaction

### What does `SCM_DO_BUILD_DURING_DEPLOYMENT` do?

Azure App Service's deploy-time hook: when `true`, Kudu runs the Oryx build pipeline against the extracted zip BEFORE rsync to `/home/site/wwwroot`. When `false`, Kudu skips Oryx and rsyncs the zip contents verbatim.

Per Microsoft Azure docs: this flag is intended for "source code deploys" where the zip contains source (`src/`, `tsconfig.json`, `package.json`, `package-lock.json`) and Oryx is responsible for `npm install` + build. The zip should NOT contain `node_modules` or `dist/` — Oryx generates those.

### What does `ENABLE_ORYX_BUILD` do?

Companion flag. When `true`, Oryx is invoked even if it's not the primary deployment mechanism. Effectively redundant with `SCM_DO_BUILD_DURING_DEPLOYMENT=true` for OneDeploy. Toggling either alone leaves room for inconsistent behavior; both should match.

### What happens when both are `true` AND zip contains `node_modules`?

This is the incident state. Behavior reconstructed from Kudu log analysis:

1. Kudu extracts zip to `/tmp/zipdeploy/extracted` — contains `package.json`, `package-lock.json`, `dist/`, **and** `node_modules/`
2. Oryx invoked with `compress_node_modules=tar-gz` — instructs Oryx to compress `node_modules` into a tar.gz at the destination
3. Oryx runs `npm install` in `/tmp/8deb93cfdddf84c` — **regenerates** the entire `node_modules` tree (424 packages, ~16s)
4. Oryx runs `npm run build` → `tsc` → "Compiles the current project (tsconfig.json in the working directory.)" — no `tsconfig.json` in zip, so `tsc` prints help and exits 0
5. Oryx reports "Build Summary: 0 errors, 0 warnings"
6. Post-build step is supposed to rsync `/tmp/8deb93cfdddf84c` to `/home/site/wwwroot` (with `node_modules` packed as tar.gz)
7. **Rsync silently fails or skips** — no "Rsync completed" / "Manifest created" / "Build completed successfully" / "Deployment successful" entries in Kudu log (compare against any successful deploy log: those four entries are always present)
8. Kudu reports "Deployment Failed" with no specific error and empty `status_text`

**The result on disk:** `/home/site/wwwroot` has `dist/` updated but no `node_modules/`. Container restart loads `dist/server.js` → `require('express')` → `MODULE_NOT_FOUND` → exit code 1.

### What happens when both are `false`?

Kudu skips Oryx entirely. The zip's contents (`package.json`, `package-lock.json`, `dist/`, `node_modules/`) are rsynced directly to `/home/site/wwwroot`. Container starts and finds all required modules pre-installed. **This is the recovery path that worked today (deploy `b9bcf9d3`, 19s end-to-end vs. ~30s for a typical Oryx-mode deploy).**

### Documented Azure guidance

Per Microsoft's Node.js on App Service docs: "If you want to deploy a built application, your ZIP file should contain the compiled output and dependencies (`node_modules`). Set `SCM_DO_BUILD_DURING_DEPLOYMENT=false` so the platform doesn't try to rebuild."

The hobbyiq3 deploy pattern (zip with `dist/` + `node_modules/`) matches the "deploy a built application" path. **`SCM_DO_BUILD_DURING_DEPLOYMENT=false` is the documented correct setting for our zip shape.** Yesterday's `true` setting was contrary to docs but happened to work intermittently.

## 3. Recent deploy history comparison

| Kudu id | SHA (inferred) | End time (UTC) | Status | Active | Env-vars at time of deploy |
|---|---|---|---|---|---|
| `b9bcf9d3` | 190604b | 2026-05-24T07:48:13 | 4 SUCCESS | yes | SCM_DO_BUILD=false, ENABLE_ORYX=false |
| `3239fe3e` | b6ec8a3 (Phase 1) | 2026-05-24T02:34:59 | 3 FAILED | no | SCM_DO_BUILD=true, ENABLE_ORYX=(absent/default) |
| `cb17b384` | 190604b (rollback attempt 1) | 2026-05-24T03:03:23 | 3 FAILED | no | SCM_DO_BUILD=true, ENABLE_ORYX=(absent/default) |
| `de6fb5a2` | 190604b (PR #118 deploy) | 2026-05-23T09:58:12 | 4 SUCCESS | no | SCM_DO_BUILD=true, ENABLE_ORYX=(absent/default) |
| `4add1816` | c74250b | 2026-05-23T09:36:34 | 4 SUCCESS | no | SCM_DO_BUILD=true |
| `ea2f463a` | (earlier) | 2026-05-23T00:47:00 | 4 SUCCESS | no | SCM_DO_BUILD=true |
| `de38440b` ↓ | various | 2026-05-22T20:26 ↓ | 4 SUCCESS (×8 in 24h) | no | SCM_DO_BUILD=true |

### Why did yesterday succeed under the same env vars that failed today?

The same `SCM_DO_BUILD_DURING_DEPLOYMENT=true` + same zip pattern (containing `node_modules`) ran cleanly through 8+ deploys in the 24h before today's incident. Today's first attempt failed under identical inputs.

Hypotheses (UNVERIFIED — would require Azure infrastructure access to confirm):

- **Oryx version drift.** Today's Kudu log shows `Oryx Version: 0.2.20260420.1`. Older deploys may have used a prior Oryx that handled the zip-with-node_modules edge case differently. Without Oryx version history per deploy this can't be confirmed.
- **Disk pressure on the App Service instance.** `compress_node_modules=tar-gz` requires double the `node_modules` footprint during compression. A nearly-full disk could fail the compress step silently. App Service instance disk usage isn't directly observable.
- **Race with the deploy script's [1/5] env-var change.** The script changes `GIT_SHA`/`GIT_BRANCH`/`DEPLOYED_AT` env vars BEFORE the deploy, which triggers an implicit restart. The 30s sleep may not always be enough for the restart to settle. If the restart is mid-flight when Kudu attempts rsync, file locks could cascade. Yesterday's deploys may have had the restart fully settle within 30s; today's may not have.
- **Cardinal infrastructure-level flake.** Azure App Service deploys are non-deterministic at the edge. Two consecutive deploys failing in the same window may simply be bad luck — but the empty `status_text` and missing rsync log entries are consistent with infrastructure failures.

The honest answer: **we don't know why today differed from yesterday under the same nominal inputs.** The fix is to remove the variable that could fail (Oryx involvement) by matching env-var state to zip shape.

## 4. The deploy script's invariants

`scripts/deploy-with-build-info.ps1` (162 LOC) is the production deploy entrypoint. Its design assumptions:

| Step | Action | Unstated invariant |
|---|---|---|
| Line 30 | `if (-not (Test-Path deploy.zip)) { exit 1 }` | `deploy.zip` exists at repo root — explicit |
| Line 42-46 | `az webapp config appsettings set ... GIT_SHA=...` | App Settings change won't break the existing running container; 30s sleep is enough — **unstated** |
| Line 51 | `Start-Sleep -Seconds 30` | 30s is sufficient for App Service restart to fully settle — **unstated, brittle** |
| Line 64-71 | `az webapp deploy --src-path deploy.zip --type zip --restart false --async true` | Deploy mechanism (OneDeploy) will handle the zip correctly given current App Settings — **unstated** |
| Throughout | Deploy mode depends on `SCM_DO_BUILD_DURING_DEPLOYMENT` + `ENABLE_ORYX_BUILD` | **Script does NOT verify these App Settings before deploying** — invariant blind |
| Line 100-129 | Poll Kudu until `status=4` | `Write-Error` inside try/catch is caught and swallowed — script polls forever on `status=3` instead of exiting — **bug** |
| Line 144-157 | Verify `/api/health` reports the expected SHA | `GIT_SHA` env var was already set at [1/5]; /api/health reads from env, so this check succeeds even if the wwwroot is broken — **Finding 11 trap reincarnated** |

### Critical missing invariant

The script's deploy mechanism (`az webapp deploy --type zip` = OneDeploy) behavior depends on:
- `SCM_DO_BUILD_DURING_DEPLOYMENT` (controls Oryx invocation)
- `ENABLE_ORYX_BUILD` (controls Oryx fallback)
- Zip contents (with/without `node_modules`, with/without `tsconfig.json`+`src/`)

These three must be coherent. Two valid combinations:

| Mode | App Settings | Zip contents |
|---|---|---|
| **Source-deploy** | `SCM_DO_BUILD=true`, `ENABLE_ORYX=true` | `src/`, `tsconfig.json`, `package*.json` (NO `dist/`, NO `node_modules/`) |
| **Built-artifact deploy** | `SCM_DO_BUILD=false`, `ENABLE_ORYX=false` | `dist/`, `node_modules/`, `package*.json` (NO `src/` needed) |

Today's incident was the mismatch: `SCM_DO_BUILD=true` (expecting source) + zip containing `dist/`+`node_modules/` (built-artifact shape). Oryx attempted to recompile (no source) AND repackage `node_modules` (`compress_node_modules=tar-gz`). Rsync output drifted from expected layout and the deploy stalled.

The script has no check for this mismatch. **A pre-deploy invariant check would have caught both the b6ec8a3 attempt and the rollback attempt before they touched production.**

## 5. The Finding 11 connection

[SESSION_HANDOFF Finding 11 (2026-05-21 PM)](../../docs/SESSION_HANDOFF.md#finding-11--stale-deployzip-incident-new-2026-05-21-pm) characterized a similar trap: the deploy script's `/api/health` SHA verification succeeds based on env-var read, not actual wwwroot content. The fix at the time was: rebuild + zip + redeploy.

**How is today's incident the same as Finding 11?**

- Both involve `/api/health` SHA being misleading because `GIT_SHA` is set at deploy script [1/5] independently of whether the deploy actually succeeds
- Both expose the script's invariant-blindness — it trusts inputs and doesn't verify outputs

**How is today's incident different from Finding 11?**

- Finding 11: stale `deploy.zip` (script consumed an old artifact) — the *zip* was wrong
- Today: zip content correct but env-var state mismatched — the *deployment mode* was wrong
- Finding 11: production stayed up (old code still served traffic, just had wrong SHA reported); today's incident took production DOWN (broken wwwroot crash-looped the container)

**Was the previous fix sufficient? What did it miss?**

The Finding 11 fix was operational ("rebuild + zip" runbook step). It did not harden the deploy script. The same script that surfaced Finding 11 surfaced today's incident — it's been brittle the whole time, and we got unlucky today.

**Should the Finding 11 docs have flagged this as a follow-up?**

Yes. SESSION_HANDOFF Finding 11 noted three options for follow-up: "(a) make the deploy script build/zip itself, (b) add a CI step that fails if `deploy.zip` mtime < latest commit on `main`, or (c) accept the gap and rely on the schema-probe discipline going forward — decision deferred." None of (a)/(b)/(c) addressed the env-var-state mismatch class of failure. Today's incident is a fourth category that wasn't on the radar.

## 6. Required state for safe Phase 1 retry

Before re-attempting the b6ec8a3 deploy, the following must be true:

1. **App Settings durable:** `SCM_DO_BUILD_DURING_DEPLOYMENT=false` and `ENABLE_ORYX_BUILD=false` must be confirmed set on hobbyiq3. (Both are currently set as of 2026-05-24T07:46.) These should be made durable via Infrastructure-as-Code or at least documented as required state.

2. **Deploy script updated:** `scripts/deploy-with-build-info.ps1` should add a pre-deploy invariant check:
   - Read current `SCM_DO_BUILD_DURING_DEPLOYMENT` and `ENABLE_ORYX_BUILD` from App Settings via `az webapp config appsettings list`
   - Inspect `deploy.zip` to detect whether it contains `node_modules/` and `dist/`
   - If zip contains `node_modules/` AND `SCM_DO_BUILD` is `true`: ABORT with clear error message
   - If zip contains `src/` AND no `dist/` AND `SCM_DO_BUILD` is `false`: ABORT with clear error message
   - Exit cleanly before [1/5] env-var change — leaves production untouched on misconfiguration

3. **Deploy script's Kudu poll bug fixed:** The `Write-Error ... exit 1` inside the `try` block at lines 118-119 is caught by the outer `catch` and swallowed. The script then polls forever on `status=3`. Should be replaced with `throw` (un-catchable) or set a flag and break out cleanly.

4. **Deploy script's SHA verification hardened:** Currently the script verifies `/api/health` reports the new SHA — but since `GIT_SHA` env var is set at [1/5] independently of wwwroot state, this passes even on a broken deploy. Replace with a feature-probe (e.g., probe a known-new endpoint or check a known-changed response field).

5. **Pre-deploy verification step:** Before pushing the deploy zip to production, optionally deploy to a staging slot or test instance first. App Service Standard tier supports deployment slots; current hobbyiq3 tier should be verified.

6. **Zip artifact verification:** `zip.js` should print or verify expected contents (file count, total size, presence of `dist/`, presence of `node_modules/`) — fails the build script if invariants don't match.

## 7. Recommendations

Concrete changes, sized as a separate workstream:

| Item | File | LOC | Priority |
|---|---|---|---|
| Add invariant check at start of deploy script | `scripts/deploy-with-build-info.ps1` (new pre-step before [1/5]) | ~30-40 | High — prevents the next incident |
| Fix Kudu poll `Write-Error` swallowing bug | `scripts/deploy-with-build-info.ps1:118-119` | ~3 | High — current script can hang forever |
| Replace `/api/health` SHA verification with feature-probe | `scripts/deploy-with-build-info.ps1:140-162` | ~15 | Medium — Finding 11's residual hazard |
| Make `SCM_DO_BUILD_DURING_DEPLOYMENT=false` + `ENABLE_ORYX_BUILD=false` durable via Bicep/ARM template or docs | infra (TBD) + `docs/deployment/` | ~10-20 + doc | Medium — prevents drift |
| Add zip content audit to `zip.js` (count + size + structure check) | `zip.js` | ~10-15 | Low — defense in depth |
| Update SESSION_HANDOFF Finding 11 entry with today's add-on category and pointer to this audit | `docs/SESSION_HANDOFF.md` | docs | Low — follow-up doc hygiene |

**Estimated total workstream size:** ~70-100 LOC + small docs additions, ~2-3 hour focused session. Should ship BEFORE any Phase 1 retry.

**Suggested PR title:** "harden(deploy): pre-deploy invariant check + Kudu poll fix + feature-probe verification"

## Anti-drift note

This document characterizes the incident, the deploy infrastructure, and required hardening. It does **not** ship any code changes. The recommendations belong to a focused follow-up workstream.

Specific things NOT proposed here:
- Migrating to a different deploy mechanism (GitHub Actions, Bicep, Terraform)
- Adding deployment slots or blue/green strategies
- Switching the zip pattern to slim-zip (source-only, source-deploy mode)
- Rewriting the deploy script in a different language

All of those are valid future considerations but are out of scope for closing today's incident.
