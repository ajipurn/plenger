# Reports and CI

The public CLI starts the dashboard and updates the package. It does not expose
scan or report commands. The dashboard exports saved scans as JSON.
The static report engine and GitHub Action remain available separately.
See [../STATUS.md](../STATUS.md) for qualification evidence.

## Report engine

The static engine supports JSON, SARIF 2.1.0 and Markdown reports.
Reports contain parsed and skipped files, inventory, capabilities, findings,
source evidence, coverage and rule definitions. Facts can be included per file.
Locations use 1-based lines and UTF-16 columns. Known secrets are redacted.

Contributors use scan(), createReport() and the formatters in src/report.
JSON contracts are generated from the source:

- [report-v1.schema.json](../../schemas/report-v1.schema.json)
- [baseline-v1.schema.json](../../schemas/baseline-v1.schema.json)
- [suppressions-v1.schema.json](../../schemas/suppressions-v1.schema.json)

SARIF uses repository-relative paths. Critical/high findings have level error,
medium warning and low note. Findings include security severity, CWE/OWASP tags,
confidence and stable fingerprints. A completed scan is not proof of safety:
syntax errors, skipped files and incomplete traces can leave gaps.

## Baselines and suppressions

The GitHub Action accepts explicit baseline and suppression files.
It never loads policy files automatically.

A baseline records rule, relative path and fingerprint:

```json
{
  "schemaVersion": 1,
  "findings": [
    { "fingerprint": "0123456789abcdef", "rule": "PLG101", "path": "src/tools.py" }
  ]
}
```

Fingerprints survive checkout relocation and unrelated line edits. Renaming
a file or subject can create a new finding. Take the fingerprints of reviewed
findings from a SARIF upload (`partialFingerprints`, key `plenger/v1`) or the
job summary. Matched findings are unchanged;
others count as new. An explicit baseline does not suppress a finding.

Suppressions need a reason and a fingerprint or known rule id:

```json
{
  "schemaVersion": 1,
  "suppressions": [
    { "fingerprint": "0123456789abcdef", "reason": "Reviewed proxy validation" },
    { "rule": "PLG502", "path": "test/**/*.py", "reason": "Intentional test fixtures" }
  ]
}
```

Selectors combine with AND and the first match supplies the reason. Paths are
relative to the scan root, with * within a segment and ** across segments.
Policies are bounded to 4 MiB. Invalid rules, versions, selectors and duplicate
baseline fingerprints fail validation.

A plenger-ignore comment names one or more rules on the same line, or the
following line when the comment stands alone:

```python
# plenger-ignore PLG801 reviewed: host is checked by the proxy
subprocess.run(f"ping -c 1 {host}", shell=True)
```

Suppression file entries take precedence over comments. The report engine
records inSource and external suppressions distinctly. The dashboard shows
every static finding; it does not hide findings using source comments.

## GitHub Action

The root [action.yml](../../action.yml) installs lockfile-pinned runtime
dependencies with install scripts disabled. scripts/github-action.ts calls the
static engine directly, without the public launcher or any registry update check.
It reads source without importing the target or installing its dependencies.

Inputs are:

| Input | Default | Purpose |
| --- | --- | --- |
| path | . | File or folder under the workspace |
| fail-on | high | Cumulative severity threshold, or none |
| baseline | empty | Explicit baseline file |
| suppressions | empty | Explicit suppression file |
| sarif-file | plenger.sarif | Output inside the workspace |
| gitignore | true | Respect target ignore files |
| source-root | . | Repository root used for SARIF paths |
| include-suppressed | false | Include suppressed findings in SARIF |

The Action scans once and writes SARIF, a Markdown job summary and the
sarif-file and exit-code outputs before a finding gate failure.
GitHub does not honor SARIF suppressions, so they are omitted from the upload
by default. The summary retains the review counts.

| Exit | Meaning |
| --- | --- |
| 0 | Scan completed and gate passed or was disabled |
| 1 | Scan or file I/O error |
| 2 | Invalid input or policy |
| 3 | New unsuppressed findings met the severity threshold |

Use the action from a checkout of this repository, pinned to a reviewed revision.
The repository's own CI tests the local action with contents: read permission.
Uploading SARIF is a separate workflow step and follows
[GitHub's SARIF upload documentation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file).
