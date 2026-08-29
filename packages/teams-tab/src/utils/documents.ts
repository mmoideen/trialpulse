/**
 * Browse-tab document filtering.
 *
 * Per the PRD, RBAC must be structural: a document whose classification is
 * outside the caller's role must never be rendered, not merely hidden with
 * CSS. `filterDocumentsForRole` is the single choke point every document
 * list passes through before it reaches a component, and it is driven
 * entirely by `ROLE_POLICIES` from the frozen shared contract -- there is no
 * parallel allow-list to fall out of sync.
 */
import { DOCUMENT_CLASSIFICATIONS, ROLE_POLICIES, type DocumentClassification, type DocumentStatus, type Role } from '@trialpulse/shared';

export function filterDocumentsForRole(documents: DocumentStatus[], role: Role): DocumentStatus[] {
  const allowed = new Set<DocumentClassification>(ROLE_POLICIES[role].allowedClassifications);
  return documents.filter((doc) => allowed.has(doc.document_classification));
}

export function matchesSearch(document: DocumentStatus, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    document.document_title.toLowerCase().includes(q) ||
    document.document_version.toLowerCase().includes(q)
  );
}

/**
 * Groups already-role-filtered documents by classification, preserving the
 * canonical classification order and including classifications the role is
 * allowed to see even when zero documents currently match (so the Browse tab
 * can render a per-classification empty state).
 */
export function groupByClassification(
  documents: DocumentStatus[],
  role: Role,
): Array<{ classification: DocumentClassification; documents: DocumentStatus[] }> {
  const allowedOrdered = DOCUMENT_CLASSIFICATIONS.filter((c) =>
    ROLE_POLICIES[role].allowedClassifications.includes(c),
  );
  return allowedOrdered.map((classification) => ({
    classification,
    documents: documents.filter((doc) => doc.document_classification === classification),
  }));
}
