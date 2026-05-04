param appName string
param environmentName string
param location string
param resourceSuffix string = ''
param keyVaultName string

param redisSkuCapacity int = 0

var redisName = 'redis-${appName}-${environmentName}${resourceSuffix}'

resource redis 'Microsoft.Cache/Redis@2023-04-01' = {
  name: redisName
  location: location
  properties: {
    sku: {
      name: 'Basic'
      family: 'C'
      capacity: redisSkuCapacity
    }
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
  }
}

output redisHostName string = redis.properties.hostName
