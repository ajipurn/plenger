# Detection evaluation, Claude Haiku 5.5, weakness-matched scoring, 2026-10-17

Discovery now gives a CWE id for each finding, and `pnpm evaluate` reports a
third count: a case is detected only when a kept finding at the labeled lines
names the labeled weakness or one of its family. This record is one run on the
85-case corpus with the calibrated second review of
[the validation record](detection-claude-haiku-2026-10-17-validation.md). It
establishes behaviour on that corpus only.

## Configuration

- Command: `pnpm evaluate --provider "Claude 1" --runs 1 --yes`, from
  2026-10-17T14:54Z to 15:20Z.
- Connection: saved provider "Claude 1", model `claude-haiku-5-5`, the same
  connection and saved prices as the earlier records.
- Change: the discovery instructions ask for "the CWE id that best names its
  weakness", and each finding has a `cwe` field (a `CWE-<n>` id or null). The
  second review is unchanged.
- Prompt digest `3d1da1e64a74`.
- Corpus: 85 cases, 43 vulnerable and 42 safe, after the fixes to three safe
  cases and the added sibling-prefix case. The pathlib pair was added after
  this run.
- Families: `WEAKNESS_FAMILIES` in `scripts/lib/evaluation.ts` groups CWE ids
  that name the same weakness at different levels, such as 22, 23, 36 and 73
  for path traversal, or 284, 285, 639, 862 and 863 for access control.

## Results

| Count | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| Any kept finding at the labeled lines | 41 | 19 | 2 | 23 | 0.68 | 0.95 |
| Only source-supported findings | 36 | 17 | 7 | 25 | 0.68 | 0.84 |
| Only findings of the labeled weakness | 39 | 4 | 4 | 38 | 0.91 | 0.91 |

85 of 85 reviews completed. They used 972,904 reported tokens; the estimate was
USD 0.21 at this connection's saved prices. Every one of the 81 findings at a
labeled location had a CWE id.

## Observations

- Of the 19 safe cases with a kept finding, 15 were findings of another
  weakness at the labeled lines. 11 of those were resource or hardening items:
  CWE-400 nine times (unbounded reads, response bodies, `ast.literal_eval`
  input, a subprocess without a timeout), CWE-770 twice and CWE-778 once. The
  others were missing authorization in the Go handler and `py-sql-tool-param`,
  prompt injection through text returned to an agent, an unverified restore and
  boolean values accepted as numbers.
- Four safe cases were reported with the labeled weakness:
  - `py-crew-agent-safe-code`: CrewAI code execution in safe mode, kept as
    needs-review.
  - `py-rag-context-user` and `py-system-prompt-safe`: prompt injection where the
    untrusted text is only the user message.
  - `py-write-tool-relative-checked`: a containment bypass claimed for a tool
    that rejects `..` and absolute paths before joining onto a resolved base.
    The case stands as safe on POSIX paths.
- Four vulnerable cases were missed under this count:
  - `py-faiss-dangerous-load`: named CWE-502, then dismissed by the second review.
  - `py-team-no-termination`: no finding.
  - `py-system-prompt-injection`: found, but named CWE-77, command injection.
  - `ts-email-tool-recipient`: found, but named CWE-441 and CWE-20 instead of an
    access control id.
- Consequences: the hardening findings are what the next discovery change
  targets, and the prompt injection rule needs to say when caller text in the
  user message is the intended use. Families are not widened to absorb CWE-77 or
  CWE-441; those are recorded as naming errors.

## Not established

Spread between runs (one run only), other models, exploration and real
projects. The families are a judgment and can move a case either way.

## AI review: claude-haiku-5-5

Prompt digest `3d1da1e64a74`, 1 run, Standard depth. 0 of 85 reviews did not complete. Estimated cost USD 0.2068.

Precision 0.68 (min 0.68, max 0.68). Recall 0.95 (min 0.95, max 0.95). Counting only source-supported findings: precision 0.68 (min 0.68, max 0.68), recall 0.84 (min 0.84, max 0.84). Counting only findings that name the labeled weakness: precision 0.91 (min 0.91, max 0.91), recall 0.91 (min 0.91, max 0.91).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 41 | 19 | 2 | 23 | 0.68 | 0.95 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 1/1 | source-supported | 0 |
| go-sql-handler-placeholder | safe | 1/1 | source-supported, source-supported | 0 |
| java-download-path-confined | safe | 0/1 | dismissed | 0 |
| java-download-path-traversal | vulnerable | 1/1 | source-supported | 0 |
| py-agent-approved-delete | safe | 1/1 | needs-review | 0 |
| py-agent-unapproved-delete | vulnerable | 1/1 | source-supported | 1 |
| py-aws-key-docs-example | safe | 0/1 | none | 0 |
| py-aws-key-in-source | vulnerable | 1/1 | source-supported | 0 |
| py-calc-tool-eval | vulnerable | 1/1 | source-supported | 0 |
| py-calc-tool-literal-eval | safe | 1/1 | source-supported | 0 |
| py-command-tool-lookup | safe | 1/1 | source-supported | 0 |
| py-command-tool-lookup-fallback | vulnerable | 1/1 | source-supported, source-supported | 0 |
| py-copy-tool-name-pattern | safe | 0/1 | none | 0 |
| py-copy-tool-path-pattern | vulnerable | 1/1 | source-supported | 0 |
| py-crew-agent-safe-code | safe | 1/1 | needs-review | 0 |
| py-crew-agent-unsafe-code | vulnerable | 1/1 | needs-review | 0 |
| py-delete-tool-guarded | safe | 0/1 | none | 0 |
| py-delete-tool-late-check | vulnerable | 1/1 | source-supported | 0 |
| py-eval-output | vulnerable | 1/1 | source-supported | 0 |
| py-eval-output-literal | safe | 1/1 | source-supported, source-supported, source-supported | 0 |
| py-faiss-dangerous-load | vulnerable | 0/1 | dismissed | 0 |
| py-faiss-rebuild | safe | 0/1 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 1/1 | source-supported | 0 |
| py-fetch-tool-scheme-check | vulnerable | 1/1 | source-supported, source-supported | 0 |
| py-hardcoded-key | vulnerable | 1/1 | needs-review | 1 |
| py-hf-no-remote-code | safe | 0/1 | none | 0 |
| py-hf-trust-remote-code | vulnerable | 1/1 | source-supported | 0 |
| py-key-from-env | safe | 0/1 | none | 0 |
| py-mcp-local-http | safe | 0/1 | none | 0 |
| py-mcp-pinned-uvx | safe | 0/1 | none | 0 |
| py-mcp-remote-http | vulnerable | 1/1 | source-supported | 0 |
| py-mcp-unpinned-uvx | vulnerable | 1/1 | source-supported, needs-review | 0 |
| py-path-helper-confined | safe | 0/1 | none | 0 |
| py-path-helper-unconfined | vulnerable | 1/1 | needs-review | 0 |
| py-path-tool | vulnerable | 1/1 | source-supported | 0 |
| py-path-tool-confined | safe | 1/1 | source-supported | 0 |
| py-prompt-refuses-password | safe | 0/1 | none | 0 |
| py-prompt-with-password | vulnerable | 1/1 | source-supported | 0 |
| py-rag-context-system | vulnerable | 1/1 | needs-review | 0 |
| py-rag-context-user | safe | 1/1 | source-supported, needs-review | 0 |
| py-read-tool-confined | safe | 1/1 | source-supported | 0 |
| py-read-tool-sibling-prefix | vulnerable | 1/1 | source-supported | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 1/1 | source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 1/1 | needs-review | 0 |
| py-requests-toolkit-disabled | safe | 0/1 | none | 0 |
| py-restore-tool-json | safe | 1/1 | source-supported | 0 |
| py-restore-tool-pickle | vulnerable | 1/1 | source-supported | 0 |
| py-shell-tool | vulnerable | 1/1 | source-supported, source-supported | 0 |
| py-shell-tool-allowlist | safe | 1/1 | source-supported | 0 |
| py-smolagents-any-import | vulnerable | 1/1 | source-supported | 0 |
| py-smolagents-docker-imports | safe | 0/1 | dismissed | 0 |
| py-sql-tool | vulnerable | 1/1 | source-supported | 0 |
| py-sql-tool-param | safe | 1/1 | source-supported | 0 |
| py-system-prompt-injection | vulnerable | 1/1 | source-supported | 0 |
| py-system-prompt-safe | safe | 1/1 | source-supported, source-supported | 0 |
| py-team-max-messages | safe | 0/1 | none | 0 |
| py-team-no-termination | vulnerable | 0/1 | none | 0 |
| py-tenant-scoped-repository | safe | 0/1 | none | 0 |
| py-tenant-unscoped-repository | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-absolute-only | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-allowlist | safe | 0/1 | none | 0 |
| py-write-tool-relative-checked | safe | 1/1 | source-supported, needs-review | 0 |
| py-write-tool-unchecked-guard | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-unpacked | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-unpacked-confined | safe | 0/1 | none | 0 |
| ts-command-tool-allowlist | safe | 0/1 | dismissed | 0 |
| ts-command-tool-model-allowlist | vulnerable | 1/1 | source-supported, source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 1/1 | source-supported | 0 |
| ts-email-tool-recipient | vulnerable | 1/1 | source-supported, source-supported | 0 |
| ts-git-tool-argument | vulnerable | 1/1 | source-supported | 0 |
| ts-git-tool-argument-allowlist | safe | 0/1 | none | 0 |
| ts-idor-route | vulnerable | 1/1 | source-supported | 0 |
| ts-idor-route-scoped | safe | 0/1 | none | 0 |
| ts-mcp-http-bearer-auth | safe | 1/1 | source-supported, source-supported | 0 |
| ts-mcp-http-no-auth | vulnerable | 1/1 | source-supported, source-supported | 0 |
| ts-openai-browser | vulnerable | 1/1 | source-supported | 0 |
| ts-openai-server | safe | 0/1 | none | 0 |
| ts-read-tool-no-separators | safe | 0/1 | none | 0 |
| ts-read-tool-slash-only | vulnerable | 1/1 | source-supported | 0 |
| ts-route-agent-clock-tool | safe | 1/1 | needs-review, source-supported | 0 |
| ts-route-agent-shell-tool | vulnerable | 1/1 | needs-review, source-supported, source-supported | 0 |
| ts-route-missing-auth | vulnerable | 1/1 | source-supported | 0 |
| ts-route-router-auth | safe | 0/1 | none | 1 |
| ts-ssrf-tool | vulnerable | 1/1 | source-supported | 0 |
| ts-ssrf-tool-allowlist | safe | 1/1 | source-supported | 0 |
