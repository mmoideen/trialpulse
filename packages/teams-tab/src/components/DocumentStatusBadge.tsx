import { useId } from 'react';
import type { IngestionStatus } from '@trialpulse/shared';
import { INGESTION_STATUS_LABELS } from '../utils/labels';
import styles from './DocumentStatusBadge.module.css';

export interface DocumentStatusBadgeProps {
  status: IngestionStatus;
  lastIngestedAt: string | null;
  chunkCount: number;
}

// CSS module classes are typed via an index signature, so with
// noUncheckedIndexedAccess each lookup is `string | undefined`. The `!` here
// is safe: these four class names are authored directly in
// DocumentStatusBadge.module.css and never change independently of this file.
const STATUS_CLASS: Record<IngestionStatus, string> = {
  pending: styles.pending!,
  indexed: styles.indexed!,
  failed: styles.failed!,
  outdated: styles.outdated!,
};

/** Colour + icon + text glyph per status so the signal never rests on colour alone (WCAG 1.4.1). */
function StatusIcon({ status }: { status: IngestionStatus }) {
  const common = { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': true, focusable: false } as const;
  switch (status) {
    case 'indexed':
      return (
        <svg {...common} className={styles.icon}>
          <path fill="currentColor" d="M4.7 9.1 1.6 6l1-1 2.1 2.1L9.4 2.4l1 1-5.7 5.7Z" />
        </svg>
      );
    case 'failed':
      return (
        <svg {...common} className={styles.icon}>
          <path
            fill="currentColor"
            d="M2.4 2.4 6 6l3.6-3.6 1 1L7 7l3.6 3.6-1 1L6 8l-3.6 3.6-1-1L5 7 1.4 3.4Z"
          />
        </svg>
      );
    case 'outdated':
      return (
        <svg {...common} className={styles.icon}>
          <path fill="currentColor" d="M6 1a5 5 0 1 0 0 10A5 5 0 0 0 6 1Zm.6 2.4v2.9l2.2 1.3-.4.7-2.8-1.7V3.4h1Z" />
        </svg>
      );
    case 'pending':
    default:
      return (
        <svg {...common} className={styles.icon}>
          <circle cx="6" cy="6" r="3.6" fill="currentColor" />
        </svg>
      );
  }
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** Ingestion status badge: Pending / Indexed / Failed / Outdated, gray / green / red / yellow. */
export function DocumentStatusBadge({ status, lastIngestedAt, chunkCount }: DocumentStatusBadgeProps) {
  const tooltipId = useId();
  const label = INGESTION_STATUS_LABELS[status];

  return (
    <span className={styles.wrapper}>
      <span
        className={`${styles.badge} ${STATUS_CLASS[status]}`}
        tabIndex={0}
        aria-describedby={tooltipId}
      >
        <StatusIcon status={status} />
        {label}
      </span>
      <span role="tooltip" id={tooltipId} className={styles.tooltip}>
        Last ingested: {formatTimestamp(lastIngestedAt)}
        <br />
        Chunks: {chunkCount}
      </span>
    </span>
  );
}
