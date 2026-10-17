# Detection evaluation, Claude Haiku 5.5, calibrated second review, 2026-10-17

First calibration of the second review's instructions, measured on the same
82-case corpus, connection and model as the
[baseline](detection-claude-haiku-2026-10-17.md). It establishes behaviour on
that corpus only.

## Configuration

- Command: `pnpm evaluate --provider "Claude 1" --runs 3 --yes`, from
  2026-10-17T10:21Z to 11:36Z. Everything as in the baseline except the second
  review's instructions.
- Change: the second review traces each candidate's path, looks on it for a
  control that defeats the described attack (fixed choices, data kept apart from
  code, a confined path, a host allowlist, route authentication including
  router-level middleware, tenant scoping in the called function, approval,
  pinning, TLS or a local host, a sandbox, an iteration limit), and counts a
  control only when it runs before the effect, checks the value that reaches it
  and compares with values the application fixes. It names checks that do not
  count. needs-review is limited to decisions that depend on code that was not
  supplied. Discovery is unchanged.
- Prompt digest `f4672832ce62`; the baseline used `beabaf1c5906`. The corpus
  informed the wording, and the measurement is on the same corpus, so these
  figures overstate what the change does elsewhere.

## Against the baseline

| Second review | TP | FP | FN | TN | Precision | Recall | Source-supported precision | Source-supported recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline `beabaf1c5906` | 117 | 72 | 6 | 51 | 0.62 | 0.95 | 0.72 | 0.50 |
| Calibrated `f4672832ce62` | 118 | 68 | 5 | 55 | 0.63 | 0.96 | 0.73 | 0.85 |

Counts are pooled over three runs. Verdicts at labeled locations:

| Second review | Safe: source-supported | Safe: needs-review | Safe: dismissed | Vulnerable: source-supported | Vulnerable: needs-review | Vulnerable: dismissed |
| --- | --- | --- | --- | --- | --- | --- |
| Baseline | 26 | 78 | 1 | 75 | 83 | 0 |
| Calibrated | 52 | 41 | 5 | 134 | 21 | 1 |

## AI review: claude-haiku-5-5

Prompt digest `f4672832ce62`, 3 runs, Standard depth. 0 of 246 reviews did not complete. Estimated cost USD 0.6078.

Precision 0.63 (min 0.62, max 0.66). Recall 0.96 (min 0.95, max 0.98). Counting only source-supported findings: precision 0.73 (min 0.71, max 0.74), recall 0.85 (min 0.83, max 0.85).

| Run | TP | FP | FN | TN | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 39 | 23 | 2 | 18 | 0.63 | 0.95 |
| 2 | 39 | 24 | 2 | 17 | 0.62 | 0.95 |
| 3 | 40 | 21 | 1 | 20 | 0.66 | 0.98 |

| Case | Truth | Detected in runs | Verdicts at the location | Unlabeled findings |
| --- | --- | --- | --- | --- |
| go-sql-handler-concat | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 3 |
| go-sql-handler-placeholder | safe | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 2 |
| java-download-path-confined | safe | 2/3 | needs-review, source-supported, needs-review, needs-review | 0 |
| java-download-path-traversal | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-agent-approved-delete | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-agent-unapproved-delete | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-aws-key-docs-example | safe | 0/3 | none | 0 |
| py-aws-key-in-source | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-calc-tool-eval | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-calc-tool-literal-eval | safe | 2/3 | source-supported, source-supported | 0 |
| py-command-tool-lookup | safe | 1/3 | source-supported | 0 |
| py-command-tool-lookup-fallback | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-copy-tool-name-pattern | safe | 0/3 | none | 0 |
| py-copy-tool-path-pattern | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-crew-agent-safe-code | safe | 2/3 | needs-review, needs-review | 0 |
| py-crew-agent-unsafe-code | vulnerable | 3/3 | needs-review, source-supported, needs-review | 0 |
| py-delete-tool-guarded | safe | 2/3 | dismissed, source-supported, needs-review | 0 |
| py-delete-tool-late-check | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-eval-output | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-eval-output-literal | safe | 3/3 | source-supported, source-supported, source-supported, needs-review, source-supported, source-supported | 0 |
| py-faiss-dangerous-load | vulnerable | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-faiss-rebuild | safe | 0/3 | none | 0 |
| py-fetch-tool-host-allowlist | safe | 3/3 | source-supported, source-supported, source-supported, source-supported | 0 |
| py-fetch-tool-scheme-check | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-hardcoded-key | vulnerable | 1/3 | source-supported | 1 |
| py-hf-no-remote-code | safe | 0/3 | none | 0 |
| py-hf-trust-remote-code | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-key-from-env | safe | 0/3 | none | 4 |
| py-mcp-local-http | safe | 1/3 | needs-review, dismissed | 0 |
| py-mcp-pinned-uvx | safe | 3/3 | needs-review, source-supported, source-supported, needs-review | 0 |
| py-mcp-remote-http | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| py-mcp-unpinned-uvx | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| py-path-helper-confined | safe | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-path-helper-unconfined | vulnerable | 3/3 | source-supported, needs-review, source-supported | 0 |
| py-path-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-path-tool-confined | safe | 1/3 | source-supported | 0 |
| py-prompt-refuses-password | safe | 1/3 | dismissed, needs-review | 2 |
| py-prompt-with-password | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| py-rag-context-system | vulnerable | 3/3 | needs-review, source-supported, needs-review, needs-review, needs-review | 0 |
| py-rag-context-user | safe | 3/3 | needs-review, source-supported, source-supported, source-supported, needs-review | 0 |
| py-read-tool-confined | safe | 0/3 | none | 0 |
| py-read-tool-unresolved-prefix | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-requests-toolkit-dangerous | vulnerable | 3/3 | source-supported, needs-review, needs-review | 0 |
| py-requests-toolkit-disabled | safe | 0/3 | none | 0 |
| py-restore-tool-json | safe | 3/3 | needs-review, needs-review, source-supported, source-supported | 0 |
| py-restore-tool-pickle | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-shell-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-shell-tool-allowlist | safe | 1/3 | needs-review | 0 |
| py-smolagents-any-import | vulnerable | 3/3 | source-supported, needs-review, needs-review | 0 |
| py-smolagents-docker-imports | safe | 1/3 | needs-review | 0 |
| py-sql-tool | vulnerable | 3/3 | source-supported, needs-review, source-supported, source-supported, needs-review | 0 |
| py-sql-tool-param | safe | 3/3 | needs-review, needs-review, source-supported | 0 |
| py-system-prompt-injection | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| py-system-prompt-safe | safe | 3/3 | source-supported, needs-review, source-supported, source-supported, source-supported | 0 |
| py-team-max-messages | safe | 0/3 | none | 0 |
| py-team-no-termination | vulnerable | 0/3 | none | 0 |
| py-tenant-scoped-repository | safe | 2/3 | needs-review, needs-review | 0 |
| py-tenant-unscoped-repository | vulnerable | 3/3 | source-supported, dismissed, source-supported, source-supported | 0 |
| py-write-tool-allowlist | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| py-write-tool-unchecked-guard | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| py-write-tool-unpacked-confined | safe | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-command-tool-allowlist | safe | 1/3 | needs-review, dismissed | 0 |
| ts-command-tool-model-allowlist | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-email-tool-fixed-recipient | safe | 3/3 | source-supported, needs-review, source-supported, needs-review, source-supported, needs-review | 0 |
| ts-email-tool-recipient | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-git-tool-argument | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-git-tool-argument-allowlist | safe | 0/3 | none | 0 |
| ts-idor-route | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-idor-route-scoped | safe | 1/3 | needs-review | 0 |
| ts-mcp-http-bearer-auth | safe | 3/3 | needs-review, needs-review, needs-review, source-supported, needs-review | 0 |
| ts-mcp-http-no-auth | vulnerable | 3/3 | needs-review, needs-review, needs-review, source-supported | 0 |
| ts-openai-browser | vulnerable | 3/3 | source-supported, source-supported, source-supported | 1 |
| ts-openai-server | safe | 0/3 | none | 0 |
| ts-read-tool-no-separators | safe | 0/3 | dismissed | 0 |
| ts-read-tool-slash-only | vulnerable | 3/3 | source-supported, source-supported, source-supported | 0 |
| ts-route-agent-clock-tool | safe | 3/3 | needs-review, needs-review, needs-review | 0 |
| ts-route-agent-shell-tool | vulnerable | 3/3 | needs-review, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-route-missing-auth | vulnerable | 3/3 | source-supported, source-supported, source-supported, needs-review | 0 |
| ts-route-router-auth | safe | 2/3 | needs-review, source-supported, source-supported | 2 |
| ts-ssrf-tool | vulnerable | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |
| ts-ssrf-tool-allowlist | safe | 3/3 | source-supported, source-supported, source-supported, source-supported, source-supported, source-supported | 0 |

## Observations

- The calibration did not raise precision: 0.63 against 0.62, inside the spread
  between runs (0.62 to 0.66 here, 0.59 to 0.64 in the baseline). Recall stayed
  at 0.96.
- It moved verdicts from needs-review to source-supported, on safe and
  vulnerable cases alike, and dismissed little more: 5 dismissals on safe cases
  instead of 1. Counting only source-supported findings, recall rose from 0.50
  to 0.85 at the same precision, 0.73.
- Per case, 9 safe cases were reported in fewer runs and 5 in more, among them
  the tenant-scoped repository (0 to 2 of 3) and the allowlisted write (1 to 3 of
  3). The vulnerable hardcoded key was found once.
- The Go handler with a placeholder query was reported in every run, all five
  verdicts source-supported. The handler also returns any customer's orders with
  no authentication, so these findings may concern another weakness at the
  labeled lines rather than SQL injection. The corpus counts any kept finding
  that cites the labeled lines, and the evaluation does not keep finding titles
  or second-review reasons, so this cannot be told apart from the record. The same
  may hold for other safe cases whose code has a second weakness.
- 246 of 246 reviews completed. They used 2,815,255 reported tokens, 4% more than
  the baseline; the estimate was USD 0.61 at this connection's saved prices.

## Diagnostic run with findings kept

`pnpm evaluate --json` now keeps each finding at a labeled location with its
title, STRIDE category, severity, verdict and second-review reason. One more run
with the calibrated instructions, 2026-10-17T13:48Z to 14:14Z, gave precision
0.61 and recall 0.95 (82 of 82 reviews completed, USD 0.21 at this connection's
prices). 25 safe cases were reported. Read one by one, they fall into three
groups:

| Group | Cases | What the kept findings say |
| --- | --- | --- |
| The safe case has a real weakness | 6 | Of the labeled kind: `py-write-tool-unpacked-confined` checks `str(path).startswith(str(WORKDIR))` with no separator, so a sibling such as `workdir_old/` passes; `py-fetch-tool-host-allowlist` lets `requests` follow redirects off the allowlisted host; `ts-mcp-http-bearer-auth` exports `requireBearerAuth` without applying it. Of another kind: the Go handler, `py-sql-tool-param` and `py-path-helper-confined` return another customer's data or a file to any caller, with no authentication or ownership check. |
| Another, minor weakness at the labeled lines | 16 | Unbounded input or output (`ast.literal_eval`, file reads, query results, email bodies, fetches), no timeout or rate limit, no audit log, a bare program name resolved through `PATH`, an unpinned model revision, transitive dependencies under a pinned MCP server, overwriting a report through the tool built for it, prompt injection through documents placed in the user message. |
| needs-review on a control the review recognized | 3 | Human approval (`needs_approval=True`), CrewAI's safe code mode and the fixed-area check, each held open on code outside the case. |

In almost every case the second review named the guard for the labeled
weakness and said it holds: the area check "fixes the only value that reaches
shutil.rmtree", "Authorization is applied via requireAdmin in server.ts line 7",
the allowlist and `redirect: "error"` "block off-host requests". The low
precision comes mostly from scoring: any kept finding that cites the labeled
lines counts, whatever its weakness, and three safe cases are not safe.

Consequences, not yet acted on:

- Three corpus cases need fixing so the safe twin holds no real weakness of its
  own kind, and twins should differ only in the labeled weakness.
- Counting only findings of the labeled weakness needs the review to name one,
  for instance a CWE per finding.
- The static scan accepts `str(path).startswith(str(BASE))` without a separator
  as confinement since commit `748bbec`; it should require `BASE + os.sep`,
  `is_relative_to` or the like. The same pattern is in the risks fixture's
  `read_note` and `readNote`.
- Discovery reports hardening items (resource limits, audit logs) despite its
  instruction against generic best practices.

## Not established

Other models, a separate second-review model, Full coverage, exploration and
real projects. The grouping above is one reading of one run.
