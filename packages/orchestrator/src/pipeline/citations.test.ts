import type { ScoredChunk } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { numberChunks, validateAndRenumberCitations } from './citations';

function chunk(id: string, overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    chunk_id: id,
    document_id: `doc-${id}`,
    document_title: `Document ${id}`,
    document_classification: 'protocol',
    document_version: '1.0',
    content: `Content of ${id}`,
    content_hash: `hash-${id}`,
    heading_path: `Heading ${id}`,
    page_number: 1,
    source_url: `https://example.com/${id}`,
    ingested_at: '2026-01-01T00:00:00Z',
    site_code: null,
    previous_version_hash: null,
    similarity_score: 0.9,
    ...overrides,
  };
}

describe('numberChunks', () => {
  it('numbers chunks 1-indexed in order', () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    const numbered = numberChunks(chunks);
    expect(numbered.map((n) => n.index)).toEqual([1, 2, 3]);
    expect(numbered[1]?.chunk.chunk_id).toBe('b');
  });
});

describe('validateAndRenumberCitations', () => {
  it('keeps valid citations and leaves numbering untouched when already sequential', () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    const { text, citations } = validateAndRenumberCitations(
      'The enrollment target is 480 [1]. The endpoint is OS [2].',
      chunks,
    );
    expect(text).toBe('The enrollment target is 480 [1]. The endpoint is OS [2].');
    expect(citations).toHaveLength(2);
    expect(citations[0]).toMatchObject({ index: 1, chunk_id: 'a' });
    expect(citations[1]).toMatchObject({ index: 2, chunk_id: 'b' });
  });

  it('strips a hallucinated citation index that does not map to any supplied chunk', () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    const { text, citations } = validateAndRenumberCitations(
      'The enrollment target is 480 [1]. Some other unsupported claim [7].',
      chunks,
    );
    expect(text).not.toContain('[7]');
    expect(text).toBe('The enrollment target is 480 [1]. Some other unsupported claim.');
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ index: 1, chunk_id: 'a' });
  });

  it('drops citations for chunks that were supplied but never cited', () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    const { citations } = validateAndRenumberCitations('Only chunk two was used [2].', chunks);
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ chunk_id: 'b' });
  });

  it('renumbers citations sequentially in order of first appearance, not original index', () => {
    const chunks = [chunk('a'), chunk('b'), chunk('c')];
    // Model cites chunk 3 first, then chunk 1 -- final numbering must be
    // [1] for chunk 3 and [2] for chunk 1, and the text must reflect that.
    const { text, citations } = validateAndRenumberCitations('First fact [3]. Second fact [1].', chunks);
    expect(text).toBe('First fact [1]. Second fact [2].');
    expect(citations).toEqual([
      expect.objectContaining({ index: 1, chunk_id: 'c' }),
      expect.objectContaining({ index: 2, chunk_id: 'a' }),
    ]);
  });

  it('maps repeated citations of the same chunk to the same renumbered index', () => {
    const chunks = [chunk('a'), chunk('b')];
    const { text, citations } = validateAndRenumberCitations('Fact one [2]. Fact two, also from [2].', chunks);
    // Only one distinct chunk is cited (original index 2), and it is the
    // first index encountered, so it renumbers to [1] both times.
    expect(citations).toHaveLength(1);
    expect(citations[0]).toMatchObject({ index: 1, chunk_id: 'b' });
    expect(text).toBe('Fact one [1]. Fact two, also from [1].');
  });

  it('handles an answer with no citations at all (e.g. a refusal)', () => {
    const chunks: ScoredChunk[] = [];
    const { text, citations } = validateAndRenumberCitations('I cannot find information about X.', chunks);
    expect(text).toBe('I cannot find information about X.');
    expect(citations).toEqual([]);
  });

  it('treats index 0 and negative-looking brackets as invalid (never off-by-one into a real chunk)', () => {
    const chunks = [chunk('a')];
    const { text, citations } = validateAndRenumberCitations('Bad ref [0] and good ref [1].', chunks);
    expect(text).toBe('Bad ref and good ref [1].');
    expect(citations).toHaveLength(1);
  });

  it('D1: renders a redaction-suppressed source_url ("") as null, never as an empty-but-truthy URL', () => {
    const chunks = [chunk('a', { source_url: '' })];
    const { citations } = validateAndRenumberCitations('Fact one [1].', chunks);
    expect(citations[0]?.source_url).toBeNull();
  });
});
