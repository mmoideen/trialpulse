import type { QueryResponse } from '@trialpulse/shared';
import { describe, expect, it } from 'vitest';
import { buildAnswerCard, buildFeedbackAckText, toCardAttachment } from './cards';

function response(overrides: Partial<QueryResponse> = {}): QueryResponse {
  return {
    trace_id: 'trace-1',
    status: 'answered',
    answer: 'The enrollment target is 480 participants [1].',
    citations: [
      {
        index: 1,
        chunk_id: 'c1',
        document_id: 'd1',
        document_title: 'AXIOM-HN01 Protocol v3.0',
        document_classification: 'protocol',
        document_version: '3.0',
        heading_path: '1. Study Design',
        page_number: 1,
        source_url: 'https://example.com/doc#page=1',
        similarity_score: 0.9,
      },
    ],
    refusal_reason: null,
    role: 'regulatory_affairs',
    redaction_notice: null,
    model_used: 'gpt-4o',
    latency_ms: 500,
    cache_hit: false,
    estimated_cost_usd: 0.01,
    ...overrides,
  };
}

describe('buildAnswerCard', () => {
  it('includes the answer text', () => {
    const card = buildAnswerCard(response(), { turnId: 'turn-1' });
    expect(card['body'][0]).toMatchObject({ type: 'TextBlock', text: expect.stringContaining('480 participants') });
  });

  it('renders a numbered citation pill linking to source_url', () => {
    const card = buildAnswerCard(response(), { turnId: 'turn-1' });
    const actionSet = card['body'].find((b: { type: string }) => b.type === 'ActionSet');
    expect(actionSet.actions[0]).toMatchObject({
      type: 'Action.OpenUrl',
      title: '[1] AXIOM-HN01 Protocol v3.0',
      url: 'https://example.com/doc#page=1',
    });
  });

  it('includes thumbs up/down actions carrying the turn id', () => {
    const card = buildAnswerCard(response(), { turnId: 'turn-42' });
    expect(card['actions']).toHaveLength(2);
    expect(card['actions'][0].data).toMatchObject({ action: 'feedback', turn_id: 'turn-42', feedback: 'up' });
    expect(card['actions'][1].data).toMatchObject({ action: 'feedback', turn_id: 'turn-42', feedback: 'down' });
  });

  it('renders a redaction notice block when present', () => {
    const card = buildAnswerCard(response({ redaction_notice: 'Summary only.' }), { turnId: 't' });
    expect(card['body'].some((b: { text?: string }) => b.text === 'Summary only.')).toBe(true);
  });

  it('omits the citation ActionSet when there are no citations (e.g. a refusal)', () => {
    const card = buildAnswerCard(response({ citations: [], status: 'refused', answer: 'I cannot find information about X.' }), {
      turnId: 't',
    });
    expect(card['body'].some((b: { type: string }) => b.type === 'ActionSet')).toBe(false);
  });

  it('D1: never renders an Action.OpenUrl for a citation with source_url: null, and shows a restricted label instead', () => {
    const card = buildAnswerCard(
      response({
        citations: [
          {
            index: 1,
            chunk_id: 'c1',
            document_id: 'd1',
            document_title: 'Site US-027 Protocol Deviation Notice',
            document_classification: 'site_communication',
            document_version: '1.0',
            heading_path: '[SITE REDACTED] Protocol Deviation Notice',
            page_number: 1,
            source_url: null,
            similarity_score: 0.9,
          },
        ],
      }),
      { turnId: 'turn-1' },
    );
    expect(card['body'].some((b: { type: string }) => b.type === 'ActionSet')).toBe(false);
    const restrictedBlock = card['body'].find((b: { text?: string }) =>
      typeof b.text === 'string' && b.text.includes('source restricted'),
    );
    expect(restrictedBlock).toBeDefined();
    expect(restrictedBlock.text).toContain('Site US-027 Protocol Deviation Notice');
  });

  it('D1: renders a clickable citation and a restricted one side by side correctly', () => {
    const openCitation = response().citations[0]!;
    const restrictedCitation = { ...openCitation, index: 2, chunk_id: 'c2', source_url: null, document_title: 'Restricted Doc' };
    const card = buildAnswerCard(response({ citations: [openCitation, restrictedCitation] }), { turnId: 't' });
    const actionSet = card['body'].find((b: { type: string }) => b.type === 'ActionSet');
    expect(actionSet.actions).toHaveLength(1);
    expect(actionSet.actions[0].url).toBe(openCitation.source_url);
    const restrictedBlock = card['body'].find((b: { text?: string }) =>
      typeof b.text === 'string' && b.text.includes('source restricted'),
    );
    expect(restrictedBlock.text).toContain('Restricted Doc');
  });
});

describe('toCardAttachment', () => {
  it('wraps the card in the adaptive card content type', () => {
    const card = buildAnswerCard(response(), { turnId: 't' });
    const attachment = toCardAttachment(card);
    expect(attachment.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(attachment.content).toBe(card);
  });
});

describe('buildFeedbackAckText', () => {
  it('differs between up and down', () => {
    expect(buildFeedbackAckText('up')).not.toBe(buildFeedbackAckText('down'));
  });
});
