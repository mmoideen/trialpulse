/**
 * Entra ID (Azure AD) JWT validation.
 *
 * Every `/api/*` route except `/api/health` and the SharePoint webhook
 * handshake goes through `authenticateRequest`. It either returns a fully
 * populated `CallerIdentity` or throws a typed `AuthError` that the HTTP
 * layer maps to a 401/403 without leaking any internal detail.
 *
 * Development mode (`TRIALPULSE_AUTH_MODE=development`) additionally accepts
 * an unsigned `x-dev-identity` header so the local harness and `npm run dev`
 * can simulate any role without standing up a real Entra tenant. This branch
 * is gated on `config.authMode`, which `loadConfig()` refuses to set to
 * `'development'` when running inside Azure (see `src/config.ts`) -- so this
 * file only has to get the request-time check right, not the deploy-time one.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { isRole, resolveRole, type CallerIdentity } from '@trialpulse/shared';
import type { TrialPulseConfig } from '../config';
import { AuthError } from './errors';

/** Minimal shape we need from a headers object; matches both `Headers` and a plain record. */
export type HeaderLike = Headers | Record<string, string | undefined>;

function getHeader(headers: HeaderLike, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  // HTTP headers are case-insensitive; plain-object callers (tests, the bot
  // adapter) might supply any casing, so scan rather than assume lowercase.
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (record[key] ?? null) : null;
}

// One remote JWKS client per issuer for the life of the process. `jose`
// already caches the fetched key set internally (with its own cooldown), so
// this just avoids re-registering a fetcher on every request.
const jwksCache = new Map<string, JWTVerifyGetKey>();

function deriveJwksUrl(issuer: string): URL {
  const trimmed = issuer.replace(/\/+$/, '');
  // Standard Entra v2 issuer shape: https://login.microsoftonline.com/{tenant}/v2.0
  const base = trimmed.replace(/\/v2\.0$/, '');
  return new URL(`${base}/discovery/v2.0/keys`);
}

function getRemoteJwks(config: TrialPulseConfig): JWTVerifyGetKey {
  const cached = jwksCache.get(config.entra.issuer);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(deriveJwksUrl(config.entra.issuer));
  jwksCache.set(config.entra.issuer, jwks);
  return jwks;
}

export interface AuthenticateOptions {
  /**
   * Override the JWKS key source. Production code never sets this; tests use
   * it to inject a `createLocalJWKSet` built from an ephemeral test key,
   * avoiding any network dependency.
   */
  getKey?: JWTVerifyGetKey;
}

function extractAssignedSites(payload: JWTPayload): string[] {
  const direct = (payload as Record<string, unknown>)['sites'];
  const sitesFrom = (value: unknown): string[] | null => {
    if (Array.isArray(value)) {
      return value.filter((v): v is string => typeof v === 'string');
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
    }
    return null;
  };

  const directSites = sitesFrom(direct);
  if (directSites) return directSites;

  // Fall back to an Entra directory extension attribute, e.g.
  // `extension_<appid>_assignedSites`, for tenants that provision site
  // assignment via a custom user attribute rather than a token claim.
  for (const [key, value] of Object.entries(payload)) {
    if (/^extension_[a-z0-9]+_assignedsites$/i.test(key)) {
      const extSites = sitesFrom(value);
      if (extSites) return extSites;
    }
  }
  return [];
}

async function verifyEntraJwt(
  token: string,
  config: TrialPulseConfig,
  getKey: JWTVerifyGetKey,
): Promise<CallerIdentity> {
  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, getKey, {
      issuer: config.entra.issuer,
      audience: config.entra.audience,
      // Small tolerance for clock skew between the Functions host and Entra;
      // deliberately not zero, deliberately not generous.
      clockTolerance: 5,
      // D12: not currently exploitable -- `jose` resolves keys by type
      // against Entra's RSA-only JWKS regardless -- but that is a property
      // of `jose`'s internals, not of anything asserted here. Pinning the
      // algorithm explicitly means this stays safe even if a future JWKS
      // response, key rotation, or `jose` upgrade ever behaves differently
      // (e.g. the classic "alg: none" / symmetric-key-confusion family of
      // JWT bugs), without depending on a dependency's undocumented
      // resolution behaviour.
      algorithms: ['RS256'],
    });
    payload = result.payload;
  } catch (err) {
    throw new AuthError(401, `Token validation failed: ${(err as Error).message}`, 'invalid_token');
  }

  const tid = typeof payload['tid'] === 'string' ? payload['tid'] : undefined;
  if (!tid || tid !== config.entra.tenantId) {
    throw new AuthError(403, 'Token tenant does not match the configured tenant.', 'tenant_mismatch');
  }

  const upn =
    typeof payload['preferred_username'] === 'string'
      ? payload['preferred_username']
      : typeof payload['upn'] === 'string'
        ? payload['upn']
        : undefined;
  if (!upn) {
    throw new AuthError(403, 'Token is missing a user principal name claim.', 'missing_upn');
  }

  const oid = typeof payload['oid'] === 'string' ? payload['oid'] : undefined;
  if (!oid) {
    throw new AuthError(403, 'Token is missing an object id claim.', 'missing_oid');
  }

  const { role, fallbackApplied } = resolveRole(payload['roles']);
  return {
    user_principal_name: upn,
    object_id: oid,
    tenant_id: tid,
    name: typeof payload['name'] === 'string' ? payload['name'] : upn,
    role,
    role_fallback_applied: fallbackApplied,
    assigned_sites: extractAssignedSites(payload),
  };
}

/**
 * Parse the local-development `x-dev-identity` header.
 *
 * Expected shape: `{"upn":"claire@meridiantx.com","role":"regulatory_affairs","oid":"...","sites":["US-014"]}`.
 * Never reachable unless `config.authMode === 'development'`, which itself
 * cannot be true on a real Azure host (see `src/config.ts`).
 */
function parseDevIdentity(raw: string): CallerIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthError(401, 'x-dev-identity header must be valid JSON.', 'invalid_dev_header');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new AuthError(401, 'x-dev-identity header must be a JSON object.', 'invalid_dev_header');
  }
  const obj = parsed as Record<string, unknown>;
  const upn = typeof obj['upn'] === 'string' ? obj['upn'] : undefined;
  if (!upn) {
    throw new AuthError(403, 'x-dev-identity is missing required field "upn".', 'invalid_dev_header');
  }
  const roleClaim = obj['role'];
  if (roleClaim !== undefined && !isRole(roleClaim)) {
    throw new AuthError(403, `x-dev-identity has an unrecognised role "${String(roleClaim)}".`, 'invalid_dev_header');
  }
  const { role, fallbackApplied } = resolveRole(roleClaim);
  const sites = Array.isArray(obj['sites'])
    ? obj['sites'].filter((s): s is string => typeof s === 'string')
    : [];
  return {
    user_principal_name: upn,
    object_id: typeof obj['oid'] === 'string' ? obj['oid'] : 'dev-oid',
    tenant_id: 'dev-tenant',
    name: typeof obj['name'] === 'string' ? obj['name'] : upn,
    role,
    role_fallback_applied: fallbackApplied,
    assigned_sites: sites,
  };
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

/**
 * Authenticate an inbound request and return the caller's identity.
 *
 * The `x-dev-identity` branch is only ever consulted when
 * `config.authMode === 'development'`; in every other mode this function
 * goes straight to real Entra JWT validation, so a stray dev header on a
 * production request is inert -- it is never even read.
 */
export async function authenticateRequest(
  headers: HeaderLike,
  config: TrialPulseConfig,
  options: AuthenticateOptions = {},
): Promise<CallerIdentity> {
  if (config.authMode === 'development') {
    const devHeader = getHeader(headers, 'x-dev-identity');
    if (devHeader) {
      return parseDevIdentity(devHeader);
    }
    // No dev header supplied even though dev mode is on: fall through to the
    // real JWT path below so local runs can still exercise it end-to-end.
  }

  const authHeader = getHeader(headers, 'authorization');
  if (!authHeader) {
    throw new AuthError(401, 'Missing Authorization header.', 'missing_token');
  }
  const match = authHeader.trim().match(BEARER_PATTERN);
  if (!match?.[1]) {
    throw new AuthError(401, 'Authorization header must be a Bearer token.', 'malformed_token');
  }

  const getKey = options.getKey ?? getRemoteJwks(config);
  return verifyEntraJwt(match[1], config, getKey);
}
