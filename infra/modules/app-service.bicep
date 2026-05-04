param appName string
param environmentName string
param location string
param resourceSuffix string = ''
param keyVaultName string
param logAnalyticsWorkspaceId string
param appInsightsInstrumentationKey string
param storageAccountName string
param postgresFqdn string
param redisHostName string
param serviceBusNamespace string

var webAppName = 'app-${appName}-api-${environmentName}${resourceSuffix}'
var planName = 'plan-${appName}-api-${environmentName}${resourceSuffix}'

resource plan 'Microsoft.Web/serverfarms@2022-03-01' = {
  name: planName
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2022-09-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|18-lts'
      appSettings: [
        {
          name: 'NODE_ENV'
          value: 'production'
        }
        {
          name: 'WEBSITES_PORT'
          value: '8080'
        }
          {
            name: 'PORT'
            value: '8080'
          }
          {
            name: 'WEBSITE_RUN_FROM_PACKAGE'
            value: '1'
          }
        {
          name: 'APPINSIGHTS_INSTRUMENTATIONKEY'
          value: appInsightsInstrumentationKey
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: appInsightsInstrumentationKey
        }
        {
          name: 'KEY_VAULT_NAME'
          value: keyVaultName
        }
        {
          name: 'STORAGE_ACCOUNT_NAME'
          value: storageAccountName
        }
        {
          name: 'POSTGRES_FQDN'
          value: postgresFqdn
        }
        {
          name: 'REDIS_HOSTNAME'
          value: redisHostName
        }
        {
          name: 'SERVICE_BUS_NAMESPACE'
          value: serviceBusNamespace
        }
        {
          name: 'CORS_ALLOWED_ORIGINS'
          value: '*'
        }
        {
          name: 'ENABLE_AI_SEARCH'
          value: 'false'
        }
        {
          name: 'ENABLE_NOTIFICATIONS'
          value: 'false'
        }
        {
          name: 'ENABLE_DEBUG_PRICING'
          value: 'false'
        }
        {
          name: 'CACHE_TTL_ESTIMATE_SECONDS'
          value: '900'
        }
        {
          name: 'CACHE_TTL_SEARCH_SECONDS'
          value: '900'
        }
        {
          name: 'CACHE_TTL_PORTFOLIO_SECONDS'
          value: '600'
        }
      ]
      healthCheckPath: '/api/health'
    }
  }
  identity: {
    type: 'SystemAssigned'
  }
  tags: {
    environment: environmentName
    app: appName
  }
}

output webAppName string = webApp.name
output planName string = plan.name
