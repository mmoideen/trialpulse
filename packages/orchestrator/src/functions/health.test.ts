import { describe, expect, it } from 'vitest';
import { handleHealth } from './health';
import { buildTestDeps } from './test-support';

describe('GET /api/health', () => {
  it('reports ok when every dependency is reachable, without auth', async () => {
    const { deps } = buildTestDeps();
    const result = await handleHealth(deps);
    expect(result.status).toBe(200);
    const body = result.jsonBody as { status: string; dependencies: Record<string, string> };
    expect(body.status).toBe('ok');
    expect(body.dependencies.search).toBe('ok');
    expect(body.dependencies.audit).toBe('ok');
    expect(body.dependencies.cache).toBe('ok');
  });

  it('never leaks configuration values in the response', async () => {
    const { deps } = buildTestDeps();
    const result = await handleHealth(deps);
    const body = JSON.stringify(result.jsonBody);
    expect(body).not.toContain(deps.config.azureOpenAI.endpoint);
    expect(body).not.toContain(deps.config.cosmos.endpoint);
  });

  it('reports degraded when a dependency throws', async () => {
    const { deps } = buildTestDeps();
    deps.search.countChunks = () => Promise.reject(new Error('boom'));
    const result = await handleHealth(deps);
    const body = result.jsonBody as { status: string; dependencies: Record<string, string> };
    expect(body.status).toBe('degraded');
    expect(body.dependencies.search).toBe('error');
  });
});
