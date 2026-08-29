## What changed

<!-- One paragraph. What does this PR do, and why now? -->

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Infrastructure / CI
- [ ] Documentation
- [ ] Refactor with no behaviour change

## Security and compliance checklist

TrialPulse enforces document access boundaries for a clinical trial sponsor.
Anything ticked below that you cannot honestly tick needs a reviewer comment
explaining why.

- [ ] No change to how the Azure AI Search `$filter` is constructed, **or** the
      change is covered by a test in `packages/shared/src/rbac.test.ts` and an
      RBAC-leakage case in the eval suite.
- [ ] No user-controlled string reaches the OData filter expression.
- [ ] Every new query path writes an audit record with the role, the filter and
      the retrieved chunk ids.
- [ ] No secret, tenant id, real user principal name or real document content is
      added to the repository. `gitleaks` passing is necessary, not sufficient.
- [ ] Redaction rules for `medical_affairs`, `site_monitor` and `executive`
      still hold for any new response path.
- [ ] New Azure resources are tagged, have a diagnostic setting, and the
      identity that uses them received the narrowest role that works.

## Evaluation

- [ ] `npm run eval` passes locally
- [ ] Gate deltas (paste the summary line, including any threshold that moved):

```
<!-- paste eval summary -->
```

## Documentation

- [ ] An ADR was added or amended if this changes an architectural decision
- [ ] `docs/runbook.md` updated if this changes an operational procedure
- [ ] `docs/threat-model.md` updated if this adds or closes an attack surface

## How this was tested

<!-- Commands run, roles exercised, what you checked by hand. -->
