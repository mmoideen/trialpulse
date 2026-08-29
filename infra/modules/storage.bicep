metadata description = 'Storage account backing the ingestion work queue, its poison queue, the Functions host, the Flex Consumption deployment container, and the cold audit archive with an archive-tier lifecycle policy (PRD sections 8.5 and 9).'

@description('Name of the storage account. Lowercase alphanumeric, 3-24 characters, globally unique.')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region for the storage account.')
param location string

@description('Tags applied to the storage account.')
param tags object

@description('Replication SKU. LRS is sufficient for dev; GRS or ZRS for production audit archives.')
@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
])
param skuName string = 'Standard_LRS'

@description('Allow storage account key access. Kept false: both function apps use identity-based connections for AzureWebJobsStorage and for the queue bindings.')
param allowSharedKeyAccess bool = false

@description('Days after last modification before an audit blob is moved to the Cool tier.')
@minValue(1)
param auditCoolAfterDays int = 30

@description('Days after last modification before an audit blob is moved to the Archive tier. PRD section 8.5 / section 9 specify 90 days.')
@minValue(1)
param auditArchiveAfterDays int = 90

@description('Days after last modification before an archived audit blob is deleted. 2555 days is the 7-year clinical retention requirement.')
@minValue(1)
param auditDeleteAfterDays int = 2555

@description('''
Apply a container-level immutability (WORM, "write once, read many") policy to
the audit-archive container, time-locked for auditDeleteAfterDays. This is the
actual technical control behind the 7-year compliance retention requirement
(PRD section 8.5): RBAC scope alone cannot fully protect this container,
because Flex Consumption's identity-based AzureWebJobsStorage connection
documented-ly requires Storage Blob Data Owner at STORAGE ACCOUNT scope (see
modules/rbac.bicep) -- a container-scoped role assignment is not sufficient
for the Functions host's own dynamically-created containers, so neither
function app's identity can be scoped below account-wide Owner today. An
immutability policy closes that gap independently of RBAC scope: modifying or
removing it is a control-plane operation
(Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies),
which is a DIFFERENT permission from the data-plane Storage Blob Data Owner
role either managed identity holds, so neither identity can touch it even
though both hold Owner on the blob data plane. Deliberately `Unlocked` rather
than `Locked`: a locked policy can only ever be extended, never shortened or
removed, by anyone, including during legitimate environment teardown; unlocked
already fully defeats the threat this exists for (a compromised or merely
over-privileged *workload* identity), since that identity has no control-plane
rights over the policy either way. Requires blob versioning on the account,
which is already enabled unconditionally below.
''')
param enableAuditArchiveImmutability bool = true

@description('Resource id of the Log Analytics workspace that receives storage logs.')
param logAnalyticsWorkspaceId string

var deploymentContainerName = 'function-releases'
var auditArchiveContainerName = 'audit-archive'
var ingestionQueueName = 'ingestion-work'
// The Azure Functions queue trigger writes failed messages to "<queue>-poison"
// by convention. Creating it up front means the dead-letter drain runbook has a
// stable target from day one instead of a queue that appears on first failure.
var ingestionPoisonQueueName = '${ingestionQueueName}-poison'

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  kind: 'StorageV2'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: allowSharedKeyAccess
    allowCrossTenantReplication: false
    defaultToOAuthAuthentication: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: false
      services: {
        blob: {
          enabled: true
          keyType: 'Account'
        }
        queue: {
          enabled: true
          keyType: 'Account'
        }
      }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: 30
    }
    isVersioningEnabled: true
  }
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource auditArchiveContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: auditArchiveContainerName
  properties: {
    publicAccess: 'None'
    metadata: {
      purpose: 'compacted-audit-records'
      retention: 'seven-years'
    }
    // See enableAuditArchiveImmutability's @description for why this, not
    // narrower RBAC, is the real control here. Must be set at container
    // creation time -- immutableStorageWithVersioning cannot be added to an
    // already-existing container after the fact. The actual retention period
    // is a separate child resource (auditArchiveImmutabilityPolicy, below):
    // this property only turns version-level WORM on for the container.
    immutableStorageWithVersioning: {
      enabled: enableAuditArchiveImmutability
    }
  }
}

// The version-level WORM retention period itself. A distinct child resource
// from the container's `immutableStorageWithVersioning` flag above -- Azure's
// container-scoped `immutabilityPolicies` resource name must be exactly
// 'default'. Left `Unlocked` (the default `state` when unspecified): see
// enableAuditArchiveImmutability's @description for why that already defeats
// the threat this exists for without the operational risk of a policy that
// can never be shortened or removed, ever, even for a dev environment teardown.
resource auditArchiveImmutabilityPolicy 'Microsoft.Storage/storageAccounts/blobServices/containers/immutabilityPolicies@2023-05-01' = if (enableAuditArchiveImmutability) {
  parent: auditArchiveContainer
  name: 'default'
  properties: {
    immutabilityPeriodSinceCreationInDays: auditDeleteAfterDays
    allowProtectedAppendWrites: false
  }
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {}
}

resource ingestionQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: ingestionQueueName
  properties: {}
}

resource ingestionPoisonQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: ingestionPoisonQueueName
  properties: {}
}

resource lifecyclePolicy 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'audit-archive-tiering'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                auditArchiveContainerName
              ]
            }
            actions: {
              baseBlob: {
                tierToCool: {
                  daysAfterModificationGreaterThan: auditCoolAfterDays
                }
                tierToArchive: {
                  daysAfterModificationGreaterThan: auditArchiveAfterDays
                }
                delete: {
                  daysAfterModificationGreaterThan: auditDeleteAfterDays
                }
              }
            }
          }
        }
        {
          name: 'purge-old-function-releases'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                deploymentContainerName
              ]
            }
            actions: {
              version: {
                delete: {
                  daysAfterCreationGreaterThan: 30
                }
              }
            }
          }
        }
      ]
    }
  }
  dependsOn: [
    auditArchiveContainer
    deploymentContainer
  ]
}

resource accountDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: storageAccount
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource blobDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: blobService
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

resource queueDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: queueService
  name: 'to-log-analytics'
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        categoryGroup: 'audit'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'Transaction'
        enabled: true
      }
    ]
  }
}

@description('Name of the storage account.')
output name string = storageAccount.name

@description('Resource id of the storage account.')
output id string = storageAccount.id

@description('Primary blob endpoint.')
output blobEndpoint string = storageAccount.properties.primaryEndpoints.blob

@description('Primary queue endpoint.')
output queueEndpoint string = storageAccount.properties.primaryEndpoints.queue

@description('Container used by Flex Consumption for one-deploy packages.')
output deploymentContainerName string = deploymentContainer.name

@description('Container holding compacted audit records.')
output auditArchiveContainerName string = auditArchiveContainer.name

@description('Ingestion work queue name.')
output ingestionQueueName string = ingestionQueue.name

@description('Ingestion dead-letter (poison) queue name.')
output ingestionPoisonQueueName string = ingestionPoisonQueue.name
