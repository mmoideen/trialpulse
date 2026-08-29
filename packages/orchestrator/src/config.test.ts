import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from './config';

/** A minimal, fully valid environment for the happy-path tests. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    AZURE_OPENAI_ENDPOINT: 'https://trialpulse-aoai.openai.azure.com/',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'text-embedding-3-large',
    AZURE_OPENAI_GENERATION_DEPLOYMENT: 'gpt-4o',
    AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI: 'gpt-4o-mini',
    AZURE_SEARCH_ENDPOINT: 'https://trialpulse-search.search.windows.net',
    AZURE_SEARCH_INDEX_NAME: 'trialpulse-chunks',
    COSMOS_ENDPOINT: 'https://trialpulse-cosmos.documents.azure.com:443/',
    COSMOS_DATABASE_NAME: 'trialpulse',
    ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
    ENTRA_AUDIENCE: 'api://trialpulse',
    ENTRA_ISSUER: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
    KEY_VAULT_URI: 'https://trialpulse-kv.vault.azure.net/',
    SHAREPOINT_WEBHOOK_CLIENT_STATE: 'super-secret-client-state',
    AZURE_STORAGE_QUEUE_ACCOUNT_URL: 'https://trialpulse.queue.core.windows.net',
    TRIALPULSE_INGEST_QUEUE: 'ingestion-work',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('loads a complete, valid environment', () => {
    const config = loadConfig(validEnv());
    expect(config.authMode).toBe('production');
    expect(config.azureOpenAI.embeddingDeployment).toBe('text-embedding-3-large');
    expect(config.azureOpenAI.generationDeploymentFull).toBe('gpt-4o');
    expect(config.azureOpenAI.generationDeploymentMini).toBe('gpt-4o-mini');
    expect(config.dailyCostCapUsd).toBe(500);
    expect(config.logLevel).toBe('info');
    expect(config.azureOpenAI.apiKey).toBeUndefined();
  });

  it('applies overridable defaults', () => {
    const config = loadConfig(
      validEnv({
        TRIALPULSE_DAILY_COST_CAP_USD: '250',
        TRIALPULSE_LOG_LEVEL: 'debug',
        AZURE_OPENAI_API_VERSION: '2025-01-01-preview',
      }),
    );
    expect(config.dailyCostCapUsd).toBe(250);
    expect(config.logLevel).toBe('debug');
    expect(config.azureOpenAI.apiVersion).toBe('2025-01-01-preview');
  });

  it('aggregates every missing required variable into a single error', () => {
    let thrown: unknown;
    try {
      loadConfig({});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    for (const key of [
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
      'AZURE_OPENAI_GENERATION_DEPLOYMENT',
      'AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI',
      'AZURE_SEARCH_ENDPOINT',
      'AZURE_SEARCH_INDEX_NAME',
      'COSMOS_ENDPOINT',
      'COSMOS_DATABASE_NAME',
      'ENTRA_TENANT_ID',
      'ENTRA_AUDIENCE',
      'ENTRA_ISSUER',
      'KEY_VAULT_URI',
      'SHAREPOINT_WEBHOOK_CLIENT_STATE',
      'AZURE_STORAGE_QUEUE_ACCOUNT_URL',
      'TRIALPULSE_INGEST_QUEUE',
    ]) {
      expect(message).toContain(key);
    }
  });

  it('rejects an invalid TRIALPULSE_AUTH_MODE value', () => {
    expect(() => loadConfig(validEnv({ TRIALPULSE_AUTH_MODE: 'yolo' }))).toThrow(/TRIALPULSE_AUTH_MODE/);
  });

  it('reads the ingestion queue name and leaves SharePoint site/drive id undefined when unset (D12/F5)', () => {
    const config = loadConfig(validEnv());
    expect(config.ingestQueueName).toBe('ingestion-work');
    expect(config.sharePoint.siteId).toBeUndefined();
    expect(config.sharePoint.driveId).toBeUndefined();
    expect(config.telemetry.connectionString).toBeUndefined();
  });

  it('reads the Application Insights connection string when set (D12)', () => {
    const config = loadConfig(validEnv({ APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=abc;IngestionEndpoint=https://x.in.applicationinsights.azure.com/' }));
    expect(config.telemetry.connectionString).toBe('InstrumentationKey=abc;IngestionEndpoint=https://x.in.applicationinsights.azure.com/');
  });

  it('rejects a non-positive cost cap', () => {
    expect(() => loadConfig(validEnv({ TRIALPULSE_DAILY_COST_CAP_USD: '-5' }))).toThrow(
      /TRIALPULSE_DAILY_COST_CAP_USD/,
    );
  });

  it('allows development auth mode on a developer workstation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = loadConfig(validEnv({ TRIALPULSE_AUTH_MODE: 'development' }));
    expect(config.authMode).toBe('development');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses to start in development auth mode when running inside Azure', () => {
    expect(() =>
      loadConfig(
        validEnv({
          TRIALPULSE_AUTH_MODE: 'development',
          WEBSITE_INSTANCE_ID: 'some-real-azure-instance-id',
        }),
      ),
    ).toThrow(/development.*not allowed.*Azure/is);
  });

  it('refuses to start in development auth mode when the Functions runtime marker is present', () => {
    expect(() =>
      loadConfig(
        validEnv({
          TRIALPULSE_AUTH_MODE: 'development',
          FUNCTIONS_WORKER_RUNTIME_VERSION: '~4',
        }),
      ),
    ).toThrow(/development.*not allowed.*Azure/is);
  });
});
