metadata description = '''
Every data-plane role assignment in TrialPulse, in one auditable place.

Design rule: each managed identity receives the narrowest built-in role that
still lets it do its job, scoped to a single resource. There is no assignment at
subscription scope, and no Owner or Contributor anywhere. The differences below
are deliberate, not accidental:

  orchestrator -> Search Index Data READER      (it queries; it never writes)
  ingestion    -> Search Index Data CONTRIBUTOR (it writes chunks)
  ingestion    -> Search Service Contributor    (it creates/updates the index
                                                 definition out of band)
  orchestrator -> Cosmos DB Data Contributor    (audit + conversations)
  ingestion    -> Cosmos DB Data Contributor    (per-document ingestion status
                                                 ONLY, scoped to the single
                                                 `documents` container -- never
                                                 the account, so the pipeline
                                                 can never reach the audit log)
  orchestrator -> Storage Queue Data Message SENDER    (enqueue reindex jobs)
  ingestion    -> Storage Queue Data Contributor       (queue trigger must peek,
                                                        update and delete, and
                                                        create the poison queue)
  orchestrator -> Cognitive Services OpenAI User on the CONVERSATIONAL account only
  ingestion    -> Cognitive Services OpenAI User on the EMBEDDING account only
'''

@description('Object id of the orchestrator function app managed identity.')
param orchestratorPrincipalId string

@description('Object id of the ingestion function app managed identity.')
param ingestionPrincipalId string

@description('Name of the Azure AI Search service.')
param searchServiceName string

@description('Name of the Cosmos DB account.')
param cosmosAccountName string

@description('Cosmos SQL database name, used to scope the ingestion role assignment to a single container.')
param cosmosDatabaseName string

@description('Container the ingestion pipeline writes document status into. The ingestion role assignment is scoped to exactly this container.')
param cosmosDocumentsContainerName string

@description('Name of the storage account.')
param storageAccountName string

@description('Name of the Key Vault.')
param keyVaultName string

@description('Name of the Azure OpenAI account serving conversational traffic.')
param conversationalOpenAiName string

@description('Name of the Azure OpenAI account serving ingestion embeddings.')
param embeddingOpenAiName string

// Built-in role definition GUIDs. These are stable, tenant-independent Azure
// identifiers, not secrets.
var roleIds = {
  searchIndexDataReader: '1407120a-92aa-4202-b7e9-c0e197c71c8f'
  searchIndexDataContributor: '8ebe5a00-799e-43f5-93ac-243d3dce84a7'
  searchServiceContributor: '7ca78c08-252a-4471-8644-bb5ff32d4ba0'
  cognitiveServicesOpenAiUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  storageBlobDataOwner: 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
  storageQueueDataContributor: '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
  storageQueueDataMessageSender: 'c6a89b2d-59bc-44d0-9896-0f6e12d7b80a'
}

// Cosmos DB data-plane roles live in the account, not in Azure RBAC.
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'

resource searchService 'Microsoft.Search/searchServices@2023-11-01' existing = {
  name: searchServiceName
}

resource cosmosAccount 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = {
  name: cosmosAccountName
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource conversationalOpenAi 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: conversationalOpenAiName
}

resource embeddingOpenAi 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: embeddingOpenAiName
}

// ---------------------------------------------------------------------------
// Azure AI Search
// ---------------------------------------------------------------------------

resource orchestratorSearchReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: searchService
  name: guid(searchService.id, orchestratorPrincipalId, roleIds.searchIndexDataReader)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.searchIndexDataReader
    )
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Orchestrator queries the trialpulse-chunks index. Read only: a compromised orchestrator cannot rewrite the corpus it is answering from.'
  }
}

resource ingestionSearchContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: searchService
  name: guid(searchService.id, ingestionPrincipalId, roleIds.searchIndexDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.searchIndexDataContributor
    )
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Ingestion pipeline upserts and tombstones chunks.'
  }
}

resource ingestionSearchServiceContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: searchService
  name: guid(searchService.id, ingestionPrincipalId, roleIds.searchServiceContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.searchServiceContributor
    )
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Ingestion pipeline creates and migrates the index definition from ingestion/schema/search-index.json. Scoped to this search service only; it grants no data-plane read of index contents.'
  }
}

// ---------------------------------------------------------------------------
// Azure OpenAI - the two accounts are the isolation boundary
// ---------------------------------------------------------------------------

resource orchestratorOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: conversationalOpenAi
  name: guid(conversationalOpenAi.id, orchestratorPrincipalId, roleIds.cognitiveServicesOpenAiUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.cognitiveServicesOpenAiUser
    )
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Orchestrator calls gpt-4o, gpt-4o-mini and the query-sized embedding deployment. It has no access to the ingestion account.'
  }
}

resource ingestionOpenAiUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: embeddingOpenAi
  name: guid(embeddingOpenAi.id, ingestionPrincipalId, roleIds.cognitiveServicesOpenAiUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.cognitiveServicesOpenAiUser
    )
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Ingestion pipeline calls the high-throughput embedding deployment. It cannot reach a generation model at all, so a compromised ingestion job cannot be turned into a text generator.'
  }
}

// ---------------------------------------------------------------------------
// Cosmos DB (data-plane RBAC, not Azure RBAC)
// ---------------------------------------------------------------------------

resource orchestratorCosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, orchestratorPrincipalId, cosmosDataContributorRoleId)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: orchestratorPrincipalId
    scope: cosmosAccount.id
  }
}

// The ingestion pipeline writes per-document status (indexed / failed, chunk
// count, last ingested at) so the Browse tab and version comparison have
// something to read. It has no reason to see audit logs or conversations, so
// this assignment is scoped to the single `documents` container rather than to
// the account -- a compromised ingestion identity cannot read or tamper with
// the compliance audit trail.
resource ingestionCosmosDocumentsContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmosAccount
  name: guid(cosmosAccount.id, ingestionPrincipalId, cosmosDataContributorRoleId, cosmosDocumentsContainerName)
  properties: {
    roleDefinitionId: '${cosmosAccount.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    principalId: ingestionPrincipalId
    scope: '${cosmosAccount.id}/dbs/${cosmosDatabaseName}/colls/${cosmosDocumentsContainerName}'
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

// Storage Blob Data Owner at account scope is the documented minimum for an
// identity-based AzureWebJobsStorage connection on Flex Consumption: the
// Functions host creates and manages its own azure-webjobs-hosts container for
// singleton locks, so a container-scoped assignment is not sufficient. This is
// a platform requirement for BOTH function apps, independent of anything
// either app's own code does.
//
// NOTE, corrected from an earlier version of this comment: nothing in
// packages/orchestrator/src/ writes to the audit-archive container today --
// there is no compaction/archive job (see AUDIT_ARCHIVE_CONTAINER in
// infra/main.bicep and docs/production-readiness-checklist.md). This grant is
// therefore *not* scoped down to exclude that container, because it cannot
// be: the account-scope requirement above already covers it, and Azure RBAC
// has no way to carve a single container back out of an account-scope
// assignment. What actually protects the audit-archive container from this
// (or any) identity in the meantime is
// modules/storage.bicep's `enableAuditArchiveImmutability` --
// a control-plane-only immutability policy that this identity's data-plane
// Storage Blob Data Owner role cannot touch. When the archive job described
// in docs/runbook.md is implemented, re-read this comment: it will finally be
// describing something real.
resource orchestratorBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, orchestratorPrincipalId, roleIds.storageBlobDataOwner)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.storageBlobDataOwner
    )
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Functions host storage and the Flex Consumption deployment package. NOT because the orchestrator writes to the audit-archive container -- nothing does today; see the comment above this resource.'
  }
}

resource ingestionBlobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, ingestionPrincipalId, roleIds.storageBlobDataOwner)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.storageBlobDataOwner
    )
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Functions host storage and Flex Consumption deployment package.'
  }
}

resource orchestratorQueueSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, orchestratorPrincipalId, roleIds.storageQueueDataMessageSender)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.storageQueueDataMessageSender
    )
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
    description: 'POST /api/admin/reindex and the SharePoint webhook handler enqueue work. Sender only: the orchestrator cannot read, peek or delete other messages in the ingestion queue.'
  }
}

resource ingestionQueueContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageAccount
  name: guid(storageAccount.id, ingestionPrincipalId, roleIds.storageQueueDataContributor)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.storageQueueDataContributor
    )
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Queue-triggered ingestion must dequeue, extend visibility, delete on success and write to the poison queue on final failure.'
  }
}

// ---------------------------------------------------------------------------
// Key Vault
// ---------------------------------------------------------------------------

resource orchestratorKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, orchestratorPrincipalId, roleIds.keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.keyVaultSecretsUser
    )
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Resolves the sharepoint-client-state Key Vault reference. Read only, no list-and-dump of vault metadata beyond secret read.'
  }
}

resource ingestionKeyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVault
  name: guid(keyVault.id, ingestionPrincipalId, roleIds.keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roleIds.keyVaultSecretsUser
    )
    principalId: ingestionPrincipalId
    principalType: 'ServicePrincipal'
    description: 'Resolves Key Vault references used by the SharePoint connector.'
  }
}

@description('Names of the Azure RBAC role assignments created, for post-deployment verification.')
output roleAssignmentNames array = [
  orchestratorSearchReader.name
  ingestionSearchContributor.name
  ingestionSearchServiceContributor.name
  orchestratorOpenAiUser.name
  ingestionOpenAiUser.name
  orchestratorBlobOwner.name
  ingestionBlobOwner.name
  orchestratorQueueSender.name
  ingestionQueueContributor.name
  orchestratorKeyVaultSecretsUser.name
  ingestionKeyVaultSecretsUser.name
]

@description('Name of the Cosmos DB data-plane role assignment created.')
output cosmosRoleAssignmentName string = orchestratorCosmosDataContributor.name
