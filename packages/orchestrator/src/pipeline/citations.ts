/**
 * Citation parsing and validation (query-pipeline step 11).
 *
 * The model is instructed (see `prompt.ts`) to cite context by its numbered
 * index, e.g. `[1]`, `[2]`. Models -- including our deterministic memory
 * generation provider standing in for one -- occasionally invent an index
 * that was never supplied (a hallucinated `[7]` when only 3 chunks were
 * given). This module is the single place that turns "raw model text +
 * numbered chunks" into "final answer text + a citation list that the text
 * and the list agree on":
 *
 *  - Any bracketed index that does not map to a supplied chunk is stripped
 *    from the answer text entirely (never rendered, never trusted).
 *  - Any supplied chunk the model never actually cited is dropped from the
 *    returned citation list (no dangling, uncited sources).
 *  - The surviving citations are renumbered in order of first appearance so
 *    citation `[1]` in the final text is always `citations[0]`, `[2]` is
 *    always `citations[1]`, and so on -- regardless of what index the model
 *    originally used.
 */
import type { Citation, ScoredChunk } from '@trialpulse/shared';

const CITATION_MARKER_RE = /\[(\d+)\]/g;

/** Build the numbered chunk list exactly as presented to the model in the prompt (1-indexed). */
export function numberChunks(chunks: readonly ScoredChunk[]): Array<{ index: number; chunk: ScoredChunk }> {
  return chunks.map((chunk, i) => ({ index: i + 1, chunk }));
}

function chunkToCitation(chunk: ScoredChunk, index: number): Citation {
  return {
    index,
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    document_title: chunk.document_title,
    document_classification: chunk.document_classification,
    document_version: chunk.document_version,
    heading_path: chunk.heading_path,
    page_number: chunk.page_number,
    // D1: `redactChunksForRole` sets `source_url` to `''` as an in-pipeline
    // sentinel for "this chunk's source must not be disclosed to this
    // caller" (see `pipeline/redaction.ts`). Render that as `null` here --
    // the point in the pipeline where a `Chunk` becomes a caller-facing
    // `Citation` -- rather than ever emitting an empty-but-truthy URL.
    source_url: chunk.source_url.length > 0 ? chunk.source_url : null,
    similarity_score: chunk.similarity_score,
  };
}

export interface CitationValidationResult {
  /** Answer text with invented citation markers stripped and valid ones renumbered. */
  text: string;
  citations: Citation[];
}

/**
 * Validate and renumber citations in `rawAnswerText` against `chunks`
 * (the same array, in the same order, that was numbered `[1]..[n]` in the
 * prompt).
 */
export function validateAndRenumberCitations(
  rawAnswerText: string,
  chunks: readonly ScoredChunk[],
): CitationValidationResult {
  // Map from the *original* 1-based prompt index to a *new* sequential index,
  // assigned the first time that original index is seen, in text order.
  const renumbered = new Map<number, number>();
  let nextIndex = 1;

  const text = rawAnswerText.replace(CITATION_MARKER_RE, (whole, rawDigits: string) => {
    const original = Number(rawDigits);
    const isValid = Number.isInteger(original) && original >= 1 && original <= chunks.length;
    if (!isValid) {
      // Hallucinated index: drop the marker entirely rather than rendering a
      // citation that points nowhere. Collapse the resulting double space.
      return '';
    }
    let mapped = renumbered.get(original);
    if (mapped === undefined) {
      mapped = nextIndex;
      nextIndex += 1;
      renumbered.set(original, mapped);
    }
    return `[${mapped}]`;
  });

  const citations: Citation[] = [];
  for (const [originalIndex, newIndex] of renumbered.entries()) {
    const chunk = chunks[originalIndex - 1];
    if (!chunk) continue; // unreachable given the bounds check above; defensive only.
    citations.push(chunkToCitation(chunk, newIndex));
  }
  citations.sort((a, b) => a.index - b.index);

  // Tidy up whitespace left behind by a stripped marker (e.g. "answer [7]." -> "answer .").
  const cleanedText = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();

  return { text: cleanedText, citations };
}
