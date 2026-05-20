# Existing deployment discovery

Date: 2026-05-17

## CI/CD findings

- Configuration found: yes
  - `.github/workflows/deploy-backend.yml`
  - `.github/workflows/main_hobbyiq3.yml`
  - `.github/workflows/azure-appservice-deploy.yml`
  - `.github/workflows/azure-deploy.yml`
  - `.github/workflows/daily-refresh.yml`
- Historical deploy trigger: push to `main` and `workflow_dispatch` on the App Service workflows before they were disabled.
- Current deploy trigger: no active push-to-main backend deploy workflow is checked in now.
  - `dff4db7` explicitly disabled the old App Service and azd workflows on 2026-05-06.
  - `.github/workflows/daily-refresh.yml` is still active on a schedule and manual dispatch, and it deploys `deploy.zip` to `HobbyIQ3`, but it is not the normal PR merge deploy path.
- Historical deploy step:
  - Build backend
  - Create `deploy.zip`
  - Deploy to Azure Web App `HobbyIQ3` with `azure/webapps-deploy@v3`
- Strongest workflow evidence:
  - Commit `301ccc4` changed `deploy-backend.yml` to use `HobbyIQ3` and root build/package flow.
  - Commit `dff4db7` later disabled those legacy workflows.

## Azure resource identification

- Resource group: `rg-hobbyiq-dev`
- App Service name: `HobbyIQ3`
- Subscription: identified
- Region: `Central US`
- State: `Running`
- Verified via az CLI: yes
- Output snippet:

```json
{
  "name": "HobbyIQ3",
  "state": "Running",
  "defaultHostName": "hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net",
  "location": "Central US"
}
```

- Why this is the production target:
  - The hostname matches the live prod URL exercised by the tier1 harness and direct production probes in this session.
  - `az webapp list` in the subscription shows `HobbyIQ3` running in `rg-hobbyiq-dev` and no competing match for the production hostname.

## Azure config findings

- `azure.yaml` exists, but it currently describes an `azd` service hosted as `containerapp`.
- No `.azure/` environment state is checked into the workspace.
- This does not match the verified production target, which is an Azure App Service named `HobbyIQ3`.
- Conclusion: current `azd up` is not the correct production deploy path for Phase 3.

## Script and docs findings

- Root packaging script: `zip.js`
  - Produces `deploy.zip` at the repo root.
- Generic direct deploy script exists: `scripts/deploy-backend-zip.ps1`
  - Uses `az webapp deploy`.
  - Its current default zip name is `backend-deploy.zip`, so it is not an exact match for the historically successful path.
- Historical/manual docs also point to direct App Service ZIP deploy patterns, including older app names.
- Current active workflow `.github/workflows/daily-refresh.yml` still uses the same code-only App Service deploy model:
  - build backend
  - create `deploy.zip`
  - deploy to `HobbyIQ3`

## Session evidence of the successful earlier prod deploy

- The current session transcript contains the exact successful code-only deploy path used earlier after PR #41:
  1. `cd <repo>\backend; npm run build`
  2. `cd <repo>; node zip.js`
  3. `az webapp deploy --resource-group rg-hobbyiq-dev --name HobbyIQ3 --src-path deploy.zip --type zip --restart true --timeout 600`
- The transcript then recorded: `Deploy: RuntimeSuccessful`.
- This is the strongest evidence for the Phase 3 production path because it is same-session, same target, and already succeeded against the verified live app.

## Deploy path for Phase 3

- Recommended option: Option C
- Exact command/steps:
  1. From `backend/`: `npm run build`
  2. From repo root: `node zip.js`
  3. From repo root: `az webapp deploy --resource-group rg-hobbyiq-dev --name HobbyIQ3 --src-path deploy.zip --type zip --restart true`
  4. Verify with:
     - `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/health`
     - targeted CompIQ endpoint probes
- Confidence: high
  - Exact app/resource group verified in Azure
  - Exact deploy command recovered from this same session
  - Historical workflow evidence aligns with the same App Service target and `deploy.zip` artifact shape

## Discrepancies / gotchas

- `azd up` is the wrong command for production here. It tries to provision new infrastructure and is blocked by quota/capacity.
- `azure.yaml` currently points at a Container Apps topology, which does not match the verified production target.
- The old push-to-main deploy workflows for `HobbyIQ3` were disabled on 2026-05-06.
- `.github/workflows/daily-refresh.yml` still deploys to `HobbyIQ3`, but it is a scheduled/manual workflow and should not be assumed to be the normal Phase 3 ship path.
- Older docs and scripts reference obsolete app names such as `hobbyiq-andjgvhgfbhfcuhv`; those are not the verified production target for this session.
- No `.azure/<env>/.env` production state is present in the repo, so `azd deploy` is not currently grounded by checked-in environment state.

## Runbook status

- Created: yes
- Path: `backend/docs/deployment/deploy-runbook.md`

## Next step

- Ready for deploy, fire next prompt.
- Use the direct App Service code-only deploy path to `HobbyIQ3`; do not use `azd up`.
