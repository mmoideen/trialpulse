/**
 * Cosmos DB-backed `ConversationStore` (PRD 6.1: "Conversation history is
 * maintained per user (stored in Cosmos DB, TTL 30 days)").
 *
 * Container is partitioned by `conversation_id`; every read is additionally
 * scoped to `user_principal_name` so a caller can never read another user's
 * turns even if they somehow learn a conversation id that isn't theirs.
 * Item-level `ttl` (already on `ConversationTurn.ttl`) relies on the
 * container having a default TTL policy enabled (`-1`, "on but no default"),
 * which is provisioned by `infra/`.
 */
import { CosmosClient } from '@azure/cosmos';
import { CONVERSATION_PAGE_SIZE, type ConversationTurn } from '@trialpulse/shared';
import type { TrialPulseConfig } from '../../config';
import type { ConversationStore } from '../types';
import { getManagedIdentityCredential } from './credential';
import { isLikelyTransientAzureError, withRetry } from './retry';

const CONVERSATIONS_CONTAINER = 'conversations';

function createClient(config: TrialPulseConfig): CosmosClient {
  if (config.cosmos.key) {
    return new CosmosClient({ endpoint: config.cosmos.endpoint, key: config.cosmos.key });
  }
  return new CosmosClient({ endpoint: config.cosmos.endpoint, aadCredentials: getManagedIdentityCredential() });
}

class AzureConversationStore implements ConversationStore {
  private readonly client: CosmosClient;
  private readonly databaseName: string;

  constructor(config: TrialPulseConfig) {
    this.client = createClient(config);
    this.databaseName = config.cosmos.databaseName;
  }

  private container() {
    return this.client.database(this.databaseName).container(CONVERSATIONS_CONTAINER);
  }

  async append(turn: ConversationTurn): Promise<void> {
    await withRetry(() => this.container().items.upsert(turn), { isRetryable: isLikelyTransientAzureError });
  }

  async list(
    conversationId: string,
    userPrincipalName: string,
    options: { limit?: number; continuation?: string } = {},
  ): Promise<{ turns: ConversationTurn[]; continuation: string | null }> {
    const iterator = this.container().items.query<ConversationTurn>(
      {
        query:
          'SELECT * FROM c WHERE c.conversation_id = @conversationId AND c.user_principal_name = @upn ' +
          'ORDER BY c.timestamp DESC',
        parameters: [
          { name: '@conversationId', value: conversationId },
          { name: '@upn', value: userPrincipalName },
        ],
      },
      {
        maxItemCount: options.limit ?? CONVERSATION_PAGE_SIZE,
        continuationToken: options.continuation,
        partitionKey: conversationId,
      },
    );
    const page = await withRetry(() => iterator.fetchNext(), { isRetryable: isLikelyTransientAzureError });
    return {
      turns: page.resources,
      continuation: page.hasMoreResults ? page.continuationToken : null,
    };
  }

  async recordFeedback(turnId: string, userPrincipalName: string, feedback: 'up' | 'down'): Promise<boolean> {
    // The turn's partition key is its conversation_id, which we don't have
    // here -- look it up first (a caller only ever has the turn id, e.g.
    // from a card action), then patch it via a point read/replace scoped to
    // the same conversation partition, re-checking ownership before writing.
    const { resources } = await withRetry(
      () =>
        this.container()
          .items.query<ConversationTurn>({
            query: 'SELECT * FROM c WHERE c.id = @id AND c.user_principal_name = @upn',
            parameters: [
              { name: '@id', value: turnId },
              { name: '@upn', value: userPrincipalName },
            ],
          })
          .fetchAll(),
      { isRetryable: isLikelyTransientAzureError },
    );
    const turn = resources[0];
    if (!turn) return false;
    turn.feedback = feedback;
    await withRetry(() => this.container().items.upsert(turn), { isRetryable: isLikelyTransientAzureError });
    return true;
  }
}

export function createAzureConversationStore(config: TrialPulseConfig): ConversationStore {
  return new AzureConversationStore(config);
}
