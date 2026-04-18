// main.bicep - Azure App Service (Linux) for HobbyIQ Node.js backend
// Provisions App Service Plan, Web App, logging, and outputs the Web App URL

param appName string = 'hobbyiq'
param location string = 'Central US'
param resourceGroupName string = 'rg-hobbyiq-dev'
@allowed([
  'B1'
  'F1'
])
param skuName string = 'B1' // Will fallback to F1 (Free) if B1 quota is not available
param nodeVersion string = '20-lts'

resource plan 'Microsoft.Web/serverfarms@2022-09-01' = {
  name: '${appName}-plan'
  location: location
  sku: {
    name: skuName
    tier: skuName == 'F1' ? 'Free' : 'Basic'
    size: skuName
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true // Linux
  }
}

resource webapp 'Microsoft.Web/sites@2022-09-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    siteConfig: {
      linuxFxVersion: 'NODE|${nodeVersion}'
      alwaysOn: skuName != 'F1'
      appSettings: [
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        {
          name: 'PORT'
          value: '8080'
        }
        {
          name: 'WEBSITE_RUN_FROM_PACKAGE'
          value: '1'
        }
      ]
      detailedErrorLoggingEnabled: true
      httpLoggingEnabled: true
      requestTracingEnabled: true
    }
    httpsOnly: true
  }
}

output webAppUrl string = 'https://${webapp.name}.azurewebsites.net/'

// NOTE: If deployment fails due to B1 quota, redeploy with skuName='F1'.
// If app name is taken, use a unique name (e.g., hobbyiq-<random>).
