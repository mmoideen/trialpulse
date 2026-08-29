/**
 * `POST /api/admin/reindex` -- `it_admin` only. Validates the request and
 * enqueues re-ingestion job(s); it never touches the search index directly
 * (PRD 3.3.1: ingestion is queue-driven, decoupled from query availability).
 *
 * D12/F5: this used to enqueue onto `reindex-jobs`, a queue nothing
 * consumes (`infra/modules/storage.bicep` provisions exactly one ingestion
 * queue, `ingestion-work`, whose name flows to both apps as
 * `TRIALPULSE_INGEST_QUEUE`; see `ingestion/README.md`'s "Ingestion queue
 * contract"). Fixed to enqueue onto the real queue, in the exact shape
 * `ingestion/function_app.py`'s `ingest_document_queue` consumes --
 * `IngestionJob(**json.loads(...))`, exactly `{site_id, drive_id, item_id,
 * reason}`, no more, no fewer, or that call raises `TypeError`.
 *
 * One real gap remains, called out rather than silently worked around:
 * this app has no Microsoft Graph credentials and no stored mapping from a
 * TrialPulse `document_id` to a Graph drive-item id (`DocumentStatus` --
 * `packages/shared/src/types.ts` -- carries a `source_url`, not a Graph
 * item id). `item_id` below is therefore the `document_id` itself, which
 * is almost certainly *not* a valid Graph item id. Unlike the SharePoint
 * webhook/delta-sync producers (retired -- see `webhooks-sharepoint.ts` and
 * `timers.ts`), this one is kept enqueuing rather than retired, because
 * `POST /api/admin/reindex` is a distinct, orchestrator-owned feature with
 * no ingestion-side equivalent, and the pipeline's own retry/dead-letter
 * design (`ingestion/trialpulse_ingest/retry.py`) already fails an
 * unresolvable item safely and observably rather than corrupting anything.
 * Follow-up: either the ingestion side exposes a real `document_id` ->
 * Graph item id lookup, or this endpoint's contract changes to accept a
 * real item id from the caller.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { canAccessAdminApi, reindexRequestSchema, type ReindexRequestInput } from '@trialpulse/shared';
import { AuthError } from '../auth/errors';
import type { AppDeps } from './deps';
import { HttpError, mapErrorToResponse, newTraceId, requireIdentity, type HttpResult } from './http-utils';

/** Exactly `ingestion/trialpulse_ingest/sharepoint.IngestionJob`'s field set -- see module doc. Never add a field here without adding it there too. */
interface IngestionJobMessage {
  site_id: string;
  drive_id: string;
  item_id: string;
  reason: string;
}

const ADMIN_REINDEX_REASON = 'admin_reindex';

/** One job per resolvable target. See module doc for the `item_id` caveat. */
function buildJobMessages(deps: AppDeps, request: ReindexRequestInput): IngestionJobMessage[] {
  const siteId = deps.config.sharePoint.siteId ?? '';
  const driveId = deps.config.sharePoint.driveId ?? '';
  if (!siteId || !driveId) {
    deps.logger.log(
      'warn',
      'admin reindex: SHAREPOINT_SITE_ID/SHAREPOINT_DRIVE_ID are not configured for this app; enqueuing with an empty site_id/drive_id',
      {},
    );
  }

  if (request.document_ids && request.document_ids.length > 0) {
    return request.document_ids.map((documentId) => ({
      site_id: siteId,
      drive_id: driveId,
      item_id: documentId,
      reason: ADMIN_REINDEX_REASON,
    }));
  }

  // `classification`-scoped or `full: true` reindex has no single item to
  // name; `reindexRequestSchema` guarantees at least one of
  // document_ids/classification/full is set, so this branch is reached
  // only for those two. A single sentinel job records the *intent*
  // auditably; it cannot itself be resolved into a real document without
  // the ingestion-side lookup this module's doc comment describes.
  const sentinel = request.classification ?? 'full';
  return [{ site_id: siteId, drive_id: driveId, item_id: `admin_reindex:${sentinel}`, reason: ADMIN_REINDEX_REASON }];
}

export async function handleAdminReindex(
  deps: AppDeps,
  headers: HttpRequest['headers'],
  body: unknown,
): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    if (!canAccessAdminApi(identity.role)) {
      throw new AuthError(403, 'The admin reindex API requires the it_admin role.', 'forbidden_role');
    }
    const parsed = reindexRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new HttpError(400, 'Invalid reindex request.', 'invalid_request');
    }

    const jobs = buildJobMessages(deps, parsed.data);
    for (const job of jobs) {
      await deps.queue.enqueue(deps.config.ingestQueueName, job);
    }
    deps.logger.log('info', 'admin reindex requested', {
      trace_id: traceId,
      requested_by: identity.user_principal_name,
      job_count: jobs.length,
    });

    return { status: 202, jsonBody: { accepted: true, trace_id: traceId } };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerAdminReindexFunction(deps: AppDeps): void {
  app.http('adminReindex', {
    methods: ['POST'],
    route: 'admin/reindex',
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const body = await request.json().catch(() => ({}));
      const result = await handleAdminReindex(deps, request.headers, body);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
