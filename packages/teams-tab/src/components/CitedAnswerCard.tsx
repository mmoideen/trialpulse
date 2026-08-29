import { useState } from 'react';
import type { Citation } from '@trialpulse/shared';
import { splitAnswerIntoSegments } from '../utils/answer-segments';
import { RedactionNotice } from './RedactionNotice';
import styles from './CitedAnswerCard.module.css';

export interface CitedAnswerCardProps {
  answer: string;
  citations: Citation[];
  redactionNotice?: string | null;
  onShare?: (answer: string, citations: Citation[]) => void;
}

/**
 * Renders a generated answer with inline citation pills and a citation list.
 *
 * The answer arrives as plain text from the model. It is rendered exclusively
 * as React text nodes -- split into segments by `splitAnswerIntoSegments` --
 * so any markup-looking substring (a stray `<script>` tag, an `onerror`
 * attribute, etc.) is displayed verbatim as inert text rather than parsed.
 */
export function CitedAnswerCard({ answer, citations, redactionNotice, onShare }: CitedAnswerCardProps) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const segments = splitAnswerIntoSegments(answer, citations);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(answer);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('failed');
    } finally {
      setTimeout(() => setCopyStatus('idle'), 3000);
    }
  }

  return (
    <article className={styles.card} data-testid="cited-answer-card">
      {redactionNotice ? <RedactionNotice message={redactionNotice} /> : null}
      <p className={styles.answer}>
        {segments.map((segment, i) =>
          segment.kind === 'citation' ? (
            // D1: `source_url: null` means the redaction pipeline suppressed
            // this citation's source (e.g. a site_communication chunk
            // outside the caller's assigned sites) -- never render a link,
            // clickable or otherwise, for it.
            segment.citation.source_url !== null ? (
              <a
                key={`${segment.citation.chunk_id}-${i}`}
                className={styles.citationPill}
                href={segment.citation.source_url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Citation ${segment.citation.index}: ${segment.citation.document_title}, page ${segment.citation.page_number}`}
              >
                {segment.text}
              </a>
            ) : (
              <span
                key={`${segment.citation.chunk_id}-${i}`}
                className={styles.citationPill}
                aria-label={`Citation ${segment.citation.index}: source restricted`}
              >
                {segment.text}
              </span>
            )
          ) : (
            <span key={i}>{segment.text}</span>
          ),
        )}
      </p>

      {citations.length > 0 ? (
        <ol className={styles.citationList} aria-label="Sources">
          {citations.map((citation) => (
            <li key={citation.chunk_id} className={styles.citationItem}>
              <span className={styles.citationIndex} aria-hidden="true">
                [{citation.index}]
              </span>
              <span>
                {citation.source_url !== null ? (
                  <a
                    className={styles.citationLink}
                    href={citation.source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {citation.document_title}
                  </a>
                ) : (
                  <span className={styles.citationLink}>{citation.document_title} (source restricted)</span>
                )}
                <span className={styles.citationMeta}>
                  {' '}
                  &middot; v{citation.document_version} &middot; {citation.heading_path} &middot; p.
                  {citation.page_number}
                </span>
              </span>
            </li>
          ))}
        </ol>
      ) : null}

      <div className={styles.actions}>
        <button type="button" className={styles.actionButton} onClick={() => {
            void handleCopy();
          }}
        >
          Copy to clipboard
        </button>
        <button
          type="button"
          className={styles.actionButton}
          onClick={() => onShare?.(answer, citations)}
        >
          Share in channel
        </button>
        {copyStatus !== 'idle' ? (
          <span className={styles.copyStatus} role="status">
            {copyStatus === 'copied' ? 'Copied.' : 'Copy failed.'}
          </span>
        ) : null}
      </div>
    </article>
  );
}
