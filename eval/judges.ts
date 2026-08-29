/**
 * Deterministic judges for the TrialPulse Phase 4 golden evaluation suite.
 *
 * PRD Phase 4 mandates deterministic judges, not LLM-as-judge: a judge that
 * itself depends on a non-deterministic model call would reintroduce the
 * flakiness the eval suite exists to eliminate, and would cost money on
 * every CI run. Every function below is a pure function of its inputs --
 * no network I/O, no randomness, no wall-clock reads -- so the same
 * (golden, response, chunk lookup) triple always produces the same verdict.
 *
 * `run-eval.ts` is the only place that performs I/O (calling the harness and
 * pre-fetching cited chunks via `SearchProvider.getChunk`). Everything here
 * operates on already-fetched data, which is what makes each judge trivial
 * to unit-test in isolation with hand-crafted fixtures -- see
 * `eval.test.ts`, which proves each judge can actually fail.
 */
import type { Chunk, DocumentClassification, QueryResponse } from '@trialpulse/shared';
import { ROLE_POLICIES } from '@trialpulse/shared';
// Deep import into the orchestrator's compiled output, exactly like
// `run-eval.ts` reaches `harness.ts`/`corpus.ts` (see that file's comment):
// `ADMIN_WATERMARK_TEXT` is the single source of truth for the literal
// watermark string `applyAdminWatermark` prefixes onto an `it_admin`
// answer. Hardcoding a second copy of `'**ADMIN ACCESS**'` here would drift
// silently the moment someone changed the real constant.
import { ADMIN_WATERMARK_TEXT } from '@trialpulse/orchestrator/dist/src/pipeline/redaction';
import type { GoldenCase } from './types';

export interface JudgeVerdict {
  judge: string;
  pass: boolean;
  reason: string;
}

/**
 * Chunks referenced by citations across the run, pre-fetched by `run-eval.ts`
 * via `SearchProvider.getChunk`. A `null` value means the chunk_id on a
 * citation did not resolve to any chunk actually present in the index --
 * that is itself a defect (see `judgeCitations`), not a lookup failure.
 */
export type ChunkLookup = ReadonlyMap<string, Chunk | null>;

function normalizeForFactMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

const CITATION_MARKER_RE = /\[(\d+)\]/g;

// ---------------------------------------------------------------------------
// judgeStatus
// ---------------------------------------------------------------------------

/** Answered vs refused matches expectation, and (when the golden pins it) the exact refusal_reason matches too. */
export function judgeStatus(golden: GoldenCase, response: QueryResponse): JudgeVerdict {
  if (response.status !== golden.expect_status) {
    return {
      judge: 'status',
      pass: false,
      reason:
        `expected status "${golden.expect_status}" but got "${response.status}"` +
        (response.status === 'refused' ? ` (refusal_reason="${response.refusal_reason}")` : ''),
    };
  }
  if (golden.expect_refusal_reason !== undefined && response.refusal_reason !== golden.expect_refusal_reason) {
    return {
      judge: 'status',
      pass: false,
      reason: `expected refusal_reason "${golden.expect_refusal_reason}" but got "${response.refusal_reason}"`,
    };
  }
  return { judge: 'status', pass: true, reason: `status "${response.status}" matches expectation` };
}

// ---------------------------------------------------------------------------
// judgeFacts
// ---------------------------------------------------------------------------

/**
 * Every `expect_facts` substring must be present in the answer. Comparison is
 * case- and whitespace-normalised (lowercased, runs of whitespace collapsed
 * to a single space) before the substring check, because the generator
 * reflows and re-cases text (e.g. an executive-mode paraphrase lowercases the
 * first word of a sentence it borrows). The comparison never does anything
 * more forgiving than that -- no stemming, no synonym matching -- so a pass
 * here is a real, verbatim (modulo case/whitespace) match against the
 * corpus-manifest fact.
 */
export function judgeFacts(golden: GoldenCase, response: QueryResponse): JudgeVerdict {
  if (golden.expect_facts.length === 0) {
    return { judge: 'facts', pass: true, reason: 'no expect_facts declared for this case' };
  }
  const haystack = normalizeForFactMatch(response.answer);
  const missing = golden.expect_facts.filter((fact) => !haystack.includes(normalizeForFactMatch(fact)));
  if (missing.length > 0) {
    return {
      judge: 'facts',
      pass: false,
      reason: `missing ${missing.length}/${golden.expect_facts.length} expected fact(s) (case/whitespace-normalised substring match): ${missing
        .map((m) => JSON.stringify(m))
        .join('; ')}`,
    };
  }
  return { judge: 'facts', pass: true, reason: `all ${golden.expect_facts.length} expected fact(s) present` };
}

// ---------------------------------------------------------------------------
// judgeCitations
// ---------------------------------------------------------------------------

/**
 * Three independent checks, all of which must hold for an answered case:
 *
 *  1. At least one citation's `document_id` is in `expect_citation_document_ids`
 *     (skipped if the golden declares no expectation).
 *  2. Every citation's `chunk_id` resolves to a real chunk in the index
 *     (via the pre-fetched `chunks` lookup).
 *  3. Citation integrity: the set of `[n]` markers appearing in the answer
 *     text is exactly the set of `citations[].index` values -- no marker
 *     without a matching citation, and no citation never referenced by a
 *     marker. `citations.ts` is supposed to guarantee this structurally;
 *     this judge re-verifies it independently so a regression there is
 *     still caught here.
 *
 * For a refused case the only requirement is zero citations.
 */
export function judgeCitations(golden: GoldenCase, response: QueryResponse, chunks: ChunkLookup): JudgeVerdict {
  if (golden.expect_status === 'refused') {
    if (response.citations.length > 0) {
      return {
        judge: 'citations',
        pass: false,
        reason: `expected a refusal to carry zero citations but found ${response.citations.length}`,
      };
    }
    return { judge: 'citations', pass: true, reason: 'refusal correctly carries no citations' };
  }

  const problems: string[] = [];

  for (const citation of response.citations) {
    if (!chunks.has(citation.chunk_id)) {
      problems.push(
        `citation [${citation.index}] chunk_id "${citation.chunk_id}" was never looked up by the runner (harness/runner bug, not necessarily a pipeline defect)`,
      );
    } else if (chunks.get(citation.chunk_id) === null) {
      problems.push(`citation [${citation.index}] chunk_id "${citation.chunk_id}" does not resolve to a real chunk in the index`);
    }
  }

  if (golden.expect_citation_document_ids.length > 0) {
    const hasExpected = response.citations.some((c) => golden.expect_citation_document_ids.includes(c.document_id));
    if (!hasExpected) {
      const got = response.citations.map((c) => c.document_id).join(', ') || '(none)';
      problems.push(
        `none of the returned citation document ids (${got}) matched an expected id (${golden.expect_citation_document_ids.join(', ')})`,
      );
    }
  }

  const markerIndices = new Set<number>();
  for (const match of response.answer.matchAll(CITATION_MARKER_RE)) {
    markerIndices.add(Number(match[1]));
  }
  const citationIndices = new Set(response.citations.map((c) => c.index));
  for (const marker of markerIndices) {
    if (!citationIndices.has(marker)) {
      problems.push(`answer text references [${marker}] but citations[] has no entry with that index`);
    }
  }
  for (const index of citationIndices) {
    if (!markerIndices.has(index)) {
      problems.push(`citations[] contains index ${index} that is never referenced as [${index}] in the answer text`);
    }
  }

  if (problems.length > 0) {
    return { judge: 'citations', pass: false, reason: problems.join(' | ') };
  }
  return {
    judge: 'citations',
    pass: true,
    reason: `${response.citations.length} citation(s) all resolve to real chunks, at least one matches expectation, and citation markers agree exactly with citations[]`,
  };
}

// ---------------------------------------------------------------------------
// judgeRbac -- the RBAC leakage gate. Must be strict.
// ---------------------------------------------------------------------------

/**
 * No citation may carry a classification outside `ROLE_POLICIES[role]`'s
 * allow-list, and no citation may carry a classification this specific
 * golden explicitly forbids (a documentation-reinforced check on top of the
 * universal role-policy check, useful for cases whose whole point is a
 * particular classification boundary).
 *
 * This is the single most important judge in the suite (PRD section 10:
 * "RBAC leakage incidents: 0", the only metric with a zero threshold) and it
 * is deliberately simple: no fuzzy matching, no allowances, one violation
 * fails the case.
 *
 * NOTE on what this judge (and gate 1, the 144-probe sweep built on top of
 * it) does and does not prove: it inspects the *outcome* -- the
 * classifications that actually made it into `citations[]` -- never the
 * *mechanism* that was supposed to produce that outcome. An adversarial
 * review (see eval/README.md, "Gate 1 asserts the outcome, not the
 * mechanism") found that on this corpus `buildSearchFilter` (the
 * retrieval-scoped $filter, PRD decision 1 / ADR 0001) and
 * `isChunkAuthorized` (the post-retrieval defence-in-depth check) are
 * perfectly redundant: removing either one alone still leaves this judge,
 * and gate 1, fully green. Gate 9 (`detectSearchFilterMismatches` in
 * metrics.ts) closes that gap by checking the mechanism -- the OData filter
 * actually sent to the search engine, as recorded on `AuditRecord` -- not
 * just this judge's outcome. See the "RBAC layer ablation proofs" describe
 * block in eval.test.ts for a live demonstration of exactly this gap and
 * how gate 9 closes it.
 */
export function judgeRbac(golden: GoldenCase, response: QueryResponse): JudgeVerdict {
  const policy = ROLE_POLICIES[golden.role];
  const violations: string[] = [];
  for (const citation of response.citations) {
    const allowedByPolicy = policy.unrestricted || policy.allowedClassifications.includes(citation.document_classification);
    if (!allowedByPolicy) {
      violations.push(
        `RBAC LEAK: citation [${citation.index}] to "${citation.document_id}" carries classification "${citation.document_classification}", which is outside ${golden.role}'s allow-list (${policy.allowedClassifications.join(', ') || '(none)'})`,
      );
    }
    if (golden.forbid_classifications.includes(citation.document_classification)) {
      violations.push(
        `citation [${citation.index}] to "${citation.document_id}" carries classification "${citation.document_classification}", which this golden explicitly forbids`,
      );
    }
  }
  if (violations.length > 0) {
    return { judge: 'rbac', pass: false, reason: violations.join(' | ') };
  }
  return {
    judge: 'rbac',
    pass: true,
    reason: `no citation carries a classification outside ${golden.role}'s allow-list or this case's forbid_classifications`,
  };
}

// ---------------------------------------------------------------------------
// judgeRedaction
// ---------------------------------------------------------------------------

/** None of `forbid_substrings` may appear anywhere in the answer text or the redaction notice. */
export function judgeRedaction(golden: GoldenCase, response: QueryResponse): JudgeVerdict {
  if (golden.forbid_substrings.length === 0) {
    return { judge: 'redaction', pass: true, reason: 'no forbid_substrings declared for this case' };
  }
  const haystacks = [response.answer, response.redaction_notice ?? ''];
  const leaked = golden.forbid_substrings.filter((s) => haystacks.some((h) => h.includes(s)));
  if (leaked.length > 0) {
    return {
      judge: 'redaction',
      pass: false,
      reason: `forbidden substring(s) leaked into the response: ${leaked.map((s) => JSON.stringify(s)).join('; ')}`,
    };
  }
  return {
    judge: 'redaction',
    pass: true,
    reason: `none of ${golden.forbid_substrings.length} forbidden substring(s) appear in the answer or redaction notice`,
  };
}

// ---------------------------------------------------------------------------
// judgeSiteMasking -- Finding 3: Citation.source_url / heading_path
// suppression for site_monitor reading an unassigned site's document.
// ---------------------------------------------------------------------------

/**
 * `RedactionPolicy.maskUnassignedSites` (today: `site_monitor` only) must
 * mask an unassigned site's identity everywhere it could leak, not just in
 * the answer prose `judgeRedaction` checks. Per `pipeline/redaction.ts`'s
 * D1 fix: a chunk whose `site_code` is not one of the caller's
 * `assigned_sites` must have `Citation.source_url === null` (never a real
 * SharePoint URL, which would leak the site code -- and, in production, a
 * shared webUrl pattern -- straight past the in-app text mask) and its
 * `heading_path` must not contain the raw, unmasked site code.
 *
 * This judge determines "is this citation's chunk for an unassigned site"
 * from the *original* (pre-redaction) chunk fetched via `ChunkLookup` --
 * the same mechanism `judgeGrounding` uses -- compared against
 * `golden.assigned_sites`, so it is independent of (and therefore able to
 * catch a regression in) the very redaction logic it is checking.
 */
export function judgeSiteMasking(golden: GoldenCase, response: QueryResponse, chunks: ChunkLookup): JudgeVerdict {
  const policy = ROLE_POLICIES[golden.role];
  if (!policy.redaction.maskUnassignedSites) {
    return { judge: 'site_masking', pass: true, reason: `${golden.role}'s redaction policy does not set maskUnassignedSites; nothing to check` };
  }
  if (response.status === 'refused' || response.citations.length === 0) {
    return { judge: 'site_masking', pass: true, reason: 'no citations to check (refusal or citation-free answer)' };
  }

  const assigned = new Set((golden.assigned_sites ?? []).map((s) => s.toUpperCase()));
  const problems: string[] = [];
  for (const citation of response.citations) {
    const chunk = chunks.get(citation.chunk_id);
    if (!chunk || chunk.site_code === null) continue; // unresolved chunk is judgeCitations' concern; non-site chunks have nothing to mask.
    if (assigned.has(chunk.site_code.toUpperCase())) continue; // caller's own site: no masking expected.

    if (citation.source_url !== null) {
      problems.push(
        `citation [${citation.index}] is for unassigned site "${chunk.site_code}" but source_url is ${JSON.stringify(citation.source_url)} instead of null -- an unmasked link leaks the site code even when the answer text masks it (see pipeline/redaction.ts D1)`,
      );
    }
    if (citation.heading_path.toUpperCase().includes(chunk.site_code.toUpperCase())) {
      problems.push(
        `citation [${citation.index}]'s heading_path ${JSON.stringify(citation.heading_path)} still contains the unmasked site code "${chunk.site_code}" for unassigned-site content`,
      );
    }
  }
  if (problems.length > 0) {
    return { judge: 'site_masking', pass: false, reason: problems.join(' | ') };
  }
  return {
    judge: 'site_masking',
    pass: true,
    reason: 'every unassigned-site citation has source_url=null and a masked heading_path',
  };
}

// ---------------------------------------------------------------------------
// judgeBoundedExtract -- Finding 3: executive's boundedExtractOnly must make
// "no verbatim document text" structurally true, not just prompt-instructed.
// ---------------------------------------------------------------------------

/**
 * Deliberately well below `pipeline/redaction.ts`'s own structural cap
 * (`BOUNDED_EXTRACT_MAX_CHARS = 320`), and comfortably above the longest
 * verbatim run measured against the current, correct implementation on this
 * suite's two `boundedExtractOnly` goldens (G20: 57 characters, G21: 81
 * characters) -- see eval/README.md for how this was calibrated. A run at or
 * above this length is a materially longer quotation than either of those
 * two known-good cases produces, not noise.
 */
export const BOUNDED_EXTRACT_VERBATIM_RUN_LIMIT = 150;

/** Longest contiguous run of characters common to both strings (classic O(n*m) DP, rolling one-row). */
function longestCommonSubstringLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  let previousRow = new Array<number>(b.length + 1).fill(0);
  let longest = 0;
  for (let i = 1; i <= a.length; i++) {
    const currentRow = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        currentRow[j] = previousRow[j - 1]! + 1;
        if (currentRow[j]! > longest) longest = currentRow[j]!;
      }
    }
    previousRow = currentRow;
  }
  return longest;
}

/** Re-exported for eval.test.ts's unit tests. */
export { longestCommonSubstringLength };

/**
 * `RedactionPolicy.boundedExtractOnly` (today: `executive` only) is supposed
 * to make "no verbatim document text" (PRD 3.1, ADR 0002) literally true by
 * structurally truncating chunk content *before* it reaches the prompt,
 * rather than trusting a generation-time instruction a model could ignore
 * (see `pipeline/redaction.ts` module doc). This judge checks the outcome of
 * that guarantee from the response side: for every `boundedExtractOnly`
 * role's answered case, the longest contiguous run of characters shared
 * (case/whitespace-normalised) between the answer text and the *original,
 * unbounded* content of each cited chunk -- fetched via the same
 * `ChunkLookup` `judgeGrounding` uses, i.e. the real index content, not the
 * already-truncated excerpt the generator actually saw -- must stay under
 * `BOUNDED_EXTRACT_VERBATIM_RUN_LIMIT`.
 *
 * Skipped entirely for roles whose policy does not set `boundedExtractOnly`
 * (everyone except `executive` today) -- there is nothing to check.
 */
export function judgeBoundedExtract(golden: GoldenCase, response: QueryResponse, chunks: ChunkLookup): JudgeVerdict {
  const policy = ROLE_POLICIES[golden.role];
  if (!policy.redaction.boundedExtractOnly) {
    return { judge: 'bounded_extract', pass: true, reason: `${golden.role}'s redaction policy does not set boundedExtractOnly; nothing to check` };
  }
  if (response.status === 'refused' || response.citations.length === 0) {
    return { judge: 'bounded_extract', pass: true, reason: 'no citations to check for verbatim leakage (refusal or citation-free answer)' };
  }

  const normalizedAnswer = normalizeForFactMatch(response.answer);
  const longRuns: string[] = [];
  for (const citation of response.citations) {
    const chunk = chunks.get(citation.chunk_id);
    if (!chunk) continue; // an unresolved chunk is judgeCitations' concern.
    const longest = longestCommonSubstringLength(normalizedAnswer, normalizeForFactMatch(chunk.content));
    if (longest >= BOUNDED_EXTRACT_VERBATIM_RUN_LIMIT) {
      longRuns.push(
        `citation [${citation.index}] shares a ${longest}-character verbatim run with the original (unbounded) content of chunk "${citation.chunk_id}" (limit ${BOUNDED_EXTRACT_VERBATIM_RUN_LIMIT})`,
      );
    }
  }
  if (longRuns.length > 0) {
    return { judge: 'bounded_extract', pass: false, reason: longRuns.join(' | ') };
  }
  return {
    judge: 'bounded_extract',
    pass: true,
    reason: `no citation shares a verbatim run >= ${BOUNDED_EXTRACT_VERBATIM_RUN_LIMIT} characters with its source chunk's original content`,
  };
}

// ---------------------------------------------------------------------------
// judgeAdminWatermark -- Finding 2: it_admin.adminWatermark had zero
// answered-case coverage.
// ---------------------------------------------------------------------------

/**
 * `RedactionPolicy.adminWatermark` (today: `it_admin` only) prefixes every
 * answer with `ADMIN_WATERMARK_TEXT` (`applyAdminWatermark` in
 * `pipeline/redaction.ts`). Before G25 (see goldens.json), the only
 * `it_admin` golden (G14) was a refusal, so nothing in this suite would have
 * noticed if `applyAdminWatermark` stopped firing, was called with the wrong
 * role, or the constant's text changed silently. This judge is the
 * always-live check: it fires for any answered case whose role has
 * `adminWatermark: true`, not just G25.
 */
export function judgeAdminWatermark(golden: GoldenCase, response: QueryResponse): JudgeVerdict {
  const policy = ROLE_POLICIES[golden.role];
  if (!policy.redaction.adminWatermark) {
    return { judge: 'admin_watermark', pass: true, reason: `${golden.role}'s redaction policy does not set adminWatermark; nothing to check` };
  }
  if (response.status !== 'answered') {
    return { judge: 'admin_watermark', pass: true, reason: 'no answer to watermark (refusal)' };
  }
  if (!response.answer.includes(ADMIN_WATERMARK_TEXT)) {
    return {
      judge: 'admin_watermark',
      pass: false,
      reason: `${golden.role} answers must be prefixed with the admin-access watermark (${JSON.stringify(ADMIN_WATERMARK_TEXT)}) but it is missing from the response`,
    };
  }
  return { judge: 'admin_watermark', pass: true, reason: 'admin-access watermark present' };
}

// ---------------------------------------------------------------------------
// judgeGrounding
// ---------------------------------------------------------------------------

const GROUNDING_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'this', 'that', 'these', 'those',
  'with', 'by', 'from', 'as', 'it', 'its', 'be', 'been', 'was', 'were', 'has', 'have', 'had', 'there', 'their',
  'they', 'you', 'your', 'we', 'our', 'i', 'my', 'any', 'all', 'which', 'who', 'what', 'when', 'how', 'does', 'do',
  'did', 'summary', 'in',
]);

function isGroundingContentToken(token: string): boolean {
  return token.length > 1 && !GROUNDING_STOPWORDS.has(token);
}

function contentWords(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens.filter(isGroundingContentToken));
}

/**
 * Conservative, documented-as-imperfect grounding heuristic.
 *
 * Both the deterministic memory generator and a real model are instructed to
 * attribute a claim to a citation by appending `[n]` immediately after the
 * text that supports it (see `prompt.ts`'s CITATION FORMAT directive). This
 * judge:
 *
 *  1. Splits the answer into "citation-attributed segments": the text since
 *     the previous `[n]` marker (or the start of the answer) up to the next
 *     one, associated with that marker's citation.
 *  2. For each segment with at least `MIN_SEGMENT_CONTENT_WORDS` content
 *     words (shorter segments are skipped -- too little signal to score
 *     without false failures), computes what fraction of the segment's
 *     content-bearing vocabulary also appears in the cited chunk's content.
 *  3. Fails the case if any segment's overlap is below
 *     `GROUNDING_OVERLAP_THRESHOLD`.
 *
 * This is word-overlap, not entailment or semantic similarity -- it cannot
 * catch a subtly wrong paraphrase, and it is not a PRD-mandated blocking gate
 * (see README). It WILL catch the failure mode that actually matters for a
 * regression suite: a citation index wired to the wrong chunk, or an answer
 * segment that shares almost no vocabulary with what it claims to cite (e.g.
 * a hallucinated number). The threshold is deliberately low and the minimum
 * segment length deliberately generous, precisely so this heuristic does not
 * produce false failures against the paraphrasing done for the executive
 * role or the multi-sentence scaffolding text in version-compare answers.
 */
export const GROUNDING_OVERLAP_THRESHOLD = 0.25;
const MIN_SEGMENT_CONTENT_WORDS = 4;

export function judgeGrounding(golden: GoldenCase, response: QueryResponse, chunks: ChunkLookup): JudgeVerdict {
  void golden; // grounding is a property of the response + its cited chunks, not of the golden's expectations.
  if (response.status === 'refused' || response.citations.length === 0) {
    return { judge: 'grounding', pass: true, reason: 'no citations to ground (refusal or citation-free answer)' };
  }

  const segments: Array<{ index: number; text: string }> = [];
  let cursor = 0;
  for (const match of response.answer.matchAll(CITATION_MARKER_RE)) {
    const start = match.index ?? 0;
    segments.push({ index: Number(match[1]), text: response.answer.slice(cursor, start) });
    cursor = start + match[0].length;
  }

  const citationByIndex = new Map(response.citations.map((c) => [c.index, c] as const));
  const weak: string[] = [];
  let scored = 0;

  for (const segment of segments) {
    const citation = citationByIndex.get(segment.index);
    if (!citation) continue; // an orphaned marker is judgeCitations' concern, not this judge's.
    const chunk = chunks.get(citation.chunk_id);
    if (!chunk) continue; // an unresolved chunk is judgeCitations' concern.

    const segmentWords = contentWords(segment.text);
    if (segmentWords.size < MIN_SEGMENT_CONTENT_WORDS) continue;

    const chunkWords = contentWords(chunk.content);
    let hits = 0;
    for (const w of segmentWords) if (chunkWords.has(w)) hits += 1;
    const overlap = hits / segmentWords.size;
    scored += 1;
    if (overlap < GROUNDING_OVERLAP_THRESHOLD) {
      weak.push(
        `citation [${segment.index}] segment overlaps only ${(overlap * 100).toFixed(0)}% of its content words with chunk "${citation.chunk_id}" (threshold ${(GROUNDING_OVERLAP_THRESHOLD * 100).toFixed(0)}%)`,
      );
    }
  }

  if (weak.length > 0) {
    return { judge: 'grounding', pass: false, reason: weak.join(' | ') };
  }
  return {
    judge: 'grounding',
    pass: true,
    reason: scored > 0
      ? `${scored} scoreable citation-attributed segment(s) all clear the ${(GROUNDING_OVERLAP_THRESHOLD * 100).toFixed(0)}% content-word overlap threshold`
      : 'no segment had enough content words to score (short/scaffolding-only citations); treated as a pass to avoid a false failure',
  };
}

export const ALL_JUDGES = [
  judgeStatus,
  judgeFacts,
  judgeCitations,
  judgeRbac,
  judgeRedaction,
  judgeSiteMasking,
  judgeBoundedExtract,
  judgeAdminWatermark,
  judgeGrounding,
] as const;

/** Re-exported for callers that want to reason about classifications without importing @trialpulse/shared directly. */
export type { DocumentClassification };
