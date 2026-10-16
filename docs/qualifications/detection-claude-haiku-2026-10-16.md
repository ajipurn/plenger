# Detection evaluation, Claude Haiku 5.5, 2026-10-16

First live measurement of the source-based AI review, on the labeled corpus in
`test/fixtures/evaluation/`. It establishes behaviour on that corpus only.

## Configuration

- Command: `pnpm evaluate -- --provider "Claude 2" --runs 3 --yes`
- Connection: native Anthropic Messages API, model `claude-haiku-5-5`, default
  temperature, automatic output limit, saved USD prices for the cost estimate.
- Review: Standard depth, one batch per case, discovery and second review on the
  same connection. The saved catalog did not report this model's input window,
  so the default 20 KiB batch budget applied; every case fits it whole.
- Prompt digest `94d7f6c4c43f`. Only the corpus was sent, redacted as in every review.

Corpus: 16 labeled cases in `test/fixtures/evaluation`, 8 vulnerable and 8 safe near-misses. A finding counts for a case when it overlaps the labeled lines; AI findings dismissed by the second review do not count. The corpus is small and synthetic: these figures describe it, not arbitrary projects.

## Static rules

| TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| 7 | 2 | 1 | 6 | 0.78 | 0.88 |

| Rule | Vulnerable cases | Safe cases | Precision |
| --- | --- | --- | --- |
| PLG101 | 1 | 1 | 0.50 |
| PLG104 | 1 | 0 | 1.00 |
| PLG105 | 1 | 1 | 0.50 |
| PLG106 | 1 | 0 | 1.00 |
| PLG302 | 1 | 0 | 1.00 |
| PLG401 | 1 | 0 | 1.00 |
| PLG501 | 1 | 0 | 1.00 |

| Case | Truth | Static rules at the location |
| --- | --- | --- |
| py-eval-output | vulnerable | PLG401 |
| py-eval-output-literal | safe | none |
| py-hardcoded-key | vulnerable | PLG501 |
| py-key-from-env | safe | none |
| py-path-tool | vulnerable | PLG104 |
| py-path-tool-confined | safe | none |
| py-shell-tool | vulnerable | PLG101 |
| py-shell-tool-allowlist | safe | PLG101 |
| py-sql-tool | vulnerable | PLG106 |
| py-sql-tool-param | safe | none |
| py-system-prompt-injection | vulnerable | PLG302 |
| py-system-prompt-safe | safe | none |
| ts-idor-route | vulnerable | none |
| ts-idor-route-scoped | safe | none |
| ts-ssrf-tool | vulnerable | PLG105 |
| ts-ssrf-tool-allowlist | safe | PLG105 |

## AI review: claude-haiku-5-5

Prompt digest `94d7f6c4c43f`, 3 runs, Standard depth. 0 of 48 reviews did not complete. Estimated cost USD 1.5338.

Precision 0.59 (min 0.58, max 0.62). Recall 0.92 (min 0.88, max 1.00). Counting only source-supported findings: precision 0.87 (min 0.75, max 1.00), recall 0.75 (min 0.75, max 0.75).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 7 | 5 | 1 | 3 | 0.58 | 0.88 |
| 2 | 7 | 5 | 1 | 3 | 0.58 | 0.88 |
| 3 | 8 | 5 | 0 | 3 | 0.62 | 1.00 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| py-eval-output | vulnerable | 3/3 | source-supported, needs-review, needs-review, source-supported | 0 |
| py-eval-output-literal | safe | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| py-hardcoded-key | vulnerable | 1/3 | needs-review | 3 |
| py-key-from-env | safe | 0/3 | none | 2 |
| py-path-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, needs-review, source-supported | 0 |
| py-path-tool-confined | safe | 1/3 | needs-review | 0 |
| py-shell-tool | vulnerable | 3/3 | needs-review, source-supported, source-supported, source-supported, source-supported | 0 |
| py-shell-tool-allowlist | safe | 2/3 | needs-review, needs-review | 0 |
| py-sql-tool | vulnerable | 3/3 | source-supported, source-supported, needs-review, source-supported | 0 |
| py-sql-tool-param | safe | 3/3 | needs-review, needs-review, needs-review, needs-review | 0 |
| py-system-prompt-injection | vulnerable | 3/3 | source-supported, needs-review, source-supported, needs-review, source-supported, source-supported, needs-review | 0 |
| py-system-prompt-safe | safe | 3/3 | needs-review, source-supported, needs-review, needs-review, needs-review, source-supported | 0 |
| ts-idor-route | vulnerable | 3/3 | needs-review, source-supported, needs-review | 0 |
| ts-idor-route-scoped | safe | 0/3 | none | 0 |
| ts-ssrf-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-ssrf-tool-allowlist | safe | 3/3 | needs-review, needs-review, needs-review, source-supported, needs-review | 0 |

## Observations

- All 48 reviews completed, with no refusal, invalid response or retry. Each
  used 6,921 to 13,970 reported tokens, 521,198 in total; the estimated total was
  USD 1.53.
- Counting every finding the second review did not dismiss, precision was 0.59
  and recall 0.92. Counting only source-supported findings, precision was 0.87
  and recall 0.75. Treat needs-review as a triage queue, not as a confirmed issue.
- The second review almost never dismissed a near-miss. Parameterized SQL,
  `ast.literal_eval`, the allowlisted fetch and the constant system prompt were
  reported in every run, mostly as needs-review, sometimes as source-supported.
- The tenant-scoped route was never reported, and the unscoped route was found in
  every run. No static rule covers this pair.
- The hardcoded key was found in one run of three. Reviews redact known secrets
  before the request, so the model sees a placeholder; PLG501 covers the case
  statically. The unlabeled findings in the key pair concern other code in those
  files, which the corpus does not label.
- Recall varied between runs (0.88, 0.88, 1.00) only through the hardcoded key.

## Not established

Other models, a separate second-review model, Deep depth, scaled batch budgets,
real projects and larger corpora. Compare later records only when the prompt
digest matches.
