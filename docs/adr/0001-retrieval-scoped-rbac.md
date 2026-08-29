# 0001. Enforce RBAC in the retrieval query, not as a post-filter

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD decision 1, PRD sections 1.2 and 3.1

## Context

TrialPulse answers questions from a corpus that mixes unblinded safety data,
regulatory correspondence, competitive intelligence and site-level operational
documents. A site monitor must not see aggregate safety data. A clinical
operations manager must not see competitive intelligence. These are not UI
preferences; for a clinical-stage sponsor they are the difference between a
usable system and one that cannot be deployed.

There are two places to enforce that boundary in a retrieval-augmented system:

1. **Post-filter.** Run the search unfiltered, then drop chunks the caller is
   not allowed to see before building the prompt.
2. **Retrieval-scoped.** Push a filter into the search engine so the engine
   never returns a forbidden chunk in the first place.

Post-filtering is the tempting option because it is one line of application code
and needs no index design. It is also wrong, and the failure modes are subtle
enough that they survive code review.

The problem is that a search response carries information beyond the documents
it returns:

- **Result counts leak.** "Top 20 results, 3 of which you may see" tells the
  caller that 17 documents about their query exist. Ask "what is the unblinded
  Grade 4 hepatotoxicity rate", get zero visible results but a non-zero total,
  and you have learned that such a document exists. Repeat with varying terms
  and you can bisect towards its contents. The count is a side channel.
- **Ranking leaks.** Relevance scores are computed over the full candidate set.
  If the top-scoring permitted chunk comes back with a score of 0.61 for one
  phrasing and 0.83 for another, the caller learns which phrasing is closer to
  content they cannot see.
- **Truncation destroys recall silently.** `top: 20` followed by a post-filter
  can return two chunks to a `site_monitor` whose corpus contains two hundred
  relevant site communications, because eighteen slots were consumed by
  documents they were never eligible for. The user experiences this as "the
  system does not know about my site", and the fix people reach for is to raise
  `top`, which makes the leak wider rather than smaller.
- **Every future code path has to remember.** A post-filter lives in the query
  handler. The next endpoint - version comparison, the Browse tab's document
  list, a "related documents" affordance, an admin export - is a new code path
  that has to re-implement it. One that forgets is an access-control bug that no
  test is looking for.

## Decision

Every chunk carries a `document_classification` field, marked `filterable` in the
Azure AI Search index. The orchestrator derives an OData `$filter` from the
caller's role and sends it with every search request. The search engine returns
only permitted chunks; counts, scores and ranking are all computed over the
permitted subset only.

The filter is built by `buildSearchFilter(role)` in
`packages/shared/src/rbac.ts`. Three properties of that function matter:

1. **It is total over the role enum.** Every role in `ROLES` has an entry in
   `ROLE_POLICIES`. A new role cannot be added without deciding its allow-list;
   there is no default branch that falls through to "no filter".
2. **No caller-controlled string reaches the filter.** Every literal in the
   expression comes from the frozen `DOCUMENT_CLASSIFICATIONS` constant. The
   OData escaping helper exists as defence in depth, not because user input is
   expected to arrive.
3. **An empty allow-list matches nothing, not everything.** The defensive branch
   emits `document_classification eq null and document_classification ne null`,
   a contradiction. The failure mode of a misconfigured role is "you see
   nothing", never "you see everything".

We keep a second, independent check after retrieval: `isChunkAuthorized(role,
classification)` re-validates every returned chunk against the same policy. It
is not the enforcement mechanism - it is a tripwire. If it ever strips a chunk,
the search filter has a bug and the event is an incident, not a warning. The
user-facing behaviour is an ordinary refusal, deliberately indistinguishable
from "no relevant documents", so the response never signals that an
authorisation bug just occurred; the audit record carries the distinct
`no_authorized_documents` reason for compliance review.

## Consequences

**Good**

- The leak channels above close. A `site_monitor` cannot infer the existence of
  a safety report from counts, scores, or the shape of a refusal.
- Every retrieval path inherits enforcement, because the filter is built in one
  place and the search provider is the only way to reach the corpus.
- The exact filter string is written to the audit record. A compliance reviewer
  can replay any historical query with the filter that was actually applied,
  rather than trusting that application code behaved.

**Bad, or at least costly**

- The index schema now has a security-critical field. Any ingestion bug that
  writes the wrong `document_classification` is an access-control failure, not a
  metadata typo. This moves risk from the query path to the ingestion path,
  where it is harder to test, and is why classification is asserted at ingestion
  rather than inferred at query time.
- Filter syntax errors become availability incidents. A malformed OData filter
  is a 400 from Azure AI Search, which means a hard failure rather than a
  degraded answer. We accept this: failing closed is the correct posture.
- The in-memory search provider used by tests and the eval suite has to
  understand the filter language. `parseClassificationFilter` in
  `packages/orchestrator/src/providers/memory/memory-search.ts` accepts only the
  exact shapes `buildSearchFilter` emits and throws on anything else. A local
  provider that silently ignored an unrecognised filter would make the eval
  suite pass while production leaked, which would be worse than having no eval
  suite at all.
- Roles whose restriction is *redaction* rather than *classification* -
  `executive` and `it_admin` - get no filter and must be handled in the
  generation and post-processing layers. Retrieval-scoped RBAC is necessary, not
  sufficient. See ADR 0002.
