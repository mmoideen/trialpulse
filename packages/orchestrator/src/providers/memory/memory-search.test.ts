import { buildSearchFilter, RELEVANCE_THRESHOLD, type Chunk } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { embedDeterministic } from './memory-embeddings';
import { computeRelevanceScore, MemorySearchProvider, parseClassificationFilter } from './memory-search';

function chunk(overrides: Partial<Chunk>): Chunk {
  return {
    chunk_id: 'c1',
    document_id: 'd1',
    document_title: 'Doc',
    document_classification: 'protocol',
    document_version: '1.0',
    content: '',
    content_hash: 'h',
    heading_path: 'Heading',
    page_number: 1,
    source_url: 'https://example.com',
    ingested_at: '2026-01-01T00:00:00Z',
    site_code: null,
    previous_version_hash: null,
    ...overrides,
  };
}

describe('parseClassificationFilter', () => {
  it('returns null (unrestricted) for a null filter', () => {
    expect(parseClassificationFilter(null)).toBeNull();
  });

  it('parses a single-clause filter', () => {
    expect(parseClassificationFilter("document_classification eq 'protocol'")).toEqual(['protocol']);
  });

  it('parses a parenthesised multi-clause filter', () => {
    expect(
      parseClassificationFilter(
        "(document_classification eq 'protocol' or document_classification eq 'safety_report')",
      ),
    ).toEqual(['protocol', 'safety_report']);
  });

  it('parses the exact filters buildSearchFilter() produces for every restricted role', () => {
    for (const role of ['clinical_operations', 'medical_affairs', 'site_monitor'] as const) {
      const filter = buildSearchFilter(role);
      expect(() => parseClassificationFilter(filter)).not.toThrow();
    }
  });

  it('RBAC filter construction: parses buildSearchFilter(role) into exactly that role\'s allow-list, for every role', async () => {
    const { ROLES, getRolePolicy } = await import('@trialpulse/shared');
    for (const role of ROLES) {
      const policy = getRolePolicy(role);
      const filter = buildSearchFilter(role);
      const parsed = parseClassificationFilter(filter);
      if (policy.unrestricted) {
        expect(filter).toBeNull();
        expect(parsed).toBeNull();
      } else {
        expect(parsed?.slice().sort()).toEqual([...policy.allowedClassifications].sort());
      }
    }
  });

  it('returns an empty allow-list for the defensive "match nothing" expression', () => {
    expect(
      parseClassificationFilter('document_classification eq null and document_classification ne null'),
    ).toEqual([]);
  });

  it('throws on an unsupported filter shape rather than silently ignoring it', () => {
    expect(() => parseClassificationFilter("document_classification ne 'protocol'")).toThrow(/unsupported/i);
  });

  it('throws on an attempted injection through the filter string', () => {
    expect(() =>
      parseClassificationFilter("document_classification eq 'protocol' or 1 eq 1"),
    ).toThrow(/unsupported/i);
  });

  it('throws on an unknown classification value', () => {
    expect(() => parseClassificationFilter("document_classification eq 'not_a_real_class'")).toThrow(/unknown/i);
  });

  it('throws on an empty string filter', () => {
    expect(() => parseClassificationFilter('')).toThrow(/unsupported/i);
  });
});

describe('computeRelevanceScore calibration (real synthetic-corpus text)', () => {
  const protocolDesign = chunk({
    document_title: 'AXIOM-HN01 Protocol v3.0',
    document_classification: 'protocol',
    heading_path: '1. Study Design',
    content:
      'AXIOM-HN01 is a randomized, double-blind, placebo-controlled Phase 3 study. Planned enrollment is ' +
      '480 participants across 92 sites. Participants are randomized 1:1 to revarafusp alfa plus ' +
      'torilizumab or placebo plus torilizumab.',
  });
  const protocolEndpoint = chunk({
    document_title: 'AXIOM-HN01 Protocol v3.0',
    document_classification: 'protocol',
    heading_path: '2. Primary Endpoint',
    content:
      'The primary endpoint is overall survival (OS) in the PD-L1 CPS greater than or equal to 1 population. ' +
      'The study is powered at 90% to detect a hazard ratio of 0.70.',
  });
  const safetySoc = chunk({
    document_title: 'Quarterly Safety Report Q2 2026',
    document_classification: 'safety_report',
    heading_path: '2. Aggregate Adverse Events by System Organ Class',
    content:
      'Skin and subcutaneous tissue disorders were reported in 218 events during Q2 2026. Gastrointestinal ' +
      'disorders were reported in 141 events during Q2 2026. Metabolism and nutrition disorders were reported ' +
      'in 96 events during Q2 2026. Vascular disorders were reported in 47 events during Q2 2026.',
  });
  const siteDeviation = chunk({
    document_title: 'Site US-027 Protocol Deviation Notice',
    document_classification: 'site_communication',
    heading_path: '1. Deviation Description',
    content:
      'Site US-027 reported a major protocol deviation on 27 May 2026 involving an out-of-window tumor ' +
      'assessment. The tumor assessment was performed 11 days outside the protocol-specified window.',
  });

  function score(query: string, target: Chunk): number {
    return computeRelevanceScore(query, embedDeterministic(query), target);
  }

  it('scores >= 0.80 when the query contains all content-bearing terms of the target chunk (enrollment)', () => {
    expect(score('What is the planned enrollment for AXIOM-HN01?', protocolDesign)).toBeGreaterThanOrEqual(0.8);
  });

  it('scores >= 0.80 for a full-coverage query against the primary endpoint section', () => {
    expect(score('What is the primary endpoint and power of the study?', protocolEndpoint)).toBeGreaterThanOrEqual(
      0.8,
    );
  });

  it('scores >= 0.80 for a full-coverage query against the safety SOC table', () => {
    expect(
      score('How many gastrointestinal disorder events were reported during Q2 2026?', safetySoc),
    ).toBeGreaterThanOrEqual(0.8);
  });

  it('scores >= 0.80 for a full-coverage query against a site deviation notice', () => {
    expect(score('What protocol deviation was reported at site US-027?', siteDeviation)).toBeGreaterThanOrEqual(0.8);
  });

  it('every full-coverage example clears RELEVANCE_THRESHOLD (0.72)', () => {
    expect(score('What is the planned enrollment for AXIOM-HN01?', protocolDesign)).toBeGreaterThan(
      RELEVANCE_THRESHOLD,
    );
  });

  it('scores between 0.45 and 0.80 for a partially-overlapping query', () => {
    const s = score('What is the enrollment target and primary endpoint for the study?', protocolEndpoint);
    expect(s).toBeGreaterThanOrEqual(0.45);
    expect(s).toBeLessThanOrEqual(0.8);
  });

  it('MUST fall below RELEVANCE_THRESHOLD for an unrelated query (weather vs. protocol)', () => {
    const s = score('What is the weather forecast for Boston tomorrow?', protocolDesign);
    expect(s).toBeLessThan(RELEVANCE_THRESHOLD);
    expect(s).toBeLessThan(0.3);
  });

  it('scores < 0.30 for an unrelated query against the safety report', () => {
    expect(score('What is the weather forecast for Boston tomorrow?', safetySoc)).toBeLessThan(0.3);
  });

  it('scores < 0.30 when the query topic exists in the corpus but not in this particular chunk', () => {
    expect(score('What protocol deviation was reported at site US-027?', safetySoc)).toBeLessThan(0.3);
  });
});

describe('MemorySearchProvider', () => {
  const protocolChunk = chunk({
    chunk_id: 'p1',
    document_id: 'sp-prot-0001',
    document_title: 'AXIOM-HN01 Protocol v3.0',
    document_classification: 'protocol',
    heading_path: '1. Study Design',
    content: 'Planned enrollment is 480 participants across 92 sites.',
  });
  const safetyChunk = chunk({
    chunk_id: 's1',
    document_id: 'sp-saf-0001',
    document_title: 'Quarterly Safety Report Q2 2026',
    document_classification: 'safety_report',
    heading_path: '3. Serious Adverse Events',
    content: 'There were 34 serious adverse events reported in Q2 2026.',
  });
  const ciChunk = chunk({
    chunk_id: 'ci1',
    document_id: 'sp-ci-0001',
    document_title: 'HNSCC Competitive Landscape Q2 2026',
    document_classification: 'competitive_intelligence',
    heading_path: '1. Late-Stage Competitors',
    content: 'Late-stage competitors include several PD-1 and PD-L1 combination approaches.',
  });

  it('enforces the RBAC filter: a restricted role never sees a disallowed classification', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk, ciChunk]);
    const filter = buildSearchFilter('site_monitor'); // site_communication only
    const results = await provider.hybridSearch({
      queryText: 'enrollment',
      queryVector: embedDeterministic('enrollment'),
      filter,
      top: 10,
    });
    expect(results).toHaveLength(0);
  });

  it('an unrestricted role (null filter) can see every classification', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk, ciChunk]);
    const results = await provider.hybridSearch({
      queryText: 'enrollment safety competitors',
      queryVector: embedDeterministic('enrollment safety competitors'),
      filter: buildSearchFilter('regulatory_affairs'),
      top: 10,
    });
    expect(results.map((r) => r.chunk_id).sort()).toEqual(['ci1', 'p1', 's1']);
  });

  it('clinical_operations filter excludes competitive_intelligence', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk, ciChunk]);
    const results = await provider.hybridSearch({
      queryText: 'enrollment safety competitors',
      queryVector: embedDeterministic('enrollment safety competitors'),
      filter: buildSearchFilter('clinical_operations'),
      top: 10,
    });
    expect(results.map((r) => r.chunk_id).sort()).toEqual(['p1', 's1']);
  });

  it('sorts results by descending relevance score', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk]);
    const results = await provider.hybridSearch({
      queryText: 'serious adverse events reported',
      queryVector: embedDeterministic('serious adverse events reported'),
      filter: null,
      top: 10,
    });
    expect(results[0]?.chunk_id).toBe('s1');
    expect(results[0]!.similarity_score).toBeGreaterThanOrEqual(results[1]!.similarity_score);
  });

  it('respects top', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk, ciChunk]);
    const results = await provider.hybridSearch({
      queryText: 'enrollment safety competitors',
      queryVector: embedDeterministic('enrollment safety competitors'),
      filter: null,
      top: 1,
    });
    expect(results).toHaveLength(1);
  });

  it('restricts to documentIds when supplied, in addition to the classification filter', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk]);
    const results = await provider.hybridSearch({
      queryText: 'enrollment',
      queryVector: embedDeterministic('enrollment'),
      filter: null,
      top: 10,
      documentIds: ['sp-saf-0001'],
    });
    expect(results.map((r) => r.chunk_id)).toEqual(['s1']);
  });

  it('upsertChunks skips a chunk whose content_hash has not changed (idempotency)', async () => {
    const provider = new MemorySearchProvider();
    const first = await provider.upsertChunks([protocolChunk]);
    expect(first).toEqual({ upserted: 1, skipped: 0 });
    const second = await provider.upsertChunks([protocolChunk]);
    expect(second).toEqual({ upserted: 0, skipped: 1 });
    expect(await provider.countChunks()).toBe(1);
  });

  it('upsertChunks re-indexes when content_hash changes for the same chunk_id', async () => {
    const provider = new MemorySearchProvider([protocolChunk]);
    const updated = { ...protocolChunk, content: 'Updated content.', content_hash: 'new-hash' };
    const result = await provider.upsertChunks([updated]);
    expect(result).toEqual({ upserted: 1, skipped: 0 });
    const stored = await provider.getChunk(protocolChunk.chunk_id);
    expect(stored?.content).toBe('Updated content.');
  });

  it('deleteByDocumentId removes every chunk for that document', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk]);
    const deleted = await provider.deleteByDocumentId('sp-prot-0001');
    expect(deleted).toBe(1);
    expect(await provider.countChunks()).toBe(1);
  });

  it('listDocuments groups chunks by document and respects the RBAC filter', async () => {
    const provider = new MemorySearchProvider([protocolChunk, safetyChunk, ciChunk]);
    const docs = await provider.listDocuments(buildSearchFilter('medical_affairs'));
    expect(docs.map((d) => d.document_id).sort()).toEqual(['sp-ci-0001', 'sp-saf-0001']);
  });

  it('getChunk returns null for an unknown id', async () => {
    const provider = new MemorySearchProvider([protocolChunk]);
    expect(await provider.getChunk('does-not-exist')).toBeNull();
  });
});
