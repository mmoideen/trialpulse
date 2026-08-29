import type { DocumentStatus } from '@trialpulse/shared';
import { isChunkAuthorized, ROLES } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { handleGetDocument, handleListDocuments } from './documents';
import { buildTestDeps, devHeaders } from './test-support';

function status(overrides: Partial<DocumentStatus> = {}): DocumentStatus {
  return {
    document_id: 'sp-ci-0001',
    document_title: 'HNSCC Competitive Landscape Q2 2026',
    document_classification: 'competitive_intelligence',
    document_version: '1.0',
    status: 'indexed',
    chunk_count: 2,
    last_ingested_at: '2026-01-01T00:00:00Z',
    error_message: null,
    source_url: 'https://example.com/doc',
    ...overrides,
  };
}

describe('GET /api/documents/{id}', () => {
  it('returns the document for an authorised role', async () => {
    const { deps } = buildTestDeps();
    await deps.documentMetadata.upsert(status());
    const result = await handleGetDocument(deps, devHeaders('medical_affairs'), 'sp-ci-0001');
    expect(result.status).toBe(200);
    expect((result.jsonBody as DocumentStatus).document_id).toBe('sp-ci-0001');
  });

  it('returns 404 (never 403) when the caller is authenticated but not authorised for the classification', async () => {
    const { deps } = buildTestDeps();
    await deps.documentMetadata.upsert(status()); // competitive_intelligence
    // clinical_operations may see every classification except competitive_intelligence.
    const result = await handleGetDocument(deps, devHeaders('clinical_operations'), 'sp-ci-0001');
    expect(result.status).toBe(404);
  });

  it('returns 404 for a document that does not exist at all', async () => {
    const { deps } = buildTestDeps();
    const result = await handleGetDocument(deps, devHeaders('regulatory_affairs'), 'does-not-exist');
    expect(result.status).toBe(404);
  });

  it('returns the same 404 shape for "does not exist" and "not authorised", so existence cannot be probed', async () => {
    const { deps } = buildTestDeps();
    await deps.documentMetadata.upsert(status());
    const unauthorised = await handleGetDocument(deps, devHeaders('site_monitor'), 'sp-ci-0001');
    const nonExistent = await handleGetDocument(deps, devHeaders('site_monitor'), 'totally-unknown-id');
    expect(unauthorised.status).toBe(404);
    expect(nonExistent.status).toBe(404);
    expect((unauthorised.jsonBody as { error: string }).error).toBe((nonExistent.jsonBody as { error: string }).error);
  });

  it('returns 404 for a malformed document id rather than a 400 (no existence signal via validation errors)', async () => {
    const { deps } = buildTestDeps();
    const result = await handleGetDocument(deps, devHeaders('regulatory_affairs'), 'bad id with spaces');
    expect(result.status).toBe(404);
  });

  it('rejects an unauthenticated caller with 401, not 404', async () => {
    const { deps } = buildTestDeps({ config: { authMode: 'production' } });
    const result = await handleGetDocument(deps, {}, 'sp-ci-0001');
    expect(result.status).toBe(401);
  });
});

describe('GET /api/documents (list)', () => {
  async function seedOnePerClassification(deps: ReturnType<typeof buildTestDeps>['deps']) {
    const classifications = [
      'protocol',
      'investigator_brochure',
      'regulatory_submission',
      'safety_report',
      'site_communication',
      'competitive_intelligence',
    ] as const;
    for (const c of classifications) {
      await deps.documentMetadata.upsert(
        status({ document_id: `doc-${c}`, document_classification: c }),
      );
    }
  }

  it('requires authentication', async () => {
    const { deps } = buildTestDeps();
    const result = await handleListDocuments(deps, {});
    expect(result.status).toBe(401);
  });

  it('returns every classification for an unrestricted role', async () => {
    const { deps } = buildTestDeps();
    await seedOnePerClassification(deps);
    const result = await handleListDocuments(deps, devHeaders('regulatory_affairs'));
    expect(result.status).toBe(200);
    expect(result.jsonBody as DocumentStatus[]).toHaveLength(6);
  });

  it('omits out-of-scope documents entirely rather than flagging them', async () => {
    const { deps } = buildTestDeps();
    await seedOnePerClassification(deps);
    const result = await handleListDocuments(deps, devHeaders('site_monitor'));
    const docs = result.jsonBody as DocumentStatus[];
    expect(docs).toHaveLength(1);
    expect(docs[0]!.document_classification).toBe('site_communication');
  });

  it('excludes competitive intelligence from clinical operations', async () => {
    const { deps } = buildTestDeps();
    await seedOnePerClassification(deps);
    const result = await handleListDocuments(deps, devHeaders('clinical_operations'));
    const docs = result.jsonBody as DocumentStatus[];
    expect(docs).toHaveLength(5);
    expect(docs.map((d) => d.document_classification)).not.toContain('competitive_intelligence');
  });

  it('never returns a document outside the role allow-list, for every role', async () => {
    for (const role of ROLES) {
      const { deps } = buildTestDeps();
      await seedOnePerClassification(deps);
      const result = await handleListDocuments(deps, devHeaders(role));
      for (const doc of result.jsonBody as DocumentStatus[]) {
        expect(
          isChunkAuthorized(role, doc.document_classification),
          `${role} received ${doc.document_classification}`,
        ).toBe(true);
      }
    }
  });
});

describe('D2: site-level scoping for /api/documents and /api/documents/{id}', () => {
  async function seedSiteCommunications(deps: ReturnType<typeof buildTestDeps>['deps']) {
    await deps.documentMetadata.upsert(
      status({
        document_id: 'site-us-014',
        document_title: 'Site US-014 Monitoring Visit Follow-up Letter',
        document_classification: 'site_communication',
        source_url: 'https://meridiantx.sharepoint.com/sites/trials/site-us-014-monitoring-visit-followup.docx',
      }),
    );
    await deps.documentMetadata.upsert(
      status({
        document_id: 'site-us-027',
        document_title: 'Site US-027 Protocol Deviation Notice',
        document_classification: 'site_communication',
        source_url: 'https://meridiantx.sharepoint.com/sites/trials/site-us-027-protocol-deviation-notice.docx',
      }),
    );
    await deps.documentMetadata.upsert(
      status({
        document_id: 'newsletter',
        document_title: 'AXIOM Investigator Newsletter June 2026',
        document_classification: 'site_communication',
        source_url: 'https://meridiantx.sharepoint.com/sites/trials/investigator-newsletter-june-2026.docx',
      }),
    );
  }

  it('GET /api/documents/{id}: a site monitor assigned only to US-014 gets 404 for a US-027 document, never the full record', async () => {
    const { deps } = buildTestDeps();
    await seedSiteCommunications(deps);
    const result = await handleGetDocument(
      deps,
      devHeaders('site_monitor', { sites: ['US-014'] }),
      'site-us-027',
    );
    expect(result.status).toBe(404);
  });

  it('GET /api/documents/{id}: a site monitor assigned to US-014 can still fetch their own site\'s document', async () => {
    const { deps } = buildTestDeps();
    await seedSiteCommunications(deps);
    const result = await handleGetDocument(
      deps,
      devHeaders('site_monitor', { sites: ['US-014'] }),
      'site-us-014',
    );
    expect(result.status).toBe(200);
    expect((result.jsonBody as DocumentStatus).document_id).toBe('site-us-014');
  });

  it('GET /api/documents/{id}: a role without maskUnassignedSites (e.g. regulatory_affairs) is never site-scoped', async () => {
    const { deps } = buildTestDeps();
    await seedSiteCommunications(deps);
    const result = await handleGetDocument(deps, devHeaders('regulatory_affairs', { sites: [] }), 'site-us-027');
    expect(result.status).toBe(200);
  });

  it('GET /api/documents (list): omits every site_communication document outside the caller\'s assigned sites', async () => {
    const { deps } = buildTestDeps();
    await seedSiteCommunications(deps);
    const result = await handleListDocuments(deps, devHeaders('site_monitor', { sites: ['US-014'] }));
    const docs = result.jsonBody as DocumentStatus[];
    const ids = docs.map((d) => d.document_id);
    expect(ids).toContain('site-us-014');
    expect(ids).not.toContain('site-us-027');
  });

  it('GET /api/documents (list): never excludes a cross-site document with no single-site title', async () => {
    const { deps } = buildTestDeps();
    await seedSiteCommunications(deps);
    const result = await handleListDocuments(deps, devHeaders('site_monitor', { sites: ['US-014'] }));
    const ids = (result.jsonBody as DocumentStatus[]).map((d) => d.document_id);
    expect(ids).toContain('newsletter');
  });

  it('GET /api/documents (list): a role without maskUnassignedSites sees every site\'s documents', async () => {
    const { deps } = buildTestDeps();
    await seedSiteCommunications(deps);
    const result = await handleListDocuments(deps, devHeaders('regulatory_affairs', { sites: [] }));
    const ids = (result.jsonBody as DocumentStatus[]).map((d) => d.document_id);
    expect(ids).toEqual(expect.arrayContaining(['site-us-014', 'site-us-027', 'newsletter']));
  });

  it('covers every role: only site_monitor is ever site-scoped, every other role sees every site (D2)', async () => {
    for (const role of ROLES) {
      const { deps } = buildTestDeps();
      await seedSiteCommunications(deps);
      const result = await handleListDocuments(deps, devHeaders(role, { sites: ['US-014'] }));
      const ids = (result.jsonBody as DocumentStatus[]).map((d) => d.document_id);
      if (role === 'site_monitor') {
        expect(ids).not.toContain('site-us-027');
      } else if (ids.length > 0) {
        // clinical_operations/regulatory_affairs (the only other roles with
        // site_communication access) must see every site, not just their own.
        expect(ids).toContain('site-us-027');
      }
    }
  });
});
