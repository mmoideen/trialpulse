/**
 * In-memory `ConversationStore` for local dev, unit tests and the eval
 * harness. Enforces the same "a caller may only read their own conversation"
 * rule the Cosmos-backed implementation enforces via partition key.
 */
import type { ConversationTurn } from '@trialpulse/shared';
import { CONVERSATION_PAGE_SIZE } from '@trialpulse/shared';
import type { ConversationStore } from '../types';

/**
 * D10: a raw numeric OFFSET into a list sorted newest-first, that GROWS AT
 * THE HEAD (new turns are always the newest), shifts under concurrent
 * append -- page 1 returns `t25..t6` with continuation `"20"`; append `t26`;
 * page 2 (offset 20) now returns `t6..t1`, duplicating `t6`. A stable cursor
 * anchored to the last item actually returned (`before|<timestamp>|<id>`)
 * is immune to this: it is never affected by how many *newer* items appear
 * ahead of it, only by items strictly older than it, which is exactly the
 * set the next page should show regardless of what got appended meanwhile.
 */
const CURSOR_PREFIX = 'before';

function compareTurnsNewestFirst(a: ConversationTurn, b: ConversationTurn): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
  // Deterministic tie-break for turns sharing a timestamp (e.g. two writes
  // in the same millisecond): without one, "the last item on this page" is
  // ambiguous and the cursor built from it would not reproducibly bound the
  // next page.
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function encodeCursor(turn: ConversationTurn): string {
  return `${CURSOR_PREFIX}|${turn.timestamp}|${turn.id}`;
}

function decodeCursor(raw: string): { timestamp: string; id: string } | null {
  const parts = raw.split('|');
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) return null;
  const [, timestamp, id] = parts;
  if (!timestamp || !id) return null;
  return { timestamp, id };
}

/** True when `turn` sorts strictly after `cursor`'s position in the newest-first order (i.e. `turn` is older). */
function isStrictlyOlderThanCursor(turn: ConversationTurn, cursor: { timestamp: string; id: string }): boolean {
  if (turn.timestamp !== cursor.timestamp) return turn.timestamp < cursor.timestamp;
  return turn.id < cursor.id;
}

export class MemoryConversationStore implements ConversationStore {
  private readonly turns: ConversationTurn[] = [];

  append(turn: ConversationTurn): Promise<void> {
    this.turns.push(turn);
    return Promise.resolve();
  }

  list(
    conversationId: string,
    userPrincipalName: string,
    options: { limit?: number; continuation?: string } = {},
  ): Promise<{ turns: ConversationTurn[]; continuation: string | null }> {
    const owned = this.turns
      .filter((t) => t.conversation_id === conversationId && t.user_principal_name === userPrincipalName)
      .sort(compareTurnsNewestFirst);

    const limit = options.limit ?? CONVERSATION_PAGE_SIZE;

    let startIndex = 0;
    if (options.continuation) {
      const cursor = decodeCursor(options.continuation);
      // An unparsable/foreign continuation is treated as "start from the
      // top" rather than thrown -- the same forgiving posture a malformed
      // Cosmos continuation token would need at this layer.
      if (cursor) {
        const firstOlderIndex = owned.findIndex((t) => isStrictlyOlderThanCursor(t, cursor));
        startIndex = firstOlderIndex === -1 ? owned.length : firstOlderIndex;
      }
    }

    const page = owned.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + page.length < owned.length;
    const lastOfPage = page[page.length - 1];
    const continuation = hasMore && lastOfPage ? encodeCursor(lastOfPage) : null;
    return Promise.resolve({ turns: page, continuation });
  }

  recordFeedback(turnId: string, userPrincipalName: string, feedback: 'up' | 'down'): Promise<boolean> {
    const turn = this.turns.find((t) => t.id === turnId && t.user_principal_name === userPrincipalName);
    if (!turn) return Promise.resolve(false);
    turn.feedback = feedback;
    return Promise.resolve(true);
  }
}
