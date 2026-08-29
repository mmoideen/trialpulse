# 0002. Six Entra app roles, classification allow-lists, and least-privilege tie-breaking

- **Status:** Accepted
- **Date:** 2026-08-28
- **Source:** PRD sections 2.2, 3.1, decision 1; implemented in `packages/shared/src/rbac.ts`

## Context

The PRD defines six Entra app roles and, for each, a set of document classes and
a redaction rule. Roles come from the `roles` claim on the caller's JWT; there is
no local role database, which means TrialPulse cannot repair, normalise or
override what Entra says. Whatever the token asserts is what we act on.

Turning the PRD's table into executable policy surfaced three problems that had
to be decided rather than guessed.

### Problem 1: the PRD contradicts itself about the site monitor's classification

Three places in the PRD describe the same thing differently.

| Location | What it says |
|---|---|
| Decision 1 (section 2.3) | "A `site_monitor` role gets `document_classification eq 'site_level'`" |
| Role table (section 3.1) | `site_monitor` -> document classes: `site_communications` |
| Library list (section 2.2) | SharePoint library `Site Communications/` |

`site_level` appears exactly once, in a sentence whose purpose is to illustrate
filter syntax rather than to define the vocabulary. The other two references
agree with each other, agree with the SharePoint library that is the source of
truth for classification, and agree with the naming pattern of every other
classification (`protocol`, `safety_report`, ... - all named after the document
kind, none named after an access level).

### Problem 2: singular and plural are mixed

Section 3.1 lists `investigator_brochures`, `safety_reports`,
`site_communications` (plural) and `competitive_intelligence` (singular, because
it is a mass noun). Section 4.2's example chunk uses `"document_classification":
"protocol"` (singular). A field whose values are sometimes plural and sometimes
not is a bug generator: `eq 'safety_report'` silently matches nothing.

### Problem 3: what happens when a token carries several roles

The PRD says what to do when a caller has *no* recognised role (treat as
`site_monitor`, log a warning) and is silent on the far more common real-world
case: an Entra token carrying two or more app roles. This happens routinely -
someone moves from clinical operations to medical affairs and the old assignment
is never removed; a contractor is granted `site_monitor` for an audit and also
holds `clinical_operations` from a previous engagement.

## Decision

### The six roles

| App role | Allowed classifications | Filter emitted | Redaction |
|---|---|---|---|
| `regulatory_affairs` | all six | none (unrestricted) | none |
| `clinical_operations` | all except `competitive_intelligence` | 5-clause disjunction | none |
| `medical_affairs` | `investigator_brochure`, `safety_report`, `competitive_intelligence` | 3-clause disjunction | safety reports aggregated; no patient identifiers |
| `site_monitor` | `site_communication` | single clause | site identifiers masked unless the site is in the caller's `sites` claim |
| `executive` | all six | none (unrestricted) | summary only; no verbatim document text |
| `it_admin` | all six | none (unrestricted) | every answer watermarked `ADMIN ACCESS` |

Note that `executive` and `it_admin` are *unrestricted at retrieval* and
restricted at generation. Retrieval-scoped RBAC (ADR 0001) is the mechanism for
classification boundaries; it is the wrong mechanism for "you may know the
conclusion but not read the paragraph". Those roles are handled in
`packages/orchestrator/src/pipeline/redaction.ts` and by a directive in the
system prompt, and the redaction applied is recorded on the audit record.

### Resolution of Problem 1: the classification is `site_communication`

`site_level` was a drafting artefact in an illustrative sentence. The canonical
value is `site_communication`, matching the SharePoint library, the section 3.1
role table, and the naming convention of every other classification.

This is not a cosmetic choice. Had we implemented `site_level`, the ingestion
pipeline would have stamped chunks with `site_communication` (derived from the
library name) while the orchestrator filtered on `site_level`, and every
`site_monitor` query would have returned zero results. The system would have
failed closed - safe, but completely non-functional, and the cause would have
been a one-word inconsistency in a spec.

### Resolution of Problem 2: classifications are singular

The vocabulary is frozen in `DOCUMENT_CLASSIFICATIONS` in
`packages/shared/src/types.ts`:

```
protocol, investigator_brochure, regulatory_submission,
safety_report, site_communication, competitive_intelligence
```

Singular throughout. A classification names *a document*, not a collection of
them. The Python ingestion pipeline and the TypeScript orchestrator both derive
from this list, and `ingestion/tests/test_constants_drift.py` exists to catch the
two copies drifting apart.

### Resolution of Problem 3: a multi-role token resolves to the LEAST privileged role

`resolveRole()` ranks recognised roles on this ascending privilege order:

```
site_monitor < executive < medical_affairs < clinical_operations < it_admin < regulatory_affairs
```

and selects the lowest. Unrecognised strings in the claim are ignored; if
nothing is recognised, the caller is treated as `site_monitor` and
`role_fallback_applied` is set on the audit record.

The reasoning is about who reviewed what. An Entra app role assignment is a
deliberate act by an administrator, but a *combination* of assignments is
usually not - it is the residue of two separate decisions taken at different
times by different people. Choosing the maximum means TrialPulse would grant an
access level that nobody ever approved, assembled by our own tie-break rule.
Choosing the minimum means the worst case is that a legitimately-promoted user
sees too little and files a ticket, at which point an administrator removes the
stale assignment - which is the correct remediation anyway.

The ordering itself is worth reading carefully, because it is not simply
"breadth of corpus":

- `executive` ranks *below* `medical_affairs` despite having an unrestricted
  retrieval filter, because its redaction policy suppresses verbatim document
  text entirely. In terms of what a caller can actually extract, summary-only
  access to everything is less than full-text access to three classifications.
- `it_admin` ranks below `regulatory_affairs` because its answers are
  watermarked, which makes any use of that access visible in a screenshot.

Reasonable people could rank `executive` and `medical_affairs` the other way. The
ordering is a single array in `rbac.ts` with a comment, so if Meridian's compliance
officer disagrees it is a one-line change with a test, not a refactor.

## Consequences

**Good**

- The policy is one frozen object. Reading `ROLE_POLICIES` tells you the entire
  access model, and `rbac.test.ts` asserts every role's filter and allow-list.
- Multi-role tokens have a defined, conservative, logged behaviour instead of
  depending on Entra's claim ordering.
- Because the classification vocabulary is shared across both languages and
  drift-tested, the class of bug where ingestion writes one spelling and query
  filters on another is closed.

**Bad, or at least costly**

- Least-privilege tie-breaking will produce support tickets. A user promoted
  into `regulatory_affairs` who still holds `site_monitor` gets site
  communications only, and the failure looks like a broken product rather than a
  stale role assignment. Mitigation: the audit record and the response both
  carry the effective role, and the Teams tab shows a role badge, so the
  diagnosis is immediate. The alternative failure mode - silently granting
  access - is invisible until an auditor finds it.
- `executive` and `it_admin` depend on generation-time behaviour. A prompt-level
  instruction is a weaker control than an index filter. `redaction.ts` enforces
  what it can deterministically (stripping verbatim quotes, applying the
  watermark), but "summarise, do not quote" is ultimately something a model
  complies with rather than something the architecture guarantees. This is a
  documented residual risk in `docs/threat-model.md`.
- `site_monitor` is the default for unrecognised roles *and* the most
  restrictive real role. A misconfigured Entra app role therefore looks exactly
  like a correctly-configured site monitor from the outside. The
  `role_fallback_applied` flag on the audit record is the only distinguisher,
  which is why it exists.

## Open question for Meridian

The PRD's Executive Briefing Mode (feature 3.2.5) offers a "drill down" link
"visible only to less-restricted roles". Under this model `executive` already has
the broadest classification allow-list, so "less restricted" must mean "less
redacted" - the drill-down is meaningful for `regulatory_affairs` and
`clinical_operations`, not for the executive who is looking at it. The intended
behaviour when an executive clicks their own drill-down link needs a product
decision.

The current implementation resolves it conservatively: `buildRedactionNotice` in
`packages/orchestrator/src/pipeline/redaction.ts` acknowledges an executive's
`drill_down` request and still returns the summary view, with the notice
"Drill-down detail is only available to roles with document-level access."
The link is therefore an affordance for sharing a question onward to a colleague
with a less-redacted role, not an escalation path for the executive. That reading
is defensible but it is an interpretation, and it should be confirmed with the
product owner before the executive persona is demonstrated.
