import { describe, expect, it } from 'vitest';
import { buildCumulativeCostSeries, buildRoleQuerySeries, topExpensiveQueries } from './dashboard';
import { makeDailySummary } from '../test/fixtures';

describe('buildRoleQuerySeries', () => {
  it('sorts by date and fills every role, defaulting to 0 when absent from breakdown_by_role', () => {
    const summaries = [
      makeDailySummary({ date: '2026-08-02' }),
      makeDailySummary({ date: '2026-08-01' }),
    ];
    const series = buildRoleQuerySeries(summaries);
    expect(series.map((s) => s.date)).toEqual(['2026-08-01', '2026-08-02']);
    expect(series[0]!.it_admin).toBe(0);
    expect(series[0]!.regulatory_affairs).toBe(40);
  });
});

describe('buildCumulativeCostSeries', () => {
  it('accumulates cost across days and attaches the flat budget line', () => {
    const summaries = [
      makeDailySummary({ date: '2026-08-01', total_cost_usd: 1 }),
      makeDailySummary({ date: '2026-08-02', total_cost_usd: 2.5 }),
    ];
    const series = buildCumulativeCostSeries(summaries, 300);
    expect(series).toEqual([
      { date: '2026-08-01', cumulativeCost: 1, budget: 300 },
      { date: '2026-08-02', cumulativeCost: 3.5, budget: 300 },
    ]);
  });
});

describe('topExpensiveQueries', () => {
  it('sorts descending by cost and truncates to the limit', () => {
    const rows = [
      { query_hash: 'a', role: 'regulatory_affairs' as const, cost_usd: 0.01, latency_ms: 100, count: 1 },
      { query_hash: 'b', role: 'regulatory_affairs' as const, cost_usd: 0.5, latency_ms: 100, count: 1 },
      { query_hash: 'c', role: 'regulatory_affairs' as const, cost_usd: 0.2, latency_ms: 100, count: 1 },
    ];
    expect(topExpensiveQueries(rows, 2).map((r) => r.query_hash)).toEqual(['b', 'c']);
  });
});
