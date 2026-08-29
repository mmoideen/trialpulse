import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type TrialPulseConfig } from '../config';
import { AuthError } from './errors';
import { authenticateRequest } from './jwt';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AUDIENCE = 'api://trialpulse';
const ISSUER = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;

function baseConfig(overrides: Partial<TrialPulseConfig> = {}): TrialPulseConfig {
  return {
    ...loadConfig({
      AZURE_OPENAI_ENDPOINT: 'https://aoai.example.com/',
      AZURE_OPENAI_EMBEDDING_DEPLOYMENT: 'embed',
      AZURE_OPENAI_GENERATION_DEPLOYMENT: 'gpt-4o',
      AZURE_OPENAI_GENERATION_DEPLOYMENT_MINI: 'gpt-4o-mini',
      AZURE_SEARCH_ENDPOINT: 'https://search.example.com',
      AZURE_SEARCH_INDEX_NAME: 'idx',
      COSMOS_ENDPOINT: 'https://cosmos.example.com:443/',
      COSMOS_DATABASE_NAME: 'db',
      ENTRA_TENANT_ID: TENANT_ID,
      ENTRA_AUDIENCE: AUDIENCE,
      ENTRA_ISSUER: ISSUER,
      KEY_VAULT_URI: 'https://kv.example.com/',
      SHAREPOINT_WEBHOOK_CLIENT_STATE: 'secret',
      AZURE_STORAGE_QUEUE_ACCOUNT_URL: 'https://trialpulse.queue.core.windows.net',
      TRIALPULSE_INGEST_QUEUE: 'ingestion-work',
    }),
    ...overrides,
  };
}

describe('authenticateRequest', () => {
  let getKey: JWTVerifyGetKey;
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  beforeAll(async () => {
    const { privateKey: priv, publicKey } = await generateKeyPair('RS256');
    privateKey = priv;
    publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    getKey = createLocalJWKSet({ keys: [publicJwk] });
  });

  async function signToken(
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setExpirationTime(opts.expiresIn ?? '10m')
      .sign(privateKey);
  }

  it('accepts a valid token and extracts identity fields', async () => {
    const config = baseConfig();
    const token = await signToken({
      tid: TENANT_ID,
      oid: 'user-oid-1',
      preferred_username: 'dana.whitfield@meridiantx.com',
      name: 'Dana Whitfield',
      roles: ['regulatory_affairs'],
      sites: ['US-014', 'US-027'],
    });
    const identity = await authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey });
    expect(identity.user_principal_name).toBe('dana.whitfield@meridiantx.com');
    expect(identity.object_id).toBe('user-oid-1');
    expect(identity.tenant_id).toBe(TENANT_ID);
    expect(identity.role).toBe('regulatory_affairs');
    expect(identity.role_fallback_applied).toBe(false);
    expect(identity.assigned_sites).toEqual(['US-014', 'US-027']);
  });

  it('falls back to the least-privileged role when roles claim is unrecognised', async () => {
    const config = baseConfig();
    const token = await signToken({
      tid: TENANT_ID,
      oid: 'user-oid-2',
      upn: 'contractor@meridiantx.com',
      roles: ['some_unmapped_role'],
    });
    const identity = await authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey });
    expect(identity.role).toBe('site_monitor');
    expect(identity.role_fallback_applied).toBe(true);
  });

  it('reads assigned sites from an extension attribute when the sites claim is absent', async () => {
    const config = baseConfig();
    const token = await signToken({
      tid: TENANT_ID,
      oid: 'user-oid-3',
      upn: 'monitor@meridiantx.com',
      roles: ['site_monitor'],
      extension_abc123_assignedSites: 'US-014,EU-003',
    });
    const identity = await authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey });
    expect(identity.assigned_sites).toEqual(['US-014', 'EU-003']);
  });

  it('rejects a missing Authorization header', async () => {
    const config = baseConfig();
    await expect(authenticateRequest({}, config, { getKey })).rejects.toMatchObject({
      status: 401,
      code: 'missing_token',
    });
  });

  it('rejects a malformed Authorization header', async () => {
    const config = baseConfig();
    await expect(
      authenticateRequest({ authorization: 'Basic abc123' }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'malformed_token' });
  });

  it('rejects a token signed for the wrong audience', async () => {
    const config = baseConfig();
    const token = await signToken(
      { tid: TENANT_ID, oid: 'x', upn: 'x@meridiantx.com' },
      { audience: 'api://some-other-app' },
    );
    await expect(
      authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
  });

  it('rejects a token signed by the wrong issuer', async () => {
    const config = baseConfig();
    const token = await signToken(
      { tid: TENANT_ID, oid: 'x', upn: 'x@meridiantx.com' },
      { issuer: 'https://login.microsoftonline.com/other-tenant/v2.0' },
    );
    await expect(
      authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
  });

  it('rejects a token whose tid does not match the configured tenant', async () => {
    const config = baseConfig();
    const token = await signToken({
      tid: '99999999-9999-9999-9999-999999999999',
      oid: 'x',
      upn: 'x@meridiantx.com',
    });
    await expect(
      authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 403, code: 'tenant_mismatch' });
  });

  it('rejects an expired token', async () => {
    const config = baseConfig();
    const token = await signToken(
      { tid: TENANT_ID, oid: 'x', upn: 'x@meridiantx.com' },
      { expiresIn: '-10m' },
    );
    await expect(
      authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
  });

  it('rejects a token missing the user principal name claim', async () => {
    const config = baseConfig();
    const token = await signToken({ tid: TENANT_ID, oid: 'x' });
    await expect(
      authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 403, code: 'missing_upn' });
  });

  it('D12: rejects a validly-signed token using an algorithm other than RS256, even with a matching key in the JWKS', async () => {
    const config = baseConfig();
    const { privateKey: esPrivateKey, publicKey: esPublicKey } = await generateKeyPair('ES256');
    const esJwk = await exportJWK(esPublicKey);
    esJwk.kid = 'es-key-1';
    esJwk.alg = 'ES256';
    esJwk.use = 'sig';
    const esGetKey = createLocalJWKSet({ keys: [esJwk] });

    const token = await new SignJWT({ tid: TENANT_ID, oid: 'x', upn: 'x@meridiantx.com' })
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('10m')
      .sign(esPrivateKey);

    await expect(
      authenticateRequest({ authorization: `Bearer ${token}` }, config, { getKey: esGetKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_token' });
  });

  describe('development auth mode', () => {
    it('accepts an unsigned x-dev-identity header', async () => {
      const config = baseConfig({ authMode: 'development' });
      const identity = await authenticateRequest(
        {
          'x-dev-identity': JSON.stringify({ upn: 'dev@meridiantx.com', role: 'it_admin', sites: [] }),
        },
        config,
      );
      expect(identity.user_principal_name).toBe('dev@meridiantx.com');
      expect(identity.role).toBe('it_admin');
    });

    it('falls through to real JWT validation when no dev header is present', async () => {
      const config = baseConfig({ authMode: 'development' });
      await expect(authenticateRequest({}, config, { getKey })).rejects.toMatchObject({
        status: 401,
        code: 'missing_token',
      });
    });
  });

  describe('production auth mode', () => {
    it('NEVER honours an x-dev-identity header, even if present', async () => {
      const config = baseConfig({ authMode: 'production' });
      const err = await authenticateRequest(
        {
          'x-dev-identity': JSON.stringify({ upn: 'attacker@meridiantx.com', role: 'regulatory_affairs' }),
        },
        config,
        { getKey },
      ).catch((e: unknown) => e);
      // Must fail exactly like an unauthenticated request -- the dev header
      // must never even be inspected outside development mode.
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(401);
      expect((err as AuthError).code).toBe('missing_token');
    });
  });
});
