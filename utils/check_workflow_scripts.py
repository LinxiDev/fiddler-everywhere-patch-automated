#!/usr/bin/env python3
"""Parse every `run:` script in the workflows with PowerShell's own parser.

GitHub Actions expression syntax (for example `startsWith(env.X, 'Yes')`) is
only valid in `if:` keys and `${{ }}` placeholders, never inside the script
body. This check extracts each run block and asks PowerShell to parse it, so
that mistake fails locally instead of in CI.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

# GitHub replaces ${{ ... }} before the script runs, so replace those with a
# token that is valid PowerShell to avoid false positives.
EXPRESSION = re.compile(r"\$\{\{[^}]*\}\}")

PWSH = sys.argv[1] if len(sys.argv) > 1 else "pwsh"
WORKFLOWS = sorted(Path(".github/workflows").glob("*.yml"))
PARSER = """param([string]$Path)
$errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$null, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
    $errors | ForEach-Object {
        Write-Output ('line ' + $_.Extent.StartLineNumber + ': ' + $_.Message)
    }
    exit 1
}
exit 0
"""


def iter_run_scripts(node, path=""):
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else str(key)
            if key == "run" and isinstance(value, str):
                yield here, value
            else:
                yield from iter_run_scripts(value, here)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from iter_run_scripts(value, f"{path}[{index}]")


def main() -> int:
    failures = 0
    checked = 0
    with tempfile.TemporaryDirectory() as tmp:
        parser_path = Path(tmp) / "parser.ps1"
        parser_path.write_text(PARSER, encoding="utf-8")
        for workflow in WORKFLOWS:
            data = yaml.safe_load(workflow.read_text(encoding="utf-8"))
            for location, script in iter_run_scripts(data):
                checked += 1
                script_path = Path(tmp) / "check.ps1"
                script_path.write_text(EXPRESSION.sub("__GHA_EXPR__", script), encoding="utf-8")
                result = subprocess.run(
                    [PWSH, "-NoProfile", "-File", str(parser_path), str(script_path)],
                    capture_output=True,
                    text=True,
                )
                if result.returncode != 0:
                    failures += 1
                    print(f"FAIL {workflow}:{location}")
                    for line in (result.stdout + result.stderr).strip().splitlines():
                        print(f"     {line}")
    print(f"checked {checked} run block(s), {failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
