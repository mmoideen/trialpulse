import { Suspense, lazy, useState, type KeyboardEvent } from 'react';
import type { Citation } from '@trialpulse/shared';
import type { ApiClient } from './teams/api-client';
import type { CallerUiIdentity } from './teams/auth';
import { AskTab } from './tabs/AskTab';
import { BrowseTab } from './tabs/BrowseTab';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RoleBadge } from './components/RoleBadge';
import styles from './App.module.css';

// PRD section 9: "the initial tab load must be Ask only." React.lazy + this
// dynamic import means the Dashboard module (and recharts, which it pulls
// in) is only fetched once the user actually opens the Dashboard tab -- see
// src/App.dashboard-lazy.test.tsx for the assertion that this holds.
const DashboardTab = lazy(() => import('./tabs/DashboardTab'));

export type TabId = 'ask' | 'browse' | 'dashboard';

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'ask', label: 'Ask' },
  { id: 'browse', label: 'Browse' },
  { id: 'dashboard', label: 'Dashboard' },
];

export interface AppProps {
  apiClient: ApiClient;
  identity: CallerUiIdentity;
  onShare?: (answer: string, citations: Citation[]) => void;
}

/**
 * App shell: three tabs (Ask / Browse / Dashboard) per PRD 6.1, each wrapped
 * in its own ErrorBoundary so a render error in one tab never blanks the
 * others. Only the active tab (plus any tab visited earlier this session)
 * is mounted, which is what keeps Browse's document fetch and Dashboard's
 * usage fetch from firing before the user asks for them.
 */
export function App({ apiClient, identity, onShare }: AppProps) {
  const [activeTab, setActiveTab] = useState<TabId>('ask');
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set<TabId>(['ask']));

  function selectTab(id: TabId) {
    setActiveTab(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  function handleTabKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.findIndex((t) => t.id === activeTab);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      selectTab(TABS[(index + 1) % TABS.length]!.id);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      selectTab(TABS[(index - 1 + TABS.length) % TABS.length]!.id);
    }
  }

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>TrialPulse</h1>
        <div className={styles.headerRight}>
          <RoleBadge role={identity.role} />
        </div>
      </header>

      {identity.roleFallbackApplied ? (
        <p className={styles.fallbackBanner} role="status">
          Your account has no recognised TrialPulse role. Showing the most restricted view (Site
          Monitor). Contact your IT administrator to have a role assigned.
        </p>
      ) : null}

      <div
        className={styles.tablist}
        role="tablist"
        aria-label="TrialPulse sections"
        onKeyDown={handleTabKeyDown}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            role="tab"
            type="button"
            className={styles.tab}
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <main className={styles.main}>
        <div
          role="tabpanel"
          id="tabpanel-ask"
          aria-labelledby="tab-ask"
          hidden={activeTab !== 'ask'}
          className={activeTab === 'ask' ? styles.tabpanel : undefined}
        >
          <ErrorBoundary label="Ask">
            <AskTab apiClient={apiClient} onShare={onShare} />
          </ErrorBoundary>
        </div>

        <div
          role="tabpanel"
          id="tabpanel-browse"
          aria-labelledby="tab-browse"
          hidden={activeTab !== 'browse'}
          className={activeTab === 'browse' ? styles.tabpanel : undefined}
        >
          <ErrorBoundary label="Browse">
            {visited.has('browse') ? <BrowseTab apiClient={apiClient} role={identity.role} /> : null}
          </ErrorBoundary>
        </div>

        <div
          role="tabpanel"
          id="tabpanel-dashboard"
          aria-labelledby="tab-dashboard"
          hidden={activeTab !== 'dashboard'}
          className={activeTab === 'dashboard' ? styles.tabpanel : undefined}
        >
          <ErrorBoundary label="Dashboard">
            <Suspense fallback={<p className={styles.suspenseFallback}>Loading dashboard&hellip;</p>}>
              {visited.has('dashboard') ? <DashboardTab apiClient={apiClient} role={identity.role} /> : null}
            </Suspense>
          </ErrorBoundary>
        </div>
      </main>
    </div>
  );
}
