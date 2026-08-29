# TrialPulse cost model

A worked estimate against the PRD's stated load, with the token arithmetic shown
so you can disagree with the assumptions rather than the total.

**Headline: the PRD's `< $300/month` target (section 10) is not achievable at the
configuration the PRD itself specifies.** At 500 queries/day with Azure AI Search
*standard* tier (section 8.2) the estimate is **~$417/month**. It comes in under
$300 only on the *basic* search tier - and at 1M chunks of 3072-dimension vectors
the basic tier is unlikely to have the vector quota, so that saving requires
reducing embedding dimensions, which the PRD's index schema does not allow.
At the 5,000 queries/day scale-up the estimate is **~$2,000/month**, and even
routing 100% of traffic to `gpt-4o-mini` lands near **$900/month**.

The rest of this document shows the work.

---

## Assumptions

Stated explicitly, because the total is a function of these and not much else.

### Prices

| Item | Rate | Source |
|---|---|---|
| `gpt-4o` input | $2.50 / 1M tokens | `packages/shared/src/cost.ts` |
| `gpt-4o` output | $10.00 / 1M tokens | `packages/shared/src/cost.ts` |
| `gpt-4o-mini` input | $0.15 / 1M tokens | `packages/shared/src/cost.ts` |
| `gpt-4o-mini` output | $0.60 / 1M tokens | `packages/shared/src/cost.ts` |
| `text-embedding-3-large` | $0.13 / 1M tokens | `packages/shared/src/cost.ts` |
| Azure AI Search basic | ~$0.10/hour/SU -> ~$74/month | Azure list price, East US |
| Azure AI Search standard (S1) | ~$0.336/hour/SU -> ~$245/month | Azure list price, East US |
| Semantic ranker (standard) | $1.00 / 1,000 queries, first 1,000/month free | PRD section 9 |
| Azure Cache for Redis Basic C0 | ~$16/month | Azure list price |
| Cosmos DB serverless | $0.25 / 1M RU, $0.25 / GB-month | Azure list price |
| Blob storage, hot | ~$0.018 / GB-month | Azure list price |
| Functions Flex Consumption, on demand | ~$0.000028 / GB-second | Azure list price |
| Functions Flex Consumption, always-ready | ~$0.0000056 / GB-second | Azure list price |
| Log Analytics ingestion | ~$2.30 / GB | Azure list price |

Model rates are taken from the code, so the estimate and the runtime cost
calculation cannot disagree. Infrastructure rates are list prices for East US at
the time of writing and are the softest numbers here - **verify against the Azure
pricing calculator before quoting any of this to Meridian.** No reserved capacity,
no enterprise discount, no provisioned throughput units.

### Load

| Assumption | Value | Basis |
|---|---|---|
| Queries per day | 500, scaling to 5,000 | PRD section 8.2 |
| Days per month | 30 | |
| Corpus size | 1M chunks | PRD section 8.2 |
| Tokens per chunk | 512 | `CHUNK_TARGET_TOKENS` |
| Corpus churn | 5% of chunks/month | judgement - see sensitivity |
| Chunks per prompt | 8 | `maxChunks` for most roles in `rbac.ts` |
| Cache hit rate on query embeddings | 30% | judgement; PRD section 9 specifies a 1h TTL |

### Per-query token budget

This is the number that drives everything.

| Component | Tokens | Where it comes from |
|---|---|---|
| System prompt: grounding, citation contract, injection boundary | ~450 | `prompt.ts` |
| Role boundary statement | ~60 | `ROLE_BOUNDARY_TEXT` in `prompt.ts` |
| 8 context blocks x (512 content + ~25 header) | ~4,296 | `formatChunkBlock` |
| Conversation history (2 prior turns, truncated) | ~250 | PRD section 6.1 |
| User question | ~20 | |
| **Total input** | **~5,076, round to 5,000** | |
| Generated answer | ~350 | |

**86% of the input is retrieved context.** Everything about generation cost is
really about how much context you send.

### Per-query cost

```
gpt-4o        = 5,000 x $2.50/1M  +  350 x $10.00/1M
              = $0.01250          +  $0.00350        = $0.01600

gpt-4o-mini   = 5,000 x $0.15/1M  +  350 x $0.60/1M
              = $0.00075          +  $0.00021        = $0.00096

query embed   = 20 x $0.13/1M                        = $0.0000026
```

A `gpt-4o` query costs **16.7x** a `gpt-4o-mini` query. Query embedding is
0.016% of a `gpt-4o` query and is not worth optimising; the Redis cache in PRD
section 9 exists for latency, not for cost.

### Routing mix

`routeModel()` in `packages/orchestrator/src/pipeline/model-router.ts` sends a
query to `gpt-4o` when the caller is an executive, when the query contains a
high-reasoning keyword, or when the query is 100 tokens or longer.
`HIGH_REASONING_KEYWORDS` includes `safety`, `regulatory`, `adverse`, `sae`,
`ind`, `nda`, `fda`, `submission`, `deviation` and `protocol amendment`.

In a clinical operations and regulatory affairs corpus, those words are not
edge cases - they are the vocabulary. **A 50/50 split is the base case here, and
it may well be optimistic.** This is the single largest source of uncertainty in
the model and it is a design decision, not a fact about the world.

---

## Scenario A: 500 queries/day, 1M chunks

15,000 queries/month.

| Component | Calculation | Monthly |
|---|---|---|
| Generation, `gpt-4o` (50%) | 7,500 x $0.01600 | **$120.00** |
| Generation, `gpt-4o-mini` (50%) | 7,500 x $0.00096 | $7.20 |
| Query embedding | 15,000 x 20 tok x 0.7 (cache) x $0.13/1M | $0.03 |
| Ingestion embedding, steady state | 512M tok x 5% x $0.13/1M | $3.33 |
| Semantic ranker | (15,000 - 1,000) / 1,000 x $1.00 | $14.00 |
| Azure AI Search, **basic**, 1 SU | | **$73.73** |
| Cosmos DB serverless | ~300K RU + 0.2 GB + backup + cache container | $1.00 |
| Storage (queues, archive, host) | | $1.00 |
| Functions Flex, on demand | ~110K GB-s | $4.00 |
| Application Insights / Log Analytics | ~1.5 GB | $4.00 |
| Azure Monitor log alert rules (3) | | $1.50 |
| **Total, basic search tier** | | **~$230** |
| **Total, standard (S1) search tier** | swap $73.73 -> $245.28 | **~$401** |
| **Total, prod parameters** | S1 x 2 replicas, 1 always-ready instance, GZRS | **~$677** |

Three totals, because the answer depends entirely on which one you mean.

- **$246** meets the PRD's target with about 18% headroom. It requires the basic
  search tier and no always-ready instance, and see the vector-quota caveat below.
- **$417** is what the PRD actually specifies: section 8.2 says "Azure AI Search
  standard tier". This is **39% over budget** before anyone does anything wrong.
- **$693** is `main.parameters.prod.json` as written: S1 with 2 replicas (the
  minimum for Azure AI Search's query SLA) and one always-ready Functions
  instance (to keep cold starts out of the P99 latency target).

### The vector quota problem

At 3,072 dimensions (PRD section 4.2, `EMBEDDING_DIMENSIONS`):

```
1,000,000 chunks x 3,072 dims x 4 bytes = 12.29 GB of raw vectors
+ HNSW graph overhead (m: 16)           ~ 15 GB
+ text, metadata, tombstoned chunks     ~ 16-18 GB total
```

Azure AI Search meters *vector index size* separately from document storage, and
the per-partition vector quota on the basic tier is materially smaller than on
S1. **At 3,072 dimensions, 1M chunks is very unlikely to fit on basic.** Check
the current per-tier vector quota in the Azure documentation before relying on
the $246 figure - this is a hard limit, not a performance guideline.

Which means the $246 scenario is reachable only if you also do one of:

- **Reduce embedding dimensions to 1,024.** `text-embedding-3-large` supports
  dimension reduction natively, taking the vector index to ~4.1 GB. It costs some
  retrieval quality, and it contradicts the PRD's index schema, which hardcodes
  `"dimensions": 3072`.
- **Enable scalar or binary quantization,** roughly 4x or 32x smaller with a
  reranking pass to recover accuracy.

Both are reasonable engineering choices. Neither is in the PRD, and both change
retrieval behaviour, which means the 0.72 relevance threshold would need
re-deriving (ADR 0004).

### The PRD contradicts itself on cost

| Section | Requirement | Cost implication |
|---|---|---|
| 10 | Monthly Azure spend `< $300` | |
| 8.2 | Azure AI Search **standard** tier | +$171/month over basic |
| 8.3 | 99.9% uptime | Azure AI Search only offers a query SLA at **2+ replicas** -> another +$245/month |
| 6.3 | P99 < 2s / 5s | Cold starts blow this; an always-ready instance is +$29/month |

Sections 8.2, 8.3 and 6.3 together cost about **$690/month** before a single
token is generated or a single query is served. Section 10's target and the rest
of the PRD were written against different assumptions.

---

## Scenario B: 5,000 queries/day

150,000 queries/month. Corpus assumed to have grown to ~1.5M chunks.

| Component | Calculation | Monthly |
|---|---|---|
| Generation, `gpt-4o` (50%) | 75,000 x $0.01600 | **$1,200.00** |
| Generation, `gpt-4o-mini` (50%) | 75,000 x $0.00096 | $72.00 |
| Query embedding | 150,000 x 20 tok x 0.7 x $0.13/1M | $0.27 |
| Ingestion embedding | 768M tok x 5% x $0.13/1M | $5.00 |
| Semantic ranker | 149,000 / 1,000 x $1.00 | **$149.00** |
| Azure AI Search S1, 2 replicas | | **$490.56** |
| Cosmos DB serverless | ~3M RU + 2 GB | $3.00 |
| Storage | | $5.00 |
| Functions Flex, on demand + 1 always-ready | ~600K GB-s + always-ready | $49.00 |
| Application Insights / Log Analytics | ~15 GB | $34.50 |
| Azure Monitor log alert rules | | $1.50 |
| **Total** | | **~$2,010** |

**Nearly 7x the PRD's target.** Generation alone is $1,272, or 63% of the bill.

The all-`gpt-4o-mini` floor, which sacrifices answer quality entirely:

```
150,000 x $0.00096 = $144  generation
                   + $754  everything else
                   = ~$898/month
```

Still **3x the target**. There is no routing configuration that gets 5,000
queries/day under $300/month with this architecture. The $300 figure and the
5,000/day figure cannot both be requirements.

---

## Sensitivity

Ordered by how much moving the dial actually changes the bill.

### 1. Context size (largest lever)

4,296 of ~5,000 input tokens are retrieved context. Reducing `maxChunks` from 8
to 4:

```
input = 450 + 60 + (4 x 537) + 250 + 20 = 2,928 tokens
gpt-4o = 2,928 x $2.50/1M + 350 x $10/1M = $0.00732 + $0.00350 = $0.01082
```

**-32% on every `gpt-4o` query**: -$38/month in scenario A, -$389/month in
scenario B. The cost is recall - fewer chunks means a higher false-refusal rate,
which PRD section 6.3 caps at 5%. This trade is measurable with the golden eval
and is the first thing to tune.

### 2. Routing mix

Every 10 percentage points shifted from `gpt-4o` to `gpt-4o-mini`:

- Scenario A: 1,500 queries x $0.01504 = **-$22.56/month**
- Scenario B: 15,000 queries x $0.01504 = **-$225.60/month**

The mix is set by `HIGH_REASONING_KEYWORDS`. If "safety" and "regulatory" appear
in 60% of real questions rather than 40%, scenario B rises by ~$226. **Measure
the real distribution before committing to a budget** - one week of production
traffic answers this question definitively, and until then the mix is a guess.

### 3. Search tier and replicas

$74 (basic, 1 SU) -> $245 (S1, 1 SU) -> $491 (S1, 2 SU). The largest *fixed*
cost and the only one that does not scale with usage. At scenario A's volume,
search is 30-70% of the bill depending on tier.

### 4. Semantic ranker

Free below 1,000 queries/month, then $1 per 1,000. Invisible in a pilot and
**$149/month at scenario B** - the third-largest line item. Worth measuring
whether semantic ranking actually improves MRR on this corpus before paying for
it at scale; the eval suite is the instrument for that.

### 5. Corpus churn

The 5%/month figure is a guess. Protocol amendments, IB updates and site
communications arrive in bursts, not smoothly. At 20%/month churn the ingestion
embedding line goes from $3.33 to $13.31 in scenario A - noticeable but not
decisive. **Idempotent ingestion (ADR 0003) is what keeps this small**; without
content hashing, the daily sync alone would re-embed 512M tokens every day, at
$67/day.

### 6. One-time backfill

Initial ingestion of 1M chunks: `512M tokens x $0.13/1M = ` **$66.56**, once.
Same cost applies every time the chunking algorithm or the embedding model
version changes and forces a full re-embed - which is a fifth of the monthly
budget, and why `runbook.md` says to announce a reindex before running it.

### 7. Embedding cache (resolved)

**Previous issue (now resolved):** The orchestrator's `CacheProvider` was
implemented over Cosmos DB but Redis was provisioned unused, at $16/month. That
accounted for ~6% of the budget.

**Resolution:** Redis has been removed entirely. The cache runs on the existing
Cosmos DB account with per-item TTL (`cache_entries` container). The decision
and rationale are documented in `docs/adr/0008-embedding-cache-store.md`.
Cosmos RU for cache traffic at this volume is a few cents per month.

### 8. Prompt caching (not currently available to us)

Azure OpenAI discounts cached input tokens when a prompt shares a stable prefix
of at least 1,024 tokens. Our static prefix is ~510 tokens (system prompt plus
role boundary) and the context that follows differs per query, so **nothing is
currently eligible**. Restructuring the prompt so the static portion exceeds
1,024 tokens would make that prefix cacheable, saving roughly $0.0006 per
`gpt-4o` query - about $5/month in scenario A. Real, small, and worth doing only
alongside a prompt revision that was happening anyway.

---

## Honest conclusion

At the PRD's realistic pilot scale - 500 queries/day, 25 daily active users,
8 queries/user/week - the system costs **roughly $250 to $700/month** depending
on whether you buy the availability the PRD asks for. Model tokens are $130 of
that; the rest is fixed infrastructure, dominated by Azure AI Search.

**The `< $300/month` target should be renegotiated to `< $500/month` for the
pilot**, with the understanding that it scales roughly linearly with query volume
above that. Presenting $300 as achievable at 5,000 queries/day would be
misleading, and it is the kind of number that gets quoted back during a budget
review nine months later.

If a hard $300 ceiling is genuinely non-negotiable, the levers, in order of how
much they cost you elsewhere:

1. Basic search tier with 1,024-dimension embeddings (~-$171/month; costs
   retrieval quality and contradicts the PRD index schema)
2. `maxChunks` 8 -> 5 (~-$25/month at scenario A; costs recall)
3. Narrow `HIGH_REASONING_KEYWORDS` to genuinely high-stakes terms
   (~-$20 to -$45/month; costs answer quality on borderline questions)
4. Disable the semantic ranker (-$14/month at scenario A, -$149 at scenario B;
   costs ranking quality - measure with the eval before deciding)
5. Accept 1 search replica and no SLA (~-$245/month; costs the availability
   commitment in PRD section 8.3)

Items 1 and 5 are the only two large enough to matter, and both trade away
something the PRD explicitly asks for. That is the shape of the problem.
