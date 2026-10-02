# Reports and CI

## Report formats

```sh
pnpm dev scan project --format json --output scan.json
pnpm dev scan project --format sarif --output scan.sarif
pnpm dev scan project --format markdown --output report.md
```

Terminal is the default format. `--all` shows every active finding there;
JSON, SARIF and Markdown always contain every finding, including suppressed and
baseline findings. Output files use UTF-8, omit ANSI colours and are overwritten
when requested. Parent directories are created. Markdown source links are relative
to the scan root, so keep the report at that root when using its relative links.

The JSON report has `schemaVersion: 1`, tool metadata, the scan root, parsed and
skipped files, excluded directories, inventory, findings, the rules that fired,
duration and review counts. `facts` uses the same contract, with code facts in
each parsed file. Locations use 1-based lines and UTF-16 columns; end positions
are exclusive. Recognised credentials remain redacted in every format, including
source snippets and suppression reasons.

The complete contracts are:

- [report-v1.schema.json](../schemas/report-v1.schema.json)
- [baseline-v1.schema.json](../schemas/baseline-v1.schema.json)
- [suppressions-v1.schema.json](../schemas/suppressions-v1.schema.json)

Changes incompatible with these contracts require a new schema version. Duration
varies between runs, and the root is the local absolute path. All other output is
deterministic for the same sources and policy. Rule definitions accompany only the
rules that fired; `plenger rules --json` gives the entire catalog separately.

SARIF follows [OASIS SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json).
It includes source regions, evidence as related locations, remediation, OWASP/CWE
tags, severity, confidence, triage score, exposure and `plenger/v1` partial
fingerprints. Critical/high findings use level `error`, medium `warning` and low
`note`. Source URIs are encoded relative to `%SRCROOT%`, whose base is the scan's
absolute file URI. Coverage warnings are in the SARIF invocation and run
properties. A completed static scan is not proof of safety: syntax errors,
truncation and skipped files can leave gaps. Finding gates do not turn those gaps
into findings; inspect coverage as part of review.

## Baselines

```sh
pnpm dev scan project --write-baseline plenger-baseline.json
pnpm dev scan project --baseline plenger-baseline.json --fail-on high
```

A baseline is a review snapshot of every detected finding, including suppressed
ones. Commit it after reviewing the report. Generating or refreshing it does not
change the current scan's gate; `--baseline` explicitly selects the comparison.
No policy files are loaded automatically.

```json
{
  "schemaVersion": 1,
  "findings": [
    { "fingerprint": "0123456789abcdef", "rule": "PLG101", "path": "src/tools.py" }
  ]
}
```

Fingerprints are based on rule, root-relative path and subject, rather than line
numbers or the absolute checkout directory. Use the same scan root for comparison.
Moving the checkout and adding unrelated lines preserve a match; renaming a file
or subject can create a new finding. Repeated findings with identical keys have
source-ordered occurrence numbers, so inserting such a duplicate can change their
matches. Removed findings disappear from the report; unused baseline entries have
no effect. Duplicate baseline fingerprints are rejected.

Matched findings gain `baselineState: "unchanged"`; other findings gain `"new"`.
Without a baseline, all findings count as new and omit `baselineState`.
The `review` counters describe overlapping sets: `active + suppressed` is the
total, and `new + unchanged` is the total. An unchanged finding may be active or
suppressed.

## Suppressions

```sh
pnpm dev scan project --suppressions plenger-suppressions.json --fail-on high
```

```json
{
  "schemaVersion": 1,
  "suppressions": [
    { "fingerprint": "0123456789abcdef", "reason": "Reviewed: proxy validates this input" },
    { "rule": "PLG502", "path": "test/**/*.py", "reason": "Intentional test credential fixtures" }
  ]
}
```

Each entry needs a fingerprint or a known rule id and a nonblank reason of at most
1000 characters. Optional selectors combine with AND: a fingerprint plus a rule
plus a path must all match. The first matching entry supplies the reported reason.
Paths are relative to the scan root, use forward slashes and cannot contain `..`.
`*` matches within a path segment; `**` matches across segments; `**/` also matches
zero directories. Other characters are literal; there is no negation or regex
syntax. A rule without a path suppresses every finding of that rule, so prefer a
fingerprint or a narrow path where possible.

Suppressed findings remain in JSON and Markdown with `suppression.reason`, and
in SARIF with accepted external suppressions. Terminal output omits their details
and shows the count. Unknown fields, malformed JSON, unsupported versions, unknown
suppression rules and invalid selectors fail instead of silently weakening the
gate. Policy files are limited to 4 MiB. Additional semantic checks, such as known
rule ids and unique fingerprints, are enforced by the CLI beyond the JSON schemas.

## CI gate and exit codes

`--fail-on high` fails for new, unsuppressed high or critical findings. Thresholds
are cumulative: `critical`, `high`, `medium`, `low`; `none` disables the gate and is
the CLI default. Confidence affects triage order but does not bypass the severity
gate. Reports are written before evaluating the finding gate.

| Exit | Meaning |
| --- | --- |
| 0 | Scan completed; finding gate passed or was disabled |
| 1 | Scan or file I/O error |
| 2 | Invalid command line or malformed policy |
| 3 | New unsuppressed findings met the severity threshold |

## GitHub Action

The root [action.yml](../action.yml) is a composite action. It installs the
scanner's lockfile-pinned runtime dependencies with install scripts disabled,
then reads the target source without installing or executing that target. Its
inputs are `path` (default `.`), `fail-on` (default `high`), optional `baseline` and
`suppressions`, `sarif-file` (default `plenger.sarif`) and `gitignore` (default
`true`). Paths are workspace-relative; the SARIF output must stay inside the
workspace. The action scans once, writes SARIF, appends a Markdown job summary and
sets `sarif-file` and `exit-code` outputs before a finding-gate failure. Job-summary
links for targets inside the repository point to source at the scanned GitHub
commit. Oversized job summaries are
replaced by counts, with full details retained in SARIF.

This workflow uses the action from this repository's checkout. For another
repository, check out the scanner at a pinned revision in a separate directory
and use that directory as the local action path. Publication is part of M6.

```yaml
name: Agent security
on: [push, pull_request]
permissions:
  contents: read
  actions: read
  security-events: write
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./
        id: plenger
        with:
          path: src
          fail-on: high
          # baseline: plenger-baseline.json
          # suppressions: plenger-suppressions.json
      - uses: github/codeql-action/upload-sarif@v4
        if: ${{ !cancelled() && steps.plenger.outputs.sarif-file != '' }}
        with:
          sarif_file: ${{ steps.plenger.outputs.sarif-file }}
          category: plenger
```

The upload step runs after gate failure when a report exists, and requires the
repository to support code scanning. Private/internal repositories need GitHub
Code Security enabled; permissions and upload behavior follow
[GitHub's SARIF upload documentation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file).
The repository's own CI requires only `contents: read` and tests the Action
without depending on code-scanning availability.
