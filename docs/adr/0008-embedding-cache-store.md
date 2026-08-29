# ADR 0008: Cosmos DB TTL container for the query embedding cache

## Status

Accepted — 2026-08-28. Supersedes the Azure Cache for Redis recommendation in PRD section 9.

## Context

PRD section 9 (Optimization Recommendations, "Cost control") recommends:

> Cache embeddings for identical queries (same normalized text + role) for 1 hour using Azure Cache for Redis.

The requirement being expressed is the caching behaviour — a keyed get/set with a
one-hour expiry, scoped by normalised query text and role — not Redis specifically.
Section 9 is a recommendations section, not a functional requirement.

Two things pushed against taking Redis literally:

1. **Cosmos DB is already a hard dependency.** TrialPulse must run Cosmos for the
   audit log (PRD 2.1, 4.1) and conversation history (PRD 6.1). Cosmos containers
   support a native per-item `ttl` field in seconds, which maps exactly onto
   `CacheProvider.set(key, value, ttlSeconds)`.
2. **A second data store is a second failure domain.** An unavailable cache tier
   must never take down a query path, and every additional stateful service adds
   provisioning, network, identity, patching and monitoring surface for what is,
   at the PRD's stated load of 500–5000 queries/day, a very small amount of traffic.

We initially provisioned Redis in Bicep alongside a Cosmos-backed
`CacheProvider` implementation. That left an Azure Cache for Redis instance
running, costing roughly $16/month, that no code path ever connected to — and an
architecture diagram that claimed a component the system did not use.

## Decision

The query embedding cache is a **Cosmos DB container (`cache_entries`) with TTL
enabled**, accessed through the `CacheProvider` interface
(`packages/orchestrator/src/providers/types.ts`).

Azure Cache for Redis is **not provisioned**. The `redis.bicep` module, its
parameters, the `REDIS_CONNECTION_STRING` app setting and the unused
`redisConnectionString` config field have been removed rather than left in place
as dead infrastructure.

Cache keys are produced by `embeddingCacheKey(query, role)`
(`packages/shared/src/hash.ts`), which is `emb:<role>:<sha256(normalizedQuery)>`.
The role is part of the key, not just the value, so a cache entry can never be
served across a role boundary — see ADR 0001.

## Consequences

**Positive**

- One stateful data store instead of two: fewer identities, fewer private
  endpoints, fewer alerts, less to patch.
- The infrastructure template now describes only resources the system actually
  uses. A reader of `infra/main.bicep` can trust it.
- ~$16/month of idle spend removed, against a PRD section 10 target that is
  already difficult to meet (see `docs/cost-model.md`).
- Cache TTL is enforced by the database rather than by application logic.

**Negative**

- Cosmos point reads are slower than Redis (single-digit ms versus sub-ms) and
  are billed in RU/s rather than being effectively free. At the PRD's stated
  load this is immaterial; at very high query volume the RU cost of cache
  traffic could begin to matter.
- Cosmos TTL deletion is best-effort background work, so an expired item can
  briefly remain readable. `MemoryCacheProvider` and the Cosmos provider both
  therefore check expiry on read rather than trusting the store to have
  removed the item. The embedding cache is not a correctness boundary — a
  stale hit only means an embedding is reused for the same normalised query and
  role — so this is acceptable.

**Reversibility**

Low cost. `CacheProvider` has three methods. A Redis-backed implementation can
be added under `packages/orchestrator/src/providers/azure/` and selected by the
provider factory without changing `query-pipeline.ts`. If that happens, restore
the deleted `redis.bicep` from git history rather than writing it again.

## Related

- ADR 0001 (retrieval-scoped RBAC) — why the cache key is role-scoped.
- `docs/cost-model.md` — the spend picture this decision feeds into.
