/**
 * Pure data transforms feeding the CostDashboard charts. Kept independent of
 * recharts and React so they're trivial to unit test.
 */
import { ROLES, type DailySummary, type Role } from '@trialpulse/shared';

/**
 * PRD section 10 (Success Metrics) sets the target monthly Azure spend at
 * under $300. The API contract does not return a per-tenant budget value, so
 * the dashboard uses this PRD figure as the reference line for "cumulative
 * cost vs. monthly budget". If Meridian configures a different budget via the
 * admin usage endpoint in the future, this constant is the single place to
 * wire that in.
 */
export const DEFAULT_MONTHLY_BUDGET_USD = 300;

export interface RoleQueryDatum {
  date: string;
  total: number;
  [role: string]: string | number;
}

/** One row per day: `{ date, <role>: queryCount, ... }`, for a stacked/grouped bar chart. */
export function buildRoleQuerySeries(summaries: DailySummary[]): RoleQueryDatum[] {
  return [...summaries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((summary) => {
      const row: RoleQueryDatum = { date: summary.date, total: summary.total_queries };
      for (const role of ROLES) {
        row[role] = summary.breakdown_by_role[role]?.queries ?? 0;
      }
      return row;
    });
}

export interface CumulativeCostDatum {
  date: string;
  cumulativeCost: number;
  budget: number;
}

/** Running total of cost across the given summaries, alongside a flat budget line. */
export function buildCumulativeCostSeries(
  summaries: DailySummary[],
  budgetUsd: number = DEFAULT_MONTHLY_BUDGET_USD,
): CumulativeCostDatum[] {
  let running = 0;
  return [...summaries]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((summary) => {
      running += summary.total_cost_usd;
      return { date: summary.date, cumulativeCost: Math.round(running * 1e4) / 1e4, budget: budgetUsd };
    });
}

export interface TopQueryRow {
  query_hash: string;
  role: Role;
  cost_usd: number;
  latency_ms: number;
  count: number;
}

/** Top N most expensive queries, most expensive first. */
export function topExpensiveQueries(rows: TopQueryRow[], limit = 10): TopQueryRow[] {
  return [...rows].sort((a, b) => b.cost_usd - a.cost_usd).slice(0, limit);
}
