## Clean Up

* If you see a `dist/server.js` file in the repo, ensure it is not committed unless you intentionally want to deploy built output. Normally, Azure should build from source using the scripts in `backend/package.json`.
* If you see a `hello-azure` folder, it is a sample app and can be deleted if not used.
# HobbyIQ Azure Deployment Guide

## Provider Registration (Required for First-Time Setup or New Subscriptions)

Run these PowerShell commands to check and register all required Azure resource providers:

```powershell
$providers = @(
	"Microsoft.Web",
	"Microsoft.Storage",
	"Microsoft.DBforPostgreSQL",
	"Microsoft.Cache",
	"Microsoft.ServiceBus",
	"Microsoft.KeyVault",
	"Microsoft.Insights",
	"Microsoft.OperationalInsights"
)

foreach ($p in $providers) {
	az provider show --namespace $p --query "{Namespace:namespace, State:registrationState}" --output table
}

foreach ($p in $providers) {
	az provider register --namespace $p
}
```

This guide describes how to deploy the HobbyIQ backend to Azure using Bicep, azd, and GitHub Actions.

## Prerequisites
- Azure CLI (`az`)
- Azure Developer CLI (`azd`)
- Node.js LTS
- GitHub account (for CI/CD)

## Infrastructure Overview
- **App Service (Linux, Node LTS)**: Main API
- **PostgreSQL Flexible Server**: Database
- **Redis Cache**: Caching
- **Blob Storage**: Asset storage
- **Service Bus**: Messaging
- **Key Vault**: Secrets
- **Monitoring**: Log Analytics & Application Insights
- **Azure Functions (Jobs)**: Optional background jobs
- **AI Search, Notification Hubs, API Management**: Optional, disabled by default

## Deployment Steps

### 1. Configure Environment
- Clone the repo
- Copy `.env.example` to `.env` and fill in required values
- Review and adjust `azure.yaml` parameters as needed

### 2. Provision Infrastructure
```sh
azd up
```
- This will deploy all required Azure resources using Bicep modules in `infra/`
- Optional services (AI Search, Notification Hubs, API Management) are disabled by default for cost control

### 3. Deploy Application
- The API and jobs services will be deployed automatically by azd
- Environment variables and secrets are managed via Key Vault and Bicep outputs

### 4. CI/CD Pipeline
- See `.github/workflows/azure-deploy.yml` for automated deployment via GitHub Actions
- Push to `main` branch triggers deployment

### 5. Smoke Test

After deployment, run the smoke test:

**Windows PowerShell:**
```powershell
./scripts/smoke-test-azure.ps1 -BaseUrl "https://<your-app-service-name>.azurewebsites.net"
```

**Linux/macOS (bash):**
```sh
bash scripts/smoke-test-azure.sh
```

This validates the main API endpoint and basic infra health.

## Clean ZIP / Run-From-Package Deployment

To ensure a clean deployment and avoid stale files in Azure App Service, use the ZIP deploy method with WEBSITE_RUN_FROM_PACKAGE=1.

### 1. Ensure App Settings

```powershell
az webapp config appsettings set `
  --resource-group <RESOURCE_GROUP> `
  --name <APP_SERVICE_NAME> `
  --settings WEBSITE_RUN_FROM_PACKAGE=1 PORT=8080 WEBSITES_PORT=8080
```

### 2. Run Clean ZIP Deploy

```powershell
.\scripts\deploy-backend-zip.ps1 `
  -ResourceGroup "<RESOURCE_GROUP>" `
  -AppName "<APP_SERVICE_NAME>"
```

### 3. Smoke Test

```powershell
.\scripts\smoke-test-azure.ps1 -BaseUrl "https://<APP_SERVICE_NAME>.azurewebsites.net"
```

### 4. Log Tail if Smoke Test Fails

```powershell
az webapp log tail `
  --name <APP_SERVICE_NAME> `
  --resource-group <RESOURCE_GROUP>
```

**Notes:**
- This avoids stale wwwroot files by running the app directly from the deployment package.
- The app runs from the mounted ZIP package root (not a nested backend folder).
- Do not include secrets or .env files in the package.
- Do not include node_modules (App Service will install dependencies if needed).
- If you ever need to check for legacy files, use log tail and inspect the logs for unexpected file paths.
- Use azd provision for infrastructure, and this script for app deployment.

## Cost Controls
- All expensive/optional services are disabled by default
- Use parameter overrides to enable them if needed

## Security
- No secrets are committed
- Managed identity and Key Vault are used for secrets
- HTTPS enforced everywhere

## Upgrades
- All infra is modular and parameterized for easy upgrades
- Update Bicep modules and re-run `azd up` to apply changes

---

**Note:**
If you see a `hello-azure` folder, it is a sample app scaffolded by Azure tools and is not used for HobbyIQ deployment. You can safely delete the `hello-azure` folder and any references to it in deployment scripts or configuration files.

---
For troubleshooting and advanced configuration, see the comments in each Bicep module and the azd documentation.
