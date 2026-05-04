param appName string
param environmentName string
param location string
param resourceSuffix string = ''

var storageAccountName = toLower('stg${appName}${environmentName}${resourceSuffix}')

resource storage 'Microsoft.Storage/storageAccounts@2022-09-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
  }
}

resource cardImages 'Microsoft.Storage/storageAccounts/blobServices/containers@2022-09-01' = {
  name: '${storage.name}/default/card-images'
  properties: {}
}
resource slabImages 'Microsoft.Storage/storageAccounts/blobServices/containers@2022-09-01' = {
  name: '${storage.name}/default/slab-images'
  properties: {}
}
resource imports 'Microsoft.Storage/storageAccounts/blobServices/containers@2022-09-01' = {
  name: '${storage.name}/default/imports'
  properties: {}
}
resource dailyIqAssets 'Microsoft.Storage/storageAccounts/blobServices/containers@2022-09-01' = {
  name: '${storage.name}/default/dailyiq-assets'
  properties: {}
}

output storageAccountName string = storage.name
