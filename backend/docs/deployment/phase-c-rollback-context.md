## Phase C rollback context

Pre-deploy state captured: 2026-05-17T16:00:00Z (UTC)

### GIT_SHA strategy for B4
- Selected strategy: Option A (preferred)
- Reason: PR #43 is merged, so B4 can stamp the exact main HEAD used for deploy
- PR #43 merge SHA: c75aa2586a126c8a05cb9d069d829ab38aa2f0f6
- Current App Service `GIT_SHA`: b0f5a9b11f22d8abdab093e4ccbcd6cdde76de51 (pre-Phase-3)
- Action in B4: update `GIT_SHA` from the old value to the post-merge `git rev-parse HEAD` value before build/deploy
- Insert these commands in B4 after `git pull` and before `npm install`:

```bash
git checkout main
git pull
SHA=$(git rev-parse HEAD)
az webapp config appsettings set \
  --resource-group rg-hobbyiq-dev \
  --name HobbyIQ3 \
  --settings GIT_SHA=$SHA
az webapp config appsettings list \
  --resource-group rg-hobbyiq-dev \
  --name HobbyIQ3 \
  --query "[?name=='GIT_SHA']"
```

PowerShell equivalent:

```powershell
git checkout main
git pull
$SHA = (git rev-parse HEAD).Trim()
az webapp config appsettings set --resource-group rg-hobbyiq-dev --name HobbyIQ3 --settings "GIT_SHA=$SHA"
az webapp config appsettings list --resource-group rg-hobbyiq-dev --name HobbyIQ3 --query "[?name=='GIT_SHA']"
```

### Previous deployment (rollback target)
- Active deployment ID at pre-B4: 8f4a56bb-0e5b-4579-b654-d2d48a22b075
- Active deployment received_time: 2026-05-17T15:35:58.0900079Z
- Previous deployment ID: 3209b54c-1fee-47ab-92c2-0b39cd660d8f
- Previous main SHA (pre-Phase-3 target): d110174
- PR #41 merge SHA reference: b0f5a9b
- Local ZIP artifact path: C:/Users/dvabu/OneDrive - Just the Boys and Cards LLC/Desktop/HobbyIQ-V1/deploy.zip

### Rollback strategy
- Primary: Strategy A (local ZIP redeploy)
- Backup 1: Strategy B (Kudu deployment history + source sync)
- Backup 2: Strategy C (rebuild from pre-Phase-3 SHA d110174 and redeploy)
- Estimated time to rollback:
  - Strategy A: 2-4 minutes
  - Strategy B: 3-6 minutes
  - Strategy C: 6-12 minutes

### Quick rollback commands
Strategy A (primary):

```powershell
Set-Location "C:/Users/dvabu/OneDrive - Just the Boys and Cards LLC/Desktop/HobbyIQ-V1"
az webapp deploy --resource-group rg-hobbyiq-dev --name HobbyIQ3 --src-path "C:/Users/dvabu/OneDrive - Just the Boys and Cards LLC/Desktop/HobbyIQ-V1/deploy.zip" --type zip --restart true
```

Strategy B (backup):

```powershell
az webapp deployment source sync --resource-group rg-hobbyiq-dev --name HobbyIQ3 --slot production
```

Strategy C (rebuild previous main and redeploy):

```powershell
Set-Location "C:/Users/dvabu/OneDrive - Just the Boys and Cards LLC/Desktop/HobbyIQ-V1"
git fetch origin
git checkout d110174
cd backend
npm install
npm run build
cd ..
node zip.js
az webapp deploy --resource-group rg-hobbyiq-dev --name HobbyIQ3 --src-path "C:/Users/dvabu/OneDrive - Just the Boys and Cards LLC/Desktop/HobbyIQ-V1/deploy.zip" --type zip --restart true
```

### Verification after rollback

```powershell
Invoke-WebRequest "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/health" -UseBasicParsing | Select-Object -ExpandProperty StatusCode
Invoke-WebRequest "https://hobbyiq3-e5a4dgfsdnb5fbha.centralus-01.azurewebsites.net/api/compiq/health" -UseBasicParsing | Select-Object -ExpandProperty StatusCode
```
