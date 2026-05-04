param appName string
param environmentName string
param location string
param resourceSuffix string = ''

var nhNamespace = 'nh-${appName}-${environmentName}${resourceSuffix}'
var nhName = 'hub-${appName}-${environmentName}${resourceSuffix}'

resource nhNamespaceRes 'Microsoft.NotificationHubs/namespaces@2023-06-01' = {
  name: nhNamespace
  location: location
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  properties: {}
}

resource nh 'Microsoft.NotificationHubs/namespaces/notificationHubs@2023-06-01' = {
  name: '${nhNamespace}/${nhName}'
  properties: {}
}

output notificationHubName string = nh.name
