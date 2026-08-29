import type { ConversationTurn } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { handleFeedback } from './feedback';
import { buildTestDeps, devHeaders } from './test-support';

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    conversation_id: '11111111-1111-1111-1111-111111111111',
    user_principal_name: 'regulatory_affairs@meridiantx.com',
    role: 'regulatory_affairs',
    question: 'What is the enrollment target?',
    answer: '480 participants [1]',
    citations: [],
    status: 'answered',
    timestamp: '2026-06-15T12:00:00.000Z',
    feedback: null,
    ttl: 2592000,
    ...overrides,
  };
}

describe('POST /api/feedback', () => {
  it('records feedback for the caller\'s own turn', async () => {
    const { deps } = buildTestDeps();
    await deps.conversations.append(turn());
    const result = await handleFeedback(deps, devHeaders('regulatory_affairs'), {
      turn_id: '22222222-2222-2222-2222-222222222222',
      feedback: 'up',
    });
    expect(result.status).toBe(200);
  });

  it('D7: response matches the published { turn_id, feedback } contract, not { recorded: true }', async () => {
    const { deps } = buildTestDeps();
    await deps.conversations.append(turn());
    const result = await handleFeedback(deps, devHeaders('regulatory_affairs'), {
      turn_id: '22222222-2222-2222-2222-222222222222',
      feedback: 'down',
    });
    expect(result.jsonBody).toEqual({
      turn_id: '22222222-2222-2222-2222-222222222222',
      feedback: 'down',
    });
  });

  it('returns 404 when the turn belongs to a different user', async () => {
    const { deps } = buildTestDeps();
    await deps.conversations.append(turn({ user_principal_name: 'someone.else@meridiantx.com' }));
    const result = await handleFeedback(deps, devHeaders('regulatory_affairs'), {
      turn_id: '22222222-2222-2222-2222-222222222222',
      feedback: 'up',
    });
    expect(result.status).toBe(404);
  });

  it('returns 400 for an invalid feedback payload', async () => {
    const { deps } = buildTestDeps();
    const result = await handleFeedback(deps, devHeaders('regulatory_affairs'), { turn_id: 'not-a-uuid', feedback: 'up' });
    expect(result.status).toBe(400);
  });
});
