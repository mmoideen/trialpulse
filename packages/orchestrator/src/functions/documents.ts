/**
 * `GET /api/documents` (list) and `GET /api/documents/{id}` (single) -- auth + RBAC.
 *
 * The list route backs the Browse tab. It returns only the classifications the
 * caller's role allows, so a document outside the role's scope is absent from
 * the payload rather than present-but-flagged.
 *
 * Returns 404 (never 403) when the caller is not authorised to see the
 * document's classification, so this endpoint cannot be used to probe for
 * document existence by distinguishing "doesn't exist" from "exists but you
 * can't see it" via status code.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { documentIdSchema, getRolePolicy, isChunkAuthorized, type CallerIdentity, type DocumentStatus, type RolePolicy } from '@trialpulse/shared';
import { findSiteCode } from '../pipeline/redaction';
import type { AppDeps } from './deps';
import { HttpError, mapErrorToResponse, newTraceId, requireIdentity, type HttpResult } from './http-utils';

/**
 * D2: `assigned_sites` was referenced only inside `pipeline/redaction.ts`
 * (chunk-content masking) -- `/api/documents` and `/api/documents/{id}`
 * scoped purely by `document_classification`, so a site monitor assigned to
 * one site could list and fetch full, unmasked `site_communication` records
 * for every other site. This makes site assignment a real scoping
 * dimension for both endpoints, exactly like classification.
 *
 * `DocumentStatus` has no persisted `site_code` field of its own --
 * `ingestion/trialpulse_ingest/document_status.py` deliberately keeps that
 * record minimal ("do not add ingestion-internal fields here"), unlike
 * `Chunk`, which does carry one. Every `site_communication` document in the
 * corpus is titled `"Site <CODE> ..."`, so `findSiteCode` recovers the same
 * signal from the title that would otherwise require a schema change
 * outside this workstream's ownership.
 */
function isBlockedByAssignedSite(
  identity: CallerIdentity,
  policy: RolePolicy,
  document: DocumentStatus,
): boolean {
  if (!policy.redaction.maskUnassignedSites) return false;
  if (document.document_classification !== 'site_communication') return false;
  const siteCode = findSiteCode(document.document_title);
  if (siteCode === null) return false; // not a single-site document (e.g. a cross-site newsletter)
  return !identity.assigned_sites.includes(siteCode);
}

export async function handleGetDocument(
  deps: AppDeps,
  headers: HttpRequest['headers'],
  rawId: string,
): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    const parsedId = documentIdSchema.safeParse(rawId);
    if (!parsedId.success) {
      // A malformed id can never resolve to a real document either -- 404
      // for the same existence-probing reason as an authorization failure.
      throw new HttpError(404, 'Document not found.', 'not_found');
    }

    const document = await deps.documentMetadata.get(parsedId.data);
    const policy = getRolePolicy(identity.role);
    if (
      !document ||
      !isChunkAuthorized(identity.role, document.document_classification) ||
      isBlockedByAssignedSite(identity, policy, document)
    ) {
      // Same 404 (never 403, never a distinguishable body) whether the
      // document does not exist, is outside the role's classification
      // allow-list, or is outside the caller's assigned sites.
      throw new HttpError(404, 'Document not found.', 'not_found');
    }

    return { status: 200, jsonBody: document };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

/**
 * `GET /api/documents` -- documents visible to the caller's role.
 *
 * Scoping happens in the metadata store query (`list`) rather than by fetching
 * everything and filtering afterwards, for the same reason retrieval filters at
 * the search engine: a post-filter leaks scope through counts and ordering.
 */
export async function handleListDocuments(
  deps: AppDeps,
  headers: HttpRequest['headers'],
): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    const policy = getRolePolicy(identity.role);
    const scope = policy.unrestricted ? null : policy.allowedClassifications;

    const documents = await deps.documentMetadata.list(scope);
    // Defence in depth: the store already scoped the query by classification,
    // so a document surviving to here that the role's classification
    // allow-list does not cover would be a scoping *bug*, not a display bug
    // -- logged as an incident. Site scoping (D2) is a separate, always-on
    // check applied in the same pass: unlike classification, it is
    // *expected* to filter out real, ordinary documents for a site monitor
    // (see `isBlockedByAssignedSite`'s doc comment for why it cannot be
    // pushed into the store query the way classification is), so it is
    // counted and logged separately, never as an `rbac_violation`.
    const classificationAuthorized = documents.filter((d) => isChunkAuthorized(identity.role, d.document_classification));
    if (classificationAuthorized.length !== documents.length) {
      deps.logger.log('error', 'rbac_violation: document metadata store returned out-of-scope documents', {
        trace_id: traceId,
        role: identity.role,
        returned: documents.length,
        authorized: classificationAuthorized.length,
      });
    }
    const authorized = classificationAuthorized.filter((d) => !isBlockedByAssignedSite(identity, policy, d));
    if (authorized.length !== classificationAuthorized.length) {
      deps.logger.log('info', 'documents filtered out for a site the caller is not assigned to', {
        trace_id: traceId,
        role: identity.role,
        filtered: classificationAuthorized.length - authorized.length,
      });
    }

    return { status: 200, jsonBody: authorized };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerDocumentsFunction(deps: AppDeps): void {
  app.http('listDocuments', {
    methods: ['GET'],
    route: 'documents',
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const result = await handleListDocuments(deps, request.headers);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });

  app.http('getDocument', {
    methods: ['GET'],
    route: 'documents/{id}',
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const result = await handleGetDocument(deps, request.headers, request.params['id'] ?? '');
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
