import type { Citation } from '@trialpulse/shared';

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'citation'; text: string; citation: Citation };

const CITATION_MARKER = /\[(\d+)\]/g;

/**
 * Splits model-generated answer text into plain-text and citation-marker
 * segments so the caller can render citation markers as clickable pills
 * while every other character -- including anything that looks like markup
 * -- stays a plain string. This function never touches the DOM; it is a pure
 * text -> segment-array transform. The caller renders every segment as a
 * React text node (which auto-escapes), never by assigning raw HTML.
 */
export function splitAnswerIntoSegments(answer: string, citations: Citation[]): AnswerSegment[] {
  const byIndex = new Map(citations.map((c) => [c.index, c]));
  const segments: AnswerSegment[] = [];
  let lastIndex = 0;

  for (const match of answer.matchAll(CITATION_MARKER)) {
    const full = match[0];
    const numStr = match[1] ?? '';
    const matchIndex = match.index ?? 0;
    const citation = byIndex.get(Number(numStr));
    // A bracketed number with no matching citation (e.g. "[99]" when there
    // is no citation 99) is not a citation marker -- leave it exactly where
    // it was, merged into the surrounding text, instead of splitting it into
    // its own segment.
    if (!citation) continue;

    if (matchIndex > lastIndex) {
      segments.push({ kind: 'text', text: answer.slice(lastIndex, matchIndex) });
    }
    segments.push({ kind: 'citation', text: full, citation });
    lastIndex = matchIndex + full.length;
  }

  if (lastIndex < answer.length) {
    segments.push({ kind: 'text', text: answer.slice(lastIndex) });
  }
  return segments;
}
