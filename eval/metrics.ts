/**
 * Aggregate metrics for the golden evaluation run.
 *
 * Every function here is pure and operates on already-collected
 * `CaseResult[]` (golden + the response the harness produced for it) plus,
 * where needed, the same pre-fetched chunk lookup the judges use. No I/O,
 * no timing side effects beyond reading `response.latency_ms`, which is
 * itself produced once by the pipeline during `run-eval.ts`'s harness pass.
 */
import type { QueryResponse, Role } from '@trialpulse/shared';
import { buildSearchFilter, ROLE_POLICIES } from '@trialpulse/shared';
import type { ChunkLookup } from './judges';
import type { GoldenCase } from './types';

export interface CaseResult {
  golden: GoldenCase;
  response: QueryResponse;
}

// ---------------------------------------------------------------------------
// MRR -- PRD target > 0.85
// ---------------------------------------------------------------------------

/** Every case that declares `expect_citation_document_ids` -- the population `computeMRR` scores over. */
function mrrEligibleCases(results: readonly CaseResult[]): readonly CaseResult[] {
  return results.filter((r) => r.golden.expect_citation_document_ids.length > 0);
}

/**
 * Mean reciprocal rank of the first expected document id in the ranked
 * citation list, over every case that declares `expect_citation_document_ids`
 * (i.e. every "answered" case with a retrieval expectation). A case whose
 * citations never include an expected id scores 0 for that case, exactly as
 * an absent result should.
 *
 * See eval/README.md ("Is a local MRR of 1.0 informative?") for why this
 * number, on this corpus, is best read as a regression smoke test for the
 * deterministic local pipeline rather than a production relevance estimate:
 * the sample is small (`mrrSampleSize` below reports exactly how small) and
 * the local scorer is lexical/hashed-cosine, not a semantic embedding.
 */
export function computeMRR(results: readonly CaseResult[]): number {
  const relevant = mrrEligibleCases(results);
  if (relevant.length === 0) return 0;
  let sum = 0;
  for (const r of relevant) {
    const rank = r.response.citations.findIndex((c) => r.golden.expect_citation_document_ids.includes(c.document_id));
    sum += rank === -1 ? 0 : 1 / (rank + 1);
  }
  return sum / relevant.length;
}

/** How many of `results` actually contribute to `computeMRR` -- reported alongside the score so it is never read as if it covered the whole suite (Finding 4). */
export function computeMRRSampleSize(results: readonly CaseResult[]): number {
  return mrrEligibleCases(results).length;
}

// ---------------------------------------------------------------------------
// Citation accuracy -- PRD target > 90%
// ---------------------------------------------------------------------------

/**
 * Proportion of returned citations, across every "answered" case, that (a)
 * resolve to a real chunk in the index and (b) whose document id is in that
 * case's expected set (vacuously true for a case that declares no
 * expectation). Measured per-citation, not per-case: a case with 5 citations
 * where 1 is wrong contributes 4/5, not a single failed case.
 */
export function computeCitationAccuracy(results: readonly CaseResult[], chunks: ChunkLookup): { accuracy: number; totalCitations: number; correctCitations: number } {
  let total = 0;
  let correct = 0;
  for (const r of results) {
    if (r.golden.expect_status !== 'answered') continue;
    for (const c of r.response.citations) {
      total += 1;
      const resolvesToRealChunk = chunks.get(c.chunk_id) != null;
      const inExpectedSet = r.golden.expect_citation_document_ids.length === 0 || r.golden.expect_citation_document_ids.includes(c.document_id);
      if (resolvesToRealChunk && inExpectedSet) correct += 1;
    }
  }
  // No citations were ever returned across any answered case: report 1.0
  // (vacuously accurate) but sampleSize=0 is surfaced separately so this
  // can never silently mask a suite that answered nothing.
  const accuracy = total === 0 ? 1 : correct / total;
  return { accuracy, totalCitations: total, correctCitations: correct };
}

// ---------------------------------------------------------------------------
// False-negative refusal rate -- PRD target < 5%
// ---------------------------------------------------------------------------

/** Proportion of cases expecting an answer that were instead refused. */
export function computeFalseNegativeRefusalRate(results: readonly CaseResult[]): { rate: number; falseRefusals: number; expectedAnswered: number } {
  const shouldAnswer = results.filter((r) => r.golden.expect_status === 'answered');
  const falseRefusals = shouldAnswer.filter((r) => r.response.status === 'refused').length;
  return {
    rate: shouldAnswer.length === 0 ? 0 : falseRefusals / shouldAnswer.length,
    falseRefusals,
    expectedAnswered: shouldAnswer.length,
  };
}

/**
 * The other, non-symmetric direction: a case that should have refused but
 * was answered instead. Per docs/evaluation.md and PRD decision 3 this must
 * be zero -- answering a question the corpus does not cover, or a caller is
 * not authorized to see, is the hallucination / RBAC-leak failure mode, not
 * a rate-tolerant one. Reported alongside gate 7 in run-eval.ts.
 */
export function computeFalseAnswerCount(results: readonly CaseResult[]): { count: number; expectedRefused: number } {
  const shouldRefuse = results.filter((r) => r.golden.expect_status === 'refused');
  const falseAnswers = shouldRefuse.filter((r) => r.response.status === 'answered').length;
  return { count: falseAnswers, expectedRefused: shouldRefuse.length };
}

// ---------------------------------------------------------------------------
// Latency -- PRD targets P50 < 2s, P99 < 5s
// ---------------------------------------------------------------------------

function percentile(sortedAscending: readonly number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length) - 1;
  const idx = Math.min(sortedAscending.length - 1, Math.max(0, rank));
  return sortedAscending[idx]!;
}

/**
 * P50/P99 of `response.latency_ms` across the run.
 *
 * IMPORTANT: this is in-process local timing against providers that do zero
 * network I/O (no Azure AI Search round trip, no Azure OpenAI call). It is
 * NOT a measurement of the PRD 6.3 production latency SLO and must never be
 * reported as one -- see README.md. It is reported here only as a tripwire:
 * if this number jumps sharply, something in the pipeline is doing
 * unexpectedly expensive synchronous work.
 */
export function computeLatency(results: readonly CaseResult[]): { p50Ms: number; p99Ms: number } {
  const sorted = results.map((r) => r.response.latency_ms).slice().sort((a, b) => a - b);
  return { p50Ms: percentile(sorted, 50), p99Ms: percentile(sorted, 99) };
}

// ---------------------------------------------------------------------------
// Cost -- informational only, not a blocking gate (see README)
// ---------------------------------------------------------------------------

export function computeTotalCost(results: readonly CaseResult[]): number {
  const total = results.reduce((sum, r) => sum + r.response.estimated_cost_usd, 0);
  return Math.round(total * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// RBAC leakage -- PRD target 0, the only zero-tolerance metric
// ---------------------------------------------------------------------------

export interface RbacProbe {
  /** Human-readable label for the incident report, e.g. "G07 as clinical_operations (own role)" or "G07 as regulatory_affairs (cross-role sweep)". */
  label: string;
  role: Role;
  response: QueryResponse;
}

export interface RbacLeakageReport {
  incidents: string[];
  count: number;
  probesRun: number;
}

/**
 * Checks every citation in every probe against `ROLE_POLICIES[probe.role]`.
 * Used both for the 24 cases run under their own designated role and for the
 * extended sweep in `run-eval.ts` that replays every query under every role
 * (144 probes total) -- see README for why the sweep exists.
 *
 * This is an OUTCOME check (gate 1): it can only ever see a leak that
 * actually made it into `citations[]`. It cannot, by construction, tell the
 * difference between "the retrieval-scoped filter correctly restricted this
 * query" and "the filter was dropped entirely but the independent
 * post-retrieval check silently absorbed the leak" -- see
 * `detectSearchFilterMismatches` below (gate 9) for the mechanism-level
 * check added specifically to close that gap, and the "RBAC layer ablation
 * proofs" in eval.test.ts for a live demonstration.
 */
export function detectRbacLeakage(probes: readonly RbacProbe[]): RbacLeakageReport {
  const incidents: string[] = [];
  for (const probe of probes) {
    const policy = ROLE_POLICIES[probe.role];
    for (const citation of probe.response.citations) {
      const allowed = policy.unrestricted || policy.allowedClassifications.includes(citation.document_classification);
      if (!allowed) {
        incidents.push(
          `${probe.label}: citation to document "${citation.document_id}" (classification "${citation.document_classification}") is outside ${probe.role}'s allow-list`,
        );
      }
    }
  }
  return { incidents, count: incidents.length, probesRun: probes.length };
}

// ---------------------------------------------------------------------------
// Search filter integrity -- Finding 1 (adversarial review). Feeds gate 9.
// ---------------------------------------------------------------------------

export interface SearchFilterProbe {
  /** Human-readable label, mirroring RbacProbe.label. */
  label: string;
  role: Role;
  /**
   * `AuditRecord.search_filter` for this probe's trace_id -- the exact OData
   * string actually sent to the search engine (or `null` for an unrestricted
   * role). `undefined` means no audit record was ever found for this
   * probe's trace_id, itself a defect in the audit trail (compliance
   * critical -- see docs/runbook.md), reported as a mismatch below rather
   * than silently skipped.
   */
  auditedSearchFilter: string | null | undefined;
}

export interface SearchFilterIntegrityReport {
  mismatches: string[];
  count: number;
  probesRun: number;
}

/**
 * Finding 1 (adversarial review): "Gate 1 asserts the outcome, not the
 * mechanism". Recomputes `buildSearchFilter(probe.role)` -- the single
 * source of truth for what the retrieval-scoped RBAC filter mandated by PRD
 * decision 1 / ADR 0001 *should* be for this role -- and compares it against
 * what the pipeline actually recorded in the audit trail for that probe
 * (`AuditRecord.search_filter`, set from `query-pipeline.ts`'s local
 * `searchFilter` variable, the same value threaded into
 * `SearchProvider.hybridSearch`).
 *
 * A mismatch means the pipeline's *use* of `buildSearchFilter` diverged from
 * what calling it directly, right now, actually returns -- e.g. a future
 * refactor that stops calling it, calls it for the wrong role, or
 * substitutes a stale/hardcoded value ("someone optimising the query path by
 * dropping the $filter"). That is exactly the defect class gate 1 alone
 * cannot see on this corpus: a dropped filter that widens retrieval is still
 * fully absorbed by the independent `isChunkAuthorized` post-filter before
 * any leak reaches `citations[]` (see eval/README.md and the ablation tests
 * in eval.test.ts).
 *
 * What this check is necessarily blind to: corruption of `buildSearchFilter`
 * itself. Both this function and the pipeline call the exact same, single
 * implementation -- if that implementation's own logic were wrong, this
 * check would recompute the same wrong answer and see no mismatch.
 * `buildSearchFilter`'s own output is unit-tested directly in
 * `packages/shared/src/rbac.test.ts`; this check is about the pipeline's
 * *wiring* around it, not the policy table itself.
 */
export function detectSearchFilterMismatches(probes: readonly SearchFilterProbe[]): SearchFilterIntegrityReport {
  const mismatches: string[] = [];
  for (const probe of probes) {
    if (probe.auditedSearchFilter === undefined) {
      mismatches.push(`${probe.label}: no audit record found for this probe's trace_id -- cannot verify the search filter actually used`);
      continue;
    }
    const expected = buildSearchFilter(probe.role);
    if (probe.auditedSearchFilter !== expected) {
      mismatches.push(
        `${probe.label}: AuditRecord.search_filter was ${JSON.stringify(probe.auditedSearchFilter)} but buildSearchFilter(${probe.role}) currently returns ${JSON.stringify(expected)} -- the filter actually sent to the search engine does not match the one PRD decision 1 / ADR 0001 mandates for this role`,
      );
    }
  }
  return { mismatches, count: mismatches.length, probesRun: probes.length };
}

// ---------------------------------------------------------------------------
// Redaction coverage -- Finding 2 (adversarial review): report gate 2
// honestly instead of as an inflated "24/24".
// ---------------------------------------------------------------------------

export interface RedactionCoverageReport {
  totalCases: number;
  /** Cases with a non-empty `forbid_substrings` (judgeRedaction does real work). */
  forbidSubstringsCases: number;
  /** Answered cases whose role has `maskUnassignedSites` (judgeSiteMasking does real work). */
  siteMaskingCases: number;
  /** Answered cases whose role has `boundedExtractOnly` (judgeBoundedExtract does real work). */
  boundedExtractCases: number;
  /** Answered cases whose role has `adminWatermark` (judgeAdminWatermark does real work). */
  adminWatermarkCases: number;
  /** Cases where none of the above apply -- judgeRedaction (and every other redaction judge) passes vacuously. */
  vacuousCases: number;
}

/**
 * Finding 2: `judgeRedaction` alone returns `pass: true, reason: 'no
 * forbid_substrings declared'` for any case with an empty `forbid_substrings`
 * array -- 19 of the 24 original goldens, 8 of the 13 originally-answered
 * ones. Reporting gate 2 as "24/24 cases pass" is technically true and
 * substantively misleading: most of those passes check nothing. This
 * function counts, per case, whether *any* redaction-family judge
 * (`judgeRedaction`, `judgeSiteMasking`, `judgeBoundedExtract`,
 * `judgeAdminWatermark`) had something real to check, so gate 2's printed
 * "actual" can say "N cases carry a redaction assertion" instead of just the
 * total.
 */
export function computeRedactionCoverage(results: readonly CaseResult[]): RedactionCoverageReport {
  let forbidSubstringsCases = 0;
  let siteMaskingCases = 0;
  let boundedExtractCases = 0;
  let adminWatermarkCases = 0;
  let vacuousCases = 0;

  for (const { golden, response } of results) {
    const policy = ROLE_POLICIES[golden.role];
    const hasForbidSubstrings = golden.forbid_substrings.length > 0;
    const hasSiteMasking = policy.redaction.maskUnassignedSites && response.status === 'answered';
    const hasBoundedExtract = policy.redaction.boundedExtractOnly && response.status === 'answered';
    const hasAdminWatermark = policy.redaction.adminWatermark && response.status === 'answered';

    if (hasForbidSubstrings) forbidSubstringsCases += 1;
    if (hasSiteMasking) siteMaskingCases += 1;
    if (hasBoundedExtract) boundedExtractCases += 1;
    if (hasAdminWatermark) adminWatermarkCases += 1;
    if (!hasForbidSubstrings && !hasSiteMasking && !hasBoundedExtract && !hasAdminWatermark) vacuousCases += 1;
  }

  return {
    totalCases: results.length,
    forbidSubstringsCases,
    siteMaskingCases,
    boundedExtractCases,
    adminWatermarkCases,
    vacuousCases,
  };
}

export interface MetricsReport {
  mrr: number;
  mrrSampleSize: number;
  citationAccuracy: number;
  totalCitations: number;
  correctCitations: number;
  falseNegativeRefusalRate: number;
  falseRefusals: number;
  expectedAnsweredCount: number;
  falseAnswerCount: number;
  expectedRefusedCount: number;
  latencyP50Ms: number;
  latencyP99Ms: number;
  totalCostUsd: number;
  sampleSize: number;
}

export function computeMetrics(results: readonly CaseResult[], chunks: ChunkLookup): MetricsReport {
  const citationAccuracy = computeCitationAccuracy(results, chunks);
  const falseNegative = computeFalseNegativeRefusalRate(results);
  const falseAnswer = computeFalseAnswerCount(results);
  const latency = computeLatency(results);
  return {
    mrr: computeMRR(results),
    mrrSampleSize: computeMRRSampleSize(results),
    citationAccuracy: citationAccuracy.accuracy,
    totalCitations: citationAccuracy.totalCitations,
    correctCitations: citationAccuracy.correctCitations,
    falseNegativeRefusalRate: falseNegative.rate,
    falseRefusals: falseNegative.falseRefusals,
    expectedAnsweredCount: falseNegative.expectedAnswered,
    falseAnswerCount: falseAnswer.count,
    expectedRefusedCount: falseAnswer.expectedRefused,
    latencyP50Ms: latency.p50Ms,
    latencyP99Ms: latency.p99Ms,
    totalCostUsd: computeTotalCost(results),
    sampleSize: results.length,
  };
}
