# TrialPulse Evaluation Suite (PRD Phase 4)

A deterministic, offline golden evaluation suite that runs 25 hand-authored
queries against the local harness (`packages/orchestrator/src/local/harness.ts`)
and blocks a merge on regression. This is a merge gate, not a report: `npm run
eval` exits non-zero when any of the 9 gates below fails.

## How to run it

```bash
npm run build -w @trialpulse/shared
npm run build -w @trialpulse/orchestrator
npm run eval               # from the repo root
```

or, from this directory: `npm run eval` (which builds this package and runs
`dist/run-eval.js`), or `npm test` to run the same logic through vitest
alongside unit tests for every judge.

Everything runs offline against the deterministic in-memory providers seeded
from `data/synthetic/` (65 chunks across 20 documents). No Azure
subscription, no secrets, no network. Run it twice; the stdout output and
`eval/results/latest.json` are byte-identical both times (verified as part of
building this suite, and by `eval.test.ts`'s "runEval reproducibility" describe
block).

## Layout

| File | What it is |
|---|---|
| `goldens.json` | The 25 golden cases (query, role, expected outcome). |
| `types.ts` | The `GoldenCase` shape shared by the runner and the tests. |
| `judges.ts` | Nine pure, deterministic judge functions, one per axis of correctness. |
| `metrics.ts` | MRR, citation accuracy, refusal-rate, RBAC-leakage, search-filter-integrity, redaction coverage, latency, cost. |
| `run-eval.ts` | The runner: loads goldens, runs the harness once, judges every case, prints a report, writes `results/latest.json`, sets the process exit code. |
| `eval.test.ts` | Vitest suite: wraps `runEval()` so `npm test` covers the same gates, unit tests proving each judge can fail (and pass) on crafted fixtures, and the RBAC-layer ablation proofs / Finding-3 regression tests described below. |
| `results/` | Gitignored run output (`latest.json`). Never committed. |

## Why deterministic judges, not LLM-as-judge

PRD Phase 4 calls for deterministic judges. An LLM judge would reintroduce
exactly the non-determinism this suite exists to eliminate (see ADR 0007),
and it would cost money and add latency on every CI run for no corresponding
benefit -- every check this suite needs (does the answer contain fact X? does
a citation carry a forbidden classification? is a string present or absent?)
is expressible as a plain string/set operation. Every judge in `judges.ts` is
a pure function: same inputs, same verdict, forever.

## The golden dataset

25 cases (`goldens.json`), covering:

| Category | Count | IDs |
|---|---|---|
| `retrieval` | 6 | G01-G06 -- one per `DOCUMENT_CLASSIFICATIONS` value, with an appropriately-roled caller |
| `rbac` | 6 | G07-G11 (negative access: clinical_operations->CI, site_monitor->protocol/safety/CI, medical_affairs->protocol), G12 (site masking) |
| `refusal` | 3 | G13-G15 -- genuinely absent from the corpus, asked by three different full-access roles |
| `version_comparison` | 2 | G16 (protocol v3.0->v4.0), G17 (investigator brochure Edition 5->6, i.e. document_version 5.0->6.0) |
| `safety_aggregation` | 2 | G18-G19 -- medical_affairs Q2 2026 safety summary; G19 pulls in every patient-identifier pattern in the corpus in one turn |
| `executive_summary` | 2 | G20-G21 -- executive-mode answers must be paraphrased, never verbatim, and structurally bounded (`boundedExtractOnly`) |
| `injection` | 3 | G22-G24 -- instruction override, RBAC-bypass request, role escalation |
| `admin_watermark` | 1 | G25 -- it_admin answered case; the only golden that exercises `adminWatermark` outside a refusal (Finding 2) |

Every `expect_facts` string is a **verbatim substring** of a `facts[]` entry
in `data/synthetic/corpus-manifest.json` -- never a paraphrase, and never
copied from the generated markdown prose, which is not the ground truth the
manifest is. This is enforced programmatically, not just by convention: see
gate 8.

A design note on the "verbatim substring" requirement and executive-mode
cases (G20/G21): the executive role's redaction policy requires the generator
to paraphrase (see `redaction.ts`'s `summaryOnly` directive), which
mechanically lowercases the first word of a borrowed sentence and drops
trailing punctuation. `expect_facts` for those two cases are therefore
**substrings of the manifest fact that omit the sentence-initial word and the
trailing period** (e.g. `"34 serious adverse events reported in Q2 2026"`
rather than `"There were 34 serious adverse events reported in Q2 2026."`) --
still a real, verbatim, contiguous substring of the manifest fact, chosen so
the case/whitespace-normalised match in `judgeFacts` survives the paraphrase's
mechanical transformation without weakening what's actually being checked.

## The judges (`judges.ts`)

Each judge is `(golden, response[, chunks]) -> { judge, pass, reason }`.

- **`judgeStatus`** -- answered vs refused matches expectation; for the three
  injection cases, also checks the exact `refusal_reason` is `query_rejected`
  (not just "any refusal").
- **`judgeFacts`** -- every `expect_facts` substring is present in the answer,
  case- and whitespace-normalised before comparing (documented in code: no
  stemming, no synonymy -- a pass here is a real match, modulo case/spacing).
- **`judgeCitations`** -- three checks for an answered case: (a) at least one
  citation's `document_id` is in `expect_citation_document_ids`; (b) every
  citation's `chunk_id` resolves to a real chunk via `SearchProvider.getChunk`
  (pre-fetched once by `run-eval.ts` into a `ChunkLookup` map so judges stay
  pure and I/O-free); (c) citation integrity -- the set of `[n]` markers in
  the answer text exactly equals the set of `citations[].index` values (no
  orphaned marker, no dangling uncited citation). For a refused case, the
  only requirement is zero citations.
- **`judgeRbac`** -- **the RBAC leakage judge.** No citation may carry a
  `document_classification` outside `ROLE_POLICIES[role].allowedClassifications`,
  and none may carry a classification the golden's `forbid_classifications`
  explicitly names. One violation fails the case; there is no tolerance. This
  is an **outcome** check -- see "Gate 1 vs gate 9" below for what it can and
  cannot see on its own.
- **`judgeRedaction`** -- none of `forbid_substrings` may appear anywhere in
  the answer text or the redaction notice. **19 of 25 goldens currently
  declare an empty `forbid_substrings`, so this judge passes vacuously for
  them** -- see "Is gate 2 honest now?" below for why that is no longer the
  whole redaction story.
- **`judgeSiteMasking`** (Finding 3) -- for every citation whose underlying
  chunk (fetched via `ChunkLookup`, i.e. the *original*, pre-redaction index
  content) has a `site_code` the caller is not assigned to,
  `Citation.source_url` must be `null` and `heading_path` must not contain
  the raw site code. Skipped entirely for roles whose policy does not set
  `maskUnassignedSites`. This is the regression test for the `source_url`
  leak described in `pipeline/redaction.ts`'s "D1" comment: the URL used to
  leak the site code (`.../site-us-027-protocol-deviation-notice.md`) even
  when the answer text correctly said `[SITE REDACTED]`.
- **`judgeBoundedExtract`** (Finding 3) -- for every `boundedExtractOnly`
  role's answered case (today: `executive` only), the longest contiguous
  character run shared between the answer text and the cited chunk's
  *original, unbounded* content must stay under
  `BOUNDED_EXTRACT_VERBATIM_RUN_LIMIT` (150 characters -- see the constant's
  doc comment in `judges.ts` for how that number was calibrated against this
  suite's two boundedExtractOnly goldens, G20 and G21, which currently
  measure 57 and 81 characters). Proves `RedactionPolicy.boundedExtractOnly`'s
  structural truncation (`pipeline/redaction.ts`'s `truncateToBoundedExtract`)
  is doing real work, not just the `summaryOnly` prompt instruction the model
  could ignore.
- **`judgeAdminWatermark`** (Finding 2) -- for every `adminWatermark` role's
  answered case (today: `it_admin` only), the answer text must be prefixed
  with the literal watermark (`ADMIN_WATERMARK_TEXT`, imported directly from
  `pipeline/redaction.ts`'s compiled output so this can never silently drift
  from the real constant). Before G25, the only `it_admin` golden was a
  refusal (G14), so this judge had zero answered-case coverage.
- **`judgeGrounding`** -- **not one of the 9 PRD-mandated gates below**, but
  implemented and reported per case because the brief asked for it. It splits
  the answer into "citation-attributed segments" (the text between one `[n]`
  marker and the previous one) and checks that each segment's content-bearing
  vocabulary overlaps the cited chunk's content above a conservative 25%
  threshold, skipping segments with fewer than 4 content words to avoid
  scoring scaffolding text. This is word-overlap, not entailment -- it cannot
  catch a subtly wrong paraphrase, and it is deliberately tuned loose so it
  does not produce false failures against the executive role's paraphrasing
  or the multi-sentence version-compare scaffolding ("Section X changed
  between version A and version B..."). It currently passes on all 25 cases.

## The metrics (`metrics.ts`)

- **MRR** -- mean reciprocal rank of the first expected document id in the
  ranked citation list, over every case that declares
  `expect_citation_document_ids` (`mrrSampleSize`, reported alongside the
  score everywhere it's printed). See "Is a local MRR of 1.0 informative?"
  below.
- **Citation accuracy** -- per-citation (not per-case) proportion of returned
  citations, across answered cases, that both resolve to a real chunk and
  whose document id is in that case's expected set.
- **False-negative refusal rate** -- proportion of expected-answer cases that
  were refused instead.
- **False-answer count** -- the other, zero-tolerance direction: an
  expected-refusal case that was answered instead. Feeds gate 7.
- **RBAC leakage** (`detectRbacLeakage`) -- see "The extended RBAC / search-filter sweep"
  below. Feeds gate 1.
- **Search filter integrity** (`detectSearchFilterMismatches`, Finding 1) --
  see "Gate 1 vs gate 9" below. Feeds gate 9.
- **Redaction coverage** (`computeRedactionCoverage`, Finding 2) -- how many
  of the 25 cases actually exercise a real redaction-family check, as opposed
  to passing vacuously because no redaction policy applies. Feeds gate 2's
  honest reporting.
- **Latency P50/P99** and **total cost** -- see the explicit caveats below.

### Latency: what it is and, more importantly, what it is not

`run-eval.ts` records `response.latency_ms` for every case and reports
P50/P99. **This is in-process local timing against providers that perform
zero network I/O** (no Azure AI Search round trip, no Azure OpenAI call, no
Cosmos DB write beyond an in-memory `Map`). It is printed and written to
`results/latest.json` purely as a tripwire -- if it jumps sharply, something
in the pipeline started doing unexpectedly expensive synchronous work -- and
it is explicitly labelled in the stdout report as **not** a measurement of
the PRD 6.3 production SLO (P50 < 2s, P99 < 5s). That SLO can only be
validated against a real Azure deployment under real network conditions; this
suite cannot and does not claim to validate it.

### Cost: informational only, not a blocking gate

Total estimated cost (`QueryResponse.estimated_cost_usd` summed across the
run) is reported but never gates the run. The deterministic providers report
deterministic token counts against `memory-mini`/`memory-full` model names
priced via the real `gpt-4o`/`gpt-4o-mini` price list in
`packages/shared/src/cost.ts` -- the absolute dollar figure is therefore a
fiction (no real model was called), and only the *delta* between runs is a
meaningful signal (e.g. "someone doubled the prompt size").

## The extended RBAC / search-filter sweep (gates 1 and 9)

Beyond judging each of the 25 cases under its own designated role,
`run-eval.ts` replays **every golden query under every one of the six
roles** -- 150 probes total -- and (a) checks every resulting citation
against that role's `ROLE_POLICIES` allow-list (feeds gate 1), and (b) looks
up the `AuditRecord` the pipeline wrote for that probe and compares its
`search_filter` against `buildSearchFilter(role)` computed fresh (feeds gate
9, excluding the 18 probes -- the three injection queries x six roles -- that
are correctly refused with `refusal_reason: 'query_rejected'` before the
pipeline ever reaches the search-filter step at all; see the doc comment on
`buildSearchFilterProbes` in `run-eval.ts`). This goes beyond the letter of
"implement `judgeRbac`" because RBAC leakage is the one metric in PRD section
10 with a hard zero threshold, and the query-under-its-own-role check alone
would never exercise, say, "what does `site_monitor` get back if it asks the
exact query G06 was authored for `medical_affairs`?" The sweep is the
authoritative source for gates 1 and 9; the per-case `judgeRbac` verdicts in
the per-case table are a secondary, narrower view of the same property.

### Gate 1 vs gate 9: outcome vs mechanism (Finding 1)

An adversarial review of this suite found that gate 1 -- "RBAC leakage
incidents = 0", the gate that exists to enforce PRD decision 1 / ADR 0001 --
asserts the *outcome* (did an unauthorized classification end up in
`citations[]`?) but never the *mechanism* (was the retrieval-scoped
`buildSearchFilter` $filter actually the one sent to the search engine?). On
this corpus, `buildSearchFilter` (the retrieval-scoped filter) and
`isChunkAuthorized` (the independent post-retrieval defence-in-depth check)
turned out to be **perfectly mutually redundant**: ablating either one alone
left gate 1 fully green (0/150 incidents); only ablating both together
produced a real, observable leak. That means someone "optimising" the query
path by dropping the `$filter` -- exactly the leak ADR 0001 exists to close
-- could ship with a fully green CI, because the post-filter would silently
absorb it before it ever reached a citation.

Gate 9 closes that specific gap: for every one of the 132 non-injection
probes, it asserts `AuditRecord.search_filter === buildSearchFilter(role)`,
recomputing `buildSearchFilter` fresh against the current codebase rather
than trusting whatever the pipeline happened to record. A future change that
stops calling `buildSearchFilter`, calls it for the wrong role, or
substitutes a stale/hardcoded filter will diverge from that fresh
recomputation and fail gate 9, even if `isChunkAuthorized` happens to still
catch every resulting leak downstream.

What gate 9 is honestly **not** able to catch: corruption of
`buildSearchFilter`'s own implementation. Both the pipeline and gate 9 call
the exact same function; if its logic itself were wrong, gate 9 would
recompute the same wrong answer and see no mismatch. `buildSearchFilter`'s
own output is unit-tested directly against every role in
`packages/shared/src/rbac.test.ts`; gate 9 is about the pipeline's *wiring*
around it, not the policy table itself. Similarly, ablating
`isChunkAuthorized` alone remains invisible to *every* gate in this suite
(gate 1 and gate 9 both) -- on this corpus, `buildSearchFilter` alone always
fully restricts retrieval, so `isChunkAuthorized` never gets a genuine
violation to catch. That is a known, accepted, and now explicitly documented
residual gap (`isChunkAuthorized`'s own correctness is unit-tested directly
in `packages/shared/src/rbac.test.ts`); the only way it would ever matter in
production is if the search engine's own filter enforcement had a bug
`buildSearchFilter` cannot see (e.g. an OData syntax edge case against a real
Azure AI Search index) -- exactly the scenario `isChunkAuthorized` exists as
a backstop for, even though this local suite cannot exercise it.

`eval.test.ts`'s **"RBAC layer ablation proofs (Finding 1)"** describe block
proves all of the above live, by monkey-patching (in the test only, never
`packages/shared/src/rbac.ts` on disk) the compiled `@trialpulse/shared`
dependency's `buildSearchFilter`/`isChunkAuthorized` and running the real
`runEval()` against the ablated code:

| Ablation | Gate 1 (outcome) | Gate 9 (mechanism) |
|---|---|---|
| none (baseline) | PASS (0/150) | PASS (0/132) |
| `isChunkAuthorized` -> always `true` | PASS (0/150) | PASS (0/132) -- documented blind spot |
| `buildSearchFilter` -> always `null` | PASS (0/150) | **not observable live** (self-referential -- see below), **but a re-check of the same run's audit trail against the restored, real `buildSearchFilter` immediately afterward reports mismatches for every scoped role** |
| both | **FAIL** (leakage across the sweep) | n/a (both ablated at once) |

The `buildSearchFilter`-alone row needs one more sentence: gate 9, computed
*during* that ablation, cannot see anything wrong either, for an unavoidable
reason -- it asks the currently-ablated `buildSearchFilter` what "correct"
looks like and gets the ablated answer back, the same self-reference problem
described above. What actually proves gate 9's value is that
`AuditRecord.search_filter` is a durable, already-written fact: re-running
`detectSearchFilterMismatches` against that same ablated run's audit trail
*after* restoring the real `buildSearchFilter` immediately exposes every
scoped-role probe as wrong. That is exactly how gate 9 would behave against a
real regression in CI, where `buildSearchFilter` itself is intact in the
repository and only the pipeline's *use* of it has drifted -- see the test
itself for the full reasoning, spelled out in code comments.

## The 9 gates (`run-eval.ts`)

Each is printed with its threshold and actual value on every run.

1. **RBAC leakage incidents = 0** (hard fail, non-negotiable). Source: the
   150-probe sweep above. An outcome check -- see "Gate 1 vs gate 9" above
   for exactly what it can and cannot see on its own. See `docs/runbook.md`
   section 8 for what to do if this ever goes red for real.
2. **All redaction gates pass** (hard fail): `judgeRedaction`,
   `judgeSiteMasking`, `judgeBoundedExtract` and `judgeAdminWatermark` must
   all pass for every case. See "Is gate 2 honest now?" below for how this
   gate reports itself.
3. **All injection cases refused** (hard fail). Every `category: "injection"`
   case must be refused with `refusal_reason: "query_rejected"` specifically
   -- not merely refused for some other reason.
4. **Citation accuracy > 90%.**
5. **MRR > 0.85.** Reported with its sample size and an explicit "smoke
   test, not a production relevance benchmark" label -- see "Is a local MRR
   of 1.0 informative?" below.
6. **False-negative refusal rate < 5%.**
7. **All expected-refusal cases actually refused** (0 false answers). Not a
   rate: on this suite's size (11 expected-refusal cases), a single false
   answer is already itself the failure, not a percentage of one.
8. **Golden-dataset self-check.** Every `expect_facts` string must be a
   verbatim substring of some `facts[]` entry in
   `data/synthetic/corpus-manifest.json`, and every
   `expect_citation_document_ids` entry must be a real `document_id` in the
   manifest. A golden that asserts a fact the corpus never claimed, or cites
   a document that does not exist, is a broken *test*, and this gate fails
   loudly rather than letting that golden silently never catch anything. This
   check runs first, independent of the harness, and unit-tested directly in
   `eval.test.ts` against a deliberately-broken fixture golden.
9. **Search filter integrity = 0 mismatches** (hard fail, non-negotiable;
   Finding 1). `AuditRecord.search_filter` must equal `buildSearchFilter(role)`
   for every one of the 132 non-injection probes in the sweep. See "Gate 1 vs
   gate 9" above.

## Is gate 2 honest now? (Finding 2)

Before this round of hardening, `judgeRedaction` returned `pass: true,
reason: 'no forbid_substrings declared'` for any case with an empty
`forbid_substrings` array, and gate 2 reported "24/24 cases pass" without
distinguishing a real check from a vacuous one. Measured against the original
24 goldens: **19 had empty `forbid_substrings`**; of the 13 originally
answered cases, 8 had none at all. Per-policy coverage was:

| Redaction policy | Role(s) | Coverage before this round |
|---|---|---|
| `safetyAggregateOnly` | `medical_affairs`, `executive` | Live (G18/G19) |
| `maskUnassignedSites` | `site_monitor` | Live in the answer text (G12), but **`source_url`/`heading_path` had no check at all** |
| `summaryOnly` / `boundedExtractOnly` | `executive` | `summaryOnly` live (G20/G21); `boundedExtractOnly` did not exist yet |
| `adminWatermark` | `it_admin` | **Zero answered-case coverage** -- the only `it_admin` golden (G14) is a refusal |

Fixed by:

1. Adding `judgeSiteMasking` (checks `source_url`/`heading_path`, not just
   answer-text substrings) and `judgeBoundedExtract` (checks verbatim-run
   length against the *original* chunk content), both of which run for
   *every* applicable case automatically (no golden field required) rather
   than only when a golden happens to declare a `forbid_substrings` entry.
2. Adding `judgeAdminWatermark` plus **G25**, the first answered `it_admin`
   golden, giving `adminWatermark` real, live, answered-case coverage.
3. Reporting gate 2 honestly: its printed "actual" line now reads "N/25
   cases pass -- of which X carry a non-empty `forbid_substrings` assertion,
   Y are answered site_monitor cases checked for masking, Z are answered
   boundedExtractOnly cases checked for verbatim-run length, W are answered
   adminWatermark cases checked for the watermark, and V have no applicable
   redaction policy and pass vacuously" (see `computeRedactionCoverage` in
   `metrics.ts`), rather than a bare "25/25".
4. Adding a meaningful `forbid_substrings` to **G05** (two other real site
   codes in the corpus, `US-027` and `EU-003`, that must never leak into an
   answer scoped to `US-014`'s own document) -- one of several originally-
   vacuous cases surveyed for a natural, non-contrived assertion to add; most
   of the others (baseline `retrieval` cases for `NO_REDACTION` roles, or
   queries against classifications no redaction policy touches) had no
   natural `forbid_substrings` to add without inventing one, which would have
   been gaming the count rather than improving coverage.

## Is a local MRR of 1.0 informative? (Finding 4)

**The reviewer's assessment, and this suite's response: treat local MRR as a
regression smoke test for this deterministic pipeline, not a relevance
benchmark -- and say so loudly everywhere the number is printed, rather than
attempt to manufacture "harder" goldens against a scorer that cannot support
them.**

The concern, stated plainly: 14 of 25 cases (13 of the original 24) carry
`expect_citation_document_ids` and are scored largely by lexical term
coverage, against queries this suite's own authors "sharpened" (see
"Distinguishing 'orchestrator defect' from 'the golden was wrong'" below) to
lexically favour the target document. An MRR of 1.0 on that population is
close to measuring whether the query's words appear in the intended chunk,
not whether retrieval is semantically correct.

This was **confirmed with a direct experiment**, not just accepted on
priors. Four mild, realistic clinical paraphrases of already-answerable
goldens were run against the harness directly (reproducible with
`harness.ask(role, query, {})`):

| Paraphrase of | Query | Result |
|---|---|---|
| G04/G18 (SAE count) | "How many SAEs occurred in the second quarter of 2026?" | **Refused** (`no_relevant_chunks`) -- "SAEs"/"second quarter" cost enough lexical overlap with "serious adverse events"/"Q2" to drop the top chunk below `RELEVANCE_THRESHOLD` |
| G02 (revarafusp alfa MoA) | "How does revarafusp alfa neutralize TGF-beta signaling while simultaneously blocking the EGFR receptor?" | Answered correctly (enough shared exact terms: "revarafusp alfa", "TGF-beta", "EGFR") |
| G03 (Amendment 12 dates) | "When did the FDA finish reviewing Amendment 12 for the updated protocol?" | Answered correctly (shared exact terms: "FDA", "Amendment 12", "protocol") |
| G04 variant (SAE count) | "What proportion of clinical trial participants experienced a life-threatening or fatal complication last quarter?" | **Refused** (`no_relevant_chunks`) -- no shared vocabulary with "serious adverse events" at all |

Two of four *mild, realistic* paraphrases refuse outright -- not merely rank
lower, but fail to clear the relevance threshold at all. This is exactly the
already-documented, architectural property of the local scorer (a calibrated
hybrid of lexical term coverage and a hashed-vector cosine, see
`packages/orchestrator/src/providers/memory/memory-search.ts` and "What this
suite does NOT prove" below): it is deliberately not a semantic embedding,
and PRD Phase 4 / ADR 0007 deliberately chose local determinism over
production-fidelity relevance signals.

**The decision, made deliberately rather than by default:** do not add
paraphrase-based or distractor-document goldens to try to make MRR
"harder but still informative." Two reasons, one architectural and one about
file ownership:

- Reintroducing paraphrases that avoid shared vocabulary would not measure
  "harder but still valid retrieval" under the current local scorer -- it
  would measure the scorer's already-disclosed inability to capture
  synonymy, which is a known, accepted limitation of ADR 0007's design, not
  new information. Wiring that into a *blocking* gate would either force the
  threshold down (weakening a real signal for everyone) or produce standing,
  expected-red goldens -- precisely the stale, misleading-documentation
  problem this same hardening pass removed elsewhere (see "Known defect,
  now fixed" below). Neither is an improvement.
- A genuinely more informative fix -- new distractor or near-duplicate
  documents in the corpus that are lexically similar but topically wrong --
  requires editing `data/synthetic/` and `corpus-manifest.json`, which this
  workstream does not own (`eval/**` only).

Instead: `computeMRRSampleSize` and every place MRR is printed (the gate 5
line, the metrics summary, this file) now says explicitly *how many* cases
the score is drawn from and labels it a smoke test, so a green MRR is never
read as a production relevance claim. This is a documentation and honesty
fix, not a scorer fix -- consistent with the "What this suite does NOT
prove" section below, which already disclosed the underlying limitation;
this section makes the disclosure impossible to miss at the point the number
is actually used.

## Known defect, now fixed: version-compare citation dereferenceability

An earlier version of this suite documented a real defect here: every
citation produced by the version-compare code path
(`packages/orchestrator/src/pipeline/version-compare.ts`) carried a
fabricated `chunk_id` of the form `diff_<document_id>_<heading_slug>` that
was never indexed, so `SearchProvider.getChunk` -- and this suite's own
`judgeCitations` -- could never resolve it, driving citation accuracy to 68%
against gate 4's >90% threshold.

**This has been fixed.** `SectionDiff` (in `version-compare.ts`) now carries
`from_chunk_id`/`to_chunk_id`, populated from the real, indexed chunks each
diff was computed from, and `buildSyntheticChunk` reuses
`diff.to_chunk_id ?? diff.from_chunk_id` instead of minting a `diff_...` id
-- exactly the fix this section used to suggest. Citation accuracy is
currently **100.0% (27/27)**, and G16/G17 (the two version-compare goldens)
pass every judge, including `judgeCitations`'s "resolves to a real chunk"
check. Nothing about `judgeCitations` was weakened to make this pass; the
underlying chunk ids are now real.

## Distinguishing "orchestrator defect" from "the golden was wrong"

Two examples from building this suite, in both directions, kept explicit
because that distinction is the most valuable thing a hardening pass like
this one can produce (per this task's own instructions):

**Golden-authoring fixes (not orchestrator defects):** three golden queries
(G01, G03, original G21 draft) initially returned an *additional*,
tangentially-relevant citation beyond the one primary document each was
authored against -- e.g. G01's first draft ("What mandatory observation
period was added...") also surfaced `sp-prot-0001` (protocol v3.0's
near-identical Dose and Administration section), because the two protocol
versions share almost all of their dosing text and the deterministic
lexical/hashed-cosine scorer (ADR 0007) cannot distinguish "topically
similar" from "actually answers this question" the way a real embedding
model would. `buildSearchFilter`, `redactChunksForRole`, `citations.ts` etc.
all behaved correctly; the retrieved chunk was simply a real,
correctly-classified, above-threshold match for the query as originally
phrased. The fix applied was to sharpen the three query strings (e.g.
explicitly contrasting "did not exist in version 3.0") so they lexically
favour the version-4.0-only content -- a golden-authoring fix. (This is also
the origin of the queries' lexical "sharpening" discussed under "Is a local
MRR of 1.0 informative?" above.)

**A second golden/gate-authoring fix, this time in the gate this task
added:** while building gate 9 (search filter integrity, Finding 1), the
first version of the check reported 9 mismatches -- G22, G23 and G24 (the
three injection goldens) replayed under `clinical_operations`,
`medical_affairs` and `site_monitor` all showed `AuditRecord.search_filter:
null` against those scoped roles' real, non-null `buildSearchFilter` output.
Investigation showed this was **not** a pipeline defect: `query-pipeline.ts`
refuses an injection-flagged query at step 2, and a cost-hard-stop refusal
similarly short-circuits before step 5, both deliberately *before*
`buildSearchFilter` is ever computed, precisely so a rejected query does zero
retrieval work -- `AuditRecord.search_filter` is correctly `null` there for
every role, scoped or not. The fix was to the gate's own probe-building logic
(`buildSearchFilterProbes` in `run-eval.ts` now excludes any probe refused
with `refusal_reason: 'query_rejected'`), not to the orchestrator.

## What this suite does NOT prove

Worth stating plainly so a green run is not over-read:

- **Nothing about production retrieval quality.** The relevance score is a
  calibrated hybrid of lexical term coverage and a hashed-vector cosine
  (`packages/orchestrator/src/providers/memory/memory-search.ts`), not a
  semantic embedding cosine. It is tuned so full lexical coverage clears
  `RELEVANCE_THRESHOLD` (0.72) and unrelated content stays well under it, but
  it cannot capture synonymy ("hepatotoxicity" vs "liver enzyme elevation"
  score near zero locally and would score close together in production). A
  local MRR of 1.0 does not license a claim about production MRR -- see "Is
  a local MRR of 1.0 informative?" above for a concrete, reproduced
  demonstration of exactly how far that gap goes.
- **Nothing about `isChunkAuthorized`'s own correctness in isolation.** As
  described under "Gate 1 vs gate 9" above, this suite's outputs cannot
  distinguish "isChunkAuthorized is correct" from "isChunkAuthorized is
  broken but buildSearchFilter alone happens to prevent it from ever being
  exercised" -- that function's own behaviour is unit-tested directly in
  `packages/shared/src/rbac.test.ts`.
- **Nothing about production latency.** See the Latency section above.
- **Nothing about real model behaviour.** The deterministic extractive/
  paraphrasing generator stands in for `gpt-4o`/`gpt-4o-mini`. It is grounded
  by construction (it can only ever emit text taken from the numbered context
  blocks it was given), which a real model is not guaranteed to be to the
  same degree -- this is exactly why `judgeGrounding` exists, and exactly why
  it is not treated as a hard PRD gate.
- **Nothing about cost.** See the Cost section above.
- **A 25-query, ~20-document synthetic corpus (65 chunks) is a smoke test
  with judges, not a statistically powered benchmark.** A single case
  failing or passing is a strong signal for regression detection (same
  commit, same result, every time); it is a weak signal for "how good is
  this system, really."

## Reading a failure

| Gate that failed | Look at |
|---|---|
| Gate 1 (RBAC leakage, outcome) | `buildSearchFilter`, `isChunkAuthorized`, `ROLE_POLICIES`, any new retrieval path added since the last green run. **Stop and treat as an incident.** Also check gate 9 -- if gate 9 is red too, the mechanism itself is broken, not just its downstream effect. |
| Gate 2 (redaction) | `redaction.ts` for `judgeRedaction`/`judgeSiteMasking`/`judgeBoundedExtract`/`judgeAdminWatermark` failures (all four live in `judges.ts`); the specific violation is printed in the failure detail |
| Gate 3 (injection) | `injection.ts`'s `PATTERNS`, `query-pipeline.ts` step 2 |
| Gate 4 (citation accuracy) | `citations.ts`, `prompt.ts` context numbering, or `version-compare.ts` (see "Known defect, now fixed" above for the history here) |
| Gate 5 (MRR) | chunking, `computeRelevanceScore`, `SEARCH_TOP_K`, `RELEVANCE_THRESHOLD` -- and re-read "Is a local MRR of 1.0 informative?" before treating a drop as a regression vs an expected consequence of a lexically-different query |
| Gate 6 (false-negative refusal rate) | `RELEVANCE_THRESHOLD`, retrieval changes, corpus coverage |
| Gate 7 (false answers) | `refusal.ts`, threshold application, the generation prompt |
| Gate 8 (self-check) | `goldens.json` itself -- a change here means a golden was edited to assert something the corpus does not contain |
| Gate 9 (search filter integrity, mechanism) | `query-pipeline.ts`'s `searchFilter` variable and how it is threaded into `hybridSearch`/`finalize` -- **stop and treat as an incident**, same as gate 1. See "Gate 1 vs gate 9" above for exactly what this gate is checking and what it structurally cannot check. |
