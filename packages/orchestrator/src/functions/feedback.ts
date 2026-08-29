/**
 * `POST /api/feedback` -- thumbs up/down on a previous answer (PRD 6.1's
 * "Was this helpful?" control).
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { feedbackRequestSchema } from '@trialpulse/shared';
import type { AppDeps } from './deps';
import { HttpError, mapErrorToResponse, newTraceId, requireIdentity, type HttpResult } from './http-utils';

export async function handleFeedback(deps: AppDeps, headers: HttpRequest['headers'], body: unknown): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    const parsed = feedbackRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'Invalid feedback request.', 'invalid_request');
    }
    const recorded = await deps.conversations.recordFeedback(
      parsed.data.turn_id,
      identity.user_principal_name,
      parsed.data.feedback,
    );
    if (!recorded) {
      // Either the turn does not exist or it belongs to someone else --
      // same response either way, for the same existence-probing reason as
      // /api/documents/{id}.
      throw new HttpError(404, 'Conversation turn not found.', 'not_found');
    }
    // D7: the published client contract
    // (`packages/teams-tab/src/teams/api-client.ts`'s `FeedbackResponse`)
    // declares `{ turn_id, feedback }`, echoing back what was recorded --
    // this used to return `{ recorded: true }` instead. Harmless today only
    // because the tab discards the value; match the contract regardless.
    return { status: 200, jsonBody: { turn_id: parsed.data.turn_id, feedback: parsed.data.feedback } };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerFeedbackFunction(deps: AppDeps): void {
  app.http('feedback', {
    methods: ['POST'],
    route: 'feedback',
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const body = await request.json().catch(() => ({}));
      const result = await handleFeedback(deps, request.headers, body);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
