import { useState } from 'react';

const STORAGE_KEY = 'trialpulse.conversationId';

/**
 * `QueryResponse` does not echo back a `conversation_id` (see
 * packages/shared/src/types.ts), so the client is the source of truth for
 * which conversation thread it is contributing to: it mints a UUID once per
 * browser profile, persists it, and sends it on every `QueryRequest`. The
 * orchestrator associates turns under that id; `GET /api/conversations/:id`
 * reads them back for the history sidebar.
 */
function readOrCreateConversationId(): string {
  try {
    const existing = window.localStorage.getItem(STORAGE_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(STORAGE_KEY, created);
    return created;
  } catch {
    // localStorage unavailable (e.g. privacy mode): fall back to an
    // in-memory id that lasts for this session only.
    return crypto.randomUUID();
  }
}

export function useConversationId(): string {
  const [conversationId] = useState(readOrCreateConversationId);
  return conversationId;
}
