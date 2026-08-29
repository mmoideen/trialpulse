import { contentHash, type DocumentStatus, type ScoredChunk } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { detectVersionCompareIntent, diffSections, findVersionPair, toSyntheticChunks } from './version-compare';

// Real section text from data/synthetic/corpus-manifest.json (documents
// sp-prot-0001 / sp-prot-0002, AXIOM-HN01 protocol v3.0 -> v4.0), joined
// exactly the way the seeding pipeline joins a section's `facts` into a
// chunk's `content`.
const V3_SECTIONS: Array<{ heading: string; page: number; facts: string[] }> = [
  {
    heading: '1. Study Design',
    page: 1,
    facts: [
      'AXIOM-HN01 is a randomized, double-blind, placebo-controlled Phase 3 study.',
      'Planned enrollment is 480 participants across 92 sites.',
      'Participants are randomized 1:1 to revarafusp alfa plus torilizumab or placebo plus torilizumab.',
    ],
  },
  {
    heading: '2. Primary Endpoint',
    page: 3,
    facts: [
      'The primary endpoint is overall survival (OS) in the PD-L1 CPS greater than or equal to 1 population.',
      'The study is powered at 90% to detect a hazard ratio of 0.70.',
    ],
  },
  {
    heading: '5. Interim Analysis',
    page: 14,
    facts: [
      'A single interim analysis is planned after 60% of target OS events.',
      'The interim analysis is reviewed by an independent Data Monitoring Committee.',
    ],
  },
];

const V4_SECTIONS: Array<{ heading: string; page: number; facts: string[] }> = [
  {
    heading: '1. Study Design',
    page: 1,
    facts: [
      'AXIOM-HN01 is a randomized, double-blind, placebo-controlled Phase 3 study.',
      'Planned enrollment is increased to 528 participants across 104 sites.',
      'Participants are randomized 1:1 to revarafusp alfa plus torilizumab or placebo plus torilizumab.',
    ],
  },
  {
    heading: '2. Primary Endpoint',
    page: 3,
    facts: [
      'The primary endpoint is overall survival (OS) in the PD-L1 CPS greater than or equal to 1 population.',
      'Progression-free survival was elevated from an exploratory endpoint to a key secondary endpoint in version 4.0.',
      'The study is powered at 90% to detect a hazard ratio of 0.70.',
    ],
  },
  {
    heading: '5. Interim Analysis',
    page: 14,
    facts: [
      'Version 4.0 adds a second interim analysis after 40% of target OS events.',
      'The interim analysis is reviewed by an independent Data Monitoring Committee.',
    ],
  },
  {
    heading: '6. Summary of Changes from Version 3.0',
    page: 21,
    facts: [
      'Enrollment increased from 480 to 528 participants.',
      'Site count increased from 92 to 104.',
      'A second interim analysis was added.',
    ],
  },
];

function chunkFromSection(
  documentId: string,
  documentTitle: string,
  documentVersion: string,
  section: { heading: string; page: number; facts: string[] },
): ScoredChunk {
  return {
    chunk_id: `${documentId}_${section.heading}`,
    document_id: documentId,
    document_title: documentTitle,
    document_classification: 'protocol',
    document_version: documentVersion,
    content: section.facts.join(' '),
    content_hash: `hash_${documentId}_${section.heading}`,
    heading_path: section.heading,
    page_number: section.page,
    source_url: `https://example.com/${documentId}`,
    ingested_at: '2026-01-01T00:00:00Z',
    site_code: null,
    previous_version_hash: null,
    similarity_score: 1,
  };
}

const FROM_DOC: DocumentStatus = {
  document_id: 'sp-prot-0001',
  document_title: 'AXIOM-HN01 Protocol v3.0',
  document_classification: 'protocol',
  document_version: '3.0',
  status: 'indexed',
  chunk_count: V3_SECTIONS.length,
  last_ingested_at: '2026-01-01T00:00:00Z',
  error_message: null,
  source_url: 'https://example.com/sp-prot-0001',
};

const TO_DOC: DocumentStatus = {
  document_id: 'sp-prot-0002',
  document_title: 'AXIOM-HN01 Protocol v4.0',
  document_classification: 'protocol',
  document_version: '4.0',
  status: 'indexed',
  chunk_count: V4_SECTIONS.length,
  last_ingested_at: '2026-01-01T00:00:00Z',
  error_message: null,
  source_url: 'https://example.com/sp-prot-0002',
};

const UNRELATED_DOC: DocumentStatus = {
  document_id: 'sp-ci-0001',
  document_title: 'HNSCC Competitive Landscape Q2 2026',
  document_classification: 'competitive_intelligence',
  document_version: '1.0',
  status: 'indexed',
  chunk_count: 2,
  last_ingested_at: '2026-01-01T00:00:00Z',
  error_message: null,
  source_url: 'https://example.com/sp-ci-0001',
};

describe('detectVersionCompareIntent', () => {
  it('detects the PRD example phrasing', () => {
    expect(detectVersionCompareIntent('What changed between protocol version 3.0 and 4.0?')).toEqual({
      fromVersion: '3.0',
      toVersion: '4.0',
    });
  });

  it('detects "compare version X to version Y" phrasing', () => {
    expect(detectVersionCompareIntent('Please compare version 3.0 to version 4.0 of the protocol.')).toEqual({
      fromVersion: '3.0',
      toVersion: '4.0',
    });
  });

  it('returns null for an ordinary, non-comparison query', () => {
    expect(detectVersionCompareIntent('What is the primary endpoint of the study?')).toBeNull();
  });
});

describe('findVersionPair', () => {
  it('matches the two protocol documents by title with the version suffix stripped', () => {
    const pair = findVersionPair([FROM_DOC, TO_DOC, UNRELATED_DOC], { fromVersion: '3.0', toVersion: '4.0' });
    expect(pair).not.toBeNull();
    expect(pair?.from.document_id).toBe('sp-prot-0001');
    expect(pair?.to.document_id).toBe('sp-prot-0002');
  });

  it('returns null when one of the requested versions does not exist', () => {
    const pair = findVersionPair([FROM_DOC, TO_DOC], { fromVersion: '3.0', toVersion: '9.0' });
    expect(pair).toBeNull();
  });
});

describe('diffSections', () => {
  const fromChunks = V3_SECTIONS.map((s) => chunkFromSection(FROM_DOC.document_id, FROM_DOC.document_title, '3.0', s));
  const toChunks = V4_SECTIONS.map((s) => chunkFromSection(TO_DOC.document_id, TO_DOC.document_title, '4.0', s));
  const diffs = diffSections(fromChunks, toChunks);

  it('marks "1. Study Design" as changed (enrollment/site count changed)', () => {
    const d = diffs.find((x) => x.heading_path === '1. Study Design');
    expect(d?.status).toBe('changed');
    expect(d?.from_content).toContain('480 participants');
    expect(d?.to_content).toContain('528 participants');
  });

  it('marks "2. Primary Endpoint" as changed (PFS language added)', () => {
    const d = diffs.find((x) => x.heading_path === '2. Primary Endpoint');
    expect(d?.status).toBe('changed');
  });

  it('marks "5. Interim Analysis" as changed', () => {
    const d = diffs.find((x) => x.heading_path === '5. Interim Analysis');
    expect(d?.status).toBe('changed');
    expect(d?.from_content).toContain('60% of target OS events');
    expect(d?.to_content).toContain('40% of target OS events');
  });

  it('marks "6. Summary of Changes from Version 3.0" as added', () => {
    const d = diffs.find((x) => x.heading_path === '6. Summary of Changes from Version 3.0');
    expect(d?.status).toBe('added');
    expect(d?.from_content).toBeNull();
    expect(d?.to_page).toBe(21);
  });

  it('never fabricates a "removed" section when every v3 heading still exists in v4', () => {
    expect(diffs.some((d) => d.status === 'removed')).toBe(false);
  });

  it('produces exactly one diff entry per distinct heading across both versions', () => {
    expect(diffs).toHaveLength(4); // Study Design, Primary Endpoint, Interim Analysis, Summary of Changes
  });
});

// ---------------------------------------------------------------------------
// Regression: `diffSections` used to align chunks by the FULL heading_path.
// Production `heading_path` is title-prefixed
// ("<document_title> > <section path>", see
// `ingestion/trialpulse_ingest/pipeline.py`), and a new document version's
// title necessarily differs from the version it supersedes (e.g. "...v3.0"
// vs "...v4.0"). Aligning on the full heading_path therefore matched
// nothing at all: the reviewer measured a real run of the full AXIOM-HN01
// v3.0 -> v4.0 protocol (5 sections + pre-heading banner in v3.0, 6
// sections + banner in v4.0, all title-prefixed) producing
// `{"removed": 6, "added": 7}` -- every section "removed" from v3.0 and
// "added" in v4.0, even though only 5 sections actually changed and 1 was
// added. The fixtures below use the PRODUCTION shape (title-prefixed
// heading_path, exactly as `local/corpus.ts`/the Python pipeline emit it)
// to prove the fix.
// ---------------------------------------------------------------------------
const SYNTHETIC_BANNER_TEXT =
  'SYNTHETIC DATA NOTICE. Every document in this corpus is entirely fabricated for TrialPulse local development, automated testing, and evaluation.';

const FULL_V3_SECTIONS: Array<{ heading: string; page: number; facts: string[] }> = [
  V3_SECTIONS[0]!,
  V3_SECTIONS[1]!,
  {
    heading: '3. Key Inclusion Criteria',
    page: 5,
    facts: [
      'Participants must be at least 18 years of age.',
      'ECOG performance status must be 0 or 1.',
      'Participants must have measurable disease per RECIST v1.1.',
    ],
  },
  {
    heading: '4. Dose and Administration',
    page: 9,
    facts: [
      'Revarafusp alfa is administered at 1500 mg intravenously every 3 weeks.',
      'Torilizumab is administered at 200 mg intravenously every 3 weeks.',
    ],
  },
  V3_SECTIONS[2]!,
];

const FULL_V4_SECTIONS: Array<{ heading: string; page: number; facts: string[] }> = [
  V4_SECTIONS[0]!,
  V4_SECTIONS[1]!,
  {
    heading: '3. Key Inclusion Criteria',
    page: 5,
    facts: [
      'Participants must be at least 18 years of age.',
      'ECOG performance status must be 0 or 1.',
      'Participants must have measurable disease per RECIST v1.1.',
      'Version 4.0 permits enrollment of participants with treated, stable brain metastases.',
    ],
  },
  {
    heading: '4. Dose and Administration',
    page: 9,
    facts: [
      'Revarafusp alfa is administered at 1500 mg intravenously every 3 weeks.',
      'Torilizumab is administered at 200 mg intravenously every 3 weeks.',
      'Version 4.0 adds a mandatory 60-minute observation period after the first infusion.',
    ],
  },
  V4_SECTIONS[2]!,
  V4_SECTIONS[3]!,
];

/** A chunk shaped exactly like production output: title-prefixed heading_path, banner chunk included. */
function productionShapedChunk(
  documentId: string,
  documentTitle: string,
  documentVersion: string,
  sectionPath: string,
  page: number,
  content: string,
): ScoredChunk {
  const headingPath = sectionPath ? `${documentTitle} > ${sectionPath}` : documentTitle;
  return {
    chunk_id: `${documentId}_${sectionPath || 'banner'}`,
    document_id: documentId,
    document_title: documentTitle,
    document_classification: 'protocol',
    document_version: documentVersion,
    content,
    content_hash: contentHash(content),
    heading_path: headingPath,
    page_number: page,
    source_url: `https://example.com/${documentId}`,
    ingested_at: '2026-01-01T00:00:00Z',
    site_code: null,
    previous_version_hash: null,
    similarity_score: 1,
  };
}

function productionShapedDocumentChunks(
  documentId: string,
  documentTitle: string,
  documentVersion: string,
  sections: Array<{ heading: string; page: number; facts: string[] }>,
): ScoredChunk[] {
  const banner = productionShapedChunk(documentId, documentTitle, documentVersion, '', 1, SYNTHETIC_BANNER_TEXT);
  const sectionChunks = sections.map((s) =>
    productionShapedChunk(documentId, documentTitle, documentVersion, s.heading, s.page, s.facts.join(' ')),
  );
  return [banner, ...sectionChunks];
}

describe('diffSections (production heading_path shape: title-prefixed, full section set)', () => {
  const fromChunks = productionShapedDocumentChunks('sp-prot-0001', 'AXIOM-HN01 Protocol v3.0', '3.0', FULL_V3_SECTIONS);
  const toChunks = productionShapedDocumentChunks('sp-prot-0002', 'AXIOM-HN01 Protocol v4.0', '4.0', FULL_V4_SECTIONS);
  const diffs = diffSections(fromChunks, toChunks);

  it('never fabricates a wholesale removed-and-re-added diff just because the two versions have different titles', () => {
    expect(diffs.filter((d) => d.status === 'removed')).toHaveLength(0);
    expect(diffs).not.toHaveLength(13); // the old, broken {"removed":6,"added":7} shape
  });

  it('matches the real defect numbers: 5 sections changed, 1 section added, the identical banner is unchanged', () => {
    const byStatus = new Map<string, number>();
    for (const d of diffs) byStatus.set(d.status, (byStatus.get(d.status) ?? 0) + 1);
    expect(byStatus.get('changed')).toBe(5);
    expect(byStatus.get('added')).toBe(1);
    expect(byStatus.get('unchanged')).toBe(1);
    expect(byStatus.get('removed')).toBeUndefined();
    expect(diffs).toHaveLength(7);
  });

  it('aligns the pre-heading banner (bare section path "") across versions instead of diffing it as two unrelated sections', () => {
    const banner = diffs.find((d) => d.heading_path === '');
    expect(banner).toBeDefined();
    expect(banner?.status).toBe('unchanged');
  });

  it('reports the bare section path, never the title-prefixed form, on every diff entry', () => {
    for (const d of diffs) {
      expect(d.heading_path).not.toContain('AXIOM-HN01 Protocol v3.0');
      expect(d.heading_path).not.toContain('AXIOM-HN01 Protocol v4.0');
    }
  });
});

describe('toSyntheticChunks', () => {
  const fromChunks = V3_SECTIONS.map((s) => chunkFromSection(FROM_DOC.document_id, FROM_DOC.document_title, '3.0', s));
  const toChunks = V4_SECTIONS.map((s) => chunkFromSection(TO_DOC.document_id, TO_DOC.document_title, '4.0', s));
  const intent = { fromVersion: '3.0', toVersion: '4.0' };
  const diffs = diffSections(fromChunks, toChunks);
  const synthetic = toSyntheticChunks(diffs, { from: FROM_DOC, to: TO_DOC }, intent);

  it('produces one synthetic chunk per changed/added section, all above the relevance threshold', () => {
    expect(synthetic).toHaveLength(4);
    for (const chunk of synthetic) {
      expect(chunk.similarity_score).toBeGreaterThanOrEqual(0.72);
      expect(chunk.document_classification).toBe('protocol');
    }
  });

  it('describes the changed interim analysis section with both versions text', () => {
    const interim = synthetic.find((c) => c.heading_path === '5. Interim Analysis');
    expect(interim?.content).toContain('60% of target OS events');
    expect(interim?.content).toContain('40% of target OS events');
  });

  it('emits a single "no differences" chunk when nothing changed', () => {
    const noDiffs = diffSections(fromChunks, fromChunks); // compare a document to itself
    const result = toSyntheticChunks(noDiffs, { from: FROM_DOC, to: TO_DOC }, intent);
    expect(result).toHaveLength(1);
    expect(result[0]?.content).toMatch(/no differences/i);
  });

  // Regression: version-compare used to mint `diff_<doc>_<heading>` chunk ids
  // that existed nowhere in the index, so following a citation from a version
  // comparison back to its source resolved to nothing. Every citation must
  // dereference to a real indexed chunk -- that is what makes an answer
  // auditable.
  it('cites only chunk ids that exist in the index', () => {
    const realIds = new Set([...fromChunks, ...toChunks].map((c) => c.chunk_id));
    expect(synthetic.length).toBeGreaterThan(0);
    for (const chunk of synthetic) {
      expect(realIds.has(chunk.chunk_id), `${chunk.chunk_id} is not a real chunk`).toBe(true);
      expect(chunk.chunk_id).not.toMatch(/^diff_/);
    }
  });

  it('anchors the "no differences" chunk to a real chunk too', () => {
    const realIds = new Set(fromChunks.map((c) => c.chunk_id));
    const noDiffs = diffSections(fromChunks, fromChunks);
    const result = toSyntheticChunks(noDiffs, { from: FROM_DOC, to: TO_DOC }, intent);
    expect(realIds.has(result[0]!.chunk_id)).toBe(true);
  });

  it('prefers the newer version chunk id for a changed section', () => {
    const interim = synthetic.find((c) => c.heading_path === '5. Interim Analysis');
    const newerChunk = toChunks.find((c) => c.heading_path === '5. Interim Analysis');
    expect(interim?.chunk_id).toBe(newerChunk?.chunk_id);
  });

  it('returns nothing to cite when there are no chunks at all, so the pipeline refuses', () => {
    expect(toSyntheticChunks([], { from: FROM_DOC, to: TO_DOC }, intent)).toEqual([]);
  });
});
