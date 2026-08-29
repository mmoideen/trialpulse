/**
 * Typed, validated application configuration.
 *
 * Every field is loaded from `process.env`. Per PRD section 8.1, secrets are
 * "managed via Azure Key Vault; no secrets in code or environment variables
 * except Key Vault references." In practice that means one of two things for
 * every credential-shaped field below:
 *
 *   1. We never read it at all, and instead authenticate with
 *      `DefaultAzureCredential` (managed identity) -- the preferred path,
 *      used by every Azure provider in `src/providers/azure/` unless an
 *      explicit key is configured.
 *   2. We read it from an env var, but that env var is populated by the
 *      Azure Functions "Key Vault reference" app setting mechanism
 *      (`@Microsoft.KeyVault(SecretUri=...)`), which the platform resolves
 *      to the real secret value at cold start. The app setting *value* is
 *      never a literal secret checked into source control or `local.settings.json`
 *      in a deployed environment -- only local development uses literal
 *      values, from a developer's own untracked `.env`.
 *
 * Every place below that reads a secret-shaped env var carries a comment
 * reiterating which of the two patterns applies. `loadConfig()` never
 * hardcodes a secret and never silently defaults one.
 */
import type { LogLevel } from './providers/types';

export type AuthMode = 'production' | 'development';

export interface AzureOpenAIConfig {
  endpoint: string;
  apiVersion: string;
  /** PRD decision 4: embeddings run on their own deployment, isolated from generation load. */
  embeddingDeployment: string;
  /** gpt-4o deployment, used for high-reasoning / executive / long queries. */
  generationDeploymentFull: string;
  /** gpt-4o-mini deployment, used for short/low-stakes queries and cost-cap downgrades. */
  generationDeploymentMini: string;
  /**
   * Optional API key fallback. Populated via a Key Vault reference app
   * setting (see module doc). When unset, providers authenticate with
   * `DefaultAzureCredential` instead -- no secret required at all.
   */
  apiKey?: string;
}

export interface SearchConfig {
  endpoint: string;
  indexName: string;
  apiVersion: string;
  /** Optional API key fallback; see `AzureOpenAIConfig.apiKey` doc. */
  apiKey?: string;
}

export interface CosmosConfig {
  endpoint: string;
  databaseName: string;
  /** Optional primary-key fallback; see `AzureOpenAIConfig.apiKey` doc. */
  key?: string;
}

export interface EntraConfig {
  tenantId: string;
  /** Expected `aud` claim: the app registration's Application ID URI or client id. */
  audience: string;
  /** Expected `iss` claim, e.g. `https://login.microsoftonline.com/<tenantId>/v2.0`. */
  issuer: string;
}

export interface SharePointWebhookConfig {
  /**
   * Shared secret used to validate the `clientState` on inbound SharePoint
   * change notifications. Populated via a Key Vault reference app setting;
   * see module doc. Never logged, never echoed back to the caller.
   */
  clientState: string;
  /**
   * D12/F5: the Microsoft Graph site/drive id the ingestion pipeline
   * ingests from. Not set for the orchestrator app in `infra/` today (only
   * the ingestion app's settings carry these) -- optional here rather than
   * required so this doesn't block orchestrator startup. Used only by
   * `functions/admin-reindex.ts`'s best-effort ingestion job payload; see
   * that module's doc comment for the real limitation this papers over
   * (the orchestrator cannot resolve or validate a real Graph drive-item
   * id, unlike `ingestion/trialpulse_ingest/sharepoint.py`).
   */
  siteId?: string;
  driveId?: string;
}

export interface CacheConfig {
}

export interface StorageConfig {
  /** Azure Storage account queue endpoint, e.g. `https://trialpulse.queue.core.windows.net`. Auth is managed identity. */
  queueAccountUrl: string;
}

export interface TelemetryConfig {
  /**
   * D12: `APPLICATIONINSIGHTS_CONNECTION_STRING`, already set by
   * `infra/main.bicep`'s `commonSettings` for this app. Optional here (not
   * `readRequired`) so local dev/tests, which never set it, keep working
   * with the no-op telemetry sink -- see `functions/deps.ts`.
   */
  connectionString?: string;
}

export interface TrialPulseConfig {
  authMode: AuthMode;
  azureOpenAI: AzureOpenAIConfig;
  search: SearchConfig;
  cosmos: CosmosConfig;
  entra: EntraConfig;
  /** Used by Azure providers to resolve Key Vault references directly (rare; usually app settings do this for us). */
  keyVaultUri: string;
  sharePoint: SharePointWebhookConfig;
  cache: CacheConfig;
  storage: StorageConfig;
  /** PRD 3.3.3: hard cost cap in USD/day; overridable for non-production tuning. */
  dailyCostCapUsd: number;
  logLevel: LogLevel;
  /**
   * D12/F5: `TRIALPULSE_INGEST_QUEUE`, already set to the same provisioned
   * queue name (`ingestion-work`) for both this app and the ingestion app
   * by `infra/main.bicep`. See `ingestion/README.md`'s "Ingestion queue
   * contract" -- this is the only queue name any producer in this app may
   * enqueue onto.
   */
  ingestQueueName: string;
  telemetry: TelemetryConfig;
  botFramework: BotFrameworkConfig;
}

export interface BotFrameworkConfig {
  /**
   * D12: the Bot Framework channel registration's Microsoft App ID
   * (`${{BOT_APP_ID}}` in `teams/manifest/manifest.json`) -- the expected
   * `aud` claim on inbound Bot Framework Connector Service JWTs. Not
   * currently provisioned by `infra/`. Optional: `functions/messages.ts`
   * fails closed (rejects every request) when it is unset, rather than
   * skipping audience validation.
   */
  appId?: string;
}

class ConfigError extends Error {
  constructor(missing: string[], invalid: string[]) {
    const lines: string[] = [];
    if (missing.length > 0) {
      lines.push(`Missing required environment variables:\n  - ${missing.join('\n  - ')}`);
    }
    if (invalid.length > 0) {
      lines.push(`Invalid environment variable values:\n  - ${invalid.join('\n  - ')}`);
    }
    super(`TrialPulse orchestrator configuration is invalid.\n${lines.join('\n')}`);
    this.name = 'ConfigError';
  }
}

/** A reliable signal that the process is actually running inside Azure Functions/App Service. */
function isRunningInAzure(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['WEBSITE_INSTANCE_ID'] || env['FUNCTIONS_WORKER_RUNTIME_VERSION']);
}

function readRequired(env: NodeJS.ProcessEnv, key: string, missing: string[]): string {
  const value = env[key];
  if (!value || value.trim().length === 0) {
    missing.push(key);
    return '';
  }
  return value;
}

function readOptional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return value && value.trim().length > 0 ? value : undefined;
}

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  invalid: string[],
): number {
  const raw = readOptional(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    invalid.push(`${key}="${raw}" must be a positive number`);
    return fallback;
  }
  return parsed;
}

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

function readLogLevel(env: NodeJS.ProcessEnv, invalid: string[]): LogLevel {
  const raw = readOptional(env, 'TRIALPULSE_LOG_LEVEL');
  if (raw === undefined) return 'info';
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  invalid.push(`TRIALPULSE_LOG_LEVEL="${raw}" must be one of ${LOG_LEVELS.join(', ')}`);
  return 'info';
}

function readAuthMode(env: NodeJS.ProcessEnv, invalid: string[]): AuthMode {
  const raw = readOptional(env, 'TRIALPULSE_AUTH_MODE');
  if (raw === undefined) return 'production';
  if (raw === 'production' || raw === 'development') return raw;
  invalid.push(`TRIALPULSE_AUTH_MODE="${raw}" must be "production" or "development"`);
  return 'production';
}

/**
 * Load and validate configuration from `process.env`.
 *
 * Throws a single aggregated `ConfigError` listing every problem at once --
 * this is far kinder to a deploy pipeline than failing on the first missing
 * variable, forcing a fix-one-redeploy-repeat loop.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TrialPulseConfig {
  const missing: string[] = [];
  const invalid: string[] = [];

  const azureOpenAI: AzureOpenAIConfig = {
    endpoint: readRequired(env, 'AZURE_OPENAI_ENDPOINT', missing),
    apiVersion: readOptional(env, 'AZURE_OPENAI_API_VERSION') ?? '2024-10-21',
    embeddingDeployment: readRequired(env, 'AZURE_OPENAI_EMBEDDING_DEPLOYMENT', missing),
    generationDeploymentFull: readRequired(env, 'AZURE_OPENAI_GENERATION_DEPLOYMENT', missing),
    generationDeploymentMini: readRequired(env, 'AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI', missing),
    // Key Vault reference app setting, or absent entirely when using managed identity. See module doc.
    apiKey: readOptional(env, 'AZURE_OPENAI_API_KEY'),
  };

  const search: SearchConfig = {
    endpoint: readRequired(env, 'AZURE_SEARCH_ENDPOINT', missing),
    indexName: readRequired(env, 'AZURE_SEARCH_INDEX_NAME', missing),
    apiVersion: readOptional(env, 'AZURE_SEARCH_API_VERSION') ?? '2024-07-01',
    // Key Vault reference app setting, or absent entirely when using managed identity. See module doc.
    apiKey: readOptional(env, 'AZURE_SEARCH_API_KEY'),
  };

  const cosmos: CosmosConfig = {
    endpoint: readRequired(env, 'COSMOS_ENDPOINT', missing),
    databaseName: readRequired(env, 'COSMOS_DATABASE_NAME', missing),
    // Key Vault reference app setting, or absent entirely when using managed identity. See module doc.
    key: readOptional(env, 'COSMOS_KEY'),
  };

  const entra: EntraConfig = {
    tenantId: readRequired(env, 'ENTRA_TENANT_ID', missing),
    audience: readRequired(env, 'ENTRA_AUDIENCE', missing),
    issuer: readRequired(env, 'ENTRA_ISSUER', missing),
  };

  const keyVaultUri = readRequired(env, 'KEY_VAULT_URI', missing);

  const sharePoint: SharePointWebhookConfig = {
    // Key Vault reference app setting: the SharePoint webhook shared secret is
    // never a literal value in a deployed app setting, only in local dev.
    clientState: readRequired(env, 'SHAREPOINT_WEBHOOK_CLIENT_STATE', missing),
    // Not a Key Vault reference, not currently set for this app by
    // `infra/` -- see the interface doc above.
    siteId: readOptional(env, 'SHAREPOINT_SITE_ID'),
    driveId: readOptional(env, 'SHAREPOINT_DRIVE_ID'),
  };

  const cache: CacheConfig = {
    // Key Vault reference app setting, or absent entirely (falls back to the in-memory cache provider).
  };

  const storage: StorageConfig = {
    queueAccountUrl: readRequired(env, 'AZURE_STORAGE_QUEUE_ACCOUNT_URL', missing),
  };

  const ingestQueueName = readRequired(env, 'TRIALPULSE_INGEST_QUEUE', missing);

  const telemetry: TelemetryConfig = {
    connectionString: readOptional(env, 'APPLICATIONINSIGHTS_CONNECTION_STRING'),
  };

  const botFramework: BotFrameworkConfig = {
    appId: readOptional(env, 'BOT_FRAMEWORK_APP_ID'),
  };

  const dailyCostCapUsd = readNumber(env, 'TRIALPULSE_DAILY_COST_CAP_USD', 500, invalid);
  const logLevel = readLogLevel(env, invalid);
  const authMode = readAuthMode(env, invalid);

  // Hard structural guard, independent of anything a caller does at request
  // time: development auth mode (which accepts an unsigned x-dev-identity
  // header -- see src/auth/jwt.ts) must be physically impossible to enable
  // on a real Azure Functions host. WEBSITE_INSTANCE_ID (or the Functions
  // worker runtime version var) is set by the Azure hosting platform itself
  // and cannot be forged by an app setting typo, unlike TRIALPULSE_AUTH_MODE.
  if (authMode === 'development' && isRunningInAzure(env)) {
    invalid.push(
      'TRIALPULSE_AUTH_MODE="development" is not allowed when running inside Azure ' +
        '(detected WEBSITE_INSTANCE_ID / FUNCTIONS_WORKER_RUNTIME_VERSION). ' +
        'Development auth mode accepts an unsigned identity header and must only ' +
        'ever run on a developer workstation or in CI.',
    );
  }

  if (missing.length > 0 || invalid.length > 0) {
    throw new ConfigError(missing, invalid);
  }

  if (authMode === 'development') {
    // A deliberately unmissable banner: anyone tailing logs (or staring at a
    // terminal) while this is active should immediately know that request
    // authentication is not actually happening.
    // eslint-disable-next-line no-console -- intentional, see comment above.
    console.warn(
      '\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n' +
        '!! TRIALPULSE_AUTH_MODE=development -- JWT validation is BYPASSED for any  !!\n' +
        '!! request carrying an "x-dev-identity" header. This must NEVER be set in  !!\n' +
        '!! a deployed environment. See src/auth/jwt.ts.                            !!\n' +
        '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n',
    );
  }

  return {
    authMode,
    azureOpenAI,
    search,
    cosmos,
    entra,
    keyVaultUri,
    sharePoint,
    cache,
    storage,
    dailyCostCapUsd,
    logLevel,
    ingestQueueName,
    telemetry,
    botFramework,
  };
}
