# Product Requirements Document: TrialPulse

## 1. Product Overview

### 1.1 Purpose

TrialPulse is a Microsoft Teams-native clinical document intelligence application built specifically for Meridian Therapeutics. It provides instant, cited, role-scoped answers drawn from Meridian's clinical document corpus, including protocols, investigator brochures, regulatory submissions, safety reports, and site communications. The system enforces strict access boundaries so that a site monitor cannot see unblinded safety data, a regulatory affairs specialist can see everything, and an executive gets high-level summaries without document-level detail. TrialPulse lives entirely inside Meridian's existing Microsoft 365 tenant, requiring no new authentication system, no new vendor contract, and no context switching. The goal is to eliminate the hours clinical operations and regulatory staff currently spend searching SharePoint folders and email threads for document fragments they know exist but cannot locate.

### 1.2 Core Objectives

1. Reduce mean time to answer for clinical document questions from hours to under 30 seconds, with every answer carrying a verifiable citation to the source document and page.
2. Enforce role-based access control at the retrieval layer, not as an afterthought, so that document scope violations are structurally impossible.
3. Deliver a complete audit trail of every question, every retrieved chunk, every redaction decision, and every token cost, stored in a queryable format for compliance review.
4. Operate within Meridian's existing Microsoft 365 tenant using Entra ID for authentication, SharePoint Online for document storage, and Azure OpenAI for embedding and generation, with no data ever leaving the tenant boundary.
5. Provide a cost transparency dashboard so IT leadership can see per-department spend and model utilization in real time.

### 1.3 Target Users

| Role | Description | Primary Needs |
|------|-------------|---------------|
| Regulatory Affairs | Senior directors and associates managing FDA submissions, IND amendments, and global regulatory correspondence | Instant retrieval of submission documents, cross-referencing between versions, and audit-ready Q&A logs |
| Clinical Operations | Trial managers, CRAs, and project managers running the AXIOM-HN01 Phase 3 study | Protocol lookups, site communication search, deviation documentation, and enrollment tracker references |
| Medical Affairs | Medical science liaisons and medical directors engaging with KOLs and sites | Investigator brochure access, safety narrative summaries, and competitive landscape documents |
| Site Monitor | External or internal monitors auditing trial sites | Site-level documents only, no access to unblinded aggregate data or cross-site comparisons |
| Executive | C-suite and board members needing high-level summaries | Dashboard-level metrics, trial status summaries, and competitive intelligence without document-level noise |
| IT Administrator | The person running Meridian's IT who is evaluating AI | Cost visibility, usage dashboards, role assignment, and governance controls |

---

## 2. Technical Architecture

### 2.1 Stack Overview

| Layer | Technology | Purpose |
|-------|------------|---------|
| Collaboration Client | Microsoft Teams (declarative agent + personal tab) | Primary user interface; no separate app install required |
| Identity & Auth | Microsoft Entra ID (Azure AD) via Teams SSO | Zero-trust authentication; roles sourced from Entra app roles |
| Document Source | SharePoint Online document libraries | Source of truth for clinical documents; versioning and retention native |
| Ingestion Pipeline | Azure Functions (Python) + Azure Queue Storage | Headings-aware chunking, content hashing, idempotent re-ingestion |
| Vector Store | Azure AI Search (formerly Cognitive Search) | Hybrid search with semantic ranking; vector + keyword |
| Embedding Model | Azure OpenAI text-embedding-3-large | 3072-dimension embeddings for clinical text retrieval |
| Generation Model | Azure OpenAI GPT-4o or GPT-4o-mini | Response generation with grounded citations; mini for cost-sensitive queries |
| Application Backend | Azure Functions (TypeScript/Node.js) | Orchestration layer: auth, retrieval, generation, audit logging |
| Audit Database | Azure Cosmos DB (NoSQL) | Immutable audit log with trace IDs, queryable by compliance |
| Cost Telemetry | Azure Application Insights + custom telemetry | Per-query token costs, cache hit rates, latency distributions |
| Cost Dashboard | Power BI embedded or Teams tab | Real-time departmental spend and usage analytics |
| Infrastructure | Azure Bicep | Infrastructure as code with environment parity |

### 2.2 High-Level Architecture

```
Microsoft Teams
    |
    |-- SSO Token (Entra ID)
    v
Azure Functions (Orchestrator)
    |
    |-- 1. Validate JWT + Extract Role Claim
    |-- 2. Build Role-Scoped Search Filter
    |-- 3. Query Azure AI Search (Vector + Semantic)
    |-- 4. Apply Relevance Threshold (cosine > 0.72)
    |-- 5. If chunks found: Generate cited answer
    |-- 6. If no chunks: Refuse (do not hallucinate)
    |-- 7. Write audit record to Cosmos DB
    |-- 8. Return answer + citations to Teams
    |
    v
Azure AI Search <-- Azure Functions (Ingestion Pipeline)
    |                      ^
    |                      |-- SharePoint Webhooks
    v                      |-- Scheduled delta sync
SharePoint Online Document Libraries
    |-- Protocols/
    |-- Investigator Brochures/
    |-- Regulatory Submissions/
    |-- Safety Reports/
    |-- Site Communications/
    |-- Competitive Intelligence/
```

### 2.3 Critical Architecture Decisions

**Decision 1: Retrieval-scoped RBAC enforced in the search query, not post-filter.**
Azure AI Search will include a `document_classification` field on every chunk. The orchestrator appends a `$filter` clause to every search query based on the caller's Entra app role. A `site_monitor` role gets `document_classification eq 'site_level'`. A `regulatory_affairs` role gets no filter. This means the search engine itself returns only permitted chunks. Post-filtering is not used because it creates a leakage vector through result counts and ranking.

**Decision 2: Document ingestion is idempotent and version-aware.**
Every document chunk carries a `content_hash` (SHA-256 of the normalized text). The ingestion pipeline computes this hash before writing. If the hash exists, the chunk is skipped. If a document is updated in SharePoint, the new version generates new hashes; old hashes are tombstoned after 30 days. This prevents duplicate chunks and supports document versioning without full re-indexing.

**Decision 3: Refusal over hallucination.**
If no chunks meet the relevance threshold (cosine similarity > 0.72), the system returns a structured refusal: "I cannot find information about [topic] in the documents you are authorized to access." The refusal is logged with the full query, the role, and the empty result set. There is no fallback to general knowledge. This is a compliance requirement for regulated document Q&A.

**Decision 4: Separate embedding and generation model deployments.**
The embedding model runs on a dedicated Azure OpenAI deployment with high throughput and no rate limit sensitivity. The generation model runs on a separate deployment with per-minute token limits appropriate for conversational load. This separation prevents ingestion jobs from starving user queries.

**Decision 5: All data stays within the tenant boundary.**
SharePoint Online, Azure OpenAI (with data residency configuration), Azure AI Search, and Cosmos DB all run in the same Azure region (East US, matching Meridian's Boston presence) and within the same Entra tenant. No data is sent to third-party APIs, including the OpenAI API directly. This satisfies Meridian's likely data residency and BAA requirements as a clinical-stage company handling sensitive trial information.

---

## 3. Functional Requirements

### 3.1 Identity, Multi-Tenancy, and RBAC

**Role Definitions (Entra App Roles):**

| App Role | Document Classes | Redaction Rules |
|----------|------------------|-----------------|
| `regulatory_affairs` | All | None |
| `clinical_operations` | All except `competitive_intelligence` | None |
| `medical_affairs` | `investigator_brochures`, `safety_reports`, `competitive_intelligence` | Safety reports: aggregate counts only, no patient identifiers |
| `site_monitor` | `site_communications` only | Site name masked unless assigned to caller's site |
| `executive` | All | Full document text redacted; only summaries and metrics shown |
| `it_admin` | All (for support) | Watermarked "ADMIN ACCESS" on every answer |

**Provisioning Flow:**
1. Meridian's IT admin assigns Entra app roles in the Azure portal or via Microsoft Graph.
2. TrialPulse reads the `roles` claim from the JWT on every request. No local role database is maintained.
3. If a user has no recognized role, they are treated as `site_monitor` (most restrictive) and a warning is logged.

**Isolation Guarantees:**
- Search queries are filtered at the engine level.
- The generation prompt includes a system instruction that reinforces the role boundary.
- Audit logs record the exact role claim used for each query.

### 3.2 Core Domain Features

**Feature 3.2.1: Natural Language Document Q&A**
- Users type questions in natural language in the Teams chat or tab.
- The system retrieves relevant document chunks, generates a cited answer, and presents it with source links back to SharePoint.
- Citations are numbered and link directly to the source document page/section.

**Feature 3.2.2: Document Version Comparison**
- Users can ask: "What changed between protocol version 3.0 and 4.0?"
- The system retrieves both versions, runs a diff on the relevant sections, and presents a structured comparison.
- This requires the ingestion pipeline to tag chunks with `document_version` and `previous_version_hash`.

**Feature 3.2.3: Safety Signal Quick Look**
- Medical affairs users can ask: "Summarize safety events for revarafusp alfa in the last quarter."
- The system retrieves safety report chunks, aggregates by SOC (System Organ Class), and presents a structured table.
- Patient identifiers are never included; only aggregate counts and narrative summaries.

**Feature 3.2.4: Regulatory Submission Tracker Q&A**
- Regulatory users can ask: "What IND amendments are pending?" or "When is the pre-NDA meeting scheduled?"
- The system retrieves from regulatory submission documents and correspondence.
- Answers include document names, dates, and responsible parties.

**Feature 3.2.5: Executive Briefing Mode**
- Executive users ask high-level questions: "What is the status of the AXIOM-HN01 trial?"
- The system synthesizes across multiple document types and presents a 3-bullet summary with a "drill down" link that opens the detailed answer (visible only to less-restricted roles).

### 3.3 Background Workflows

**Workflow 3.3.1: Document Ingestion Pipeline**
- Triggered by SharePoint webhooks (immediate) and a daily scheduled sync (catch-up).
- Steps: Download document, extract text (Word/PDF), chunk with heading awareness, compute content hash, generate embeddings, write to Azure AI Search index.
- Idempotency: Content hash prevents duplicate chunks.
- Retry policy: Exponential backoff with 3 retries for transient failures; dead-letter queue after final failure.

**Workflow 3.3.2: Audit Log Compaction**
- Daily job compresses raw audit events into a daily summary table.
- Raw events are moved to cold storage (Azure Blob Archive) after 90 days.
- Summary table retains aggregated metrics: query counts, refusal counts, average latency, total cost per role.

**Workflow 3.3.3: Cost Alerting**
- Hourly job checks rolling 24-hour spend against configurable thresholds.
- If spend exceeds 150% of the prior 7-day average, a Teams message is sent to IT admin.
- If spend exceeds a hard cap ($500/day default), the generation model is downgraded to GPT-4o-mini for all non-executive queries.

---

## 4. Database Schema

### 4.1 Cosmos DB Collections (Audit and Telemetry)

```json
// Collection: audit_logs
{
  "id": "uuid",
  "trace_id": "uuid",
  "timestamp": "2026-08-28T19:45:00Z",
  "user_principal_name": "dana.whitfield@meridiantx.com",
  "entra_role": "regulatory_affairs",
  "query_text": "What changed in protocol version 4.0?",
  "query_hash": "sha256_of_normalized_query",
  "retrieved_chunks": [
    {
      "chunk_id": "doc_uuid_chunk_12",
      "document_id": "sharepoint_item_id",
      "document_title": "AXIOM-HN01 Protocol v4.0",
      "document_classification": "protocol",
      "similarity_score": 0.84,
      "content_hash": "abc123..."
    }
  ],
  "response_text": "...generated answer...",
  "response_status": "answered", // or "refused"
  "refusal_reason": null, // or "no_relevant_chunks"
  "tokens_input": 1240,
  "tokens_output": 340,
  "model_used": "gpt-4o",
  "estimated_cost_usd": 0.0042,
  "latency_ms": 1840,
  "cache_hit": false
}

// Collection: daily_summaries
{
  "id": "2026-08-28",
  "date": "2026-08-28",
  "total_queries": 142,
  "total_refusals": 8,
  "avg_latency_ms": 1650,
  "total_cost_usd": 2.14,
  "breakdown_by_role": {
    "regulatory_affairs": { "queries": 45, "cost": 0.78 },
    "clinical_operations": { "queries": 52, "cost": 0.89 },
    "medical_affairs": { "queries": 28, "cost": 0.31 },
    "executive": { "queries": 12, "cost": 0.12 },
    "site_monitor": { "queries": 5, "cost": 0.04 }
  }
}
```

### 4.2 Azure AI Search Index Schema

```json
{
  "name": "trialpulse-chunks",
  "fields": [
    { "name": "chunk_id", "type": "Edm.String", "key": true, "retrievable": true },
    { "name": "document_id", "type": "Edm.String", "filterable": true, "retrievable": true },
    { "name": "document_title", "type": "Edm.String", "searchable": true, "retrievable": true },
    { "name": "document_classification", "type": "Edm.String", "filterable": true, "facetable": true },
    { "name": "document_version", "type": "Edm.String", "filterable": true, "sortable": true },
    { "name": "content", "type": "Edm.String", "searchable": true, "retrievable": true },
    { "name": "content_hash", "type": "Edm.String", "filterable": true },
    { "name": "heading_path", "type": "Edm.String", "searchable": true, "retrievable": true },
    { "name": "page_number", "type": "Edm.Int32", "filterable": true, "sortable": true },
    { "name": "source_url", "type": "Edm.String", "retrievable": true },
    { "name": "ingested_at", "type": "Edm.DateTimeOffset", "filterable": true, "sortable": true },
    { "name": "embedding", "type": "Collection(Edm.Single)", "dimensions": 3072, "vectorSearchConfiguration": "default" }
  ]
}
```

### 4.3 Indexes

- `document_classification` filterable index (used on every query for RBAC).
- `document_id` filterable index (used for version comparison and deduplication).
- `content_hash` filterable index (used for idempotency checks).
- Semantic configuration on `content` and `document_title` fields.
- HNSW vector index on `embedding` with `efConstruction: 128`, `m: 16`.

---

## 5. API and Server Actions

### 5.1 Server Actions (Azure Functions)

| Action | Auth Requirement | Optimistic Update |
|--------|------------------|-------------------|
| `POST /api/query` | Valid Entra JWT with app role claim | None (response is synchronous) |
| `GET /api/health` | None | N/A |
| `GET /api/admin/usage` | `it_admin` role only | N/A |
| `POST /api/admin/reindex` | `it_admin` role only | Background queue job |
| `GET /api/documents/:id` | Valid JWT + RBAC filter on document_classification | N/A |

### 5.2 Public API (Microsoft Teams Bot Framework)

- Teams declarative agent manifest defines the bot endpoint.
- Bot Framework Adapter handles message routing.
- All messages are processed through the same `POST /api/query` orchestrator.

### 5.3 Webhooks

**SharePoint Change Notification Webhook:**
- Registered on each monitored document library.
- Sends `clientState`-validated notifications to `POST /api/webhooks/sharepoint`.
- Webhook handler enqueues a document re-ingestion job.
- Signature validation uses the SharePoint webhook validation token.

---

## 6. User Interface

### 6.1 Layout Structure

**Teams Chat Interface (Declarative Agent):**
- User @mentions the agent or opens a 1:1 chat.
- Conversation history is maintained per user (stored in Cosmos DB, TTL 30 days).
- Each response includes: answer text, numbered citations, and a "Was this helpful?" thumbs up/down.

**Teams Personal Tab (Full Experience):**
- Three tabs: Ask, Browse, Dashboard.
- Ask: Full-page chat with conversation history sidebar.
- Browse: Document library explorer filtered by user's role; shows ingestion status per document.
- Dashboard: Usage analytics for the user (personal) and IT admin (organization-wide).

### 6.2 Key Components

**Component: CitedAnswerCard**
- Displays the generated answer with inline citation numbers.
- Each citation is a clickable pill linking to the source SharePoint document.
- Includes a "Copy to clipboard" button and a "Share in channel" button.

**Component: DocumentStatusBadge**
- Shows ingestion status: Pending, Indexed, Failed, Outdated.
- Color-coded: Gray, Green, Red, Yellow.
- Hover tooltip shows last ingested timestamp and chunk count.

**Component: CostDashboard**
- Bar chart: daily queries by role (last 30 days).
- Line chart: cumulative cost vs. monthly budget.
- Table: top 10 most expensive queries (anonymized query hash, role, cost, latency).

### 6.3 Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| P50 query latency | < 2 seconds | Azure Application Insights custom event |
| P99 query latency | < 5 seconds | Azure Application Insights custom event |
| Search relevance (MRR) | > 0.85 | Eval dataset (24 golden queries) |
| Refusal rate (false negative) | < 5% | Eval dataset manual review |
| Daily ingestion throughput | > 500 documents | Azure Functions monitoring |
| Uptime | 99.9% | Azure Monitor availability test |

---

## 7. Implementation Phases

### Phase 1: Foundation (Weeks 1--2)

1. Provision Azure resources (OpenAI, AI Search, Cosmos DB, Functions) via Bicep.
2. Set up Entra app registration with app roles.
3. Build the ingestion pipeline: SharePoint connector, text extraction, chunking, embedding, indexing.
4. Seed the index with 20 synthetic clinical documents for local testing.

**Deliverable:** A working ingestion pipeline and a populated search index with synthetic data.

### Phase 2: Query Engine (Weeks 3--4)

1. Build the orchestrator function: auth, RBAC filter construction, hybrid search, generation, refusal logic.
2. Implement the Teams declarative agent manifest and bot adapter.
3. Build the cited answer card and basic conversation history.
4. Write the audit logging pipeline to Cosmos DB.

**Deliverable:** A Teams chatbot that answers questions from synthetic data with citations and role enforcement.

### Phase 3: Governance and Cost Control (Week 5)

1. Build the cost telemetry pipeline and Power BI dashboard.
2. Implement cost alerting workflows and model downgrade logic.
3. Build the admin API endpoints (usage, reindex, health).
4. Create the production readiness checklist and runbook.

**Deliverable:** Cost dashboard live, alerting configured, admin controls functional.

### Phase 4: Evaluation and Hardening (Week 6)

1. Build the 24-item golden eval dataset with deterministic judges.
2. Run end-to-end evaluation: relevance, citation accuracy, RBAC leakage, refusal correctness.
3. Fix any failing gates.
4. Document the threat model and architecture decision records.

**Deliverable:** Eval gates passing, documentation complete, production readiness checklist signed off.

---

## 8. Non-Functional Requirements

### 8.1 Security

- All API endpoints require a valid Entra JWT. No anonymous access.
- RBAC enforced at the search engine level, not application post-filter.
- Input validation: zod schemas on all incoming requests; query length capped at 1000 characters; injection heuristics flagged to audit log.
- Secrets managed via Azure Key Vault; no secrets in code or environment variables except Key Vault references.
- gitleaks scan in CI on every commit.

### 8.2 Scalability

- Azure Functions consumption plan auto-scales to handle ingestion bursts (e.g., after a large document upload).
- Azure AI Search standard tier supports up to 100M chunks; Meridian's corpus will likely be under 1M chunks in year one.
- Azure OpenAI deployments provisioned with TPM limits appropriate for 500 queries/day initial load, scalable to 5000/day.

### 8.3 Availability

- Target: 99.9% uptime excluding scheduled maintenance.
- Azure AI Search and Cosmos DB both offer SLA-backed availability.
- Ingestion pipeline failures do not impact query availability.

### 8.4 Observability

- OpenTelemetry tracing across all Functions: request span, retrieve span, generate span.
- Custom dimensions on every span: role, query_hash, document_classification filter, cache_hit, latency, cost.
- Azure Monitor alerts on P99 latency > 5s, error rate > 1%, and daily cost > threshold.

### 8.5 Compliance

- All audit logs retained for 7 years (industry standard for clinical trial records).
- Cosmos DB point-in-time restore enabled.
- Data residency: all resources deployed to East US (matching Meridian's Boston presence).
- No PHI is intentionally stored in the vector index; the system is designed for clinical operations documents, not patient-level data. If patient-level data is ever ingested, a separate HIPAA-compliant workspace with BAA is required.

---

## 9. Optimization Recommendations

**Database tuning:**
- Pre-warm the Azure AI Search index with common queries to improve semantic ranking quality.
- Use Azure AI Search semantic ranking (free tier up to 1000 queries/month; beyond that, consider dedicated semantic capacity).

**Frontend performance:**
- Teams tab should lazy-load the Dashboard component; initial load should be the Ask interface only.
- Conversation history should paginate (20 messages per page) to keep Cosmos DB read costs low.

**Reliability:**
- Implement a circuit breaker on the Azure OpenAI generation call. If 3 consecutive failures occur, fall back to GPT-4o-mini for 5 minutes before retrying the primary model.
- Queue-based ingestion prevents SharePoint webhook floods from overwhelming the system.

**Cost control:**
- Use GPT-4o-mini for all queries under 100 tokens unless the user is an executive or the query contains keywords like "safety" or "regulatory" that require higher reasoning.
- Cache embeddings for identical queries (same normalized text + role) for 1 hour using Azure Cache for Redis.
- Compress audit logs older than 90 days to Parquet in Azure Blob Archive storage.

---

## 10. Success Metrics

| Metric | Baseline | Target (90 days) |
|--------|----------|------------------|
| Mean time to answer | 2--4 hours (manual SharePoint search) | < 30 seconds |
| Daily active users | 0 | 25 (20% of ~125 employees) |
| Queries per user per week | 0 | 8 |
| Citation accuracy (eval) | N/A | > 90% |
| RBAC leakage incidents | N/A | 0 |
| Monthly Azure spend | N/A | < $300 |
| User satisfaction (thumbs up rate) | N/A | > 80% |

---

## 11. Open Questions and Risks

1. **Open: Does Meridian have an executed BAA with Microsoft for Azure OpenAI?** Without a BAA, patient-level data must never enter the system. The PRD assumes only operational documents are ingested, but this must be confirmed with Meridian's compliance officer.
2. **Open: What is the current SharePoint site structure?** The ingestion pipeline needs to know which document libraries to monitor. If documents are scattered across personal OneDrives, a migration to centralized libraries may be a prerequisite.
3. **Risk: SharePoint webhook reliability.** SharePoint webhooks can miss events or deliver them out of order. The daily scheduled sync is the safety net, but a 24-hour delay on ingestion could frustrate users who just uploaded a document.
4. **Risk: Azure OpenAI quota limits.** Meridian's tenant may not have high enough TPM quotas initially. A quota increase request to Microsoft may take 1--2 weeks.
5. **Open: Will Meridian require on-premises data gateway?** If any documents live on on-premises file servers, an Azure Data Gateway would be required. The PRD assumes cloud-native storage.
