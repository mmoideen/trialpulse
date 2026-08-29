# TrialPulse operational runbook

Procedures for running TrialPulse in Azure. Written for someone on call who has
not read the codebase.

> **This runbook has never been executed.** No Azure tenant has been provisioned
> for TrialPulse. Commands were written against the resources declared in
> `infra/`, and resource names, output names and app settings were checked
> against the compiled ARM template - but nothing below has been run end to end.
> The first person to use it should expect to correct it, and should.

## Conventions

```bash
ENV=dev                                   # or prod
RG="rg-trialpulse-$ENV"
SUB="<subscription-id>"
az account set --subscription "$SUB"
```

Resource names carry a deterministic suffix. Do not memorise them; read them from
the deployment outputs:

```bash
az deployment sub show \
  --name "<deployment-name>" \
  --query properties.outputs \
  --output json
```

Or find them by tag, which is why everything is tagged:

```bash
az resource list --tag app=trialpulse --query "[?tags.env=='$ENV'].{name:name,type:type}" -o table
```

## Access required

| Task | Role |
|---|---|
| Deploy | Contributor + User Access Administrator on the subscription |
| Read logs, run KQL | Log Analytics Reader on the workspace |
| Rotate secrets | Key Vault Secrets Officer on the vault |
| Drain a queue | Storage Queue Data Contributor on the storage account |
| Query the audit trail | Cosmos DB Built-in Data Reader on the account |
| Investigate an RBAC leak | all of the above |

Grant these to groups, not to people, and time-bound the investigation set with
Privileged Identity Management if it is available.

---

## 1. Deploy

### 1.1 First deployment of an environment

Order matters. Steps 2 and 4 are not in Bicep by design (`infra/README.md`
explains why).

**Step 1 - infrastructure.**

```bash
az deployment sub what-if \
  --location eastus \
  --template-file infra/main.bicep \
  --parameters "infra/main.parameters.$ENV.json"

az deployment sub create \
  --name "trialpulse-$ENV-$(date +%Y%m%d%H%M)" \
  --location eastus \
  --template-file infra/main.bicep \
  --parameters "infra/main.parameters.$ENV.json"
```

Record the outputs. You need `searchEndpoint`, `orchestratorFunctionAppName`,
`ingestionFunctionAppName` and `keyVaultUri`.

**Step 2 - Entra app registration (manual, once per environment).**

Create the app registration, expose an API with Application ID URI
`api://trialpulse-<env>`, and define six app roles with the exact values:
`regulatory_affairs`, `clinical_operations`, `medical_affairs`, `site_monitor`,
`executive`, `it_admin`. Add the Teams client ids as pre-authorised applications
for SSO. Then re-deploy with the real values:

```bash
az deployment sub create ... \
  --parameters entraTenantId="<tenant-id>" entraClientId="<app-id>"
```

The role *values* must match `ROLES` in `packages/shared/src/types.ts` exactly.
A mismatch is not a hard failure - `resolveRole` discards unrecognised strings -
so every affected user silently becomes a `site_monitor` with
`role_fallback_applied` set. Check for that after the first sign-ins:

```kql
customEvents | where name == "trialpulse.query"
| where tostring(customDimensions.role_fallback_applied) == "true"
| summarize count() by tostring(customDimensions.user_principal_name)
```

**Step 3 - create the search index.**

The index is owned by `ingestion/schema/search-index.json` and created by
`ingestion/scripts/create_index.py`, using the credential of whoever runs it (or
the ingestion managed identity). Confirm the schema file and the script's
arguments before running; this runbook does not restate them.

Verify:

```bash
az rest --method get \
  --url "$(az deployment sub show -n <name> --query properties.outputs.searchEndpoint.value -o tsv)/indexes/trialpulse-chunks?api-version=2024-07-01" \
  --resource "https://search.azure.com"
```

**Step 4 - register SharePoint webhooks.**

Use the `clientState` from Key Vault:

```bash
az keyvault secret show --vault-name <kv-name> --name sharepoint-client-state --query value -o tsv
```

Subscribe each monitored library to `POST https://<orchestrator-host>/api/webhooks/sharepoint`.
Graph webhook subscriptions expire; a renewal timer must be running before you
consider this step done.

**Step 5 - deploy application code.**

```bash
npm ci && npm run build
cd packages/orchestrator && func azure functionapp publish "<orchestratorFunctionAppName>"

cd ingestion && func azure functionapp publish "<ingestionFunctionAppName>"
```

**Step 6 - verify.**

```bash
curl -sS "https://<orchestrator-host>/api/health"
```

Then a single authenticated query as each of the six roles. If the `site_monitor`
query returns anything whose citation carries a classification other than
`site_communication`, stop and go to section 8.

### 1.2 Routine deployment

Application-only change: rebuild and `func azure functionapp publish`.
Infrastructure change: always `what-if` first and read the output. Deleting a
Cosmos container or a search service is not something to discover after the fact.

---

## 2. Roll back

### 2.1 Application code

Flex Consumption deploys a package to the `function-releases` blob container,
which has versioning enabled with a 30-day retention on prior versions
(`infra/modules/storage.bicep`). Fastest reliable rollback is to redeploy the
previous commit:

```bash
git checkout <previous-good-sha>
npm ci && npm run build
cd packages/orchestrator && func azure functionapp publish "<app-name>"
```

Verify `/api/health` and one query per role before standing down.

### 2.2 Infrastructure

There is no `az deployment rollback`. Redeploy the previous template:

```bash
git checkout <previous-good-sha> -- infra/
az deployment sub what-if --location eastus \
  --template-file infra/main.bicep --parameters "infra/main.parameters.$ENV.json"
```

Read the what-if output before applying. Bicep deployments are incremental, so a
resource removed from the template is **not** deleted - it lingers. That is
usually what you want during a rollback.

**Never roll back by deleting the resource group.** Key Vault has soft delete
(90 days) and, in prod, purge protection, so the name is unavailable for 90 days;
Cosmos DB and its audit trail would be destroyed.

### 2.3 Cosmos DB point-in-time restore

Continuous backup is enabled (7 days dev, 30 days prod). Restore creates a **new
account**; it does not restore in place.

```bash
az cosmosdb restore \
  --target-database-account-name "cosmos-trialpulse-$ENV-restored" \
  --account-name "<source-account>" \
  --restore-timestamp "2026-08-28T18:00:00Z" \
  --location eastus \
  --resource-group "$RG"
```

Then repoint `COSMOS_ENDPOINT` and grant the orchestrator identity a data-plane
role on the new account - the role assignment does **not** come across with the
restore. This is the step people forget.

---

## 3. Rotate secrets

The estate has exactly one secret. Everything else is managed identity.

### 3.1 SharePoint `clientState`

Rotating invalidates every existing webhook subscription, so re-register in the
same maintenance window.

```bash
NEW=$(openssl rand -base64 32)
az keyvault secret set --vault-name <kv-name> --name sharepoint-client-state --value "$NEW"
```

App settings use versionless Key Vault references, so no redeploy is needed -
but the running host caches the resolved value. Restart both apps:

```bash
az functionapp restart -g "$RG" -n "<orchestrator-app>"
az functionapp restart -g "$RG" -n "<ingestion-app>"
```

Then re-register every SharePoint subscription with the new value. Until you do,
inbound notifications fail validation and ingestion falls back to the daily sync
- degraded, not broken.

Do **not** pass the new value as a Bicep parameter and redeploy; that would
rotate it a second time.

### 3.2 Things that do not need rotating

Azure OpenAI, Azure AI Search and Cosmos DB all run with local auth disabled, and
storage has shared-key access disabled. There are no keys for these services. If
someone asks you to rotate one, the correct answer is that it does not exist -
and if it does exist, someone has re-enabled local auth and that is the incident.

---

## 4. Reindex

### 4.1 One document

```bash
curl -sS -X POST "https://<orchestrator-host>/api/admin/reindex" \
  -H "Authorization: Bearer <it_admin token>" \
  -H "Content-Type: application/json" \
  -d '{"document_id":"<sharepoint-item-id>"}'
```

This enqueues to `ingestion-work`. Because ingestion is idempotent (ADR 0003),
re-enqueuing an unchanged document costs a hash lookup per chunk.

### 4.2 Full corpus

Needed when the chunking algorithm changes, the embedding model version changes,
or the index schema changes. All three re-id or re-embed every chunk.

Before starting, decide whether this is a **rebuild in place** or a
**side-by-side swap**. Rebuild in place is simpler and leaves the index in a
mixed state while it runs, so queries during the window see a partially-updated
corpus. Side-by-side (create `trialpulse-chunks-v2`, backfill, flip
`AZURE_SEARCH_INDEX_NAME`, delete the old) costs an extra index's worth of
storage and quota and is the right choice for prod.

Then:

1. Raise the ingestion embedding capacity so the backfill finishes in hours:
   ```bash
   az deployment sub create ... --parameters embeddingIngestionCapacity=350
   ```
   Check quota first (section 9). This changes **only** the ingestion account -
   conversational capacity is on a separate account and is unaffected. That is
   the entire point of ADR 0005.
2. Kick off the backfill from `ingestion/scripts/`.
3. Watch throughput and the poison queue:
   ```bash
   az storage message peek --queue-name ingestion-work-poison \
     --account-name "<storage>" --auth-mode login --num-messages 10
   ```
4. Return `embeddingIngestionCapacity` to its baseline afterwards.

Budget: ~512M tokens for 1M chunks at 512 tokens each, about **$67** at
`text-embedding-3-large` list price. Announce it before you spend it - it is
roughly a quarter of the PRD's monthly target.

---

## 5. Drain the dead-letter queue

The Azure Functions queue trigger moves a message to `ingestion-work-poison`
after the retry policy is exhausted.

**Step 1 - measure.**

```bash
az storage queue stats --name ingestion-work-poison --account-name "<storage>" --auth-mode login
az storage message peek --queue-name ingestion-work-poison \
  --account-name "<storage>" --auth-mode login --num-messages 32 -o json
```

**Step 2 - find out why.** Do not replay blind.

```kql
traces
| where cloud_RoleName has "ingest"
| where severityLevel >= 3
| where timestamp > ago(24h)
| project timestamp, message, operation_Id
| order by timestamp desc
```

Common causes: a document type the extractor cannot parse; a document that no
longer exists in SharePoint (deleted between webhook and processing); an Azure
OpenAI 429 storm during a backfill; an expired or revoked Graph permission.

**Step 3 - act.**

- *Transient (429s, throttling, a dependency that was down):* fix the cause, then
  replay by re-enqueuing each message onto `ingestion-work`. Idempotency makes
  replay safe.
- *Permanent (unparseable document):* record the document id, delete the message,
  and file an issue. Do not leave it cycling.
- *Document no longer exists:* delete the message and confirm its chunks were
  tombstoned.

**Step 4 - close the loop.** A poison queue that filled up without anyone
noticing is the real finding. There is currently **no alert on poison queue
depth** - see `production-readiness-checklist.md`. Until there is, check it as
part of any ingestion investigation.

---

## 6. Respond to a cost alert

Two alerts can fire, and they mean different things.

| Alert | Source | Meaning |
|---|---|---|
| `alert-daily-model-cost` | orchestrator custom metric | Rolling 24h **model** spend above threshold. Fires within an hour. |
| Consumption budget | Azure billing | **Infrastructure + model** spend against the monthly budget. Lags by up to a day. |

**Step 1 - find where it went.**

```kql
customEvents
| where name == "trialpulse.query"
| where timestamp > ago(24h)
| extend cost = todouble(customMeasurements.estimated_cost_usd),
         role = tostring(customDimensions.role),
         model = tostring(customDimensions.model_used)
| summarize total = sum(cost), queries = count(), avg_cost = avg(cost)
    by role, model
| order by total desc
```

**Step 2 - classify.**

- *One role, many queries:* likely a script or a runaway client. Identify the UPN
  from the audit trail and talk to them.
- *Normal query count, high cost per query:* too much context per prompt. Check
  whether `maxChunks` or the chunk size changed.
- *`gpt-4o` share unexpectedly high:* check `model-router.ts` -
  `HIGH_REASONING_KEYWORDS` includes "safety" and "regulatory", which appear in a
  lot of legitimate clinical questions. This is the most likely benign
  explanation and also the most likely design flaw.
- *Cost concentrated in ingestion:* a backfill is running, or a chunking change
  triggered a full re-embed.

**Step 3 - contain.** Lower the hard cap so all non-executive traffic downgrades
to `gpt-4o-mini` (~17x cheaper):

```bash
az functionapp config appsettings set -g "$RG" -n "<orchestrator-app>" \
  --settings TRIALPULSE_DAILY_COST_CAP_USD=25
```

If it is a runaway client rather than organic growth, reduce
`functionMaximumInstanceCount` or temporarily disable the function app. **Be
explicit that this is an outage**, not a mitigation.

**Step 4 - a caveat you must know.** The daily model-cost alert depends on the
orchestrator emitting a custom metric whose name matches the `costMetricName`
parameter in `infra/modules/alerts.bicep` (default
`trialpulse.query.cost_usd`). That match has **not been verified against the
orchestrator's telemetry emitter**. If the alert has never fired and spend is
clearly non-zero, suspect the metric name before you conclude that costs are
fine:

```kql
customMetrics | where timestamp > ago(1d) | distinct name
```

---

## 7. Azure OpenAI quota exhausted

**Symptoms.** HTTP 429 from Azure OpenAI; P99 latency alert firing; the circuit
breaker tripping (3 consecutive failures, 5-minute cooldown); users reporting
timeouts. If only ingestion is failing, queries should be unaffected - the two
accounts are separate (ADR 0005). If both are failing, the problem is
subscription-level quota, not deployment capacity.

**Step 1 - distinguish rate limit from outage.**

```kql
dependencies
| where timestamp > ago(1h)
| where target has "openai"
| summarize count() by resultCode, bin(timestamp, 5m)
| order by timestamp desc
```

429 means quota. 5xx means service.

**Step 2 - check current allocation.**

```bash
az cognitiveservices account deployment list \
  -g "$RG" -n "<oai-tp-chat-...>" \
  --query "[].{name:name, capacity:sku.capacity}" -o table

az cognitiveservices usage list --location eastus -o table
```

**Step 3 - mitigate now.**

- Shift traffic to `gpt-4o-mini`, which usually has separate and larger quota:
  ```bash
  az functionapp config appsettings set -g "$RG" -n "<orchestrator-app>" \
    --settings TRIALPULSE_DAILY_COST_CAP_USD=1
  ```
  A cap of $1 keeps the downgrade permanently active. This is a deliberate abuse
  of the cost cap as a routing lever; note it in the incident so it gets undone.
- If ingestion is the cause, pause the backfill and lower
  `embeddingIngestionCapacity`.
- If there is regional headroom, raise the affected deployment's capacity by
  redeploying with a higher parameter. Remember the two accounts draw from the
  *same* subscription-level model quota (ADR 0005 consequences) - raising one may
  require lowering the other.

**Step 4 - the real fix.** Request a quota increase through the Azure portal
(Azure OpenAI -> Quotas). **PRD risk 4 puts this at 1-2 weeks.** It is not an
incident-time remedy; it is why capacity headroom belongs in the deployment plan.

---

## 8. Suspected RBAC leak - incident procedure

**This is the one incident TrialPulse exists to prevent.** Treat any credible
report as an S1 until disproved. A "credible report" includes: a user saying they
saw a document they did not expect; a citation whose `document_classification` is
outside the caller's allow-list; a non-zero count on the leakage detector below;
or the `no_authorized_documents` refusal reason appearing at all - that reason
means the post-retrieval tripwire fired, which means the search filter did not do
its job.

Do the steps in order. Step 2 before step 3.

### Step 1 - Contain (target: 15 minutes)

Decide whether to stop the service. The bias is towards stopping: a document
disclosure at a clinical-stage sponsor is not recoverable by apology.

```bash
# Full stop.
az functionapp stop -g "$RG" -n "<orchestrator-app>"
```

If the leak is scoped to one role and you can confirm that scope, a narrower
containment is to remove the affected users' Entra app role assignments. Do not
"fix" the filter in production first. Containment precedes diagnosis.

Leave the ingestion app running - it does not serve queries, and stopping it
loses nothing.

### Step 2 - Preserve the audit trail (before anything else)

The audit trail is both the investigation's only evidence and a mutable store
(threat model T4). Snapshot it first.

```bash
# 1. Note the exact UTC time. Continuous backup restore points depend on it.
date -u +%Y-%m-%dT%H:%M:%SZ

# 2. Export the relevant partitions. audit_logs is partitioned by /partition_date.
az cosmosdb sql container query ... # or the Data Explorer, exporting to JSON
```

```sql
SELECT * FROM c
WHERE c.partition_date >= '2026-08-25' AND c.partition_date <= '2026-08-28'
```

Store the export outside the TrialPulse resource group - a different storage
account, or a compliance share. Record who exported it and when.

Do **not** delete or edit any audit record. Do not redeploy infrastructure, which
could alter diagnostic settings and truncate what Log Analytics retained.

### Step 3 - Identify affected queries by trace id

Every answer carries a `trace_id` that joins the response, the audit record and
the Application Insights spans. Start from the reported one.

```sql
-- The reported query.
SELECT * FROM c WHERE c.trace_id = '<reported-trace-id>'
```

Read three fields: `entra_role` (what role was actually used),
`search_filter` (the exact OData filter sent), and `retrieved_chunks[]` (what
came back, with classifications and content hashes).

Then find every other query with the same defect:

```sql
-- Every query by this user in the window.
SELECT * FROM c
WHERE c.partition_date >= '2026-08-25'
  AND c.user_principal_name = '<upn>'
ORDER BY c.timestamp DESC
```

The leakage detector - **this is the query that defines the blast radius**:

```sql
SELECT c.trace_id, c.timestamp, c.user_principal_name, c.entra_role,
       c.search_filter, c.retrieved_chunks
FROM c
WHERE c.partition_date >= '2026-08-01'
  AND c.entra_role = 'site_monitor'
  AND ARRAY_LENGTH(
        ARRAY(SELECT VALUE r FROM r IN c.retrieved_chunks
              WHERE r.document_classification != 'site_communication')
      ) > 0
```

Repeat per role against its allow-list from ADR 0002. Also check for the
tripwire, which should never appear:

```sql
SELECT * FROM c WHERE c.refusal_reason = 'no_authorized_documents'
```

Cross-reference with traces:

```kql
union requests, dependencies, traces
| where operation_Id == "<trace-id>"
| order by timestamp asc
| project timestamp, itemType, name, resultCode, message, customDimensions
```

Produce a written list: trace ids, users, roles, document ids and classifications
disclosed, timestamps. That list is the incident's factual core and it is what
the notification in step 5 is based on.

### Step 4 - Root cause

Work through, in order of likelihood:

1. **Wrong classification at ingestion.** The filter worked; the chunk was
   mislabelled. Check the chunk's `document_classification` in the index against
   its SharePoint library. This is the most likely cause (threat model T1) and it
   is an ingestion bug, not a query bug.
2. **Filter construction.** Compare the `search_filter` on the audit record with
   what `buildSearchFilter()` should emit for that role. A mismatch is a code
   defect; write the failing case into `packages/shared/src/rbac.test.ts` first.
3. **Role resolution.** Was `entra_role` what the user should have had? Check
   `role_fallback_applied` and the user's actual Entra app role assignments -
   including stale ones (ADR 0002's least-privilege tie-break means extra roles
   *reduce* access, so an unexpectedly high privilege points at an assignment,
   not at a tie-break bug).
4. **A path that bypasses the filter.** Version comparison, the Browse tab's
   document list, the admin API. Every retrieval path must go through
   `buildSearchFilter`; find the one that does not.

### Step 5 - Notify

Timing and audience are Meridian's call, not the on-call engineer's. Escalate
immediately to: the IT administrator who owns TrialPulse, Meridian's compliance
officer, and the document owner for the disclosed classification. If the
disclosed material includes unblinded safety data or patient-identifiable
information, that is a regulatory notification decision and the compliance
officer owns it - **do not wait until the technical fix is ready to make that
call.**

Provide: the affected trace ids and users, the documents and classifications
disclosed, the exposure window, the root cause, and the containment taken.

### Step 6 - Remediate and reopen

1. Fix the root cause with a regression test that fails before the fix.
2. Add an RBAC-leakage case to the golden eval covering the specific defect.
3. Re-run the leakage detector queries over the full retention window to confirm
   the blast radius did not grow.
4. Restart the app and verify one query per role.
5. Write the post-incident review. If the defect was a mislabelled chunk, the
   review's action item is ingestion-time classification verification, which
   `production-readiness-checklist.md` already lists as missing.

---

## 9. Useful queries

**Latency distribution.**

```kql
requests
| where name == "POST /api/query" and timestamp > ago(24h)
| summarize p50 = percentile(duration, 50), p95 = percentile(duration, 95),
            p99 = percentile(duration, 99), count()
    by bin(timestamp, 1h)
| order by timestamp desc
```

**Refusal rate by role.** A sudden rise usually means an ingestion gap or a
classification change, not a model problem.

```kql
customEvents
| where name == "trialpulse.query" and timestamp > ago(7d)
| extend role = tostring(customDimensions.role),
         status = tostring(customDimensions.response_status)
| summarize refusals = countif(status == "refused"), total = count() by role
| extend refusal_rate = round(100.0 * refusals / total, 1)
```

**Cache hit rate.** Low hit rate means the shared cache is not in use and
embedding cost is higher than modelled.

```kql
customEvents
| where name == "trialpulse.query" and timestamp > ago(24h)
| extend hit = tobool(customDimensions.cache_hit)
| summarize hit_rate = round(100.0 * countif(hit) / count(), 1)
```

**Ingestion throughput against the PRD's 500 documents/day target.**

```kql
customEvents
| where name startswith "trialpulse.ingest" and timestamp > ago(24h)
| summarize count() by bin(timestamp, 1h)
```

Metric and event names above follow the naming the orchestrator and ingestion
telemetry modules are expected to use. **Confirm them against
`packages/orchestrator/src/` and `ingestion/trialpulse_ingest/telemetry.py`
before relying on any of these in an alert** - the same caveat as section 6 step 4.
