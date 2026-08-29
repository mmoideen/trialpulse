metadata description = 'Log Analytics workspace and workspace-based Application Insights component. Every other module routes its diagnostic settings here, so this module must deploy first.'

@description('Azure region for the workspace and the Application Insights component.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Name of the Log Analytics workspace.')
param logAnalyticsName string

@description('Name of the Application Insights component.')
param appInsightsName string

@description('Interactive retention, in days, for the Log Analytics workspace. Audit records are retained for 7 years in Cosmos DB and Blob Archive, not here.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 90

@description('Daily ingestion cap in GB. Protects against a log-volume denial-of-wallet. Use -1 for no cap (not recommended).')
param dailyQuotaGb int = 5

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
    DisableIpMasking: false
  }
}

@description('Resource id of the Log Analytics workspace.')
output logAnalyticsWorkspaceId string = logAnalytics.id

@description('Customer id (workspace GUID) used by KQL tooling.')
output logAnalyticsCustomerId string = logAnalytics.properties.customerId

@description('Resource id of the Application Insights component.')
output appInsightsId string = appInsights.id

@description('Application Insights connection string. Not a credential for reading telemetry; it is write-only ingestion metadata.')
output appInsightsConnectionString string = appInsights.properties.ConnectionString
