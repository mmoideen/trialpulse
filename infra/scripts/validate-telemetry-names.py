#!/usr/bin/env python3
"""Cross-check the metric/operation name strings `infra/modules/alerts.bicep`
alerts on against what `packages/orchestrator/src/` actually emits.

This exists because `infra/modules/alerts.bicep`'s `costMetricName` parameter
carries a comment that says it "MUST match the telemetry emitted by
packages/orchestrator" -- a promise nothing ever checked. The daily-cost alert
(PRD section 8.4's denial-of-wallet guardrail) reads a custom Application
Insights metric named by `costMetricName` via a KQL query
(`customMetrics | where name == "..."`), and the P99-latency / error-rate
alerts read `requests` filtered by `queryOperationName`. If the orchestrator
never emits a customMetric under that exact name, or the HTTP route's
operation name drifts from `queryOperationName`, the corresponding alert rule
still deploys successfully, still shows as "Enabled" in the portal, and never
fires -- for exactly the same "quiet at 3am" reason
`validate-app-settings.py` exists.

What it does:
  * extracts the default string values of `costMetricName` and
    `queryOperationName` from `infra/modules/alerts.bicep`
  * asserts each one appears verbatim, as a substring, somewhere in
    `packages/orchestrator/src/**/*.ts`

What it deliberately does NOT do: parse Bicep expressions. `main.bicep` does
not currently override either parameter when it instantiates the `alerts`
module (see the `module alerts 'modules/alerts.bicep' = { ... }` block) -- if
that ever changes, this script's `ALERTS_MODULE` extraction must be pointed at
the actual value flowing in, not the module's own default, or it will validate
the wrong string.

This check is expected to fail until `packages/orchestrator/src/functions/deps.ts`
gains a real Application Insights `TelemetrySink` that emits a customMetric
named `trialpulse.query.cost_usd` (today it uses `NoopTelemetry`, which
discards every span -- see docs/runbook.md and
docs/production-readiness-checklist.md). That failure is the point: it is the
one piece of evidence in CI that the denial-of-wallet alert is currently dead.

Usage:  python3 infra/scripts/validate-telemetry-names.py
Exit:   0 on success, 1 on any finding.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
ALERTS_MODULE = REPO_ROOT / "infra" / "modules" / "alerts.bicep"
ORCHESTRATOR_SRC = REPO_ROOT / "packages" / "orchestrator" / "src"

# Bicep params of the form: param NAME string = 'VALUE'
PARAM_DEFAULT_RE = re.compile(r"param\s+({name})\s+string\s*=\s*'([^']*)'")

# The alerts.bicep parameters whose default value must be traceable to
# something the orchestrator actually emits, and a short description of what
# each one names, used only for the failure message.
TRACKED_PARAMS = {
    "costMetricName": "Application Insights customMetric name (the daily model-cost alert's data source)",
    "queryOperationName": "Application Insights `requests` operation name (the P99-latency and error-rate alerts' data source)",
}


def alerts_module_defaults() -> dict[str, str]:
    if not ALERTS_MODULE.exists():
        print(f"error: {ALERTS_MODULE} not found", file=sys.stderr)
        raise SystemExit(2)
    text = ALERTS_MODULE.read_text()
    values: dict[str, str] = {}
    for name in TRACKED_PARAMS:
        match = re.search(PARAM_DEFAULT_RE.pattern.format(name=re.escape(name)), text)
        if match is None:
            print(
                f"error: could not find `param {name} string = '...'` in {ALERTS_MODULE}",
                file=sys.stderr,
            )
            raise SystemExit(2)
        values[name] = match.group(2)
    return values


def orchestrator_source_text() -> str:
    if not ORCHESTRATOR_SRC.exists():
        print(f"error: {ORCHESTRATOR_SRC} not found", file=sys.stderr)
        raise SystemExit(2)
    chunks: list[str] = []
    for path in ORCHESTRATOR_SRC.rglob("*.ts"):
        chunks.append(path.read_text())
    return "\n".join(chunks)


def main() -> int:
    defaults = alerts_module_defaults()
    haystack = orchestrator_source_text()
    findings: list[str] = []

    for name, description in TRACKED_PARAMS.items():
        value = defaults[name]
        print(f"{name} = {value!r} ({description})")
        if value not in haystack:
            findings.append(
                f"alerts.bicep `{name}` = {value!r} does not appear anywhere in "
                f"packages/orchestrator/src/ -- {description} that the alert reads "
                f"is never produced, so the alert can never fire"
            )

    if findings:
        print(f"\nFAIL: {len(findings)} finding(s)")
        for finding in findings:
            print(f"  - {finding}")
        return 1

    print("\nPASS: every alerts.bicep telemetry name is referenced in packages/orchestrator/src/.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
