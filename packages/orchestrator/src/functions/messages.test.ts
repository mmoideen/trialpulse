import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleTeamsMessage } from './messages';
import { buildTestDeps } from './test-support';

const BOT_APP_ID = '22222222-2222-2222-2222-222222222222';
const BOT_ISSUER = 'https://api.botframework.com';

describe('POST /api/messages', () => {
  let getKey: JWTVerifyGetKey;
  let privateKey: CryptoKey;

  beforeAll(async () => {
    const { privateKey: priv, publicKey } = await generateKeyPair('RS256');
    privateKey = priv;
    const publicJwk: JWK = await exportJWK(publicKey);
    publicJwk.kid = 'bf-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    getKey = createLocalJWKSet({ keys: [publicJwk] });
  });

  async function botToken(): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'bf-key-1' })
      .setIssuedAt()
      .setIssuer(BOT_ISSUER)
      .setAudience(BOT_APP_ID)
      .setExpirationTime('10m')
      .sign(privateKey);
  }

  it('D12: rejects with 401 when the Bot Framework app id is not configured (fails closed)', async () => {
    const { deps } = buildTestDeps();
    const result = await handleTeamsMessage(deps, { authorization: 'Bearer anything' }, { type: 'message', text: 'hi' });
    expect(result.status).toBe(401);
  });

  it('rejects a request with no Authorization header at all', async () => {
    const { deps } = buildTestDeps({ config: { botFramework: { appId: BOT_APP_ID } } });
    const result = await handleTeamsMessage(deps, {}, { type: 'message', text: 'hi' }, { getKey });
    expect(result.status).toBe(401);
  });

  it('rejects a forged token (wrong audience)', async () => {
    const { deps } = buildTestDeps({ config: { botFramework: { appId: BOT_APP_ID } } });
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'bf-key-1' })
      .setIssuedAt()
      .setIssuer(BOT_ISSUER)
      .setAudience('some-other-bot')
      .setExpirationTime('10m')
      .sign(privateKey);
    const result = await handleTeamsMessage(deps, { authorization: `Bearer ${forged}` }, { type: 'message', text: 'hi' }, { getKey });
    expect(result.status).toBe(401);
  });

  it('D12: never calls the query pipeline for a genuine, verified message activity -- fails closed on user identity instead', async () => {
    const { deps } = buildTestDeps({ config: { botFramework: { appId: BOT_APP_ID } } });
    const token = await botToken();
    const result = await handleTeamsMessage(
      deps,
      { authorization: `Bearer ${token}` },
      { type: 'message', text: 'What is the planned enrollment?' },
      { getKey },
    );
    expect(result.status).toBe(200);
    const body = result.jsonBody as { type: string; text: string };
    expect(body.type).toBe('message');
    // Never a real cited answer -- this is the explicit "cannot verify your
    // identity yet" reply, not `handleTeamsActivity`'s output.
    expect(body.text).toMatch(/tab/i);
  });

  it('acknowledges a non-message activity (e.g. conversationUpdate) with an empty 200, never processing it as a question', async () => {
    const { deps } = buildTestDeps({ config: { botFramework: { appId: BOT_APP_ID } } });
    const token = await botToken();
    const result = await handleTeamsMessage(deps, { authorization: `Bearer ${token}` }, { type: 'conversationUpdate' }, { getKey });
    expect(result.status).toBe(200);
    expect(result.jsonBody).toEqual({});
  });

  it('never leaks a stack trace or internal error detail in the response body', async () => {
    const { deps } = buildTestDeps();
    const result = await handleTeamsMessage(deps, {}, { type: 'message', text: 'hi' });
    const body = JSON.stringify(result.jsonBody);
    expect(body).not.toMatch(/at .*\.ts:\d+/);
  });
});
