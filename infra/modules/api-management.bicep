param appName string
param environmentName string
param location string
param resourceSuffix string = ''

var apiMgmtName = 'apim-${appName}-${environmentName}${resourceSuffix}'

resource apim 'Microsoft.ApiManagement/service@2022-08-01' = {
  name: apiMgmtName
  location: location
  sku: {
    name: 'Consumption'
    capacity: 0
  }
  properties: {
    publisherEmail: 'admin@hobbyiq.com'
    publisherName: 'HobbyIQ'
  }
}

output apiManagementName string = apim.name
