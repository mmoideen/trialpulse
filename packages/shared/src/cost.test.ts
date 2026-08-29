import { describe, expect, it } from 'vitest';
import { approximateTokens, estimateCost, isKnownModel, MODEL_PRICING } from './cost';

describe('estimateCost', () => {
  it('prices a gpt-4o call from the published rate card', () => {
    // 1000 in @ $0.0025/1k + 500 out @ $0.01/1k = 0.0025 + 0.005
    expect(estimateCost('gpt-4o', 1000, 500)).toBeCloseTo(0.0075, 6);
  });

  it('prices gpt-4o-mini far below gpt-4o for identical usage', () => {
    const full = estimateCost('gpt-4o', 2000, 800);
    const mini = estimateCost('gpt-4o-mini', 2000, 800);
    expect(mini).toBeLessThan(full);
    expect(mini).toBeGreaterThan(0);
  });

  it('charges nothing for embedding output tokens', () => {
    expect(MODEL_PRICING['text-embedding-3-large'].outputPer1k).toBe(0);
    expect(estimateCost('text-embedding-3-large', 1000, 999)).toBeCloseTo(0.00013, 6);
  });

  it('returns zero for an unpriced model rather than throwing', () => {
    expect(estimateCost('gpt-5-imaginary', 1000, 1000)).toBe(0);
    expect(isKnownModel('gpt-5-imaginary')).toBe(false);
    expect(isKnownModel('gpt-4o')).toBe(true);
  });

  it('rounds to six decimal places so float sums stay stable', () => {
    const cost = estimateCost('gpt-4o-mini', 7, 3);
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost.toString().split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
  });

  it('handles zero usage', () => {
    expect(estimateCost('gpt-4o', 0, 0)).toBe(0);
  });
});

describe('approximateTokens', () => {
  it('returns zero for empty input', () => {
    expect(approximateTokens('')).toBe(0);
  });

  it('scales roughly with length', () => {
    expect(approximateTokens('a'.repeat(400))).toBe(100);
    expect(approximateTokens('a'.repeat(401))).toBe(101);
  });
});
