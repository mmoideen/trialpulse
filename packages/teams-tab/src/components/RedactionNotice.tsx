import styles from './RedactionNotice.module.css';

export interface RedactionNoticeProps {
  message: string | null | undefined;
}

/** Surfaces `QueryResponse.redaction_notice` when a role's redaction policy altered the answer. */
export function RedactionNotice({ message }: RedactionNoticeProps) {
  if (!message) return null;
  return (
    <div className={styles.notice} role="note">
      <svg className={styles.icon} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          fill="currentColor"
          d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 3.5a.85.85 0 1 1 0 1.7.85.85 0 0 1 0-1.7ZM7.25 7h1.5v5h-1.5V7Z"
        />
      </svg>
      <span>{message}</span>
    </div>
  );
}
