param appName string
param environmentName string
param location string
param resourceSuffix string = ''
param keyVaultName string

var sbNamespace = 'sb-${appName}-${environmentName}${resourceSuffix}'

resource sb 'Microsoft.ServiceBus/namespaces@2022-10-01-preview' = {
  name: sbNamespace
  location: location
  sku: {
    name: 'Basic'
    tier: 'Basic'
  }
  properties: {}
}

resource pricingRefresh 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: '${sb.name}/pricing-refresh'
  properties: {}
}
resource alertGeneration 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: '${sb.name}/alert-generation'
  properties: {}
}
resource dailyIqGeneration 'Microsoft.ServiceBus/namespaces/queues@2022-10-01-preview' = {
  name: '${sb.name}/dailyiq-generation'
  properties: {}
}

output serviceBusNamespace string = sb.name
