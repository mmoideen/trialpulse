/**
 * Circuit breaker for the Azure OpenAI generation call (PRD section 9,
 * "Reliability"): "If 3 consecutive failures occur, fall back to GPT-4o-mini
 * for 5 minutes before retrying the primary model."
 *
 * This class tracks the *primary* (full) model only. Routing to mini because
 * `model-router.ts` chose mini for cost/role reasons never touches this
 * state -- only an actual failed call to the full model does.
 *
 * State machine:
 *   closed    -- primary model calls proceed normally.
 *   open      -- `shouldBypassPrimary()` returns true; every call is routed
 *                to mini without attempting the primary model at all.
 *   half_open -- the cooldown has elapsed; `shouldBypassPrimary()` returns
 *                false again so exactly the next primary attempts act as a
 *                probe. A probe failure re-opens the breaker for another
 *                full cooldown (measured from that failure); a probe success
 *                closes it and resets the failure count.
 */
import { CIRCUIT_BREAKER_COOLDOWN_MS, CIRCUIT_BREAKER_FAILURE_THRESHOLD } from '@trialpulse/shared';
import type { Clock } from '../providers/types';

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAtMs: number | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly failureThreshold: number = CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    private readonly cooldownMs: number = CIRCUIT_BREAKER_COOLDOWN_MS,
  ) {}

  state(): CircuitState {
    if (this.openedAtMs === null) return 'closed';
    const elapsed = this.clock.now().getTime() - this.openedAtMs;
    return elapsed >= this.cooldownMs ? 'half_open' : 'open';
  }

  /** True when the caller should skip the primary model and use mini instead. */
  shouldBypassPrimary(): boolean {
    return this.state() === 'open';
  }

  /** Record a successful primary-model call: fully resets the breaker. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAtMs = null;
  }

  /** Record a failed primary-model call (including a failed half-open probe). */
  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      // Opens on the Nth failure, and re-opens (restarting the cooldown
      // clock) on every subsequent failure while already past the
      // threshold -- including a failed half-open probe.
      this.openedAtMs = this.clock.now().getTime();
    }
  }
}
