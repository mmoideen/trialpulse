metadata description = 'RBAC-authorised Key Vault. TrialPulse deliberately keeps exactly one secret here (the SharePoint webhook clientState); every other dependency is reached with a managed identity and no credential at all.'

@description('Name of the Key Vault. Must be globally unique, 3-24 characters.')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region for the vault.')
param location string

@description('Tags applied to the vault.')
param tags object

@description('Enable purge protection. Required for production; leave off in dev so short-lived environments can be torn down and redeployed with the same name.')
param enablePurgeProtection bool = false

@description('Soft-delete retention in days.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 90

@description('Resource id of the Log Analytics workspace that receives vault audit logs.')
param logAnalyticsWorkspaceId string

@description('SharePoint change-notification clientState. Defaults to a fresh GUID on every deployment; pass an explicit value once webhooks are registered, otherwise re-deploying rotates the value and invalidates existing subscriptions. See docs/runbook.md.')
@secure()
param sharepointClientState string = newGuid()

var sharepointClientStateSecretName = 'sharepoint-client-state'

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    // RBAC, not access policies: role assignments are auditable in Azure
    // Activity Log and can be scoped per secret.
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: enablePurgeProtection ? true : null
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource sharepointClientStateSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: sharepointClientStateSecretName
  properties: {
    value: sharepointClientState
    contentType: 'text/plain'
    attributes: {
      enabled: true
    }
  }
}

resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: keyVault
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

@description('Name of the vault.')
output name string = keyVault.name

@description('Resource id of the vault.')
output id string = keyVault.id

@description('Vault URI, e.g. https://kv-tp-dev-abcd1234.vault.azure.net/')
output vaultUri string = keyVault.properties.vaultUri

@description('Versionless Key Vault reference for the SharePoint clientState secret. Versionless so that rotating the secret does not require an app redeploy.')
output sharepointClientStateReference string = '@Microsoft.KeyVault(SecretUri=${keyVault.properties.vaultUri}secrets/${sharepointClientStateSecret.name}/)'
