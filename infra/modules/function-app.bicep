metadata description = 'A Flex Consumption Function App with a system-assigned managed identity, plus its dedicated plan. App settings are NOT set here: they are applied by function-app-settings.bicep after the RBAC module has run, so that Key Vault references resolve on the first deployment instead of failing until a restart.'

@description('Name of the function app.')
@minLength(2)
@maxLength(60)
param name string

@description('Name of the Flex Consumption plan. Flex Consumption hosts exactly one function app per plan, so each app gets its own.')
param planName string

@description('Azure region for the plan and the app.')
param location string

@description('Tags applied to the plan and the app.')
param tags object

@description('Language worker. node for the TypeScript orchestrator, python for the ingestion pipeline.')
@allowed([
  'node'
  'python'
])
param runtimeName string

@description('Language worker version, e.g. 20 for Node or 3.11 for Python.')
param runtimeVersion string

@description('Name of the storage account used for the Functions host and the deployment package.')
param storageAccountName string

@description('Blob container that Flex Consumption reads the deployment package from.')
param deploymentContainerName string

@description('Maximum instance count the app may scale out to. This is the primary denial-of-wallet guardrail on the compute tier.')
@minValue(40)
@maxValue(1000)
param maximumInstanceCount int = 40

@description('Memory per instance in MB.')
@allowed([
  512
  2048
  4096
])
param instanceMemoryMB int = 2048

@description('Always-ready instances. 0 accepts cold starts (fine for dev and for the ingestion pipeline); 1 keeps the P99 query latency target reachable in production, at a fixed monthly cost - see docs/cost-model.md.')
@minValue(0)
@maxValue(20)
param alwaysReadyInstanceCount int = 0

@description('Origins allowed to call the app from a browser. The Teams tab is served from a different origin, so this must include the tab host and https://teams.microsoft.com.')
param corsAllowedOrigins array = []

@description('Resource id of the Log Analytics workspace that receives function app logs.')
param logAnalyticsWorkspaceId string

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: name
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    publicNetworkAccess: 'Enabled'
    clientAffinityEnabled: false
    siteConfig: {
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      cors: {
        allowedOrigins: corsAllowedOrigins
        supportCredentials: false
      }
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storageAccount.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            // The app pulls its own deployment package using its managed
            // identity. No storage key, no SAS token.
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: instanceMemoryMB
        alwaysReady: alwaysReadyInstanceCount > 0
          ? [
              {
                name: 'http'
                instanceCount: alwaysReadyInstanceCount
              }
            ]
          : []
      }
      runtime: {
        name: runtimeName
        version: runtimeVersion
      }
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: site
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'FunctionAppLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('Name of the function app.')
output name string = site.name

@description('Resource id of the function app.')
output id string = site.id

@description('Default hostname of the function app.')
output defaultHostName string = site.properties.defaultHostName

@description('Object id of the system-assigned managed identity. This is the principal every role assignment is issued to.')
output principalId string = site.identity.principalId
