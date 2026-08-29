import type { RefusalReason } from '@trialpulse/shared';
import { REFUSAL_REASON_LABELS } from '../utils/labels';
import styles from './RefusalCard.module.css';

export interface RefusalCardProps {
  reason: RefusalReason | null;
}

/**
 * Renders a structured refusal (PRD decision 3: refuse rather than
 * hallucinate). This is a calm, informational card -- not a red error banner
 * -- because a refusal is TrialPulse working correctly, not failing. It must
 * never be visually confused with a genuine request failure (see the
 * error-state styling in AskTab, which is deliberately distinct).
 */
export function RefusalCard({ reason }: RefusalCardProps) {
  const body = reason
    ? REFUSAL_REASON_LABELS[reason]
    : "TrialPulse couldn't find information about this in the documents you're authorized to access.";

  return (
    <div className={styles.card} data-testid="refusal-card" role="status">
      <svg className={styles.icon} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M10 1.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm-.9 4.6h1.8v6.1H9.1V6.1Zm.9 8.9a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"
        />
      </svg>
      <div>
        <p className={styles.title}>No answer available</p>
        <p className={styles.body}>{body}</p>
        <p className={styles.hint}>
          Try rephrasing your question, or confirm the document you expect exists within your role's
          access scope.
        </p>
      </div>
    </div>
  );
}
