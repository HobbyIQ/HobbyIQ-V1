# CompIQ Deploy Runbook

Production target:

- Resource group: `rg-hobbyiq-dev`
- App Service: `HobbyIQ3`
- Region: `Central US`
- URL: `https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net`

Deploy method: Option C — direct Azure App Service ZIP deploy

Why this is the production path:

- Verified live Azure Web App is `HobbyIQ3` in `rg-hobbyiq-dev`.
- The exact earlier successful deploy in this session used `node zip.js` plus `az webapp deploy` to this target.
- Historical workflow commits for production deploys also targeted `HobbyIQ3` with a `deploy.zip` artifact.

Step-by-step:

1. From `backend/`, build the backend:

```powershell
cd backend
npm run build
```

1. From repo root, package the production ZIP:

```powershell
cd ..
node zip.js
```

1. Deploy the ZIP to the existing production App Service:

```powershell
az webapp deploy --resource-group rg-hobbyiq-dev --name HobbyIQ3 --src-path deploy.zip --type zip --restart true
```

1. Verify the app is healthy:

```powershell
./scripts/smoke-test-azure.ps1 -BaseUrl "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net"
```

1. Run any targeted Phase 3 probes you need after health is green.

Verification:

- Health endpoint:
  - `GET /api/health`
  - Expected: HTTP 200
- CompIQ health endpoint:
  - `GET /api/compiq/health`
  - Expected: HTTP 200
- Targeted pricing/search probes against production URL
- Optional: tier1 harness against prod from `backend/`

```powershell
$env:HOBBYIQ_TIER1='1'
npm run test:harness:tier1
```

Rollback:

- See `phase-c-rollback-plan.md` / `phase-c-rollback-plan_2.md` for rollback criteria and procedure.
- If rollback is needed, revert the Phase 3 PR and redeploy to the same `HobbyIQ3` App Service using this same ZIP deploy path.

Known issues:

- `azd up` will fail here because it tries to provision new infrastructure; it is not the production deploy path for this environment.
- `azure.yaml` currently describes a Container Apps-style topology that does not match the verified live production host.
- The old App Service GitHub workflows for `HobbyIQ3` were disabled on 2026-05-06, so merge-to-main is not currently a trustworthy deploy trigger.
- `.github/workflows/daily-refresh.yml` still deploys to `HobbyIQ3`, but it is a scheduled/manual maintenance workflow, not the primary release path.
- Older scripts/docs mention obsolete app names; use `HobbyIQ3` unless owner confirms a new target.

Notes:

- If you need to inspect App Service configuration before deploy, use read-only commands like:

```powershell
az webapp show --name HobbyIQ3 --resource-group rg-hobbyiq-dev --query "{name:name,state:state,defaultHostName:defaultHostName,location:location}"
```

- If you need logs after deploy:

```powershell
az webapp log tail --name HobbyIQ3 --resource-group rg-hobbyiq-dev
```
