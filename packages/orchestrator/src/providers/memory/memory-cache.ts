/**
 * In-memory `CacheProvider` for local dev, unit tests and the eval harness.
 *
 * TTL is honoured against an injected `Clock` rather than `Date.now()` so
 * tests can advance time deterministically instead of sleeping.
 */
import type { CacheProvider, Clock } from '../types';

interface CacheEntry {
  value: unknown;
  expiresAtMs: number;
}

export class MemoryCacheProvider implements CacheProvider {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly clock: Clock) {}

  get<T>(key: string): Promise<T | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    if (this.clock.now().getTime() >= entry.expiresAtMs) {
      this.store.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value as T);
  }

  set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAtMs: this.clock.now().getTime() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  /** Test/local-only affordance: number of entries currently stored, expired or not. */
  size(): number {
    return this.store.size;
  }
}
