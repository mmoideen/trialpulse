import type { ConversationTurn } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { MemoryConversationStore } from './memory-conversations';

function turn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    id: 'turn',
    conversation_id: 'conv-1',
    user_principal_name: 'user@meridiantx.com',
    role: 'regulatory_affairs',
    question: 'q',
    answer: 'a',
    citations: [],
    status: 'answered',
    timestamp: '2026-06-15T12:00:00.000Z',
    feedback: null,
    ttl: 2_592_000,
    ...overrides,
  };
}

/** `2026-06-15T12:00:{seconds}.000Z`, so turn 25 is newest and turn 1 is oldest -- matching the reviewer's `t1..t25` repro. */
function timestampFor(n: number): string {
  return `2026-06-15T12:${String(n).padStart(2, '0')}:00.000Z`;
}

describe('MemoryConversationStore', () => {
  it('lists a caller\'s own turns, newest first', async () => {
    const store = new MemoryConversationStore();
    await store.append(turn({ id: 't1', timestamp: timestampFor(1) }));
    await store.append(turn({ id: 't2', timestamp: timestampFor(2) }));
    const page = await store.list('conv-1', 'user@meridiantx.com');
    expect(page.turns.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(page.continuation).toBeNull();
  });

  it('never returns another user\'s turns for the same conversation id', async () => {
    const store = new MemoryConversationStore();
    await store.append(turn({ id: 't1', user_principal_name: 'someone.else@meridiantx.com' }));
    const page = await store.list('conv-1', 'user@meridiantx.com');
    expect(page.turns).toEqual([]);
  });

  it('paginates at the requested limit and returns a continuation when more remain', async () => {
    const store = new MemoryConversationStore();
    for (let i = 1; i <= 25; i += 1) {
      await store.append(turn({ id: `t${i}`, timestamp: timestampFor(i) }));
    }
    const page1 = await store.list('conv-1', 'user@meridiantx.com', { limit: 20 });
    expect(page1.turns).toHaveLength(20);
    expect(page1.turns[0]?.id).toBe('t25');
    expect(page1.turns[19]?.id).toBe('t6');
    expect(page1.continuation).not.toBeNull();

    const page2 = await store.list('conv-1', 'user@meridiantx.com', { limit: 20, continuation: page1.continuation ?? undefined });
    expect(page2.turns.map((t) => t.id)).toEqual(['t5', 't4', 't3', 't2', 't1']);
    expect(page2.continuation).toBeNull();
  });

  it('D10: a turn appended between page 1 and page 2 is never duplicated and never skipped', async () => {
    const store = new MemoryConversationStore();
    for (let i = 1; i <= 25; i += 1) {
      await store.append(turn({ id: `t${i}`, timestamp: timestampFor(i) }));
    }
    const page1 = await store.list('conv-1', 'user@meridiantx.com', { limit: 20 });
    expect(page1.turns[page1.turns.length - 1]?.id).toBe('t6');

    // A new turn arrives, newer than everything already returned -- exactly
    // the reviewer's repro (append between page 1 and "load more").
    await store.append(turn({ id: 't26', timestamp: timestampFor(26) }));

    const page2 = await store.list('conv-1', 'user@meridiantx.com', { limit: 20, continuation: page1.continuation ?? undefined });
    const page2Ids = page2.turns.map((t) => t.id);
    expect(page2Ids).toEqual(['t5', 't4', 't3', 't2', 't1']);
    // The stable cursor must never re-surface anything already returned on
    // page 1, and never skip anything either.
    const allIds = [...page1.turns.map((t) => t.id), ...page2Ids];
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates
    for (let i = 1; i <= 25; i += 1) {
      expect(allIds).toContain(`t${i}`); // nothing skipped (t26 is new, not part of the original 25)
    }
  });

  it('treats a malformed/foreign continuation token as "start from the top" rather than throwing', async () => {
    const store = new MemoryConversationStore();
    await store.append(turn({ id: 't1', timestamp: timestampFor(1) }));
    const page = await store.list('conv-1', 'user@meridiantx.com', { continuation: 'not-a-real-cursor' });
    expect(page.turns.map((t) => t.id)).toEqual(['t1']);
  });
});
