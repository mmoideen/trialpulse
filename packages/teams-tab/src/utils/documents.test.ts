import { describe, expect, it } from 'vitest';
import { DOCUMENT_CLASSIFICATIONS, ROLES, ROLE_POLICIES, type DocumentClassification } from '@trialpulse/shared';
import { filterDocumentsForRole, groupByClassification, matchesSearch } from './documents';
import { makeDocumentStatus } from '../test/fixtures';

// One document per classification, so every role's allow-list is exercised.
const ALL_DOCS = DOCUMENT_CLASSIFICATIONS.map((classification) =>
  makeDocumentStatus({
    document_id: `doc-${classification}`,
    document_title: `${classification} doc`,
    document_classification: classification,
  }),
);

describe('filterDocumentsForRole', () => {
  it.each(ROLES)('returns exactly the classifications ROLE_POLICIES allows for "%s"', (role) => {
    const allowed = new Set<DocumentClassification>(ROLE_POLICIES[role].allowedClassifications);
    const result = filterDocumentsForRole(ALL_DOCS, role);

    expect(result).toHaveLength(allowed.size);
    for (const doc of result) {
      expect(allowed.has(doc.document_classification)).toBe(true);
    }
    // Every disallowed classification must be completely absent.
    for (const classification of DOCUMENT_CLASSIFICATIONS) {
      if (!allowed.has(classification)) {
        expect(result.some((d) => d.document_classification === classification)).toBe(false);
      }
    }
  });
});

describe('groupByClassification', () => {
  it.each(ROLES)('only produces groups for classifications allowed to "%s"', (role) => {
    const filtered = filterDocumentsForRole(ALL_DOCS, role);
    const groups = groupByClassification(filtered, role);
    const groupClassifications = groups.map((g) => g.classification);

    expect(new Set(groupClassifications)).toEqual(new Set(ROLE_POLICIES[role].allowedClassifications));
  });

  it('includes an empty group (for an empty-state message) when a classification has no matching documents', () => {
    const groups = groupByClassification([], 'regulatory_affairs');
    expect(groups.every((g) => g.documents.length === 0)).toBe(true);
    expect(groups.length).toBe(ROLE_POLICIES.regulatory_affairs.allowedClassifications.length);
  });
});

describe('matchesSearch', () => {
  it('matches on title or version, case-insensitively', () => {
    const doc = makeDocumentStatus({ document_title: 'Investigator Brochure', document_version: '2.1' });
    expect(matchesSearch(doc, 'investigator')).toBe(true);
    expect(matchesSearch(doc, 'BROCHURE')).toBe(true);
    expect(matchesSearch(doc, '2.1')).toBe(true);
    expect(matchesSearch(doc, 'unrelated')).toBe(false);
  });

  it('matches everything when the query is empty', () => {
    const doc = makeDocumentStatus();
    expect(matchesSearch(doc, '')).toBe(true);
    expect(matchesSearch(doc, '   ')).toBe(true);
  });
});
