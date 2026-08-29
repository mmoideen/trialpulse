#!/usr/bin/env python3
"""Cross-check the Bicep app settings against the environment variables the
application code actually requires.

This exists because of a real class of bug that nothing else catches. The
orchestrator and the ingestion pipeline are written by different people in
different languages, and the Bicep template that feeds them their configuration
is written by a third. A rename on either side produces a deployment that
succeeds, an app that starts, and a `ConfigError` on the first request - or,
worse, a silently-defaulted value.

What it does:
  * extracts every `readRequired(env, 'NAME', ...)` from the orchestrator's
    config.ts - the definitive list of what the app refuses to start without
  * ALSO extracts every direct `env['NAME']` / `process.env['NAME']` /
    `process.env.NAME` literal-key access anywhere under
    packages/orchestrator/src/**, skipping any access immediately followed by
    a `??` fallback. This is what closes the hole that let
    `TRIALPULSE_PROVIDER_MODE` (read directly in providers/index.ts, not via
    `readRequired`, and therefore invisible to this script) go completely
    unset in main.bicep while this script printed PASS. `readRequired`/
    `readOptional` themselves read via `env[key]` with a variable, not a
    string literal, so they are never double-counted by this second pass.
  * extracts every `os.environ["NAME"]` (subscript form, i.e. no default) from
    the ingestion pipeline: ingestion/*.py, ingestion/trialpulse_ingest/*.py
    AND ingestion/scripts/*.py (the last of these was previously missed
    entirely)
  * extracts the app-setting keys assigned to each function app in main.bicep
  * asserts the second set covers the first

It intentionally ignores optional reads (`readOptional`, `os.environ.get`, and
any direct access with an inline `??` fallback), because a missing optional is
a decision, not a defect. A variable read straight off `env`/`process.env`
with no fallback at all is, structurally, exactly as "required" as one gated
through `readRequired` -- the app's behaviour just silently forks on it
instead of throwing -- which is precisely the shape of the provider-mode bug
this script now catches.

Usage:  python3 infra/scripts/validate-app-settings.py
Exit:   0 on success, 1 on any finding.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
MAIN_BICEP = REPO_ROOT / "infra" / "main.bicep"
ORCHESTRATOR_CONFIG = REPO_ROOT / "packages" / "orchestrator" / "src" / "config.ts"
ORCHESTRATOR_SRC = REPO_ROOT / "packages" / "orchestrator" / "src"
INGESTION_DIR = REPO_ROOT / "ingestion"

SETTING_KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*(?:__[A-Za-z0-9_]+)?)\s*:")
READ_REQUIRED_RE = re.compile(r"readRequired\(\s*env\s*,\s*'([A-Z0-9_]+)'")
OS_ENVIRON_REQUIRED_RE = re.compile(r"""os\.environ\[\s*["']([A-Z0-9_a-z]+)["']\s*\]""")

# Matches `env['NAME']`, `process.env['NAME']`, `process.env["NAME"]` and
# `process.env.NAME` -- every shape of direct, literal-keyed environment
# access used outside the config.ts readRequired/readOptional convention.
# Deliberately does NOT match `env[key]`/`process.env[key]` (a variable, not a
# string literal): that is exactly the shape readRequired/readOptional use
# internally, and it is already covered by READ_REQUIRED_RE at its call sites.
DIRECT_ENV_ACCESS_RE = re.compile(
    r"""(?:process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]"""
    r"""|env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]"""
    r"""|process\.env\.([A-Z][A-Z0-9_]*))"""
    # Zero-width lookahead: must NOT consume the trailing characters, or
    # finditer's next scan position skips past the start of an immediately
    # adjacent access (e.g. `env['A'] || env['B']`), silently dropping it.
    r"""(?=(?P<tail>.{0,8}))""",
    re.DOTALL,
)

# Settings the Azure Functions host provides or consumes itself, which never
# appear in application source.
HOST_PROVIDED = {
    "AzureWebJobsStorage",
    "AzureWebJobsStorage__accountName",
    "APPLICATIONINSIGHTS_CONNECTION_STRING",
    "FUNCTIONS_WORKER_RUNTIME",
    "FUNCTIONS_EXTENSION_VERSION",
    "WEBSITE_INSTANCE_ID",
    "FUNCTIONS_WORKER_RUNTIME_VERSION",
}


def block_keys(text: str) -> set[str]:
    keys: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        match = SETTING_KEY_RE.match(stripped)
        if match:
            keys.add(match.group(1))
    return keys


def bicep_app_settings() -> dict[str, set[str]]:
    """Extract the app-setting key sets for each function app from main.bicep."""
    src = MAIN_BICEP.read_text()

    start = src.index("var commonSettings = {")
    common = block_keys(src[start : src.index("\n}\n", start)])

    result: dict[str, set[str]] = {}
    for module in ("orchestrator-settings", "ingestion-settings"):
        anchor = src.index(f"name: '{module}'")
        open_at = src.index("union(commonSettings, {", anchor)
        close_at = src.index("\n    })", open_at)
        result[module] = common | block_keys(src[open_at:close_at])
    return result


def direct_env_access_required(text: str) -> set[str]:
    """Names read via a literal-keyed `env[...]`/`process.env[...]`/
    `process.env.NAME` with no inline `??` fallback immediately after them."""
    names: set[str] = set()
    for match in DIRECT_ENV_ACCESS_RE.finditer(text):
        name = match.group(1) or match.group(2) or match.group(3)
        tail = match.group("tail")
        if "??" in tail:
            continue
        names.add(name)
    return names


def orchestrator_required() -> set[str]:
    if not ORCHESTRATOR_CONFIG.exists():
        print(f"error: {ORCHESTRATOR_CONFIG} not found", file=sys.stderr)
        raise SystemExit(2)
    if not ORCHESTRATOR_SRC.exists():
        print(f"error: {ORCHESTRATOR_SRC} not found", file=sys.stderr)
        raise SystemExit(2)

    names = set(READ_REQUIRED_RE.findall(ORCHESTRATOR_CONFIG.read_text()))
    for path in ORCHESTRATOR_SRC.rglob("*.ts"):
        names |= direct_env_access_required(path.read_text())
    return names


def ingestion_required() -> set[str]:
    names: set[str] = set()
    if not INGESTION_DIR.exists():
        return names
    paths = (
        list(INGESTION_DIR.glob("*.py"))
        + list((INGESTION_DIR / "trialpulse_ingest").glob("*.py"))
        + list((INGESTION_DIR / "scripts").glob("*.py"))
    )
    for path in paths:
        for name in OS_ENVIRON_REQUIRED_RE.findall(path.read_text()):
            if name.isupper() or "_" in name:
                names.add(name)
    return names


def main() -> int:
    settings = bicep_app_settings()
    findings: list[str] = []

    checks = (
        ("orchestrator", orchestrator_required(), settings["orchestrator-settings"]),
        ("ingestion", ingestion_required(), settings["ingestion-settings"]),
    )

    for label, required, supplied in checks:
        for name in sorted(required - supplied - HOST_PROVIDED):
            findings.append(
                f"{label}: requires {name!r} but main.bicep does not set it on the app"
            )
        print(
            f"{label}: {len(required)} required env var(s), "
            f"{len(supplied)} app setting(s) supplied"
        )

    if findings:
        print(f"\nFAIL: {len(findings)} finding(s)")
        for finding in findings:
            print(f"  - {finding}")
        return 1

    print("\nPASS: every required environment variable is supplied by main.bicep.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
