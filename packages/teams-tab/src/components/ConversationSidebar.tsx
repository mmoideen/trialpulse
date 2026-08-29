import type { ConversationTurn } from '@trialpulse/shared';
import styles from './ConversationSidebar.module.css';

export interface ConversationSidebarProps {
  turns: ConversationTurn[];
  hasMore: boolean;
  loadingMore: boolean;
  onSelectTurn: (turnId: string) => void;
  onLoadMore: () => void;
  /** True when the last "load older" attempt failed; the button stays usable. */
  loadMoreError?: boolean;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Conversation history sidebar for the Ask tab (PRD 6.1). Loads turns
 * `CONVERSATION_PAGE_SIZE` at a time via the "Load older" button, keeping
 * Cosmos DB read costs low per PRD section 9.
 */
export function ConversationSidebar({
  turns,
  hasMore,
  loadingMore,
  onSelectTurn,
  onLoadMore,
  loadMoreError = false,
}: ConversationSidebarProps) {
  return (
    <nav className={styles.sidebar} aria-label="Conversation history">
      <h2 className={styles.heading}>History</h2>
      {turns.length === 0 ? (
        <p className={styles.empty}>No previous questions yet.</p>
      ) : (
        <ul className={styles.list}>
          {turns.map((turn) => (
            <li key={turn.id}>
              <button
                type="button"
                className={styles.turnButton}
                onClick={() => onSelectTurn(turn.id)}
              >
                <span className={styles.turnQuestion}>{turn.question}</span>
                <span className={styles.turnTimestamp}>{formatTimestamp(turn.timestamp)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {hasMore ? (
        <>
          {loadMoreError ? (
            <p className={styles.loadMoreError} role="status">
              Could not load older messages. Try again.
            </p>
          ) : null}
          <button type="button" className={styles.loadMore} onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older questions'}
          </button>
        </>
      ) : null}
    </nav>
  );
}
