/**
 * `POST /api/webhooks/sharepoint` -- SharePoint change notification webhook.
 *
 * Two distinct behaviours, per Microsoft Graph/SharePoint webhook semantics:
 *
 *  1. Validation handshake: when SharePoint registers (or SharePoint's
 *     periodic health check re-validates) the subscription, it calls this
 *     endpoint with a `validationtoken` query parameter and no meaningful
 *     body. We must echo that token back as `text/plain` with a 200 --
 *     anything else and SharePoint tears the subscription down.
 *
 *  2. Notifications: SharePoint POSTs a batch of change notifications, each
 *     carrying a `clientState` that must match the shared secret we
 *     registered the subscription with. Mismatches are rejected with a
 *     **202**, not 401: SharePoint's retry/backoff behaviour on webhook
 *     delivery treats a non-2xx response as "endpoint is unhealthy" and
 *     will aggressively retry and eventually disable the subscription --
 *     which would make a single forged or misconfigured notification able
 *     to take down real delivery. A 202 tells SharePoint "received,
 *     nothing more to do here" while we drop the payload and audit the
 *     mismatch server-side instead of surfacing it as a webhook failure.
 *
 * D12/F5 -- this endpoint does not enqueue ingestion work, and should not
 * be the live Microsoft Graph subscription target. `ingestion/function_app.py`
 * implements the same route with real Graph credentials, `clientState`
 * enforcement, and correct, Graph-validated `IngestionJob` enqueuing onto
 * the one provisioned queue (`ingestion-work`) -- see
 * `ingestion/README.md`'s "Which app owns the SharePoint webhook
 * subscription", which explicitly leaves the choice of "repoint this
 * endpoint's queue producer at the real queue" vs. "retire it" to whoever
 * owns this file. Repointing would still require fabricating a `site_id`/
 * `drive_id`/Graph `item_id` this app has no credentials to resolve or
 * validate -- exactly what that document says must never be hand-crafted.
 * Retired: this handler now only performs the SharePoint-facing handshake
 * and `clientState` bookkeeping (still real security surface -- SharePoint,
 * or an attacker, can still reach this URL) and logs what it saw, without
 * ever queueing a job this app cannot correctly construct.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { sharePointNotificationSchema } from '@trialpulse/shared';
import type { AppDeps } from './deps';
import { newTraceId, textResult, timingSafeStringEqual, type HttpResult } from './http-utils';

/**
 * D12: always the same body regardless of what happened -- a malformed
 * payload, an invalid `clientState`, a validated notification, or an
 * unexpected internal error are all indistinguishable to the caller. Two
 * independent reasons this matters:
 *  - Publishing whether `clientState` matched (the old `{ accepted:
 *    anyValid }`) to an unauthenticated caller undoes the constant-time
 *    comparison's whole point -- an attacker who can distinguish the two
 *    outcomes can still brute-force the secret one request at a time, just
 *    without a *timing* side-channel.
 *  - Returning a different HTTP status for "unhandled error" (previously
 *    an uncaught 500, since this handler had no try/catch) than for
 *    "clientState mismatch" (202) is a status-code oracle, and a non-2xx
 *    response is exactly what makes SharePoint eventually delete the
 *    subscription -- the one outcome the 202-on-mismatch design exists to
 *    prevent in the first place.
 */
const ACK_BODY = { received: true } as const;

export async function handleSharePointWebhook(
  deps: AppDeps,
  query: { validationtoken?: string },
  body: unknown,
): Promise<HttpResult> {
  const traceId = newTraceId();

  if (query.validationtoken) {
    return textResult(200, query.validationtoken);
  }

  try {
    const parsed = sharePointNotificationSchema.safeParse(body);
    if (!parsed.success) {
      deps.logger.log('warn', 'sharepoint webhook payload failed schema validation', { trace_id: traceId });
      return { status: 202, jsonBody: ACK_BODY };
    }

    for (const notification of parsed.data.value) {
      const isValid =
        typeof notification.clientState === 'string' &&
        timingSafeStringEqual(notification.clientState, deps.config.sharePoint.clientState);

      if (!isValid) {
        deps.logger.log('warn', 'sharepoint webhook clientState mismatch, dropping notification', {
          trace_id: traceId,
          subscription_id: notification.subscriptionId,
        });
        continue;
      }
      // See module doc: intentionally not enqueued. Logged so the
      // notification is still auditable even though nothing is queued.
      deps.logger.log('info', 'sharepoint webhook notification validated (not enqueued; see module doc)', {
        trace_id: traceId,
        subscription_id: notification.subscriptionId,
        resource: notification.resource,
      });
    }

    return { status: 202, jsonBody: ACK_BODY };
  } catch (err) {
    deps.logger.log('error', 'unhandled error in sharepoint webhook handler', { trace_id: traceId, error: String(err) });
    return { status: 202, jsonBody: ACK_BODY };
  }
}

export function registerSharePointWebhookFunction(deps: AppDeps): void {
  app.http('sharepointWebhook', {
    methods: ['POST', 'GET'],
    route: 'webhooks/sharepoint',
    authLevel: 'anonymous', // SharePoint cannot present an Entra JWT; clientState is the auth mechanism.
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const validationtoken = request.query.get('validationtoken') ?? undefined;
      const body = validationtoken ? undefined : await request.json().catch(() => ({}));
      const result = await handleSharePointWebhook(deps, { validationtoken }, body);
      if (result.textBody !== undefined) {
        return { status: result.status, body: result.textBody, headers: { 'Content-Type': 'text/plain' } };
      }
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
