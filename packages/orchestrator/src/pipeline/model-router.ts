/**
 * Model routing (PRD section 9, "Cost control").
 *
 * "Use GPT-4o-mini for all queries under 100 tokens unless the user is an
 * executive or the query contains keywords like 'safety' or 'regulatory'
 * that require higher reasoning" -- plus a hard, cost-driven global
 * downgrade for non-executive traffic (PRD 3.3.3).
 *
 * Pure function: no I/O, no clock, no config object. `query-pipeline.ts`
 * resolves `downgradeActive` (from a cache-backed flag the hourly cost-alert
 * timer sets) and maps the returned tier to an actual deployment name.
 */
import { approximateTokens, HIGH_REASONING_KEYWORDS, MINI_MODEL_TOKEN_THRESHOLD, type Role } from '@trialpulse/shared';

export type ModelTier = 'mini' | 'full';

/**
 * Cache key the hourly cost-alert timer (`functions/timers.ts`) sets to
 * `true` when rolling daily spend exceeds `DAILY_COST_HARD_CAP_USD`, and that
 * `query-pipeline.ts` reads before every routing decision. Using the
 * already-shared `CacheProvider` for this (rather than adding a new provider
 * interface, which is frozen) keeps the timer and the pipeline decoupled.
 */
export const COST_DOWNGRADE_CACHE_KEY = 'trialpulse:cost_downgrade_active';

/**
 * D5(a): cache key the cost-alert timer sets to `true` when rolling daily
 * spend exceeds `dailyCostCapUsd * DAILY_COST_HARD_STOP_MULTIPLIER`.
 * `query-pipeline.ts` checks this *before any billable work happens at
 * all* (before the embedding call, before search) and refuses the query
 * outright when set -- the downgrade flag above only ever makes a query
 * cheaper, never zero-cost, so it cannot be the thing that actually stops
 * spend during a burst.
 */
export const COST_HARD_STOP_CACHE_KEY = 'trialpulse:cost_hard_stop_active';

export interface ModelRouteInput {
  role: Role;
  query: string;
  /** True when the rolling daily spend has exceeded `DAILY_COST_HARD_CAP_USD`. */
  downgradeActive: boolean;
}

// D5(c): a plain `String.includes` substring match let 'ind' fire on find,
// kind, index, binding, individual, indication, window, remind -- and 'nda'
// on agenda, calendar -- routing ordinary short queries to the ~17x more
// expensive full model as a matter of routine, and letting anyone trivially
// force the expensive model on demand by including any of those common
// words. Word-boundary matching (case-insensitively) keeps every existing
// legitimate match (e.g. "safety", "regulatory", "SAE") while eliminating
// the substring false positives.
function containsHighReasoningKeyword(query: string): boolean {
  return HIGH_REASONING_KEYWORDS.some((keyword) => {
    const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(query);
  });
}

export function routeModel(input: ModelRouteInput): ModelTier {
  const { role, query, downgradeActive } = input;

  // D5(b): the hard cost cap must apply to *every* role, including
  // executive -- previously `role !== 'executive'` scoped the downgrade so
  // the one role PRD 9 unconditionally routes to the expensive model was
  // also the one role the daily hard cap could never touch, making a
  // denial-of-wallet burst from (or targeting) executive traffic
  // structurally unstoppable by this control. Checked before the
  // executive override below, and before length/keyword signals, so it is
  // a true override in every case, for every role.
  if (downgradeActive) {
    return 'mini';
  }

  // Executives always get the higher-reasoning model: PRD 9 lists "the user
  // is an executive" as an unconditional override, matching Executive
  // Briefing Mode's cross-document synthesis needs (feature 3.2.5) --
  // unconditional with respect to query length/keywords, but not with
  // respect to the hard cost cap above.
  if (role === 'executive') {
    return 'full';
  }

  if (containsHighReasoningKeyword(query)) {
    return 'full';
  }

  return approximateTokens(query) < MINI_MODEL_TOKEN_THRESHOLD ? 'mini' : 'full';
}
