/**
 * Cosmos DB-backed `AuditSink` (PRD section 4.1: `audit_logs` and
 * `daily_summaries` collections).
 *
 * `audit_logs` is partitioned by `partition_date` (the UTC date the query
 * happened on) -- this keeps a day's writes and the daily compaction job's
 * reads (`functions/timers.ts`) within a single logical partition, and
 * spreads write volume across partitions over time instead of hotspotting
 * one.
 */
import { CosmosClient } from '@azure/cosmos';
import type { AuditRecord, DailySummary, Role } from '@trialpulse/shared';
import type { TrialPulseConfig } from '../../config';
import type { AuditSink } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

const AUDIT_LOGS_CONTAINER = 'audit_logs';
const DAILY_SUMMARIES_CONTAINER = 'daily_summaries';

function createClient(config: TrialPulseConfig): CosmosClient {
  if (config.cosmos.key) {
    return new CosmosClient({ endpoint: config.cosmos.endpoint, key: config.cosmos.key });
  }
  return new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: getManagedIdentityCredential() });
}

class AzureAuditSink implements AuditSink {
  private readonly client: CosmosClient;
  private readonly databaseName: string;

  constructor(config: TrialPulseConfig) {
    this.client = createClient(config);
    this.databaseName = config.cosmos.databaseName;
  }

  private auditContainer() {
    return this.client.database(this.databaseName).container(AUDIT_LOGS_CONTAINER);
  }

  private summaryContainer() {
    return this.client.database(this.databaseName).container(DAILY_SUMMARIES_CONTAINER);
  }

  async write(record: AuditRecord): Promise<void> {
    await withRetry(() => this.auditContainer().items.upsert(record), { isRetryable: isLikelyTransientAzureError });
  }

  async query(options: { from?: string; to?: string; role?: Role; limit?: number }): Promise<AuditRecord[]> {
    const conditions: string[] = [];
    const parameters: { name: string; value: string | number }[] = [];
    if (options.from) {
      conditions.push('c.partition_date >= @from');
      parameters.push({ name: '@from', value: options.from });
    }
    if (options.to) {
      conditions.push('c.partition_date <= @to');
      parameters.push({ name: '@to', value: options.to });
    }
    if (options.role) {
      conditions.push('c.entra_role = @role');
      parameters.push({ name: '@role', value: options.role });
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const top = options.limit ? `TOP ${Math.floor(options.limit)}` : '';
    const query = `SELECT ${top} * FROM c ${where} ORDER BY c.timestamp DESC`;

    const { resources } = await withRetry(
      () => this.auditContainer().items.query<AuditRecord>({ query, parameters }).fetchAll(),
      { isRetryable: isLikelyTransientAzureError },
    );
    return resources;
  }

  async upsertDailySummary(summary: DailySummary): Promise<void> {
    await withRetry(() => this.summaryContainer().items.upsert(summary), { isRetryable: isLikelyTransientAzureError });
  }

  async getDailySummaries(from: string, to: string): Promise<DailySummary[]> {
    const { resources } = await withRetry(
      () =>
        this.summaryContainer()
          .items.query<DailySummary>({
            query: 'SELECT * FROM c WHERE c.date >= @from AND c.date <= @to ORDER BY c.date ASC',
            parameters: [
              { name: '@from', value: from },
              { name: '@to', value: to },
            ],
          })
          .fetchAll(),
      { isRetryable: isLikelyTransientAzureError },
    );
    return resources;
  }
}

export function createAzureAuditSink(config: TrialPulseConfig): AuditSink {
  return new AzureAuditSink(config);
}
