/**
 * `GET /api/admin/usage` -- `it_admin` only. Powers the Cost Dashboard
 * (PRD 6.2 `CostDashboard`): daily summaries plus a top-expensive-queries
 * aggregate.
 *
 * D6: this used to return `{ summaries, recent_queries }` where
 * `recent_queries` was up to 100 FULL `AuditRecord`s -- `query_text`,
 * `response_text`, `retrieved_chunks`, `search_filter` -- verbatim clinical
 * questions and answers across every user, shipped unwatermarked to a
 * browser. The published client contract
 * (`packages/teams-tab/src/teams/api-client.ts`'s `UsageResponse`) declares
 * `{ summaries, top_queries }` with `top_queries` as pre-aggregated,
 * non-identifying rows (`query_hash`, `role`, `cost_usd`, `latency_ms`,
 * `count`) -- no verbatim text at all. Aggregating server-side, under the
 * key the client already expects, both fixes the shape mismatch (the
 * client's `[...undefined]` on the missing `top_queries` key crashed
 * `CostDashboard` for the only role allowed to open it) and is the
 * data-minimising fix: the dashboard never needed raw query/response text.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { canAccessAdminApi, usageQuerySchema, type AuditRecord, type Role } from '@trialpulse/shared';
import { AuthError } from '../auth/errors';
import type { AppDeps } from './deps';
import { HttpError, mapErrorToResponse, newTraceId, requireIdentity, type HttpResult } from './http-utils';

const DEFAULT_FROM = '2000-01-01';
const DEFAULT_TO = '9999-12-31';

/** Raw audit records fetched for aggregation before being collapsed to `TopQueryUsage` rows; not itself returned. */
const AGGREGATION_SAMPLE_LIMIT = 1_000;

/** Matches `UsageResponse['top_queries']`'s element type in `packages/teams-tab/src/teams/api-client.ts` exactly -- see `admin.contract.test.ts`. */
export interface TopQueryUsage {
  query_hash: string;
  role: Role;
  cost_usd: number;
  latency_ms: number;
  count: number;
}

/**
 * Collapse raw audit records into non-identifying, pre-aggregated rows
 * grouped by `(query_hash, role)`, sorted by total cost descending. Never
 * carries `query_text`/`response_text`/`retrieved_chunks`/`search_filter`.
 */
export function aggregateTopQueries(records: readonly AuditRecord[], limit = 10): TopQueryUsage[] {
  interface Accumulator {
    query_hash: string;
    role: Role;
    totalCostUsd: number;
    totalLatencyMs: number;
    count: number;
  }
  const groups = new Map<string, Accumulator>();
  for (const record of records) {
    const key = `${record.query_hash}::${record.entra_role}`;
    const existing = groups.get(key);
    if (existing) {
      existing.totalCostUsd += record.estimated_cost_usd;
      existing.totalLatencyMs += record.latency_ms;
      existing.count += 1;
    } else {
      groups.set(key, {
        query_hash: record.query_hash,
        role: record.entra_role,
        totalCostUsd: record.estimated_cost_usd,
        totalLatencyMs: record.latency_ms,
        count: 1,
      });
    }
  }
  return [...groups.values()]
    .map((g) => ({
      query_hash: g.query_hash,
      role: g.role,
      // Total cost this query pattern incurred, not a per-occurrence
      // average -- "most expensive queries" means "biggest cost drivers".
      cost_usd: Math.round(g.totalCostUsd * 1e6) / 1e6,
      // Latency, unlike cost, is a per-occurrence characteristic of the
      // query -- report the average so it stays comparable across rows
      // with very different `count`s.
      latency_ms: Math.round(g.totalLatencyMs / g.count),
      count: g.count,
    }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, limit);
}

export async function handleAdminUsage(
  deps: AppDeps,
  headers: HttpRequest['headers'],
  rawQuery: Record<string, string | undefined>,
): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    const identity = await requireIdentity(headers, deps.config);
    if (!canAccessAdminApi(identity.role)) {
      throw new AuthError(403, 'The admin usage API requires the it_admin role.', 'forbidden_role');
    }
    const parsed = usageQuerySchema.safeParse({
      from: rawQuery.from,
      to: rawQuery.to,
      role: rawQuery.role,
    });
    if (!parsed.success) {
      throw new HttpError(400, 'Invalid usage query parameters.', 'invalid_request');
    }
    const { from, to, role } = parsed.data;

    const [summaries, records] = await Promise.all([
      deps.audit.getDailySummaries(from ?? DEFAULT_FROM, to ?? DEFAULT_TO),
      deps.audit.query({ from, to, role, limit: AGGREGATION_SAMPLE_LIMIT }),
    ]);
    const top_queries = aggregateTopQueries(records);

    return { status: 200, jsonBody: { summaries, top_queries } };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerAdminUsageFunction(deps: AppDeps): void {
  app.http('adminUsage', {
    methods: ['GET'],
    route: 'admin/usage',
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const rawQuery: Record<string, string | undefined> = {
        from: request.query.get('from') ?? undefined,
        to: request.query.get('to') ?? undefined,
        role: request.query.get('role') ?? undefined,
      };
      const result = await handleAdminUsage(deps, request.headers, rawQuery);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
