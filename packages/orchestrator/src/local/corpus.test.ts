import { contentHash } from '@trialpulse/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSourceUrl, chunkMarkdown, loadCorpusChunks, sectionPathOf } from './corpus';

// ---------------------------------------------------------------------------
// chunkMarkdown -- these mirror ingestion/tests/test_chunking.py's cases
// one-for-one so a regression here is caught locally, not only by the
// (heavier, Python-shelling) chunk-parity.test.ts.
// ---------------------------------------------------------------------------
describe('chunkMarkdown', () => {
  it('a single short section under a heading is one chunk', () => {
    const text = '## 1. Study Design\n<!-- page: 1 -->\n\nThis is a short section body.\n';
    const drafts = chunkMarkdown(text);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      sectionPath: '1. Study Design',
      pageNumber: 1,
      content: 'This is a short section body.',
      ordinal: 0,
    });
  });

  it('never splits across a heading, across multiple sibling sections', () => {
    const text = [
      '## 1. Study Design',
      '<!-- page: 1 -->',
      '',
      'First section body.',
      '',
      '## 2. Primary Endpoint',
      '<!-- page: 3 -->',
      '',
      'Second section body.',
      '',
      '## 3. Inclusion Criteria',
      '<!-- page: 5 -->',
      '',
      'Third section body.',
    ].join('\n');
    const drafts = chunkMarkdown(text);
    expect(drafts.map((d) => d.sectionPath)).toEqual(['1. Study Design', '2. Primary Endpoint', '3. Inclusion Criteria']);
    expect(drafts.map((d) => d.pageNumber)).toEqual([1, 3, 5]);
    expect(drafts.map((d) => d.content)).toEqual(['First section body.', 'Second section body.', 'Third section body.']);
    expect(drafts.map((d) => d.ordinal)).toEqual([0, 1, 2]);
  });

  it('builds nested heading paths as "A > B > C"', () => {
    const text = [
      '## A',
      '<!-- page: 1 -->',
      '',
      'Top level body.',
      '',
      '### B',
      '<!-- page: 1 -->',
      '',
      'Nested body.',
      '',
      '#### C',
      '<!-- page: 2 -->',
      '',
      'Deeply nested body.',
    ].join('\n');
    const drafts = chunkMarkdown(text);
    expect(drafts.map((d) => d.sectionPath)).toEqual(['A', 'A > B', 'A > B > C']);
    expect(drafts[2]?.pageNumber).toBe(2);
  });

  it('a sibling heading pops the previous nested level', () => {
    const text = [
      '## A',
      '<!-- page: 1 -->',
      '',
      'Body A.',
      '',
      '### B',
      '<!-- page: 1 -->',
      '',
      'Body B.',
      '',
      '## D',
      '<!-- page: 4 -->',
      '',
      'Body D, a sibling of A, not nested under B.',
    ].join('\n');
    const drafts = chunkMarkdown(text);
    expect(drafts.map((d) => d.sectionPath)).toEqual(['A', 'A > B', 'D']);
  });

  it('content before the first heading becomes an empty section path (the pre-heading banner)', () => {
    const text = 'Some preamble banner text before any heading.\n\n## 1. First\n<!-- page: 1 -->\n\nBody.\n';
    const drafts = chunkMarkdown(text);
    expect(drafts[0]?.sectionPath).toBe('');
    expect(drafts[0]?.content).toBe('Some preamble banner text before any heading.');
    expect(drafts[1]?.sectionPath).toBe('1. First');
  });

  it('a top-level "#" heading is NOT a section boundary (only "##".."######" are)', () => {
    const text = '# Document Title\n\nBanner text under the title.\n\n## 1. First\n\nBody.\n';
    const drafts = chunkMarkdown(text);
    expect(drafts[0]?.sectionPath).toBe('');
    expect(drafts[0]?.content).toBe('# Document Title\n\nBanner text under the title.');
  });

  it('defaults the page number to 1 when no marker is present', () => {
    const drafts = chunkMarkdown('## 1. No Page Marker\n\nBody with no page marker at all.\n');
    expect(drafts[0]?.pageNumber).toBe(1);
  });

  it('page markers are parsed and never appear in chunk content', () => {
    const drafts = chunkMarkdown('## 1. Heading\n<!-- page: 9 -->\n\nBody text.\n');
    expect(drafts[0]?.pageNumber).toBe(9);
    expect(drafts[0]?.content).not.toContain('<!-- page:');
  });

  it('an empty section produces no chunk', () => {
    const drafts = chunkMarkdown('## 1. Empty\n<!-- page: 1 -->\n\n## 2. Has Content\n<!-- page: 2 -->\n\nSome text.\n');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sectionPath).toBe('2. Has Content');
  });

  it('splits a long section into multiple overlapping whole-sentence chunks', () => {
    const sentences = Array.from({ length: 120 }, (_, i) => `Sentence number ${i + 1} contains exactly six words here.`);
    const body = sentences.join(' ');
    const text = `## Long Section\n<!-- page: 7 -->\n\n${body}\n`;

    const drafts = chunkMarkdown(text);
    expect(drafts.length).toBeGreaterThan(1);
    for (const draft of drafts) {
      expect(draft.sectionPath).toBe('Long Section');
      expect(draft.pageNumber).toBe(7);
    }

    // Adjacent chunks overlap: the tail of chunk i shares at least one
    // sentence with the head of chunk i+1.
    for (let i = 0; i < drafts.length - 1; i += 1) {
      const firstSentences = drafts[i]!.content.split('. ').map((s) => s.trim());
      const secondSentences = drafts[i + 1]!.content.split('. ').map((s) => s.trim());
      const overlap = firstSentences.slice(-10).some((s) => secondSentences.slice(0, 10).includes(s));
      expect(overlap).toBe(true);
    }

    const ordinals = drafts.map((d) => d.ordinal);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('never splits a section that is under the token target, regardless of sentence count', () => {
    const sentences = Array.from({ length: 19 }, (_, i) => `Short sentence ${i + 1}.`);
    const body = sentences.join(' ');
    const drafts = chunkMarkdown(`## Short Section\n<!-- page: 2 -->\n\n${body}\n`);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.content).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// sectionPathOf -- mirrors tombstones.section_path_of.
// ---------------------------------------------------------------------------
describe('sectionPathOf', () => {
  it('strips the exact "<document_title> > " prefix', () => {
    expect(
      sectionPathOf({ document_title: 'AXIOM-HN01 Protocol v3.0', heading_path: 'AXIOM-HN01 Protocol v3.0 > 1. Study Design' }),
    ).toBe('1. Study Design');
  });

  it('returns the empty string for the pre-heading banner chunk (heading_path === document_title)', () => {
    expect(sectionPathOf({ document_title: 'AXIOM-HN01 Protocol v3.0', heading_path: 'AXIOM-HN01 Protocol v3.0' })).toBe('');
  });

  it('returns heading_path unchanged when it does not start with the title prefix', () => {
    expect(sectionPathOf({ document_title: 'Some Other Title', heading_path: '1. Study Design' })).toBe('1. Study Design');
  });
});

// ---------------------------------------------------------------------------
// buildSourceUrl -- mirrors pipeline.py's build_source_url exactly: no
// #page= anchor, library keyed by classification, TrialPulse (not
// lowercase) in the site path.
// ---------------------------------------------------------------------------
describe('buildSourceUrl', () => {
  it('builds a library-keyed URL with no page anchor', () => {
    expect(buildSourceUrl('protocol', 'protocol-axiom-hn01-v3.0.md')).toBe(
      'https://meridiantx.sharepoint.com/sites/TrialPulse/Protocols/protocol-axiom-hn01-v3.0.md',
    );
  });

  it('percent-encodes spaces in multi-word library names', () => {
    expect(buildSourceUrl('investigator_brochure', 'ib.md')).toBe(
      'https://meridiantx.sharepoint.com/sites/TrialPulse/Investigator%20Brochures/ib.md',
    );
  });
});

// ---------------------------------------------------------------------------
// loadCorpusChunks against the real 20-document synthetic corpus.
// ---------------------------------------------------------------------------
describe('loadCorpusChunks (real synthetic corpus)', () => {
  it('produces exactly 65 chunks, matching the production Python pipeline', () => {
    const chunks = loadCorpusChunks();
    expect(chunks).toHaveLength(65);
  });

  it('produces the correct chunk count per classification, matching the production Python pipeline', () => {
    const chunks = loadCorpusChunks();
    const counts = new Map<string, number>();
    for (const c of chunks) {
      counts.set(c.document_classification, (counts.get(c.document_classification) ?? 0) + 1);
    }
    expect(counts.get('protocol')).toBe(17);
    expect(counts.get('investigator_brochure')).toBe(7);
    expect(counts.get('regulatory_submission')).toBe(12);
    expect(counts.get('safety_report')).toBe(9);
    expect(counts.get('site_communication')).toBe(11);
    expect(counts.get('competitive_intelligence')).toBe(9);
  });

  it('every chunk_id is a 64-character lowercase hex sha256 digest (document_id::heading_path::ordinal::content_hash)', () => {
    const chunks = loadCorpusChunks();
    for (const chunk of chunks) {
      expect(chunk.chunk_id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('heading_path is title-prefixed, "<document title> > <section path>"', () => {
    const chunks = loadCorpusChunks();
    const designChunk = chunks.find(
      (c) => c.document_id === 'sp-prot-0001' && c.heading_path === 'AXIOM-HN01 Protocol v3.0 > 1. Study Design',
    );
    expect(designChunk).toBeDefined();
    expect(designChunk?.content).toContain('Planned enrollment is 480 participants across 92 sites.');
  });

  it('the pre-heading banner is its own chunk, with heading_path equal to the bare document title', () => {
    const chunks = loadCorpusChunks();
    const banner = chunks.find((c) => c.document_id === 'sp-prot-0001' && c.heading_path === 'AXIOM-HN01 Protocol v3.0');
    expect(banner).toBeDefined();
    expect(banner?.content).toContain('SYNTHETIC DATA NOTICE');
    expect(banner?.page_number).toBe(1);
  });

  it('no chunk content contains a raw page marker -- markers are parsed and stripped', () => {
    const chunks = loadCorpusChunks();
    for (const chunk of chunks) {
      expect(chunk.content).not.toContain('<!-- page:');
    }
  });

  it('source_url has no #page= anchor and points at a classification-keyed SharePoint library', () => {
    const chunks = loadCorpusChunks();
    const protocolChunk = chunks.find((c) => c.document_id === 'sp-prot-0001');
    expect(protocolChunk?.source_url).toBe(
      'https://meridiantx.sharepoint.com/sites/TrialPulse/Protocols/protocol-axiom-hn01-v3.0.md',
    );
    expect(protocolChunk?.source_url).not.toContain('#page=');
  });

  it('every chunk has a non-empty content_hash consistent with its content', () => {
    const chunks = loadCorpusChunks();
    for (const chunk of chunks) {
      expect(chunk.content_hash).toBe(contentHash(chunk.content));
    }
  });

  it('stamps site_code from the manifest, null when the document has none', () => {
    const chunks = loadCorpusChunks();
    const siteChunk = chunks.find((c) => c.document_id === 'sp-site-0002');
    expect(siteChunk?.site_code).toBe('US-027');
    const protocolChunk = chunks.find((c) => c.document_id === 'sp-prot-0001');
    expect(protocolChunk?.site_code).toBeNull();
  });

  it('backfills previous_version_hash by aligning on the BARE section path across a supersedes chain', () => {
    const chunks = loadCorpusChunks();
    const v3Design = chunks.find((c) => c.document_id === 'sp-prot-0001' && sectionPathOf(c) === '1. Study Design');
    const v4Design = chunks.find((c) => c.document_id === 'sp-prot-0002' && sectionPathOf(c) === '1. Study Design');
    expect(v3Design).toBeDefined();
    expect(v4Design).toBeDefined();
    expect(v4Design?.previous_version_hash).toBe(v3Design?.content_hash);
  });

  it('leaves previous_version_hash null for a document that supersedes nothing', () => {
    const chunks = loadCorpusChunks();
    const v3Design = chunks.find((c) => c.document_id === 'sp-prot-0001' && sectionPathOf(c) === '1. Study Design');
    expect(v3Design?.previous_version_hash).toBeNull();
  });

  it('leaves previous_version_hash null for a section added only in the newer version', () => {
    const chunks = loadCorpusChunks();
    const summarySection = chunks.find(
      (c) => c.document_id === 'sp-prot-0002' && sectionPathOf(c) === '6. Summary of Changes from Version 3.0',
    );
    expect(summarySection).toBeDefined();
    expect(summarySection?.previous_version_hash).toBeNull();
  });
});

describe('loadCorpusChunks (markdown-only, mirroring production)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  function writeManifest(tempDirPath: string, filename: string): void {
    const manifest = {
      corpus_version: 'test',
      documents: [
        {
          document_id: 'doc-1',
          filename,
          title: 'Test Document',
          classification: 'protocol',
          version: '1.0',
          effective_date: '2026-01-01',
          site_code: null,
          supersedes: null,
        },
      ],
    };
    writeFileSync(join(tempDirPath, 'corpus-manifest.json'), JSON.stringify(manifest), 'utf8');
  }

  it('chunks strictly from the markdown body: front matter stripped, headings drive section boundaries', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'trialpulse-corpus-'));
    writeManifest(tempDir, 'doc-1.md');
    writeFileSync(
      join(tempDir, 'doc-1.md'),
      [
        '---',
        'document_id: "doc-1"',
        'title: "Test Document"',
        '---',
        '',
        '## 1. Study Design',
        '<!-- page: 1 -->',
        '',
        'Real markdown body text for this section.',
        '',
      ].join('\n'),
      'utf8',
    );

    const chunks = loadCorpusChunks({ corpusDir: tempDir });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe('Real markdown body text for this section.');
    expect(chunks[0]?.heading_path).toBe('Test Document > 1. Study Design');
    expect(chunks[0]?.content).not.toContain('document_id:');
  });

  it('throws a clear error when the markdown file is missing -- there is no facts[]-based fallback', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'trialpulse-corpus-'));
    writeManifest(tempDir, 'does-not-exist.md');

    expect(() => loadCorpusChunks({ corpusDir: tempDir })).toThrow(/markdown file not found/);
  });
});
