param appName string
param environmentName string
param location string
param resourceSuffix string = ''

var aiSearchName = 'search-${appName}-${environmentName}${resourceSuffix}'

resource aiSearch 'Microsoft.Search/searchServices@2023-11-01' = {
  name: aiSearchName
  location: location
  sku: {
    name: 'basic'
  }
  properties: {
    hostingMode: 'default'
    partitionCount: 1
    replicaCount: 1
    publicNetworkAccess: 'Enabled'
  }
}

output aiSearchName string = aiSearch.name
