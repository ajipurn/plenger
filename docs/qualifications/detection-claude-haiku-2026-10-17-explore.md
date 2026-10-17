# Detection evaluation, Claude Haiku 5.5, discovery noise rules and Explore mode, 2026-10-17

Four live runs after the [weakness-matched baseline](detection-claude-haiku-2026-10-17-cwe.md):
two versions of new discovery rules against hardening noise, each in Batch and
in Explore mode. They establish behaviour on the evaluation corpus only, one
run each.

## Configuration

- Connection: saved provider "Claude 1", model `claude-haiku-5-5`, the same
  connection and saved prices as the earlier records. One run per row,
  `pnpm evaluate --provider "Claude 1" --runs 1 --yes --mode <mode>`.
- Corpus: 86 cases, 44 vulnerable and 42 safe. The baseline ran on 85; the
  table below compares the 85 cases all runs share. The added pathlib case was
  found with its weakness in all four runs.
- Rules v1: hardening items (rate limits, timeouts, request size, token or cost
  limits, logging, audit trails, monitoring, security headers) are STRIDE
  mitigations, not findings; an iteration limit is a finding only for an agent
  loop without a stop condition; prompt injection is a finding only when
  untrusted text reaches a system or developer message or steers a model with
  privileged tools or output.
- Rules v2: v1, plus supply-chain weaknesses and credentials in source are
  findings, and retrieved documents, tool results, files and web content count
  as untrusted text.
- Explore v2 also makes the submit tools strict on Claude. Explore v1 did not.

| Run | Mode | Rules | Prompt digest | Time (UTC) |
| --- | --- | --- | --- | --- |
| Baseline | Batch | none | `3d1da1e64a74` | 14:54 to 15:20 |
| Batch v1 | Batch | v1 | `9daf1cdfc486` | 15:26 to 15:51 |
| Explore v1 | Explore | v1 | `ba97014d85a6` | 15:26 to 15:57 |
| Batch v2 | Batch | v2 | `96606658d921` | 15:52 to 16:15 |
| Explore v2 | Explore | v2, strict tools | `404467970ca1` | 16:06 to 16:39 |

The corpus informed the rules, and the measurement is on the same corpus, so
these figures overstate what the rules do elsewhere.

## Results on the 85 shared cases

| Run | Any finding: precision | Recall | Source-supported: precision | Recall | Labeled weakness: precision | Recall | False positives |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | 0.68 | 0.95 | 0.68 | 0.84 | 0.91 | 0.91 | 19 |
| Batch v1 | 0.80 | 0.91 | 0.85 | 0.81 | 0.97 | 0.84 | 10 |
| Explore v1 | 0.82 | 0.95 | 0.85 | 0.79 | 0.95 | 0.91 | 9 |
| Batch v2 | 0.82 | 0.95 | 0.88 | 0.81 | 0.93 | 0.93 | 9 |
| Explore v2 | 0.82 | 0.98 | 0.92 | 0.81 | 0.93 | 0.95 | 9 |

## Batch against Explore, rules v2, 86 cases

| Mode | Completed | Model requests | Tool calls | Reported tokens | Estimated USD |
| --- | --- | --- | --- | --- | --- |
| Batch | 86 of 86 | 137 | none | 929,274 | 0.19 |
| Explore | 86 of 86 | 188 | `search` 51, `list_files` 38, `read_file` 1, submits 142 | 1,219,001 | 0.27 |

Explore made 1 to 4 requests per review: 33 reviews needed one (no candidates),
37 needed three.

## Observations

- The rules removed most hardening findings. Resource and audit findings
  (CWE-400, 770, 778) on safe cases fell from 13 in 12 cases in the baseline to
  1 in Batch v2 and none in Explore v2. False positives fell from 19 to 9.
- Rules v1 cost recall in Batch: retrieved documents in a system prompt
  (`py-rag-context-system`), an unpinned `uvx` MCP server
  (`py-mcp-unpinned-uvx`) and the hardcoded key were missed, the first two
  after 3 of 3 runs in each earlier record. Explore v1, on the same rules,
  found all three, so part of this is variance between single runs. Rules v2
  found the first two again in both modes.
- The labeled weakness count stayed above 0.9 in precision for every run with
  the rules. The remaining safe-case findings are mostly another real
  weakness at the labeled lines: missing authorization in the Go handler and
  the path helper, a remote model revision without a pin, an unsigned restore.
- Every case fits the first message, which holds up to 48 KiB of source. The
  model read one file range in 86 reviews and used search and listing to check
  for callers. The cross-file pairs therefore did not test reading: in Explore
  v2 router-level middleware was recognized (the safe twin was not reported),
  the path helper and Go placeholder twins were reported for missing
  authorization, as in Batch.
- Explore v1 needed a corrected discovery submission in 12 of 86 reviews, and
  two reviews failed after a second rejection. The run did not keep the
  rejection reasons, so their cause is not known. With strict submit tools,
  Explore v2 needed none. Its four remaining rejections, in three cases, were
  second-review reasons over the 1,200-character cap, which the strict schema
  can only state in a description; one candidate stayed Unvalidated.
- Explore cost 38% more than Batch and made 37% more requests, for one more
  vulnerable case found and two fewer safe cases with a source-supported
  finding.

## Not established

Spread between runs (one run per row), cases that need reading beyond the first
message, other models and transports, Full coverage and real projects. The
design's acceptance (explore recall not lower than batch, higher precision on
the cross-file pairs, over three runs) is not met by one run each.

## Generated report: Batch v2

Batch mode, prompt digest `96606658d921`, 1 run, Standard depth. 0 of 86 reviews did not complete. Estimated cost USD 0.1935. 137 model requests.

Precision 0.82 (min 0.82, max 0.82). Recall 0.95 (min 0.95, max 0.95). Counting only source-supported findings: precision 0.88 (min 0.88, max 0.88), recall 0.82 (min 0.82, max 0.82). Counting only findings that name the labeled weakness: precision 0.93 (min 0.93, max 0.93), recall 0.93 (min 0.93, max 0.93).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 42 | 9 | 2 | 33 | 0.82 | 0.95 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 1/1 | source-supported, source-supported | 0 |
| go-sql-handler-placeholder | safe | 1/1 | source-supported | 0 |
| java-download-path-confined | safe | 0/1 | none | 0 |
| java-download-path-traversal | vulnerable | 1/1 | source-supported | 0 |
| py-agent-approved-delete | safe | 0/1 | none | 0 |
| py-agent-unapproved-delete | vulnerable | 1/1 | needs-review | 0 |
| py-aws-key-docs-example | safe | 0/1 | none | 0 |
| py-aws-key-in-source | vulnerable | 1/1 | source-supported | 0 |
| py-calc-tool-eval | vulnerable | 1/1 | source-supported | 0 |
| py-calc-tool-literal-eval | safe | 0/1 | none | 0 |
| py-command-tool-lookup | safe | 0/1 | none | 0 |
| py-command-tool-lookup-fallback | vulnerable | 1/1 | source-supported | 0 |
| py-copy-tool-name-pattern | safe | 0/1 | none | 0 |
| py-copy-tool-path-pattern | vulnerable | 1/1 | source-supported | 0 |
| py-crew-agent-safe-code | safe | 0/1 | none | 0 |
| py-crew-agent-unsafe-code | vulnerable | 1/1 | needs-review | 0 |
| py-delete-tool-guarded | safe | 0/1 | none | 0 |
| py-delete-tool-late-check | vulnerable | 1/1 | source-supported | 0 |
| py-eval-output | vulnerable | 1/1 | source-supported | 0 |
| py-eval-output-literal | safe | 0/1 | none | 0 |
| py-faiss-dangerous-load | vulnerable | 1/1 | needs-review | 0 |
| py-faiss-rebuild | safe | 0/1 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 0/1 | none | 0 |
| py-fetch-tool-scheme-check | vulnerable | 1/1 | source-supported | 0 |
| py-hardcoded-key | vulnerable | 0/1 | none | 0 |
| py-hf-no-remote-code | safe | 1/1 | source-supported | 0 |
| py-hf-trust-remote-code | vulnerable | 1/1 | source-supported | 0 |
| py-key-from-env | safe | 0/1 | none | 0 |
| py-mcp-local-http | safe | 0/1 | none | 0 |
| py-mcp-pinned-uvx | safe | 0/1 | none | 0 |
| py-mcp-remote-http | vulnerable | 1/1 | source-supported | 0 |
| py-mcp-unpinned-uvx | vulnerable | 1/1 | source-supported | 0 |
| py-path-helper-confined | safe | 1/1 | source-supported | 0 |
| py-path-helper-unconfined | vulnerable | 1/1 | needs-review | 0 |
| py-path-tool | vulnerable | 1/1 | source-supported | 0 |
| py-path-tool-confined | safe | 0/1 | none | 0 |
| py-path-tool-pathlib | vulnerable | 1/1 | source-supported | 0 |
| py-prompt-refuses-password | safe | 0/1 | none | 0 |
| py-prompt-with-password | vulnerable | 1/1 | source-supported | 0 |
| py-rag-context-system | vulnerable | 1/1 | source-supported | 0 |
| py-rag-context-user | safe | 0/1 | none | 0 |
| py-read-tool-confined | safe | 0/1 | none | 0 |
| py-read-tool-sibling-prefix | vulnerable | 1/1 | source-supported | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 1/1 | source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 1/1 | needs-review | 0 |
| py-requests-toolkit-disabled | safe | 0/1 | none | 0 |
| py-restore-tool-json | safe | 1/1 | needs-review | 0 |
| py-restore-tool-pickle | vulnerable | 1/1 | source-supported | 0 |
| py-shell-tool | vulnerable | 1/1 | source-supported | 0 |
| py-shell-tool-allowlist | safe | 0/1 | none | 0 |
| py-smolagents-any-import | vulnerable | 1/1 | needs-review | 0 |
| py-smolagents-docker-imports | safe | 0/1 | none | 0 |
| py-sql-tool | vulnerable | 1/1 | source-supported | 0 |
| py-sql-tool-param | safe | 1/1 | needs-review | 0 |
| py-system-prompt-injection | vulnerable | 1/1 | source-supported | 0 |
| py-system-prompt-safe | safe | 0/1 | none | 0 |
| py-team-max-messages | safe | 0/1 | none | 0 |
| py-team-no-termination | vulnerable | 0/1 | none | 0 |
| py-tenant-scoped-repository | safe | 0/1 | none | 0 |
| py-tenant-unscoped-repository | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-absolute-only | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-allowlist | safe | 0/1 | none | 0 |
| py-write-tool-relative-checked | safe | 1/1 | source-supported | 0 |
| py-write-tool-unchecked-guard | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-unpacked | vulnerable | 1/1 | source-supported | 0 |
| py-write-tool-unpacked-confined | safe | 0/1 | none | 0 |
| ts-command-tool-allowlist | safe | 0/1 | none | 0 |
| ts-command-tool-model-allowlist | vulnerable | 1/1 | source-supported, source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 1/1 | needs-review | 0 |
| ts-email-tool-recipient | vulnerable | 1/1 | source-supported | 0 |
| ts-git-tool-argument | vulnerable | 1/1 | source-supported | 0 |
| ts-git-tool-argument-allowlist | safe | 0/1 | none | 0 |
| ts-idor-route | vulnerable | 1/1 | source-supported | 0 |
| ts-idor-route-scoped | safe | 0/1 | none | 0 |
| ts-mcp-http-bearer-auth | safe | 1/1 | dismissed, source-supported, source-supported | 0 |
| ts-mcp-http-no-auth | vulnerable | 1/1 | source-supported | 0 |
| ts-openai-browser | vulnerable | 1/1 | source-supported | 0 |
| ts-openai-server | safe | 0/1 | none | 0 |
| ts-read-tool-no-separators | safe | 0/1 | none | 0 |
| ts-read-tool-slash-only | vulnerable | 1/1 | source-supported | 0 |
| ts-route-agent-clock-tool | safe | 0/1 | none | 0 |
| ts-route-agent-shell-tool | vulnerable | 1/1 | source-supported, needs-review | 0 |
| ts-route-missing-auth | vulnerable | 1/1 | source-supported | 0 |
| ts-route-router-auth | safe | 1/1 | needs-review | 0 |
| ts-ssrf-tool | vulnerable | 1/1 | source-supported | 0 |
| ts-ssrf-tool-allowlist | safe | 0/1 | none | 0 |

## Generated report: Explore v2

Explore mode, prompt digest `404467970ca1`, 1 run, Standard depth. 0 of 86 reviews did not complete. Estimated cost USD 0.2676. 188 model requests; tool calls: list_files 38, read_file 1, search 51, submit_decisions 56, submit_discovery 86.

Precision 0.83 (min 0.83, max 0.83). Recall 0.98 (min 0.98, max 0.98). Counting only source-supported findings: precision 0.92 (min 0.92, max 0.92), recall 0.82 (min 0.82, max 0.82). Counting only findings that name the labeled weakness: precision 0.93 (min 0.93, max 0.93), recall 0.95 (min 0.95, max 0.95).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 43 | 9 | 1 | 33 | 0.83 | 0.98 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 1/1 | source-supported, source-supported | 1 |
| go-sql-handler-placeholder | safe | 1/1 | source-supported | 0 |
| java-download-path-confined | safe | 0/1 | none | 0 |
| java-download-path-traversal | vulnerable | 1/1 | source-supported | 0 |
| py-agent-approved-delete | safe | 0/1 | dismissed | 0 |
| py-agent-unapproved-delete | vulnerable | 1/1 | needs-review, needs-review | 0 |
| py-aws-key-docs-example | safe | 0/1 | none | 0 |
| py-aws-key-in-source | vulnerable | 1/1 | source-supported | 0 |
| py-calc-tool-eval | vulnerable | 1/1 | source-supported | 0 |
| py-calc-tool-literal-eval | safe | 0/1 | none | 0 |
| py-command-tool-lookup | safe | 0/1 | none | 0 |
| py-command-tool-lookup-fallback | vulnerable | 1/1 | source-supported | 0 |
| py-copy-tool-name-pattern | safe | 0/1 | none | 0 |
| py-copy-tool-path-pattern | vulnerable | 1/1 | source-supported | 0 |
| py-crew-agent-safe-code | safe | 1/1 | needs-review | 0 |
| py-crew-agent-unsafe-code | vulnerable | 1/1 | needs-review | 0 |
| py-delete-tool-guarded | safe | 1/1 | needs-review | 0 |
| py-delete-tool-late-check | vulnerable | 1/1 | source-supported, needs-review | 0 |
| py-eval-output | vulnerable | 1/1 | source-supported | 0 |
| py-eval-output-literal | safe | 0/1 | none | 0 |
| py-faiss-dangerous-load | vulnerable | 1/1 | needs-review | 0 |
| py-faiss-rebuild | safe | 0/1 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 0/1 | none | 0 |
| py-fetch-tool-scheme-check | vulnerable | 1/1 | source-supported | 0 |
| py-hardcoded-key | vulnerable | 1/1 | needs-review | 0 |
| py-hf-no-remote-code | safe | 1/1 | source-supported | 0 |
| py-hf-trust-remote-code | vulnerable | 1/1 | source-supported | 0 |
| py-key-from-env | safe | 0/1 | none | 0 |
| py-mcp-local-http | safe | 0/1 | none | 0 |
| py-mcp-pinned-uvx | safe | 0/1 | none | 0 |
| py-mcp-remote-http | vulnerable | 1/1 | source-supported | 0 |
| py-mcp-unpinned-uvx | vulnerable | 1/1 | source-supported | 0 |
| py-path-helper-confined | safe | 1/1 | needs-review | 0 |
| py-path-helper-unconfined | vulnerable | 1/1 | source-supported, source-supported | 0 |
| py-path-tool | vulnerable | 1/1 | source-supported | 0 |
| py-path-tool-confined | safe | 0/1 | none | 0 |
| py-path-tool-pathlib | vulnerable | 1/1 | source-supported | 0 |
| py-prompt-refuses-password | safe | 0/1 | none | 0 |
| py-prompt-with-password | vulnerable | 1/1 | source-supported | 0 |
| py-rag-context-system | vulnerable | 1/1 | source-supported | 0 |
| py-rag-context-user | safe | 0/1 | none | 0 |
| py-read-tool-confined | safe | 0/1 | none | 0 |
| py-read-tool-sibling-prefix | vulnerable | 1/1 | source-supported | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 1/1 | source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 1/1 | source-supported | 0 |
| py-requests-toolkit-disabled | safe | 0/1 | none | 0 |
| py-restore-tool-json | safe | 1/1 | needs-review | 0 |
| py-restore-tool-pickle | vulnerable | 1/1 | source-supported | 0 |
| py-shell-tool | vulnerable | 1/1 | source-supported | 0 |
| py-shell-tool-allowlist | safe | 0/1 | none | 0 |
| py-smolagents-any-import | vulnerable | 1/1 | needs-review | 0 |
| py-smolagents-docker-imports | safe | 0/1 | none | 0 |
| py-sql-tool | vulnerable | 1/1 | source-supported, needs-review | 0 |
| py-sql-tool-param | safe | 1/1 | needs-review | 0 |
| py-system-prompt-injection | vulnerable | 1/1 | source-supported | 0 |
| py-system-prompt-safe | safe | 0/1 | none | 0 |
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
| ts-command-tool-allowlist | safe | 0/1 | none | 0 |
| ts-command-tool-model-allowlist | vulnerable | 1/1 | source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 1/1 | needs-review | 0 |
| ts-email-tool-recipient | vulnerable | 1/1 | source-supported, needs-review | 0 |
| ts-git-tool-argument | vulnerable | 1/1 | unvalidated | 0 |
| ts-git-tool-argument-allowlist | safe | 0/1 | none | 0 |
| ts-idor-route | vulnerable | 1/1 | source-supported | 0 |
| ts-idor-route-scoped | safe | 0/1 | none | 0 |
| ts-mcp-http-bearer-auth | safe | 0/1 | none | 0 |
| ts-mcp-http-no-auth | vulnerable | 1/1 | source-supported, needs-review | 0 |
| ts-openai-browser | vulnerable | 1/1 | source-supported | 0 |
| ts-openai-server | safe | 0/1 | none | 0 |
| ts-read-tool-no-separators | safe | 0/1 | none | 0 |
| ts-read-tool-slash-only | vulnerable | 1/1 | needs-review | 0 |
| ts-route-agent-clock-tool | safe | 0/1 | none | 0 |
| ts-route-agent-shell-tool | vulnerable | 1/1 | source-supported, source-supported | 0 |
| ts-route-missing-auth | vulnerable | 1/1 | source-supported | 0 |
| ts-route-router-auth | safe | 0/1 | none | 0 |
| ts-ssrf-tool | vulnerable | 1/1 | source-supported | 0 |
| ts-ssrf-tool-allowlist | safe | 0/1 | none | 0 |
