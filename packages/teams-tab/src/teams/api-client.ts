/**
 * Typed fetch wrapper for the TrialPulse orchestrator API.
 *
 * - Attaches the bearer token from an `AuthProvider` to every request.
 * - On a 401, invalidates the cached token and retries exactly once with a
 *   freshly fetched token; a second 401 is surfaced as an error.
 * - Distinguishes 403 (forbidden), 429 (rate limited, with a retry hint),
 *   and 5xx (server error) so the UI can render the right message.
 * - Enforces a client-side timeout via AbortController.
 * - Never logs the token, request headers, or Authorization value.
 */
import type {
  ConversationTurn,
  DailySummary,
  DocumentStatus,
  QueryRequest,
  QueryResponse,
  Role,
} from '@trialpulse/shared';
import type { AuthProvider } from './auth';

export type ApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'unknown';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  /** Present for 429 responses that carried a Retry-After header. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    kind: ApiErrorKind,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ConversationPage {
  turns: ConversationTurn[];
  continuation: string | null;
}

export interface UsageResponse {
  summaries: DailySummary[];
  top_queries: Array<{
    query_hash: string;
    role: Role;
    cost_usd: number;
    latency_ms: number;
    count: number;
  }>;
}

export interface FeedbackResponse {
  turn_id: string;
  feedback: 'up' | 'down';
}

export interface ApiClientOptions {
  baseUrl?: string;
  /** Request timeout in ms before the in-flight fetch is aborted. Default 20s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export class ApiClient {
  private readonly authProvider: AuthProvider;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(authProvider: AuthProvider, options: ApiClientOptions = {}) {
    this.authProvider = authProvider;
    this.baseUrl = options.baseUrl ?? '';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  }

  async query(request: QueryRequest): Promise<QueryResponse> {
    return this.request<QueryResponse>('/api/query', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  async getDocument(id: string): Promise<DocumentStatus> {
    return this.request<DocumentStatus>(`/api/documents/${encodeURIComponent(id)}`);
  }

  /**
   * Lists documents visible to the caller's role. This extends the
   * `/api/documents/{id}` route from the published contract with its natural
   * plural counterpart; see teams-tab delivery notes for why.
   */
  async listDocuments(): Promise<DocumentStatus[]> {
    return this.request<DocumentStatus[]>('/api/documents');
  }

  async getConversation(
    conversationId: string,
    params: { limit?: number; continuation?: string | null } = {},
  ): Promise<ConversationPage> {
    const search = new URLSearchParams();
    if (params.limit != null) search.set('limit', String(params.limit));
    if (params.continuation) search.set('continuation', params.continuation);
    const qs = search.toString();
    return this.request<ConversationPage>(
      `/api/conversations/${encodeURIComponent(conversationId)}${qs ? `?${qs}` : ''}`,
    );
  }

  async submitFeedback(turnId: string, feedback: 'up' | 'down'): Promise<FeedbackResponse> {
    return this.request<FeedbackResponse>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ turn_id: turnId, feedback }),
    });
  }

  async getUsage(params: { from?: string; to?: string; role?: Role } = {}): Promise<UsageResponse> {
    const search = new URLSearchParams();
    if (params.from) search.set('from', params.from);
    if (params.to) search.set('to', params.to);
    if (params.role) search.set('role', params.role);
    const qs = search.toString();
    return this.request<UsageResponse>(`/api/admin/usage${qs ? `?${qs}` : ''}`);
  }

  async health(): Promise<{ status: string }> {
    return this.request<{ status: string }>('/api/health', { skipAuth: true });
  }

  private async request<T>(
    path: string,
    init: RequestInit & { skipAuth?: boolean } = {},
    attempt = 0,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(init.headers);
      headers.set('Accept', 'application/json');
      if (init.body && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }

      if (!init.skipAuth) {
        const token = await this.authProvider.getToken(attempt > 0);
        headers.set('Authorization', `Bearer ${token}`);
        const extra = this.authProvider.getExtraHeaders?.();
        if (extra) {
          for (const [key, value] of Object.entries(extra)) headers.set(key, value);
        }
      }

      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers,
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new ApiError('The request took too long and was cancelled.', 'timeout');
        }
        throw new ApiError('Could not reach TrialPulse. Check your connection.', 'network');
      }

      if (response.status === 401) {
        if (attempt === 0) {
          this.authProvider.invalidate();
          return this.request<T>(path, init, attempt + 1);
        }
        throw new ApiError('Your session expired. Please sign in again.', 'unauthorized', 401);
      }

      if (response.status === 403) {
        throw new ApiError(
          "You don't have permission to do that.",
          'forbidden',
          403,
        );
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        throw new ApiError(
          retryAfterMs
            ? `TrialPulse is busy. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`
            : 'TrialPulse is busy. Please try again shortly.',
          'rate_limited',
          429,
          retryAfterMs,
        );
      }

      if (response.status >= 500) {
        throw new ApiError(
          'TrialPulse is having trouble responding right now.',
          'server_error',
          response.status,
        );
      }

      if (!response.ok) {
        throw new ApiError(`Request failed (${response.status}).`, 'unknown', response.status);
      }

      if (response.status === 204) {
        return undefined as T;
      }

      try {
        return (await response.json()) as T;
      } catch {
        throw new ApiError('Received an unexpected response from TrialPulse.', 'invalid_response');
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createApiClient(authProvider: AuthProvider, options?: ApiClientOptions): ApiClient {
  return new ApiClient(authProvider, options);
}
