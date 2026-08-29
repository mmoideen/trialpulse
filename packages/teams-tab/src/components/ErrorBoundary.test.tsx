import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ErrorBoundary } from './ErrorBoundary';

function Bomb({ shouldThrow }: { shouldThrow: boolean }): ReactElement {
  if (shouldThrow) throw new Error('boom');
  return <div>Safe content</div>;
}

describe('ErrorBoundary', () => {
  it('renders children normally when there is no error', () => {
    render(
      <ErrorBoundary label="Ask">
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Safe content')).toBeInTheDocument();
  });

  it('catches a render error and shows a labelled recovery action instead of a blank screen', () => {
    // React logs the caught error to console.error; silence it for this test.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary label="Dashboard">
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(/dashboard/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
    expect(screen.queryByText('Safe content')).not.toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('calls onError with the caught error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    render(
      <ErrorBoundary label="Browse" onError={onError}>
        <Bomb shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledWith(expect.any(Error), expect.anything());
    consoleSpy.mockRestore();
  });

  it('recovers when "Try again" is clicked after the underlying problem is resolved', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const control = { shouldThrow: true };

    function FlakyChild() {
      if (control.shouldThrow) throw new Error('boom');
      return <div>Recovered content</div>;
    }

    render(
      <ErrorBoundary label="Ask">
        <FlakyChild />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    control.shouldThrow = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    consoleSpy.mockRestore();
  });
});
