import { describe, expect, it, vi } from 'vitest';
import type { TrialPulseConfig } from '../../config';
import type { Logger } from '../types';
import {
  AzureAppInsightsTelemetrySink,
  parseConnectionString,
  TELEMETRY_EVENT_QUERY,
  TELEMETRY_METRIC_QUERY_COST_USD,
} from './azure-telemetry';

class CapturingLogger implements Logger {
  entries: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
    this.entries.push({ level, message, fields });
  }
}

function configWith(connectionString?: string): Pick<TrialPulseConfig, 'telemetry'> {
  return { telemetry: { connectionString } };
}

describe('parseConnectionString', () => {
  it('extracts the instrumentation key and ingestion endpoint', () => {
    const parsed = parseConnectionString(
      'InstrumentationKey=abc-123;IngestionEndpoint=https://eastus.in.applicationinsights.azure.com/;LiveEndpoint=https://x',
    );
    expect(parsed).toEqual({
      instrumentationKey: 'abc-123',
      ingestionEndpoint: 'https://eastus.in.applicationinsights.azure.com/',
    });
  });

  it('falls back to the default ingestion endpoint when absent', () => {
    const parsed = parseConnectionString('InstrumentationKey=abc-123');
    expect(parsed?.ingestionEndpoint).toBe('https://dc.services.visualstudio.com/');
  });

  it('returns null when the instrumentation key is missing', () => {
    expect(parseConnectionString('IngestionEndpoint=https://x')).toBeNull();
  });
});

describe('AzureAppInsightsTelemetrySink', () => {
  it('D12: does nothing when Application Insights is not configured (local dev/tests)', () => {
    const fetchImpl = vi.fn();
    const sink = new AzureAppInsightsTelemetrySink(configWith(undefined), new CapturingLogger(), fetchImpl);
    sink.recordSpan({ name: 'query', durationMs: 100, attributes: { role: 'regulatory_affairs', status: 'answered', cache_hit: false, cost_usd: 0.01 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('D12: emits the exact trialpulse.query.cost_usd metric and trialpulse.query event for the "query" span', () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const sink = new AzureAppInsightsTelemetrySink(
      configWith('InstrumentationKey=test-key;IngestionEndpoint=https://x.in.applicationinsights.azure.com/'),
      new CapturingLogger(),
      fetchImpl,
    );
    sink.recordSpan({
      name: 'query',
      durationMs: 1234,
      attributes: { role: 'regulatory_affairs', status: 'answered', cache_hit: false, cost_usd: 0.0042 },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x.in.applicationinsights.azure.com/v2/track');
    const envelopes = JSON.parse(init.body as string) as Array<Record<string, unknown>>;

    const eventEnvelope = envelopes.find((e) => (e['data'] as { baseData: { name?: string } }).baseData.name === TELEMETRY_EVENT_QUERY);
    expect(eventEnvelope).toBeDefined();
    expect((eventEnvelope as Record<string, unknown>)['iKey']).toBe('test-key');

    const metricEnvelope = envelopes.find(
      (e) => (e['data'] as { baseType: string }).baseType === 'MetricData',
    ) as { data: { baseData: { metrics: Array<{ name: string; value: number }> } } };
    expect(metricEnvelope).toBeDefined();
    expect(metricEnvelope.data.baseData.metrics[0]).toMatchObject({ name: TELEMETRY_METRIC_QUERY_COST_USD, value: 0.0042 });
  });

  it('emits a generic custom event (no metric) for a span other than "query"', () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const sink = new AzureAppInsightsTelemetrySink(
      configWith('InstrumentationKey=test-key'),
      new CapturingLogger(),
      fetchImpl,
    );
    sink.recordSpan({ name: 'audit_write_failure', durationMs: 0, attributes: { trace_id: 't1' } });

    const envelopes = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string) as Array<
      Record<string, unknown>
    >;
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0]?.['data'] as { baseData: { name: string } }).baseData.name).toBe('trialpulse.audit_write_failure');
  });

  it('never throws when the export fetch rejects (fire-and-forget)', () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const logger = new CapturingLogger();
    const sink = new AzureAppInsightsTelemetrySink(configWith('InstrumentationKey=test-key'), logger, fetchImpl);
    expect(() => sink.recordSpan({ name: 'query', durationMs: 1, attributes: { cost_usd: 0.01 } })).not.toThrow();
  });

  it('logs a warning and disables export when the connection string has no instrumentation key', () => {
    const logger = new CapturingLogger();
    const fetchImpl = vi.fn();
    const sink = new AzureAppInsightsTelemetrySink(configWith('IngestionEndpoint=https://x'), logger, fetchImpl);
    sink.recordSpan({ name: 'query', durationMs: 1, attributes: { cost_usd: 0.01 } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });
});
