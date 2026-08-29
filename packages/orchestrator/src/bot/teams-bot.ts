/**
 * Bot Framework message handler (PRD 5.2: "All messages are processed
 * through the same POST /api/query orchestrator").
 *
 * This module deliberately has no dependency on the `botbuilder` SDK: the
 * Bot Framework Activity schema is a plain, publicly documented JSON shape,
 * and everything below is pure activity-in/activity-out logic that can be
 * unit tested without standing up a `BotFrameworkAdapter`. Wiring this to a
 * real Teams channel (registering the adapter, verifying the Bot Framework
 * JWT on inbound requests, calling `adapter.processActivity`) is
 * infrastructure that belongs at the deploy/App Service layer alongside
 * adding `botbuilder` as a dependency -- the orchestration logic here does
 * not change when that wiring is added.
 *
 * Caller identity still comes from `authenticateRequest` (Teams SSO issues
 * the same Entra ID tokens our HTTP endpoints validate; see PRD 2.1's
 * "Teams SSO" identity row) -- the bot layer does not invent a separate
 * auth path.
 */
import { validate as isUuid, v5 as uuidv5 } from 'uuid';
import type { CallerIdentity, QueryResponse } from '@trialpulse/shared';
import type { QueryPipeline } from '../pipeline/query-pipeline';
import type { ConversationStore } from '../providers/types';
import { buildAnswerCard, buildFeedbackAckText, toCardAttachment, type AdaptiveCard } from './cards';

/**
 * Fixed namespace for deriving a stable UUID from a Teams conversation id.
 * Teams conversation ids (e.g. "19:abc123@thread.tacv2") are not
 * RFC 4122 UUIDs, but `QueryRequest.conversation_id` is (`queryRequestSchema`
 * requires `.uuid()`, matching the Ask tab's own generated ids). Hashing the
 * Teams id into a UUIDv5 keeps conversation history stable across turns in
 * the same Teams thread without weakening the shared schema for every other
 * caller.
 */
const TEAMS_CONVERSATION_NAMESPACE = '6f6d6e6e-2b3a-4b0d-9a3e-9a2f0a6d9e11';

function toConversationId(rawId: string | undefined): string | undefined {
  if (!rawId) return undefined;
  return isUuid(rawId) ? rawId : uuidv5(rawId, TEAMS_CONVERSATION_NAMESPACE);
}

/** The minimal slice of the Bot Framework Activity schema this module needs. */
export interface TeamsActivity {
  type: string;
  text?: string;
  conversation?: { id?: string };
  /** Present on an Adaptive Card `Action.Submit` postback (thumbs up/down). */
  value?: { action?: string; turn_id?: string; feedback?: 'up' | 'down' };
}

export interface BotReply {
  type: 'message';
  text?: string;
  attachments?: Array<{ contentType: string; content: AdaptiveCard }>;
}

export interface TeamsBotDeps {
  pipeline: QueryPipeline;
  conversations: ConversationStore;
}

function isFeedbackSubmit(activity: TeamsActivity): activity is TeamsActivity & { value: { action: 'feedback'; turn_id: string; feedback: 'up' | 'down' } } {
  return activity.value?.action === 'feedback' && typeof activity.value.turn_id === 'string' && (activity.value.feedback === 'up' || activity.value.feedback === 'down');
}

/** Map a Teams message activity into the same `QueryRequest` shape `/api/query` accepts. */
export function activityToQueryRequest(activity: TeamsActivity): { query: string; conversation_id?: string } {
  const conversationId = toConversationId(activity.conversation?.id);
  return {
    query: (activity.text ?? '').trim(),
    ...(conversationId ? { conversation_id: conversationId } : {}),
  };
}

function toBotReply(response: QueryResponse, turnId: string): BotReply {
  return {
    type: 'message',
    attachments: [toCardAttachment(buildAnswerCard(response, { turnId }))],
  };
}

/**
 * Handle one inbound Teams activity: either a natural-language question
 * (routed through the exact same `QueryPipeline` as `/api/query`) or a
 * thumbs up/down card postback.
 */
export async function handleTeamsActivity(
  deps: TeamsBotDeps,
  identity: CallerIdentity,
  activity: TeamsActivity,
): Promise<BotReply> {
  if (isFeedbackSubmit(activity)) {
    await deps.conversations.recordFeedback(activity.value.turn_id, identity.user_principal_name, activity.value.feedback);
    return { type: 'message', text: buildFeedbackAckText(activity.value.feedback) };
  }

  const request = activityToQueryRequest(activity);
  const response = await deps.pipeline.execute(identity, request);
  // The conversation turn's `id` (== trace_id) is what the thumbs up/down
  // Action.Submit payload references; see `ConversationTurn.id` in
  // query-pipeline.ts's `finalize()`.
  return toBotReply(response, response.trace_id);
}
