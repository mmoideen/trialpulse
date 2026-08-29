/**
 * In-memory `AuditSink` for local dev, unit tests and the eval harness.
 * Keeps everything in an array; queries are linear scans, which is fine at
 * the scale a local run or a unit test ever reaches.
 */
import type { AuditRecord, DailySummary, Role } from '@trialpulse/shared';
import type { AuditSink } from '../types';

export class MemoryAuditSink implements AuditSink {
  private readonly records: AuditRecord[] = [];
  private readonly summaries = new Map<string, DailySummary>();

  write(record: AuditRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }

  query(options: { from?: string; to?: string; role?: Role; limit?: number }): Promise<AuditRecord[]> {
    let results = [...this.records];
    if (options.from) results = results.filter((r) => r.partition_date >= options.from!);
    if (options.to) results = results.filter((r) => r.partition_date <= options.to!);
    if (options.role) results = results.filter((r) => r.entra_role === options.role);
    results.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    return Promise.resolve(options.limit ? results.slice(0, options.limit) : results);
  }

  upsertDailySummary(summary: DailySummary): Promise<void> {
    this.summaries.set(summary.date, summary);
    return Promise.resolve();
  }

  getDailySummaries(from: string, to: string): Promise<DailySummary[]> {
    const results = [...this.summaries.values()]
      .filter((s) => s.date >= from && s.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
    return Promise.resolve(results);
  }

  /** Test/local-only affordance: every record written so far, insertion order. */
  all(): readonly AuditRecord[] {
    return this.records;
  }
}
