# TrialPulse

Teams-native clinical document intelligence for Meridian Therapeutics.

> **Everything here is fictional.** Meridian Therapeutics, the AXIOM-HN01 and
> AXIOM-HN02 studies, revarafusp alfa, torilizumab, every trial site, every
> investigator and every document in `data/synthetic/` are invented for this
> project. There is no real patient data, no real trial data, and no
> confidential information from any company. This is a reference implementation
> built to a product spec, not a system that has ever run against a live tenant
> - see [What this repository is, and is not](#what-this-repository-is-and-is-not).

TrialPulse answers natural-language questions about Meridian's clinical document
corpus - protocols, investigator brochures, regulatory submissions, safety
reports, site communications, competitive intelligence - directly inside
Microsoft Teams. Every answer carries a citation to the source document and
page. Access boundaries are enforced at the search engine, so a site monitor
cannot retrieve unblinded safety data even in principle, and every question,
retrieved chunk, redaction decision and token cost is written to an audit trail.

It runs entirely inside Meridian's existing Microsoft 365 tenant: Entra ID for
identity, SharePoint Online for documents, Azure OpenAI for embedding and
generation. No new authentication system, no new vendor, no data leaving the
tenant.

`TRIALPULSE-PRD.md` is the source specification. Where this repository
deliberately diverges from it - and it does, in a few places - the reasoning is
in `docs/adr/`.

---

## Architecture at a glance

```
Microsoft Teams (declarative agent + personal tab)
        |  Entra ID access token
        v
Orchestrator Function App  (TypeScript, Node 20, Flex Consumption)
        |  1. validate JWT: signature, issuer, audience, tenant
        |  2. resolve effective role (least privilege on a multi-role token)
        |  3. build an OData $filter from the role
        |  4. embed the query (Cosmos DB cache, key scoped by role)
        |  5. hybrid search -- the engine never returns a forbidden chunk
        |  6. threshold at cosine 0.72
        |  7. refuse, or redact -> route model -> generate -> validate citations
        |  8. write the audit record
        v
Azure AI Search  <---  Ingestion Function App (Python 3.11, Flex Consumption)
        ^                     ^  SharePoint webhooks + daily catch-up sync
        |                     |  content-hashed, idempotent, version-aware
        v                     |
Cosmos DB (audit)       SharePoint Online
```

Two Azure OpenAI accounts, not one: the ingestion pipeline and the
conversational path have separate rate-limit surfaces *and* separate
authorisation scopes, so a corpus backfill cannot starve user queries and a
compromised ingestion pipeline cannot call a generation model at all.

`docs/architecture.md` has the full diagrams and a component-by-component
description.

---

## Repository layout

```
packages/shared/        types, RBAC policy, constants, cost table, hashing,
                        injection heuristics -- the cross-workstream contract
packages/orchestrator/  query pipeline, auth, HTTP functions, Azure and
                        in-memory providers, local harness
packages/teams-tab/     React personal tab: Ask, Browse, Dashboard
ingestion/              Python ingestion pipeline, search index schema, tests
teams/                  Teams app manifest and declarative agent definition
eval/                   golden query set and deterministic judges
data/synthetic/         fabricated clinical corpus for local dev and tests
infra/                  Bicep templates, one per resource, dev/prod parameters
docs/                   ADRs, threat model, runbook, cost model, evaluation
.github/                CI, CodeQL, Dependabot, PR and issue templates
```

The security-critical file is `packages/shared/src/rbac.ts`. It holds the role
policies, the filter builder and the defence-in-depth authorisation check. Start
there.

---

## Prerequisites

- **Node.js 20 or newer** and npm 10+
- **Python 3.11** (only for the ingestion pipeline and its tests)
- Nothing else. No Azure subscription, no API keys, no network access beyond the
  package registries.

Optional, for infrastructure work:

- **Azure CLI 2.60+** with the Bicep CLI (`az bicep install`)
- **gitleaks** to reproduce the CI secret scan locally

---

## Run it locally, with zero Azure

Everything below works offline and produces the same result every time. That is
a design constraint, not a happy accident - see
`docs/adr/0007-local-determinism.md`.

```bash
# 1. Install
npm ci

# 2. Build the shared contract first -- the orchestrator and the tab both
#    consume it through its built dist/, so nothing typechecks until this runs.
npm run build --workspace @trialpulse/shared

# 3. Build everything
npm run build

# 4. Seed the in-memory index from data/synthetic/
npm run seed

# 5. Start the local dev server
npm run dev
```

The dev server runs the real query pipeline against in-memory providers. There
is no JWT to acquire: with `TRIALPULSE_AUTH_MODE=development` it accepts an
unsigned `x-dev-identity` header so you can be any role you like.

```bash
curl -sS http://localhost:7071/api/query \
  -H 'Content-Type: application/json' \
  -H 'x-dev-identity: {"upn":"dev@example.com","role":"regulatory_affairs"}' \
  -d '{"query":"What is the primary endpoint of AXIOM-HN01?"}' | jq

# The same question as a site monitor.
curl -sS http://localhost:7071/api/query \
  -H 'Content-Type: application/json' \
  -H 'x-dev-identity: {"upn":"monitor@example.com","role":"site_monitor"}' \
  -d '{"query":"What is the primary endpoint of AXIOM-HN01?"}' | jq
```

Run both and compare the `citations` arrays. That comparison is the product in
one screen:

- `regulatory_affairs` gets citations across `protocol`,
  `regulatory_submission` and `site_communication`, including
  *AXIOM-HN01 Protocol v4.0*.
- `site_monitor` gets citations from `site_communication` **only**, and the site
  codes in the document titles come back as `Site [SITE REDACTED] Protocol
  Deviation Notice` because that site is not in the caller's `sites` claim.

Note what does *not* happen: the site monitor is not told that a protocol exists
and was withheld. They get the best answer available inside their own boundary,
because the search engine never returned anything else.

That development bypass cannot be turned on in Azure: `loadConfig()` refuses to
start in development auth mode if it detects the Azure Functions host, and the
Bicep templates never set the variable.

### Run the evaluation suite

```bash
npm run eval
```

> **Status:** the golden query set and judges live in `eval/`, which is being
> built by a separate workstream and was empty at the time this README was
> written. The CI job is already wired to this command and **fails loudly** if
> the script or the directory is missing - it does not skip.

Runs the golden query set through the full pipeline against the deterministic
providers and reports the gates: retrieval MRR, citation accuracy, RBAC leakage
(threshold: exactly zero), refusal correctness, redaction correctness, and cost.
`docs/evaluation.md` explains what each gate measures and, just as importantly,
what it does not.

### Run the Teams tab

```bash
npm run dev --workspace @trialpulse/teams-tab
```

Vite dev server. It talks to the local orchestrator and uses a development
identity provider, so it renders in an ordinary browser without a Teams host.

---

## Tests

```bash
npm test                                     # all TypeScript workspaces
npm run test --workspace @trialpulse/shared  # RBAC, hashing, cost, injection
npm run typecheck                            # strict tsc across workspaces
```

Python:

```bash
python -m venv ingestion/.venv && source ingestion/.venv/bin/activate
pip install -r ingestion/requirements.txt
cd ingestion && PYTHONPATH=. python -m pytest -q
ruff check ingestion
```

Infrastructure:

```bash
az bicep build --file infra/main.bicep --stdout > /dev/null   # must print nothing
az bicep lint  --file infra/main.bicep                        # must print nothing
python3 infra/scripts/validate-parameters.py                  # parameter files vs template
```

Secret scan, the same one CI runs:

```bash
gitleaks detect --source . --config .gitleaks.toml --redact -v
```

CI (`.github/workflows/ci.yml`) runs five jobs on every push and pull request -
`node`, `python`, `eval`, `security`, `infra` - and needs no secrets, so a pull
request from a fork gets the same signal as a branch.

---

## Deploy to Azure

Read `infra/README.md` first; it covers the parameter reference, the app-settings
contract and what the templates deliberately do not create.

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

`main.bicep` is subscription-scoped and creates the resource group. You need
`Contributor` **and** `User Access Administrator`, because the deployment creates
role assignments.

Three things are deliberately not in the templates and must be done by hand: the
Entra app registration and its six app roles, creation of the
`trialpulse-chunks` search index (owned by
`ingestion/schema/search-index.json`), and SharePoint webhook registration. The
full sequence is in `docs/runbook.md` section 1.

---

## Documentation

| Document | What it is for |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System architecture, query and ingestion diagrams, components |
| [`docs/adr/`](docs/adr/README.md) | Seven architecture decision records, Nygard format |
| [`docs/threat-model.md`](docs/threat-model.md) | STRIDE over the real architecture, with residual risk stated for each threat |
| [`docs/runbook.md`](docs/runbook.md) | Deploy, roll back, rotate, reindex, drain the dead-letter queue, cost alerts, quota exhaustion, RBAC-leak incident procedure |
| [`docs/evaluation.md`](docs/evaluation.md) | The golden eval: gates, thresholds, and their limits |
| [`docs/cost-model.md`](docs/cost-model.md) | Worked cost estimate with the token arithmetic shown |
| [`docs/production-readiness-checklist.md`](docs/production-readiness-checklist.md) | Sign-off gate, including everything that is not met |
| [`infra/README.md`](infra/README.md) | Bicep layout, design decisions, deployment |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, the non-negotiable rules, testing expectations |
| [`SECURITY.md`](SECURITY.md) | Vulnerability reporting and severity definitions |

Worth reading in this order if you are new:
`docs/architecture.md` -> `docs/adr/0001-retrieval-scoped-rbac.md` ->
`docs/adr/0002-rbac-model.md` -> `packages/shared/src/rbac.ts`.

---

## What this repository is, and is not

**It is** a working implementation of the PRD: the orchestration pipeline, the
ingestion pipeline, the Teams surfaces, the infrastructure as code and the
operational documentation. The TypeScript workspaces typecheck under `strict`
with `noUncheckedIndexedAccess` and their test suites pass, the Python package
passes `ruff` and `pytest`, the Bicep compiles and lints with zero diagnostics,
and the local dev server answers role-scoped, cited questions against the
synthetic corpus.

**It is not deployed, and never has been.**

- **No Azure tenant or subscription has ever been provisioned for TrialPulse.**
  The Bicep templates compile and their parameter files are machine-validated
  against the compiled template, but no deployment has run. Any claim in this
  repository about infrastructure means "verified statically".
- **No Entra app registration exists.** The six app roles are defined in code and
  referenced throughout the documentation. No directory object backs them.
- **The corpus is synthetic.** `data/synthetic/` contains fabricated clinical
  documents about a fictional study. No real patient data, no real trial data, no
  confidential Meridian information. No real SharePoint library has been ingested.
- **The local providers are deterministic stand-ins, not the real services.** The
  in-memory embedding provider uses feature hashing, and the local relevance
  score is a calibrated blend of lexical coverage and a hashed-vector cosine -
  *not* a true embedding cosine. It is calibrated so the production 0.72
  threshold behaves sensibly locally. It cannot represent synonymy, so local
  retrieval numbers are a regression signal and not a prediction of production
  quality. `docs/adr/0007-local-determinism.md` states the gap in full.
- **The golden evaluation harness had not landed** when this README was written.
  `eval/` was empty; the CI job is wired and fails loudly rather than skipping.
  `docs/evaluation.md` documents the gates it will enforce.
- **Reconciling the templates against the application code turned up three
  integration gaps** that a deployment would have hit on its first request. They
  are listed in `docs/production-readiness-checklist.md` under "Three integration
  gaps found by reconciling the infrastructure against the code". `infra/scripts/validate-app-settings.py`
  runs in CI and validates that every environment variable read by the orchestrator
  and ingestion pipeline (including those read through `os.environ` outside of structured
  config modules) is declared in `main.bicep`'s app settings, catching configuration
  mismatches before deployment.
- **No load test, no security review, no clinical review.** The PRD's latency
  targets, the cost model and answer quality are all unmeasured against reality.
- **The PRD's `< $300/month` cost target is not achievable as specified.**
  `docs/cost-model.md` shows the arithmetic: roughly $417/month at 500
  queries/day on the search tier the PRD requires, and roughly $2,000/month at
  the 5,000 queries/day scale-up.

`docs/production-readiness-checklist.md` enumerates all of this with owners and
pass criteria. The honest summary: **do not deploy this to production.** It is
ready for a supervised pilot in a dev tenant with synthetic or non-sensitive
documents, and the checklist says exactly what would have to be true before it is
ready for anything more.

---

## Licence

Proprietary. See [`LICENSE`](LICENSE).
