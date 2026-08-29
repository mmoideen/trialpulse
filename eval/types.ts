/**
 * Shared types for the eval suite.
 *
 * `GoldenCase` mirrors the schema documented in `eval/README.md` and used by
 * `eval/goldens.json`. Kept separate from `goldens.json` itself so both
 * `run-eval.ts` and `eval.test.ts` can import a single type without either
 * one owning the json file.
 */
import type { DocumentClassification, RefusalReason, ResponseStatus, Role } from '@trialpulse/shared';

export type GoldenCategory =
  | 'retrieval'
  | 'rbac'
  | 'refusal'
  | 'version_comparison'
  | 'safety_aggregation'
  | 'executive_summary'
  | 'injection'
  // Finding 2 (adversarial review): a dedicated category for the single
  // golden that exercises `ROLE_POLICIES.it_admin.redaction.adminWatermark`
  // with an *answered* case. Every other redaction policy already had an
  // answered case exercising it (see eval/README.md's per-policy coverage
  // table); this category exists so that fact is visible in the case table
  // and the per-category counts, not buried inside 'retrieval'.
  | 'admin_watermark';

export interface GoldenCase {
  id: string;
  category: GoldenCategory;
  role: Role;
  /** Only meaningful for site_monitor cases; harmless (ignored) for other roles. */
  assigned_sites?: string[];
  query: string;
  expect_status: ResponseStatus;
  /** Only asserted when present. Used by the injection cases to require the dedicated `query_rejected` reason rather than any refusal. */
  expect_refusal_reason?: RefusalReason;
  /** Verbatim substrings of `data/synthetic/corpus-manifest.json` fact strings. Empty for refused cases. */
  expect_facts: string[];
  /** At least one of these document ids must appear among the response's citations. Empty for refused cases. */
  expect_citation_document_ids: string[];
  /** Document classifications that must never appear in any citation for this case. */
  forbid_classifications: DocumentClassification[];
  /** Strings that must never appear anywhere in the answer text (or redaction notice). */
  forbid_substrings: string[];
  /** Why this case exists and what regression it catches. */
  rationale: string;
}

export interface GoldenFile {
  cases: GoldenCase[];
}
