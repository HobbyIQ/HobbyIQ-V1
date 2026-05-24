# HobbyIQ deployment runbook

**Scope:** App Service deploys for `hobbyiq3` (backend). compiq-mcp follows the same pattern; differences noted inline.

**Last verified:** 2026-05-25 (post deploy-infra-harden PR; no-op deploy test verified script end-to-end).

## TL;DR

Deploys are **built-artifact mode**: the zip contains pre-compiled `dist/` and pre-installed `node_modules/`; Azure App Service rsyncs the zip verbatim to `/home/site/wwwroot` without running Oryx. The deploy script (`scripts/deploy-with-build-info.ps1`) enforces this invariant before touching production.

## Required App Settings on hobbyiq3

The following App Service settings **must** be set and match the deploy mode. The deploy script aborts at [0/5] if these don't match the zip shape.

| Setting | Required value | Why |
| --- | --- | --- |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `false` | Prevents Oryx from running `npm install` + `tsc` against the zip. Critical: when `true`, Oryx's `compress_node_modules=tar-gz` step can lose `node_modules/` during rsync (root cause of 2026-05-24 5h14m outage). |
| `ENABLE_ORYX_BUILD` | `false` | Companion flag. Toggling only one leaves Oryx in undefined state. |
| `NPM_CONFIG_PRODUCTION` | `false` | Legacy: was relevant when SCM_DO_BUILD was true so devDependencies could install for `tsc`. Harmless in built-artifact mode; left in place. |

### How to verify current state

```powershell
az webapp config appsettings list -g rg-hobbyiq-dev -n HobbyIQ3 `
  --query "[?name=='SCM_DO_BUILD_DURING_DEPLOYMENT' || name=='ENABLE_ORYX_BUILD'].{name:name,value:value}" `
  -o table
```

Expected output:

```text
Name                              Value
--------------------------------  -------
SCM_DO_BUILD_DURING_DEPLOYMENT    false
ENABLE_ORYX_BUILD                 false
```

### How to set/reset them if they drift

```powershell
az webapp config appsettings set -g rg-hobbyiq-dev -n HobbyIQ3 `
  --settings SCM_DO_BUILD_DURING_DEPLOYMENT=false ENABLE_ORYX_BUILD=false
```

This triggers a restart. Run BEFORE the next deploy attempt; the script's [0/5] invariant check will block the deploy otherwise.

## Two valid deploy modes (only built-artifact is in use today)

Per `docs/phase0/deploy_infra_audit.md` §4:

| Mode | App Settings | Zip contents |
| --- | --- | --- |
| **Built-artifact** (current hobbyiq3) | `SCM_DO_BUILD=false`, `ENABLE_ORYX=false` | `dist/`, `node_modules/`, `package*.json` (NO `src/`) |
| Source-deploy (not used) | `SCM_DO_BUILD=true`, `ENABLE_ORYX=true` | `src/`, `tsconfig.json`, `package*.json` (NO `dist/`, NO `node_modules/`) |

Mixing modes — for example, `SCM_DO_BUILD=true` with a zip containing pre-baked `node_modules/` — caused the 2026-05-24 incident. The deploy script's [0/5] check refuses to proceed when the mode and zip shape disagree.

## Deploy procedure

From repo root:

```powershell
cd backend
npm run build                  # produces dist/
cd ..
node zip.js                    # produces deploy.zip with dist/ + node_modules/
.\scripts\deploy-with-build-info.ps1
```

The script:

1. **[0/5]** Verifies App Settings match `EXPECTED_APP_SETTINGS` and zip shape matches the deploy mode. Aborts before any state change on mismatch.
2. **[1/5]** Sets `GIT_SHA`/`GIT_SHA_SHORT`/`GIT_BRANCH`/`DEPLOYED_AT` App Settings (triggers implicit restart, settles 30s).
3. **[2/5]** Enqueues async OneDeploy via `az webapp deploy --type zip`.
4. **[3/5]** Acquires AAD token for Kudu API.
5. **[4/5]** Polls Kudu `/api/deployments/latest` every 15s (max 20 min). On terminal failure surfaces `status_text`, `message`, and `log_url` and exits 1.
6. **[5/5]** Explicit restart + verifies `/api/health` reports the deployed SHA + feature-probes `/api/compiq/normalization-dictionary` (200 + valid body — proves `dist/` and `node_modules/` actually loaded).

Total runtime: ~3-5 min for clean deploy. Up to ~20 min if Kudu is slow.

## What to do when a deploy fails

### [0/5] invariant check fails

The error message lists which invariant failed. Two common cases:

- **App Settings drift:** someone manually changed `SCM_DO_BUILD_DURING_DEPLOYMENT` or `ENABLE_ORYX_BUILD`. Reset them with the `az` command above; rerun the script.
- **Zip shape mismatch:** the zip was built for the wrong mode (e.g., a slim-zip with only `src/` against built-artifact App Settings). Rebuild with the correct `zip.js`.

Production is **not touched** — safe to iterate locally.

### [4/5] Kudu reports failure (status=3)

The script now surfaces `status_text`, `message`, and `log_url`. Open the `log_url` in a browser (it requires AAD auth) for full Oryx + rsync detail. Common failure modes:

- **Oryx + zip-with-node_modules collision** (yesterday's incident). Should be impossible now that [0/5] enforces invariants — but if it surfaces again, the App Settings drifted between [0/5] check and Kudu execution.
- **App Service disk pressure.** Rare. Look at the Azure Portal "Diagnostic and solve problems" view.
- **Container build cache issues.** Try the deploy a second time; sometimes transient.

Production state depends on what Kudu did before failing. Typically:

- If `/api/health` returns 200: production is unchanged (Kudu failed before rsync touched wwwroot).
- If `/api/health` returns 503: container is crash-looping; wwwroot likely partially overwritten. **Recovery:** redeploy a known-good SHA per the rollback procedure below.

### [5/5] feature-probe fails (SHA matches but `/api/compiq/normalization-dictionary` doesn't return 200)

This is the **Finding 11 incident pattern**: `/api/health` reports the new SHA (because `GIT_SHA` env var was set at [1/5]) but the deployed code doesn't actually serve traffic. wwwroot is likely missing `node_modules/` or has a corrupt `dist/`. Production is broken.

Recovery: redeploy a known-good SHA. See rollback procedure below.

## Rollback procedure

When production is broken and the most recent deploy is bad:

1. Identify the last-known-good SHA — typically the prior squash-merge commit on `main`. Cross-check by inspecting `git log --oneline -10` and the Kudu deployment history (`az webapp log deployment list -g rg-hobbyiq-dev -n HobbyIQ3`).
2. `git checkout <good-sha>` (detached HEAD is fine).
3. `cd backend && rm -rf dist && npm run build`
4. `cd .. && rm -f deploy.zip && node zip.js`
5. Verify zip size (~79 MB) and contains both `dist/` and `node_modules/`.
6. Run `.\scripts\deploy-with-build-info.ps1`. The [0/5] check enforces the same invariants for rollback as for forward deploys.
7. Once recovered: `git checkout main` to return to head of main.

If the deploy script itself is suspected of bugs (it's the same script that broke yesterday), the manual fallback is:

```powershell
az webapp deploy -g rg-hobbyiq-dev -n HobbyIQ3 `
  --src-path deploy.zip --type zip --restart true
```

Skips [0/5] invariant check — only use as last resort when the App Settings are known-correct and the script is suspected.

## App Service settings other than build-related

- `APPLICATIONINSIGHTS_CONNECTION_STRING` — telemetry. Required.
- `COSMOS_CONNECTION_STRING` + `COSMOS_ENDPOINT` + `COSMOS_DATABASE` — Cosmos auth. Refreshed per CF-COSMOS-ROT (2026-05-23).
- `CARDSIGHT_API_KEY` + `CARDSIGHT_MODE=exclusive` — Cardsight integration.
- `EBAY_WEBHOOK_VERIFICATION_TOKEN` + `EBAY_WEBHOOK_ENDPOINT` — eBay marketplace-account-deletion webhook.

When in doubt about which settings are required, compare against a known-healthy deploy's settings list and look for differences.

## References

- [docs/phase0/deploy_infra_audit.md](../phase0/deploy_infra_audit.md) — 2026-05-24 incident post-mortem
- [scripts/deploy-with-build-info.ps1](../../scripts/deploy-with-build-info.ps1) — the deploy script
- [zip.js](../../zip.js) — produces deploy.zip with the built-artifact shape

## Anti-drift note

If this runbook drifts from the script's actual behavior, the SCRIPT is the source of truth. Update this doc to match. If the script changes (especially the `EXPECTED_APP_SETTINGS` table or the invariant-check logic), update this doc in the same PR.
