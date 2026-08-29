import { describe, expect, it } from 'vitest';
import type { Clock } from '../providers/types';
import { CircuitBreaker } from './circuit-breaker';

class FakeClock implements Clock {
  private current: number;
  constructor(startMs: number) {
    this.current = startMs;
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

describe('CircuitBreaker', () => {
  it('starts closed', () => {
    const breaker = new CircuitBreaker(new FakeClock(0), 3, 5 * 60 * 1000);
    expect(breaker.state()).toBe('closed');
    expect(breaker.shouldBypassPrimary()).toBe(false);
  });

  it('stays closed for fewer than the failure threshold', () => {
    const breaker = new CircuitBreaker(new FakeClock(0), 3, 5 * 60 * 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    expect(breaker.shouldBypassPrimary()).toBe(false);
  });

  it('opens on the Nth consecutive failure', () => {
    const breaker = new CircuitBreaker(new FakeClock(0), 3, 5 * 60 * 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.shouldBypassPrimary()).toBe(true);
  });

  it('a success before reaching the threshold resets the failure count', () => {
    const breaker = new CircuitBreaker(new FakeClock(0), 3, 5 * 60 * 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('transitions to half_open once the cooldown elapses', () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(clock, 3, 5 * 60 * 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('open');

    clock.advance(5 * 60 * 1000 - 1);
    expect(breaker.state()).toBe('open');

    clock.advance(1);
    expect(breaker.state()).toBe('half_open');
    expect(breaker.shouldBypassPrimary()).toBe(false);
  });

  it('a successful half-open probe fully closes the breaker', () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(clock, 3, 5 * 60 * 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(5 * 60 * 1000);
    expect(breaker.state()).toBe('half_open');

    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.shouldBypassPrimary()).toBe(false);
  });

  it('a failed half-open probe re-opens the breaker for a fresh cooldown', () => {
    const clock = new FakeClock(0);
    const breaker = new CircuitBreaker(clock, 3, 5 * 60 * 1000);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    clock.advance(5 * 60 * 1000);
    expect(breaker.state()).toBe('half_open');

    breaker.recordFailure(); // failed probe
    expect(breaker.state()).toBe('open');

    clock.advance(5 * 60 * 1000 - 1);
    expect(breaker.state()).toBe('open');
    clock.advance(1);
    expect(breaker.state()).toBe('half_open');
  });
});
