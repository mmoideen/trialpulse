import { describe, expect, it, vi } from 'vitest';
import { isLikelyTransientAzureError, withRetry } from './retry';

describe('withRetry', () => {
  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { sleep: async () => undefined });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxAttempts on failure, then throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('boom'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(withRetry(fn, { maxAttempts: 3, sleep })).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // slept between attempts 1->2 and 2->3, not after the last
  });

  it('succeeds after a transient failure on a later attempt', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('recovered');
    const result = await withRetry(fn, { sleep: async () => undefined });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry when isRetryable returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('permanent'));
    const sleep = vi.fn();
    await expect(withRetry(fn, { isRetryable: () => false, sleep })).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('isLikelyTransientAzureError', () => {
  it('treats 429 as transient', () => {
    expect(isLikelyTransientAzureError({ statusCode: 429 })).toBe(true);
  });

  it('treats 500 and above as transient', () => {
    expect(isLikelyTransientAzureError({ statusCode: 503 })).toBe(true);
  });

  it('treats 404 as not transient', () => {
    expect(isLikelyTransientAzureError({ statusCode: 404 })).toBe(false);
  });

  it('treats known transient network error codes as transient', () => {
    expect(isLikelyTransientAzureError({ code: 'ETIMEDOUT' })).toBe(true);
  });

  it('treats an unrecognised error as not transient', () => {
    expect(isLikelyTransientAzureError(new Error('some app error'))).toBe(false);
  });
});
