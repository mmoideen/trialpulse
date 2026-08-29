/**
 * `GET /api/health` -- anonymous. Reports dependency reachability without
 * leaking any configuration (no endpoints, no error messages, no stack
 * traces): each dependency is reduced to `"ok"` or `"error"`.
 */
import { app } from '@azure/functions';
import type { InvocationContext } from '@azure/functions';
import type { AppDeps } from './deps';
import type { HttpResult } from './http-utils';

type DependencyHealth = 'ok' | 'error';

async function probe(fn: () => Promise<unknown>): Promise<DependencyHealth> {
  try {
    await fn();
    return 'ok';
  } catch {
    return 'error';
  }
}

export async function handleHealth(deps: AppDeps): Promise<HttpResult> {
  const [search, audit, cache] = await Promise.all([
    probe(() => deps.search.countChunks()),
    probe(() => deps.audit.query({ limit: 1 })),
    probe(async () => {
      await deps.cache.set('health-check', 'ok', 5);
      await deps.cache.get('health-check');
    }),
  ]);

  const dependencies = { search, audit, cache };
  const overall = Object.values(dependencies).every((d) => d === 'ok') ? 'ok' : 'degraded';

  return { status: 200, jsonBody: { status: overall, dependencies, time: deps.clock.now().toISOString() } };
}

export function registerHealthFunction(deps: AppDeps): void {
  app.http('health', {
    methods: ['GET'],
    route: 'health',
    authLevel: 'anonymous',
    handler: async (_request, _context: InvocationContext) => {
      const result = await handleHealth(deps);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
