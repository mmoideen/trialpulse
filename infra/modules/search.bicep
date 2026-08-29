metadata description = 'Azure AI Search service. The trialpulse-chunks index itself is created out of band by the ingestion pipeline from ingestion/schema/search-index.json; index schema is deliberately not duplicated in Bicep because the ingestion pipeline owns its shape.'

@description('Name of the search service. Lowercase letters, digits and hyphens; globally unique.')
@minLength(2)
@maxLength(60)
param name string

@description('Azure region for the search service.')
param location string

@description('Tags applied to the search service.')
param tags object

@description('SKU. PRD section 8.2 calls for standard; basic is offered because it is roughly a third of the price and is sufficient below ~1M chunks with dimension reduction. See docs/cost-model.md.')
@allowed([
  'basic'
  'standard'
  'standard2'
  'standard3'
])
param sku string = 'standard'

@description('Replica count. Azure AI Search only offers a read SLA at 2 or more replicas, and a read-write SLA at 3 or more.')
@minValue(1)
@maxValue(12)
param replicaCount int = 1

@description('Partition count. Vector index size scales with this.')
@allowed([
  1
  2
  3
  4
  6
  12
])
param partitionCount int = 1

@description('Semantic ranker tier. free allows 1000 semantic queries per month; standard is billed per 1000 queries.')
@allowed([
  'disabled'
  'free'
  'standard'
])
param semanticSearch string = 'free'

@description('Public network access for the search data plane.')
@allowed([
  'enabled'
  'disabled'
])
param publicNetworkAccess string = 'enabled'

@description('Resource id of the Log Analytics workspace that receives search logs.')
param logAnalyticsWorkspaceId string

resource searchService 'Microsoft.Search/searchServices@2023-11-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    replicaCount: replicaCount
    partitionCount: partitionCount
    hostingMode: 'default'
    publicNetworkAccess: publicNetworkAccess
    // Admin and query API keys are disabled outright. All data-plane access is
    // Entra ID + RBAC, which is what makes the per-identity least-privilege
    // split (index reader for the orchestrator, index contributor for
    // ingestion) actually enforceable.
    disableLocalAuth: true
    semanticSearch: semanticSearch
    networkRuleSet: {
      ipRules: []
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: searchService
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
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

@description('Name of the search service.')
output name string = searchService.name

@description('Resource id of the search service.')
output id string = searchService.id

@description('Data-plane endpoint of the search service. Azure AI Search does not surface an endpoint property through ARM, so it is composed from the service name.')
output endpoint string = 'https://${searchService.name}.search.windows.net'
