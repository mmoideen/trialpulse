metadata description = '''
TrialPulse infrastructure - top-level template.

SCOPE: subscription. main.bicep creates (or updates) the resource group and then
deploys every module into it. Subscription scope was chosen over resource-group
scope so that dev and prod are provisioned by exactly the same command with only
a parameters file differing - the resource group name, tags and location are all
part of the template rather than something an operator types into `az group
create` and gets subtly wrong. Every role assignment is still scoped to an
individual resource; nothing is granted at subscription scope.

DEPLOY:
  az deployment sub create \
    --name trialpulse-dev-$(date +%Y%m%d%H%M) \
    --location eastus \
    --template-file infra/main.bicep \
    --parameters infra/main.parameters.dev.json

NOT CREATED HERE (deliberately, see infra/README.md):
  - the Entra ID app registration and its app roles (identity, not infrastructure)
  - the trialpulse-chunks search index (owned by ingestion/schema/search-index.json)
  - SharePoint webhook subscriptions (registered by the ingestion pipeline)
'''

targetScope = 'subscription'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

@description('Environment name. Drives resource naming, tagging and the safety posture of several defaults.')
@allowed([
  'dev'
  'prod'
])
param environmentName string

@description('Azure region for every resource. East US by default for data residency (PRD decision 5 - matches Meridian\'s Boston presence).')
param location string = 'eastus'

@description('Name of the resource group that holds the whole environment.')
param resourceGroupName string = 'rg-trialpulse-${environmentName}'

@description('Owner tag. A team or distribution list, never an individual.')
param ownerTag string = 'clinical-platform@example.com'

@description('Cost centre tag used for chargeback reporting.')
param costCenterTag string = 'CC-CLINOPS-001'

@description('Data classification tag. TrialPulse handles confidential clinical operations documents, not patient-level data (PRD section 8.5).')
@allowed([
  'confidential'
  'restricted'
])
param dataClassificationTag string = 'confidential'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

@description('Entra ID tenant id that issues user tokens. Placeholder GUID by default; a real value must be supplied per environment.')
param entraTenantId string = '00000000-0000-0000-0000-000000000000'

@description('Expected audience (aud) claim of inbound tokens. This MUST be the exact Application ID URI of the TrialPulse Entra app registration (as configured under that app\'s "Expose an API" blade), e.g. api://trialpulse-tab.azurewebsites.net/11111111-1111-1111-1111-111111111111 -- NOT an arbitrary string like api://trialpulse-dev. A Teams SSO token\'s aud claim is always the app registration\'s Application ID URI, so anything else can never validate. This value, teams/manifest/manifest.json webApplicationInfo.resource, and the app registration\'s Application ID URI are ONE value in THREE places; see infra/README.md "Entra identity: one value, three places". The orchestrator rejects any token whose audience does not match exactly.')
param entraApiAudience string = 'api://REPLACE_WITH_TAB_DOMAIN/REPLACE_WITH_AAD_APP_CLIENT_ID'

@description('Application (client) id of the TrialPulse Entra app registration.')
param entraClientId string = '00000000-0000-0000-0000-000000000000'

// ---------------------------------------------------------------------------
// SharePoint
// ---------------------------------------------------------------------------

@description('Microsoft Graph site id of the SharePoint site holding the clinical document libraries. Read by ingestion/trialpulse_ingest/sharepoint.py as SHAREPOINT_SITE_ID.')
param sharePointSiteId string = 'REPLACE_ME'

@description('Microsoft Graph drive id of the document library the ingestion pipeline monitors. Read by ingestion/trialpulse_ingest/sharepoint.py as SHAREPOINT_DRIVE_ID.')
param sharePointDriveId string = 'REPLACE_ME'

@description('SharePoint change-notification clientState. Stored as the single Key Vault secret in the system. Regenerated on every deployment unless supplied explicitly.')
@secure()
param sharePointClientState string = newGuid()

// ---------------------------------------------------------------------------
// Azure OpenAI
// ---------------------------------------------------------------------------

@description('Model name for the embedding deployments.')
param embeddingModelName string = 'text-embedding-3-large'

@description('Model version for the embedding deployments.')
param embeddingModelVersion string = '1'

@description('Capacity, in thousands of tokens per minute, for the INGESTION embedding deployment. Sized for corpus backfill.')
@minValue(1)
param embeddingIngestionCapacity int = 120

@description('Capacity, in thousands of tokens per minute, for the QUERY embedding deployment on the conversational account. Query embeddings are ~20 tokens each, so this stays small on purpose.')
@minValue(1)
param embeddingQueryCapacity int = 20

@description('Model version for gpt-4o.')
param gpt4oModelVersion string = '2024-11-20'

@description('Capacity, in thousands of tokens per minute, for the gpt-4o deployment.')
@minValue(1)
param gpt4oCapacity int = 30

@description('Model version for gpt-4o-mini.')
param gpt4oMiniModelVersion string = '2024-07-18'

@description('Capacity, in thousands of tokens per minute, for the gpt-4o-mini deployment. Most traffic routes here (PRD section 9 cost control).')
@minValue(1)
param gpt4oMiniCapacity int = 60

// ---------------------------------------------------------------------------
// Azure AI Search
// ---------------------------------------------------------------------------

@description('Search service SKU.')
@allowed([
  'basic'
  'standard'
  'standard2'
  'standard3'
])
param searchSku string = 'standard'

@description('Search replica count. 2 or more is required for the query SLA that PRD section 8.3 depends on.')
@minValue(1)
@maxValue(12)
param searchReplicaCount int = 1

@description('Search partition count.')
@allowed([
  1
  2
  3
  4
  6
  12
])
param searchPartitionCount int = 1

@description('Semantic ranker tier.')
@allowed([
  'disabled'
  'free'
  'standard'
])
param searchSemanticTier string = 'free'

@description('Name of the search index created out of band by the ingestion pipeline.')
param searchIndexName string = 'trialpulse-chunks'

@description('Azure AI Search data-plane REST API version used by the orchestrator.')
param searchApiVersion string = '2024-07-01'

@description('Azure OpenAI REST API version used by the orchestrator.')
param openAiApiVersion string = '2024-10-21'

// ---------------------------------------------------------------------------
// Cosmos DB
// ---------------------------------------------------------------------------

@description('Cosmos DB capacity mode.')
@allowed([
  'serverless'
  'provisioned'
])
param cosmosCapacityMode string = 'serverless'

@description('Maximum autoscale RU/s when capacity mode is provisioned.')
@minValue(1000)
param cosmosMaxThroughput int = 1000

@description('Continuous backup retention tier for point-in-time restore (PRD section 8.5).')
@allowed([
  'Continuous7Days'
  'Continuous30Days'
])
param cosmosBackupTier string = 'Continuous7Days'

// ---------------------------------------------------------------------------
// Storage, cache, compute
// ---------------------------------------------------------------------------

@description('Storage replication SKU.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
])
param storageSkuName string = 'Standard_LRS'

@description('Maximum instance count for each function app. The primary denial-of-wallet guardrail on compute.')
@minValue(40)
param functionMaximumInstanceCount int = 40

@description('Always-ready instances for the orchestrator. 1 in production keeps cold starts out of the P99; 0 in dev.')
@minValue(0)
param orchestratorAlwaysReadyInstances int = 0

@description('Origins permitted to call the orchestrator from a browser. Must include the Teams tab host.')
param corsAllowedOrigins array = [
  'https://teams.microsoft.com'
  'https://local.teams.office.com'
]

@description('Enable Key Vault purge protection. Required in production; blocks name reuse for 90 days after deletion, which is why dev leaves it off.')
param keyVaultPurgeProtection bool = false

// ---------------------------------------------------------------------------
// Observability and cost
// ---------------------------------------------------------------------------

@description('Log Analytics interactive retention in days.')
@minValue(30)
@maxValue(730)
param logRetentionInDays int = 90

@description('Log Analytics daily ingestion cap in GB.')
param logDailyQuotaGb int = 5

@description('E-mail addresses that receive every Azure Monitor alert and budget notification.')
param alertEmailAddresses array = []

@description('Rolling 24-hour model spend, in USD, that triggers the cost alert.')
param dailyModelCostThresholdUsd int = 20

@description('Monthly Azure budget in USD for this resource group.')
param monthlyBudgetUsd int = 300

@description('Hard daily model-spend cap in USD enforced in-process by the orchestrator (PRD section 3.3.3). Distinct from the alert threshold: this one changes behaviour, downgrading generation to gpt-4o-mini.')
param orchestratorDailyCostCapUsd int = 500

@description('Log level for the orchestrator.')
@allowed([
  'debug'
  'info'
  'warn'
  'error'
])
param orchestratorLogLevel string = 'info'

@description('Create the Azure Consumption budget. Disable in subscriptions where the deploying principal lacks budget permissions.')
param enableBudget bool = true

// ---------------------------------------------------------------------------
// Naming and tags
// ---------------------------------------------------------------------------

// Deterministic: the same subscription + environment + region always produces
// the same names, so a redeploy is an update rather than a second estate.
var resourceToken = substring(uniqueString(subscription().id, environmentName, location), 0, 8)

var names = {
  logAnalytics: 'log-trialpulse-${environmentName}-${resourceToken}'
  appInsights: 'appi-trialpulse-${environmentName}-${resourceToken}'
  keyVault: 'kv-tp-${environmentName}-${resourceToken}'
  search: 'srch-trialpulse-${environmentName}-${resourceToken}'
  cosmos: 'cosmos-trialpulse-${environmentName}-${resourceToken}'
  storage: 'sttp${environmentName}${resourceToken}'
  openAiConversational: 'oai-tp-chat-${environmentName}-${resourceToken}'
  openAiEmbedding: 'oai-tp-embed-${environmentName}-${resourceToken}'
  orchestratorApp: 'func-tp-orch-${environmentName}-${resourceToken}'
  orchestratorPlan: 'plan-tp-orch-${environmentName}-${resourceToken}'
  ingestionApp: 'func-tp-ingest-${environmentName}-${resourceToken}'
  ingestionPlan: 'plan-tp-ingest-${environmentName}-${resourceToken}'
  actionGroup: 'ag-trialpulse-${environmentName}'
}

var tags = {
  app: 'trialpulse'
  env: environmentName
  owner: ownerTag
  costCenter: costCenterTag
  dataClassification: dataClassificationTag
}

var deploymentNames = {
  embedding: 'text-embedding-3-large'
  queryEmbedding: 'text-embedding-3-large-query'
  chat: 'gpt-4o'
  chatMini: 'gpt-4o-mini'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Layer 1 - observability (everything else writes diagnostics here)
// ---------------------------------------------------------------------------

module monitoring 'modules/monitoring.bicep' = {
  scope: resourceGroup
  name: 'monitoring'
  params: {
    location: location
    tags: tags
    logAnalyticsName: names.logAnalytics
    appInsightsName: names.appInsights
    retentionInDays: logRetentionInDays
    dailyQuotaGb: logDailyQuotaGb
  }
}

// ---------------------------------------------------------------------------
// Layer 2 - stateful services
// ---------------------------------------------------------------------------

module keyVault 'modules/keyvault.bicep' = {
  scope: resourceGroup
  name: 'key-vault'
  params: {
    name: names.keyVault
    location: location
    tags: tags
    enablePurgeProtection: keyVaultPurgeProtection
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    sharepointClientState: sharePointClientState
  }
}

module storage 'modules/storage.bicep' = {
  scope: resourceGroup
  name: 'storage'
  params: {
    name: names.storage
    location: location
    tags: tags
    skuName: storageSkuName
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module search 'modules/search.bicep' = {
  scope: resourceGroup
  name: 'search'
  params: {
    name: names.search
    location: location
    tags: tags
    sku: searchSku
    replicaCount: searchReplicaCount
    partitionCount: searchPartitionCount
    semanticSearch: searchSemanticTier
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module cosmos 'modules/cosmos.bicep' = {
  scope: resourceGroup
  name: 'cosmos'
  params: {
    name: names.cosmos
    location: location
    tags: tags
    capacityMode: cosmosCapacityMode
    maxThroughput: cosmosMaxThroughput
    continuousBackupTier: cosmosBackupTier
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

// PRD decision 4: ingestion must not be able to starve user queries. Two
// accounts rather than two deployments in one account, because that also makes
// the isolation enforceable with RBAC - the ingestion identity has no role on
// the conversational account and literally cannot call a generation model.
module openAiConversational 'modules/openai.bicep' = {
  scope: resourceGroup
  name: 'openai-conversational'
  params: {
    name: names.openAiConversational
    location: location
    tags: tags
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    deployments: [
      {
        name: deploymentNames.chat
        model: {
          name: 'gpt-4o'
          version: gpt4oModelVersion
        }
        sku: {
          name: 'GlobalStandard'
          capacity: gpt4oCapacity
        }
      }
      {
        name: deploymentNames.chatMini
        model: {
          name: 'gpt-4o-mini'
          version: gpt4oMiniModelVersion
        }
        sku: {
          name: 'GlobalStandard'
          capacity: gpt4oMiniCapacity
        }
      }
      {
        name: deploymentNames.queryEmbedding
        model: {
          name: embeddingModelName
          version: embeddingModelVersion
        }
        sku: {
          name: 'Standard'
          capacity: embeddingQueryCapacity
        }
      }
    ]
  }
}

module openAiEmbedding 'modules/openai.bicep' = {
  scope: resourceGroup
  name: 'openai-embedding'
  params: {
    name: names.openAiEmbedding
    location: location
    tags: tags
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    deployments: [
      {
        name: deploymentNames.embedding
        model: {
          name: embeddingModelName
          version: embeddingModelVersion
        }
        sku: {
          name: 'Standard'
          capacity: embeddingIngestionCapacity
        }
      }
    ]
  }
}

// ---------------------------------------------------------------------------
// Layer 3 - compute (identities are created here and consumed by layer 4)
// ---------------------------------------------------------------------------

module orchestratorApp 'modules/function-app.bicep' = {
  scope: resourceGroup
  name: 'orchestrator-app'
  params: {
    name: names.orchestratorApp
    planName: names.orchestratorPlan
    location: location
    tags: tags
    runtimeName: 'node'
    runtimeVersion: '20'
    storageAccountName: storage.outputs.name
    deploymentContainerName: storage.outputs.deploymentContainerName
    maximumInstanceCount: functionMaximumInstanceCount
    instanceMemoryMB: 2048
    alwaysReadyInstanceCount: orchestratorAlwaysReadyInstances
    corsAllowedOrigins: corsAllowedOrigins
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}

module ingestionApp 'modules/function-app.bicep' = {
  scope: resourceGroup
  name: 'ingestion-app'
  params: {
    name: names.ingestionApp
    planName: names.ingestionPlan
    location: location
    tags: tags
    runtimeName: 'python'
    runtimeVersion: '3.11'
    storageAccountName: storage.outputs.name
    deploymentContainerName: storage.outputs.deploymentContainerName
    maximumInstanceCount: functionMaximumInstanceCount
    instanceMemoryMB: 2048
    // Ingestion is a background pipeline. A cold start costs nobody a page.
    alwaysReadyInstanceCount: 0
    corsAllowedOrigins: []
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
  }
}


// ---------------------------------------------------------------------------
// Layer 4 - authorisation, then app settings
// ---------------------------------------------------------------------------

module rbac 'modules/rbac.bicep' = {
  scope: resourceGroup
  name: 'rbac'
  params: {
    orchestratorPrincipalId: orchestratorApp.outputs.principalId
    ingestionPrincipalId: ingestionApp.outputs.principalId
    searchServiceName: search.outputs.name
    cosmosAccountName: cosmos.outputs.name
    cosmosDatabaseName: cosmos.outputs.databaseName
    cosmosDocumentsContainerName: cosmos.outputs.documentsContainerName
    storageAccountName: storage.outputs.name
    keyVaultName: keyVault.outputs.name
    conversationalOpenAiName: openAiConversational.outputs.name
    embeddingOpenAiName: openAiEmbedding.outputs.name
  }
}

// Settings shared by both apps. Note what is absent: AZURE_OPENAI_API_KEY,
// AZURE_SEARCH_API_KEY and COSMOS_KEY are all optional in the application
// config and are deliberately never set, because local auth is disabled on all
// three services. Both apps authenticate with DefaultAzureCredential.
var commonSettings = {
  APPLICATIONINSIGHTS_CONNECTION_STRING: monitoring.outputs.appInsightsConnectionString
  AzureWebJobsStorage__accountName: storage.outputs.name
  AZURE_SEARCH_ENDPOINT: search.outputs.endpoint
  AZURE_SEARCH_INDEX_NAME: searchIndexName
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: deploymentNames.embedding
  SHAREPOINT_WEBHOOK_CLIENT_STATE: keyVault.outputs.sharepointClientStateReference
  TRIALPULSE_ENV: environmentName
}

module orchestratorSettings 'modules/function-app-settings.bicep' = {
  scope: resourceGroup
  name: 'orchestrator-settings'
  params: {
    functionAppName: orchestratorApp.outputs.name
    appSettings: union(commonSettings, {
      // The orchestrator's embedding deployment is the query-sized one on the
      // conversational account, NOT the ingestion deployment in commonSettings.
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: deploymentNames.queryEmbedding
      AZURE_OPENAI_ENDPOINT: openAiConversational.outputs.endpoint
      AZURE_OPENAI_API_VERSION: openAiApiVersion
      AZURE_OPENAI_GENERATION_DEPLOYMENT: deploymentNames.chat
      AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI: deploymentNames.chatMini
      AZURE_SEARCH_API_VERSION: searchApiVersion
      COSMOS_ENDPOINT: cosmos.outputs.endpoint
      COSMOS_DATABASE_NAME: cosmos.outputs.databaseName
      // Cosmos container names are compile-time constants in the orchestrator's
      // Azure providers, not app settings, so they are deliberately not
      // surfaced here: a setting the app never reads is a setting someone will
      // eventually change and then spend an afternoon wondering why nothing
      // happened. cosmos.outputs.containerNames is the authoritative list.
      AZURE_STORAGE_QUEUE_ACCOUNT_URL: storage.outputs.queueEndpoint
      ENTRA_TENANT_ID: entraTenantId
      ENTRA_AUDIENCE: entraApiAudience
      // environment().authentication.loginEndpoint rather than a literal, so the
      // template still resolves correctly in a sovereign cloud.
      ENTRA_ISSUER: '${environment().authentication.loginEndpoint}${entraTenantId}/v2.0'
      ENTRA_CLIENT_ID: entraClientId
      KEY_VAULT_URI: keyVault.outputs.vaultUri
      STORAGE_ACCOUNT_NAME: storage.outputs.name
      TRIALPULSE_INGEST_QUEUE: storage.outputs.ingestionQueueName
      AUDIT_ARCHIVE_CONTAINER: storage.outputs.auditArchiveContainerName
      TRIALPULSE_DAILY_COST_CAP_USD: string(orchestratorDailyCostCapUsd)
      TRIALPULSE_LOG_LEVEL: orchestratorLogLevel
      // Belt and braces. packages/orchestrator/src/providers/index.ts already
      // defaults to 'azure' when it detects an Azure Functions host
      // (WEBSITE_INSTANCE_ID / FUNCTIONS_WORKER_RUNTIME_VERSION) and only
      // falls back to 'memory' off-Azure, so this setting is redundant on a
      // correctly-configured deploy. It is set explicitly anyway: the failure
      // mode of silently getting this wrong is a deployed app that answers
      // every query from an empty in-memory index and writes the 7-year
      // compliance audit trail to a process-local Map that dies with the
      // instance, while /api/health still reports "ok". A code default
      // should never be the only thing standing between a deploy and that.
      TRIALPULSE_PROVIDER_MODE: 'azure'
      // TRIALPULSE_AUTH_MODE is intentionally not set. It defaults to
      // "production", and config.ts refuses to start in development auth mode
      // when it detects an Azure host.
    })
  }
  dependsOn: [
    // Key Vault references only resolve once the app identity holds
    // Key Vault Secrets User.
    rbac
  ]
}

module ingestionSettings 'modules/function-app-settings.bicep' = {
  scope: resourceGroup
  name: 'ingestion-settings'
  params: {
    functionAppName: ingestionApp.outputs.name
    appSettings: union(commonSettings, {
      AZURE_OPENAI_EMBEDDING_ENDPOINT: openAiEmbedding.outputs.endpoint
      // The pipeline writes per-document ingestion status into the `documents`
      // container so the Browse tab and version comparison have something to
      // read. Its Cosmos role assignment is scoped to that container alone.
      COSMOS_ENDPOINT: cosmos.outputs.endpoint
      COSMOS_DATABASE_NAME: cosmos.outputs.databaseName
      SHAREPOINT_SITE_ID: sharePointSiteId
      SHAREPOINT_DRIVE_ID: sharePointDriveId
      TRIALPULSE_INGEST_QUEUE: storage.outputs.ingestionQueueName
      TRIALPULSE_DEAD_LETTER_QUEUE: storage.outputs.ingestionPoisonQueueName
      KEY_VAULT_URI: keyVault.outputs.vaultUri
      STORAGE_ACCOUNT_NAME: storage.outputs.name
      // The queue trigger and output binding work over the identity-based
      // AzureWebJobsStorage__accountName connection above. The timer-driven
      // delta sync in ingestion/function_app.py currently builds its own
      // QueueClient from a connection string, which cannot work against a
      // storage account with allowSharedKeyAccess: false. This setting gives
      // that code path the account URL it needs once it switches to
      // QueueClient(account_url=..., credential=DefaultAzureCredential()).
      // See infra/README.md.
      AZURE_STORAGE_QUEUE_ACCOUNT_URL: storage.outputs.queueEndpoint
      // TRIALPULSE_LOCAL_DEV is intentionally not set: the ingestion pipeline
      // treats its presence as a switch to in-memory providers.
    })
  }
  dependsOn: [
    rbac
  ]
}

// ---------------------------------------------------------------------------
// Layer 5 - alerting
// ---------------------------------------------------------------------------

module alerts 'modules/alerts.bicep' = {
  scope: resourceGroup
  name: 'alerts'
  params: {
    location: location
    tags: tags
    actionGroupName: names.actionGroup
    alertEmailAddresses: alertEmailAddresses
    appInsightsId: monitoring.outputs.appInsightsId
    dailyModelCostThresholdUsd: dailyModelCostThresholdUsd
    monthlyBudgetUsd: monthlyBudgetUsd
    enableBudget: enableBudget
  }
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

@description('Resource group everything was deployed into.')
output resourceGroupName string = resourceGroup.name

@description('Deterministic suffix used in every resource name.')
output resourceToken string = resourceToken

@description('Orchestrator function app name, for `func azure functionapp publish`.')
output orchestratorFunctionAppName string = orchestratorApp.outputs.name

@description('Orchestrator base URL.')
output orchestratorBaseUrl string = 'https://${orchestratorApp.outputs.defaultHostName}'

@description('Ingestion function app name.')
output ingestionFunctionAppName string = ingestionApp.outputs.name

@description('Object id of the orchestrator managed identity.')
output orchestratorPrincipalId string = orchestratorApp.outputs.principalId

@description('Object id of the ingestion managed identity.')
output ingestionPrincipalId string = ingestionApp.outputs.principalId

@description('Azure AI Search endpoint. Create the index against this with ingestion/schema/search-index.json.')
output searchEndpoint string = search.outputs.endpoint

@description('Name of the search index the ingestion pipeline must create.')
output searchIndexName string = searchIndexName

@description('Cosmos DB document endpoint.')
output cosmosEndpoint string = cosmos.outputs.endpoint

@description('Conversational Azure OpenAI endpoint.')
output conversationalOpenAiEndpoint string = openAiConversational.outputs.endpoint

@description('Ingestion Azure OpenAI endpoint.')
output embeddingOpenAiEndpoint string = openAiEmbedding.outputs.endpoint

@description('Key Vault URI.')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Storage account name backing the ingestion queues and the audit archive.')
output storageAccountName string = storage.outputs.name


@description('Log Analytics workspace id, for KQL in docs/runbook.md.')
output logAnalyticsWorkspaceId string = monitoring.outputs.logAnalyticsWorkspaceId
