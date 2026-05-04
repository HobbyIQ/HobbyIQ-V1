param appName string
param environmentName string
param location string
param resourceSuffix string = ''
param keyVaultName string

var pgServerName = 'pg-${appName}-${environmentName}${resourceSuffix}'
var pgDbName = 'hobbyiq'

resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2022-12-01' = {
  name: pgServerName
  location: location
  sku: {
    name: 'B_Standard_B1ms'
    tier: 'Burstable'
    capacity: 1
  }
  properties: {
    version: '14'
    administratorLogin: 'hobbyiqadmin'
    administratorLoginPassword: listSecret(resourceId('Microsoft.KeyVault/vaults/secrets', keyVaultName, 'pgAdminPassword'), '2023-07-01').value
    storage: {
      storageSizeGB: 32
    }
    highAvailability: {
      mode: 'Disabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

resource db 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2022-12-01' = {
  name: '${pgServerName}/${pgDbName}'
  properties: {}
  dependsOn: [pg]
}

output postgresFqdn string = pg.properties.fullyQualifiedDomainName
output postgresDbName string = db.name
