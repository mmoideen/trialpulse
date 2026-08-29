metadata description = 'Cosmos DB for NoSQL account holding the compliance audit trail, rolled-up daily telemetry, and Teams conversation history. Continuous backup / point-in-time restore is mandatory (PRD section 8.5).'

@description('Name of the Cosmos DB account. Lowercase, globally unique, 3-44 characters.')
@minLength(3)
@maxLength(44)
param name string

@description('Azure region for the account.')
param location string

@description('Tags applied to the account.')
param tags object

@description('Name of the SQL database.')
param databaseName string = 'trialpulse'

@description('Capacity mode. Serverless suits the PRD load (500-5000 queries/day) and costs cents per month; provisioned autoscale is for sustained high write volume.')
@allowed([
  'serverless'
  'provisioned'
])
param capacityMode string = 'serverless'

@description('Maximum autoscale RU/s for the shared database throughput. Ignored when capacityMode is serverless.')
@minValue(1000)
@maxValue(100000)
param maxThroughput int = 1000

@description('Continuous backup retention tier for point-in-time restore.')
@allowed([
  'Continuous7Days'
  'Continuous30Days'
])
param continuousBackupTier string = 'Continuous7Days'

@description('Enable zone redundancy for the write region. Adds cost; not available in every region.')
param zoneRedundant bool = false

@description('Conversation history TTL in seconds. PRD section 6.1 specifies 30 days.')
param conversationTtlSeconds int = 2592000

@description('Resource id of the Log Analytics workspace that receives Cosmos DB logs.')
param logAnalyticsWorkspaceId string

var isServerless = capacityMode == 'serverless'
var databaseOptions = isServerless
  ? {}
  : {
      autoscaleSettings: {
        maxThroughput: maxThroughput
      }
    }

resource account 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: name
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: zoneRedundant
      }
    ]
    capabilities: isServerless
      ? [
          {
            name: 'EnableServerless'
          }
        ]
      : []
    backupPolicy: {
      type: 'Continuous'
      continuousModeProperties: {
        tier: continuousBackupTier
      }
    }
    // No account keys. The orchestrator reads and writes with its managed
    // identity through a Cosmos DB data-plane role assignment; there is no
    // connection string to steal from an app setting.
    disableLocalAuth: true
    disableKeyBasedMetadataWriteAccess: true
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
    networkAclBypass: 'AzureServices'
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: account
  name: databaseName
  properties: {
    resource: {
      id: databaseName
    }
    options: databaseOptions
  }
}

// audit_logs: append-only compliance record, partitioned by UTC date so that a
// compliance query for "everything on 2026-08-28" is a single-partition read.
// Deliberately has NO TTL: automatic expiry would let a failed archive job
// silently destroy records that must survive for 7 years. Deletion happens only
// after the archive job has confirmed the Parquet write to Blob Archive.
// TTL is left switched off entirely (rather than set to -1) so that a stray
// per-item ttl field cannot expire a compliance record.
resource auditLogs 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'audit_logs'
  properties: {
    resource: {
      id: 'audit_logs'
      partitionKey: {
        paths: [
          '/partition_date'
        ]
        kind: 'Hash'
        version: 2
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/*'
          }
        ]
        // Large free-text and nested arrays are excluded from the index: they
        // are never filtered on, and indexing them roughly triples write RU.
        excludedPaths: [
          {
            path: '/response_text/?'
          }
          {
            path: '/query_text/?'
          }
          {
            path: '/retrieved_chunks/*'
          }
          {
            path: '/_etag/?'
          }
        ]
        compositeIndexes: [
          [
            {
              path: '/entra_role'
              order: 'ascending'
            }
            {
              path: '/timestamp'
              order: 'descending'
            }
          ]
        ]
      }
    }
    options: {}
  }
}

resource dailySummaries 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'daily_summaries'
  properties: {
    resource: {
      id: 'daily_summaries'
      partitionKey: {
        paths: [
          '/date'
        ]
        kind: 'Hash'
        version: 2
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/*'
          }
        ]
        excludedPaths: [
          {
            path: '/_etag/?'
          }
        ]
      }
    }
    options: {}
  }
}

// conversations: Teams chat history. TTL is correct here - this is convenience
// state, not a compliance record, and the audit trail already holds the
// authoritative copy of every question and answer.
resource conversations 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'conversations'
  properties: {
    resource: {
      id: 'conversations'
      partitionKey: {
        paths: [
          '/conversation_id'
        ]
        kind: 'Hash'
        version: 2
      }
      defaultTtl: conversationTtlSeconds
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/*'
          }
        ]
        excludedPaths: [
          {
            path: '/answer/?'
          }
          {
            path: '/citations/*'
          }
          {
            path: '/_etag/?'
          }
        ]
        compositeIndexes: [
          [
            {
              path: '/conversation_id'
              order: 'ascending'
            }
            {
              path: '/timestamp'
              order: 'descending'
            }
          ]
        ]
      }
    }
    options: {}
  }
}

// documents: per-document ingestion status, backing the Browse tab's
// DocumentStatusBadge (PRD 6.1) and version-compare's document lookup.
// Partitioned by /document_classification so a role-filtered Browse query hits
// one partition per allowed classification instead of a cross-partition scan -
// which is the shape packages/orchestrator/src/providers/azure/azure-document-metadata.ts
// queries with.
//
// NOTE: nothing writes to this container today. The orchestrator reads it; the
// Python ingestion pipeline has no Cosmos client and no Cosmos role assignment.
// The container is created anyway so the Browse tab returns an empty list
// rather than a 404 from the Cosmos SDK. See docs/production-readiness-checklist.md.
resource documents 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'documents'
  properties: {
    resource: {
      id: 'documents'
      partitionKey: {
        paths: [
          '/document_classification'
        ]
        kind: 'Hash'
        version: 2
      }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [
          {
            path: '/*'
          }
        ]
        excludedPaths: [
          {
            path: '/_etag/?'
          }
        ]
        compositeIndexes: [
          [
            {
              path: '/document_classification'
              order: 'ascending'
            }
            {
              path: '/document_title'
              order: 'ascending'
            }
          ]
        ]
      }
    }
    options: {}
  }
}

// cache_entries: the orchestrator's CacheProvider (query embedding cache, PRD
// section 9; cost-downgrade flag, PRD 3.3.3). See
// packages/orchestrator/src/providers/azure/azure-cache.ts - the implementation
// deliberately uses Cosmos per-item TTL rather than the provisioned Redis cache,
// so this container is required for the app to start doing useful caching.
//
// defaultTtl: -1 means "TTL is enabled, but nothing expires unless the item
// carries its own ttl field". That is exactly right here and exactly wrong for
// audit_logs, which is why the two containers differ.
resource cacheEntries 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'cache_entries'
  properties: {
    resource: {
      id: 'cache_entries'
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
        version: 2
      }
      defaultTtl: -1
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        // Cache entries are only ever fetched by id, which is served by the
        // system index. Indexing the cached value would mean indexing a
        // 3072-element float array on every write.
        includedPaths: []
        excludedPaths: [
          {
            path: '/*'
          }
        ]
      }
    }
    options: {}
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: account
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'DataPlaneRequests'
        enabled: true
      }
      {
        category: 'ControlPlaneRequests'
        enabled: true
      }
      {
        category: 'QueryRuntimeStatistics'
        enabled: true
      }
      {
        category: 'PartitionKeyStatistics'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Requests'
        enabled: true
      }
    ]
  }
}

@description('Name of the Cosmos DB account.')
output name string = account.name

@description('Resource id of the Cosmos DB account.')
output id string = account.id

@description('Document endpoint, e.g. https://cosmos-trialpulse-dev-abcd1234.documents.azure.com:443/')
output endpoint string = account.properties.documentEndpoint

@description('Name of the SQL database.')
output databaseName string = database.name

@description('Container names, in the order the application expects them.')
output containerNames object = {
  auditLogs: auditLogs.name
  dailySummaries: dailySummaries.name
  conversations: conversations.name
  cacheEntries: cacheEntries.name
  documents: documents.name
}

@description('Container the ingestion pipeline writes per-document status into (Browse tab and version comparison read it).')
output documentsContainerName string = documents.name
