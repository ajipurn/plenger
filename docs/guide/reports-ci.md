# Reports and CI

## Report formats

```sh
plenger scan project --format json --output scan.json
plenger scan project --format sarif --output scan.sarif
plenger scan project --format markdown --output report.md
plenger scan project/src --format sarif --source-root project --output scan.sarif
```

Terminal is the default format. `--all` shows every active finding there;
JSON, SARIF and Markdown always contain every finding, including suppressed and
baseline findings. Output files use UTF-8, omit ANSI colours and are overwritten
when requested. Parent directories are created. SARIF paths and Markdown source
links are relative to the scan root, or to `--source-root` when given: pass the
repository root there when scanning a subdirectory, because GitHub code scanning
resolves SARIF paths from the repository root. The source root must contain the
scanned path. JSON locations and baselines always stay relative to the scan root.
`--omit-suppressed` leaves suppressed findings out of every format; the `review`
counts still include them.

The JSON report has `schemaVersion: 1`, tool metadata, the scan root, parsed and
skipped files, excluded directories, inventory, findings, the rules that fired,
duration and review counts. `facts` uses the same contract, with code facts in
each parsed file. Locations use 1-based lines and UTF-16 columns; end positions
are exclusive. Recognised credentials remain redacted in every format, including
source snippets and suppression reasons: known key formats, private key blocks,
credentials written out (`password: ...`) and every literal API key passed to a
model client, whatever its format. Text copied from source (snippets, prompts, code
facts) also hides quoted strings that look generated (long, random, mixing upper
case, lower case and digits); identifiers, model names and environment variable
names stay readable, and plenger's own titles and messages are never rewritten
except for those known secrets.

The complete contracts are:

- [report-v1.schema.json](../../schemas/report-v1.schema.json)
- [baseline-v1.schema.json](../../schemas/baseline-v1.schema.json)
- [suppressions-v1.schema.json](../../schemas/suppressions-v1.schema.json)

Changes incompatible with these contracts require a new schema version. Duration
varies between runs, and the root is the local absolute path. All other output is
deterministic for the same sources and policy. Rule definitions accompany only the
rules that fired; `plenger rules --json` gives the entire catalog separately.

SARIF follows [OASIS SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/schemas/sarif-schema-2.1.0.json).
It includes source regions, evidence as related locations and as a code flow (the
path code scanning lets you step through), remediation, OWASP/CWE tags, severity,
confidence, triage score, exposure and `plenger/v1` partial fingerprints.
Critical/high findings use level `error`, medium `warning` and low `note`. Code
scanning reads `security-severity` from the rule, not the result, so findings rated
below their rule's highest severity are reported under a descriptor for their
severity: a low PLG302 finding has rule id `PLG302/low` (with `properties.rule:
"PLG302"`) and security severity 2.0 instead of the rule's 7.0. A finding whose
rating changes therefore moves to another rule id. Source URIs are relative to
`%SRCROOT%`, the source root; its absolute path is not written, so reports can be
shared without revealing the local checkout path. Coverage warnings are in the
SARIF invocation and run properties. A completed static scan is not proof of safety: syntax errors,
truncation, skipped files and incomplete handler traces can leave gaps. Finding gates do not turn those gaps
into findings; inspect coverage as part of review.

## Baselines

```sh
plenger scan project --write-baseline plenger-baseline.json
plenger scan project --baseline plenger-baseline.json --fail-on high
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
plenger scan project --suppressions plenger-suppressions.json --fail-on high
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
in SARIF with accepted external suppressions. GitHub code scanning does not honour
SARIF suppressions and would show those findings as open alerts, so the Action
leaves them out of the SARIF it writes (`include-suppressed: true` keeps them); with
the CLI, use `--omit-suppressed` for a SARIF file meant for GitHub. Terminal output omits their details
and shows the count. Unknown fields, malformed JSON, unsupported versions, unknown
suppression rules and invalid selectors fail instead of silently weakening the
gate. Policy files are limited to 4 MiB. Additional semantic checks, such as known
rule ids and unique fingerprints, are enforced by the CLI beyond the JSON schemas.

### Comments in the source

A `plenger-ignore` comment suppresses the findings of the rules it names on its
own line or the line below, with the rest of the comment as the reason:

```python
# plenger-ignore PLG801 reviewed: the host comes from the admin form behind SSO
subprocess.run(f"ping -c 1 {host}", shell=True)
```

```ts
await readFile(target); // plenger-ignore PLG802, PLG104 paths are checked by the proxy
```

A comment names one or more rule ids; one without a rule id suppresses nothing. A
suppression file entry for the same finding wins over a comment. SARIF marks a
comment's suppression `inSource`, a file's `external`. `--no-inline-suppressions`
reports the findings comments suppress, for an audit of every comment.

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

The root [action.yml](../../action.yml) is a composite action. It installs the
scanner's lockfile-pinned runtime dependencies with install scripts disabled,
then reads the target source without installing or executing that target. Its
inputs are `path` (default `.`), `fail-on` (default `high`), optional `baseline` and
`suppressions`, `sarif-file` (default `plenger.sarif`), `gitignore` (default
`true`), `source-root` (default `.`, the repository root that SARIF paths are
relative to; set it when the repository is checked out into a subdirectory) and
`include-suppressed` (default `false`). Paths are workspace-relative; the SARIF
output must stay inside the workspace and the scanned path inside `source-root`.
The Action and this repository's CI pin third-party actions to commit SHAs. The action scans once, writes SARIF, appends a Markdown job summary and
sets `sarif-file` and `exit-code` outputs before a finding-gate failure. Job-summary
links for targets inside the repository point to source at the scanned GitHub
commit. Oversized job summaries are
replaced by counts, with full details retained in SARIF.

This workflow uses the action from this repository's checkout. For another
repository, check out the scanner at a pinned revision in a separate directory
and use that directory as the local action path. Publication is part of M8.

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
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0
      - uses: ./
        id: plenger
        with:
          path: src
          fail-on: high
          # baseline: plenger-baseline.json
          # suppressions: plenger-suppressions.json
      - uses: github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2 # v4.38.2
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
