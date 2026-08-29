/**
 * `POST /api/query` -- the orchestrator's core endpoint. Auth required.
 * Everything else (validation, injection scanning, RBAC, redaction,
 * generation, citations, audit) happens inside `createQueryPipeline`.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { QueryRequest } from '@trialpulse/shared';
import type { AppDeps } from './deps';
import { mapErrorToResponse, newTraceId, type HttpResult } from './http-utils';
import { requireIdentity } from './http-utils';

export async function handleQuery(deps: AppDeps, headers: HttpRequest['headers'], body: unknown): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    const response = await deps.pipeline.execute(identity, body as QueryRequest);
    return { status: 200, jsonBody: response };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerQueryFunction(deps: AppDeps): void {
  app.http('query', {
    methods: ['POST'],
    route: 'query',
    authLevel: 'anonymous', // Entra JWT is validated in-handler; see module doc.
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const body = await request.json().catch(() => ({}));
      const result = await handleQuery(deps, request.headers, body);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
