# 0004. Refuse below the relevance threshold; never fall back to general knowledge

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD decision 3, sections 6.3 and 8.5

## Context

A retrieval-augmented system has to decide what to do when retrieval comes back
weak. The options are a spectrum:

1. Answer from the weak context anyway and hope the model hedges.
2. Answer from the model's parametric knowledge, with a disclaimer.
3. Refuse, and say what was searched.

For a general-purpose assistant, (1) or (2) maximises the fraction of questions
that get a useful reply. For a system answering questions about an active Phase 3
oncology protocol, both are unacceptable, and the reason is not model quality -
it is provenance.

Every answer TrialPulse gives is potentially an input to a regulated decision. A
clinical research associate asking "what is the dose modification rule for Grade
3 hepatotoxicity?" is going to act on the answer. If the model answers from
general oncology knowledge because retrieval missed, the answer may well be
*medically reasonable* and still be wrong for this protocol - and it will be
indistinguishable, in the UI and in the audit log, from an answer that came from
the protocol. A plausible ungrounded answer is more dangerous than an obviously
wrong one, because nobody checks it.

There is also a regulatory framing. The audit trail exists so a compliance
reviewer can reconstruct what the system told whom, and on what basis. An answer
with no chunks behind it has no basis to record. "The model knew this" is not an
entry a reviewer can act on.

## Decision

**A chunk must score above 0.72 to be used.** `RELEVANCE_THRESHOLD` in
`packages/shared/src/constants.ts`. Candidates are retrieved with `top: 20`
(`SEARCH_TOP_K`) and everything below the threshold is discarded before the
prompt is built.

**If nothing clears the bar, the system refuses in a fixed form.**
`buildNoChunksRefusal()` in `packages/orchestrator/src/pipeline/refusal.ts`
produces exactly one sentence shape:

> I cannot find information about *[topic]* in the documents you are authorized
> to access.

Every refusal path funnels through that one function. The wording is fixed on
purpose: a compliance reviewer scanning thousands of audit records should be able
to filter on one sentence shape, not discover on the third audit that a fourth
code path phrased it differently. The `[topic]` is the user's own query, trimmed
of trailing punctuation - deterministic, always defined, and exactly what they
asked.

**There is no general-knowledge fallback.** Not behind a flag, not with a
disclaimer, not for "obviously safe" questions. The system prompt instructs the
model to answer only from the supplied context, and the deterministic local
model used by tests and the eval suite emits the canonical refusal when it
receives a prompt with no context blocks - so the offline harness exercises the
same behaviour rather than a stub.

**"Authorized to access" is load-bearing.** The sentence deliberately does not
distinguish "this does not exist" from "this exists but not for you". A refusal
that said "you are not permitted to see documents about X" would be a
confirmation oracle: ask a series of questions, read the refusals, and map the
corpus you cannot see. This is the same leak that ADR 0001 closes at the
retrieval layer, and it has to be closed in the wording too. The audit record
carries the distinction (`no_relevant_chunks` versus
`no_authorized_documents`); the user-facing text does not.

**A refusal is a success, not an error.** It returns HTTP 200 with
`response_status: "refused"`, is not counted by the error-rate alert
(`docs/runbook.md`), and is logged with the full query, the role, the filter and
the empty result set.

## Consequences

**Good**

- Every answer has at least one citation, because an answer with no chunks is
  not an answer. Citation accuracy becomes measurable rather than aspirational.
- Refusals are a first-class, queryable signal. The daily summary tracks refusal
  counts; a spike is a legible symptom of an ingestion gap, a threshold that is
  too high, or a role whose allow-list is wrong.
- The compliance story is simple to state: TrialPulse never asserts anything it
  cannot point at.

**Bad, or at least costly**

- 0.72 is not derived from anything. It is the PRD's number, and the PRD does
  not say how it was chosen. It is the single most consequential tunable in the
  system - it sets the trade between hallucination risk and the false-refusal
  rate that PRD section 6.3 caps at 5% - and it currently has no empirical
  backing. The golden eval measures the false-refusal rate against it
  (`docs/evaluation.md`), which is a necessary check but a small sample. **This
  threshold must be re-derived against the real corpus before production use.**
- The threshold is applied to scores from two different scoring systems. In
  production it is an Azure AI Search hybrid score; locally it is the calibrated
  hybrid in `memory-search.ts`. The local score is *calibrated to behave like*
  the production threshold, not to equal it. See ADR 0007; this is a real
  fidelity gap.
- Users will hit refusals for questions the corpus can answer, because
  vocabulary mismatch is the normal failure of lexical-plus-vector retrieval
  ("hepatotox" versus "hepatic adverse events"). The mitigation is corpus
  coverage and query understanding, not lowering the bar.
- Refusing without distinguishing "absent" from "forbidden" means a user cannot
  tell whether to escalate for access or file a document-missing ticket. That is
  the cost of closing the oracle, and it is paid by legitimate users. The
  role badge in the Teams tab at least tells them what they are searching as.
