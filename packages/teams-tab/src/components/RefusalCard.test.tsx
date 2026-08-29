import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RefusalCard } from './RefusalCard';

describe('RefusalCard', () => {
  it('renders the specific reason text when one is known', () => {
    render(<RefusalCard reason="no_relevant_chunks" />);
    expect(screen.getByText(/couldn't find information/i)).toBeInTheDocument();
  });

  it('renders a generic reassuring message when the reason is null', () => {
    render(<RefusalCard reason={null} />);
    expect(screen.getByText(/couldn't find information/i)).toBeInTheDocument();
  });

  it('uses status (not alert) semantics so it never reads as a failure', () => {
    render(<RefusalCard reason="query_rejected" />);
    // role="status" is polite/informational; role="alert" is reserved for the
    // distinct network/server error banner in AskTab.
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
