param appName string
param environmentName string
param location string
param resourceSuffix string = ''
param keyVaultName string
param logAnalyticsWorkspaceId string
param storageAccountName string
param serviceBusNamespace string
param postgresFqdn string
param redisHostName string

var functionAppName = 'func-${appName}-jobs-${environmentName}${resourceSuffix}'

resource functionApp 'Microsoft.Web/sites@2022-09-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: resourceId('Microsoft.Web/serverfarms', 'plan-${appName}-jobs-${environmentName}${resourceSuffix}')
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|18-lts'
      appSettings: [
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'
          value: 'true'
        }
        {
          name: 'AzureWebJobsStorage'
          value: storageAccountName
        }
        {
          name: 'DATABASE_URL'
          value: postgresFqdn
        }
        {
          name: 'REDIS_URL'
          value: redisHostName
        }
        {
          name: 'SERVICE_BUS_CONNECTION'
          value: serviceBusNamespace
        }
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: logAnalyticsWorkspaceId
        }
      ]
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
output functionAppName string = functionApp.name
