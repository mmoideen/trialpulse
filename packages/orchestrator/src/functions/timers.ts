/**
 * Scheduled background workflows (PRD 3.3.2, 3.3.3, and the delta-sync half
 * of 3.3.1).
 *
 * Each workflow is exposed as a pure, directly-testable `run*` function plus
 * a thin `register*` wrapper that binds it to a real `app.timer` schedule --
 * exactly the same split as the HTTP functions.
 */
import { app } from '@azure/functions';
import type { InvocationContext, Timer } from '@azure/functions';
import { COST_SPIKE_MULTIPLIER, DAILY_COST_HARD_STOP_MULTIPLIER, type AuditRecord, type DailySummary } from '@trialpulse/shared';
import { COST_DOWNGRADE_CACHE_KEY, COST_HARD_STOP_CACHE_KEY } from '../pipeline/model-router';
import type { AppDeps } from './deps';

/** Cache TTL for the downgrade/hard-stop flags: re-evaluated every 5 minutes (see `registerCostAlertTimer`); 2 hours of headroom means a stalled timer fails safe back to "not downgraded" rather than gapping into a stale `true`. */
const DOWNGRADE_FLAG_TTL_SECONDS = 2 * 60 * 60;

/** Injectable so the real deployment can post to a Teams channel without this module depending on the Bot Framework SDK. */
export interface AdminNotifier {
  notifyAdmin(message: string): Promise<void>;
}

/** Default notifier for local/dev runs: logs loudly instead of silently doing nothing. */
export class LoggingAdminNotifier implements AdminNotifier {
  constructor(private readonly logger: AppDeps['logger']) {}
  async notifyAdmin(message: string): Promise<void> {
    this.logger.log('warn', 'admin notification', { message });
    return Promise.resolve();
  }
}

/**
 * D8: nearest-rank percentile is `ceil(p * n) - 1`, not `floor(p * n)`.
 * Whenever `p * n` was an exact integer, the old formula was one rank too
 * high -- 100 queries at 1..100ms reported P99 = 100ms (the max, i.e. P100)
 * and `[10, 20]` reported P50 = 20 (the max of a 2-element array, i.e. P100)
 * instead of the true median, 10.
 */
function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(p * sortedValues.length) - 1));
  return sortedValues[index]!;
}

/** Pure aggregation: PRD 3.3.2's daily_summaries shape from a day's raw audit records. */
export function computeDailySummary(date: string, records: readonly AuditRecord[]): DailySummary {
  const latencies = [...records.map((r) => r.latency_ms)].sort((a, b) => a - b);
  const totalCost = records.reduce((sum, r) => sum + r.estimated_cost_usd, 0);
  const totalQueries = records.length;
  const totalRefusals = records.filter((r) => r.response_status === 'refused').length;
  const cacheHits = records.filter((r) => r.cache_hit).length;
  const avgLatency = totalQueries > 0 ? latencies.reduce((s, v) => s + v, 0) / totalQueries : 0;

  const breakdown: Record<string, { queries: number; cost: number }> = {};
  for (const record of records) {
    const entry = breakdown[record.entra_role] ?? { queries: 0, cost: 0 };
    entry.queries += 1;
    entry.cost += record.estimated_cost_usd;
    breakdown[record.entra_role] = entry;
  }

  return {
    id: date,
    date,
    total_queries: totalQueries,
    total_refusals: totalRefusals,
    avg_latency_ms: Math.round(avgLatency),
    p50_latency_ms: percentile(latencies, 0.5),
    p99_latency_ms: percentile(latencies, 0.99),
    total_cost_usd: Math.round(totalCost * 1e6) / 1e6,
    cache_hit_rate: totalQueries > 0 ? cacheHits / totalQueries : 0,
    breakdown_by_role: breakdown,
  };
}

/** Workflow 3.3.2: compact yesterday's raw audit events into a daily summary. */
export async function runDailyAuditCompaction(deps: AppDeps, targetDate?: string): Promise<DailySummary> {
  const yesterday = targetDate ?? previousUtcDate(deps.clock.now());
  const records = await deps.audit.query({ from: yesterday, to: yesterday, limit: 1_000_000 });
  const summary = computeDailySummary(yesterday, records);
  await deps.audit.upsertDailySummary(summary);
  return summary;
}

function previousUtcDate(now: Date): string {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return yesterday.toISOString().slice(0, 10);
}

function sum(values: readonly number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/**
 * D9: a partial history (e.g. one day post-go-live, or after any audit gap)
 * used to deflate the baseline up to 7x by dividing by a hardcoded 7
 * regardless of how many days of history actually existed, tripping the
 * spike alert on perfectly ordinary days. Divides by the actual number of
 * distinct `partition_date`s present, and additionally requires a minimum
 * of `MIN_PRIOR_DAYS_FOR_SPIKE_CHECK` distinct days before evaluating at
 * all -- a 1-2 day "average" is too noisy to be a meaningful baseline even
 * with the correct divisor. Day-1-with-zero-history was already handled
 * correctly by the `> 0` guard and remains so.
 */
const MIN_PRIOR_DAYS_FOR_SPIKE_CHECK = 3;

/** Every distinct `partition_date` present in `records`. */
function distinctPartitionDates(records: readonly AuditRecord[]): Set<string> {
  return new Set(records.map((r) => r.partition_date));
}

/** Workflow 3.3.3: cost alerting, the hard-cap model downgrade, and the cost hard stop (D5). */
export async function runCostAlertCheck(deps: AppDeps, notifier: AdminNotifier): Promise<void> {
  const now = deps.clock.now();
  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoff8d = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const fromPartition = cutoff8d.toISOString().slice(0, 10);
  const toPartition = now.toISOString().slice(0, 10);

  const records = await deps.audit.query({ from: fromPartition, to: toPartition, limit: 1_000_000 });
  const last24h = records.filter((r) => new Date(r.timestamp) >= cutoff24h);
  const prior7d = records.filter((r) => new Date(r.timestamp) < cutoff24h && new Date(r.timestamp) >= cutoff8d);

  const spend24h = sum(last24h.map((r) => r.estimated_cost_usd));
  const priorDistinctDays = distinctPartitionDates(prior7d).size;
  const prior7dAvgDaily = priorDistinctDays > 0 ? sum(prior7d.map((r) => r.estimated_cost_usd)) / priorDistinctDays : 0;

  if (
    prior7dAvgDaily > 0 &&
    priorDistinctDays >= MIN_PRIOR_DAYS_FOR_SPIKE_CHECK &&
    spend24h > COST_SPIKE_MULTIPLIER * prior7dAvgDaily
  ) {
    await notifier.notifyAdmin(
      `TrialPulse cost spike: $${spend24h.toFixed(2)} in the last 24h vs a ${priorDistinctDays}-day average of ` +
        `$${prior7dAvgDaily.toFixed(2)}/day (${COST_SPIKE_MULTIPLIER}x threshold).`,
    );
  }

  // D5(a)/(b): the downgrade alone is advisory -- spend keeps growing under
  // the mini model, just more slowly. Crossing a second, higher threshold
  // sets a hard-stop flag `query-pipeline.ts` checks *before any billable
  // work happens at all* and refuses outright. Both flags are re-evaluated
  // on `registerCostHardStopTimer`'s much shorter schedule (see below), not
  // just the hourly summary schedule, to shrink the burst-detection window.
  const downgradeActive = spend24h > deps.config.dailyCostCapUsd;
  const hardStopActive = spend24h > deps.config.dailyCostCapUsd * DAILY_COST_HARD_STOP_MULTIPLIER;
  if (downgradeActive) {
    deps.logger.log('warn', 'daily cost hard cap exceeded, forcing mini model for all queries', {
      spend_24h_usd: spend24h,
      cap_usd: deps.config.dailyCostCapUsd,
    });
  }
  if (hardStopActive) {
    deps.logger.log('error', 'daily cost hard stop threshold exceeded, refusing further queries', {
      marker: 'cost_hard_stop',
      spend_24h_usd: spend24h,
      hard_stop_threshold_usd: deps.config.dailyCostCapUsd * DAILY_COST_HARD_STOP_MULTIPLIER,
    });
  }
  await Promise.all([
    deps.cache.set(COST_DOWNGRADE_CACHE_KEY, downgradeActive, DOWNGRADE_FLAG_TTL_SECONDS),
    deps.cache.set(COST_HARD_STOP_CACHE_KEY, hardStopActive, DOWNGRADE_FLAG_TTL_SECONDS),
  ]);
}

/**
 * Workflow 3.3.1 (delta half), historically: trigger the daily SharePoint
 * catch-up sync by enqueuing a message.
 *
 * D12/F5: retired. This enqueued onto `sharepoint-delta-sync-jobs`, a queue
 * nothing has ever consumed -- there is no queue-triggered "run delta sync
 * now" handler anywhere. The real catch-up sync already runs autonomously:
 * `ingestion/function_app.py`'s `daily_delta_sync` is its own
 * `@app.timer_trigger`, calling `SharePointConnector.run_delta_sync`
 * directly with real Graph credentials and correctly enqueuing any changed
 * items it finds onto the one provisioned queue. This function has no
 * remaining job to do; it is kept (rather than deregistering the timer
 * outright) purely so a scheduled-function monitoring dashboard doesn't
 * show one disappearing, and it now only logs, never enqueues.
 */
export async function runSharePointDeltaSyncTrigger(deps: AppDeps): Promise<void> {
  deps.logger.log('info', 'sharepoint delta sync trigger is a no-op; see ingestion/function_app.py daily_delta_sync', {
    triggered_at: deps.clock.now().toISOString(),
  });
}

export function registerDailyAuditCompactionTimer(deps: AppDeps): void {
  app.timer('dailyAuditCompaction', {
    schedule: '0 0 1 * * *', // 01:00 UTC daily
    handler: async (_timer: Timer, _context: InvocationContext) => {
      await runDailyAuditCompaction(deps);
    },
  });
}

export function registerCostAlertTimer(deps: AppDeps, notifier: AdminNotifier = new LoggingAdminNotifier(deps.logger)): void {
  app.timer('costAlertCheck', {
    // D5(a): was hourly. A burst could exceed the daily cap by an unbounded
    // multiple within that detection lag with no refusal path at all.
    // Every 5 minutes shrinks the window the hard-stop/downgrade flags can
    // lag reality to a small fraction of an hour.
    schedule: '0 */5 * * * *',
    handler: async (_timer: Timer, _context: InvocationContext) => {
      await runCostAlertCheck(deps, notifier);
    },
  });
}

export function registerSharePointDeltaSyncTimer(deps: AppDeps): void {
  app.timer('sharepointDeltaSync', {
    schedule: '0 30 1 * * *', // 01:30 UTC daily, after the audit compaction
    handler: async (_timer: Timer, _context: InvocationContext) => {
      await runSharePointDeltaSyncTrigger(deps);
    },
  });
}

