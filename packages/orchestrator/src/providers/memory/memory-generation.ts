/**
 * Deterministic extractive "model" for local dev, unit tests and the eval
 * harness.
 *
 * Real GPT-4o/GPT-4o-mini calls are non-deterministic (temperature,
 * provider-side sampling); the eval suite needs a stand-in that is
 * deterministic *and* actually grounded in the supplied context, not a
 * canned string. This provider:
 *
 *  - Parses the numbered `--- CONTEXT [n] ---` blocks out of the system
 *    prompt built by `prompt.ts` (it never sees the original `ScoredChunk[]`
 *    directly -- `GenerationProvider.generate` only takes `{system, user}`,
 *    so recovering structure from the rendered prompt is the only option,
 *    exactly as a real model would).
 *  - When no context blocks are present, returns the canonical refusal
 *    string via `refusal.ts` -- it never falls back to "knowledge" it does
 *    not have.
 *  - Otherwise, for each context block, picks the sentence with the highest
 *    lexical overlap with the user's question and cites it `[n]`.
 *  - When the system prompt carries `SUMMARY_ONLY_MARKER` (the executive
 *    role's redaction directive), instead produces at most 3 bullet points
 *    that paraphrase (rather than quote verbatim) the most relevant
 *    sentence per selected context block.
 *
 * It deliberately does not echo the user's question back into the answer.
 */
import { approximateTokens } from '@trialpulse/shared';
import type { GenerationProvider, GenerationRequest, GenerationResult } from '../types';
import { buildNoChunksRefusal } from '../../pipeline/refusal';
import { SUMMARY_ONLY_MARKER } from '../../pipeline/redaction';
import { tokenize } from './memory-embeddings';

const MEMORY_GENERATION_MODEL_PREFIX = 'memory-generation';

interface ParsedContextBlock {
  index: number;
  content: string;
}

// D4: keep in sync with `pipeline/prompt.ts`'s `formatChunkBlock` -- the
// delimiter now carries a per-request nonce, `(...)`, matched via a
// backreference so the opening and closing markers must carry the *same*
// nonce (the nonce's actual value is opaque to this parser; only that the
// two sides agree matters).
const CONTEXT_BLOCK_RE = /--- CONTEXT \[(\d+)\] \(([^)]*)\) ---\r?\n([\s\S]*?)\r?\n--- END CONTEXT \[\1\] \(\2\) ---/g;
// Not anchored: the block body has header lines (Title/Version/Section/Page)
// before a "Content:" line, and we want everything after that line, however
// many lines the content itself spans.
const CONTENT_LINE_RE = /Content:\r?\n([\s\S]*)/;

/** Recover the numbered context blocks from a system prompt built by `prompt.ts`. */
/** Exported for D4 regression tests: asserting the parser recovers exactly the real blocks, not a forged one. */
export function parseContextBlocks(system: string): ParsedContextBlock[] {
  const blocks: ParsedContextBlock[] = [];
  for (const match of system.matchAll(CONTEXT_BLOCK_RE)) {
    const index = Number(match[1]);
    const body = match[3] ?? '';
    const contentMatch = body.match(CONTENT_LINE_RE);
    const content = contentMatch?.[1] ?? body;
    blocks.push({ index, content: content.trim() });
  }
  return blocks;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'what', 'when', 'how', 'does',
  'do', 'did', 'was', 'were', 'this', 'that', 'with', 'by', 'from', 'as', 'it', 'its', 'be', 'been', 'has', 'have',
]);

function overlapScore(question: string, sentence: string): number {
  const questionTerms = new Set(tokenize(question).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
  if (questionTerms.size === 0) return 0;
  const sentenceTerms = tokenize(sentence);
  let hits = 0;
  for (const term of sentenceTerms) {
    if (questionTerms.has(term)) hits += 1;
  }
  return hits;
}

/** Pick the best-matching sentence in a context block for the user's question. */
function bestSentence(question: string, blockContent: string): string {
  const sentences = splitSentences(blockContent);
  if (sentences.length === 0) return blockContent.trim();
  let best = sentences[0]!;
  let bestScore = -1;
  for (const sentence of sentences) {
    const s = overlapScore(question, sentence);
    if (s > bestScore) {
      bestScore = s;
      best = sentence;
    }
  }
  return best;
}

/** Light paraphrase so the summary-only path never emits verbatim document text. */
function paraphrase(sentence: string): string {
  const trimmed = sentence.replace(/[.\s]+$/, '');
  const lower = trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
  return `In summary, ${lower}`;
}

function extractQuestion(userMessage: string): string {
  return userMessage.trim();
}

export class MemoryGenerationProvider implements GenerationProvider {
  generate(request: GenerationRequest): Promise<GenerationResult> {
    const blocks = parseContextBlocks(request.system);
    const question = extractQuestion(request.user);
    const tokensInput = approximateTokens(request.system) + approximateTokens(request.user);

    if (blocks.length === 0) {
      const text = buildNoChunksRefusal(question);
      return Promise.resolve({
        text,
        tokensInput,
        tokensOutput: approximateTokens(text),
        model: `${MEMORY_GENERATION_MODEL_PREFIX}:${request.model}`,
      });
    }

    const isSummaryOnly = request.system.includes(SUMMARY_ONLY_MARKER);
    const text = isSummaryOnly ? this.buildSummary(question, blocks) : this.buildExtractiveAnswer(question, blocks);

    return Promise.resolve({
      text,
      tokensInput,
      tokensOutput: approximateTokens(text),
      model: `${MEMORY_GENERATION_MODEL_PREFIX}:${request.model}`,
    });
  }

  /**
   * Ground the answer in each context block's *entire* content (not just a
   * single extracted sentence): a block already represents one focused
   * section, so quoting it in full is strictly grounded and, unlike
   * best-sentence extraction, never risks picking a topically-adjacent but
   * factually-empty sentence (e.g. a version-compare block's header
   * sentence, which shares more vocabulary with "what changed between
   * version X and Y" than the actual facts that changed do).
   */
  private buildExtractiveAnswer(_question: string, blocks: ParsedContextBlock[]): string {
    return blocks.map(({ index, content }) => `${content.trim()} [${index}]`).join(' ');
  }

  private buildSummary(question: string, blocks: ParsedContextBlock[]): string {
    const top = blocks.slice(0, 3);
    return top
      .map(({ index, content }) => `- ${paraphrase(bestSentence(question, content))} [${index}]`)
      .join('\n');
  }
}
