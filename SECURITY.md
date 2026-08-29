# Security policy

TrialPulse enforces document access boundaries for a clinical trial sponsor. A
security defect here is not a bug that leaks a session token - it is a defect
that can disclose unblinded safety data or regulatory correspondence to someone
who was never authorised to see it.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Report privately to Meridian's IT administrator, or through GitHub's private
vulnerability reporting if it is enabled on this repository. Include:

- what you observed and how to reproduce it
- the affected role or roles, if it is an access-control issue
- a `trace_id` if you have one - it joins the response to the audit record and
  to the Application Insights spans
- your assessment of impact

We will acknowledge within two business days and give a remediation timeline
after triage.

**Do not include real document content, real patient-identifiable information or
a captured access token in a report.** Reference document ids and section
headings instead.

## Severity

| Severity | Definition | Response |
|---|---|---|
| **S1** | A user obtained content outside their role's allow-list; the RBAC filter was bypassed; or authentication was bypassed | Immediate. Follow `docs/runbook.md` section 8 - contain first, preserve the audit trail second, diagnose third. |
| **S2** | Forged or misattributed citations; a redaction rule not applied; secret exposure | Same-day triage |
| **S3** | Denial of service or denial of wallet | Next business day |
| **S4** | Information disclosure with no cross-role impact; hardening opportunity | Backlog |

Anything that lets one role read another role's documents is S1 regardless of how
difficult it is to trigger.

## What is in scope

The orchestrator, the ingestion pipeline, the Teams tab and agent, the Bicep
templates and the CI configuration in this repository. In particular:

- the RBAC filter path (`packages/shared/src/rbac.ts` and every caller)
- JWT validation (`packages/orchestrator/src/auth/jwt.ts`)
- prompt injection, including payloads embedded in **document content** rather
  than in a user's question
- citation integrity (`packages/orchestrator/src/pipeline/citations.ts`)
- redaction (`packages/orchestrator/src/pipeline/redaction.ts`)
- role assignments and resource configuration in `infra/`

Out of scope: Microsoft 365, Entra ID and Azure platform services themselves;
report those to Microsoft.

## Known gaps

`docs/threat-model.md` documents every threat we are aware of, with what is
mitigated and what is not. The unmitigated items are summarised at the end of
that document and repeated on `docs/production-readiness-checklist.md`. Reporting
one of those is still useful - a working exploit changes the priority - but it is
not news.

The largest known gaps, stated plainly:

- no ingestion-time scanning of document content for prompt injection
- the audit store is mutable by the same identity that writes to it
- no per-user rate limiting
- no destination check or telemetry on the Teams "Share in channel" affordance
- all service data planes are on public endpoints

## Secrets

If you believe a secret has been committed:

1. Assume it is compromised. Rotate it first - `docs/runbook.md` section 3.
2. Then remove it from history.
3. Then work out how it got past `gitleaks` and fix the rule in `.gitleaks.toml`.

Rotation before removal, every time. Git history rewriting is slow and a
published secret is live the whole time you are doing it.

## Contact

Meridian IT administrator. Replace this line with a monitored security address
before the repository is shared beyond the build team.
