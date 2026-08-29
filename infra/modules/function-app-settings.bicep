metadata description = 'Applies the complete app-settings collection to an existing function app. Split out of function-app.bicep so it can be ordered after the RBAC module: a Key Vault reference in an app setting only resolves once the app identity holds Key Vault Secrets User.'

@description('Name of the function app whose settings are being replaced.')
param functionAppName string

@description('Complete app settings map. This resource is authoritative - any setting not present here is removed from the app.')
param appSettings object

resource site 'Microsoft.Web/sites@2023-12-01' existing = {
  name: functionAppName
}

resource settings 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: site
  name: 'appsettings'
  properties: appSettings
}

@description('Names of the settings applied, for deployment output verification. Values are intentionally not emitted.')
output appliedSettingNames array = [for setting in items(appSettings): setting.key]
