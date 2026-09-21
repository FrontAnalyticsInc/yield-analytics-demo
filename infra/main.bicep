// Azure resources for the demo: one storage account that receives the Parquet feed
// (optional; the default feed is served by the walden app itself).
//   az group create -n rg-yield-demo -l eastus2
//   az deployment group create -g rg-yield-demo -f infra/main.bicep
// Then set AZURE_STORAGE_CONNECTION_STRING in .env (see docs/powerbi.md).

@description('Globally unique storage account name (3-24 lowercase letters/digits).')
param storageName string = 'styield${uniqueString(resourceGroup().id)}'
param location string = resourceGroup().location

resource sa 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    isHnsEnabled: true // ADLS Gen2, the same layout the production design uses
  }
  tags: { app: 'yield-analytics-demo' }
}

resource blob 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: sa
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blob
  name: 'yield'
}

output storageAccount string = sa.name
output dfsEndpoint string = sa.properties.primaryEndpoints.dfs
