#!/bin/bash
set -e

# deploy.sh - Robust deployment for HobbyIQ Node.js backend

APP_NAME="hobbyiq"
RESOURCE_GROUP="rg-hobbyiq-dev"
LOCATION="centralus"
BICEP_FILE="main.bicep"
ZIP_FILE="app.zip"
SKU="B1"

log() { echo -e "\033[1;34m[INFO]\033[0m $1"; }
err() { echo -e "\033[1;31m[ERROR]\033[0m $1"; }

# 1. Azure login
az account show > /dev/null 2>&1 || az login

# 2. Set subscription (uncomment and set if needed)
# az account set --subscription <YOUR_SUBSCRIPTION_ID>

# 3. Create resource group
log "Ensuring resource group exists..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION"

# 4. Check B1 quota, fallback to F1 if needed
if ! az appservice list-quotas --location "$LOCATION" | grep -q '"name": "B1"'; then
  log "B1 quota not available, falling back to F1 (Free tier)."
  SKU="F1"
fi

# 5. Handle app name collision
if az webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" &>/dev/null; then
  SUFFIX=$RANDOM
  log "App name $APP_NAME already taken, using $APP_NAME-$SUFFIX"
  APP_NAME="${APP_NAME}-${SUFFIX}"
fi

# 6. Deploy Bicep
log "Deploying infrastructure with SKU $SKU..."
az deployment group create \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$BICEP_FILE" \
  --parameters appName="$APP_NAME" location="$LOCATION" skuName="$SKU"

# 7. Zip backend (exclude node_modules, .git, bicep, script, zip)
log "Zipping backend files..."
zip -r "$ZIP_FILE" . -x "node_modules/*" -x ".git/*" -x "$ZIP_FILE" -x "$BICEP_FILE" -x "deploy.sh"

# 8. Deploy to Web App
log "Deploying zip to Azure Web App..."
if ! az webapp deployment source config-zip \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --src "$ZIP_FILE"; then
  err "Deployment failed! Showing logs:"
  az webapp log tail --resource-group "$RESOURCE_GROUP" --name "$APP_NAME"
  exit 1
fi

# 9. Post-deploy validation
APP_URL=$(az webapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query defaultHostName -o tsv)
log "App deployed at: https://$APP_URL"

log "Testing health endpoint..."
curl -fsSL "https://$APP_URL/api/health" || err "Health check failed!"

log "Deployment complete!"
