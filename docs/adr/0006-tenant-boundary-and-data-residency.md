# 0006. Keep all data inside the tenant, in East US, with no third-party APIs

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD decision 5, sections 1.2 and 8.5, open question 1

## Context

Meridian is a clinical-stage biotech running an active Phase 3 study. The corpus
TrialPulse indexes includes the AXIOM-HN01 protocol, investigator brochures,
IND correspondence and safety reports. Three constraints follow, and they are
constraints of the business, not preferences of the architecture.

1. **Contractual.** Clinical trial documents are covered by sponsor-CRO and
   sponsor-site agreements that restrict onward disclosure. Sending a protocol
   excerpt to a vendor with whom Meridian has no data processing agreement is a
   contractual breach regardless of what that vendor does with it.
2. **Regulatory.** If patient-level data ever enters the system - and safety
   narratives are exactly where it would - HIPAA applies, and processing it
   without a Business Associate Agreement is not a matter of degree.
3. **Practical.** An IT organisation of Meridian's size evaluating an AI system
   will be asked "where does the data go" by an auditor, a partner or a board
   member. "Nowhere it wasn't already" is an answer that survives that
   conversation. Anything more complicated does not.

## Decision

**Everything runs in Meridian's own Azure subscription, in the same Entra tenant
as Microsoft 365, in East US.** SharePoint Online, Azure OpenAI, Azure AI
Search, Cosmos DB, Storage and both Function Apps are deployed to
`eastus` by a single `location` parameter, defaulted in `infra/main.bicep`.
East US matches Meridian's Boston presence, which keeps the network path short and
keeps the data in the same jurisdiction as the people accountable for it.

**No third-party API is called on the request path.** Not the OpenAI API
directly, not a hosted vector database, not an external reranker, not an
observability SaaS. Azure OpenAI is used specifically because it is a first-party
Azure service governed by the Azure subscription agreement and the Microsoft
Product Terms rather than by a separate vendor contract - documents submitted to
it are not used to train shared models and are processed within the region.

**Authentication is Entra ID, and there is no local user or role store.** Roles
come from the `roles` claim on the caller's token (ADR 0002). TrialPulse holds no
copy of Meridian's directory, so offboarding a user in Entra removes their access
here with no second system to remember.

**Service-to-service authentication is managed identity, not keys.** Local auth
is disabled on Azure OpenAI, Azure AI Search and Cosmos DB; shared-key access is
disabled on Storage. The estate has two secrets, both in Key Vault, both surfaced
as versionless Key Vault references (see `infra/README.md`). A credential that
does not exist cannot be exfiltrated.

**Region is a parameter, not a constant.** `location` defaults to `eastus` and
flows to every module. If Meridian later needs an EU deployment for a European
regulatory filing, that is a parameters file, not a refactor - though model
availability differs by region and would need checking.

## Consequences

**Good**

- The data-flow diagram fits in a sentence: SharePoint to Azure Functions to
  Azure AI Search and Azure OpenAI, all inside one tenant in one region.
- No new vendor contract, no new DPA, no new authentication system, no new
  offboarding checklist. This is the largest single reason the PRD's premise -
  that TrialPulse can be deployed by an IT organisation of Meridian's size - holds.
- Audit records never leave the tenant either. The 7-year retention obligation
  is satisfied inside Cosmos DB and Blob Archive under Meridian's own control.

**Bad, or at least costly**

- **The BAA question is unresolved and it is blocking for one class of content.**
  PRD open question 1 asks whether Meridian has an executed BAA with Microsoft
  covering Azure OpenAI. Without one, patient-level data must never be ingested.
  The system is designed for operational documents and PRD section 8.5 states
  that intent, but *design intent is not an enforcement mechanism*: nothing in
  the ingestion pipeline inspects a document for patient identifiers before
  embedding it. A safety narrative containing subject initials and a date of
  birth, dropped into the Safety Reports library, will be chunked, embedded and
  indexed like anything else. Detection at ingestion is not implemented and is
  listed as a gap in `docs/production-readiness-checklist.md`.
  **This must be confirmed with Meridian's compliance officer before any real
  document is ingested.**
- Azure OpenAI abuse monitoring retains prompts for up to 30 days for human
  review unless a modified-abuse-monitoring exemption is approved. That retention
  is inside Microsoft's boundary, not Meridian's. For a tenant handling clinical
  documents this is worth requesting explicitly; it is not the default.
- Single-region means a regional outage is a total outage. PRD section 8.3 asks
  for 99.9%, which single-region Azure services can support on paper, but there
  is no failover. Multi-region would roughly double infrastructure cost and force
  a decision about whether audit data may be replicated across regions.
- We are committed to Azure OpenAI model availability in East US. If a future
  model Meridian wants is not offered there, the choice is between the model and
  the residency guarantee, and residency wins.
- Everything is deployed with `publicNetworkAccess: Enabled`. Traffic is
  TLS-protected and authenticated, but the data plane of each service is
  reachable from the internet by anyone holding a valid token. Private Endpoints
  and VNet integration are the obvious hardening step and are not implemented;
  see `docs/threat-model.md`.
