import { useEffect, useRef, useState } from 'react';
import {
  CONVERSATION_PAGE_SIZE,
  CONVERSATION_TTL_SECONDS,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  type Citation,
  type ConversationTurn,
} from '@trialpulse/shared';
import { ApiClient, ApiError } from '../teams/api-client';
import { ConversationSidebar } from '../components/ConversationSidebar';
import { ConversationTurnItem } from '../components/ConversationTurnItem';
import { useConversationId } from '../hooks/useConversationId';
import styles from './AskTab.module.css';

export interface AskTabProps {
  apiClient: ApiClient;
  onShare?: (answer: string, citations: Citation[]) => void;
}

/**
 * Full-page chat (PRD 6.1). Conversation history is paginated at
 * `CONVERSATION_PAGE_SIZE` (PRD section 9: keep Cosmos DB read costs low).
 *
 * `QueryResponse` does not echo a `conversation_id` back, so this component
 * mints and persists one client-side (see useConversationId) and sends it on
 * every request; the orchestrator groups turns by that id.
 *
 * We assume `GET /api/conversations/:id` returns the newest page first
 * (matching how the sidebar's "load older" pagination is meant to work per
 * PRD section 9) and reverse it for the oldest-first chat transcript.
 */
export function AskTab({ apiClient, onShare }: AskTabProps) {
  const conversationId = useConversationId();
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [redactionNotices, setRedactionNotices] = useState<Record<string, string | null>>({});
  const [continuation, setContinuation] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .getConversation(conversationId, { limit: CONVERSATION_PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setTurns([...page.turns].reverse());
        setContinuation(page.continuation);
      })
      .catch(() => {
        // Fail open to an empty transcript: a broken history load should
        // never block a user from asking a fresh question.
      })
      .finally(() => {
        if (!cancelled) setHistoryLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, conversationId]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, submitting]);

  async function handleLoadMore() {
    if (!continuation || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(false);
    try {
      const page = await apiClient.getConversation(conversationId, {
        limit: CONVERSATION_PAGE_SIZE,
        continuation,
      });
      setTurns((prev) => [...[...page.turns].reverse(), ...prev]);
      setContinuation(page.continuation);
    } catch {
      // Without this catch the rejection escapes as an unhandled promise and
      // the sidebar just stops loading with no explanation. Older history
      // failing to load is recoverable, so surface it and keep the button
      // available rather than tearing down the tab.
      setLoadMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }

  function handleSelectTurn(turnId: string) {
    document.getElementById(`turn-${turnId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function handleFeedback(turnId: string, feedback: 'up' | 'down') {
    await apiClient.submitFeedback(turnId, feedback);
    setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, feedback } : t)));
  }

  const trimmedQuestion = inputValue.trim();
  const overLimit = inputValue.length > MAX_QUERY_LENGTH;
  const tooShort = trimmedQuestion.length > 0 && trimmedQuestion.length < MIN_QUERY_LENGTH;
  const canSubmit = trimmedQuestion.length >= MIN_QUERY_LENGTH && !overLimit && !submitting;

  async function submitQuestion(question: string) {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await apiClient.query({ query: question, conversation_id: conversationId });
      const turn: ConversationTurn = {
        id: response.trace_id,
        conversation_id: conversationId,
        // Not surfaced by QueryResponse; irrelevant to rendering this turn locally.
        user_principal_name: '',
        role: response.role,
        question,
        answer: response.answer,
        citations: response.citations,
        status: response.status,
        timestamp: new Date().toISOString(),
        feedback: null,
        ttl: CONVERSATION_TTL_SECONDS,
      };
      setTurns((prev) => [...prev, turn]);
      setRedactionNotices((prev) => ({ ...prev, [turn.id]: response.redaction_notice }));
      setInputValue('');
    } catch (err) {
      setSubmitError(
        err instanceof ApiError ? err : new ApiError('Something went wrong. Please try again.', 'unknown'),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (canSubmit) void submitQuestion(trimmedQuestion);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSubmit) void submitQuestion(trimmedQuestion);
    }
  }

  return (
    <div className={styles.layout}>
      <ConversationSidebar
        turns={turns}
        hasMore={continuation !== null}
        loadingMore={loadingMore}
        loadMoreError={loadMoreError}
        onSelectTurn={handleSelectTurn}
        onLoadMore={() => {
          void handleLoadMore();
        }}
      />
      <div className={styles.main}>
        <h2 className="tp-visually-hidden">Ask TrialPulse a question</h2>

        <div
          ref={transcriptRef}
          className={styles.transcript}
          aria-live="polite"
          aria-atomic="false"
          aria-label="Conversation"
        >
          {!historyLoaded ? (
            <p className={styles.emptyTranscript}>Loading conversation&hellip;</p>
          ) : turns.length === 0 ? (
            <p className={styles.emptyTranscript}>
              Ask a question about a Meridian clinical document to get started.
            </p>
          ) : (
            turns.map((turn) => (
              <div id={`turn-${turn.id}`} key={turn.id}>
                <ConversationTurnItem
                  turn={turn}
                  redactionNotice={redactionNotices[turn.id] ?? null}
                  onFeedback={handleFeedback}
                  onShare={onShare}
                />
              </div>
            ))
          )}
          {submitting ? (
            <p className={styles.pendingIndicator} role="status">
              Thinking&hellip;
            </p>
          ) : null}
        </div>

        {submitError ? (
          <div className={styles.errorBanner} role="alert">
            <span>{submitError.message}</span>
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => void submitQuestion(trimmedQuestion)}
            >
              Retry
            </button>
          </div>
        ) : null}

        <form className={styles.composer} onSubmit={handleSubmit}>
          <label htmlFor="ask-input" className="tp-visually-hidden">
            Ask a question
          </label>
          <div className={styles.composerRow}>
            <textarea
              id="ask-input"
              className={styles.textarea}
              value={inputValue}
              maxLength={MAX_QUERY_LENGTH}
              placeholder="Ask about a protocol, safety report, regulatory submission…"
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={submitting}
              aria-describedby="ask-input-hint ask-input-counter"
            />
            <button type="submit" className={styles.submitButton} disabled={!canSubmit}>
              {submitting ? 'Sending…' : 'Send'}
            </button>
          </div>
          <div className={styles.metaRow}>
            <span id="ask-input-hint">
              {tooShort ? `Enter at least ${MIN_QUERY_LENGTH} characters.` : 'Shift+Enter for a new line'}
            </span>
            <span id="ask-input-counter" className={overLimit ? styles.counterOverLimit : undefined}>
              {inputValue.length}/{MAX_QUERY_LENGTH}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}
