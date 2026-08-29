import { useCallback, useEffect, useState } from 'react';
import type { DailySummary, Role } from '@trialpulse/shared';
import { ApiClient, ApiError } from '../teams/api-client';
import { CostDashboard, type CostDashboardStatus } from '../components/CostDashboard';
import type { TopQueryRow } from '../utils/dashboard';
import styles from './DashboardTab.module.css';

export interface DashboardTabProps {
  apiClient: ApiClient;
  role: Role;
}

/**
 * Usage analytics (PRD 6.1/6.2). Per PRD section 5.1, `/api/admin/usage` is
 * restricted to `it_admin`; every other role legitimately receives a 403
 * here. That is treated as a normal, calm "restricted" state -- not an
 * application error -- while genuine failures (network/5xx) still surface
 * the CostDashboard's error state with a retry action.
 *
 * This is the default export so `React.lazy(() => import('./DashboardTab'))`
 * in App.tsx can code-split it: PRD section 9 requires the initial tab load
 * to be Ask only.
 */
export default function DashboardTab({ apiClient, role }: DashboardTabProps) {
  const [status, setStatus] = useState<CostDashboardStatus>('loading');
  const [restricted, setRestricted] = useState(false);
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [topQueries, setTopQueries] = useState<TopQueryRow[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setStatus('loading');
    setRestricted(false);
    apiClient
      .getUsage({ role })
      .then((usage) => {
        setSummaries(usage.summaries);
        setTopQueries(usage.top_queries);
        setStatus('success');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.kind === 'forbidden') {
          setRestricted(true);
          setStatus('success');
          return;
        }
        setErrorMessage(err instanceof ApiError ? err.message : 'Could not load usage data.');
        setStatus('error');
      });
  }, [apiClient, role]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className={styles.container}>
      <h2 className="tp-visually-hidden">Usage dashboard</h2>
      {restricted ? (
        <p className={styles.restricted}>
          Usage analytics are visible to IT Administrators. Contact your IT admin for organization-wide
          spend and query volume.
        </p>
      ) : (
        <CostDashboard
          status={status}
          summaries={summaries}
          topQueries={topQueries}
          errorMessage={errorMessage}
          onRetry={load}
        />
      )}
    </div>
  );
}
