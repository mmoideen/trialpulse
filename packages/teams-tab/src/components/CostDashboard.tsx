import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ROLES, type DailySummary } from '@trialpulse/shared';
import { roleLabel } from '../utils/labels';
import {
  DEFAULT_MONTHLY_BUDGET_USD,
  buildCumulativeCostSeries,
  buildRoleQuerySeries,
  topExpensiveQueries,
  type TopQueryRow,
} from '../utils/dashboard';
import styles from './CostDashboard.module.css';

const ROLE_CHART_TOKENS = [
  'var(--tp-chart-1)',
  'var(--tp-chart-2)',
  'var(--tp-chart-3)',
  'var(--tp-chart-4)',
  'var(--tp-chart-5)',
  'var(--tp-chart-6)',
];

export type CostDashboardStatus = 'loading' | 'error' | 'success';

export interface CostDashboardProps {
  status: CostDashboardStatus;
  summaries: DailySummary[];
  topQueries: TopQueryRow[];
  errorMessage?: string | null;
  monthlyBudgetUsd?: number;
  onRetry?: () => void;
}

/**
 * PRD 6.2 CostDashboard: daily queries by role (bar), cumulative cost vs
 * monthly budget (line), and a top-10 expensive-query table.
 */
export function CostDashboard({
  status,
  summaries,
  topQueries,
  errorMessage,
  monthlyBudgetUsd = DEFAULT_MONTHLY_BUDGET_USD,
  onRetry,
}: CostDashboardProps) {
  if (status === 'loading') {
    return (
      <div className={styles.state} role="status" aria-live="polite">
        Loading usage data&hellip;
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={styles.errorState} role="alert">
        <p>{errorMessage ?? 'Could not load usage data.'}</p>
        {onRetry ? (
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  if (summaries.length === 0) {
    return <div className={styles.state}>No usage data for the selected period yet.</div>;
  }

  const roleQuerySeries = buildRoleQuerySeries(summaries);
  const cumulativeCostSeries = buildCumulativeCostSeries(summaries, monthlyBudgetUsd);
  const topTen = topExpensiveQueries(topQueries, 10);

  return (
    <div>
      <section className={styles.section} aria-labelledby="daily-queries-heading">
        <h3 id="daily-queries-heading" className={styles.sectionTitle}>
          Daily queries by role (last {summaries.length} days)
        </h3>
        <div className={styles.chartCard}>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={roleQuerySeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--tp-chart-grid)" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend formatter={(value) => roleLabel(value as (typeof ROLES)[number])} />
              {ROLES.map((role, i) => (
                <Bar
                  key={role}
                  dataKey={role}
                  name={role}
                  stackId="queries"
                  fill={ROLE_CHART_TOKENS[i % ROLE_CHART_TOKENS.length]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="cumulative-cost-heading">
        <h3 id="cumulative-cost-heading" className={styles.sectionTitle}>
          Cumulative cost vs. monthly budget (${monthlyBudgetUsd})
        </h3>
        <div className={styles.chartCard}>
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={cumulativeCostSeries}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--tp-chart-grid)" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
              <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
              <Legend />
              <Line
                type="monotone"
                dataKey="cumulativeCost"
                name="Cumulative cost"
                stroke="var(--tp-chart-cost-line)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="budget"
                name="Monthly budget"
                stroke="var(--tp-chart-budget-line)"
                strokeDasharray="6 4"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="top-queries-heading">
        <h3 id="top-queries-heading" className={styles.sectionTitle}>
          Top {topTen.length} most expensive queries
        </h3>
        {topTen.length === 0 ? (
          <div className={styles.state}>No queries recorded for the selected period.</div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Query</th>
                <th scope="col">Role</th>
                <th scope="col">Cost (USD)</th>
                <th scope="col">Latency (ms)</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {topTen.map((row) => (
                <tr key={row.query_hash}>
                  <td>
                    <code>{row.query_hash.slice(0, 12)}&hellip;</code>
                  </td>
                  <td>{roleLabel(row.role)}</td>
                  <td>${row.cost_usd.toFixed(4)}</td>
                  <td>{row.latency_ms}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
