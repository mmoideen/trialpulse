/**
 * `POST /api/messages` -- the Teams bot's messaging endpoint (PRD 5.2,
 * `teams/manifest/manifest.json`'s `bots` entry, `teams/README.md`).
 *
 * D12: nothing registered this endpoint at all -- `bot/teams-bot.ts`
 * exports a fully-tested `handleTeamsActivity`, but no HTTP function ever
 * called it, so the bot the manifest declares had no working messaging
 * endpoint in this codebase.
 *
 * Two distinct trust decisions, deliberately not conflated:
 *
 *  1. Channel authentication (implemented): every request here is
 *     validated as genuinely originating from the Bot Framework Connector
 *     Service, via `verifyBotFrameworkRequest` (`auth/bot-framework-auth.ts`)
 *     -- signature, issuer, audience (this bot's own Microsoft App ID),
 *     algorithm pinned to RS256. Fails closed (401) on any failure,
 *     including when `BOT_FRAMEWORK_APP_ID` is not configured at all.
 *
 *  2. User authentication (NOT implemented -- see below): every other
 *     endpoint in this app authenticates the *caller* with a validated
 *     Entra JWT via `authenticateRequest`, and `bot/teams-bot.ts`'s own
 *     module doc says the bot layer "does not invent a separate auth
 *     path." Doing that for real inside a Teams conversation requires
 *     Teams Bot SSO: the client silently completing a `signin/tokenExchange`
 *     invoke Activity, and the bot exchanging that token for a real AAD
 *     access token via the Bot Framework Token Service -- which needs
 *     either the `botbuilder`/`botbuilder-dialogs` SDKs' `OAuthPrompt`, or
 *     a hand-rolled integration against an Azure Bot OAuth connection
 *     setting (itself requiring a bot client secret and infra not
 *     provisioned here). Both are out of scope for this fix. Per this
 *     task's explicit instruction ("if not achievable without adding
 *     botbuilder, say so and implement what you can, failing closed"):
 *     this handler does NOT default to a guessed, fallback, or
 *     unauthenticated identity for a `message` activity. It replies with a
 *     safe, static message directing the user to the TrialPulse tab (which
 *     *does* have real Teams SSO) instead of ever calling
 *     `handleTeamsActivity` with fabricated identity. Wiring real Bot SSO
 *     is a distinct, larger follow-up.
 */
import { app } from '@azure/functions';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import { verifyBotFrameworkRequest, type VerifyBotFrameworkOptions } from '../auth/bot-framework-auth';
import type { TeamsActivity } from '../bot/teams-bot';
import type { AppDeps } from './deps';
import { mapErrorToResponse, newTraceId, type HttpResult } from './http-utils';

const SSO_NOT_CONFIGURED_REPLY = {
  type: 'message' as const,
  text:
    'TrialPulse cannot yet verify your identity for role-based access from within a Teams chat. ' +
    'Please use the TrialPulse tab, which supports full sign-in, to ask questions.',
};

export async function handleTeamsMessage(
  deps: AppDeps,
  headers: HttpRequest['headers'],
  body: unknown,
  botAuthOptions?: VerifyBotFrameworkOptions,
): Promise<HttpResult> {
  const traceId = newTraceId();
  try {
    // Step 1: the request must genuinely be from the Bot Framework
    // Connector Service. Throws (401) otherwise -- see module doc.
    await verifyBotFrameworkRequest(headers, deps.config, botAuthOptions);
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }

  try {
    const activity = (body ?? {}) as TeamsActivity;

    // Bot Framework expects a fast 200 acknowledging receipt regardless of
    // activity type (conversationUpdate, typing, invoke, ...); only
    // `message` activities get a substantive reply. See module doc for why
    // this never calls `handleTeamsActivity` yet.
    if (activity.type !== 'message') {
      return { status: 200, jsonBody: {} };
    }

    deps.logger.log('info', 'teams message activity received but not processed (no verified user identity available)', {
      trace_id: traceId,
    });
    return { status: 200, jsonBody: SSO_NOT_CONFIGURED_REPLY };
  } catch (err) {
    return mapErrorToResponse(err, traceId, deps.logger);
  }
}

export function registerTeamsMessagesFunction(deps: AppDeps): void {
  app.http('teamsMessages', {
    methods: ['POST'],
    route: 'messages',
    // Bot Framework cannot present a Teams-SSO Entra JWT for this route --
    // `verifyBotFrameworkRequest` inside the handler is the real auth gate,
    // exactly like the SharePoint webhook's `clientState` check.
    authLevel: 'anonymous',
    handler: async (request: HttpRequest, _context: InvocationContext) => {
      const body = await request.json().catch(() => ({}));
      const result = await handleTeamsMessage(deps, request.headers, body);
      return { status: result.status, jsonBody: result.jsonBody };
    },
  });
}
