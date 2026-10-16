# Claude security assessments

`plenger assess` reviews a selected local source scope through the native
[Claude Messages API](https://platform.claude.com/docs/en/api/typescript/messages/create).
Use an Anthropic Console API key and a model available to that account.
The command produces a defensive STRIDE assessment from static evidence.
It does not import project code or run tools. `plenger scan` stays offline.
See [qualification status](../STATUS.md) for the validation record.

## Saved connection

In Settings > Providers, add **Anthropic Claude**. Enter a name, model ID and API
key. Keep the base URL `https://api.anthropic.com/v1` for the Anthropic API.
Leave temperature blank for the model default. An explicit temperature must be
between 0 and 1, and some models accept only their default. Increase maximum
output tokens if the report does not fit. Keys are encrypted on this device.

```sh
plenger assess path/to/project --provider "Claude review" --output assessment.md
plenger assess path/to/project --provider "Claude review" --json --output assessment.json
```

Use the same `--data-dir` as the dashboard if it uses a custom data directory.
The saved connection is also available for managed tests after an explicit
start; see [red-teaming](redteam.md). Assessments do not start those tests.

## Environment credential

For CI, put the API key in a secret environment variable. Replace `MODEL_ID`
with a Claude model ID available in your Console account:

```sh
plenger assess path/to/project --model MODEL_ID --api-key-env ANTHROPIC_API_KEY --json
```

Only the named variable is read. The command does not read a project `.env` or
save the environment key. Use either a saved provider or this pair of options.

## Scope and output

The selected file or folder is the allowlist. The offline scanner respects
`.gitignore`, skips symlink entries and dependency directories, and extracts
Python, JavaScript and TypeScript facts. Only redacted facts and finding
snippets enter the request. Complete source files and environment files are
excluded. Request metadata omits the absolute checkout root.

One request contains at most 100 files and 32 KiB of context. Files with static
findings are considered first. A file whose evidence does not fit is omitted.
The report records submitted paths, omissions, skipped-file count, syntax
limitations and a digest of the submitted context. Select a smaller folder or
file when coverage is partial. Comments, architecture documents, API definition
files and deployment settings are outside this initial evidence format.

The structured report includes assets, trust boundaries, STRIDE threats,
severity, source locations, impact, mitigations and limitations. References
outside submitted file and line bounds invalidate the response. A valid location
does not establish that the model's interpretation is correct. These are review
hypotheses. They do not become static findings or change the scan's CI gate.

The JSON schema is `schemas/security-assessment-v1.schema.json`. Markdown
escapes model-provided markup. Both formats redact known secrets and the selected
API key before output. Use `--output` to retain the assessment as an audit record.

## Limits and refusal handling

The default model deadline is 60 seconds. `--timeout` changes it. The default
admission budget is 200,000 tokens; `--tokens` changes it. The provider reserves
a conservative input estimate before dispatch, enforces the configured output
allowance and reconciles input, output and cache tokens after completion. The
report records observed usage or retains the reservation if accounting is unknown.
The admission budget is not a guaranteed billing cap.

There are no retries, fallback models or prompt rewrites. A provider refusal or
structured refusal produces a `refused` report with its redacted reason. An
incomplete response, invalid evidence or request failure produces a `failed`
report. Neither response triggers tools or another request. Active validation
requires a separate explicit action.

Exit 0 means the assessment completed, including when it reports threats. Exit 1
means refusal or incomplete execution. Exit 2 means invalid command settings.
