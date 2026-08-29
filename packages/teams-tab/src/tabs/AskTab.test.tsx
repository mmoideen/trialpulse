import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MAX_QUERY_LENGTH } from '@trialpulse/shared';
import { AskTab } from './AskTab';
import { ApiError } from '../teams/api-client';
import type { ApiClient } from '../teams/api-client';
import { makeConversationTurn, makeQueryResponse } from '../test/fixtures';

function fakeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getConversation: vi.fn().mockResolvedValue({ turns: [], continuation: null }),
    query: vi.fn().mockResolvedValue(makeQueryResponse()),
    submitFeedback: vi.fn().mockResolvedValue({ turn_id: 't1', feedback: 'up' }),
    ...overrides,
  } as unknown as ApiClient;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('AskTab', () => {
  it('happy path: submits a question and renders the cited answer', async () => {
    const response = makeQueryResponse({
      answer: 'The protocol requires monthly visits [1].',
      status: 'answered',
    });
    const client = fakeApiClient({ query: vi.fn().mockResolvedValue(response) });
    const user = userEvent.setup();
    render(<AskTab apiClient={client} />);

    await waitFor(() => expect(client.getConversation).toHaveBeenCalled());

    const textarea = screen.getByLabelText(/ask a question/i);
    await user.type(textarea, 'What does the protocol require?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByText(/monthly visits/i)).toBeInTheDocument();
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'What does the protocol require?' }),
    );
    expect(textarea).toHaveValue('');
  });

  it('Shift+Enter inserts a newline instead of submitting', async () => {
    const client = fakeApiClient();
    const user = userEvent.setup();
    render(<AskTab apiClient={client} />);
    await waitFor(() => expect(client.getConversation).toHaveBeenCalled());

    const textarea = screen.getByLabelText(/ask a question/i);
    await user.type(textarea, 'line one');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(client.query).not.toHaveBeenCalled();
  });

  it('renders a refusal distinctly from an error, never as a failure', async () => {
    const refusal = makeQueryResponse({
      status: 'refused',
      answer: '',
      citations: [],
      refusal_reason: 'no_relevant_chunks',
    });
    const client = fakeApiClient({ query: vi.fn().mockResolvedValue(refusal) });
    const user = userEvent.setup();
    render(<AskTab apiClient={client} />);
    await waitFor(() => expect(client.getConversation).toHaveBeenCalled());

    const textarea = screen.getByLabelText(/ask a question/i);
    await user.type(textarea, 'Is there unblinded data available?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByTestId('refusal-card')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a distinct error banner (not a refusal) when the request fails, with a retry action', async () => {
    const client = fakeApiClient({
      query: vi.fn().mockRejectedValue(new ApiError('TrialPulse is having trouble responding right now.', 'server_error', 503)),
    });
    const user = userEvent.setup();
    render(<AskTab apiClient={client} />);
    await waitFor(() => expect(client.getConversation).toHaveBeenCalled());

    const textarea = screen.getByLabelText(/ask a question/i);
    await user.type(textarea, 'What is the status of AXIOM-HN01?');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/trouble responding/i);
    expect(screen.queryByTestId('refusal-card')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('enforces the character cap on the textarea and shows a live counter', async () => {
    const client = fakeApiClient();
    render(<AskTab apiClient={client} />);
    await waitFor(() => expect(client.getConversation).toHaveBeenCalled());

    const textarea = screen.getByLabelText(/ask a question/i) as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('maxLength', String(MAX_QUERY_LENGTH));

    fireEvent.change(textarea, { target: { value: 'a'.repeat(10) } });
    expect(screen.getByText(`10/${MAX_QUERY_LENGTH}`)).toBeInTheDocument();
  });

  it('paginates conversation history via "Load older questions"', async () => {
    const olderTurn = makeConversationTurn({ id: 'older-1', question: 'Older question' });
    const recentTurn = makeConversationTurn({ id: 'recent-1', question: 'Recent question' });
    const client = fakeApiClient({
      getConversation: vi
        .fn()
        .mockResolvedValueOnce({ turns: [recentTurn], continuation: 'cursor-1' })
        .mockResolvedValueOnce({ turns: [olderTurn], continuation: null }),
    });
    const user = userEvent.setup();
    render(<AskTab apiClient={client} />);

    const transcript = screen.getByLabelText('Conversation');
    expect(await within(transcript).findByText('Recent question')).toBeInTheDocument();
    const loadMoreButton = await screen.findByRole('button', { name: /load older questions/i });

    await user.click(loadMoreButton);

    expect(await within(transcript).findByText('Older question')).toBeInTheDocument();
    expect(client.getConversation).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ continuation: 'cursor-1' }),
    );
    // Once fully paginated, the button disappears.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /load older questions/i })).not.toBeInTheDocument(),
    );

    // Older turn renders before the recent turn in the transcript.
    const sidebar = screen.getByRole('navigation', { name: /conversation history/i });
    const buttons = within(sidebar).getAllByRole('button', { name: /question/i });
    expect(buttons[0]).toHaveTextContent('Older question');
    expect(buttons[1]).toHaveTextContent('Recent question');
  });
});

describe('AskTab conversation history pagination', () => {
  // Regression: handleLoadMore had try/finally with no catch, so a failing
  // request escaped as an unhandled promise rejection and the sidebar simply
  // stopped loading with no explanation for the user.
  it('surfaces an error when loading older questions fails, and keeps the control usable', async () => {
    const getConversation = vi
      .fn()
      .mockResolvedValueOnce({
        turns: [makeConversationTurn({ id: 't1', question: 'First question' })],
        continuation: 'cursor-1',
      })
      .mockRejectedValueOnce(new ApiError('Upstream failure', 'server_error', 500));

    const apiClient = fakeApiClient({ getConversation });
    const rejections: unknown[] = [];
    const onRejection = (event: PromiseRejectionEvent) => rejections.push(event.reason);
    window.addEventListener('unhandledrejection', onRejection);

    try {
      render(<AskTab apiClient={apiClient} />);

      const loadMore = await screen.findByRole('button', { name: /load older questions/i });
      await userEvent.click(loadMore);

      expect(await screen.findByText(/could not load older messages/i)).toBeInTheDocument();
      // The user can retry: the control must not be left disabled.
      expect(screen.getByRole('button', { name: /load older questions/i })).toBeEnabled();
      expect(rejections).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onRejection);
    }
  });
});
