import { describe, expect, it } from 'vitest';
import type { Clock } from '../types';
import { MemoryCacheProvider } from './memory-cache';

class FakeClock implements Clock {
  private current: number;
  constructor(startMs = 0) {
    this.current = startMs;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

describe('MemoryCacheProvider', () => {
  it('returns null for a missing key', async () => {
    const cache = new MemoryCacheProvider(new FakeClock());
    expect(await cache.get('missing')).toBeNull();
  });

  it('stores and retrieves a value before expiry', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    await cache.set('k', { hello: 'world' }, 60);
    clock.advance(59_000);
    expect(await cache.get('k')).toEqual({ hello: 'world' });
  });

  it('expires a value exactly at the TTL boundary, honouring the injected clock', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    await cache.set('k', 'v', 60);
    clock.advance(60_000);
    expect(await cache.get('k')).toBeNull();
  });

  it('removes the expired entry from storage on read (does not leak memory)', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    await cache.set('k', 'v', 1);
    clock.advance(1_000);
    await cache.get('k');
    expect(cache.size()).toBe(0);
  });

  it('overwrites an existing key with a new value and TTL', async () => {
    const clock = new FakeClock();
    const cache = new MemoryCacheProvider(clock);
    await cache.set('k', 'first', 10);
    await cache.set('k', 'second', 10);
    expect(await cache.get('k')).toBe('second');
  });
});
