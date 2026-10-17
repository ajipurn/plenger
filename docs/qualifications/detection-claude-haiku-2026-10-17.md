# Detection evaluation, Claude Haiku 5.5, 2026-10-17

Baseline of the source-based AI review on the 82-case corpus, before the second
review's instructions are calibrated and before read-only exploration (M9b). It
establishes behaviour on that corpus only.

## Configuration

- Command: `pnpm evaluate --provider "Claude 1" --runs 3 --yes`, from
  2026-10-17T08:56Z to 10:11Z, on commit `724b12a` with the cross-file, Go and
  Java pairs added.
- Connection: native Anthropic Messages API, model `claude-haiku-5-5`, default
  temperature, automatic output limit. The 2026-10-16 record used another saved
  connection to the same model.
- Review: one batch per case, discovery and second review on the same
  connection. Every case is under 1 KB of source and is sent whole.
- Prompt digest `beabaf1c5906`. The 2026-10-16 record used `94d7f6c4c43f`: the
  instructions changed when reviews started reading text files in any language
  (M9a), so the two records are not a strict comparison.
- Only the corpus was sent, redacted as in every review.

Corpus: 82 labeled cases in `test/fixtures/evaluation`, 41 vulnerable and 41 safe near-misses. A finding counts for a case when it overlaps the labeled lines; AI findings dismissed by the second review do not count. The corpus is small and synthetic: these figures describe it, not arbitrary projects.

## Static rules

| TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| 35 | 0 | 6 | 41 | 1.00 | 0.85 |

| Rule | Vulnerable cases | Safe cases | Precision |
| --- | --- | --- | --- |
| PLG101 | 3 | 0 | 1.00 |
| PLG102 | 1 | 0 | 1.00 |
| PLG103 | 1 | 0 | 1.00 |
| PLG104 | 7 | 0 | 1.00 |
| PLG105 | 2 | 0 | 1.00 |
| PLG106 | 1 | 0 | 1.00 |
| PLG107 | 1 | 0 | 1.00 |
| PLG108 | 1 | 0 | 1.00 |
| PLG201 | 2 | 0 | 1.00 |
| PLG202 | 2 | 0 | 1.00 |
| PLG203 | 1 | 0 | 1.00 |
| PLG301 | 1 | 0 | 1.00 |
| PLG302 | 1 | 0 | 1.00 |
| PLG303 | 1 | 0 | 1.00 |
| PLG401 | 1 | 0 | 1.00 |
| PLG501 | 1 | 0 | 1.00 |
| PLG502 | 1 | 0 | 1.00 |
| PLG503 | 1 | 0 | 1.00 |
| PLG601 | 1 | 0 | 1.00 |
| PLG602 | 1 | 0 | 1.00 |
| PLG603 | 1 | 0 | 1.00 |
| PLG701 | 1 | 0 | 1.00 |
| PLG702 | 1 | 0 | 1.00 |
| PLG703 | 1 | 0 | 1.00 |
| PLG704 | 1 | 0 | 1.00 |
| PLG705 | 1 | 0 | 1.00 |

| Case | Truth | Static rules at the location |
| --- | --- | --- |
| go-sql-handler-concat | vulnerable | none |
| go-sql-handler-placeholder | safe | none |
| java-download-path-confined | safe | none |
| java-download-path-traversal | vulnerable | none |
| py-agent-approved-delete | safe | none |
| py-agent-unapproved-delete | vulnerable | PLG201 |
| py-aws-key-docs-example | safe | none |
| py-aws-key-in-source | vulnerable | PLG502 |
| py-calc-tool-eval | vulnerable | PLG103 |
| py-calc-tool-literal-eval | safe | none |
| py-command-tool-lookup | safe | none |
| py-command-tool-lookup-fallback | vulnerable | PLG101 |
| py-copy-tool-name-pattern | safe | none |
| py-copy-tool-path-pattern | vulnerable | PLG104 |
| py-crew-agent-safe-code | safe | none |
| py-crew-agent-unsafe-code | vulnerable | PLG202 |
| py-delete-tool-guarded | safe | none |
| py-delete-tool-late-check | vulnerable | PLG104 |
| py-eval-output | vulnerable | PLG401 |
| py-eval-output-literal | safe | none |
| py-faiss-dangerous-load | vulnerable | PLG702 |
| py-faiss-rebuild | safe | none |
| py-fetch-tool-host-allowlist | safe | none |
| py-fetch-tool-scheme-check | vulnerable | PLG105 |
| py-hardcoded-key | vulnerable | PLG501 |
| py-hf-no-remote-code | safe | none |
| py-hf-trust-remote-code | vulnerable | PLG703 |
| py-key-from-env | safe | none |
| py-mcp-local-http | safe | none |
| py-mcp-pinned-uvx | safe | none |
| py-mcp-remote-http | vulnerable | PLG603 |
| py-mcp-unpinned-uvx | vulnerable | PLG602 |
| py-path-helper-confined | safe | none |
| py-path-helper-unconfined | vulnerable | none |
| py-path-tool | vulnerable | PLG104 |
| py-path-tool-confined | safe | none |
| py-prompt-refuses-password | safe | none |
| py-prompt-with-password | vulnerable | PLG503 |
| py-rag-context-system | vulnerable | PLG303 |
| py-rag-context-user | safe | none |
| py-read-tool-confined | safe | none |
| py-read-tool-unresolved-prefix | vulnerable | PLG104 |
| py-requests-toolkit-dangerous | vulnerable | PLG705 |
| py-requests-toolkit-disabled | safe | none |
| py-restore-tool-json | safe | none |
| py-restore-tool-pickle | vulnerable | PLG107 |
| py-shell-tool | vulnerable | PLG101 |
| py-shell-tool-allowlist | safe | none |
| py-smolagents-any-import | vulnerable | PLG202, PLG701 |
| py-smolagents-docker-imports | safe | none |
| py-sql-tool | vulnerable | PLG106 |
| py-sql-tool-param | safe | none |
| py-system-prompt-injection | vulnerable | PLG302 |
| py-system-prompt-safe | safe | none |
| py-team-max-messages | safe | none |
| py-team-no-termination | vulnerable | PLG203 |
| py-tenant-scoped-repository | safe | none |
| py-tenant-unscoped-repository | vulnerable | none |
| py-write-tool-allowlist | safe | none |
| py-write-tool-unchecked-guard | vulnerable | PLG104 |
| py-write-tool-unpacked | vulnerable | PLG104 |
| py-write-tool-unpacked-confined | safe | none |
| ts-command-tool-allowlist | safe | none |
| ts-command-tool-model-allowlist | vulnerable | PLG101 |
| ts-email-tool-fixed-recipient | safe | none |
| ts-email-tool-recipient | vulnerable | PLG108 |
| ts-git-tool-argument | vulnerable | PLG102 |
| ts-git-tool-argument-allowlist | safe | none |
| ts-idor-route | vulnerable | none |
| ts-idor-route-scoped | safe | none |
| ts-mcp-http-bearer-auth | safe | none |
| ts-mcp-http-no-auth | vulnerable | PLG601 |
| ts-openai-browser | vulnerable | PLG704 |
| ts-openai-server | safe | none |
| ts-read-tool-no-separators | safe | none |
| ts-read-tool-slash-only | vulnerable | PLG104 |
| ts-route-agent-clock-tool | safe | none |
| ts-route-agent-shell-tool | vulnerable | PLG201, PLG301 |
| ts-route-missing-auth | vulnerable | none |
| ts-route-router-auth | safe | none |
| ts-ssrf-tool | vulnerable | PLG105 |
| ts-ssrf-tool-allowlist | safe | none |

## AI review: claude-haiku-5-5

Prompt digest `beabaf1c5906`, 3 runs, Standard depth. 0 of 246 reviews did not complete. Estimated cost USD 0.5973.

Precision 0.62 (min 0.59, max 0.64). Recall 0.95 (min 0.95, max 0.95). Counting only source-supported findings: precision 0.72 (min 0.66, max 0.80), recall 0.50 (min 0.49, max 0.51).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 39 | 22 | 2 | 19 | 0.64 | 0.95 |
| 2 | 39 | 27 | 2 | 14 | 0.59 | 0.95 |
| 3 | 39 | 23 | 2 | 18 | 0.63 | 0.95 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 3/3 | source-supported, source-supported, source-supported, needs-review | 1 |
| go-sql-handler-placeholder | safe | 3/3 | source-supported, source-supported, source-supported, source-supported, needs-review | 2 |
| java-download-path-confined | safe | 3/3 | needs-review, needs-review, source-supported, needs-review | 0 |
| java-download-path-traversal | vulnerable | 3/3 | source-supported, needs-review, source-supported, source-supported | 0 |
| py-agent-approved-delete | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-agent-unapproved-delete | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-aws-key-docs-example | safe | 0/3 | none | 0 |
| py-aws-key-in-source | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-calc-tool-eval | vulnerable | 3/3 | source-supported, source-supported, source-supported, needs-review | 0 |
| py-calc-tool-literal-eval | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-command-tool-lookup | safe | 0/3 | none | 0 |
| py-command-tool-lookup-fallback | vulnerable | 3/3 | source-supported, source-supported, needs-review, needs-review, source-supported, needs-review, source-supported | 0 |
| py-copy-tool-name-pattern | safe | 2/3 | source-supported, needs-review | 0 |
| py-copy-tool-path-pattern | vulnerable | 3/3 | needs-review, needs-review, source-supported, source-supported | 0 |
| py-crew-agent-safe-code | safe | 2/3 | needs-review, needs-review | 0 |
| py-crew-agent-unsafe-code | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-delete-tool-guarded | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-delete-tool-late-check | vulnerable | 3/3 | source-supported, needs-review, needs-review | 0 |
| py-eval-output | vulnerable | 3/3 | source-supported, source-supported, needs-review, needs-review | 0 |
| py-eval-output-literal | safe | 3/3 | source-supported, needs-review, needs-review, needs-review, needs-review | 0 |
| py-faiss-dangerous-load | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-faiss-rebuild | safe | 0/3 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 3/3 | needs-review, source-supported, needs-review, source-supported, needs-review | 0 |
| py-fetch-tool-scheme-check | vulnerable | 3/3 | needs-review, source-supported, source-supported, needs-review, source-supported, source-supported, source-supported | 0 |
| py-hardcoded-key | vulnerable | 0/3 | none | 3 |
| py-hf-no-remote-code | safe | 0/3 | none | 0 |
| py-hf-trust-remote-code | vulnerable | 3/3 | needs-review, source-supported, source-supported | 0 |
| py-key-from-env | safe | 0/3 | none | 1 |
| py-mcp-local-http | safe | 0/3 | none | 0 |
| py-mcp-pinned-uvx | safe | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| py-mcp-remote-http | vulnerable | 3/3 | needs-review, needs-review, needs-review | 1 |
| py-mcp-unpinned-uvx | vulnerable | 3/3 | needs-review, source-supported, source-supported, needs-review | 2 |
| py-path-helper-confined | safe | 3/3 | needs-review, needs-review, needs-review, source-supported, needs-review, source-supported | 0 |
| py-path-helper-unconfined | vulnerable | 3/3 | needs-review, needs-review, source-supported, needs-review | 0 |
| py-path-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, needs-review, needs-review | 0 |
| py-path-tool-confined | safe | 1/3 | needs-review | 0 |
| py-prompt-refuses-password | safe | 0/3 | none | 1 |
| py-prompt-with-password | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-rag-context-system | vulnerable | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| py-rag-context-user | safe | 3/3 | needs-review, needs-review, source-supported, needs-review, needs-review, needs-review | 0 |
| py-read-tool-confined | safe | 1/3 | needs-review | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 3/3 | needs-review, source-supported, source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| py-requests-toolkit-disabled | safe | 0/3 | none | 0 |
| py-restore-tool-json | safe | 3/3 | needs-review, needs-review, needs-review, needs-review, needs-review, needs-review | 0 |
| py-restore-tool-pickle | vulnerable | 3/3 | source-supported, needs-review, needs-review | 0 |
| py-shell-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, needs-review | 0 |
| py-shell-tool-allowlist | safe | 1/3 | needs-review | 0 |
| py-smolagents-any-import | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-smolagents-docker-imports | safe | 1/3 | needs-review | 0 |
| py-sql-tool | vulnerable | 3/3 | source-supported, source-supported, needs-review, source-supported | 0 |
| py-sql-tool-param | safe | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| py-system-prompt-injection | vulnerable | 3/3 | needs-review, needs-review, source-supported, needs-review, needs-review, needs-review, source-supported | 0 |
| py-system-prompt-safe | safe | 3/3 | needs-review, needs-review, dismissed, source-supported, needs-review | 0 |
| py-team-max-messages | safe | 0/3 | none | 0 |
| py-team-no-termination | vulnerable | 0/3 | none | 0 |
| py-tenant-scoped-repository | safe | 0/3 | none | 0 |
| py-tenant-unscoped-repository | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-allowlist | safe | 1/3 | needs-review | 0 |
| py-write-tool-unchecked-guard | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked-confined | safe | 3/3 | needs-review, source-supported, source-supported, needs-review | 0 |
| ts-command-tool-allowlist | safe | 1/3 | needs-review, source-supported | 0 |
| ts-command-tool-model-allowlist | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 3/3 | source-supported, needs-review, needs-review, needs-review, needs-review | 1 |
| ts-email-tool-recipient | vulnerable | 3/3 | source-supported, needs-review, needs-review, needs-review, source-supported, needs-review | 0 |
| ts-git-tool-argument | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-git-tool-argument-allowlist | safe | 2/3 | source-supported, needs-review | 0 |
| ts-idor-route | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| ts-idor-route-scoped | safe | 2/3 | needs-review, needs-review, needs-review | 1 |
| ts-mcp-http-bearer-auth | safe | 3/3 | needs-review, needs-review, needs-review, source-supported, needs-review, source-supported | 0 |
| ts-mcp-http-no-auth | vulnerable | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| ts-openai-browser | vulnerable | 3/3 | source-supported, source-supported, source-supported | 2 |
| ts-openai-server | safe | 0/3 | none | 0 |
| ts-read-tool-no-separators | safe | 1/3 | needs-review | 0 |
| ts-read-tool-slash-only | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| ts-route-agent-clock-tool | safe | 3/3 | needs-review, source-supported, needs-review, needs-review, needs-review | 0 |
| ts-route-agent-shell-tool | vulnerable | 3/3 | needs-review, needs-review, needs-review, needs-review, needs-review, needs-review, source-supported | 0 |
| ts-route-missing-auth | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| ts-route-router-auth | safe | 3/3 | source-supported, needs-review, source-supported, needs-review, needs-review | 3 |
| ts-ssrf-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, needs-review, needs-review | 0 |
| ts-ssrf-tool-allowlist | safe | 3/3 | needs-review, source-supported, source-supported, source-supported | 0 |

## Observations

- All 246 reviews completed, with no refusal, invalid response or retry, in 75
  minutes, one review at a time. They used 6,306 to 16,898 reported tokens each,
  2,698,590 in total. The cost estimate, USD 0.60, comes from the prices saved on
  this connection, which differ from those of the 2026-10-16 connection; compare
  tokens, not cost.
- Counting every finding the second review did not dismiss, precision was 0.62
  and recall 0.95. Counting only source-supported findings, precision was 0.72
  and recall 0.50.
- The second review dismissed 1 of 263 verdicts at a labeled location. On safe
  cases it gave 78 needs-review, 26 source-supported and that one dismissal. 30 of
  41 safe cases were reported in at least one run, 19 in all three. Most of them
  hold their guard in the same file as the effect: a fixed allowlist, a
  parameterized query, `ast.literal_eval`, a pinned MCP server, bearer
  authentication. The precision problem is in validation, not in what the review
  can see.
- On the 16 cases of the 2026-10-16 corpus, pooled over three runs, precision
  was 0.57 and recall 0.88, against 0.59 and 0.92 then.
- Cross-file pairs: the tenant pair was right in every run: the scoped
  repository was never reported, the unscoped one always. The router-level
  middleware and the confining path helper were reported in every run, twice as
  source-supported each, although the file that holds the guard was in the batch.
- Go and Java pairs: both vulnerable cases were found in every run. Both safe
  cases were reported in every run too; the Go handler's placeholder query was
  marked source-supported in four of five verdicts.
- The two misses: the hardcoded key, which reviews redact before the request, so
  the model sees a placeholder (PLG501 covers it statically), and the team with
  no termination condition (PLG203 covers it statically).
- Recall was the same in every run (0.95). Precision varied between 0.59 and
  0.64.

Three safe cases of this corpus were later found to hold a weakness of their own
kind and were fixed: `py-write-tool-unpacked-confined`,
`py-fetch-tool-host-allowlist` and `ts-mcp-http-bearer-auth`. See
[the calibration record](detection-claude-haiku-2026-10-17-validation.md#diagnostic-run-with-findings-kept);
the scores here count them as safe.

## Not established

Other models, a separate second-review model, Full coverage, scaled batch
budgets, read-only exploration, real projects and larger corpora. Compare later
records only when the prompt digest matches; a calibration of the second review
changes it.
