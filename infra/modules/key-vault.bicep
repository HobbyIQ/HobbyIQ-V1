param appName string
param environmentName string
param location string
param resourceSuffix string = ''
param logAnalyticsWorkspaceId string

var keyVaultName = 'kv-${appName}-${environmentName}${resourceSuffix}'

resource kv 'Microsoft.KeyVault/vaults@2022-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    accessPolicies: []
    enabledForDeployment: true
    enabledForTemplateDeployment: true
    enabledForDiskEncryption: true
    enableRbacAuthorization: true
  }
  tags: {
    environment: environmentName
    app: appName
  }
}

output keyVaultName string = kv.name
