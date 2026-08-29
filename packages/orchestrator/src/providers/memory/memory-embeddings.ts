/**
 * Deterministic, dependency-free embedding provider for local dev, unit
 * tests and the eval harness.
 *
 * Uses the "hashing trick" (feature hashing): each token is hashed into one
 * of `EMBEDDING_DIMENSIONS` buckets with a deterministic sign and weight
 * derived from the same hash, then the accumulated vector is L2-normalised.
 * This is not a semantically meaningful embedding -- it cannot capture
 * synonymy -- but it is a pure function of the input text (same input always
 * produces the same vector, byte for byte) and, because shared vocabulary
 * between two texts contributes shared vector components, cosine similarity
 * between two hashed vectors correlates with lexical overlap. That is
 * exactly the signal `memory-search.ts` needs; see its module doc for how
 * this is combined with lexical coverage and calibrated against
 * `RELEVANCE_THRESHOLD`.
 */
import { approximateTokens, EMBEDDING_DIMENSIONS } from '@trialpulse/shared';
import type { EmbeddingProvider, EmbeddingResult } from '../types';

const MEMORY_EMBEDDING_MODEL = 'memory-embedding-hash-v1';

/** FNV-1a, a small non-cryptographic hash: fast, deterministic, good enough bucket dispersion. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (norm === 0) return vector;
  return vector.map((v) => v / norm);
}

/** Deterministically embed `text` into an `dimensions`-long, L2-normalised vector. */
export function embedDeterministic(text: string, dimensions: number = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const hash = fnv1a(token);
    const index = hash % dimensions;
    // Sign and weight are both pure functions of the token text (via
    // independent hash derivations), so repeated tokens accumulate rather
    // than cancel, and the same token always contributes the same way.
    const sign = (hash & 1) === 0 ? 1 : -1;
    const weight = 1 + (fnv1a(`${token}:w`) % 7);
    vector[index] = (vector[index] ?? 0) + sign * weight;
  }
  if (tokens.length === 0) {
    // Empty text still needs a valid, deterministic unit vector rather than
    // an all-zero one (which cannot be L2-normalised).
    vector[0] = 1;
  }
  return l2Normalize(vector);
}

export class MemoryEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<EmbeddingResult> {
    return Promise.resolve({
      vector: embedDeterministic(text),
      tokens: approximateTokens(text),
      model: MEMORY_EMBEDDING_MODEL,
    });
  }
}
