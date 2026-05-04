# HobbyIQ Azure Deployment Guide

## Local Development

```
cd backend
npm install
npm run build
npm test
npm start
```

## Local Smoke Test

```
./scripts/smoke-test-azure.ps1 -BaseUrl "http://localhost:8080"
```

## Inspect Deployment ZIP

```
./scripts/deploy-backend-zip.ps1 `
  -ResourceGroup "rg-hobbyiq-dev" `
  -AppName "hobbyiq-andjgvhgfbhfcuhv" `
  -InspectOnly
```

## Deploy ZIP to Azure

```
./scripts/deploy-backend-zip.ps1 `
  -ResourceGroup "rg-hobbyiq-dev" `
  -AppName "hobbyiq-andjgvhgfbhfcuhv"
```

## Restart App Service

```
az webapp restart `
  --name "hobbyiq-andjgvhgfbhfcuhv" `
  --resource-group "rg-hobbyiq-dev"
```

## Azure Smoke Test

```
./scripts/smoke-test-azure.ps1 -BaseUrl "https://hobbyiq-andjgvhgfbhfcuhv.centralus-01.azurewebsites.net"
```

## Logs

```
az webapp log tail `
  --name "hobbyiq-andjgvhgfbhfcuhv" `
  --resource-group "rg-hobbyiq-dev"
```

---

- Health check path: `/api/health`
- App Service start command: `node dist/server.js`
- Required settings: `PORT=8080`, `WEBSITES_PORT=8080`, `NODE_ENV=production`, `WEBSITE_RUN_FROM_PACKAGE=1`, `WEBSITE_WARMUP_PATH=/api/health`, `WEBSITE_WARMUP_STATUSES=200`, `WEBSITES_CONTAINER_START_TIME_LIMIT=600`
