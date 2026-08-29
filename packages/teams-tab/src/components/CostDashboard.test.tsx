import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostDashboard } from './CostDashboard';
import { makeDailySummary } from '../test/fixtures';

const topQueries = [
  { query_hash: 'abcdef0123456789', role: 'regulatory_affairs' as const, cost_usd: 0.05, latency_ms: 1200, count: 3 },
];

describe('CostDashboard', () => {
  it('shows a loading state and no charts while loading', () => {
    render(<CostDashboard status="loading" summaries={[]} topQueries={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading usage data/i);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows an error state with a retry action', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<CostDashboard status="error" summaries={[]} topQueries={[]} errorMessage="Boom" onRetry={onRetry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows an empty state when there is no usage data yet', () => {
    render(<CostDashboard status="success" summaries={[]} topQueries={[]} />);
    expect(screen.getByText(/no usage data/i)).toBeInTheDocument();
  });

  it('renders chart section headings and the top-queries table when data is present', () => {
    render(
      <CostDashboard
        status="success"
        summaries={[makeDailySummary()]}
        topQueries={topQueries}
        monthlyBudgetUsd={300}
      />,
    );

    expect(screen.getByRole('heading', { name: /daily queries by role/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /cumulative cost vs\. monthly budget/i })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('Regulatory Affairs')).toBeInTheDocument();
    expect(screen.getByText('$0.0500')).toBeInTheDocument();
  });

  it('shows an empty state for the table when there are no top queries', () => {
    render(<CostDashboard status="success" summaries={[makeDailySummary()]} topQueries={[]} />);
    expect(screen.getByText(/no queries recorded/i)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
