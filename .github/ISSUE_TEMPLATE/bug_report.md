---
name: Bug report
about: Something in TrialPulse behaves incorrectly
title: '[bug] '
labels: bug
assignees: ''
---

## Summary

<!-- One sentence. -->

## Severity

- [ ] **S1 - access boundary.** A user saw content their role is not permitted
      to see, or a citation points at a document outside their allow-list.
      Stop and follow the RBAC-leak procedure in `docs/runbook.md` before
      filing anything else here.
- [ ] S2 - wrong answer, forged or broken citation, or a refusal on a question
      that is clearly answerable from the corpus
- [ ] S3 - degraded latency, cost or ingestion throughput
- [ ] S4 - cosmetic or documentation

## Trace id

<!--
Every response carries a trace_id. It joins the answer to its audit record in
Cosmos DB and to the request/retrieve/generate spans in Application Insights.
Without it this issue is much harder to investigate.
-->

`trace_id:`

## Role and environment

- Effective role (from the answer's role badge): <!-- e.g. site_monitor -->
- Surface: <!-- Teams chat / personal tab / local dev server -->
- Environment: <!-- local / dev / prod -->
- Commit or version:

## Question asked

<!--
Paste the question verbatim. Do NOT paste confidential document text or any
patient-identifiable information into a GitHub issue. If the document content is
essential, reference the document id and section instead.
-->

## What happened

## What you expected

## Reproduction

1.
2.
3.

- [ ] Reproducible against the synthetic corpus in `data/synthetic/`
- [ ] Only reproducible against real SharePoint content

## Additional context

<!-- Screenshots with any document text redacted, related trace ids, timing. -->
