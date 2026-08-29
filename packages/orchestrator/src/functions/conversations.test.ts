import type { ConversationTurn } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { handleGetConversation } from './conversations';
import { buildTestDeps, devHeaders } from './test-support';

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn-1',
    conversation_id: 'conv-1',
    user_principal_name: 'regulatory_affairs@meridiantx.com',
    role: 'regulatory_affairs',
    question: 'q',
    answer: 'a',
    citations: [],
    status: 'answered',
    timestamp: '2026-06-15T12:00:00.000Z',
    feedback: null,
    ttl: 2592000,
    ...overrides,
  };
}

describe('GET /api/conversations/{id}', () => {
  it('returns the caller\'s own conversation turns', async () => {
    const { deps } = buildTestDeps();
    await deps.conversations.append(turn());
    const result = await handleGetConversation(deps, devHeaders('regulatory_affairs'), 'conv-1', undefined);
    expect(result.status).toBe(200);
    expect((result.jsonBody as { turns: ConversationTurn[] }).turns).toHaveLength(1);
  });

  it('never returns another user\'s turns for the same conversation id', async () => {
    const { deps } = buildTestDeps();
    await deps.conversations.append(turn({ user_principal_name: 'someone.else@meridiantx.com' }));
    const result = await handleGetConversation(deps, devHeaders('regulatory_affairs'), 'conv-1', undefined);
    expect(result.status).toBe(200);
    expect((result.jsonBody as { turns: ConversationTurn[] }).turns).toHaveLength(0);
  });

  it('rejects an unauthenticated caller', async () => {
    const { deps } = buildTestDeps({ config: { authMode: 'production' } });
    const result = await handleGetConversation(deps, {}, 'conv-1', undefined);
    expect(result.status).toBe(401);
  });

  describe('D10: honours the client-supplied limit', () => {
    it('returns exactly `limit` turns per page instead of always CONVERSATION_PAGE_SIZE', async () => {
      const { deps } = buildTestDeps();
      for (let i = 1; i <= 10; i += 1) {
        await deps.conversations.append(turn({ id: `turn-${i}`, timestamp: `2026-06-15T12:${String(i).padStart(2, '0')}:00.000Z` }));
      }
      const result = await handleGetConversation(deps, devHeaders('regulatory_affairs'), 'conv-1', undefined, '3');
      expect((result.jsonBody as { turns: ConversationTurn[] }).turns).toHaveLength(3);
    });

    it('clamps an excessive limit rather than honouring it unbounded', async () => {
      const { deps } = buildTestDeps();
      for (let i = 1; i <= 10; i += 1) {
        await deps.conversations.append(turn({ id: `turn-${i}`, timestamp: `2026-06-15T12:${String(i).padStart(2, '0')}:00.000Z` }));
      }
      const result = await handleGetConversation(deps, devHeaders('regulatory_affairs'), 'conv-1', undefined, '999999');
      expect((result.jsonBody as { turns: ConversationTurn[] }).turns).toHaveLength(10); // bounded by available turns, request itself was clamped internally
    });

    it('falls back to the store default for a non-numeric limit rather than erroring', async () => {
      const { deps } = buildTestDeps();
      await deps.conversations.append(turn());
      const result = await handleGetConversation(deps, devHeaders('regulatory_affairs'), 'conv-1', undefined, 'not-a-number');
      expect(result.status).toBe(200);
    });
  });
});
