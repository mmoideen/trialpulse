# Production readiness checklist

Sign-off gate from PRD section 7, phase 4. Every item has an owner and a pass
criterion that someone can verify rather than assert.

**Overall status: NOT READY.** Of 89 items, 49 pass, 4 are partial and 36 are not
met. The unmet items are not paperwork - they include "no Azure tenant has been
provisioned", "no real document has ever been ingested" and "no load test has
been run". Nothing in this repository has executed against Azure.

The honest one-line summary: **this is a complete, tested, documented
implementation that has never met production.**

Legend: [x] met - [~] partially met - [ ] not met

---

## 0. The things that are not true yet

Read this section first. Everything below is conditioned on it.

- [ ] **No Azure tenant or subscription has been provisioned.** The Bicep
      templates compile and lint clean and the parameter files are
      machine-validated against the compiled template's parameter contract, but
      no `az deployment sub create` has ever run. Every "verified" claim about
      infrastructure below means "verified statically".
      *Owner: Meridian IT. Pass: a successful `what-if` followed by a successful
      deployment of the dev environment, with outputs recorded.*
- [ ] **No Entra app registration exists.** The six app roles are defined in
      code and referenced in documentation. No directory object exists.
      *Owner: Meridian identity admin. Pass: app registration with six app roles
      whose values exactly match `ROLES`, admin consent granted, Teams client ids
      pre-authorised.*
- [ ] **No real SharePoint corpus has been ingested.** Everything - tests, eval,
      the local dev server - runs against ~20 fabricated documents in
      `data/synthetic/`. Real clinical documents differ in length, structure,
      table density, scanned-page prevalence and vocabulary.
      *Owner: Clinical operations + IT. Pass: one full library ingested, chunk
      count and extraction quality reviewed by a domain reader.*
- [ ] **No load test has been executed.** The PRD's P50 < 2s / P99 < 5s targets
      (section 6.3) and the 500 documents/day ingestion throughput target are
      unmeasured. Local runs use in-memory providers that return instantly and
      tell you nothing about latency.
      *Owner: Platform. Pass: sustained 500 queries/day with a burst to 10x,
      P50/P99 recorded against target.*
- [ ] **The 0.72 relevance threshold has never been validated against real
      embeddings.** It is the PRD's number, applied locally to a calibrated
      lexical/hash-vector hybrid that was tuned to make it behave sensibly
      (ADR 0007). That is circular reasoning and it is the single most
      consequential unvalidated constant in the system.
      *Owner: Platform. Pass: threshold re-derived from a precision/recall sweep
      over the real corpus with real `text-embedding-3-large` vectors.*
- [ ] **The BAA question is unanswered.** PRD open question 1. Without a Business
      Associate Agreement covering Azure OpenAI, patient-level data must never be
      ingested - and nothing in the pipeline detects or blocks it.
      *Owner: Meridian compliance officer. Pass: written confirmation of BAA status
      and a documented decision on which libraries may be ingested.*

---

## 1. Security

- [x] All API endpoints require a valid Entra JWT; only `/api/health` and the
      SharePoint webhook handshake are exempt. *Verified: `auth/jwt.ts`.*
- [x] JWT signature, `iss`, `aud` and `tid` are all validated, with 5s clock
      tolerance. *Verified: `jwtVerify` options plus explicit `tid` check.*
- [x] Development auth mode cannot be enabled on an Azure host - `loadConfig()`
      refuses to start if it detects `WEBSITE_INSTANCE_ID` or
      `FUNCTIONS_WORKER_RUNTIME_VERSION`. *Verified: `config.ts`.*
- [x] RBAC is enforced in the search query, not post-filter. *Verified:
      `buildSearchFilter`, ADR 0001.*
- [x] An empty allow-list matches nothing rather than everything. *Verified:
      `rbac.ts` defensive branch and `rbac.test.ts`.*
- [x] No caller-controlled string reaches the OData filter expression.
      *Verified: all literals come from `DOCUMENT_CLASSIFICATIONS`.*
- [x] Input validation: zod schemas, 1,000-character query cap. *Verified:
      `schemas.ts`, `MAX_QUERY_LENGTH`.*
- [x] Injection heuristics flagged to the audit record. *Verified:
      `injection.ts`.*
- [x] gitleaks scan in CI with a repository-specific config. *Verified: scan run
      locally against this tree, 0 findings.*
- [x] Secrets live in Key Vault and reach apps as versionless Key Vault
      references; no literal secret in any app setting. *Verified in
      `main.bicep`; exactly one secret exists (SharePoint clientState).*
- [x] Local auth disabled on Azure OpenAI, Azure AI Search and Cosmos DB; shared
      key access disabled on Storage. *Verified in the compiled template.*
- [x] Least-privilege role assignments, scoped per resource, no Owner or
      Contributor, nothing at subscription scope. *Verified: `rbac.bicep`.*
- [x] CodeQL analysis for TypeScript and Python. *Verified: `codeql.yml`.*
- [x] Dependency auditing: `npm audit --audit-level=high` and `pip-audit`.
      *Verified: `ci.yml`.*
- [ ] **No per-user rate limiting.** One authenticated caller can saturate the
      Azure OpenAI TPM allocation for everyone. *Owner: Platform. Pass: API
      Management or Front Door rate-limit policy in front of the orchestrator,
      with a documented per-user quota.*
- [ ] **No ingestion-time scanning of document content for prompt injection.**
      The highest residual risk in `threat-model.md` (T3). *Owner: Platform.
      Pass: chunks scanned at ingestion, matches flagged on the document record,
      and a documented decision on quarantine versus index-and-flag.*
- [ ] **No verification that a chunk's `document_classification` matches its
      content.** Retrieval-scoped RBAC is only as correct as the label.
      *Owner: Platform + clinical ops. Pass: a sampling audit over the real
      corpus, plus an automated check for documents whose classification differs
      from their source library.*
- [ ] **No Private Endpoints or VNet integration.** Every data plane is
      internet-reachable, authenticated but exposed. *Owner: Meridian IT + Platform.
      Pass: Private Endpoints on Search, Cosmos, Storage, Key Vault and both
      OpenAI accounts, with VNet-integrated function apps.*
- [ ] **No token revocation check.** An offboarded user's token remains valid
      until expiry. *Owner: Meridian identity admin. Pass: Continuous Access
      Evaluation enabled, or a documented acceptance of the ~1h window.*
- [ ] **`clientState` comparison has not been confirmed constant-time.**
      *Owner: Platform. Pass: code review confirming a timing-safe comparison.*
- [ ] **No penetration test.** *Owner: Meridian IT. Pass: third-party test covering
      at minimum the RBAC boundary, prompt injection and the webhook endpoint.*

## 2. Access control and compliance

- [x] Six roles with explicit classification allow-lists. *Verified:
      `ROLE_POLICIES`.*
- [x] Multi-role tokens resolve to the least privileged role, logged.
      *Verified: `resolveRole`, ADR 0002.*
- [x] Unrecognised roles fall back to `site_monitor` with
      `role_fallback_applied` set. *Verified: `rbac.test.ts`.*
- [x] Defence-in-depth authorisation check after retrieval, with a distinct
      audit reason. *Verified: `isChunkAuthorized`, `refusal.ts`.*
- [x] The PRD's `site_level` / `site_communications` inconsistency is resolved
      and documented. *Verified: ADR 0002.*
- [x] Audit record captures role, filter, retrieved chunks with content hashes,
      redactions and injection flags. *Verified: `AuditRecord` in `types.ts`.*
- [x] Cosmos DB continuous backup / point-in-time restore enabled. *Verified:
      `cosmos.bicep`.*
- [x] `audit_logs` has no TTL, so a stray `ttl` field cannot expire a compliance
      record. *Verified in the compiled template.*
- [x] Audit archive lifecycle: Cool at 30d, Archive at 90d, delete at 2,555d
      (7 years). *Verified: `storage.bicep`.*
- [x] All resources in East US, region parameterised. *Verified: `main.bicep`.*
- [~] **7-year retention is configured but never exercised.** The storage
      lifecycle policy is right; the compaction job that writes Parquet to the
      archive container (PRD workflow 3.3.2) has not been observed running.
      *Owner: Platform. Pass: one archive cycle completed and a record restored
      from Archive tier.*
- [ ] **The audit store is mutable.** The identity that writes audit records can
      also delete them (threat model T4). *Owner: Platform + compliance. Pass:
      an append-only sink - immutable blob with a legal hold, or Event Hubs to a
      WORM archive - or a written acceptance of the risk.*
- [ ] **No resource locks on production Cosmos DB or Storage.** A subscription
      Owner can delete the audit trail. *Owner: Meridian IT. Pass: `CanNotDelete`
      locks applied to the prod resource group.*
- [ ] **No detection of patient-identifiable data at ingestion.** PRD section 8.5
      states the intent; nothing enforces it. *Owner: Platform + compliance.
      Pass: a PII detector on extracted text that quarantines rather than indexes.*
- [ ] **Document-level SharePoint ACLs are not propagated.** Access is decided by
      classification, so TrialPulse can be more permissive than SharePoint itself.
      *Owner: Product + compliance. Pass: a documented decision, and if ACL
      propagation is required, a design for it.*

## 3. Reliability and operations

- [x] Ingestion is idempotent; re-ingestion is safe and cheap. *Verified:
      content hashing, ADR 0003, `test_hash_parity.py`.*
- [x] Retry with exponential backoff and a dead-letter queue. *Verified:
      `retry.py`; poison queue pre-created in Bicep.*
- [x] Circuit breaker on the generation call. *Verified: `circuit-breaker.ts`.*
- [x] Ingestion failures do not affect query availability (queue-decoupled).
      *Verified by design; separate function apps and separate OpenAI accounts.*
- [x] Runbook covers deploy, rollback, secret rotation, reindex, dead-letter
      drain, cost alert, quota exhaustion and RBAC leak. *Verified:
      `runbook.md`.*
- [ ] **The runbook has never been executed.** Written against the templates, not
      against a running system. *Owner: Platform. Pass: a dry run of deploy,
      rollback and secret rotation in dev, with corrections merged.*
- [ ] **No alert on dead-letter queue depth.** A silently filling poison queue is
      an ingestion outage nobody is paged for. *Owner: Platform. Pass: an alert
      rule on `ingestion-work-poison` message count above 0 for 15 minutes.*
- [ ] **No availability test.** PRD section 8.3 asks for 99.9% measured by Azure
      Monitor. *Owner: Platform. Pass: a standard availability test against
      `/api/health` with an alert.*
- [ ] **No disaster recovery test.** Continuous backup is configured; a restore
      has never been performed. *Owner: Platform. Pass: a Cosmos point-in-time
      restore executed in dev, including re-granting the data-plane role
      assignment that does not travel with the restore.*
- [ ] **No document size limit, extraction timeout or content-type allow-list in
      ingestion.** *Owner: Platform. Pass: limits implemented with a documented
      rejection path.*
- [ ] **SharePoint webhook subscription renewal is unimplemented.** Graph
      subscriptions expire; without renewal, ingestion silently degrades to the
      daily sync. *Owner: Platform. Pass: a renewal timer plus an alert on
      subscription age.*

### Three integration gaps found by reconciling the infrastructure against the code

These were found by cross-checking `infra/main.bicep` against
`packages/orchestrator/src/config.ts` and `ingestion/function_app.py`. Each one
would have produced a deployment that succeeded and an application that did not
work. `infra/scripts/validate-app-settings.py` now runs in CI to catch the first
class of these automatically.

- [ ] **The ingestion pipeline's delta sync cannot reach the queue.**
      `ingestion/function_app.py` builds a `QueueClient` from
      `os.environ["AzureWebJobsStorage"]`, but the storage account is deployed
      with `allowSharedKeyAccess: false` and an identity-based connection, so
      there is no connection string and the variable does not exist. The queue
      *trigger* and *output binding* are fine; only the timer-driven direct
      client is affected. `AZURE_STORAGE_QUEUE_ACCOUNT_URL` is already set on the
      app for the fix. *Owner: Ingestion. Pass: `QueueClient(account_url=...,
      credential=DefaultAzureCredential())`, verified against a deployed app.*
- [ ] **Nothing writes the Cosmos `documents` container.** The orchestrator's
      `AzureDocumentMetadataStore` reads it for the Browse tab and for version
      comparison, and its module comment says the Python pipeline writes it - but
      the ingestion pipeline has no Cosmos client and no Cosmos role assignment.
      The container is created by `infra/modules/cosmos.bicep` so the read path
      returns empty rather than throwing. *Owner: Ingestion + Platform. Pass:
      ingestion writes `DocumentStatus` on every processed document, with a
      Cosmos data-plane role scoped to `/dbs/trialpulse/colls/documents` - not to
      the account.*
- [x] ~~**Azure Cache for Redis is provisioned and unused.**~~ **Resolved:** 
      Redis has been removed entirely. The embedding cache runs on Cosmos DB with 
      per-item TTL. Decision documented in `docs/adr/0008-embedding-cache-store.md`. 
      Removed ~$16/month idle spend. *(Completed 2026-08-28)*

## 4. Observability

- [x] Application Insights, workspace-based, with diagnostic settings on all
      ten applicable resources. See `infra/modules/` for diagnostic settings in keyvault, search, storage (3: account, blob, queue), cosmos, and both function-app instances (orchestrator, ingestion) and both openai instances (conversational, embedding).
- [x] Alert rules for P99 latency, error rate and daily model cost. *Verified:
      `alerts.bicep`.*
- [x] Azure Consumption budget with 80% actual, 100% actual and 100% forecast
      notifications. *Verified: `alerts.bicep`.*
- [x] Daily Log Analytics ingestion cap, so observability cannot itself become a
      denial-of-wallet. *Verified: `monitoring.bicep`.*
- [x] A `trace_id` joins the response, the audit record and the spans.
      *Verified: `QueryResponse` and `AuditRecord`.*
- [~] **Alert queries reference metric and event names that have not been
      confirmed against the telemetry the orchestrator emits.** If
      `trialpulse.query.cost_usd` is not the name actually emitted, the cost
      alert never fires and looks healthy. *Owner: Platform. Pass: run
      `customMetrics | distinct name` against a live deployment and reconcile
      every KQL query in `alerts.bicep` and `runbook.md`.*
- [ ] **No alert on RBAC tripwire firing.** `refusal_reason ==
      'no_authorized_documents'` should page someone; today it is only visible if
      you query for it. *Owner: Platform. Pass: an alert rule at severity 0.*
- [ ] **No dashboard.** The Teams tab Dashboard component exists; no Azure
      workbook or shared operational dashboard does. *Owner: Platform.*

## 5. Cost

- [x] Per-query cost computed and stored on every audit record. *Verified:
      `cost.ts`, `AuditRecord`.*
- [x] Model routing sends short, low-stakes queries to `gpt-4o-mini`. *Verified:
      `model-router.ts`.*
- [x] Hard daily cost cap downgrades non-executive traffic. *Verified:
      `TRIALPULSE_DAILY_COST_CAP_USD`, PRD 3.3.3.*
- [x] `maximumInstanceCount` caps compute scale-out on both apps. *Verified:
      `function-app.bicep`.*
- [x] A worked cost model exists with assumptions stated. *Verified:
      `cost-model.md`.*
- [ ] **The PRD's `< $300/month` target is not achievable as specified.** ~$417 at
      500 queries/day on the standard search tier the PRD requires; ~$2,000 at
      5,000 queries/day. *Owner: Product + Meridian IT. Pass: a renegotiated budget
      or an explicit decision to accept basic-tier search with reduced embedding
      dimensions.*
- [ ] **No cost control actually stops anything.** Every control alerts or
      downgrades. *Owner: Platform. Pass: a hard ceiling that refuses queries,
      with a documented user-facing message.*
- [ ] **No per-user or per-role budget.** One team can consume the whole cap.

## 6. Evaluation and quality

- [x] Deterministic, offline, reproducible evaluation design. *Verified:
      ADR 0007, memory providers.*
- [x] The eval job is a hard CI gate, not advisory, and fails loudly if the
      harness is missing. *Verified: `ci.yml`.*
- [x] Citation validation drops hallucinated indices and uncited chunks.
      *Verified: `citations.ts`.*
- [~] **The 24-item golden set was not present in the tree when this checklist
      was written.** Gates and thresholds are documented in `evaluation.md`.
      *Owner: Eval workstream. Pass: `npm run eval` green in CI with all six
      gates reported.*
- [ ] **No evaluation against real embeddings or the real corpus.** The local
      score is a calibrated lexical/hash hybrid, not a semantic cosine.
      *Owner: Platform. Pass: the golden set re-run against a dev deployment with
      real `text-embedding-3-large` vectors, MRR and false-refusal rate recorded.*
- [ ] **No human review of answer quality by a clinical domain expert.**
      *Owner: Clinical operations. Pass: 20 answers reviewed by a CRA or
      regulatory associate, with correctness and citation accuracy scored.*
- [ ] **User satisfaction (thumbs up rate > 80%, PRD section 10) is unmeasured.**
      The feedback field exists on `ConversationTurn`; no data.

## 7. Release engineering

- [x] CI runs on push and PR with node, python, eval, security and infra jobs.
- [x] Concurrency group cancels superseded runs.
- [x] No secret is required for CI to pass on a fork.
- [x] npm and pip caches configured.
- [x] Bicep templates build and lint with zero diagnostics; parameter files are
      machine-validated against the compiled template. *Verified: `az bicep
      build`, `az bicep lint`, `infra/scripts/validate-parameters.py`.*
- [x] App settings are machine-validated against the environment variables the
      orchestrator and the ingestion pipeline actually require. *Verified:
      `infra/scripts/validate-app-settings.py`, wired into the `infra` CI job.*
- [x] Dependabot configured for npm, pip and GitHub Actions.
- [~] **Actions are pinned to major version tags, not commit SHAs.** Tags are
      mutable. gitleaks is installed from a version-pinned release archive with
      SHA-256 verification, so the one third-party tool in the pipeline is
      content-addressed. *Owner: Platform. Pass: Dependabot's first pass rewrites
      `uses:` references to pinned SHAs.*
- [ ] **No CD pipeline.** Deployment is manual. *Owner: Platform. Pass: a
      workflow using OIDC workload identity federation - no long-lived secret -
      scoped to the target resource group, with a manual approval gate on prod.*
- [ ] **No environment protection rules or branch protection configured.**
      *Owner: Meridian IT.*

---

## Sign-off

Do not sign this until section 0 is empty.

| Role | Name | Date | Signature |
|---|---|---|---|
| Engineering lead | | | |
| Meridian IT administrator | | | |
| Clinical operations representative | | | |
| Compliance officer | | | |

**Recommendation as of this document's date: do not deploy to production.**
The implementation is complete enough to run a supervised dev-tenant pilot with
synthetic and non-sensitive documents. It is not ready for real clinical
documents, because the two controls that would make that safe - ingestion-time
content scanning and an immutable audit trail - are not built, the access-control
threshold has never been validated against real embeddings, and no independent
security review has been performed.
