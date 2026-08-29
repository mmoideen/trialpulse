import { validate as isUuid } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createLocalHarness } from '../local/harness';
import { activityToQueryRequest, handleTeamsActivity, type TeamsActivity } from './teams-bot';

describe('activityToQueryRequest', () => {
  it('trims the text and derives a stable UUID conversation id from the Teams conversation id', () => {
    const activity: TeamsActivity = {
      type: 'message',
      text: '  What is the enrollment target?  ',
      conversation: { id: '19:abc123@thread.tacv2' },
    };
    const request = activityToQueryRequest(activity);
    expect(request.query).toBe('What is the enrollment target?');
    expect(isUuid(request.conversation_id ?? '')).toBe(true);
  });

  it('derives the same conversation id for the same Teams conversation every time', () => {
    const a = activityToQueryRequest({ type: 'message', text: 'q1', conversation: { id: '19:abc123@thread.tacv2' } });
    const b = activityToQueryRequest({ type: 'message', text: 'q2', conversation: { id: '19:abc123@thread.tacv2' } });
    expect(a.conversation_id).toBe(b.conversation_id);
  });

  it('leaves conversation_id undefined when the activity has no conversation', () => {
    const request = activityToQueryRequest({ type: 'message', text: 'hello' });
    expect(request.conversation_id).toBeUndefined();
  });
});

describe('handleTeamsActivity', () => {
  it('answers a question through the same pipeline as /api/query, rendering an Adaptive Card', async () => {
    const harness = await createLocalHarness();
    const identity = harness.identityFor('regulatory_affairs');
    const activity: TeamsActivity = {
      type: 'message',
      text: 'What is the planned enrollment for AXIOM-HN01?',
      conversation: { id: 'conv-1' },
    };
    const reply = await handleTeamsActivity({ pipeline: harness.pipeline, conversations: harness.conversations }, identity, activity);
    expect(reply.type).toBe('message');
    expect(reply.attachments?.[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.stringify(reply.attachments?.[0]?.content)).toContain('480 participants');
  });

  it('records feedback from a thumbs up/down card postback instead of asking the pipeline', async () => {
    const harness = await createLocalHarness();
    const identity = harness.identityFor('regulatory_affairs');
    const answer = await harness.ask('regulatory_affairs', 'What is the planned enrollment for AXIOM-HN01?');

    const activity: TeamsActivity = {
      type: 'message',
      value: { action: 'feedback', turn_id: answer.trace_id, feedback: 'up' },
    };
    const reply = await handleTeamsActivity({ pipeline: harness.pipeline, conversations: harness.conversations }, identity, activity);
    expect(reply.text).toMatch(/thanks/i);
    expect(reply.attachments).toBeUndefined();
  });
});
