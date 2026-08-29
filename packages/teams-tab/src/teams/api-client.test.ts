import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './api-client';
import type { AuthProvider } from './auth';

function makeAuthProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  return {
    getToken: vi.fn().mockResolvedValue('token'),
    invalidate: vi.fn(),
    getIdentity: vi.fn(),
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('ApiClient', () => {
  it('attaches the bearer token to every request', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }));
    const client = new ApiClient(auth, { fetchImpl });

    await client.getDocument('doc-1');

    const [, init] = fetchImpl.mock.calls.at(-1)!;
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer token');
  });

  it('retries exactly once after a 401, forcing a fresh token, and succeeds', async () => {
    const auth = makeAuthProvider({
      getToken: vi
        .fn()
        .mockResolvedValueOnce('stale-token')
        .mockResolvedValueOnce('fresh-token'),
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ document_id: 'doc-1' }));
    const client = new ApiClient(auth, { fetchImpl });

    const result = await client.getDocument('doc-1');

    expect(result).toEqual({ document_id: 'doc-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(auth.invalidate).toHaveBeenCalledTimes(1);
    expect(auth.getToken).toHaveBeenNthCalledWith(1, false);
    expect(auth.getToken).toHaveBeenNthCalledWith(2, true);
    const secondCallHeaders = new Headers(fetchImpl.mock.calls[1]![1].headers);
    expect(secondCallHeaders.get('Authorization')).toBe('Bearer fresh-token');
  });

  it('surfaces a second consecutive 401 as an unauthorized ApiError without a third attempt', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const client = new ApiClient(auth, { fetchImpl });

    await expect(client.getDocument('doc-1')).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'unauthorized',
      status: 401,
    } satisfies Partial<ApiError>);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('maps 403 to a forbidden ApiError', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const client = new ApiClient(auth, { fetchImpl });

    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('maps 429 to a rate_limited ApiError and surfaces a retry hint from Retry-After', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': '30' } }));
    const client = new ApiClient(auth, { fetchImpl });

    await expect(client.getDocument('doc-1')).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
      retryAfterMs: 30_000,
    });
  });

  it('maps a 5xx response to a server_error ApiError', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const client = new ApiClient(auth, { fetchImpl });

    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ kind: 'server_error', status: 503 });
  });

  it('aborts the request and throws a timeout ApiError once the client-side timeout elapses', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new DOMException('Aborted', 'AbortError');
            reject(err);
          });
        }),
    );
    const client = new ApiClient(auth, { fetchImpl, timeoutMs: 5 });

    await expect(client.getDocument('doc-1')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('skips auth entirely for health checks', async () => {
    const auth = makeAuthProvider();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok' }));
    const client = new ApiClient(auth, { fetchImpl });

    await client.health();

    expect(auth.getToken).not.toHaveBeenCalled();
  });

  it('never logs the token', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const auth = makeAuthProvider({ getToken: vi.fn().mockResolvedValue('super-secret-token') });
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ document_id: 'doc-1' }));
    const client = new ApiClient(auth, { fetchImpl });

    await client.getDocument('doc-1');

    for (const call of consoleSpy.mock.calls) {
      expect(call.join(' ')).not.toContain('super-secret-token');
    }
    consoleSpy.mockRestore();
  });
});
