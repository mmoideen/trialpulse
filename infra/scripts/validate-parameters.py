#!/usr/bin/env python3
"""Validate infra/main.parameters.*.json against the compiled ARM template.

Bicep checks the template. Nothing checks the parameter files: a typo in a
parameter name is silently ignored by ARM at deploy time, so a `searchSKU`
instead of `searchSku` produces a deployment that quietly uses the default. This
script closes that gap offline, with no Azure subscription required.

It asserts, for every environment parameter file:
  * every supplied parameter name exists on the template
  * every template parameter without a default is supplied
  * supplied values match the declared type
  * supplied values fall inside @allowed / @minValue / @maxValue constraints
  * no parameter file contains a value for a @secure() parameter
And for the template itself:
  * every parameter carries an @description

Usage:  python3 infra/scripts/validate-parameters.py
Exit:   0 on success, 1 on any finding.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = REPO_ROOT / "infra" / "main.bicep"
PARAM_FILES = sorted((REPO_ROOT / "infra").glob("main.parameters.*.json"))

TYPE_MAP = {
    "string": str,
    "securestring": str,
    "int": int,
    "bool": bool,
    "array": list,
    "object": dict,
    "secureobject": dict,
}


def compile_template() -> dict:
    """Compile main.bicep to ARM JSON using whichever Bicep CLI is available."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "main.json"
        if shutil.which("bicep"):
            cmd = ["bicep", "build", str(TEMPLATE), "--outfile", str(out)]
        elif shutil.which("az"):
            cmd = ["az", "bicep", "build", "--file", str(TEMPLATE), "--outfile", str(out)]
        else:
            print("error: neither `bicep` nor `az` is on PATH", file=sys.stderr)
            raise SystemExit(2)

        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stdout, file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            print("error: bicep build failed", file=sys.stderr)
            raise SystemExit(2)
        if result.stderr.strip():
            print("error: bicep build emitted diagnostics:", file=sys.stderr)
            print(result.stderr, file=sys.stderr)
            raise SystemExit(2)
        return json.loads(out.read_text())


def main() -> int:
    if not PARAM_FILES:
        print("error: no infra/main.parameters.*.json files found", file=sys.stderr)
        return 1

    arm = compile_template()
    spec = arm["parameters"]
    findings: list[str] = []

    undocumented = [
        name for name, p in spec.items() if not p.get("metadata", {}).get("description")
    ]
    for name in undocumented:
        findings.append(f"main.bicep: parameter '{name}' has no @description")

    secure_params = {
        name for name, p in spec.items() if p["type"].lower().startswith("secure")
    }

    for path in PARAM_FILES:
        label = path.name
        try:
            doc = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            findings.append(f"{label}: is not valid JSON ({exc})")
            continue

        supplied = doc.get("parameters", {})

        for name in sorted(set(supplied) - set(spec)):
            findings.append(f"{label}: parameter '{name}' does not exist on main.bicep")

        for name in sorted(name for name, p in spec.items() if "defaultValue" not in p):
            if name not in supplied:
                findings.append(
                    f"{label}: required parameter '{name}' has no default and is not supplied"
                )

        for name in sorted(secure_params & set(supplied)):
            findings.append(
                f"{label}: parameter '{name}' is @secure() and must never be committed "
                f"to a parameters file"
            )

        for name, entry in sorted(supplied.items()):
            if name not in spec:
                continue
            declared = spec[name]
            if "value" not in entry:
                findings.append(f"{label}.{name}: entry has no 'value' key")
                continue
            value = entry["value"]

            expected = TYPE_MAP.get(declared["type"].lower())
            if expected is None:
                findings.append(f"{label}.{name}: unhandled parameter type {declared['type']}")
            elif expected is int and isinstance(value, bool):
                findings.append(f"{label}.{name}: expected int, got bool")
            elif not isinstance(value, expected):
                findings.append(
                    f"{label}.{name}: expected {declared['type']}, got {type(value).__name__}"
                )
                continue

            allowed = declared.get("allowedValues")
            if allowed is not None and value not in allowed:
                findings.append(f"{label}.{name}: {value!r} is not one of {allowed}")

            if isinstance(value, int) and not isinstance(value, bool):
                if "minValue" in declared and value < declared["minValue"]:
                    findings.append(
                        f"{label}.{name}: {value} is below minValue {declared['minValue']}"
                    )
                if "maxValue" in declared and value > declared["maxValue"]:
                    findings.append(
                        f"{label}.{name}: {value} is above maxValue {declared['maxValue']}"
                    )

            if isinstance(value, str):
                if "minLength" in declared and len(value) < declared["minLength"]:
                    findings.append(
                        f"{label}.{name}: shorter than minLength {declared['minLength']}"
                    )
                if "maxLength" in declared and len(value) > declared["maxLength"]:
                    findings.append(
                        f"{label}.{name}: longer than maxLength {declared['maxLength']}"
                    )

    if findings:
        print(f"FAIL: {len(findings)} finding(s)")
        for finding in findings:
            print(f"  - {finding}")
        return 1

    names = ", ".join(p.name for p in PARAM_FILES)
    print(
        f"PASS: main.bicep exposes {len(spec)} documented parameters; "
        f"{names} validated against them."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
