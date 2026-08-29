/**
 * `GET /api/conversations/{id}` -- paginated at `CONVERSATION_PAGE_SIZE` by
 * default. A caller may only read their own conversation:
 * `ConversationStore.list` scopes every query to the authenticated caller's
 * `user_principal_name`, so requesting someone else's conversation id
 * simply returns an empty page rather than another user's turns or a
 * distinguishing error.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { AppDeps } from './deps';
import { mapErrorToResponse, newTraceId, requireIdentity, type HttpResult } from './http-utils';

/**
 * D10: the client (`api-client.ts`'s `getConversation`) sends `limit` as a
 * query parameter, but this handler used to read only `continuation`,
 * silently dropping it -- page size was always `CONVERSATION_PAGE_SIZE`
 * regardless of what the caller asked for. Honoured now, bounded so a
 * caller cannot request an unbounded page.
 */
const MAX_CONVERSATION_PAGE_SIZE = 100;

/** `undefined` (fall back to the store's own default) for anything absent, non-numeric, or out of range; otherwise clamped to the max. */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, MAX_CONVERSATION_PAGE_SIZE);
}

export async function handleGetConversation(
  deps: AppDeps,
  headers: HttpRequest['headers'],
  conversationId: string,
  continuation: string | undefined,
  rawLimit?: string,
): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    const limit = parseLimit(rawLimit);
    const page = await deps.conversations.list(conversationId, identity.user_principal_name, {
      continuation,
      ...(limit !== undefined ? { limit } : {}),
    });
    return { status: 200, jsonBody: page };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerConversationsFunction(deps: AppDeps): void {
  app.http('getConversation', {
    methods: ['GET'],
    route: 'conversations/{id}',
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const result = await handleGetConversation(
        deps,
        request.headers,
        request.params['id'] ?? '',
        request.query.get('continuation') ?? undefined,
        request.query.get('limit') ?? undefined,
      );
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
