/**
 * Shared test fixtures for `src/functions/*.test.ts`. Not a `.test.ts` file
 * itself, so vitest never tries to run it as a suite.
 */
import type { Role } from '@trialpulse/shared';
import { loadConfig, type TrialPulseConfig } from '../config';
import { createAppDeps, type AppDeps } from './deps';
import type { Clock, Logger } from '../providers/types';

export class FakeClock implements Clock {
  constructor(private ms: number = Date.parse('2026-06-15T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.ms);
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export class CapturingLogger implements Logger {
  entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level, message, fields });
  }
}

const VALID_ENV: NodeJS.ProcessEnv = {
  AZURE_OPENAI_ENDPOINT: 'https://aoai.example.com/',
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
  AZURE_OPENAI_GENERATION_DEPLOYMENT: 'gpt-4o',
  AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI: 'gpt-4o-mini',
  AZURE_SEARCH_ENDPOINT: 'https://search.example.com',
  AZURE_SEARCH_INDEX_NAME: 'idx',
  COSMOS_ENDPOINT: 'https://cosmos.example.com:443/',
  COSMOS_DATABASE_NAME: 'db',
  ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  ENTRA_AUDIENCE: 'api://trialpulse',
  ENTRA_ISSUER: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
  KEY_VAULT_URI: 'https://kv.example.com/',
  SHAREPOINT_WEBHOOK_CLIENT_STATE: 'super-secret-client-state',
  AZURE_STORAGE_QUEUE_ACCOUNT_URL: 'https://trialpulse.queue.core.windows.net',
  TRIALPULSE_INGEST_QUEUE: 'ingestion-work',
  TRIALPULSE_AUTH_MODE: 'development',
};

export function testConfig(overrides: Partial<TrialPulseConfig> = {}): TrialPulseConfig {
  // loadConfig() intentionally prints a loud banner for development auth
  // mode (see src/config.ts); every test in this suite deliberately uses
  // that mode, so silence it here rather than at every call site.
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    return { ...loadConfig(VALID_ENV), ...overrides };
  } finally {
    console.warn = originalWarn;
  }
}

export function buildTestDeps(overrides: { config?: Partial<TrialPulseConfig> } = {}): {
  deps: AppDeps;
  clock: FakeClock;
  logger: CapturingLogger;
} {
  const clock = new FakeClock();
  const logger = new CapturingLogger();
  const config = testConfig(overrides.config);
  const deps = createAppDeps({ mode: 'memory', config, clock, logger });
  return { deps, clock, logger };
}

/** An unsigned dev-identity header value, only ever honoured in development auth mode. */
export function devHeaders(role: Role, overrides: Record<string, unknown> = {}): Record<string, string> {
  return {
    'x-dev-identity': JSON.stringify({ upn: `${role}@meridiantx.com`, role, sites: [], ...overrides }),
  };
}
