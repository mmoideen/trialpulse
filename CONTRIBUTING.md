# Contributing to TrialPulse

## Before you start

Read `TRIALPULSE-PRD.md`. It is the specification, and where this repository
disagrees with it, the disagreement is deliberate and documented in
`docs/adr/`.

Then read `docs/adr/0001-retrieval-scoped-rbac.md` and
`docs/adr/0002-rbac-model.md`. Most of the non-obvious constraints in this
codebase come from those two decisions.

## Setup

```bash
node --version    # 20 or newer
python3 --version # 3.11 for the ingestion pipeline

npm ci
npm run build     # @trialpulse/shared must be built before anything typechecks
npm run seed      # loads data/synthetic into the in-memory index
npm test
```

No Azure account, no secrets, no network. If a change breaks that, it is the
change that is wrong - see `docs/adr/0007-local-determinism.md`.

## Workspace ownership

| Path | Contains |
|---|---|
| `packages/shared` | types, RBAC policy, constants, cost table, hashing, injection heuristics |
| `packages/orchestrator` | query pipeline, auth, providers, local harness |
| `packages/teams-tab` | React personal tab |
| `ingestion/` | Python ingestion pipeline and the search index schema |
| `teams/` | Teams app manifest and declarative agent |
| `eval/` | golden query set and deterministic judges |
| `infra/` | Bicep templates |
| `docs/`, `.github/` | documentation and CI |

`packages/shared` is a published contract. Changing a type there is a breaking
change for every other workstream and should be its own pull request.

## The rules that are not negotiable

**1. RBAC is enforced in the search query.** Never post-filter. If you add a
retrieval path, it goes through `buildSearchFilter(role)`. If you think you have
a case where post-filtering is fine, read ADR 0001 and then discuss it before
writing code.

**2. No caller-controlled string reaches the OData filter.** Every literal comes
from `DOCUMENT_CLASSIFICATIONS`.

**3. Fail closed.** An empty allow-list matches nothing. An unrecognised filter
shape throws. An unrecognised role downgrades to `site_monitor`. If you find
yourself writing a fallback that widens access, stop.

**4. No general-knowledge fallback.** If no chunk clears the relevance
threshold, refuse through `refusal.ts`. Do not add a "helpful" branch that
answers anyway. ADR 0004.

**5. Every answer path writes an audit record** with the role, the filter and the
retrieved chunk ids.

**6. Ingestion stays idempotent.** Content hashing is what makes the daily sync
affordable. If you change chunking or normalisation, you have changed every
chunk id in the corpus - say so in the pull request and read the reindex
procedure in `docs/runbook.md`.

**7. Hash normalisation is implemented twice and must stay in lockstep.**
`packages/shared/src/hash.ts` and `ingestion/trialpulse_ingest/hashing.py`.
`ingestion/tests/test_hash_parity.py` is the guard. Do not weaken it.

## Testing expectations

| Change | Minimum |
|---|---|
| Anything in `rbac.ts` | a case in `rbac.test.ts` per affected role, plus an eval RBAC-leakage case |
| A new retrieval path | proof it uses `buildSearchFilter`; an eval case exercising it as every role |
| Prompt or generation | run `npm run eval` and paste the gate deltas into the PR |
| Chunking, normalisation, hashing | `test_hash_parity.py` still passes; state the reindex impact |
| Bicep | `az bicep build` and `az bicep lint` with **zero** diagnostics, plus `python3 infra/scripts/validate-parameters.py` |
| A new Azure resource | tagged, has a diagnostic setting, and the identity that uses it got the narrowest role that works |

## Style

- `.editorconfig` is authoritative for whitespace.
- TypeScript is `strict`, with `noUncheckedIndexedAccess`. Do not loosen
  `tsconfig.base.json` to make a change compile.
- Python is checked with `ruff`.
- Comments explain *why*. The code already says what.
- No secrets, no real tenant ids, no real email addresses. Placeholders use
  `example.com`. `gitleaks` runs in CI and its config is `.gitleaks.toml`.

## Documentation

- An architectural decision gets an ADR in `docs/adr/`, in Nygard format. ADRs
  are immutable once accepted - supersede, do not edit.
- A change to an operational procedure updates `docs/runbook.md`.
- A new or closed attack surface updates `docs/threat-model.md`.
- A claim in documentation must be true of the code as written. If something is
  planned rather than built, say "planned".

## Pull requests

Use the template. The security and evaluation sections are not decoration - a
reviewer will ask about anything left unticked without an explanation.

Keep pull requests scoped to one workstream where possible. `packages/shared`
changes fan out to everyone and deserve their own review.

## Security

`SECURITY.md`. Do not open a public issue for a vulnerability.
