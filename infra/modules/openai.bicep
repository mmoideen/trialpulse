metadata description = 'An Azure OpenAI account and its model deployments. Instantiated twice by main.bicep so that the ingestion workload and the conversational workload never share a rate-limit surface (PRD decision 4).'

@description('Name of the Azure OpenAI (Cognitive Services) account. Also used as the custom subdomain, so it must be globally unique.')
@minLength(2)
@maxLength(64)
param name string

@description('Azure region. Model availability differs by region; East US is the default for data residency (PRD decision 5).')
param location string

@description('Tags applied to the account.')
param tags object

@description('Resource id of the Log Analytics workspace that receives account logs.')
param logAnalyticsWorkspaceId string

@description('Public network access for the data plane. Set to Disabled once Private Endpoints are introduced.')
@allowed([
  'Enabled'
  'Disabled'
])
param publicNetworkAccess string = 'Enabled'

@description('Model deployments to create. Each entry: { name, model: { name, version }, sku: { name, capacity } }. Capacity is in thousands of tokens per minute for Standard SKUs.')
param deployments array

resource account 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: name
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    customSubDomainName: name
    publicNetworkAccess: publicNetworkAccess
    // Key-based auth is switched off: both function apps authenticate with a
    // managed identity and the Cognitive Services OpenAI User role. There is
    // therefore no Azure OpenAI key anywhere in the system to leak or rotate.
    disableLocalAuth: true
    networkAcls: {
      defaultAction: 'Allow'
    }
    restrictOutboundNetworkAccess: false
  }
}

// Azure OpenAI rejects concurrent deployment writes against the same account,
// so the loop is serialised.
@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = [
  for deployment in deployments: {
    parent: account
    name: deployment.name
    sku: {
      name: deployment.sku.name
      capacity: deployment.sku.capacity
    }
    properties: {
      model: {
        format: 'OpenAI'
        name: deployment.model.name
        version: deployment.model.version
      }
      versionUpgradeOption: 'OnceCurrentVersionExpired'
      raiPolicyName: 'Microsoft.DefaultV2'
    }
  }
]

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: account
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
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

@description('Name of the Azure OpenAI account.')
output name string = account.name

@description('Resource id of the Azure OpenAI account.')
output id string = account.id

@description('Data-plane endpoint, e.g. https://oai-tp-chat-dev-abcd1234.openai.azure.com/')
output endpoint string = account.properties.endpoint

@description('Names of the model deployments that were created, in the order supplied.')
output deploymentNames array = [for (deployment, i) in deployments: modelDeployments[i].name]
