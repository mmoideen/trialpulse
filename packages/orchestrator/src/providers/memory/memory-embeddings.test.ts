import { EMBEDDING_DIMENSIONS } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { embedDeterministic, MemoryEmbeddingProvider } from './memory-embeddings';

describe('embedDeterministic', () => {
  it('produces a vector of the configured dimensionality', () => {
    const vector = embedDeterministic('What is the primary endpoint?');
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('is a pure function: the same input always produces the same vector', () => {
    const a = embedDeterministic('What is the enrollment target for AXIOM-HN01?');
    const b = embedDeterministic('What is the enrollment target for AXIOM-HN01?');
    expect(a).toEqual(b);
  });

  it('produces different vectors for different inputs', () => {
    const a = embedDeterministic('What is the enrollment target?');
    const b = embedDeterministic('What is the weather forecast?');
    expect(a).not.toEqual(b);
  });

  it('is L2-normalised (unit length)', () => {
    const vector = embedDeterministic('Skin and subcutaneous tissue disorders were reported in 218 events.');
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('produces a valid unit vector for empty text', () => {
    const vector = embedDeterministic('');
    const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

describe('MemoryEmbeddingProvider', () => {
  it('returns a deterministic vector, token estimate and model name', async () => {
    const provider = new MemoryEmbeddingProvider();
    const result = await provider.embed('What is the primary endpoint?');
    expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.model).toBe('memory-embedding-hash-v1');

    const again = await provider.embed('What is the primary endpoint?');
    expect(again.vector).toEqual(result.vector);
  });
});
