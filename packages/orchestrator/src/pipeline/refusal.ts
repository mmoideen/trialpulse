/**
 * The canonical refusal message builder.
 *
 * PRD decision 3 mandates one exact wording for "no relevant chunks":
 * "I cannot find information about [topic] in the documents you are
 * authorized to access." Every call site (no chunks after search, all
 * chunks stripped by the defence-in-depth RBAC check) MUST go through this
 * module so the wording never drifts between code paths -- a compliance
 * reviewer scanning audit logs should see one refusal sentence shape, not
 * three subtly different ones.
 *
 * Injection-blocked queries get a deliberately different, topic-free
 * message: reflecting the caller's own (potentially adversarial) query text
 * back into a "cannot find information about X" sentence would both look
 * strange and risk echoing injected content back into a UI surface.
 */

/**
 * D12: this refusal text interpolates the raw query. The web tab renders it
 * as a React text node (auto-escaped, safe), but `bot/cards.ts` puts it in
 * an Adaptive Card `TextBlock` with `wrap: true`, which Teams renders as
 * **Markdown** -- so a query like
 * `[Meridian IT: verify your account](https://evil.example)` becomes a real,
 * clickable phishing link inside a card posted by the trusted bot, visible
 * to a whole channel. One shared refusal builder serves both surfaces, so
 * the query is sanitised here once rather than trusting each surface to
 * remember to do it.
 */
function sanitizeEchoedTopic(topic: string): string {
  // Strip markdown link/image syntax -- `[text](url)` / `![alt](url)` --
  // keeping the visible text but dropping the URL entirely.
  let sanitized = topic.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Defang any remaining bare URL too: several Markdown renderers
  // (including Teams') autolink plain http(s) URLs even without bracket
  // syntax.
  sanitized = sanitized.replace(/\bhttps?:\/\/\S+/gi, '[link removed]');
  return sanitized;
}

/**
 * Derive a short "topic" phrase from the user's query for the refusal
 * template. We use the query itself (trimmed of trailing punctuation) rather
 * than attempting topic extraction: it is deterministic, always defined for
 * a query that has already passed `queryRequestSchema`, and it is exactly
 * what the user asked about.
 */
function deriveTopic(query: string): string {
  const trimmed = sanitizeEchoedTopic(query.trim().replace(/[?.!]+$/, ''));
  return trimmed.length > 0 ? trimmed : 'that topic';
}

/** PRD decision 3's exact refusal template, for when no chunk cleared the relevance bar. */
export function buildNoChunksRefusal(query: string): string {
  return `I cannot find information about ${deriveTopic(query)} in the documents you are authorized to access.`;
}

/**
 * Used when the defence-in-depth authorisation check (`isChunkAuthorized`)
 * strips every retrieved chunk -- i.e. the search filter itself should have
 * prevented this, and it didn't. The user experience is identical to the
 * ordinary "no chunks" refusal (we never want the wording to hint that an
 * RBAC bug just occurred), but the caller records a distinct
 * `refusal_reason` for compliance review.
 */
export function buildNoAuthorizedDocumentsRefusal(query: string): string {
  return buildNoChunksRefusal(query);
}

/**
 * Used when `scanForInjection` flags the query as blockable. Deliberately
 * does not echo the query back.
 */
export function buildInjectionRefusal(): string {
  return (
    'This request cannot be processed because it appears to attempt to override system ' +
    'instructions or bypass access controls. Please rephrase your question about the ' +
    'clinical trial documents you are authorized to access.'
  );
}

/**
 * D5(a): used when the cost hard-stop flag is active (see
 * `pipeline/model-router.ts`'s `COST_HARD_STOP_CACHE_KEY`). Deliberately
 * does not echo the query back, for the same reason `buildInjectionRefusal`
 * does not -- and because this is a system-wide condition, not a property
 * of this particular question.
 */
export function buildCostHardStopRefusal(): string {
  return (
    'TrialPulse has paused answering new questions because today\'s usage has significantly ' +
    'exceeded its cost budget. Your IT administrator has been notified; please try again later ' +
    'or contact them if this is urgent.'
  );
}
