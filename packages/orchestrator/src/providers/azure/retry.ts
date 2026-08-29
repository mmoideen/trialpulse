/**
 * Exponential backoff with jitter for transient Azure failures (throttling,
 * transient network errors, 5xx responses). Shared by every Azure-backed
 * provider so retry behaviour is consistent and centrally tunable.
 *
 * Mirrors the ingestion pipeline's retry policy (PRD 3.3.1: "Exponential
 * backoff with 3 retries for transient failures").
 */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Decide whether an error is worth retrying at all. Defaults to "always". */
  isRetryable?: (error: unknown) => boolean;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Common shape of throttling/transient errors surfaced by Azure SDKs. */
export function isLikelyTransientAzureError(error: unknown): boolean {
  const status =
    (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { statusCode?: number; status?: number } | null)?.status;
  if (typeof status === 'number') {
    // 429 (throttled), 408 (timeout), and any 5xx are worth retrying.
    return status === 429 || status === 408 || status >= 500;
  }
  const code = (error as { code?: string } | null)?.code;
  return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNABORTED';
}

/** Retry `fn` with exponential backoff and jitter, up to `maxAttempts` total attempts. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const capped = Math.min(exponential, maxDelayMs);
      // Full jitter: uniform random delay in [0, capped], which spreads out
      // retries from many concurrent callers rather than causing a
      // thundering-herd retry burst against an already-throttling service.
      const delay = Math.random() * capped;
      await sleep(delay);
    }
  }
  // Unreachable: the loop always returns or throws, but TypeScript can't
  // prove that without this.
  throw lastError;
}
