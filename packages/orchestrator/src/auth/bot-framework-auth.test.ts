import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type TrialPulseConfig } from '../config';
import { AuthError } from './errors';
import { verifyBotFrameworkRequest } from './bot-framework-auth';

const BOT_APP_ID = '22222222-2222-2222-2222-222222222222';
const ISSUER = 'https://api.botframework.com';

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
      ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
      ENTRA_AUDIENCE: 'api://trialpulse',
      ENTRA_ISSUER: 'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0',
      KEY_VAULT_URI: 'https://kv.example.com/',
      SHAREPOINT_WEBHOOK_CLIENT_STATE: 'secret',
      AZURE_STORAGE_QUEUE_ACCOUNT_URL: 'https://trialpulse.queue.core.windows.net',
      TRIALPULSE_INGEST_QUEUE: 'ingestion-work',
    }),
    ...overrides,
  };
}

describe('verifyBotFrameworkRequest', () => {
  let getKey: JWTVerifyGetKey;
  let privateKey: CryptoKey;
  let publicJwk: JWK;

  beforeAll(async () => {
    const { privateKey: priv, publicKey } = await generateKeyPair('RS256');
    privateKey = priv;
    publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'bf-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    getKey = createLocalJWKSet({ keys: [publicJwk] });
  });

  async function signToken(opts: { issuer?: string; audience?: string; expiresIn?: string } = {}): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'bf-key-1' })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? BOT_APP_ID)
      .setExpirationTime(opts.expiresIn ?? '10m')
      .sign(privateKey);
  }

  it('D12: fails closed with bot_not_configured when BOT_FRAMEWORK_APP_ID is unset', async () => {
    const config = baseConfig(); // botFramework.appId is undefined by default
    await expect(
      verifyBotFrameworkRequest({ authorization: 'Bearer anything' }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'bot_not_configured' });
  });

  it('accepts a validly-signed token from the real issuer for the configured app id', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    const token = await signToken();
    await expect(verifyBotFrameworkRequest({ authorization: `Bearer ${token}` }, config, { getKey })).resolves.toBeUndefined();
  });

  it('rejects a missing Authorization header', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    await expect(verifyBotFrameworkRequest({}, config, { getKey })).rejects.toMatchObject({
      status: 401,
      code: 'missing_token',
    });
  });

  it('rejects a malformed Authorization header', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    await expect(
      verifyBotFrameworkRequest({ authorization: 'Basic abc' }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'malformed_token' });
  });

  it('rejects a token for the wrong audience (a different bot/app id)', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    const token = await signToken({ audience: 'some-other-app-id' });
    await expect(
      verifyBotFrameworkRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_bot_token' });
  });

  it('rejects a token from the wrong issuer', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    const token = await signToken({ issuer: 'https://evil.example' });
    await expect(
      verifyBotFrameworkRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_bot_token' });
  });

  it('rejects an expired token', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    const token = await signToken({ expiresIn: '-10m' });
    await expect(
      verifyBotFrameworkRequest({ authorization: `Bearer ${token}` }, config, { getKey }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_bot_token' });
  });

  it('rejects a validly-signed token using an algorithm other than RS256', async () => {
    const config = baseConfig({ botFramework: { appId: BOT_APP_ID } });
    const { privateKey: esPrivateKey, publicKey: esPublicKey } = await generateKeyPair('ES256');
    const esJwk = await exportJWK(esPublicKey);
    esJwk.kid = 'es-key-1';
    esJwk.alg = 'ES256';
    esJwk.use = 'sig';
    const esGetKey = createLocalJWKSet({ keys: [esJwk] });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'es-key-1' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(BOT_APP_ID)
      .setExpirationTime('10m')
      .sign(esPrivateKey);

    await expect(
      verifyBotFrameworkRequest({ authorization: `Bearer ${token}` }, config, { getKey: esGetKey }),
    ).rejects.toBeInstanceOf(AuthError);
  });
});
