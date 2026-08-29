# 0007. Ship in-memory providers and a deterministic model so the repo runs offline

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD section 7 phases 1 and 4; implemented in `packages/orchestrator/src/providers/memory/`

## Context

Three things in this repository need to run before an Azure subscription exists,
and need to produce the same answer every time they run:

- **Unit tests.** A test suite that needs a search service and a model endpoint
  is a test suite that runs on one person's laptop.
- **CI.** The `.github/workflows/ci.yml` jobs must pass on a pull request from a
  fork, with no secrets, no tenant, and no network egress beyond the package
  registries.
- **The golden evaluation suite.** This is the sharp one. The eval measures
  retrieval relevance, citation accuracy, RBAC leakage and refusal correctness
  and gates merges on the results (`docs/evaluation.md`). A gate is only useful
  if a failure means "the code changed"; if the same commit can pass and fail on
  consecutive runs, the gate gets marked `continue-on-error` within a fortnight
  and stops protecting anything.

Real Azure OpenAI generation is not deterministic. Even at `temperature: 0`,
sampling and provider-side batching mean the same prompt yields different tokens
across calls, and gpt-4o's default version can change underneath a pinned
deployment. Real Azure AI Search relevance scores move when the semantic ranker
is updated. Neither is a defect - they are properties of managed, evolving
services - but both are fatal to a merge gate.

The alternative usually reached for is mocking: stub the search provider to
return a fixed list, stub the model to return a fixed string. That gets
determinism and gives up the thing worth testing. A model stub that returns
`"answer [1]"` regardless of context cannot fail a citation-accuracy check, so
the check measures nothing.

## Decision

Every external dependency sits behind an interface in
`packages/orchestrator/src/providers/types.ts`. Azure-backed implementations live
in `providers/azure/`; deterministic in-memory implementations live in
`providers/memory/`. The local dev server, the unit tests and the eval harness
wire up the memory set. The memory implementations are not stubs - they do the
real work, deterministically.

**Embeddings** (`memory-embeddings.ts`) use the hashing trick: each token is
hashed with FNV-1a into one of 3,072 buckets with a sign and weight derived from
the same hash, and the accumulated vector is L2-normalised. It is a pure function
of the input text - the same string always produces the same vector, byte for
byte - and because shared vocabulary contributes shared components, cosine
similarity between two hashed vectors correlates with lexical overlap.

**Search** (`memory-search.ts`) parses the OData `$filter` produced by
`buildSearchFilter(role)` and applies it as a real filter, then scores. It
accepts only the exact filter shapes that function emits and throws on anything
else - a local provider that silently ignored an unrecognised filter would let
the eval suite pass while production leaked (ADR 0001).

**Generation** (`memory-generation.ts`) parses the numbered
`--- CONTEXT [n] ---` blocks out of the rendered prompt - it receives only
`{system, user}`, exactly as a real model would - and for each block selects the
sentence with the highest lexical overlap with the question, citing it `[n]`. If
there are no context blocks it emits the canonical refusal from `refusal.ts`. It
honours the executive summary-only marker by producing at most three paraphrased
bullets. It never echoes the question back as the answer.

That last set of behaviours is why this is not a stub. The deterministic model
can produce an uncited claim, cite a chunk that does not support the sentence, or
quote verbatim text to an executive - so the citation-accuracy and redaction
gates can actually fail.

## The fidelity gap, stated plainly

**The local relevance score is not a cosine similarity.**
`computeRelevanceScore` in `memory-search.ts` returns:

```
0.8 * lexical_coverage + 0.2 * clamp(cosine(query_vector, chunk_vector), 0, 1)
```

where `lexical_coverage` is the fraction of the query's content-bearing terms
(stopwords removed, lightly stemmed) that appear in the chunk's content, title
or heading path.

The weights are chosen so that this hybrid *behaves* like the production
threshold rather than *equalling* a production score:

- full lexical coverage yields at least 0.80 regardless of the cosine term, so a
  chunk that contains every content word of the question reliably clears 0.72;
- partial overlap lands in a middle band, so borderline cases exist and the
  false-refusal rate is measurable;
- unrelated content stays well below 0.30.

`memory-search.test.ts` pins examples from the real synthetic corpus in all three
bands, so a change to the weights or the stemmer that moves a known-good chunk
across the threshold fails a test rather than quietly re-tuning the gate.

**What this does not tell you.** A hashed-vocabulary vector cannot represent
synonymy. "Hepatotoxicity" and "liver enzyme elevation" share no tokens and
therefore score near zero locally, while `text-embedding-3-large` would place
them close together. So:

- The local score is a **floor on lexical retrieval**, not an estimate of
  production semantic retrieval. A query that passes locally will very likely
  pass in production; a query that refuses locally may well be answered in
  production.
- **The measured false-refusal rate is pessimistic** relative to production, and
  measured MRR is only meaningful as a regression signal - a number to compare
  against the previous commit, not a prediction of the production MRR that PRD
  section 6.3 targets at 0.85.
- **The 0.72 threshold is validated against the wrong distribution.** It is the
  PRD's number, applied to a score that was calibrated to make it behave
  sensibly. That is circular, and it is honest to say so. Re-deriving the
  threshold against real embeddings and the real corpus is a production-readiness
  item, not something this repository has done or can do.

The gap is deliberate and it is bounded: everything the eval suite gates on
except the absolute retrieval scores - RBAC leakage, citation well-formedness,
refusal correctness, redaction behaviour, cost accounting - is measured on logic
that is identical between the memory and Azure paths, because it lives above the
provider interface.

## Consequences

**Good**

- `npm ci && npm run build && npm run seed && npm run eval` works on a laptop
  with no Azure account, and produces byte-identical results on every run.
- CI needs no secrets, so a fork's pull request gets the same signal as a branch.
- The provider interfaces force the Azure implementations to stay thin. Logic
  that lives above the interface - RBAC filtering, thresholding, redaction,
  citation assembly, cost accounting, audit shaping - is tested for real.
- Onboarding is `npm install` rather than a subscription request.

**Bad, or at least costly**

- The fidelity gap above. A retrieval regression caused by real embedding
  behaviour is invisible to this suite. The only fix is an evaluation run
  against a real deployment with the real corpus, which has not happened.
- Two implementations of every provider is real maintenance. The interface in
  `providers/types.ts` is a published contract and changing it is a breaking
  change for both sets plus the eval harness.
- There is a temptation to treat green local eval as evidence the system works.
  It is evidence that the *logic* works. It is not evidence about retrieval
  quality, latency, cost or model behaviour, and the production readiness
  checklist says so explicitly.
