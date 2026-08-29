import { useState } from 'react';
import type { ConversationTurn } from '@trialpulse/shared';
import { CitedAnswerCard } from './CitedAnswerCard';
import { RefusalCard } from './RefusalCard';
import styles from './ConversationTurnItem.module.css';

export interface ConversationTurnItemProps {
  turn: ConversationTurn;
  redactionNotice?: string | null;
  onFeedback: (turnId: string, feedback: 'up' | 'down') => Promise<void>;
  onShare?: (answer: string, citations: ConversationTurn['citations']) => void;
}

/** One question + answer (or refusal) pair in the Ask tab transcript. */
export function ConversationTurnItem({
  turn,
  redactionNotice,
  onFeedback,
  onShare,
}: ConversationTurnItemProps) {
  const [pending, setPending] = useState(false);
  const [feedbackError, setFeedbackError] = useState(false);

  async function handleFeedback(value: 'up' | 'down') {
    setPending(true);
    setFeedbackError(false);
    try {
      await onFeedback(turn.id, value);
    } catch {
      setFeedbackError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.turn}>
      <p className={styles.question}>{turn.question}</p>
      <div className={styles.answerWrap}>
        {turn.status === 'refused' ? (
          <RefusalCard reason={null} />
        ) : (
          <CitedAnswerCard answer={turn.answer} citations={turn.citations} redactionNotice={redactionNotice} onShare={onShare} />
        )}
        <div className={styles.feedback}>
          <span id={`feedback-label-${turn.id}`}>Was this helpful?</span>
          <button
            type="button"
            className={styles.feedbackButton}
            aria-pressed={turn.feedback === 'up'}
            aria-labelledby={`feedback-label-${turn.id}`}
            aria-label="Thumbs up"
            disabled={pending}
            onClick={() => {
              void handleFeedback('up');
            }}
          >
            👍
          </button>
          <button
            type="button"
            className={styles.feedbackButton}
            aria-pressed={turn.feedback === 'down'}
            aria-labelledby={`feedback-label-${turn.id}`}
            aria-label="Thumbs down"
            disabled={pending}
            onClick={() => {
              void handleFeedback('down');
            }}
          >
            👎
          </button>
          {feedbackError ? <span role="alert">Couldn't save feedback.</span> : null}
        </div>
      </div>
    </div>
  );
}
