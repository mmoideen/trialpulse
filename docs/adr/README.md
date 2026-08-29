# Architecture Decision Records

Decisions that shaped TrialPulse, in [Michael Nygard's format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
**Context** (the forces in play), **Decision** (what we chose, in the active
voice), **Consequences** (what follows, good and bad), **Status**.

An ADR is immutable once accepted. If a decision changes, write a new ADR that
supersedes the old one and update the old one's Status line. Do not edit history.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-retrieval-scoped-rbac.md) | Enforce RBAC in the retrieval query, not as a post-filter | Accepted |
| [0002](0002-rbac-model.md) | Six Entra app roles, classification allow-lists, and least-privilege tie-breaking | Accepted |
| [0003](0003-idempotent-versioned-ingestion.md) | Content-hashed, idempotent, version-aware ingestion with tombstoning | Accepted |
| [0004](0004-refusal-over-hallucination.md) | Refuse below the relevance threshold; never fall back to general knowledge | Accepted |
| [0005](0005-separate-model-deployments.md) | Isolate embedding and generation capacity in separate Azure OpenAI accounts | Accepted |
| [0006](0006-tenant-boundary-and-data-residency.md) | Keep all data inside the tenant, in East US, with no third-party APIs | Accepted |
| [0007](0007-local-determinism.md) | Ship in-memory providers and a deterministic model so the repo runs offline | Accepted |
| [0008](0008-embedding-cache-store.md) | Cosmos DB TTL container for the query embedding cache, not Azure Cache for Redis | Accepted |
