# 0005. Isolate embedding and generation capacity in separate Azure OpenAI accounts

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD decision 4, sections 8.2 and 9; implemented in `infra/main.bicep` and `infra/modules/openai.bicep`

## Context

TrialPulse has two workloads with opposite shapes on the same Azure OpenAI
service.

**Ingestion** is bulk and bursty. A corpus backfill embeds on the order of 1M
chunks at roughly 512 tokens each - about 512M tokens - and wants to consume
every token per minute it can get. A large SharePoint upload, or a chunking
change that forces a re-embed, produces the same burst on a Tuesday afternoon.

**Query** is interactive and thin. A user's question is about 20 tokens to embed
and a few thousand to generate against, and the PRD's P99 target is 5 seconds
(section 6.3). Azure OpenAI enforces token-per-minute limits by returning HTTP
429 with a `Retry-After`; a client that hits the limit waits. If the two
workloads share a rate-limit bucket, a backfill turns every user query into a
retry loop, and the P99 target is not missed by 10% - it is missed by an order of
magnitude, for as long as the backfill runs.

The PRD calls for separate deployments. Implementing that surfaced a detail the
PRD does not address: **the orchestrator also embeds.** Every user query is
embedded before the hybrid search, with the same `text-embedding-3-large` model
the ingestion pipeline uses. Putting both on "the embedding deployment" would
satisfy the letter of decision 4 and completely miss its point, because the
starvation path runs straight through query embedding.

## Decision

Two Azure OpenAI accounts, provisioned from one reusable Bicep module:

| Account | Deployments | Consumer |
|---|---|---|
| `oai-tp-embed-<env>-<token>` | `text-embedding-3-large` (high capacity) | ingestion function app only |
| `oai-tp-chat-<env>-<token>` | `gpt-4o`, `gpt-4o-mini`, `text-embedding-3-large-query` (small capacity) | orchestrator function app only |

Capacity for each deployment is a parameter, so dev and prod differ by a
parameters file rather than by a template edit.

Two *accounts* rather than two deployments in one account, for a second reason
beyond rate limits: it makes the isolation enforceable with authorisation rather
than convention. The ingestion managed identity holds `Cognitive Services OpenAI
User` on the embedding account and **no role at all** on the conversational
account. A compromised ingestion pipeline cannot call a generation model - not
"should not", cannot. It has no token that will be accepted. Symmetrically, the
orchestrator cannot reach the ingestion account's high-throughput capacity, so a
bug in query handling cannot drain the embedding budget.

Both accounts run with `disableLocalAuth: true`. There is no Azure OpenAI API
key anywhere in the system.

The two apps read the endpoint under different variable names -
`AZURE_OPENAI_ENDPOINT` for the orchestrator, `AZURE_OPENAI_EMBEDDING_ENDPOINT`
for the ingestion pipeline - which is fortunate, because it makes a
copy-paste-the-wrong-endpoint mistake fail loudly instead of quietly working in
dev and starving in prod. `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` has the same name
on both apps but a different value, and that one *is* a trap; it is called out
in `infra/README.md`.

## Consequences

**Good**

- A corpus backfill cannot make user queries slow. That is the whole
  requirement, and it now holds for query embedding as well as generation.
- Least privilege becomes structural rather than documentary. The blast radius
  of a compromised ingestion pipeline stops at "can embed text and write chunks".
- Cost attribution is free. Two accounts means the Azure cost export separates
  ingestion spend from conversational spend with no tagging discipline required.
- Capacity can be tuned independently. Raising ingestion throughput for a
  backfill weekend is a parameter change that provably cannot affect the
  conversational deployments.

**Bad, or at least costly**

- **Quota is per subscription, per region, per model.** Splitting into two
  accounts splits one pool; it does not create a second one. If the subscription
  has 100K TPM of `text-embedding-3-large` in East US, that 100K is now divided
  between the two accounts and neither can borrow from the other. On a
  subscription with tight quota this design can make things *worse* than a single
  shared deployment. The mitigation is that the query-side allocation is
  deliberately tiny (20K TPM handles roughly 1,000 query embeddings per minute at
  20 tokens each), so the ingestion side keeps almost all of it. PRD risk 4
  (quota may need a Microsoft request, 1-2 weeks) applies directly, and
  `docs/runbook.md` has a quota-exhaustion procedure.
- Two accounts is more surface: two custom subdomains, two sets of diagnostic
  settings, two RBAC scopes, two things to check when someone asks "is Azure
  OpenAI up".
- Model version pinning has to be maintained in two places for
  `text-embedding-3-large`. If the ingestion account and the query account ever
  run different versions of the embedding model, the query vector and the chunk
  vectors are from different spaces and retrieval quality collapses in a way that
  looks like a relevance bug rather than a configuration bug. Both are driven
  from the single `embeddingModelVersion` parameter for exactly this reason, and
  a version bump requires a full corpus re-embed - see `docs/runbook.md`.
- `versionUpgradeOption` is set to `OnceCurrentVersionExpired` rather than
  `OnceNewDefaultVersionAvailable`, so Azure will not silently move the embedding
  model underneath a corpus that was embedded with the previous version.
