/**
 * Adaptive Card JSON for a TrialPulse answer (PRD 6.2 `CitedAnswerCard`).
 *
 * Adaptive Cards are plain JSON conforming to the Adaptive Card schema --
 * there is no required SDK to build one, just an object shaped correctly
 * and sent as a `application/vnd.microsoft.card.adaptive` attachment. This
 * keeps card construction fully unit-testable without a Bot Framework
 * dependency.
 */
import type { QueryResponse } from '@trialpulse/shared';

// Loosely typed on purpose: the Adaptive Card schema is large and we only
// ever construct a handful of element kinds here. `unknown`-typed fields
// would fight the object literal shape below for no safety benefit.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AdaptiveCard = Record<string, any>;

export interface AnswerCardOptions {
  /** Identifies this turn for the thumbs up/down `Action.Submit` payload. */
  turnId: string;
}

/** Citations whose `source_url` survived redaction (see D1, `pipeline/redaction.ts`) -- these alone get a clickable action. */
function citationActions(response: QueryResponse): AdaptiveCard[] {
  return response.citations
    .filter((citation) => citation.source_url !== null)
    .map((citation) => ({
      type: 'Action.OpenUrl',
      title: `[${citation.index}] ${citation.document_title}`,
      url: citation.source_url as string,
    }));
}

/**
 * A `source_url: null` citation (D1) must never be rendered as a link --
 * there is nothing safe to link to, by design. Render it as plain,
 * non-clickable text instead, in the same numbered list style.
 */
function restrictedCitationsBlock(response: QueryResponse): AdaptiveCard | null {
  const restricted = response.citations.filter((citation) => citation.source_url === null);
  if (restricted.length === 0) return null;
  return {
    type: 'TextBlock',
    wrap: true,
    isSubtle: true,
    size: 'Small',
    spacing: 'Small',
    text: restricted.map((c) => `[${c.index}] ${c.document_title} (source restricted)`).join('\n'),
  };
}

/** Builds the Adaptive Card attachment body for a `QueryResponse`. */
export function buildAnswerCard(response: QueryResponse, options: AnswerCardOptions): AdaptiveCard {
  const body: AdaptiveCard[] = [
    {
      type: 'TextBlock',
      text: response.answer,
      wrap: true,
    },
  ];

  if (response.redaction_notice) {
    body.push({
      type: 'TextBlock',
      text: response.redaction_notice,
      wrap: true,
      isSubtle: true,
      size: 'Small',
      spacing: 'Small',
    });
  }

  const restrictedBlock = restrictedCitationsBlock(response);
  if (restrictedBlock) {
    body.push(restrictedBlock);
  }

  const openableActions = citationActions(response);
  if (openableActions.length > 0) {
    body.push({
      type: 'ActionSet',
      spacing: 'Medium',
      actions: openableActions,
    });
  }

  const actions: AdaptiveCard[] = [
    {
      type: 'Action.Submit',
      title: '👍 Helpful', // thumbs up
      data: { action: 'feedback', turn_id: options.turnId, feedback: 'up' },
    },
    {
      type: 'Action.Submit',
      title: '👎 Not helpful', // thumbs down
      data: { action: 'feedback', turn_id: options.turnId, feedback: 'down' },
    },
  ];

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body,
    actions,
  };
}

/** Wraps a card body in the Bot Framework attachment envelope for a message activity. */
export function toCardAttachment(card: AdaptiveCard): { contentType: string; content: AdaptiveCard } {
  return { contentType: 'application/vnd.microsoft.card.adaptive', content: card };
}

/** A short, plain-text acknowledgement for feedback submissions (no card round-trip needed). */
export function buildFeedbackAckText(feedback: 'up' | 'down'): string {
  return feedback === 'up' ? 'Thanks for the feedback!' : 'Thanks -- we will use this to improve answers.';
}
