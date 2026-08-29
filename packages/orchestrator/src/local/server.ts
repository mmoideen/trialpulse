#!/usr/bin/env node
/**
 * `npm run dev` -- a plain `node:http` server exposing the same routes as
 * the real Azure Functions app (`src/functions/index.ts`), backed by the
 * memory provider set seeded from `data/synthetic/`. No Azure resources,
 * no network access, no `local.settings.json` required.
 *
 * This intentionally does not use `@azure/functions`: that package's
 * runtime only activates inside the real Azure Functions host. Route
 * handling here is deliberately minimal (method + path matching) since its
 * only job is to exercise the same `handle*` functions the real Functions
 * app uses, over plain HTTP, for local iteration.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleAdminReindex } from '../functions/admin-reindex';
import { handleAdminUsage } from '../functions/admin-usage';
import { handleGetConversation } from '../functions/conversations';
import { createAppDeps, type AppDeps } from '../functions/deps';
import { handleGetDocument, handleListDocuments } from '../functions/documents';
import { handleFeedback } from '../functions/feedback';
import { handleHealth } from '../functions/health';
import type { HttpResult } from '../functions/http-utils';
import { handleQuery } from '../functions/query';
import { handleSharePointWebhook } from '../functions/webhooks-sharepoint';
import { handleTeamsMessage } from '../functions/messages';
import { loadConfig, type TrialPulseConfig } from '../config';
import { loadCorpusChunks } from './corpus';

const PORT = Number(process.env['PORT'] ?? 7071);

/**
 * D12: `server.listen(PORT)` with no host binds every interface (`::`,
 * i.e. `0.0.0.0` in practice) by default -- and this server accepts an
 * unsigned `x-dev-identity` header as a full identity, with no signature
 * check at all (see `src/auth/jwt.ts`'s development-mode branch). Bound to
 * every interface, anyone on the same network segment (same office Wi-Fi,
 * same cloud VNet, etc.) could query as any role of their choosing. Binds
 * loopback-only by default; `TRIALPULSE_DEV_BIND_ALL=true` is an explicit,
 * opt-in escape hatch for the rare case of deliberately testing from
 * another device, which a developer has to type out, not something that
 * happens by omission.
 */
const BIND_ALL_INTERFACES = (process.env['TRIALPULSE_DEV_BIND_ALL'] ?? '').toLowerCase() === 'true';
const HOST = BIND_ALL_INTERFACES ? '0.0.0.0' : '127.0.0.1';

/**
 * Local dev needs *a* config, but not real Azure resource endpoints -- the
 * memory provider set never dials out. Placeholder values fill every
 * required field so `loadConfig()`'s validation passes; `process.env` can
 * still override any of them (e.g. to test a different `TRIALPULSE_AUTH_MODE`).
 */
function buildDevConfig(): TrialPulseConfig {
  const devDefaults: NodeJS.ProcessEnv = {
    AZURE_OPENAI_ENDPOINT: 'https://local-dev.invalid/',
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'local-embedding',
    AZURE_OPENAI_GENERATION_DEPLOYMENT: 'local-gpt-4o',
    AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI: 'local-gpt-4o-mini',
    AZURE_SEARCH_ENDPOINT: 'https://local-dev.invalid/',
    AZURE_SEARCH_INDEX_NAME: 'local-index',
    COSMOS_ENDPOINT: 'https://local-dev.invalid:443/',
    COSMOS_DATABASE_NAME: 'local-db',
    ENTRA_TENANT_ID: 'local-tenant',
    ENTRA_AUDIENCE: 'api://local',
    ENTRA_ISSUER: 'https://login.microsoftonline.com/local-tenant/v2.0',
    KEY_VAULT_URI: 'https://local-dev.invalid/',
    SHAREPOINT_WEBHOOK_CLIENT_STATE: 'local-dev-client-state',
    AZURE_STORAGE_QUEUE_ACCOUNT_URL: 'https://local-dev.invalid/',
    TRIALPULSE_INGEST_QUEUE: 'local-ingestion-work',
    TRIALPULSE_AUTH_MODE: 'development',
  };
  return loadConfig({ ...devDefaults, ...process.env });
}

function normalizeHeaders(raw: IncomingMessage['headers']): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res: ServerResponse, result: HttpResult): void {
  if (result.textBody !== undefined) {
    res.writeHead(result.status, { 'Content-Type': 'text/plain' });
    res.end(result.textBody);
    return;
  }
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.jsonBody ?? null));
}

async function route(deps: AppDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const headers = normalizeHeaders(req.headers);
  const pathname = url.pathname;

  const documentMatch = pathname.match(/^\/api\/documents\/([^/]+)$/);
  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);

  if (method === 'POST' && pathname === '/api/query') {
    return send(res, await handleQuery(deps, headers, await readJsonBody(req)));
  }
  if (method === 'GET' && pathname === '/api/health') {
    return send(res, await handleHealth(deps));
  }
  if (method === 'GET' && pathname === '/api/admin/usage') {
    return send(
      res,
      await handleAdminUsage(deps, headers, {
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        role: url.searchParams.get('role') ?? undefined,
      }),
    );
  }
  if (method === 'POST' && pathname === '/api/admin/reindex') {
    return send(res, await handleAdminReindex(deps, headers, await readJsonBody(req)));
  }
  if (method === 'GET' && pathname === '/api/documents') {
    return send(res, await handleListDocuments(deps, headers));
  }
  if (method === 'GET' && documentMatch?.[1]) {
    return send(res, await handleGetDocument(deps, headers, documentMatch[1]));
  }
  if (method === 'GET' && conversationMatch?.[1]) {
    return send(
      res,
      await handleGetConversation(
        deps,
        headers,
        conversationMatch[1],
        url.searchParams.get('continuation') ?? undefined,
        url.searchParams.get('limit') ?? undefined,
      ),
    );
  }
  if (method === 'POST' && pathname === '/api/feedback') {
    return send(res, await handleFeedback(deps, headers, await readJsonBody(req)));
  }
  if ((method === 'POST' || method === 'GET') && pathname === '/api/webhooks/sharepoint') {
    const validationtoken = url.searchParams.get('validationtoken') ?? undefined;
    const body = validationtoken ? undefined : await readJsonBody(req);
    return send(res, await handleSharePointWebhook(deps, { validationtoken }, body));
  }
  if (method === 'POST' && pathname === '/api/messages') {
    return send(res, await handleTeamsMessage(deps, headers, await readJsonBody(req)));
  }

  send(res, { status: 404, jsonBody: { error: 'not_found' } });
}

function main(): void {
  const config = buildDevConfig();
  const deps = createAppDeps({ mode: 'memory', config, initialChunks: loadCorpusChunks() });

  const server = createServer((req, res) => {
    route(deps, req, res).catch((err: unknown) => {
      deps.logger.log('error', 'unhandled error routing local dev request', { error: String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  server.listen(PORT, HOST, () => {
    // eslint-disable-next-line no-console -- this script's entire job is to announce itself.
    console.log(`TrialPulse local dev server listening on http://${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.log('Use header "x-dev-identity" (JSON: {"upn":"you@meridiantx.com","role":"regulatory_affairs"}) to authenticate.');
    if (BIND_ALL_INTERFACES) {
      // eslint-disable-next-line no-console -- deliberately loud: this is a real widening of exposure.
      console.warn(
        'TRIALPULSE_DEV_BIND_ALL=true -- listening on every network interface. Anyone on this network ' +
          'can authenticate as any role via the unsigned x-dev-identity header. Do not use on a shared network.',
      );
    }
  });
}

main();
