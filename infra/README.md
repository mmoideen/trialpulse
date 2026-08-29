# TrialPulse infrastructure (Bicep)

Infrastructure as code for the TrialPulse Azure estate. Written against
`TRIALPULSE-PRD.md` sections 2, 8 and 9.

> **Status: never deployed.** These templates compile and lint cleanly with the
> Bicep CLI, and the parameter files are machine-checked against the compiled
> template's parameter contract. No Azure subscription has been provisioned, so
> nothing here has been validated against a live ARM control plane. Treat the
> first `az deployment sub what-if` as the real test.

## Scope

`main.bicep` targets **subscription scope**. It creates the resource group and
then deploys every module into it. The alternative (resource-group scope, with
the group created out of band) was rejected because it moves the group name,
region and tags out of source control and into whatever an operator types into
`az group create`.

Nothing is granted at subscription scope. Every role assignment in
`modules/rbac.bicep` is scoped to one individual resource.

## Layout

```
infra/
  main.bicep                    subscription-scope entry point
  main.parameters.dev.json      dev environment
  main.parameters.prod.json     prod environment
  bicepconfig.json              linter configuration (most rules promoted to error)
  modules/
    monitoring.bicep            Log Analytics + workspace-based Application Insights
    keyvault.bicep              RBAC-authorised Key Vault, one secret
    storage.bicep               queues, deployment container, audit archive + lifecycle
    search.bicep                Azure AI Search
    cosmos.bicep                Cosmos DB NoSQL, 5 containers, continuous backup
    openai.bicep                reusable Azure OpenAI account + deployments
    function-app.bicep          reusable Flex Consumption function app + plan
    function-app-settings.bicep app settings, applied after RBAC
    rbac.bicep                  every data-plane role assignment
    alerts.bicep                action group, 3 alert rules, consumption budget
```

## What gets created

| Resource | Name pattern | Notes |
|---|---|---|
| Resource group | `rg-trialpulse-<env>` | |
| Log Analytics | `log-trialpulse-<env>-<token>` | daily ingestion cap set |
| Application Insights | `appi-trialpulse-<env>-<token>` | workspace-based |
| Key Vault | `kv-tp-<env>-<token>` | RBAC auth, one secret |
| Storage | `sttp<env><token>` | queues + audit archive + deployment container |
| Azure AI Search | `srch-trialpulse-<env>-<token>` | `disableLocalAuth: true` |
| Cosmos DB | `cosmos-trialpulse-<env>-<token>` | continuous backup, `disableLocalAuth: true` |
| Azure OpenAI (chat) | `oai-tp-chat-<env>-<token>` | `gpt-4o`, `gpt-4o-mini`, `text-embedding-3-large-query` |
| Azure OpenAI (ingest) | `oai-tp-embed-<env>-<token>` | `text-embedding-3-large` |
| Function app (orchestrator) | `func-tp-orch-<env>-<token>` | Node 20, Flex Consumption |
| Function app (ingestion) | `func-tp-ingest-<env>-<token>` | Python 3.11, Flex Consumption |

`<token>` is `substring(uniqueString(subscription().id, environmentName, location), 0, 8)`.
It is deterministic: redeploying the same environment into the same subscription
updates the same resources rather than creating a parallel estate.

Every resource carries the tags `app`, `env`, `owner`, `costCenter` and
`dataClassification`.

## Design decisions worth knowing before you read the templates

**Two Azure OpenAI accounts, not one.** PRD decision 4 requires that ingestion
cannot starve user queries. Separate *deployments* would give separate TPM
buckets, but the orchestrator also needs to embed the user's query, and if that
shares a deployment with the ingestion backfill the starvation is back. Two
accounts give separate rate-limit surfaces *and* make the isolation enforceable
with RBAC: the ingestion identity holds no role on the conversational account
and cannot call a generation model at all. See `docs/adr/0005-separate-model-deployments.md`.

Caveat: Azure OpenAI quota is granted per subscription, per region, per model.
Splitting into two accounts splits one quota pool; it does not create more of it.

**Flex Consumption, not Consumption.** Chosen for: identity-based deployment
storage (no storage key or SAS anywhere), per-instance memory and concurrency
control, an explicit `maximumInstanceCount` that acts as a denial-of-wallet
guardrail, always-ready instances to keep cold starts out of the P99 in prod,
and first-class Python 3.11 / Node 20 support. Flex Consumption hosts exactly
one function app per plan, so each app has its own plan.

**No keys anywhere that can be avoided.** `disableLocalAuth: true` on Azure
OpenAI, Azure AI Search and Cosmos DB; `allowSharedKeyAccess: false` on storage.
`AZURE_OPENAI_API_KEY`, `AZURE_SEARCH_API_KEY` and `COSMOS_KEY` are all optional
in the orchestrator's config and are never set.

That leaves exactly one secret in the vault:

| Secret | Why it exists |
|---|---|
| `sharepoint-client-state` | SharePoint hands this value back on every change notification. It is a shared secret by protocol design and cannot be replaced by a token. |

It is delivered as a versionless Key Vault reference
(`@Microsoft.KeyVault(SecretUri=.../secrets/<name>/)`), so rotating a secret does
not require a redeployment.

**Query embedding cache runs on Cosmos DB, not Redis.** PRD section 9 recommends
Azure Cache for Redis, but the orchestrator's `CacheProvider` implementation
(`packages/orchestrator/src/providers/azure/azure-cache.ts`) uses a Cosmos DB
container with per-item TTL instead. This decision — the rationale, consequences
and reversibility — is documented in `docs/adr/0008-embedding-cache-store.md`.
The Cosmos DB container `cache_entries` is created with `defaultTtl: -1` (TTL
disabled at the container level; expiry is per-item). Redis has been removed
entirely: no `redis.bicep`, no `REDIS_CONNECTION_STRING` app setting, and no
idle $16/month spend.

**One known incompatibility with the ingestion code.** The storage account is
deployed with `allowSharedKeyAccess: false`, so there is no connection string
for anything to use. Azure Functions queue triggers and output bindings are fine
- the host handles the identity-based `AzureWebJobsStorage__accountName`
connection. But `ingestion/function_app.py`'s timer-driven delta sync builds its
own client with `QueueClient.from_connection_string(os.environ["AzureWebJobsStorage"], ...)`,
which will raise `KeyError` on a deployed app and would fail on authentication
even if the variable existed.

The fix is one line in the ingestion pipeline, not a change to this template:

```python
QueueClient(account_url=os.environ["AZURE_STORAGE_QUEUE_ACCOUNT_URL"],
            queue_name=INGEST_QUEUE_NAME,
            credential=DefaultAzureCredential())
```

`AZURE_STORAGE_QUEUE_ACCOUNT_URL` is already set on the ingestion app for
exactly this. Re-enabling shared-key access would also make it work, and would
trade a structural security property for a line of code, which is the wrong
trade. Tracked in `docs/production-readiness-checklist.md`.

**App settings are applied after RBAC.** A Key Vault reference in an app setting
only resolves once the app's identity holds Key Vault Secrets User. Creating the
app and its settings in one resource produces a first deployment where the
reference is permanently broken until someone restarts the app. Hence
`function-app-settings.bicep`, ordered after `rbac`.

**`audit_logs` has no TTL.** Deliberate. Automatic expiry would let a failed
archive job silently destroy records that must survive seven years. Deletion
happens only after the compaction job confirms the write to Blob Archive.

## Not created here

| Thing | Owner | Why not |
|---|---|---|
| Entra app registration and the six app roles | Identity admin | Identity configuration, not infrastructure. Needs admin consent, which is a human decision. |
| The `trialpulse-chunks` search index | `ingestion/schema/search-index.json` | The ingestion pipeline owns the index schema; duplicating field definitions in Bicep guarantees they drift. The `Search Service Contributor` role assignment exists so the pipeline can create it. |
| SharePoint webhook subscriptions | Ingestion pipeline | Registered against the Graph API using the `clientState` from Key Vault. |
| Private endpoints and VNet integration | Future work | Every service is deployed with `publicNetworkAccess: Enabled`. See `docs/threat-model.md`. |
| Power BI workspace for the cost dashboard (PRD 2.1) | Not built | The Teams tab Dashboard covers the same requirement. |
| The audit-archive compaction job (Cosmos `audit_logs` → Parquet → Blob Archive, confirm-then-delete from Cosmos) | Not built | `AUDIT_ARCHIVE_CONTAINER` is an orchestrator app setting read by no code today, and `AUDIT_ARCHIVE_AFTER_DAYS` / `AUDIT_RETENTION_YEARS` are declared and never referenced anywhere. `modules/cosmos.bicep`'s "Deletion happens only after the archive job has confirmed the Parquet write to Blob Archive" describes a job that does not exist yet — today nothing ever deletes from `audit_logs` (which is correct and safe by default, since TTL is deliberately off there) and nothing ever writes to the `audit-archive` container. `modules/storage.bicep`'s `enableAuditArchiveImmutability` protects whatever eventually lands in that container; it does not create the job that lands anything there. |

## App settings contract

The app settings in `main.bicep` are not invented; they are read back from the
application code and must stay in sync with it. The source of truth is:

- orchestrator: `packages/orchestrator/src/config.ts` (`loadConfig`)
- ingestion: `ingestion/trialpulse_ingest/` (`sharepoint.py`, `indexing.py`, `embedding.py`)

Two details are easy to get wrong and are worth stating explicitly:

1. The two apps use **different names for the Azure OpenAI endpoint**. The
   orchestrator reads `AZURE_OPENAI_ENDPOINT`; the ingestion pipeline reads
   `AZURE_OPENAI_EMBEDDING_ENDPOINT`. They are pointed at different accounts,
   which is the whole point of PRD decision 4, so the differing names are
   helpful rather than accidental.
2. `AZURE_OPENAI_EMBEDDING_DEPLOYMENT` has the **same name but a different
   value** on each app: the orchestrator gets the query-sized deployment on the
   conversational account, ingestion gets the high-throughput deployment on the
   ingestion account.

`TRIALPULSE_AUTH_MODE` and `TRIALPULSE_LOCAL_DEV` are deliberately never set.
Both are switches into a non-authenticating or in-memory mode, and the safest
value for a deployed environment is "absent".

## Entra identity: one value, three places

The audience the orchestrator enforces on every inbound JWT and the resource
the Teams manifest advertises for SSO are **the same value**, and nothing in
this repository (or in Azure) keeps them in sync automatically. It exists in
exactly three places, and all three must be updated together whenever it
changes:

1. **The TrialPulse Entra app registration's Application ID URI**, configured
   under that app's "Expose an API" blade in the Azure/Entra portal. This is
   the source of truth; it takes the shape
   `api://<tab-domain>/<application-client-id>` (e.g.
   `api://trialpulse-tab.azurewebsites.net/11111111-1111-1111-1111-111111111111`).
   A Teams SSO token's `aud` claim is always exactly this URI — never a
   made-up string like `api://trialpulse-dev`, and never the scope URI
   (`.../access_as_user`) that sits underneath it.
2. **`teams/manifest/manifest.json`'s `webApplicationInfo.resource`** — must
   equal (1) exactly, with no scope suffix appended. See `teams/README.md`
   "Entra app registration mapping" for the placeholder substitution
   (`${{TAB_DOMAIN}}`, `${{AAD_APP_CLIENT_ID}}`) and why the scope suffix is a
   distinct, separate value.
3. **`entraApiAudience`** in `infra/main.parameters.dev.json` and
   `infra/main.parameters.prod.json` — flows through `main.bicep` into the
   orchestrator's `ENTRA_AUDIENCE` app setting, which
   `packages/orchestrator/src/config.ts` reads into `EntraConfig.audience`
   and the JWT verifier (`jwtVerify(..., { audience })`) enforces on every
   request. Both parameter files ship this as a
   `api://REPLACE_WITH_TAB_DOMAIN/REPLACE_WITH_AAD_APP_CLIENT_ID` placeholder
   of the correct shape precisely so it cannot be deployed unmodified without
   the mismatch being obvious; it must be replaced with the real value from
   (1) before deploying, per environment (dev's app registration and prod's
   are different apps with different Application ID URIs).

If any one of these three drifts from the other two, every tab and bot
request 401s: the client retries once with a fresh token, gets 401 again, and
the user sees "Your session expired. Please sign in again." indefinitely,
because the token was never going to validate no matter how many times it is
refreshed — the audience the orchestrator wants and the audience Entra issues
are simply different strings. This is the exact failure mode this section
exists to prevent from recurring.

## Prerequisites

- Azure CLI 2.60 or newer with the Bicep CLI (`az bicep install`)
- A subscription where you hold `Contributor` **and** `User Access Administrator`
  (role assignments are part of the deployment)
- Azure OpenAI access approved on the subscription, with quota in the target
  region for `gpt-4o`, `gpt-4o-mini` and `text-embedding-3-large`

## Deploy

```bash
# Preview
az deployment sub what-if \
  --location eastus \
  --template-file infra/main.bicep \
  --parameters infra/main.parameters.dev.json

# Apply
az deployment sub create \
  --name "trialpulse-dev-$(date +%Y%m%d%H%M)" \
  --location eastus \
  --template-file infra/main.bicep \
  --parameters infra/main.parameters.dev.json
```

Supply a stable `sharePointClientState` once webhooks are registered, otherwise
every deployment rotates it and invalidates the existing subscriptions:

```bash
CLIENT_STATE=$(cat clientstate.txt)
az deployment sub create ... --parameters "sharePointClientState=$CLIENT_STATE"
```

Deployment outputs (endpoints, function app names, managed identity object ids)
are what the post-deployment steps in `docs/runbook.md` consume.

## Validate locally

```bash
az bicep build --file infra/main.bicep --stdout > /dev/null   # types + syntax
az bicep lint  --file infra/main.bicep                         # linter rules
```

Both must produce no output. `bicepconfig.json` promotes `no-unused-params`,
`no-unused-vars`, `secure-parameter-default`, `outputs-should-not-contain-secrets`
and `prefer-interpolation` to errors.

Note that Bicep's type checker only validates properties the resource type
definition models. A few values here are typed as free strings by ARM and are
therefore only checked at deployment time: the search
`semanticSearch` tier and Azure OpenAI model names and versions. Model
availability in a given region also cannot be checked offline.

## Cost

`docs/cost-model.md` works the numbers. Short version: the dev parameter file
targets roughly $110-130/month idle, the prod file roughly $390-420/month at 500
queries/day, and the PRD's `< $300/month` goal (section 10) is not reachable at
the prod search tier. The two dials that matter are `searchSku`/`searchReplicaCount`
and the share of traffic routed to `gpt-4o` rather than `gpt-4o-mini`.
