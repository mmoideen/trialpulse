import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { IngestionStatus } from '@trialpulse/shared';
import { DocumentStatusBadge } from './DocumentStatusBadge';

const STATUSES: Array<{ status: IngestionStatus; label: string }> = [
  { status: 'pending', label: 'Pending' },
  { status: 'indexed', label: 'Indexed' },
  { status: 'failed', label: 'Failed' },
  { status: 'outdated', label: 'Outdated' },
];

describe('DocumentStatusBadge', () => {
  it.each(STATUSES)('renders the $label text label for status "$status"', ({ status, label }) => {
    render(<DocumentStatusBadge status={status} lastIngestedAt="2026-08-20T10:00:00Z" chunkCount={7} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each(STATUSES)('pairs status "$status" with a visible icon, not colour alone', ({ status }) => {
    const { container } = render(
      <DocumentStatusBadge status={status} lastIngestedAt={null} chunkCount={0} />,
    );
    expect(container.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('shows a tooltip with the last-ingested timestamp and chunk count', () => {
    render(<DocumentStatusBadge status="indexed" lastIngestedAt="2026-08-20T10:00:00Z" chunkCount={42} />);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip).toHaveTextContent(/chunks: 42/i);
    expect(tooltip.textContent).toMatch(/2026/);
  });

  it('shows "never" in the tooltip when the document has not been ingested', () => {
    render(<DocumentStatusBadge status="pending" lastIngestedAt={null} chunkCount={0} />);
    expect(screen.getByRole('tooltip')).toHaveTextContent(/never/i);
  });

  it('associates the badge with its tooltip via aria-describedby for keyboard/screen-reader users', () => {
    render(<DocumentStatusBadge status="failed" lastIngestedAt={null} chunkCount={0} />);
    const badge = screen.getByText('Failed');
    const tooltip = screen.getByRole('tooltip');
    expect(badge).toHaveAttribute('aria-describedby', tooltip.id);
  });
});
