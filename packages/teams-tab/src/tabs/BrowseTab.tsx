import { useEffect, useState } from 'react';
import type { DocumentStatus, Role } from '@trialpulse/shared';
import type { ApiClient } from '../teams/api-client';
import { DocumentStatusBadge } from '../components/DocumentStatusBadge';
import { classificationLabel } from '../utils/labels';
import { filterDocumentsForRole, groupByClassification, matchesSearch } from '../utils/documents';
import styles from './BrowseTab.module.css';

export interface BrowseTabProps {
  apiClient: ApiClient;
  role: Role;
}

type LoadStatus = 'loading' | 'error' | 'success';

/**
 * Document library explorer (PRD 6.1), filtered to the caller's role.
 *
 * Filtering is structural, not visual: `filterDocumentsForRole` (driven by
 * `ROLE_POLICIES` from the frozen shared contract) runs before anything is
 * grouped or rendered, so a document outside the caller's allow-list is
 * absent from the React tree entirely -- it is never rendered greyed out or
 * hidden with CSS.
 */
export function BrowseTab({ apiClient, role }: BrowseTabProps) {
  const [documents, setDocuments] = useState<DocumentStatus[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    apiClient
      .listDocuments()
      .then((docs) => {
        if (cancelled) return;
        setDocuments(docs);
        setStatus('success');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const roleScoped = filterDocumentsForRole(documents, role);
  const searchScoped = roleScoped.filter((doc) => matchesSearch(doc, search));
  const groups = groupByClassification(searchScoped, role);

  return (
    <div className={styles.container}>
      <h2 className="tp-visually-hidden">Browse documents</h2>

      <div className={styles.searchRow}>
        <label htmlFor="browse-search">Filter documents</label>
        <input
          id="browse-search"
          type="search"
          className={styles.searchInput}
          placeholder="Search by title or version…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {status === 'loading' ? (
        <p className={styles.state} role="status" aria-live="polite">
          Loading documents&hellip;
        </p>
      ) : status === 'error' ? (
        <p className={styles.errorState} role="alert">
          Couldn't load documents. Try refreshing the tab.
        </p>
      ) : (
        groups.map(({ classification, documents: docsInGroup }) => (
          <section
            key={classification}
            className={styles.classificationSection}
            aria-labelledby={`classification-${classification}`}
          >
            <h3 id={`classification-${classification}`} className={styles.classificationTitle}>
              {classificationLabel(classification)}
            </h3>
            {docsInGroup.length === 0 ? (
              <p className={styles.emptyState}>
                {search
                  ? `No ${classificationLabel(classification).toLowerCase()} match "${search}".`
                  : `No ${classificationLabel(classification).toLowerCase()} available yet.`}
              </p>
            ) : (
              <ul className={styles.documentList}>
                {docsInGroup.map((doc) => (
                  <li key={doc.document_id} className={styles.documentRow}>
                    <div className={styles.documentInfo}>
                      <span className={styles.documentTitle}>
                        <a href={doc.source_url} target="_blank" rel="noopener noreferrer">
                          {doc.document_title}
                        </a>
                      </span>
                      <span className={styles.documentMeta}>
                        v{doc.document_version}
                        {doc.error_message ? ` · ${doc.error_message}` : ''}
                      </span>
                    </div>
                    <DocumentStatusBadge
                      status={doc.status}
                      lastIngestedAt={doc.last_ingested_at}
                      chunkCount={doc.chunk_count}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))
      )}
    </div>
  );
}
