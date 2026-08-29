/**
 * Application Insights-backed `TelemetrySink` (D12).
 *
 * `functions/deps.ts` used to default to `NoopTelemetry` unconditionally --
 * every span was discarded, so `infra/modules/alerts.bicep`'s
 * `trialpulse.query.cost_usd` custom-metric alert (the denial-of-wallet
 * guard) could never fire, no matter how much a burst actually cost.
 *
 * This talks to the Application Insights ingestion REST endpoint directly
 * (`POST {ingestionEndpoint}v2/track`) rather than pulling in the
 * `applicationinsights` SDK, matching this package's existing choice for
 * Azure Storage Queue (`azure-queue.ts`): the ingestion surface for "post a
 * few telemetry envelopes" is a single authenticated-by-instrumentation-key
 * POST, and Azure Functions' own host process already auto-instruments
 * `requests`/`dependencies`/`exceptions` (the P99 latency and error-rate
 * alerts in `alerts.bicep` read those, and need no code here at all) --
 * the one gap only application code can fill is the *custom* cost metric.
 *
 * Fire-and-forget: telemetry must never slow down or fail a user's query.
 * `recordSpan` returns synchronously (per `TelemetrySink`); export failures
 * are logged, never thrown.
 */
import type { TrialPulseConfig } from '../../config';
import type { Logger, TelemetrySink, TelemetrySpan } from '../types';

/** infra/modules/alerts.bicep's `costMetricName` default -- MUST match verbatim; the infra workstream's CI checks for this exact string in orchestrator source. */
export const TELEMETRY_METRIC_QUERY_COST_USD = 'trialpulse.query.cost_usd';
/** The per-query custom event name. MUST match verbatim; see the module doc above. */
export const TELEMETRY_EVENT_QUERY = 'trialpulse.query';

/** The one span name (`query-pipeline.ts`'s `finalize()`) that produces the custom cost metric, in addition to a generic custom event for every span. */
const QUERY_SPAN_NAME = 'query';

interface ParsedConnectionString {
  instrumentationKey: string;
  ingestionEndpoint: string;
}

/** `InstrumentationKey=...;IngestionEndpoint=https://...;...` -> its two fields this sink needs. */
export function parseConnectionString(raw: string): ParsedConnectionString | null {
  const fields = new Map<string, string>();
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const instrumentationKey = fields.get('instrumentationkey');
  if (!instrumentationKey) return null;
  const ingestionEndpoint = (fields.get('ingestionendpoint') ?? 'https://dc.services.visualstudio.com/').replace(/\/+$/, '') + '/';
  return { instrumentationKey, ingestionEndpoint };
}

function isoNow(): string {
  return new Date().toISOString();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Application Insights envelopes are a large, heterogeneous JSON schema; typing every field buys no safety here.
type Envelope = Record<string, any>;

function buildEventEnvelope(iKey: string, name: string, span: TelemetrySpan): Envelope {
  return {
    name: 'Microsoft.ApplicationInsights.Event',
    time: isoNow(),
    iKey,
    data: {
      baseType: 'EventData',
      baseData: {
        ver: 2,
        name,
        properties: {
          ...Object.fromEntries(Object.entries(span.attributes).map(([k, v]) => [k, String(v)])),
          duration_ms: String(span.durationMs),
        },
      },
    },
  };
}

function buildMetricEnvelope(iKey: string, name: string, value: number): Envelope {
  return {
    name: 'Microsoft.ApplicationInsights.Metric',
    time: isoNow(),
    iKey,
    data: {
      baseType: 'MetricData',
      baseData: {
        ver: 2,
        metrics: [{ name, kind: 'Measurement', value, count: 1 }],
      },
    },
  };
}

export class AzureAppInsightsTelemetrySink implements TelemetrySink {
  private readonly parsed: ParsedConnectionString | null;

  constructor(
    config: Pick<TrialPulseConfig, 'telemetry'>,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.parsed = config.telemetry.connectionString ? parseConnectionString(config.telemetry.connectionString) : null;
    if (config.telemetry.connectionString && !this.parsed) {
      this.logger.log('warn', 'APPLICATIONINSIGHTS_CONNECTION_STRING is set but missing InstrumentationKey; telemetry export disabled', {});
    }
  }

  recordSpan(span: TelemetrySpan): void {
    if (!this.parsed) return; // not configured (e.g. local dev/tests) -- silently a no-op, same posture as NoopTelemetry.
    const { instrumentationKey, ingestionEndpoint } = this.parsed;

    // The one well-known per-query span gets the exact, CI-checked event
    // name; every other span (e.g. `audit_write_failure`) still gets a
    // generic custom event so it isn't silently dropped, just without a
    // hardcoded name to match.
    const eventName = span.name === QUERY_SPAN_NAME ? TELEMETRY_EVENT_QUERY : `trialpulse.${span.name}`;
    const envelopes: Envelope[] = [buildEventEnvelope(instrumentationKey, eventName, span)];
    if (span.name === QUERY_SPAN_NAME) {
      const cost = span.attributes['cost_usd'];
      if (typeof cost === 'number') {
        envelopes.push(buildMetricEnvelope(instrumentationKey, TELEMETRY_METRIC_QUERY_COST_USD, cost));
      }
    }

    // Fire-and-forget: telemetry export must never block or fail a query.
    void this.fetchImpl(`${ingestionEndpoint}v2/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelopes),
    }).catch((err: unknown) => {
      this.logger.log('warn', 'telemetry export to Application Insights failed', { error: String(err) });
    });
  }
}

export function createAzureAppInsightsTelemetrySink(config: TrialPulseConfig, logger: Logger): TelemetrySink {
  return new AzureAppInsightsTelemetrySink(config, logger);
}
