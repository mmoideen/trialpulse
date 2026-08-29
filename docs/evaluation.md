# Evaluation

How TrialPulse decides whether a change made it worse.

> **Status at the time of writing.** The golden evaluation harness is being built
> by a separate workstream and `eval/` is empty in the tree this document was
> written against. The gates, thresholds and rationale below come from PRD
> sections 6.3 and 7 (phase 4) and from the deterministic providers that already
> exist in `packages/orchestrator/src/providers/memory/`. **File paths under
> `eval/` are the expected layout, not observed fact.** The CI job is wired to
> `npm run eval` at the repo root and fails loudly if the script or the directory
> is absent - it does not skip.

## Why an eval suite at all

Unit tests answer "does this function do what it says". They cannot answer "did
that prompt change make retrieval worse", because the failure is statistical and
shows up across a population of queries, not in one assertion.

For TrialPulse the stakes are asymmetric. A latency regression is annoying. An
RBAC regression is the failure the product exists to prevent, and it is exactly
the kind of thing a refactor introduces silently - someone adds a "related
documents" endpoint and forgets `buildSearchFilter`, and no unit test notices
because the new endpoint has its own tests and they all pass.

So the eval suite is a merge gate, not a report. `continue-on-error: false` in
`.github/workflows/ci.yml`, deliberately and with a comment saying why.

## Design constraints

**Deterministic.** Same commit, same result, every run. A flaky gate is marked
advisory within a fortnight and then protects nothing. This is why the suite runs
against the in-memory providers rather than a live Azure deployment - see
ADR 0007 for the full argument and for the fidelity gap it costs.

**Offline.** No Azure subscription, no secrets, no network. A pull request from a
fork gets the same signal as a branch.

**Judges, not vibes.** Every check is a deterministic function of the response.
No LLM-as-judge - it would reintroduce the non-determinism the design exists to
avoid, and it would cost money on every CI run.

## The golden set

24 queries (PRD section 7, phase 4), fabricated against the synthetic corpus in
`data/synthetic/`, whose manifest asserts that every listed fact appears verbatim
in the generated document body precisely so that judges can assert on it.

The set has to cover more than "does retrieval work". A useful distribution:

| Category | Roughly | What it catches |
|---|---|---|
| Answerable, single document | 6 | Baseline retrieval and citation |
| Answerable, requires synthesis across documents | 4 | Multi-chunk assembly |
| Version comparison (v3.0 vs v4.0) | 2 | `previous_version_hash` wiring (PRD 3.2.2) |
| **Must refuse** - not in the corpus at all | 4 | Hallucination |
| **Must refuse** - exists but outside the caller's role | 4 | The RBAC boundary |
| Redaction-sensitive (safety, site, executive) | 4 | Per-role response shaping |

The two refusal categories are separate on purpose. "Not in the corpus" tests
the threshold; "outside your role" tests the filter. A system can pass the first
and fail the second catastrophically.

Each case carries: the query, the role to run it as, the expected outcome
(`answered` or `refused`), the document ids that *should* be retrieved, and for
answered cases a set of substrings the answer must contain.

## The gates

### Gate 1 - Retrieval relevance (MRR > 0.85)

*PRD section 6.3.*

Mean reciprocal rank of the first correct document across answerable cases. If
the expected document is ranked first, that case scores 1.0; second, 0.5; third,
0.33; absent, 0.

**Read this as a regression signal, not as a production prediction.** The local
relevance score is a calibrated hybrid of lexical coverage and a hashed-vector
cosine, not a semantic embedding cosine (ADR 0007). A local MRR of 0.85 does not
license a claim that production MRR will be 0.85. What it does license: if this
number drops on a pull request, retrieval logic changed.

### Gate 2 - Citation accuracy (> 90%)

*PRD section 10.*

For each answered case, the fraction of citations that (a) resolve to a chunk
that was actually retrieved, and (b) point at a document in the case's expected
set.

`packages/orchestrator/src/pipeline/citations.ts` already makes (a) structurally
true: it strips bracketed indices that do not map to a supplied chunk and drops
uncited chunks from the list. So this gate mostly measures (b) - whether the
model cited the *right* one of the chunks it was given.

What it cannot measure is whether the cited chunk semantically supports the
sentence it is attached to. That needs human review or an LLM judge, and neither
belongs in a merge gate. This is a stated limitation, not an oversight.

### Gate 3 - RBAC leakage (exactly 0)

*PRD section 10, "RBAC leakage incidents: 0".*

**The only gate with a threshold of zero.** For every case, run it as every one
of the six roles, then assert that no citation carries a
`document_classification` outside that role's allow-list from
`ROLE_POLICIES`.

24 cases x 6 roles = 144 assertions. This is the gate that catches a new
retrieval path that forgot the filter, a role whose allow-list was widened
without review, or an ingestion change that mislabelled a classification.

A single leak fails the build. There is no "leakage rate" - a rate implies an
acceptable non-zero value, and there isn't one.

### Gate 4 - Refusal correctness (false-negative rate < 5%)

*PRD section 6.3.*

Two directions, and they are not symmetric:

- **False refusal** (refused when it should have answered): capped at 5%. On 24
  cases that is at most one.
- **False answer** (answered when it should have refused): must be **zero**.
  Answering a question about a document the caller cannot see is an RBAC leak by
  another route; answering a question the corpus does not cover is the
  hallucination that ADR 0004 exists to prevent.

The measured false-refusal rate is **pessimistic** relative to production,
because the local scorer has no notion of synonymy - "hepatotoxicity" and "liver
enzyme elevation" score near zero locally and would score close in production.
So a local false-refusal rate near the cap is not necessarily a problem, and a
local rate of zero is not evidence that production will refuse correctly.

### Gate 5 - Redaction correctness (exactly 0 violations)

*PRD section 3.1.*

Deterministic checks against the role policy:

- `medical_affairs`: no patient identifier patterns (subject ids, initials, dates
  of birth) in any answer sourced from a safety report.
- `site_monitor`: no site code outside the caller's `sites` claim appears
  unmasked; masked codes render as `[SITE REDACTED]`.
- `executive`: no verbatim span above a threshold length shared with any
  retrieved chunk - the operational definition of "summary, not quotation".
- `it_admin`: every answer carries the `ADMIN ACCESS` watermark.

The executive check is the interesting one, because "summarise, do not quote" is
a prompt instruction and therefore not guaranteed (threat model T3). Measuring
verbatim overlap is how you find out whether the instruction is holding.

### Gate 6 - Cost accounting (informational, not blocking)

Total estimated cost across the run, from `estimateCost()` in
`packages/shared/src/cost.ts`. Deterministic providers report deterministic token
counts, so this number changes only when the prompt or the routing changes -
which makes it a useful tripwire for "someone doubled the context size". It is
reported, not gated, because the absolute value is a fiction (the memory
generation provider is not gpt-4o) and only the delta is meaningful.

## Running it

```bash
npm ci
npm run build     # shared must be built first
npm run seed      # loads data/synthetic into the in-memory index
npm run eval
```

In CI (`.github/workflows/ci.yml`, job `eval`) the same three commands run after
an assertion that the `eval` and `seed` scripts and the `eval/` directory exist.
Results are uploaded as an artefact from `eval/results/` when present. That path
is gitignored, so a local run does not dirty the tree.

## Expected layout

```
eval/
  golden/            the 24 cases: query, role, expectation, expected documents
  judges/            deterministic scorers, one per gate
  results/           gitignored run output
```

The runner entry point is `eval/run-eval.ts`, reached through `npm run eval`
at the root of the repository.

## Reading a failure

| Gate that failed | Look at |
|---|---|
| MRR dropped | chunking, embedding, `computeRelevanceScore`, `SEARCH_TOP_K` |
| Citation accuracy dropped | `prompt.ts` context formatting, `citations.ts` |
| **RBAC leakage non-zero** | `buildSearchFilter`, `ROLE_POLICIES`, any new retrieval path. **Stop and treat as an incident** - see `runbook.md` section 8 |
| False refusals up | `RELEVANCE_THRESHOLD`, retrieval changes, corpus coverage |
| False answers non-zero | `refusal.ts`, threshold application, the generation prompt |
| Redaction violations | `redaction.ts`, `prompt.ts` role boundary text |
| Cost up sharply | `maxChunks`, `model-router.ts`, prompt length |

## What this suite does not tell you

Worth stating plainly so nobody over-reads a green run.

- **Nothing about production retrieval quality.** Different scorer, different
  embedding space (ADR 0007).
- **Nothing about latency.** The in-memory providers return instantly. PRD
  section 6.3's P50/P99 targets can only be measured against a real deployment.
- **Nothing about real model behaviour.** gpt-4o may follow the redaction
  instructions better or worse than the deterministic extractive model does.
- **Nothing about cost.** See gate 6.
- **Nothing about the real corpus.** 24 queries over ~20 synthetic documents is a
  smoke test with judges, not a benchmark.

Every one of these appears on `production-readiness-checklist.md` as an
unmet item requiring a real deployment.
