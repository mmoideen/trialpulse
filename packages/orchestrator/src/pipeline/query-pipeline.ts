/**
 * The query pipeline: PRD section 2.2's numbered orchestration steps,
 * `POST /api/query`'s actual implementation, and the Teams bot's engine
 * (via the same `execute()` call -- PRD 5.2: "All messages are processed
 * through the same POST /api/query orchestrator").
 *
 * Every step is deliberately ordered so RBAC and injection defences run
 * before anything expensive (embedding, generation) happens, and so a
 * refusal is reachable -- and audited -- from as early as step 2.
 */
import { randomUUID } from 'node:crypto';
import {
  buildSearchFilter,
  estimateCost,
  isChunkAuthorized,
  queryHash,
  queryRequestSchema,
  RELEVANCE_THRESHOLD,
  scanForInjection,
  embeddingCacheKey,
  EMBEDDING_CACHE_TTL_SECONDS,
  CONVERSATION_TTL_SECONDS,
  SEARCH_TOP_K,
  getRolePolicy,
  type AuditRecord,
  type AuditRetrievedChunk,
  type CallerIdentity,
  type Citation,
  type ConversationTurn,
  type GenerationModel,
  type QueryRequest,
  type QueryResponse,
  type RefusalReason,
  type ResponseStatus,
  type Role,
  type ScoredChunk,
} from '@trialpulse/shared';
import type {
  AuditSink,
  CacheProvider,
  Clock,
  ConversationStore,
  EmbeddingProvider,
  GenerationProvider,
  Logger,
  SearchProvider,
  TelemetrySink,
} from '../providers/types';
import { CircuitBreaker } from './circuit-breaker';
import { validateAndRenumberCitations } from './citations';
import { COST_DOWNGRADE_CACHE_KEY, COST_HARD_STOP_CACHE_KEY, routeModel } from './model-router';
import { buildSystemPrompt } from './prompt';
import { applyAdminWatermark, buildPromptDirectives, buildRedactionNotice, redactChunksForRole } from './redaction';
import { buildCostHardStopRefusal, buildInjectionRefusal, buildNoAuthorizedDocumentsRefusal, buildNoChunksRefusal } from './refusal';
import {
  detectVersionCompareIntent,
  diffSections,
  findVersionPair,
  toSyntheticChunks,
} from './version-compare';

export interface PipelineConfig {
  models: {
    mini: string;
    full: string;
  };
  maxOutputTokens?: number;
  temperature?: number;
}

export interface PipelineDeps {
  search: SearchProvider;
  embeddings: EmbeddingProvider;
  generation: GenerationProvider;
  audit: AuditSink;
  conversations: ConversationStore;
  cache: CacheProvider;
  clock: Clock;
  logger: Logger;
  telemetry: TelemetrySink;
  config: PipelineConfig;
}

export interface QueryPipeline {
  execute(identity: CallerIdentity, request: QueryRequest): Promise<QueryResponse>;
}

/** Thrown when `request` fails `queryRequestSchema` validation (pipeline step 1). */
export class InvalidQueryError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid query request: ${issues.join('; ')}`);
    this.name = 'InvalidQueryError';
    this.issues = issues;
  }
}

/** No real model call happened for this turn (blocked / refused before generation). */
const NO_MODEL = 'none';

function toAuditRetrievedChunks(chunks: readonly ScoredChunk[]): AuditRetrievedChunk[] {
  return chunks.map((c) => ({
    chunk_id: c.chunk_id,
    document_id: c.document_id,
    document_title: c.document_title,
    document_classification: c.document_classification,
    similarity_score: c.similarity_score,
    content_hash: c.content_hash,
  }));
}

function partitionDate(clock: Clock): string {
  return clock.now().toISOString().slice(0, 10);
}

/** The one fixed price for the embedding model (PRD decision 4: a single, dedicated embedding deployment). */
const EMBEDDING_PRICING_MODEL = 'text-embedding-3-large';

interface FinalizeInput {
  identity: CallerIdentity;
  query: string;
  conversationId: string;
  searchFilter: string | null;
  injectionFlags: string[];
  retrievedChunks: ScoredChunk[];
  citations: Citation[];
  responseText: string;
  status: ResponseStatus;
  refusalReason: RefusalReason | null;
  redactionsApplied: string[];
  redactionNotice: string | null;
  /** Tokens billed to the embedding call for this turn (0 on a cache hit or when no embedding was needed). */
  embeddingTokens: number;
  /** Generation call token counts; both 0 when no generation call happened (e.g. a refusal). */
  generationTokensInput: number;
  generationTokensOutput: number;
  /**
   * Canonical model family used for *pricing* the generation call ('gpt-4o'
   * or 'gpt-4o-mini'), independent of the actual deployment name or the
   * provider's raw returned model string (`modelUsed` below) -- `estimateCost`
   * only recognises the canonical family names from `MODEL_PRICING`.
   */
  generationPricingModel: GenerationModel | null;
  /** The provider's raw model identifier, for audit/display transparency. */
  modelUsed: string;
  cacheHit: boolean;
  startedAtMs: number;
}

export function createQueryPipeline(deps: PipelineDeps): QueryPipeline {
  const breaker = new CircuitBreaker(deps.clock);

  async function finalize(input: FinalizeInput): Promise<QueryResponse> {
    const traceId = randomUUID();
    const now = deps.clock.now();

    const embeddingCostUsd = estimateCost(EMBEDDING_PRICING_MODEL, input.embeddingTokens, 0);
    const generationCostUsd = input.generationPricingModel
      ? estimateCost(input.generationPricingModel, input.generationTokensInput, input.generationTokensOutput)
      : 0;
    const estimatedCostUsd = embeddingCostUsd + generationCostUsd;
    const tokensInput = input.embeddingTokens + input.generationTokensInput;
    const tokensOutput = input.generationTokensOutput;

    // D11: `latency_ms` used to be computed *before* `audit.write()` and
    // `conversations.append()` -- both real Cosmos round-trips in
    // production -- so the number feeding the PRD 6.3 SLO (P50 < 2s, P99 <
    // 5s) systematically understated true end-to-end latency: the caller
    // does not get the response until both finish. `conversations.append()`
    // now runs *before* the latency measurement, so its duration is
    // captured in `latency_ms` (used for the audit record, the response,
    // and therefore the SLO). The one remaining gap -- the audit write's
    // own duration cannot be included in the very record it is about to
    // persist, the familiar "a log line cannot log its own emission time"
    // limit -- is covered by the separate `query_pipeline_execute_total`
    // span below, which runs after *both* writes complete and is the
    // fully-accurate number for anyone consuming raw telemetry rather than
    // the audit-derived daily summaries.
    const turn: ConversationTurn = {
      id: traceId,
      conversation_id: input.conversationId,
      user_principal_name: input.identity.user_principal_name,
      role: input.identity.role,
      question: input.query,
      answer: input.responseText,
      citations: input.citations,
      status: input.status,
      timestamp: now.toISOString(),
      feedback: null,
      ttl: CONVERSATION_TTL_SECONDS,
    };
    try {
      await deps.conversations.append(turn);
    } catch (err) {
      deps.logger.log('warn', 'conversation append failed', { trace_id: traceId, error: String(err) });
    }

    const latencyMs = deps.clock.now().getTime() - input.startedAtMs;

    const record: AuditRecord = {
      id: traceId,
      trace_id: traceId,
      timestamp: now.toISOString(),
      user_principal_name: input.identity.user_principal_name,
      entra_role: input.identity.role,
      role_fallback_applied: input.identity.role_fallback_applied,
      query_text: input.query,
      query_hash: queryHash(input.query),
      retrieved_chunks: toAuditRetrievedChunks(input.retrievedChunks),
      response_text: input.responseText,
      response_status: input.status,
      refusal_reason: input.refusalReason,
      search_filter: input.searchFilter,
      redactions_applied: input.redactionsApplied,
      injection_flags: input.injectionFlags,
      tokens_input: tokensInput,
      tokens_output: tokensOutput,
      model_used: input.modelUsed,
      estimated_cost_usd: estimatedCostUsd,
      latency_ms: latencyMs,
      cache_hit: input.cacheHit,
      partition_date: partitionDate(deps.clock),
    };

    try {
      await deps.audit.write(record);
    } catch (err) {
      // Audit is compliance-critical but must never take down a user's
      // query. Log loudly and surface a telemetry event; there is no
      // dedicated "counter" primitive on TelemetrySink (see providers/types.ts),
      // so a zero-duration span is the closest available signal.
      deps.logger.log('error', 'audit write failed', { trace_id: traceId, error: String(err) });
      deps.telemetry.recordSpan({
        name: 'audit_write_failure',
        durationMs: 0,
        attributes: { trace_id: traceId },
      });
    }

    // D12: `cost_usd` on this specific, well-known span name is what a real
    // `TelemetrySink` (see `providers/azure/azure-telemetry.ts`) keys off
    // to emit the `trialpulse.query.cost_usd` metric alongside the
    // `trialpulse.query` event `infra/modules/alerts.bicep`'s
    // denial-of-wallet alert watches.
    deps.telemetry.recordSpan({
      name: 'query',
      durationMs: latencyMs,
      attributes: {
        role: input.identity.role,
        status: input.status,
        cache_hit: input.cacheHit,
        cost_usd: estimatedCostUsd,
      },
    });
    deps.telemetry.recordSpan({
      name: 'query_pipeline_execute_total',
      durationMs: deps.clock.now().getTime() - input.startedAtMs,
      attributes: { role: input.identity.role, status: input.status, cache_hit: input.cacheHit },
    });

    return {
      trace_id: traceId,
      status: input.status,
      answer: input.responseText,
      citations: input.citations,
      refusal_reason: input.refusalReason,
      role: input.identity.role,
      redaction_notice: input.redactionNotice,
      model_used: input.modelUsed,
      latency_ms: latencyMs,
      cache_hit: input.cacheHit,
      estimated_cost_usd: estimatedCostUsd,
    };
  }

  async function refuse(
    identity: CallerIdentity,
    query: string,
    conversationId: string,
    startedAtMs: number,
    reason: RefusalReason,
    responseText: string,
    options: {
      searchFilter?: string | null;
      injectionFlags?: string[];
      retrievedChunks?: ScoredChunk[];
      cacheHit?: boolean;
      /** An embedding call may still have happened (and cost money) before a refusal. */
      embeddingTokens?: number;
    } = {},
  ): Promise<QueryResponse> {
    return finalize({
      identity,
      query,
      conversationId,
      searchFilter: options.searchFilter ?? null,
      injectionFlags: options.injectionFlags ?? [],
      retrievedChunks: options.retrievedChunks ?? [],
      citations: [],
      responseText,
      status: 'refused',
      refusalReason: reason,
      redactionsApplied: [],
      redactionNotice: null,
      embeddingTokens: options.embeddingTokens ?? 0,
      generationTokensInput: 0,
      generationTokensOutput: 0,
      generationPricingModel: null,
      modelUsed: NO_MODEL,
      cacheHit: options.cacheHit ?? false,
      startedAtMs,
    });
  }

  async function resolveVersionCompareChunks(
    role: Role,
    query: string,
    searchFilter: string | null,
  ): Promise<{ chunks: ScoredChunk[]; embeddingTokens: number } | null> {
    const intent = detectVersionCompareIntent(query);
    if (!intent) return null;

    const documents = await deps.search.listDocuments(searchFilter);
    const pair = findVersionPair(documents, intent);
    if (!pair) return null;

    const embeddingResult = await deps.embeddings.embed(query);
    const bothVersions = await deps.search.hybridSearch({
      queryText: query,
      queryVector: embeddingResult.vector,
      filter: searchFilter,
      top: 200,
      documentIds: [pair.from.document_id, pair.to.document_id],
    });
    const fromChunks = bothVersions.filter((c) => c.document_id === pair.from.document_id);
    const toChunks = bothVersions.filter((c) => c.document_id === pair.to.document_id);
    const diffs = diffSections(fromChunks, toChunks);
    return { chunks: toSyntheticChunks(diffs, pair, intent), embeddingTokens: embeddingResult.tokens };
  }

  async function execute(identity: CallerIdentity, request: QueryRequest): Promise<QueryResponse> {
    const startedAtMs = deps.clock.now().getTime();

    // Step 1: validate.
    const parsed = queryRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new InvalidQueryError(parsed.error.issues.map((issue) => issue.message));
    }
    const validated = parsed.data;
    const query = validated.query;
    const conversationId = validated.conversation_id ?? randomUUID();

    // Step 2: injection scan.
    const scan = scanForInjection(query);
    if (scan.block) {
      deps.logger.log('warn', 'query blocked by injection heuristics', {
        user_principal_name: identity.user_principal_name,
        role: identity.role,
        flags: scan.flags,
      });
      return refuse(identity, query, conversationId, startedAtMs, 'query_rejected', buildInjectionRefusal(), {
        injectionFlags: scan.flags,
      });
    }

    // D5(a): the cost hard stop is checked here -- before the embedding
    // cache lookup, before search, before generation -- so a query refused
    // for cost costs nothing at all. This is what makes the daily cap an
    // actual hard stop rather than the advisory "downgrade to a cheaper
    // model" alone (checked later, at model-routing time): that downgrade
    // reduces per-query cost but never reaches zero, so it cannot be relied
    // on to stop a burst by itself. See `functions/timers.ts`'s
    // `runCostAlertCheck` for what sets this flag and how often.
    const hardStopActive = (await deps.cache.get<boolean>(COST_HARD_STOP_CACHE_KEY)) ?? false;
    if (hardStopActive) {
      deps.logger.log('warn', 'query refused: daily cost hard stop is active', {
        user_principal_name: identity.user_principal_name,
        role: identity.role,
      });
      return refuse(identity, query, conversationId, startedAtMs, 'query_rejected', buildCostHardStopRefusal());
    }

    // Step 5: role-scoped search filter (computed early: also used by the
    // version-compare document lookup below).
    const searchFilter = buildSearchFilter(identity.role);

    // Steps 3-6 (version-compare variant): if this looks like a "what changed
    // between version X and Y" query and we can resolve both documents
    // within the caller's RBAC scope, retrieval is a deterministic diff
    // instead of a semantic search -- see version-compare.ts.
    let candidateChunks: ScoredChunk[];
    let cacheHit = false;
    let embeddingTokens = 0;

    const versionCompareResult = await resolveVersionCompareChunks(identity.role, query, searchFilter);
    if (versionCompareResult) {
      candidateChunks = versionCompareResult.chunks;
      embeddingTokens = versionCompareResult.embeddingTokens;
    } else {
      // Step 3: embedding cache lookup, role-scoped so a cache entry can
      // never cross a role boundary.
      const cacheKey = embeddingCacheKey(query, identity.role);
      const cached = await deps.cache.get<number[]>(cacheKey);
      let queryVector: number[];
      if (cached) {
        queryVector = cached;
        cacheHit = true;
      } else {
        // Step 4: embed.
        const embeddingResult = await deps.embeddings.embed(query);
        queryVector = embeddingResult.vector;
        embeddingTokens = embeddingResult.tokens;
        await deps.cache.set(cacheKey, queryVector, EMBEDDING_CACHE_TTL_SECONDS);
      }

      // Step 6: hybrid search.
      candidateChunks = await deps.search.hybridSearch({
        queryText: query,
        queryVector,
        filter: searchFilter,
        top: SEARCH_TOP_K,
      });
    }

    // Step 7: relevance threshold + per-role chunk cap.
    const policy = getRolePolicy(identity.role);
    const aboveThreshold = candidateChunks.filter((c) => c.similarity_score > RELEVANCE_THRESHOLD);
    const truncated = aboveThreshold.slice(0, policy.maxChunks);

    if (truncated.length === 0) {
      return refuse(identity, query, conversationId, startedAtMs, 'no_relevant_chunks', buildNoChunksRefusal(query), {
        searchFilter,
        retrievedChunks: candidateChunks,
        cacheHit,
        embeddingTokens,
      });
    }

    // Step 8: defence in depth. The search filter should already guarantee
    // this; any drop here means the filter itself has a bug and is an RBAC
    // incident, not a routine quality issue.
    const authorized: ScoredChunk[] = [];
    for (const chunk of truncated) {
      if (isChunkAuthorized(identity.role, chunk.document_classification)) {
        authorized.push(chunk);
      } else {
        deps.logger.log('error', 'rbac_violation: retrieved chunk outside role allow-list, dropping', {
          marker: 'rbac_violation',
          role: identity.role,
          chunk_id: chunk.chunk_id,
          document_id: chunk.document_id,
          document_classification: chunk.document_classification,
        });
      }
    }
    const rbacViolationLabels = truncated
      .filter((c) => !authorized.includes(c))
      .map((c) => `rbac_violation:${c.document_classification}`);

    // Step 9: refuse if defence-in-depth stripped everything.
    if (authorized.length === 0) {
      return refuse(
        identity,
        query,
        conversationId,
        startedAtMs,
        'no_authorized_documents',
        buildNoAuthorizedDocumentsRefusal(query),
        { searchFilter, retrievedChunks: truncated, cacheHit, embeddingTokens },
      );
    }

    // Step 10: redact, build the prompt, route the model, generate.
    const { chunks: redactedChunks, redactionsApplied: contentRedactions } = redactChunksForRole(
      identity.role,
      identity,
      authorized,
      query,
    );
    const extraDirectives = buildPromptDirectives(identity.role);
    const system = buildSystemPrompt({ role: identity.role, chunks: redactedChunks, extraDirectives });

    const downgradeActive = (await deps.cache.get<boolean>(COST_DOWNGRADE_CACHE_KEY)) ?? false;
    const tier = routeModel({ role: identity.role, query, downgradeActive });
    const wantsPrimary = tier === 'full';
    const bypassPrimary = wantsPrimary && breaker.shouldBypassPrimary();
    const primaryDeployment = deps.config.models.full;
    const miniDeployment = deps.config.models.mini;
    const attemptPrimary = wantsPrimary && !bypassPrimary;

    const generationRequest = {
      system,
      user: query,
      model: attemptPrimary ? primaryDeployment : miniDeployment,
      ...(deps.config.maxOutputTokens !== undefined ? { maxOutputTokens: deps.config.maxOutputTokens } : {}),
      ...(deps.config.temperature !== undefined ? { temperature: deps.config.temperature } : {}),
    };

    let generationResult;
    // Tracks which price list to bill against, independent of the actual
    // Azure deployment name -- see `generationPricingModel` doc on
    // FinalizeInput. Starts matching the routing decision and flips to mini
    // if a primary-model attempt fails and we fall back mid-request.
    let pricingModel: GenerationModel = attemptPrimary ? 'gpt-4o' : 'gpt-4o-mini';
    try {
      generationResult = await deps.generation.generate(generationRequest);
      if (attemptPrimary) breaker.recordSuccess();
    } catch (err) {
      if (!attemptPrimary) throw err; // mini itself failed: nothing left to fall back to.
      breaker.recordFailure();
      deps.logger.log('error', 'primary generation model failed, falling back to mini', {
        error: String(err),
      });
      generationResult = await deps.generation.generate({ ...generationRequest, model: miniDeployment });
      pricingModel = 'gpt-4o-mini';
    }

    // Step 11: citation validation.
    const { text: citedText, citations } = validateAndRenumberCitations(generationResult.text, redactedChunks);

    // Admin watermark is applied to the final answer text, after generation
    // and after citation renumbering -- see redaction.ts module doc.
    const { text: finalText, applied: watermarked } = applyAdminWatermark(identity.role, citedText);
    const redactionsApplied = watermarked ? [...contentRedactions, 'admin_watermark'] : contentRedactions;
    const redactionNotice = buildRedactionNotice(identity.role, {
      drillDownRequested: Boolean(validated.drill_down),
      redactionsApplied,
    });

    return finalize({
      identity,
      query,
      conversationId,
      searchFilter,
      injectionFlags: scan.flags,
      retrievedChunks: authorized,
      citations,
      responseText: finalText,
      status: 'answered',
      refusalReason: null,
      redactionsApplied: [...redactionsApplied, ...rbacViolationLabels],
      redactionNotice,
      embeddingTokens,
      generationTokensInput: generationResult.tokensInput,
      generationTokensOutput: generationResult.tokensOutput,
      generationPricingModel: pricingModel,
      modelUsed: generationResult.model,
      cacheHit,
      startedAtMs,
    });
  }

  return { execute };
}
