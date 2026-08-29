/**
 * Bot Framework Connector Service JWT validation (D12).
 *
 * This is the "channel is genuinely Bot Framework" check for
 * `POST /api/messages` -- a *different* trust decision from
 * `authenticateRequest` in `jwt.ts`, which validates a *user's* Entra SSO
 * token. Bot Framework signs the outer envelope of every activity it
 * delivers with its own JWT (issuer `https://api.botframework.com`, JWKS at
 * `https://login.botframework.com/v1/.well-known/keys`, audience the bot's
 * own Microsoft App ID) -- this proves the request came from the real
 * Bot Framework Connector Service, not an arbitrary caller forging a POST
 * to this URL.
 *
 * This is deliberately NOT the same thing as authenticating the end user
 * asking the question -- see `functions/messages.ts`'s module doc for why
 * that half is not implemented here (it requires either `botbuilder`'s
 * OAuthPrompt/token-exchange dialogs or a hand-rolled Bot Connector Token
 * Service integration, both out of scope) and fails closed instead of
 * guessing an identity.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { TrialPulseConfig } from '../config';
import { AuthError } from './errors';
import type { HeaderLike } from './jwt';

const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const BOT_FRAMEWORK_JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';

let cachedJwks: JWTVerifyGetKey | null = null;
function getBotFrameworkJwks(): JWTVerifyGetKey {
  cachedJwks ??= createRemoteJWKSet(new URL(BOT_FRAMEWORK_JWKS_URL));
  return cachedJwks;
}

function getHeader(headers: HeaderLike, name: string): string | null {
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (record[key] ?? null) : null;
}

const BEARER_PATTERN = /^Bearer\s+(.+)$/i;

export interface VerifyBotFrameworkOptions {
  /** Test-only override, exactly like `AuthenticateOptions.getKey` in `jwt.ts`, avoiding any real network dependency in tests. */
  getKey?: JWTVerifyGetKey;
}

/**
 * Verify that an inbound request to `/api/messages` genuinely came from the
 * Bot Framework Connector Service. Throws `AuthError` (401) on any
 * failure -- including, deliberately, when `botFramework.appId` is not
 * configured, since that means audience validation cannot happen at all.
 */
export async function verifyBotFrameworkRequest(
  headers: HeaderLike,
  config: TrialPulseConfig,
  options: VerifyBotFrameworkOptions = {},
): Promise<void> {
  if (!config.botFramework.appId) {
    throw new AuthError(
      401,
      'Bot Framework messaging endpoint is not configured (missing BOT_FRAMEWORK_APP_ID); failing closed.',
      'bot_not_configured',
    );
  }

  const authHeader = getHeader(headers, 'authorization');
  if (!authHeader) {
    throw new AuthError(401, 'Missing Authorization header on the bot messaging endpoint.', 'missing_token');
  }
  const match = authHeader.trim().match(BEARER_PATTERN);
  if (!match?.[1]) {
    throw new AuthError(401, 'Authorization header must be a Bearer token.', 'malformed_token');
  }

  const getKey = options.getKey ?? getBotFrameworkJwks();
  try {
    await jwtVerify(match[1], getKey, {
      issuer: BOT_FRAMEWORK_ISSUER,
      audience: config.botFramework.appId,
      algorithms: ['RS256'],
    });
  } catch (err) {
    throw new AuthError(401, `Bot Framework token validation failed: ${(err as Error).message}`, 'invalid_bot_token');
  }
}
