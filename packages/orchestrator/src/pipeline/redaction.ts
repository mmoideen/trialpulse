/**
 * Redaction (PRD section 3.1 role table + `ROLE_POLICIES[role].redaction`).
 *
 * Two different mechanisms are used here, deliberately:
 *
 *  - `safetyAggregateOnly` and `maskUnassignedSites` operate on *chunk
 *    content, before the model ever sees it*. This is the safer of the two
 *    mechanisms: the model is structurally incapable of leaking a patient
 *    identifier or an unassigned site code because the text was never in its
 *    context window. `redactChunksForRole` implements this.
 *
 *  - `summaryOnly` is a generation-time directive: we cannot strip "not a
 *    3-bullet summary" out of chunk text before the model runs, because the
 *    constraint is about the *shape of the answer*, not the source material.
 *    `buildPromptDirectives` returns an instruction embedded in the system
 *    prompt (see `prompt.ts`); `SUMMARY_ONLY_MARKER` is the sentinel the
 *    deterministic memory generation provider looks for so the eval suite
 *    stays deterministic even for this role.
 *
 *  - `adminWatermark` is applied to the *generated answer text*, after the
 *    model call, by `applyAdminWatermark`. Prefixing is trivial and
 *    deterministic; there is no reason to trust a model instruction to do it
 *    reliably when a one-line string operation is exact every time.
 */
import type { CallerIdentity, Role, ScoredChunk } from '@trialpulse/shared';
import { getRolePolicy } from '@trialpulse/shared';

export const SUMMARY_ONLY_MARKER = '[[TRIALPULSE_DIRECTIVE:SUMMARY_ONLY]]';
export const ADMIN_WATERMARK_TEXT = '**ADMIN ACCESS**';

const PARTICIPANT_ID_RE = /\b\d{3}-\d{4}\b/g;
const INITIALS_RE = /\b[A-Z]\.\s?[A-Z]\.(?=[\s,.]|$)/g;
const DOB_RE = /date of birth[,:]?\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}/gi;
const AGE_SEX_RE = /\b\d{1,3}-year-old\s+(?:male|female|man|woman)\b/gi;
// Case-insensitive: the original pattern (`[A-Z]{2}-\d{3}`, uppercase only)
// matched site codes in running prose ("Site US-027 ...") but silently
// missed the same code lowercased in a filename/URL slug
// ("site-us-027-protocol-deviation-notice.md"). Matches are normalised to
// uppercase before comparison in every consumer below, so this is a pure
// widening of what gets caught, not a behaviour change for the
// already-uppercase corpus. (D1's `source_url` fix does not lean on this
// regex at all -- see `redactChunksForRole`'s comment on `chunk.site_code`
// for why the exact, authoritative field is used there instead.)
const SITE_CODE_RE = /\b[A-Za-z]{2}-\d{3}\b/g;

const BOUNDED_EXTRACT_MAX_SENTENCES = 2;
const BOUNDED_EXTRACT_MAX_CHARS = 320;
const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

/**
 * Strip patient-level identifiers from safety report text, leaving aggregate
 * counts and SOC (System Organ Class) tables untouched. Patterns are
 * intentionally narrow (see PRD 3.2.3 "aggregate counts and SOC tables
 * survive") so we never accidentally redact an event count or a SOC label.
 */
export function stripPatientIdentifiers(text: string): { text: string; changed: boolean } {
  let changed = false;
  let result = text.replace(PARTICIPANT_ID_RE, () => {
    changed = true;
    return '[PARTICIPANT ID REDACTED]';
  });
  result = result.replace(DOB_RE, () => {
    changed = true;
    return '[DATE OF BIRTH REDACTED]';
  });
  result = result.replace(AGE_SEX_RE, () => {
    changed = true;
    return '[AGE/SEX REDACTED]';
  });
  result = result.replace(INITIALS_RE, () => {
    changed = true;
    return '[INITIALS REDACTED]';
  });
  return { text: result, changed };
}

/** Mask any site code not in the caller's assigned sites, anywhere it appears in the text. */
export function maskUnassignedSiteCodes(
  text: string,
  assignedSites: readonly string[],
): { text: string; changed: boolean } {
  const assignedUpper = new Set(assignedSites.map((s) => s.toUpperCase()));
  let changed = false;
  const result = text.replace(SITE_CODE_RE, (match) => {
    if (assignedUpper.has(match.toUpperCase())) return match;
    changed = true;
    return '[SITE REDACTED]';
  });
  return { text: result, changed };
}

/**
 * Find the first site code (e.g. "US-027") in free text, normalised to
 * uppercase, or `null` if none is present. Used by `functions/documents.ts`
 * (D2) to derive a `site_communication` document's site from its title --
 * `DocumentStatus` has no persisted `site_code` field of its own (by
 * `ingestion/trialpulse_ingest/document_status.py`'s explicit design: "do
 * not add ingestion-internal fields here"), and every `site_communication`
 * document in the corpus is titled `"Site <CODE> ..."`, so the title is a
 * reliable, already-available signal.
 */
export function findSiteCode(text: string): string | null {
  const match = text.match(SITE_CODE_RE);
  return match ? match[0]!.toUpperCase() : null;
}

const WORD_RE = /[a-z0-9]+/g;
const EXTRACT_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'what', 'when',
  'how', 'does', 'do', 'did', 'this', 'that', 'with', 'by', 'from', 'as', 'it', 'its', 'be', 'been', 'has', 'have',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_RE) ?? [];
}

/** Count of query terms (stopwords excluded) also present in `sentence`, for ranking sentences by relevance. */
function relevanceScore(queryTerms: ReadonlySet<string>, sentence: string): number {
  if (queryTerms.size === 0) return 0;
  let hits = 0;
  for (const term of tokenize(sentence)) {
    if (queryTerms.has(term)) hits += 1;
  }
  return hits;
}

/**
 * Structurally bound a chunk's content to a short, sentence-level excerpt
 * (D3): the deterministic backstop for `RedactionPolicy.boundedExtractOnly`.
 * A prompt instruction ("summarise, do not quote verbatim") is not a
 * redaction -- the model can ignore it, ADR 0002 and PRD 3.1 both promise
 * "full document text redacted", and this function makes that literally
 * true before the text ever reaches `buildSystemPrompt`.
 *
 * Keeps the sentences most relevant to `query` (ranked by term overlap,
 * like `providers/memory/memory-generation.ts`'s own extractive scoring),
 * not simply the first N: an earlier version took the first two sentences
 * unconditionally, which reliably dropped the one fact actually asked about
 * whenever it appeared later in a longer chunk (caught by
 * `eval/goldens.json`'s G21 case: "revises Grade 3 or higher acneiform
 * dermatitis incidence to 13 percent" is the chunk's third sentence). With
 * no query (or no term overlap at all), falls back to the first N
 * sentences in original order, which is also the deterministic tie-break
 * when several sentences score equally.
 */
export function truncateToBoundedExtract(text: string, query = ''): { text: string; changed: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text, changed: false };

  const sentences = trimmed.split(SENTENCE_SPLIT_RE).filter((s) => s.length > 0);
  if (sentences.length <= BOUNDED_EXTRACT_MAX_SENTENCES) {
    const joined = sentences.join(' ').trim();
    if (joined.length <= BOUNDED_EXTRACT_MAX_CHARS) return { text, changed: false };
    return { text: joined.slice(0, BOUNDED_EXTRACT_MAX_CHARS).trim(), changed: true };
  }

  const queryTerms = new Set(tokenize(query).filter((t) => t.length > 1 && !EXTRACT_STOPWORDS.has(t)));
  const ranked = sentences
    .map((sentence, index) => ({ sentence, index, score: relevanceScore(queryTerms, sentence) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);

  // Greedily accept sentences in rank order, respecting the character
  // budget, rather than always taking exactly the top
  // `BOUNDED_EXTRACT_MAX_SENTENCES` sentences and hard-cutting whatever
  // doesn't fit: with the latter, a long, moderately-relevant sentence that
  // happens to *precede* the single most relevant (but short) sentence in
  // the original text could consume the entire character budget and chop
  // the actually-relevant sentence off mid-word. Skipping a candidate that
  // doesn't fit and trying the next-ranked one instead keeps the
  // highest-value complete sentences rather than a truncated fragment of a
  // lower-priority one.
  const keptIndexes = new Set<number>();
  let budgetUsed = 0;
  for (const candidate of ranked) {
    if (keptIndexes.size >= BOUNDED_EXTRACT_MAX_SENTENCES) break;
    const addedLength = candidate.sentence.length + (keptIndexes.size > 0 ? 1 : 0); // +1 for the joining space
    if (keptIndexes.size > 0 && budgetUsed + addedLength > BOUNDED_EXTRACT_MAX_CHARS) continue;
    keptIndexes.add(candidate.index);
    budgetUsed += addedLength;
  }

  // Every candidate was individually too long even alone (budgetUsed still
  // 0): guarantee non-empty output by hard-cutting the single
  // highest-ranked sentence instead of returning nothing.
  if (keptIndexes.size === 0 && ranked.length > 0) {
    const top = ranked[0]!;
    return { text: top.sentence.slice(0, BOUNDED_EXTRACT_MAX_CHARS).trim(), changed: true };
  }

  const excerpt = sentences
    .filter((_, index) => keptIndexes.has(index))
    .join(' ')
    .trim();
  return { text: excerpt, changed: true };
}

export interface ChunkRedactionResult {
  chunks: ScoredChunk[];
  /** Distinct labels for `AuditRecord.redactions_applied`. */
  redactionsApplied: string[];
}

/**
 * Apply chunk-content redaction rules for a role. Never drops a chunk --
 * dropping unauthorized chunks entirely is the job of `isChunkAuthorized`
 * (defence in depth in `query-pipeline.ts`); this function only ever
 * transforms the text of chunks the role is already allowed to see.
 */
export function redactChunksForRole(
  role: Role,
  identity: CallerIdentity,
  chunks: readonly ScoredChunk[],
  /** The caller's query, for `boundedExtractOnly`'s relevance-ranked sentence selection. Optional (defaults to no ranking signal) so most call sites/tests are unaffected. */
  query = '',
): ChunkRedactionResult {
  const policy = getRolePolicy(role).redaction;
  const applied = new Set<string>();

  if (!policy.safetyAggregateOnly && !policy.maskUnassignedSites && !policy.boundedExtractOnly) {
    return { chunks: [...chunks], redactionsApplied: [] };
  }

  const redacted = chunks.map((chunk) => {
    let content = chunk.content;
    let title = chunk.document_title;
    let headingPath = chunk.heading_path;
    let sourceUrl = chunk.source_url;

    if (policy.safetyAggregateOnly && chunk.document_classification === 'safety_report') {
      const stripped = stripPatientIdentifiers(content);
      content = stripped.text;
      if (stripped.changed) applied.add('safety_aggregate_only');
    }

    if (policy.maskUnassignedSites) {
      const maskedContent = maskUnassignedSiteCodes(content, identity.assigned_sites);
      content = maskedContent.text;
      const maskedTitle = maskUnassignedSiteCodes(title, identity.assigned_sites);
      title = maskedTitle.text;
      const maskedHeading = maskUnassignedSiteCodes(headingPath, identity.assigned_sites);
      headingPath = maskedHeading.text;

      // D1: the chunk's own `site_code` field is the authoritative signal
      // for "is this chunk about a site the caller is not assigned to" --
      // unlike the regex-based text masking above, it cannot be defeated by
      // a lowercase site code or a code that only appears in the file name.
      // `source_url` was passing through completely unmasked, so the site
      // code (and, in production, the real SharePoint `webUrl`, which every
      // `site_communication` document shares regardless of site) leaked
      // straight past the in-app mask via the citation link. `''` is an
      // in-pipeline sentinel meaning "suppressed"; `chunkToCitation` in
      // `citations.ts` renders it as a `null` (non-clickable) source.
      const chunkSiteUnassigned =
        chunk.site_code !== null && !identity.assigned_sites.includes(chunk.site_code);
      if (chunkSiteUnassigned) {
        sourceUrl = '';
      }

      if (maskedContent.changed || maskedTitle.changed || maskedHeading.changed || chunkSiteUnassigned) {
        applied.add('mask_unassigned_sites');
      }
    }

    if (policy.boundedExtractOnly) {
      const bounded = truncateToBoundedExtract(content, query);
      content = bounded.text;
      if (bounded.changed) applied.add('bounded_extract_only');
    }

    if (
      content === chunk.content &&
      title === chunk.document_title &&
      headingPath === chunk.heading_path &&
      sourceUrl === chunk.source_url
    ) {
      return chunk;
    }
    return { ...chunk, content, document_title: title, heading_path: headingPath, source_url: sourceUrl };
  });

  return { chunks: redacted, redactionsApplied: [...applied] };
}

/** Extra system-prompt instructions driven by the role's redaction policy. */
export function buildPromptDirectives(role: Role): string[] {
  const policy = getRolePolicy(role).redaction;
  const directives: string[] = [];
  if (policy.summaryOnly) {
    directives.push(
      `${SUMMARY_ONLY_MARKER} Answer in at most 3 short bullet points that summarise the key ` +
        'facts across the supplied context. Do not quote or reproduce verbatim sentences from ' +
        'the context; paraphrase. Do not include a detailed section-by-section breakdown.',
    );
  }
  return directives;
}

/**
 * Prefix a generated answer with the IT admin support-access watermark.
 * Applied to the final answer text, after generation -- see module doc.
 */
export function applyAdminWatermark(role: Role, answerText: string): { text: string; applied: boolean } {
  const policy = getRolePolicy(role).redaction;
  if (!policy.adminWatermark) return { text: answerText, applied: false };
  return { text: `${ADMIN_WATERMARK_TEXT}\n\n${answerText}`, applied: true };
}

/**
 * Build the `redaction_notice` surfaced on `QueryResponse`, or `null` when
 * nothing about the answer needed explaining to the user.
 */
export function buildRedactionNotice(
  role: Role,
  options: { drillDownRequested: boolean; redactionsApplied: readonly string[] },
): string | null {
  const policy = getRolePolicy(role).redaction;

  if (policy.summaryOnly) {
    // PRD feature 3.2.5: an executive's drill-down request must still return
    // summary-only -- detailed, document-level answers are only visible to
    // less-restricted roles.
    return options.drillDownRequested
      ? 'Drill-down detail is only available to roles with document-level access. ' +
          'Showing the Executive summary view instead.'
      : 'This is a summary view for the Executive role. Detailed document text is not shown.';
  }

  if (policy.adminWatermark) {
    return 'This answer is watermarked for IT Administrator support access.';
  }

  if (options.redactionsApplied.includes('safety_aggregate_only')) {
    return 'Patient-level identifiers were removed from safety information per Medical Affairs policy.';
  }

  if (options.redactionsApplied.includes('mask_unassigned_sites')) {
    return 'One or more site identifiers were masked because they are outside your assigned sites.';
  }

  return null;
}
